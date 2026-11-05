#!/usr/bin/env node
// Real providers operate only in a new disposable fixture, never a user project.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { git, save } from './lib/lifecycle-git.mjs';
import { captureRuntimeEnvironment } from './lib/runtime-env.mjs';
import { StateStore } from './lib/state.mjs';
import { WorkerOrchestrator } from './lib/orchestrator.mjs';

const workerModel=process.env.AGENT_ORCH_E2E_CODEX_MODEL,reviewModel=process.env.AGENT_ORCH_E2E_REVIEW_MODEL,hostModel=process.env.AGENT_ORCH_E2E_HOST_MODEL;
if(!workerModel || !reviewModel || !hostModel) throw new Error('Set explicit current Worker, Review and host models before real E2E');
const plugin=process.env.AGENT_ORCH_E2E_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-orch-083-real-')),project=path.join(root,'project');
await fs.mkdir(project);
await fs.writeFile(path.join(project,'.gitignore'),'.agent-orchestrator/\n');
await fs.writeFile(path.join(project,'README.md'),'fixture\n');
await fs.writeFile(path.join(project,'AGENTS.md'),'Synthetic test only. Write only the exact file in your task. No Git commits, configuration changes, network research, process enumeration or access outside this fixture. No GPU or training. Runtime progress reporting is permitted.\n');
await fs.writeFile(path.join(project,'verify.cjs'),"const fs=require('fs');for(const n of (process.argv[2]==='all'?['a','b']:[process.argv[2]])){if(fs.readFileSync(n+'.txt','utf8')!==n.toUpperCase()+'\\n')process.exit(1);}\n");
await git(project,['init','-b','main']);await git(project,['config','user.name','Agent Orch E2E']);await git(project,['config','user.email','e2e@example.invalid']);await git(project,['config','core.autocrlf','false']);await git(project,['add','.']);await git(project,['commit','-m','synthetic fixture']);
const tiers=route=>({low:[route],medium:[route],high:[route]});
await save(path.join(project,'.agent-orchestrator/config.json'),{version:2,trusted:true,mcp:{enabled:true},host:{provider:'codex'},
  cli:{codex:process.env.AGENT_ORCH_CODEX_BIN || 'codex',agy:process.env.AGENT_ORCH_AGY_BIN || 'agy'},
  execution:{codex_worker_timeout_seconds:300,agy_timeout_seconds:300,max_cc_repair_rounds:0},
  git_lifecycle:{commit_policy:'auto',merge_policy:'ask',max_worker_worktrees:3,max_worktrees:5},review_gate:{require_reviewer_for_implementation:true,allow_waiver:false},
  scope:{writable:['a.txt','b.txt'],forbidden:['.git/','.env','.env.*']},
  stages:{plan:{routes:tiers({provider:'codex',model:hostModel,invocation:'in_session'})},work:{routes:tiers({provider:'codex_worker',model:workerModel,reasoning_effort:'medium',service_tier:null,invocation:'cli'})},review:{routes:tiers({provider:'agy',model:reviewModel,invocation:'cli'})},accept:{inherit_from:'plan'}}});
