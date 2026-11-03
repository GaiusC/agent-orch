import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import urlopen, Request
from http.server import ThreadingHTTPServer

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'dashboard/scripts'))
from auditor_data import build_workspace, context_from_query, ContextError, normalize
from git_history import snapshot, commit_detail, git_state
SPEC=importlib.util.spec_from_file_location('workspace_test_server',ROOT/'dashboard/scripts/server.py')
SERVER=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(SERVER)


class WorkspaceDataTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='orch-auditor-test-')
        self.project=Path(self.temp.name).resolve();self.orch=self.project/'.agent-orchestrator'
        self.counter=0
        self.write('plans/p.json',{'plan_id':'p','type':'formal','name':'Example plan','created_at':'2026-01-01T00:00:00Z','task_ids':['t']})
        self.contract()

    def tearDown(self):
        self.assertEqual(self.project.parent,Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.project.name.startswith('orch-auditor-test-'))
        self.temp.cleanup()

    def write(self,rel,value):
        file=self.orch/rel;file.parent.mkdir(parents=True,exist_ok=True);file.write_text(json.dumps(value),encoding='utf-8');return file

    def contract(self,digest='v1',subtasks=None,reviews=None):
        return self.write('contracts/t.json',{'task_id':'t','plan_id':'p','contract_id':'c','contract_digest':digest,'contract_version':1,'objective':'Example task',
                'executor_subtasks':subtasks or [{'subtask_id':'a','role':'executor','objective':'Build A','depends_on':[]}],
                'reviewer_tasks':reviews if reviews is not None else [{'review_id':'r','target_subtask_ids':['a']}]})

    def job(self,id,**kw):
        self.counter+=1
        value={'id':id,'plan_id':'p','plan_type':'formal','task_id':'t','subtask_id':'a','contract_id':'c','contract_digest':'v1','type':'stage_work',
               'status':'completed','phase':'ready_for_acceptance','created_at':f'2026-01-01T00:{self.counter//60:02}:{self.counter%60:02}Z'}
        value.update(kw);self.write(f'runs/{id}/job.json',value)
        self.write(f'runs/{id}/evidence.json',{'changes':{'patch_digest':kw.pop('patch_digest','patch-1')}})
        return value

    def plan(self):return build_workspace(str(self.project),str(self.orch))['plans'][0]

    def test_all_sixty_jobs_and_empty_plan_manifests_are_kept(self):
        for i in range(60):self.job(f'work-{i}')
        self.write('plans/empty.json',{'plan_id':'empty','type':'formal','name':'Not started','created_at':'2025-01-01T00:00:00Z','task_ids':[]})
        data=build_workspace(str(self.project),str(self.orch))
        self.assertEqual(data['counts']['jobs'],60);self.assertEqual(data['counts']['plans'],2)
        self.assertEqual(sum(p['job_count'] for p in data['plans']),60)
        with patch.object(SERVER,'get_active_processes_snapshot',return_value=([],'')):
            handler=SERVER.DashboardAPIHandler.__new__(SERVER.DashboardAPIHandler)
            self.assertEqual(len(handler.get_runs_list(str(self.orch))),60)

    def test_continuation_preserves_failure_and_uses_latest_work_state(self):
        self.job('work-fail',status='failed',phase='failed')
        self.job('work-next',type='stage_work_continue',continued_from_job_id='work-fail')
        p=self.plan();self.assertEqual(p['state'],'awaiting_review');self.assertEqual(p['failure_count'],1)
        self.assertEqual(p['events'][1]['continued_from'],'work-fail')
        self.assertEqual(p['delivery']['state'],'unlinked')

    def test_review_requires_current_contract_and_patch_binding(self):
        self.job('work-main');self.job('agy-review',type='agy_review',subtask_id=None,review_id='r')
        def review(digest,patch_id):
            self.write('runs/agy-review/evidence.json',{'result':'VERDICT: PASS','review_evidence':{'contract_digest':digest,'patch_digest':patch_id}})
        review('old','patch-1');self.assertEqual(self.plan()['state'],'awaiting_review')
        review('v1','old-patch');self.assertEqual(self.plan()['state'],'awaiting_review')
        review('v1','patch-1');self.assertEqual(self.plan()['state'],'reviewed')
        self.write('runs/agy-review/evidence.json',{'result':'VERDICT: FAIL','review_evidence':{'contract_digest':'v1','patch_digest':'patch-1'}})
        failed_plan=self.plan();self.assertEqual(failed_plan['state'],'awaiting_review');self.assertTrue(next(j for j in failed_plan['jobs'] if j['id']=='agy-review')['review']['binding_current'])
        review('v1','patch-1')
        self.job('agy-later-failed',type='agy_review',review_id='r',status='failed')
        self.assertEqual(self.plan()['state'],'awaiting_review')

    def test_old_contract_execution_does_not_complete_new_contract(self):
        self.job('work-old',phase='applied_and_cleaned',acceptance_status='accepted')
        self.contract(digest='v2')
        p=self.plan();self.assertEqual(p['state'],'planned');self.assertIs(p['jobs'][0]['contract_current'],False)

    def test_missing_required_subtask_and_missing_digest_are_explicit(self):
        self.contract(subtasks=[{'subtask_id':'a','objective':'A'},{'subtask_id':'b','objective':'B','depends_on':['a']}])
        self.job('work-only-a',phase='applied_and_cleaned')
        p=self.plan();self.assertEqual(p['state'],'partial')
        self.assertIn({'source':'t/a','target':'t/b','kind':'dependency'},p['graph']['edges'])
        self.contract();self.job('work-unknown',contract_digest=None)
        self.assertEqual(self.plan()['state'],'binding_unknown')

    def test_accept_stage_without_own_job_and_unassigned_records_remain_visible(self):
        self.job('work-main',acceptance_status='accepted')
        self.write('stages/accept.json',{'stage_run_id':'accept-1','stage':'accept','task_id':'t','job_id':'work-main','status':'completed','created_at':'2026-01-01T01:00:00Z'})
        self.write('stages/orphan.json',{'stage_run_id':'plan-orphan','stage':'plan','task_id':'gone-task','status':'completed'})
        data=build_workspace(str(self.project),str(self.orch))
        p=next(p for p in data['plans'] if p['id']=='p');self.assertEqual(p['state'],'accepted')
        self.assertTrue(any(e['kind']=='accept' for e in p['events']))
        orphan=next(p for p in data['plans'] if p['id']=='__unassigned__');self.assertEqual(len(orphan['stages']),1)
        self.assertIsNone(orphan['events'][0]['start']);self.assertEqual(data['counts']['plans'],1)

    def test_malformed_input_is_reported_without_becoming_a_fake_plan(self):
        (self.orch/'plans/broken.json').write_text('{bad',encoding='utf-8')
        data=build_workspace(str(self.project),str(self.orch));self.assertEqual(len(data['warnings']),1);self.assertEqual(data['counts']['plans'],1)

    def test_git_receipts_deduplicate_projection_and_legacy_fields_without_inventing_times(self):
        sha='a'*40
        self.job('work-a',applied_at='2026-01-01T00:05:00Z',workspace={'path':'C:/isolated','git':{'head':sha}})
        operation={'operation_id':'git-apply','job_id':'work-a','kind':'patch.applied','status':'completed','occurred_at':'2026-01-01T00:05:00Z','after_head':sha,'recorded_at':'2026-01-01T00:05:01Z'}
        self.write('runs/work-a/git-operations/git-apply.json',operation)
        (self.orch/'events.jsonl').write_text('{broken\n'+json.dumps({'git_operation':operation})+'\n',encoding='utf-8')
        data=build_workspace(str(self.project),str(self.orch));p=data['plans'][0]
        self.assertEqual(sum(e.get('git_kind')=='patch.applied' for e in p['events']),1)
        baseline=next(e for e in p['events'] if e.get('git_kind')=='baseline.recorded')
        self.assertIsNone(baseline['start']);self.assertEqual(p['events'][-1]['id'],baseline['id'])
        self.assertEqual(next(e for e in p['git_activity'] if e['id']=='git-apply')['operation']['provenance'],'operation-receipt')
        self.assertEqual(len(data['warnings']),1);self.assertEqual(p['delivery']['state'],'unlinked')

    def test_integration_inputs_link_both_plans_and_orphan_operations_remain_visible(self):
        self.job('work-a')
        self.write('plans/integration.json',{'plan_id':'combined','type':'formal','task_ids':['combine']})
        self.job('integrate-a',plan_id='combined',task_id='combine',integration_job_ids=['work-a'])
        sha='b'*40
        self.write('runs/integrate-a/git-operations/input.json',{'operation_id':'input','kind':'integration.input','job_id':'integrate-a','source_job_id':'work-a','status':'completed','commit_id':sha})
        self.write('runs/missing/git-operations/clean.json',{'operation_id':'orphan','kind':'workspace.cleaned','job_id':'missing','status':'completed'})
        data=build_workspace(str(self.project),str(self.orch))
        self.assertEqual({r['plan_id'] for r in data['commit_links'][sha]},{'p','combined'})
        self.assertTrue(all(p['delivery']['state']=='unlinked' for p in data['plans']))
        self.assertTrue(any(e['id']=='orphan' for p in data['plans'] if p['type']=='unassigned' for e in p['events']))

    def test_continuations_share_one_legacy_baseline_with_all_execution_links(self):
        workspace={'path':'C:/owned/worktree','base_commit':'a'*40}
        self.job('work-first',workspace=workspace)
        self.job('work-continue',workspace=workspace,continued_from_job_id='work-first')
        activity=self.plan()['git_activity'];self.assertEqual(len(activity),1)
        self.assertEqual({activity[0]['job_id'],*activity[0]['operation']['related_job_ids']},{'work-first','work-continue'})
        self.assertIsNone(activity[0]['start'])

    def test_async_finalizers_share_the_target_delivery_receipt_and_plan_links(self):
        self.git('init','-b','main');self.git('commit','--allow-empty','-m','delivery');sha=self.git('rev-parse','HEAD')
        self.job('work-delivery',commit_id=sha,committed_at='2026-01-01T01:00:00Z')
        self.write('plans/p2.json',{'plan_id':'p2','type':'formal','task_ids':['supervise']})
        for name in ['finalize-first','finalize-retry']:
            self.job(name,type='task_finalize',target_job_id='work-delivery',commit_id=sha,
                     plan_id='p2',task_id='supervise',subtask_id=None)
        receipt={'operation_id':'delivery-receipt','job_id':'work-delivery','kind':'delivery.committed',
                 'status':'completed','commit_id':sha,'occurred_at':'2026-01-01T01:00:00Z'}
        self.write('runs/work-delivery/git-operations/delivery.json',receipt)
        (self.orch/'events.jsonl').write_text(json.dumps({'git_operation':receipt})+'\n',encoding='utf-8')
        before={p:p.read_bytes() for p in self.orch.rglob('*') if p.is_file()}
        data=build_workspace(str(self.project),str(self.orch))
        for plan in data['plans']:
            deliveries=[e for e in plan['git_activity'] if e['git_kind']=='delivery.committed']
            self.assertEqual(len(deliveries),1)
            self.assertEqual(deliveries[0]['id'],'delivery-receipt')
            self.assertEqual(deliveries[0]['job_id'],'work-delivery')
            self.assertEqual(deliveries[0]['operation']['provenance'],'operation-receipt')
            self.assertEqual(set(deliveries[0]['operation']['related_job_ids']),{'finalize-first','finalize-retry'})
            self.assertEqual(deliveries[0]['start'],'2026-01-01T01:00:00Z')
        self.assertEqual({link['plan_id'] for link in data['commit_links'][sha]},{'p','p2'})
        self.assertEqual({p:p.read_bytes() for p in self.orch.rglob('*') if p.is_file()},before)

    def test_legacy_finalizers_share_target_metadata_or_receipt_delivery(self):
        sha='a'*40
        for source in ['metadata','receipt']:
            target='work-'+source
            fields={'commit_id':sha,'committed_at':'2026-01-01T01:00:00Z'} if source=='metadata' else {}
            self.job(target,**fields)
            if source=='receipt':self.write(f'runs/{target}/finalization/receipt.json',{'commit_id':sha,'status':'closed'})
            self.job('finalize-'+source,type='task_finalize',target_job_id=target,commit_id=sha,subtask_id=None)
        deliveries=[e for e in self.plan()['git_activity'] if e['git_kind']=='delivery.committed']
        self.assertEqual({e['job_id'] for e in deliveries},{'work-metadata','work-receipt'})
        self.assertEqual(len(deliveries),2) # Distinct targets can legitimately share one commit.
        for event in deliveries:
            self.assertEqual(event['operation']['related_job_ids'],['finalize-'+event['job_id'][5:]])
            self.assertEqual(event['operation']['provenance'],'legacy-fields')
        self.assertIsNone(next(e for e in deliveries if e['job_id']=='work-receipt')['start'])

    def test_unproven_finalizer_links_and_independent_deliveries_remain_visible(self):
        sha='a'*40
        self.job('work-target',commit_id=sha)
        self.job('work-independent',commit_id=sha)
        self.job('finalize-unknown',type='task_finalize',target_job_id='missing',commit_id=sha)
        self.job('finalize-mismatch',type='task_finalize',target_job_id='work-target',commit_id='b'*40)
        self.job('finalize-unlinked',type='task_finalize',commit_id=sha)
        deliveries=[e for e in self.plan()['git_activity'] if e['git_kind']=='delivery.committed']
        self.assertEqual({e['job_id'] for e in deliveries},
                         {'work-target','work-independent','finalize-unknown','finalize-mismatch','finalize-unlinked'})
        self.assertEqual(len(deliveries),5)

    def test_finalizer_can_link_to_a_durable_receipt_when_target_job_is_missing(self):
        sha='a'*40
        self.job('finalize-only',type='task_finalize',target_job_id='work-missing',commit_id=sha)
        self.write('runs/work-missing/git-operations/delivery.json',
                   {'operation_id':'saved-delivery','job_id':'work-missing','kind':'delivery.committed',
                    'status':'completed','commit_id':sha,'occurred_at':None})
        data=build_workspace(str(self.project),str(self.orch))
        deliveries=[e for p in data['plans'] for e in p['git_activity'] if e['git_kind']=='delivery.committed']
        self.assertEqual(len(deliveries),1)
        self.assertEqual(deliveries[0]['id'],'saved-delivery')
        self.assertEqual(deliveries[0]['operation']['related_job_ids'],['finalize-only'])
        self.assertIsNone(deliveries[0]['start'])

    def test_internal_checkpoints_are_opt_in_and_do_not_move_target_head(self):
        self.git('init','-b','main');self.git('commit','--allow-empty','-m','base');base=self.git('rev-parse','HEAD')
        tree=self.git('rev-parse','HEAD^{tree}');checkpoint=self.git('commit-tree',tree,'-p',base,'-m','internal checkpoint')
        self.git('update-ref','refs/agent-orch/results/work-a',checkpoint)
        self.assertNotIn(checkpoint,[c['hash'] for c in snapshot(str(self.project))['commits']])
        extended=snapshot(str(self.project),include_internal=True)
        self.assertIn(checkpoint,[c['hash'] for c in extended['commits']]);self.assertTrue(any(r['kind']=='internal' for r in extended['refs']))
        self.assertEqual(self.git('rev-parse','HEAD'),base)

    def git(self,*args,env=None):
        return subprocess.run(['git','-c','safe.directory='+str(self.project).replace('\\','/'),'-c','user.name=Auditor test','-c','user.email=auditor@example.invalid','-c','core.hooksPath=/dev/null','-C',str(self.project),*args],check=True,capture_output=True,text=True,encoding='utf-8',env={**os.environ,**(env or {})},timeout=15).stdout.strip()

    def test_commit_mapping_is_verified_and_can_be_shared_by_two_plans(self):
        self.git('init','-b','main');self.git('commit','--allow-empty','-m','delivery');sha=self.git('rev-parse','HEAD')
        self.job('work-committed',commit_id=sha,closeout_phase='closed',acceptance_status='accepted')
        self.write('plans/p2.json',{'plan_id':'p2','type':'adhoc','task_ids':['other'],'created_at':'2026-01-02T00:00:00Z'})
        self.job('work-shared',plan_id='p2',task_id='other',commit_id=sha,closeout_phase='closed',acceptance_status='accepted')
        data=build_workspace(str(self.project),str(self.orch));self.assertEqual(sum(p['state']=='delivered' for p in data['plans']),2)
        self.assertEqual(data['counts']['linked_jobs'],2)
        self.assertTrue(all(p['delivery']['commits'][0]['commit_id']==sha for p in data['plans']))
        self.job('work-invalid',commit_id='f'*40)
        p=next(p for p in build_workspace(str(self.project),str(self.orch))['plans'] if p['id']=='p')
        self.assertNotEqual(p['state'],'delivered');self.assertTrue(any(d['state']=='missing' for d in p['delivery']['commits']))

    def test_git_history_is_strict_chronology_and_read_only(self):
        self.git('init','-b','main')
        for day,msg in [(1,'root'),(5,'future parent'),(3,'skewed child')]:
            self.git('commit','--allow-empty','-m',msg,env={'GIT_AUTHOR_DATE':f'2026-01-0{day}T00:00:00Z','GIT_COMMITTER_DATE':f'2026-01-0{day}T00:00:00Z'})
        (self.project/'new.txt').write_text('untracked',encoding='utf-8')
        before=self.git('status','--porcelain=v1');snapshot_data=snapshot(str(self.project))
        self.assertEqual([c['subject'] for c in snapshot_data['commits']],['future parent','skewed child','root'])
        self.assertEqual(snapshot_data['status']['untracked'],2) # new.txt and the fixture .agent-orchestrator directory
        detail=commit_detail(str(self.project),snapshot_data['commits'][0]['hash']);self.assertIn('future parent',detail['text'])
        self.assertEqual(self.git('status','--porcelain=v1'),before)

    def test_http_project_context_is_scoped_and_static_pages_do_not_rebind(self):
        other=self.project/'other';other.mkdir()
        with patch.object(SERVER,'SERVER_PROJECT_DIR',str(self.project)):
            server=ThreadingHTTPServer(('127.0.0.1',0),SERVER.DashboardAPIHandler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{server.server_port}'
            try:
                for folder in [other,self.project,other]:
                    with urlopen(base+'/?'+urlencode({'project':str(folder)})) as res:self.assertIn(b'workspace.js',res.read())
                    with urlopen(base+'/api/workspace?'+urlencode({'project':str(folder)})) as res:data=json.load(res)
                    self.assertEqual(normalize(data['project_dir']),normalize(folder))
                    self.assertEqual(SERVER.SERVER_PROJECT_DIR,str(self.project))
                with self.assertRaises(HTTPError) as ctx:urlopen(base+'/api/workspace?thread=00000000-0000-0000-0000-000000000000')
                self.assertEqual(ctx.exception.code,404)
            finally:server.shutdown();server.server_close();thread.join(timeout=5)

    def test_exact_thread_context_preserves_worktree_directory_and_rejects_conflicts(self):
        db=self.project/'state.sqlite';other=self.project/'other';other.mkdir();sid='11111111-1111-1111-1111-111111111111'
        con=sqlite3.connect(db);con.execute('create table threads(id text,cwd text)');con.execute('insert into threads values(?,?)',(sid,str(other)));con.commit();con.close()
        context=context_from_query(urlencode({'thread':sid}),str(self.project),db);self.assertEqual(context['cwd'],normalize(other));self.assertEqual(context['source'],'exact-thread-cwd')
        with self.assertRaises(ContextError):context_from_query(urlencode({'thread':sid,'project':str(self.project)}),str(self.project),db)

    def test_linked_git_worktrees_keep_distinct_status_and_shared_repository_identity(self):
        self.git('init','-b','main');self.git('commit','--allow-empty','-m','base')
        other=self.project/'linked tree';self.git('worktree','add','-b','feature',str(other))
        (other/'feature.txt').write_text('other',encoding='utf-8')
        a=git_state(str(self.project));b=git_state(str(other))
        self.assertEqual(a['status']['branch'],'main');self.assertEqual(b['status']['branch'],'feature')
        self.assertNotEqual(a['git_dir'],b['git_dir']);self.assertEqual(normalize(a['git_common_dir']),normalize(b['git_common_dir']))
        self.assertTrue(any(f['path']=='feature.txt' for f in b['status']['files']))
        self.assertFalse(any(f['path']=='feature.txt' for f in a['status']['files']))

    def test_commit_pagination_sorts_entire_history_before_taking_page(self):
        self.git('init','-b','main')
        for day in range(1,28):
            actual=30 if day==2 else day
            self.git('commit','--allow-empty','-m',f'commit {day}',env={'GIT_AUTHOR_DATE':f'2026-01-{actual:02}T00:00:00Z','GIT_COMMITTER_DATE':f'2026-01-{actual:02}T00:00:00Z'})
        full=snapshot(str(self.project),limit=100);page=snapshot(str(self.project),limit=20)
        self.assertEqual(full['commits'][0]['subject'],'commit 2')
        self.assertEqual([c['hash'] for c in page['commits']],[c['hash'] for c in full['commits'][:20]])
        self.assertTrue(page['has_more'])

    def test_http_rejects_cross_origin_reads_and_posts(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),SERVER.DashboardAPIHandler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        try:
            for req in [Request(base+'/api/workspace',headers={'Origin':'https://example.invalid'}),Request(base+'/api/conclusion/work-test',method='POST',headers={'Origin':'https://example.invalid'})]:
                with self.assertRaises(HTTPError) as ctx:urlopen(req)
                self.assertEqual(ctx.exception.code,403)
        finally:server.shutdown();server.server_close();thread.join(timeout=5)


if __name__=='__main__':unittest.main()
