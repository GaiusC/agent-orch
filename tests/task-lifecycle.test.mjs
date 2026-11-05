import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, inventory, json, save } from '../scripts/lib/lifecycle-git.mjs';
import { persistPlannerContract } from '../scripts/lib/contracts.mjs';
import { StateStore } from '../scripts/lib/state.mjs';
import { StageRuntime } from '../scripts/lib/stage-runtime.mjs';
import { WorkerOrchestrator } from '../scripts/lib/orchestrator.mjs';
import { bindProject } from '../scripts/lib/project-identity.mjs';
import { startIntegration } from '../scripts/lib/integration.mjs';
import { validateTaskDelivery } from '../scripts/lib/branch-delivery.mjs';
import { carryVerifiedBaseline } from '../scripts/lib/environment-baseline.mjs';
import { reserveWorkspace } from '../scripts/lib/workspace-pool.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-orch-083-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  await fs.writeFile(path.join(root,'README.md'),'base\n');
  await fs.writeFile(path.join(root,'verify.cjs'),"const fs=require('fs');if(fs.readFileSync('feature.txt','utf8')!=='good')process.exit(1);\n");
  await git(root,['init','-b','main']);await git(root,['config','user.name','Lifecycle test']);await git(root,['config','user.email','lifecycle@example.invalid']);await git(root,['config','core.autocrlf','false']);
  await git(root,['add','.']);await git(root,['commit','-m','base']);
  const config={version:2,trusted:true,mcp:{enabled:true},host:{provider:'codex'},
    cli:{codex:process.execPath,codex_prefix_args:[path.join(here,'fixtures/fake-codex-worker.mjs')],agy:process.execPath,agy_prefix_args:[path.join(here,'fixtures/fake-agy.mjs')],agy_env:{AGENT_ORCH_FAKE_AGY_MODE:'review-pass'}},
    execution:{codex_worker_timeout_seconds:20,agy_timeout_seconds:20,max_cc_repair_rounds:0},git_lifecycle:{commit_policy:'auto',merge_policy:'ask',max_worker_worktrees:3,max_worktrees:5},
    review_gate:{require_reviewer_for_implementation:true,allow_waiver:false},verification:{commands:['node verify.cjs']}};
  await save(path.join(root,'.agent-orchestrator/config.json'),config);
  const store=new StateStore(path.join(root,'.agent-orchestrator/state'),{jobsRoot:path.join(root,'.agent-orchestrator/runs'),orchestratorRoot:path.join(root,'.agent-orchestrator')});
  await store.init();const orch=new WorkerOrchestrator(store),runtime=new StageRuntime(store,root);
  return {root,config,store,orch,runtime};
}
async function plan(p,id='task',branch={mode:'create',confirm:true},actor='chat-a') {
  const contract=await persistPlannerContract(p.root,id,{contract_id:'contract-'+id,contract_version:1,repository_identity:'fixture',
    executor_subtasks:[{subtask_id:'impl',role:'executor',objective:'Create feature.txt containing good',complexity:'low',writable_paths:['feature.txt'],forbidden_paths:['.git/','.env'],required_tests:['node verify.cjs']}],
    reviewer_tasks:[{review_id:'review',role:'reviewer',type:'verify',complexity:'low',target_subtask_ids:['impl'],required_checks:['Inspect exact patch']}]},actor);
  const binding=await bindProject(p.root);
  const identity=await p.runtime.savePlanIdentity(id,{project_id:binding.project_id,coordinator_common:binding.coordinator_common,provider:'codex',model:'fixture-host',invocation:'in_session',session_id:actor,contract_id:contract.contract_id,contract_digest:contract.contract_digest});
  await p.orch.taskLifecycle.mutate(p.root,id,actor,null,async()=>{
    await p.orch.taskLifecycle.ensure(p.root,id,identity,{legacy:false,locked:true});
    if(branch) await p.orch.taskLifecycle.bindBranch(p.root,id,branch,actor);
  });
  return id;
}
async function work(p,id='task',actor='chat-a') {
  const started=await p.orch.taskLifecycle.mutate(p.root,id,actor,null,owner=>p.orch.startStageWork({project_dir:p.root,task_id:id,subtask_id:'impl',coordinator_fence:{session_id:actor,epoch:owner.epoch}},[{provider:'codex_worker',model:'fixture-worker',invocation:'cli'}]));
  const result=await p.orch.wait(started.id);assert.equal(result.status,'completed',result.error);return p.store.getJob(started.id);
}
async function accept(p,job,actor='chat-a') {
  const review=await p.orch.startVerify({project_dir:p.root,task_id:job.task_id,review_id:'review',model:'fixture-reviewer'});
  const reviewed=await p.orch.wait(review.id);assert.equal(reviewed.status,'completed',reviewed.error);
  await p.orch.taskLifecycle.mutate(p.root,job.task_id,actor,null,()=>p.orch.accept({project_dir:p.root,task_id:job.task_id,job_id:job.id,accepter_model:'fixture-host',session_id:actor}));
}
async function finalize(p,job,args={},actor='chat-a') {
  return p.orch.taskLifecycle.mutate(p.root,job.task_id,actor,null,owner=>p.orch.finalize(job.id,{...args,coordinator_fence:{session_id:actor,epoch:owner.epoch}}));
}