await captureRuntimeEnvironment(project);
const clients=[];const report={project_dir:project,root,provider_mode:'real Codex Worker + real AGY review; synthetic MCP coordinator identities',worker_model:workerModel,review_model:reviewModel,host_model:hostModel,started_at:new Date().toISOString(),jobs:[]};
const out=process.env.AGENT_ORCH_E2E_SUMMARY || path.join(root,'summary.json');
async function connect(actor) {
  const client=new Client({name:'agent-orch-083-real-e2e',version:'0.8.3'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(plugin,'scripts/mcp-stdio-bridge.mjs')],env:{...process.env,CODEX_THREAD_ID:''}}));clients.push(client);
  return {actor,client};
}
async function call(coordinator,name,args,allowError=false) {
  const owned=['stage-plan','stage-work','stage-work-continue','stage-review','stage-accept','stage-finalize','stage-integrate','apply','cleanup','cancel','task-handoff','environment-reconcile'];
  const result=await coordinator.client.callTool({name,arguments:{project_dir:project,...(owned.includes(name)?{coordinator_session_id:coordinator.actor}:{}),...args}});
  const value=JSON.parse(result.content[0].text);
  if(!allowError) assert.equal(result.isError,false,JSON.stringify(value));return {error:result.isError===true,value};
}
async function wait(c,id) {
  while(true) {
    const {value}=await call(c,'wait-for-job',{job_id:id,consumer_id:c.actor,until:'update',timeout_ms:30000});
    for(const event of value.events) console.log(JSON.stringify({event:'provider_event',...event}));
    if(value.events.some(e=>e.type==='terminal') || value.terminal) {
      // The driver inspects its own fixture receipt, not repeated MCP Status.
      const job=JSON.parse(await fs.readFile(path.join(project,'.agent-orchestrator/runs',id,'job.json'),'utf8'));
      assert.equal(job.status,'completed',job.error);report.jobs.push({id,status:job.status,model:job.model});return job;
    }
  }
}
function contract(task,names) {
  const target=names.length===1?names[0]:'all';
  return {contract_id:'contract-'+task,contract_version:1,executor_subtasks:[{subtask_id:'impl',role:'executor',complexity:'low',objective:names.length===1?`Create only ${target}.txt containing exactly ${target.toUpperCase()} followed by a newline. Do not change any other files. Run node verify.cjs ${target}.`:'Combine accepted A and B without changing unrelated files.',writable_paths:names.map(n=>n+'.txt'),forbidden_paths:['.git/','.env','.env.*'],required_tests:[`node verify.cjs ${target}`],fallback_policy:{enabled:false}}],reviewer_tasks:[{review_id:'review',role:'reviewer',type:'verify',complexity:'low',target_subtask_ids:['impl'],required_checks:[`Inspect the exact patch and independently run node verify.cjs ${target}. Verify only authorized files changed. Return VERDICT: PASS only on success. No writes, Git mutations or outside-fixture reads.`],fallback_policy:{enabled:false}}]};
}
async function plan(c,task,names) {return (await call(c,'stage-plan',{task_id:task,planner_session_id:c.actor,contract:contract(task,names),branch:{mode:'create',target_branch:'main',confirm:true}})).value;}
async function reviewAccept(c,task,job) {
  const {value:full}=await call(c,'result',{job_id:job.id,detail:'full'});
  assert.equal(full.evidence.verification.passed,true);assert.equal(full.evidence.changes.forbidden_changes.length,0);assert.equal(full.evidence.changes.unauthorized_changes.length,0);
  const {value:r}=await call(c,'stage-review',{task_id:task,review_id:'review'});await wait(c,r.job.id);
  const {value:findings}=await call(c,'result',{job_id:r.job.id,detail:'full'});assert.match(findings.evidence.result,/VERDICT:\s*PASS/);assert.equal(findings.evidence.review_evidence.patch_digest,full.evidence.changes.patch_digest);
  await call(c,'stage-accept',{task_id:task,job_id:job.id,accepter_session_id:c.actor,summary:'Main-chat synthetic E2E: exact file/test checks and independent real AGY PASS inspected; no user-project acceptance.'});
}
try {
  console.log(JSON.stringify({event:'fixture_created',project_dir:project}));
  const a=await connect('e2e-origin-a'),b=await connect('e2e-origin-b'),successor=await connect('e2e-successor-a'),integrator=await connect('e2e-integrator');
  await fs.writeFile(path.join(project,'README.md'),'staged historical edit\n');await git(project,['add','README.md']);await fs.writeFile(path.join(project,'README.md'),'working historical edit\n');
  const staged=await git(project,['show',':README.md']),working=await fs.readFile(path.join(project,'README.md'),'utf8');
  let {value:audit}=await call(a,'environment-audit',{context:{known_facts:['Synthetic README staged and working edits must be preserved']}});
  let {value:prepared}=await call(a,'environment-reconcile',{audit_id:audit.audit_id,mode:'prepare',baseline:'head',actions:[{kind:'preserve',paths:['README.md'],reason:'Synthetic preexisting edits'}]});
  await call(a,'environment-reconcile',{audit_id:audit.audit_id,mode:'execute',plan_id:prepared.plan_id,confirm:true});
  const originalPlan=await plan(a,'task-a',['a']);await plan(b,'task-b',['b']);
  const planFile=path.join(project,'.agent-orchestrator/plans/task-a.execution.json'),identityBefore=await fs.readFile(planFile);
  const {value:wa}=await call(a,'stage-work',{task_id:'task-a',subtask_id:'impl'}),{value:wb}=await call(b,'stage-work',{task_id:'task-b',subtask_id:'impl'});
  const {value:h}=await call(a,'task-handoff',{task_id:'task-a',mode:'prepare',expected_epoch:1,to_session_id:successor.actor,reason:'Synthetic user requests cross-chat continuation'});
  const {value:claim}=await call(successor,'task-handoff',{task_id:'task-a',mode:'claim',expected_epoch:1,handoff_id:h.handoff_id,confirm:true,host_model:hostModel,reason:'Continue existing job without changing budget or evidence'});assert.equal(claim.epoch,2);
  const rejected=await call(a,'stage-accept',{task_id:'task-a',job_id:wa.job.id,accepter_session_id:a.actor},true);assert.equal(rejected.error,true);assert.match(rejected.value.error,/TASK_OWNER_FENCED/);
  const [ja,jb]=await Promise.all([wait(successor,wa.job.id),wait(b,wb.job.id)]);
  report.worker_overlap_ms=Math.min(Date.parse(ja.finished_at),Date.parse(jb.finished_at))-Math.max(Date.parse(ja.started_at||ja.created_at),Date.parse(jb.started_at||jb.created_at));assert.ok(report.worker_overlap_ms>0);
  await Promise.all([reviewAccept(successor,'task-a',ja),reviewAccept(b,'task-b',jb)]);
  for(const [c,job] of [[successor,ja],[b,jb]]) {
    const {value:r}=await call(c,'stage-finalize',{job_id:job.id,merge:false,cleanup:true});assert.equal(r.status,'committed_pending_merge');assert.equal(r.workspace_status,'cleaned');
  }
  assert.equal(await git(project,['show',':README.md']),staged);assert.equal(await fs.readFile(path.join(project,'README.md'),'utf8'),working);
  const store=new StateStore(path.join(project,'.agent-orchestrator/state'),{jobsRoot:path.join(project,'.agent-orchestrator/runs'),orchestratorRoot:path.join(project,'.agent-orchestrator')});await store.init();const helper=new WorkerOrchestrator(store);
  await fs.writeFile(path.join(project,'target-note.txt'),'independent target advancement\n');await helper.gitLifecycle.commitExact(project,['target-note.txt'],'fixture: independently advance target',path.join(root,'target-commit'));
  const advanced=await call(successor,'stage-finalize',{job_id:ja.id,confirm_merge:true});assert.equal(advanced.value.merge.status,'integration_required');
  ({value:audit}=await call(a,'environment-audit',{}));({value:prepared}=await call(a,'environment-reconcile',{audit_id:audit.audit_id,mode:'prepare',baseline:'head',actions:[{kind:'preserve',paths:['README.md'],reason:'Preserve staged and working edits at new explicit fixture baseline'}]}));
  await call(a,'environment-reconcile',{audit_id:audit.audit_id,mode:'execute',plan_id:prepared.plan_id,confirm:true});
  await plan(integrator,'combined',['a','b']);const {value:integration}=await call(integrator,'stage-integrate',{task_id:'combined',subtask_id:'impl',job_ids:[ja.id,jb.id]});const combined=await wait(integrator,integration.job.id);await reviewAccept(integrator,'combined',combined);
  const {value:pending}=await call(integrator,'stage-finalize',{job_id:combined.id,merge:false});assert.equal(pending.workspace_status,'cleaned');
  await git(project,['gc','--prune=now']);assert.equal((await helper.gitLifecycle.worktrees(project)).length,1);
  // Explicitly preserve and clear only this synthetic historical edit, then merge.
  ({value:audit}=await call(a,'environment-audit',{}));({value:prepared}=await call(a,'environment-reconcile',{audit_id:audit.audit_id,mode:'prepare',baseline:'head',actions:[{kind:'wip',paths:['README.md'],branch:'codex/e2e-preserved-history',message:'Synthetic historical WIP',reason:'Temporarily clear fixture target after preserving both patches',clear_saved_paths:true}]}));
  await call(a,'environment-reconcile',{audit_id:audit.audit_id,mode:'execute',plan_id:prepared.plan_id,confirm:true});
  const {value:closed}=await call(integrator,'stage-finalize',{job_id:combined.id,confirm_merge:true,delete_branch:true});assert.equal(closed.status,'closed');
  for(const [c,j] of [[successor,ja],[b,jb]]) assert.equal((await call(c,'stage-finalize',{job_id:j.id,confirm_merge:true,delete_branch:true})).value.status,'closed');
  await fs.writeFile(path.join(project,'README.md'),staged+'\n');await git(project,['add','README.md']);await fs.writeFile(path.join(project,'README.md'),working);
  assert.equal(await git(project,['show',':README.md']),staged);assert.equal(await fs.readFile(path.join(project,'README.md'),'utf8'),working);
  assert.equal(await fs.readFile(path.join(project,'a.txt'),'utf8'),'A\n');assert.equal(await fs.readFile(path.join(project,'b.txt'),'utf8'),'B\n');
  assert.equal(await fs.readFile(path.join(project,'target-note.txt'),'utf8'),'independent target advancement\n');assert.deepEqual(await fs.readFile(planFile),identityBefore);
  report.status='passed';report.status_calls=0;report.finalization=closed;report.original_plan_digest=originalPlan.contract.contract_digest;report.handoff_epoch=2;report.old_owner_fenced=true;report.worktrees_remaining=1;report.historical_staged_and_working_states_preserved=true;
} catch(error) {report.status='failed';report.error=error.stack;throw error;}
finally {for(const c of clients)await c.close().catch(()=>{});report.finished_at=new Date().toISOString();await save(out,report);console.log(JSON.stringify(report));}
