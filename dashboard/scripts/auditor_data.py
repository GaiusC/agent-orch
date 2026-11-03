"""Normalize persisted orchestration facts for the manual-refresh workspace UI."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
from urllib.parse import parse_qs

from git_history import git_state, commit_status, GitReadError
from git_activity import read_operations, plan_activity

WORK_TYPES = {'stage_work','stage_work_continue','auto_execute','cc_execute','cc_continue','agy_execute','agy_continue','codex_execute'}
REVIEW_TYPES = {'agy_review','agy_verify'}


class ContextError(ValueError):
    def __init__(self,message,status=400):
        super().__init__(message)
        self.status=status


def normalize(value):
    value=str(value)
    if value.startswith('\\\\?\\'):
        value=value[4:]
    return os.path.realpath(os.path.abspath(value))


def context_from_query(query,default_cwd,state_db=None):
    params=parse_qs(query,keep_blank_values=True)
    project=(params.get('project') or [''])[0]
    thread=(params.get('thread') or [''])[0]
    cwd=normalize(project or default_cwd or os.getcwd())
    source='explicit-project' if project else 'server-default'
    if thread:
        if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',thread):
            raise ContextError('聊天 ID 无效。')
        db=Path(state_db or Path.home()/'.codex/state_5.sqlite').resolve()
        try:
            con=sqlite3.connect(db.as_uri()+'?mode=ro',uri=True,timeout=2)
            try: row=con.execute('select cwd from threads where id=?',(thread,)).fetchone()
            finally: con.close()
        except sqlite3.Error as exc:
            raise ContextError('聊天索引不可读取，请显式选择项目。',503) from exc
        if not row or not row[0]:
            raise ContextError('聊天目录不存在，没有回退到其他项目。',404)
        cwd=normalize(row[0]);source='exact-thread-cwd'
        if project and os.path.normcase(cwd)!=os.path.normcase(normalize(project)):
            raise ContextError('聊天与显式项目目录不一致。',409)
    if not os.path.isdir(cwd):
        raise ContextError('项目目录不存在。',404)
    return {'cwd':cwd,'thread_id':thread or None,'source':source,'host':'local'}


def read_json(file,warnings=None):
    try:
        value=json.loads(Path(file).read_text(encoding='utf-8-sig'))
        return value if isinstance(value,dict) else {}
    except (OSError,ValueError,TypeError):
        if warnings is not None: warnings.append({'file':str(file),'message':'记录暂不可读或格式无效'})
        return {}


def timestamp(value):
    try:
        if isinstance(value,(int,float)):return float(value)/1000 if value>1e12 else float(value)
        return datetime.fromisoformat(str(value).replace('Z','+00:00')).timestamp()
    except (ValueError,TypeError,OverflowError):return None


def start_time(value):
    return value.get('started_at') or value.get('created_at')


def sort_time(value):
    return timestamp(start_time(value)) or float('-inf')


def text_list(value):
    return [str(v) for v in value] if isinstance(value,list) else []


def role(job):
    if job.get('integration_job_ids'):return 'integration'
    if job.get('type') in REVIEW_TYPES or job.get('review_id'):return 'review'
    if job.get('type') in WORK_TYPES:return 'work'
    return job.get('stage') or 'execution'


def review_fact(job,evidence):
    binding=evidence.get('review_evidence') or {}
    raw=evidence.get('result') or (binding.get('findings') or {}).get('summary') or ''
    match=re.search(r'^\s*VERDICT:\s*(PASS|FAIL)\b',str(raw),re.I)
    return {'verdict':match.group(1).upper() if match else None,
            'contract_digest':binding.get('contract_digest') or job.get('contract_digest'),
            'patch_digest':binding.get('patch_digest'),
            'contract_id':binding.get('contract_id') or job.get('contract_id'),
            'review_id':job.get('review_id') or binding.get('review_id')}


def build_workspace(project_dir,orchestrator_dir):
    warnings=[]
    root=Path(orchestrator_dir) if orchestrator_dir else None
    def load(pattern):
        values=[]
        for file in sorted(root.glob(pattern)) if root else []:
            value=read_json(file,warnings)
            if value:
                value['_file']=str(file);values.append(value)
        return values
    manifests=[p for p in load('plans/*.json') if p.get('plan_id') and p.get('type') in ('formal','adhoc')]
    contracts=load('contracts/*.json')
    stages=load('stages/*.json')
    jobs=load('runs/*/job.json')
    job_by_id={}
    commit_cache={}
    normalized_jobs=[]
    for job in jobs:
        job_id=job.get('id') or Path(job['_file']).parent.name
        evidence=read_json(Path(job['_file']).parent/'evidence.json')
        binding=review_fact(job,evidence) if role(job)=='review' else None
        receipt=read_json(Path(job['_file']).parent/'finalization/receipt.json')
        sha=job.get('commit_id') or receipt.get('commit_id')
        if sha:
            if sha not in commit_cache:
                try:commit_cache[sha]=commit_status(project_dir,sha)
                except (GitReadError,OSError):commit_cache[sha]={'commit_id':sha,'state':'unverifiable','exists':False,'reachable':False}
            delivery=dict(commit_cache[sha])
        else:
            delivery={'state':'unlinked','commit_id':None}
        if sha and delivery.get('reachable') and job.get('closeout_phase') not in ('closed','cleaned') and receipt.get('status')!='closed':
            delivery['cleanup_pending']=True
        item={k:job.get(k) for k in ('plan_id','plan_type','task_id','subtask_id','review_id','contract_id','contract_digest','status','phase','provider','model','created_at','started_at','finished_at','updated_at','continued_from_job_id','stage_run_id','acceptance_status','applied_at','committed_at','closeout_phase','integrated_into_job_id','integration_job_ids','requires_agy_review','review_waiver','error')}
        item.update({'id':job_id,'type':job.get('type'),'role':role(job),'goal':job.get('goal') or '',
                     'workspace':(job.get('workspace') or {}).get('path'),'review':binding,'delivery':delivery,
                     'patch_digest':(evidence.get('changes') or {}).get('patch_digest'),
                     'source_file':job['_file']})
        normalized_jobs.append(item);job_by_id[job_id]=item
    normalized_jobs.sort(key=sort_time)
    plans={p['plan_id']:{'id':p['plan_id'],'title':str(p.get('name') or p['plan_id']).removeprefix('Plan for '),
                           'type':p.get('type'),'created_at':p.get('created_at'),'description':p.get('description') or '',
                           'task_ids':text_list(p.get('task_ids')),'tasks':[],'jobs':[],'stages':[],
                           'source_file':p['_file']} for p in manifests}
    task_contracts={}
    for c in contracts:
        if c.get('task_id'):task_contracts.setdefault(str(c['task_id']),[]).append(c)
    for task_id,versions in task_contracts.items():
        for c in versions:
            pid=c.get('plan_id')
            if not pid:
                candidates=[p['id'] for p in plans.values() if task_id in p['task_ids']]
                pid=candidates[0] if len(candidates)==1 else '__unassigned__'
            if pid not in plans:
                plans[pid]={'id':pid,'title':'未归属历史记录' if pid=='__unassigned__' else str(pid),
                            'type':'unassigned' if pid=='__unassigned__' else 'missing-manifest','created_at':None,
                            'description':'缺少计划清单，保留原始关联。','task_ids':[],'tasks':[],'jobs':[],'stages':[]}
            executor=c.get('executor_subtasks') or c.get('subtasks') or []
            reviewers=c.get('reviewer_tasks') or c.get('reviews') or []
            subtasks=[{'id':s.get('subtask_id'),'title':s.get('objective') or s.get('subtask_id'),'role':'work','depends_on':text_list(s.get('depends_on'))} for s in executor if isinstance(s,dict) and s.get('subtask_id')]
            reviews=[{'id':r.get('review_id'),'title':r.get('objective') or r.get('review_id'),'role':'review','targets':text_list(r.get('target_subtask_ids'))} for r in reviewers if isinstance(r,dict) and r.get('review_id')]
            plans[pid]['tasks'].append({'id':task_id,'contract_id':c.get('contract_id'),'contract_digest':c.get('contract_digest'),
                                        'contract_version':c.get('contract_version'),'title':c.get('objective') or c.get('goal') or (subtasks[0]['title'] if subtasks else task_id),
                                        'subtasks':subtasks,'reviews':reviews,'depends_on':text_list(c.get('dependencies') or c.get('depends_on')),
                                        'source_file':c['_file']})
            if task_id not in plans[pid]['task_ids']:plans[pid]['task_ids'].append(task_id)
    for job in normalized_jobs:
        pid=job.get('plan_id')
        if not pid:
            candidates=[p['id'] for p in plans.values() if job.get('task_id') in p['task_ids']]
            pid=candidates[0] if len(candidates)==1 else '__unassigned__'
        if pid not in plans:
            plans[pid]={'id':pid,'title':'未归属历史记录' if pid=='__unassigned__' else pid,'type':'unassigned' if pid=='__unassigned__' else 'missing-manifest',
                        'created_at':None,'description':'缺少计划清单，保留原始执行记录。','task_ids':[],'tasks':[],'jobs':[],'stages':[]}
        job['resolved_plan_id']=pid
        plans[pid]['jobs'].append(job)
        if job.get('task_id') and job['task_id'] not in plans[pid]['task_ids']:plans[pid]['task_ids'].append(job['task_id'])
    for stage in stages:
        linked=job_by_id.get(stage.get('job_id'))
        candidates=[p['id'] for p in plans.values() if stage.get('task_id') in p['task_ids']]
        pid=linked.get('resolved_plan_id') if linked else candidates[0] if len(candidates)==1 else None
        if not pid:
            warnings.append({'file':stage['_file'],'message':'阶段记录没有唯一计划归属，保留在未归属历史记录中'})
            pid='__unassigned__'
            if pid not in plans:
                plans[pid]={'id':pid,'title':'未归属历史记录','type':'unassigned','created_at':None,'description':'没有可靠计划关联的原始记录。','task_ids':[],'tasks':[],'jobs':[],'stages':[]}
        plans[pid]['stages'].append({**{k:stage.get(k) for k in ('stage_run_id','stage','task_id','subtask_id','review_id','job_id','status','created_at','finished_at','acceptance_id','contract_id','error')},'source_file':stage['_file']})
    operations=read_operations(root,jobs,read_json,warnings)
    for operation in operations:
        owners=[job_by_id.get(identifier) for identifier in [operation.get('job_id'),operation.get('source_job_id'),*operation.get('related_job_ids',[])]]
        pids={j['resolved_plan_id'] for j in owners if j}
        if not pids:
            candidates=[p['id'] for p in plans.values() if operation.get('task_id') in p['task_ids']]
            pids={candidates[0]} if len(candidates)==1 else {'__unassigned__'}
        operation['resolved_plan_ids']=sorted(pids)
        if '__unassigned__' in pids and '__unassigned__' not in plans:
            plans['__unassigned__']={'id':'__unassigned__','title':'未归属历史记录','type':'unassigned','created_at':None,'description':'缺少唯一归属的原始记录。','task_ids':[],'tasks':[],'jobs':[],'stages':[]}
    for plan in plans.values():
        events=[];nodes=[];edges=[]
        for task in plan['tasks']:
            scope=task['id']+'/'
            for sub in task['subtasks']:
                key=scope+sub['id'];nodes.append({'id':key,'label':sub['id'],'title':sub['title'],'task_id':task['id'],'role':'work'})
                for dep in sub['depends_on']:edges.append({'source':scope+dep,'target':key,'kind':'dependency'})
            for review in task['reviews']:
                key=scope+review['id'];nodes.append({'id':key,'label':review['id'],'title':review['title'],'task_id':task['id'],'role':'review'})
                for target in review['targets']:edges.append({'source':scope+target,'target':key,'kind':'review-target'})
            if not task['subtasks']:
                nodes.append({'id':task['id'],'label':task['id'],'title':task['title'],'task_id':task['id'],'role':'task'})
            for dep in task['depends_on']:edges.append({'source':dep,'target':task['id'],'kind':'dependency'})
        known_ids={n['id'] for n in nodes}
        for edge in edges:
            for key in ('source','target'):
                if edge[key] not in known_ids:
                    nodes.append({'id':edge[key],'label':edge[key],'role':'unresolved','title':'依赖端点未登记'});known_ids.add(edge[key])
        for job in plan['jobs']:
            events.append({'id':'job:'+job['id'],'kind':job['role'],'job_id':job['id'],'task_id':job.get('task_id'),
                           'unit_id':job.get('subtask_id') or job.get('review_id') or job.get('task_id') or 'execution',
                           'title':job.get('subtask_id') or job.get('review_id') or job['id'],'status':job.get('status') or 'unknown',
                           'start':start_time(job),'end':job.get('finished_at'),'continued_from':job.get('continued_from_job_id'),
                           'provider':job.get('provider'),'error':job.get('error')})
        for stage in plan['stages']:
            if stage.get('job_id') in job_by_id and stage.get('stage') in ('work','review'):continue
            events.append({'id':stage['stage_run_id'],'kind':stage.get('stage') or 'stage','job_id':stage.get('job_id'),
                           'task_id':stage.get('task_id'),'unit_id':stage.get('stage'),'title':{'plan':'制定计划','accept':'验收'}.get(stage.get('stage'),stage.get('stage')),
                           'status':stage.get('status') or 'unknown','start':start_time(stage),'end':stage.get('finished_at'),'source_file':stage['source_file'],'error':stage.get('error')})
        activity=plan_activity(operations,plan['id'],job_by_id)
        events.extend(activity)
        events.sort(key=lambda e:(timestamp(e.get('start')) is None,timestamp(e.get('start')) or float('-inf')))
        works=[j for j in plan['jobs'] if j['role'] in ('work','integration')]
        latest={}
        current_contracts={t['id']:t.get('contract_digest') for t in plan['tasks']}
        for job in works:
            expected=current_contracts.get(job.get('task_id'))
            job['contract_current']=(job.get('contract_digest')==expected) if expected and job.get('contract_digest') else None
            if job['contract_current'] is False:
                continue
            key=(job.get('task_id'),job.get('subtask_id') or job.get('task_id'))
            latest[key]=job
        current=list(latest.values())
        review_passes=[]
        latest_reviews={}
        for job in plan['jobs']:
            if job['role']=='review':latest_reviews[(job.get('task_id'),job.get('review_id') or job['id'])]=job
        for job in plan['jobs']:
            fact=job.get('review') or {}
            if fact.get('verdict'):
                matching=bool(fact.get('contract_digest')) and fact['contract_digest']==current_contracts.get(job.get('task_id'))
                matching=matching and bool(fact.get('patch_digest')) and any(w.get('task_id')==job.get('task_id') and w.get('patch_digest')==fact['patch_digest'] for w in current)
                fact['binding_current']=matching
                if fact.get('verdict')=='PASS' and matching and job in latest_reviews.values() and job.get('status')=='completed':review_passes.append(job)
        required_reviews={(t['id'],r['id']) for t in plan['tasks'] for r in t['reviews']}
        required_units={(t['id'],s['id']) for t in plan['tasks'] for s in t['subtasks']}
        observed_units=set(latest)
        passed_reviews={(j.get('task_id'),j.get('review_id')) for j in review_passes}
        reviews_complete=bool(required_reviews) and required_reviews.issubset(passed_reviews)
        if any(j.get('status') in ('running','queued') for j in current):state='running'
        elif any(j.get('status')=='failed' for j in current):state='failed'
        elif any(j.get('status')=='cancelled' for j in current):state='cancelled'
        elif required_units and not required_units.issubset(observed_units):state='partial' if current else 'planned'
        elif any(current_contracts.get(j.get('task_id')) and j.get('contract_current') is None for j in current):state='binding_unknown'
        elif current and all(j.get('phase') in ('applied','applied_and_cleaned') or j.get('applied_at') or j.get('commit_id') or j['delivery'].get('exists') for j in current):state='applied'
        elif current and all(j.get('acceptance_status')=='accepted' for j in current):state='accepted'
        elif current and all(j.get('status')=='completed' for j in current):
            state='reviewed' if reviews_complete else 'awaiting_review' if required_reviews else 'awaiting_acceptance'
        else:state='planned'
        if plan['type']=='unassigned':state='unknown'
        deliveries=[j['delivery'] for j in works if j['delivery'].get('commit_id')]
        if state not in ('failed','cancelled','running','partial','binding_unknown') and current and all(j.get('status')=='completed' and j.get('acceptance_status')=='accepted' and j['delivery'].get('reachable') for j in current):state='delivered'
        delivery_state='committed' if state=='delivered' else deliveries[0]['state'] if len(deliveries)==1 else 'partial' if deliveries else 'unlinked'
        plan.update({'state':state,'events':events,'git_activity':activity,'graph':{'nodes':nodes,'edges':edges},'job_count':len(plan['jobs']),
                     'task_count':len(set(plan['task_ids'])),'failure_count':sum(j.get('status')=='failed' for j in plan['jobs']),
                     'delivery':{'state':delivery_state,'commits':list({d['commit_id']:d for d in deliveries}.values())}})
        if not plan['created_at']:
            # An actual recorded event time is a useful fallback; never use file mtime.
            plan['created_at']=next((e['start'] for e in events if timestamp(e.get('start')) is not None),None)
            plan['time_source']='first-recorded-event'
        else:plan['time_source']='plan-created-at'
    result=list(plans.values())
    result.sort(key=lambda p:timestamp(p.get('created_at')) or float('-inf'),reverse=True)
    try:git=git_state(project_dir)
    except (GitReadError,OSError,ValueError) as exc:git={'repository':None,'error':str(exc),'status':{}}
    counts={'plans':sum(p['type'] not in ('unassigned','missing-manifest') for p in result),'groups':len(result),'tasks':sum(p['task_count'] for p in result),'jobs':len(normalized_jobs),'stages':len(stages),
            'failed_jobs':sum(j.get('status')=='failed' for j in normalized_jobs),'linked_jobs':sum(bool(j['delivery'].get('commit_id')) for j in normalized_jobs)}
    commit_links={}
    for plan in result:
        for delivery in plan['delivery']['commits']:
            commit_links.setdefault(delivery['commit_id'],[]).append({'plan_id':plan['id'],'relation':'delivery','label':'交付提交'})
        for event in plan['git_activity']:
            sha=event.get('commit_id')
            if sha and re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}',str(sha)):
                link={'plan_id':plan['id'],'relation':event['git_kind'],'label':event['title'],'event_id':event['id']}
                existing=commit_links.setdefault(sha,[])
                if not any(l['plan_id']==plan['id'] and l['label']==link['label'] for l in existing):existing.append(link)
    return {'project_dir':project_dir,'orchestrator_dir':orchestrator_dir,'plans':result,'counts':counts,'warnings':warnings,'git':git,'commit_links':commit_links,
            'generated_at':datetime.now(timezone.utc).isoformat(),'refresh':'manual','schema_version':1}