test('committed pending merge releases directory; persistent proof survives GC and merges idempotently',async t=>{
  const p=await fixture(t);await plan(p);const base=await git(p.root,['rev-parse','HEAD']);
  const job=await work(p);await accept(p,job);
  const result=await finalize(p,job,{merge:false});
  assert.equal(result.status,'committed_pending_merge');assert.equal(result.workspace_status,'cleaned');assert.equal(await git(p.root,['rev-parse','HEAD']),base);
  assert.equal(await fs.stat(job.workspace.path).then(()=>true,()=>false),false);
  const saved=await p.store.getJob(job.id),proof=await validateTaskDelivery(p.orch,saved);
  await git(p.root,['gc','--prune=now']);assert.equal(await git(p.root,['rev-parse',proof.ref]),proof.commit_id);
  const restored=path.join(p.root,'restore-check');await git(p.root,['worktree','add','--detach',restored,proof.ref]);
  assert.equal(await git(restored,['rev-parse','HEAD^{tree}']),proof.tree_id);assert.equal(await fs.readFile(path.join(restored,'feature.txt'),'utf8'),'good');
  await git(p.root,['worktree','remove',restored]);
  const merged=await finalize(p,saved,{confirm_merge:true,delete_branch:true});assert.equal(merged.status,'closed');
  const tip=await git(p.root,['rev-parse','HEAD']);assert.equal(tip,proof.commit_id);
  assert.equal((await finalize(p,saved,{confirm_merge:true})).status,'closed');assert.equal(await git(p.root,['rev-parse','HEAD']),tip);
});

test('dirty checked-out target and ignored collision stay pending without moving source ref or index',async t=>{
  const p=await fixture(t);await plan(p);const job=await work(p);await accept(p,job);
  await fs.writeFile(path.join(p.root,'README.md'),'staged\n');await git(p.root,['add','README.md']);await fs.writeFile(path.join(p.root,'README.md'),'working\n');
  const head=await git(p.root,['rev-parse','HEAD']),index=await fs.readFile(path.join(p.root,'.git/index'));
  const pending=await finalize(p,job,{confirm_merge:true});assert.equal(pending.status,'committed_pending_merge');
  assert.equal(await git(p.root,['rev-parse','HEAD']),head);assert.deepEqual(await fs.readFile(path.join(p.root,'.git/index')),index);assert.equal(await fs.readFile(path.join(p.root,'README.md'),'utf8'),'working\n');
  // An explicit fixture user resolves their own edit; ignored collisions remain protected.
  await git(p.root,['restore','--staged','--worktree','README.md']);await fs.appendFile(path.join(p.root,'.git/info/exclude'),'\nfeature.txt\n');await fs.writeFile(path.join(p.root,'feature.txt'),'unique artifact');
  const blocked=await finalize(p,await p.store.getJob(job.id),{confirm_merge:true});assert.match(blocked.merge.reason,/collide/);assert.equal(await fs.readFile(path.join(p.root,'feature.txt'),'utf8'),'unique artifact');
});

test('target advancement uses a new independently reviewed integration from persistent task refs',async t=>{
  const p=await fixture(t);await plan(p);const job=await work(p);await accept(p,job);await finalize(p,job,{merge:false});
  await fs.writeFile(path.join(p.root,'README.md'),'other accepted feature\n');await git(p.root,['add','README.md']);await git(p.root,['commit','-m','independent target advancement']);
  const old=await finalize(p,await p.store.getJob(job.id),{confirm_merge:true});assert.equal(old.merge.status,'integration_required');
  await plan(p,'integration');
  const task=await p.orch.taskLifecycle.record(p.root,'integration');
  const started=await startIntegration(p.orch,{project_dir:p.root,task_id:'integration',subtask_id:'impl',target_job_id:job.id,coordinator_fence:{session_id:'chat-a',epoch:task.epoch}});
  const result=await p.orch.wait(started.id);assert.equal(result.status,'completed',result.error);
  const combined=await p.store.getJob(started.id);await accept(p,combined);
  const merged=await finalize(p,combined,{confirm_merge:true});assert.equal(merged.status,'closed');
  assert.equal(await fs.readFile(path.join(p.root,'README.md'),'utf8'),'other accepted feature\n');assert.equal(await fs.readFile(path.join(p.root,'feature.txt'),'utf8'),'good');
  assert.equal((await p.store.getJob(job.id)).closeout_phase,'closed');
});

test('handoff adopts an in-flight job, fences old coordinator, preserves immutable Plan and independent notification cursors',async t=>{
  const p=await fixture(t);await plan(p);
  const before=await fs.readFile(p.runtime.planIdentityFile('task'));
  const started=await p.orch.taskLifecycle.mutate(p.root,'task','chat-a',1,owner=>p.orch.startStageWork({project_dir:p.root,task_id:'task',subtask_id:'impl',coordinator_fence:{session_id:'chat-a',epoch:owner.epoch}},[{provider:'codex_worker',model:'fixture-worker',invocation:'cli'}]));
  const identity=await p.runtime.loadPlanIdentity('task');
  const handoff=await p.orch.taskLifecycle.handoff(p.root,'task',{mode:'prepare',expected_epoch:1,to_session_id:'chat-b',reason:'user requested a new chat'},'chat-a',identity);
  const claimed=await p.orch.taskLifecycle.handoff(p.root,'task',{mode:'claim',expected_epoch:1,handoff_id:handoff.handoff_id,confirm:true,reason:'continue the authorized task',actor_identity:{provider:'codex',model:'fixture-host',invocation:'in_session'}},'chat-b',identity);
  assert.equal(claimed.epoch,2);
  await assert.rejects(()=>p.orch.taskLifecycle.assertOwner(p.root,'task','chat-a',1),/TASK_OWNER_FENCED/);
  await assert.rejects(()=>p.orch.taskLifecycle.handoff(p.root,'task',{mode:'claim',expected_epoch:1,handoff_id:handoff.handoff_id,confirm:true,reason:'competing claim'},'chat-c',identity),/HANDOFF_STALE/);
  assert.equal((await p.orch.wait(started.id)).status,'completed');const job=await p.store.getJob(started.id);await accept(p,job,'chat-b');
  assert.equal((await finalize(p,job,{confirm_merge:true},'chat-b')).status,'closed');assert.deepEqual(await fs.readFile(p.runtime.planIdentityFile('task')),before);
  for(const consumer of ['new-observer','old-observer']) {
    const result=await p.orch.notifications().wait({project_dir:p.root,job_id:job.id,consumer_id:consumer,timeout_ms:0});assert.equal(result.events[0].type,'terminal');
  }
});

test('cleanup defers for unique ignored artifacts without losing the committed result',async t=>{
  const p=await fixture(t);await plan(p);const job=await work(p);await accept(p,job);
  await fs.appendFile(path.join(p.root,'.git/info/exclude'),'\nunique.tmp\n');await fs.writeFile(path.join(job.workspace.path,'unique.tmp'),'keep');
  const result=await finalize(p,job,{merge:false});assert.equal(result.workspace_status,'cleanup_deferred');assert.ok(result.task_commit_id);
  await fs.rename(path.join(job.workspace.path,'unique.tmp'),path.join(p.root,'preserved-artifact.tmp'));
  const retried=await finalize(p,await p.store.getJob(job.id),{merge:false});assert.equal(retried.workspace_status,'cleaned');
});

test('prepared environment mutations are fenced after handoff, while preservation remains available',async t=>{
  const p=await fixture(t);await plan(p);
  await fs.writeFile(path.join(p.root,'feature.txt'),'historical');
  const audit=await p.orch.gitLifecycle.audit(p.root);
  const prepared=await p.orch.gitLifecycle.reconcile(p.root,{audit_id:audit.audit_id,coordinator_session_id:'chat-a',baseline:'head',actions:[{kind:'wip',paths:['feature.txt'],branch:'codex/old-owner-wip',message:'preserve',reason:'known test edit'}]});
  const identity=await p.runtime.loadPlanIdentity('task');
  await p.orch.taskLifecycle.handoff(p.root,'task',{mode:'recover',expected_epoch:1,from_session_id:'chat-a',confirm:true,reason:'explicit fixture transfer',actor_identity:{provider:'codex',model:'fixture-host',invocation:'in_session'}},'chat-b',identity);
  await assert.rejects(()=>p.orch.gitLifecycle.reconcile(p.root,{audit_id:audit.audit_id,mode:'execute',plan_id:prepared.plan_id,coordinator_session_id:'chat-a',confirm:true}),/TASK_OWNER_FENCED/);
  await assert.rejects(()=>p.orch.gitLifecycle.reconcile(p.root,{audit_id:audit.audit_id,mode:'execute',plan_id:prepared.plan_id,coordinator_session_id:'chat-b',confirm:true}),/TASK_OWNER_FENCED|OWNERSHIP_CHANGED/);
  assert.equal(await fs.readFile(path.join(p.root,'feature.txt'),'utf8'),'historical');
  assert.equal(await git(p.root,['rev-parse','--verify','refs/heads/codex/old-owner-wip'],{allowFailure:true}),null);
});

test('queued task base follows a verified accepted delivery and refuses an unrecorded target commit',async t=>{
  const p=await fixture(t);await fs.writeFile(path.join(p.root,'README.md'),'preserved\n');
  const audit=await p.orch.gitLifecycle.audit(p.root);
  const prepared=await p.orch.gitLifecycle.reconcile(p.root,{audit_id:audit.audit_id,baseline:'head',actions:[{kind:'preserve',paths:['README.md'],reason:'historical edit'}]});
  await p.orch.gitLifecycle.reconcile(p.root,{audit_id:audit.audit_id,mode:'execute',plan_id:prepared.plan_id,confirm:true});
  await plan(p,'queued');await plan(p,'delivered',{mode:'current',confirm:true});const job=await work(p,'delivered');await accept(p,job);
  const readyFile=path.join(p.root,'.agent-orchestrator/environment/readiness.json');
  const ready=await fs.readFile(readyFile);
  await finalize(p,job,{confirm_merge:true});
  // Simulate a crash after the exact delivery receipt, before readiness carry.
  await fs.writeFile(readyFile,ready);const source=await inventory(p.root);
  assert.equal(await carryVerifiedBaseline(p.root,source),true);
  assert.ok((await json(readyFile)).verified_delivery_ids.length);
  const queued=await p.orch.taskLifecycle.record(p.root,'queued');
  const resolved=await p.orch.taskLifecycle.prepareBase({id:'queued-not-started',project_dir:p.root,task_id:'queued',coordinator_fence:{session_id:'chat-a',epoch:queued.epoch}});
  assert.equal(resolved,await git(p.root,['rev-parse','HEAD']));
  await fs.writeFile(path.join(p.root,'unrecorded.txt'),'external');await git(p.root,['add','unrecorded.txt']);await git(p.root,['commit','-m','unrecorded external change']);
  assert.equal(await carryVerifiedBaseline(p.root,await inventory(p.root)),false);
  assert.equal(await p.orch.taskLifecycle.prepareBase({id:'queued-not-started',project_dir:p.root,task_id:'queued',coordinator_fence:{session_id:'chat-a',epoch:1}}),resolved);
});

test('branch-ref/proof crash recovery repairs task metadata without making another commit',async t=>{
  const p=await fixture(t);await plan(p);const job=await work(p);await accept(p,job);
  const before=await p.orch.taskLifecycle.record(p.root,'task');
  const result=await finalize(p,job,{merge:false,cleanup:false});
  await p.store.updateJob(job.id,{task_commit_id:null,delivery_status:'uncommitted'});
  await save(path.join(p.root,'.agent-orchestrator/tasks/task.json'),before);
  const recovered=await finalize(p,await p.store.getJob(job.id),{merge:false});
  assert.equal(recovered.task_commit_id,result.task_commit_id);assert.equal(recovered.workspace_status,'cleaned');
  assert.equal((await p.orch.taskLifecycle.record(p.root,'task')).branch.expected_tip,result.task_commit_id);
});

test('explicit completed branch reuse supersedes its predecessor and retains pending-subtask branches',async t=>{
  const p=await fixture(t);await plan(p,'first');const job=await work(p,'first');await accept(p,job);await finalize(p,job,{merge:false});
  await plan(p,'next',{mode:'reuse',task_branch:'codex/first',reuse_from_task_id:'first',confirm:true});
  assert.equal((await p.orch.taskLifecycle.record(p.root,'next')).branch.task_branch,'codex/first');
  await assert.rejects(()=>p.orch.taskLifecycle.assertOwner(p.root,'first','chat-a',1),/TASK_BRANCH_SUPERSEDED/);
});

test('handoff recovery requires explicit model approval and cannot transfer an active finalizer',async t=>{
  const p=await fixture(t);await plan(p);const identity=await p.runtime.loadPlanIdentity('task');
  const args={mode:'recover',expected_epoch:1,from_session_id:'chat-a',confirm:true,reason:'fixture transfer',actor_identity:{provider:'codex',model:'new-host',invocation:'in_session'}};
  await assert.rejects(()=>p.orch.taskLifecycle.handoff(p.root,'task',args,'chat-b',identity),/MODEL_APPROVAL_REQUIRED/);
  const active=await p.store.createJob({id:'finalize-fixture',type:'task_finalize',project_dir:p.root,task_id:'task',target_job_id:'work-fixture',status:'running'});
  const other=await p.store.createJob({id:'work-fixture-other',type:'stage_work',project_dir:p.root,task_id:'task',status:'completed'});
  await assert.rejects(()=>p.orch.startFinalization(other.id),/FINALIZATION_BUSY/);
  await assert.rejects(()=>p.orch.taskLifecycle.assertNoFinalization(p.root,'task'),/FINALIZATION_BUSY/);
  await assert.rejects(()=>p.orch.taskLifecycle.handoff(p.root,'task',{...args,allow_model_change:true},'chat-b',identity),/HANDOFF_BUSY/);
  await p.store.updateJob(active.id,{status:'cancelled'});
  const claimed=await p.orch.taskLifecycle.handoff(p.root,'task',{...args,allow_model_change:true},'chat-b',identity);
  assert.equal(claimed.epoch,2);assert.equal(claimed.identity.model,'new-host');assert.equal((await p.runtime.loadPlanIdentity('task')).model,'fixture-host');
});

test('legacy adoption blocks live unfenced runtimes but permits upgraded fenced supervisors',async t=>{
  const p=await fixture(t);await plan(p);const identity=await p.runtime.loadPlanIdentity('task');
  await fs.unlink(path.join(p.root,'.agent-orchestrator/tasks/task.json'));
  await p.orch.taskLifecycle.ensure(p.root,'task',identity);
  const job=await p.store.createJob({id:'old-review',type:'agy_verify',project_dir:p.root,task_id:'task',contract_digest:identity.contract_digest,status:'completed',supervisor_pid:process.ppid});
  const h=await p.orch.taskLifecycle.handoff(p.root,'task',{mode:'prepare',expected_epoch:1,to_session_id:'chat-b',reason:'fixture continuity'},'chat-a',identity);
  const args={mode:'claim',expected_epoch:1,handoff_id:h.handoff_id,confirm:true,reason:'fixture transfer',actor_identity:{provider:'codex',model:'fixture-host',invocation:'in_session'}};
  await assert.rejects(()=>p.orch.taskLifecycle.handoff(p.root,'task',args,'chat-b',identity),/LEGACY_RUNTIME_ACTIVE/);
  await p.store.updateJob(job.id,{coordination_protocol:1});
  assert.equal((await p.orch.taskLifecycle.handoff(p.root,'task',args,'chat-b',identity)).epoch,2);
});

test('copied task records cannot claim handoff authority in a different physical repository',async t=>{
  const p=await fixture(t),other=await fixture(t);await plan(p);
  const identity=await p.runtime.loadPlanIdentity('task'),record=await p.orch.taskLifecycle.record(p.root,'task');
  await save(path.join(other.root,'.agent-orchestrator/tasks/task.json'),record);
  const before=await fs.readFile(path.join(other.root,'.agent-orchestrator/tasks/task.json'));
  await assert.rejects(()=>other.orch.taskLifecycle.handoff(other.root,'task',{mode:'inspect'},'chat-a',identity),/TASK_PROJECT_IDENTITY_MISMATCH/);
  assert.deepEqual(await fs.readFile(path.join(other.root,'.agent-orchestrator/tasks/task.json')),before);
});

test('semantic index refresh can carry approved readiness; unknown content and index flags cannot',async t=>{
  const p=await fixture(t);
  await fs.writeFile(path.join(p.root,'README.md'),'historical working state\n');
  const audit=await p.orch.gitLifecycle.audit(p.root);
  const prepared=await p.orch.gitLifecycle.reconcile(p.root,{audit_id:audit.audit_id,mode:'prepare',baseline:'head',actions:[{kind:'preserve',paths:['README.md'],reason:'unrelated inherited edit'}]});
  await p.orch.gitLifecycle.reconcile(p.root,{audit_id:audit.audit_id,mode:'execute',plan_id:prepared.plan_id,confirm:true});
  const file=path.join(p.root,'.agent-orchestrator/environment/readiness.json'),old=await fs.readFile(file);
  await git(p.root,['update-index','--refresh'],{allowFailure:true});assert.equal(await carryVerifiedBaseline(p.root,await inventory(p.root)),true);
  await fs.writeFile(path.join(p.root,'unknown.txt'),'unknown');assert.equal(await carryVerifiedBaseline(p.root,await inventory(p.root)),false);await fs.unlink(path.join(p.root,'unknown.txt'));
  await fs.writeFile(file,old);await git(p.root,['update-index','--assume-unchanged','verify.cjs']);assert.equal(await carryVerifiedBaseline(p.root,await inventory(p.root)),false);
});

test('integration capacity remains available with four external directories under a five-slot total',async t=>{
  const p=await fixture(t);
  await fs.appendFile(path.join(p.root,'.git/info/exclude'),'\nexternal-*/\n');
  for(let i=0;i<4;i++) await git(p.root,['worktree','add','--detach',path.join(p.root,'external-'+i),'HEAD']);
  const integration=await reserveWorkspace({projectDir:p.root,jobDir:path.join(p.root,'.agent-orchestrator/runs/integration-slot'),config:{execution:{workspace_wait_timeout_seconds:1},git_lifecycle:{max_worker_worktrees:3,max_worktrees:5}},kind:'integration'});
  assert.ok(integration.path);const list=await git(p.root,['worktree','list','--porcelain']);assert.equal(list.split('\n').filter(l=>l.startsWith('worktree ')).length,6);
  const controller=new AbortController();setTimeout(()=>controller.abort(),100);
  await assert.rejects(()=>reserveWorkspace({projectDir:p.root,jobDir:path.join(p.root,'.agent-orchestrator/runs/blocked-worker'),config:{execution:{workspace_wait_timeout_seconds:1}},kind:'worker',signal:controller.signal}),/cancelled|capacity/i);
});
