import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {recommendRoutes,workRouteChain,reviewUpgrade} from '../scripts/lib/route-recommendations.mjs';
import {discoverHostModel,normalizeCatalog,normalizeModelSelection,promptInitializationSelection} from '../scripts/lib/model-selection.mjs';
import {persistPlannerContract} from '../scripts/lib/contracts.mjs';
import {WorkerOrchestrator} from '../scripts/lib/orchestrator.mjs';
import {StateStore} from '../scripts/lib/state.mjs';

function catalog() {
  return {providers:normalizeCatalog({codex:['gpt-8.1-sol','gpt-9.2-terra','gpt-9.2-sol','gpt-9-astra'],
    agy:['gemini-8-flash-high','claude-sonnet-7-2-medium','gemini-10-argon-high','claude-sonnet-7-2-high','gemini-10-argon-low']}),warnings:[]};
}
test('recommendation follows versioned families, not catalog order or fixed model ids',()=>{
  const result=recommendRoutes(catalog(),{hostModel:'actual-host'});assert.equal(result.available,true);
  const stages=normalizeModelSelection(result.selection);
  assert.equal(stages.plan.routes.high[0].model,'actual-host');assert.equal(stages.accept.inherit_from,'plan');
  assert.deepEqual(['low','medium','high'].map(t=>[stages.work.routes[t][0].model,stages.work.routes[t][0].reasoning_effort]),
    [['gpt-9.2-terra','medium'],['gpt-9.2-sol','medium'],['gpt-9.2-sol','high']]);
  assert.deepEqual(stages.review.routes.high.map(r=>r.model),['claude-sonnet-7-2-high','gemini-10-argon-high','gemini-8-flash-high']);
  assert.equal(stages.work.escalation.review_failures_before_upgrade,2);
  assert.deepEqual(workRouteChain({stages},'low').map(r=>r.effective_complexity),['low','medium','high']);
});
test('missing families, host identity and unsupported reasoning require customization',()=>{
  assert.equal(recommendRoutes(catalog()).available,false);
  const input=catalog();input.providers.agy=input.providers.agy.filter(e=>!e.id.includes('sonnet'));
  assert.ok(recommendRoutes(input,{hostModel:'host'}).missing.includes('Sonnet High'));
  input.providers.codex.find(e=>e.id==='gpt-9.2-sol').reasoning_efforts=['medium'];
  assert.ok(recommendRoutes(input,{hostModel:'host'}).missing.some(m=>m.includes('reasoning high')));
});
test('new Worker family names supersede old Sol/Terra without pinning family defaults',()=>{
  const input=catalog();input.providers.codex.push({id:'gpt-12-nova',label:'Newest family',priority:1},{id:'gpt-12-orbit',priority:2});
  const result=recommendRoutes(input,{hostModel:'host'});assert.equal(result.available,true);
  assert.equal(result.selection.work.routes.high[0].model,'gpt-12-nova');assert.equal(result.selection.work.routes.low[0].model,'gpt-12-orbit');
});
test('host identity is read only from the exact active thread metadata',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'orch-host-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const id='11111111-1111-4111-8111-111111111111',folder=path.join(root,'sessions/2026/11/04');await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,`rollout-${id}.jsonl`),JSON.stringify({type:'turn_context',payload:{model:'previous-host'}})+'\n'+JSON.stringify({type:'turn_context',payload:{model:'actual-host'}})+'\n{partial');
  assert.equal(await discoverHostModel({threadId:id,codexHome:root}),'actual-host');
  assert.equal(await discoverHostModel({threadId:'../../secret',codexHome:root}),null);
  assert.equal(await discoverHostModel({threadId:'22222222-2222-4222-8222-222222222222',codexHome:root}),null);
});
test('using recommended routes needs one total confirmation and editing only changes the selected tier',async()=>{
  let answers=['1'];
  let result=await promptInitializationSelection({catalog:catalog(),hostModel:'host',ask:async()=>answers.shift(),write:()=>{}});
  assert.equal(answers.length,0);assert.equal(result.stages.work.routes.low[0].reasoning_effort,'medium');
  answers=['2','1','gpt-8.1-sol','high','fast','0','y'];
  result=await promptInitializationSelection({catalog:catalog(),hostModel:'host',ask:async()=>answers.shift(),write:()=>{}});
  assert.equal(result.stages.work.routes.low[0].model,'gpt-8.1-sol');assert.equal(result.stages.work.routes.low[0].service_tier,'fast');
  assert.equal(result.stages.work.routes.medium[0].model,'gpt-9.2-sol');assert.equal(answers.length,0);
  answers=['2','0','n'];await assert.rejects(promptInitializationSelection({catalog:catalog(),hostModel:'host',ask:async()=>answers.shift(),write:()=>{}}),/cancelled/);
});
test('non-interactive recommendations never persist without approval, including repeat initialization',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'orch-recommended-init-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const catalogFile=path.join(root,'catalog.json');await fs.writeFile(catalogFile,JSON.stringify(catalog().providers));
  const cli=fileURLToPath(new URL('../scripts/agent-orch.mjs',import.meta.url));
  const run=(...flags)=>spawnSync(process.execPath,[cli,'init','--ProjectDir',root,'--HostModel','host','--ModelCatalog',catalogFile,...flags],{encoding:'utf8',timeout:15000});
  let result=run();assert.equal(result.status,2,result.stderr);assert.deepEqual(JSON.parse(result.stdout).recommendation.choices,['use_recommended','edit_recommended','custom']);
  await assert.rejects(fs.stat(path.join(root,'.agent-orchestrator')),{code:'ENOENT'});
  result=run('--UseRecommendedRoutes');assert.equal(result.status,0,result.stderr);
  const file=path.join(root,'.agent-orchestrator/config.json'),before=await fs.readFile(file,'utf8'),config=JSON.parse(before);
  assert.equal(config.stages.work.escalation.review_failures_before_upgrade,2);assert.equal(config.stages.review.routes.high.length,3);
  assert.equal(run().status,2);assert.equal(await fs.readFile(file,'utf8'),before);
});
test('custom configuration keeps Plan in the actual host and remains available',async()=>{
  const answers=['3','1','custom-worker','n','custom-review','n','y'];
  const result=await promptInitializationSelection({catalog:catalog(),hostModel:'host',ask:async()=>{assert.ok(answers.length);return answers.shift();},write:()=>{}});
  assert.equal(result.stages.plan.routes.low[0].model,'host');assert.equal(result.stages.work.routes.low[0].model,'custom-worker');assert.equal(answers.length,0);
});
test('review upgrade counts consecutive explicit FAILs, excluding quota/auth and older contracts',()=>{
  const work={id:'work',project_dir:'p',task_id:'t',subtask_id:'s',contract_digest:'current',type:'stage_work',complexity:'low',created_at:'01'};
  const review=(id,error,time)=>({id,project_dir:'p',task_id:'t',type:'agy_review',implementation_job_id:'work',status:'failed',error,created_at:time});
  const options={projectDir:'p',taskId:'t',subtaskId:'s',contractDigest:'current',baseTier:'low',threshold:2};
  const jobs=[work,review('auth','AGY_AUTH_REQUIRED','02'),review('one','Error: AGY_REVIEW_REJECTED: FAIL','03')];
  assert.equal(reviewUpgrade(jobs,options).tier,'low');jobs.push(review('two','Error: AGY_REVIEW_REJECTED: FAIL','04'));
  assert.equal(reviewUpgrade(jobs,options).tier,'medium');
  jobs.push({...review('pass','', '05'),status:'completed'});jobs.push(review('three','Error: AGY_REVIEW_REJECTED: FAIL','06'));
  assert.equal(reviewUpgrade(jobs,options).tier,'low');assert.equal(reviewUpgrade(jobs,{...options,contractDigest:'new'}).tier,'low');
  const high=jobs.map(j=>j.id==='work'?{...j,effective_complexity:'high'}:j).filter(j=>j.id!=='pass');
  assert.throws(()=>reviewUpgrade(high,options),/complexity_exhausted/);
});

const fixtures=fileURLToPath(new URL('./fixtures/',import.meta.url));
async function setup(t,{workerMode='verify',reviewerMode='quota',baseComplexity='low'}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-orch-recommended-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,...args],{cwd:root,encoding:'utf8'}).trim();
  await fs.writeFile(path.join(root,'.gitignore'),'.agent-orchestrator/\n');await fs.writeFile(path.join(root,'README.md'),'fixture\n');
  await fs.writeFile(path.join(root,'verify.cjs'),"if(require('fs').readFileSync('feature.txt','utf8')!=='good')process.exit(1)\n");
  git('init');git('config','user.name','Routing Tests');git('config','user.email','routing@example.test');git('config','core.autocrlf','false');git('add','.');git('commit','-m','fixture');
  const stages=normalizeModelSelection({plan:{provider:'codex',model:'host'},
    work:{routes:{low:[{provider:'codex_worker',model:'work-low',reasoning_effort:'medium'}],medium:[{provider:'codex_worker',model:'work-sol',reasoning_effort:'medium'}],high:[{provider:'codex_worker',model:'work-sol',reasoning_effort:'high'}]},escalation:{enabled:true,review_failures_before_upgrade:2}},
    review:{routes:Object.fromEntries(['low','medium','high'].map(tier=>[tier,['review-high','review-mid','review-low'].map(model=>({provider:'agy',model}))])),quota_fallback:true}});
  const config={version:2,trusted:true,host:{provider:'codex'},mcp:{enabled:true},stages,
    cli:{codex:process.execPath,codex_prefix_args:[path.join(fixtures,'fake-adaptive-codex.mjs'),workerMode],agy:process.execPath,agy_prefix_args:[path.join(fixtures,'fake-adaptive-agy.mjs'),reviewerMode]},
    execution:{max_cc_repair_rounds:0,codex_worker_timeout_seconds:workerMode.includes('timeout')?1:20},scope:{writable:['feature.txt'],forbidden:['.git/','.env']},
    verification:{commands:['node verify.cjs']},review_gate:{require_reviewer_for_implementation:true,allow_waiver:false}};
  await fs.mkdir(path.join(root,'.agent-orchestrator'));await fs.writeFile(path.join(root,'.agent-orchestrator/config.json'),JSON.stringify(config));
  const contract={contract_id:'adaptive',contract_version:1,repository_identity:git('rev-parse','HEAD'),executor_subtasks:[{subtask_id:'impl',role:'executor',objective:'Implement feature.txt',complexity:baseComplexity,writable_paths:['feature.txt'],forbidden_paths:['.git/','.env'],required_tests:['node verify.cjs'],fallback_policy:{enabled:true}}],reviewer_tasks:[{review_id:'review',role:'reviewer',type:'verify',complexity:'high',target_subtask_ids:['impl'],required_checks:['Verify'],fallback_policy:{enabled:true}}]};
  await persistPlannerContract(root,'task',contract,'session');
  const store=new StateStore(path.join(root,'.agent-orchestrator/state'),{jobsRoot:path.join(root,'.agent-orchestrator/runs')});await store.init();const orch=new WorkerOrchestrator(store);
  async function work(){const started=await orch.startStageWork({project_dir:root,task_id:'task',subtask_id:'impl'},stages.work.routes.low);await orch.wait(started.id);return store.getJob(started.id);}
  return {root,git,config,contract,stages,store,orch,work};
}
test('real worker attempts escalate low to medium to high, preserving work, scope, logs and fresh sessions',async t=>{
  const p=await setup(t),job=await p.work();assert.equal(job.status,'completed',job.error);assert.equal(job.effective_complexity,'high');
  assert.equal(job.complexity,'low');assert.equal(job.route_attempts.length,3);
  assert.deepEqual(job.route_attempts.map(a=>a.status),['failed','failed','completed']);
  const dirs=['route-0','route-1','route-2'].map(d=>path.join(p.store.jobDir(job.id),d));
  const evidence=await Promise.all(dirs.map(async dir=>JSON.parse(await fs.readFile(path.join(dir,'evidence.json'),'utf8'))));
  assert.equal(new Set(evidence.map(e=>e.session_id)).size,3);
  assert.deepEqual(evidence.map(e=>e.verification.passed),[false,false,true]);
  assert.equal(p.git('worktree','list','--porcelain').split('worktree ').length-1,2);
  assert.equal(await fs.readFile(path.join(job.workspace.path,'feature.txt'),'utf8'),'good');assert.equal(p.git('status','--porcelain'),'');
});
test('wait publishes a Worker terminal event only after the entire upgrade chain is persisted',async t=>{
  const p=await setup(t),execute=p.orch.executeCodexWorkerImpl.bind(p.orch);
  p.orch.executeCodexWorkerImpl=async(...args)=>{await execute(...args);await new Promise(resolve=>setTimeout(resolve,350));};
  const started=await p.orch.startStageWork({project_dir:p.root,task_id:'task',subtask_id:'impl'},p.stages.work.routes.low);
  const update=await p.orch.notifications().wait({project_dir:p.root,job_id:started.id,consumer_id:'terminal-worker',until:'terminal',timeout_ms:20000});
  const snapshot=await p.store.getJob(started.id);await p.orch.wait(started.id);
  assert.equal(update.events.find(e=>e.type==='terminal')?.status,'completed');
  assert.equal(snapshot.route_attempts.length,3);assert.equal(snapshot.route_attempts.at(-1).status,'completed');
  assert.equal(snapshot.evidence_path,path.join(p.store.jobDir(started.id),'evidence.json'));
});
for (const mode of ['timeout','pre-session-timeout']) test(`a ${mode} worker exits before upgrading and retains partial work`,async t=>{
  const p=await setup(t,{workerMode:mode}),job=await p.work();assert.equal(job.status,'completed',job.error);
  assert.match(job.route_attempts[0].error,/timed out/);assert.equal(job.route_attempts.length,3);
});
test('high is a hard ceiling for automatic verification escalation',async t=>{
  const p=await setup(t,{workerMode:'exhaust'}),job=await p.work();assert.equal(job.status,'failed');
  assert.equal(job.effective_complexity,'high');assert.equal(job.route_attempts.length,3);
  assert.equal(await fs.readFile(path.join(job.workspace.path,'feature.txt'),'utf8'),'partial-mid');
});
for (const mode of ['auth','forbidden']) test(`worker ${mode} failure never upgrades`,async t=>{
  const p=await setup(t,{workerMode:mode}),job=await p.work();assert.equal(job.status,'failed');assert.equal(job.route_attempts.length,1);
});
test('review quota fallback retains each attempt and binds the final actual model to the original patch',async t=>{
  const p=await setup(t),work=await p.work();assert.equal(work.status,'completed',work.error);
  const started=await p.orch.startVerify({project_dir:p.root,task_id:'task',review_id:'review'});await p.orch.wait(started.id);
  const review=await p.store.getJob(started.id);assert.equal(review.status,'completed',review.error);assert.equal(review.model,'review-low');
  assert.equal(review.review_route_attempts.length,3);assert.deepEqual(review.review_route_attempts.map(a=>a.status),['failed','failed','completed']);
  const result=await p.orch.result(review.id);assert.equal(result.evidence.review_evidence.implementation_job_id,work.id);assert.equal(result.evidence.review_evidence.actual_model,'review-low');
  assert.equal(result.evidence.result_source,'stdout');
});
test('wait publishes review completion only after the quota-chain evidence and attempt list are persisted',async t=>{
  const p=await setup(t),work=await p.work();assert.equal(work.status,'completed',work.error);
  const execute=p.orch.executeAgy.bind(p.orch);
  p.orch.executeAgy=async(...args)=>{await execute(...args);await new Promise(resolve=>setTimeout(resolve,350));};
  const started=await p.orch.startVerify({project_dir:p.root,task_id:'task',review_id:'review'});
  const update=await p.orch.notifications().wait({project_dir:p.root,job_id:started.id,consumer_id:'terminal-review',until:'terminal',timeout_ms:20000});
  const snapshot=await p.store.getJob(started.id);await p.orch.wait(started.id);
  assert.equal(update.events.find(e=>e.type==='terminal')?.status,'completed');
  assert.equal(snapshot.review_route_attempts.length,3);assert.equal(snapshot.model,'review-low');
  assert.equal(snapshot.evidence_path,path.join(p.store.jobDir(started.id),'evidence.json'));
});
test('two negative review rounds upgrade a new attempt while exact continuation refuses model switching',async t=>{
  const p=await setup(t,{workerMode:'pass-low',reviewerMode:'reject'});
  let work=await p.work();assert.equal(work.status,'completed',work.error);const workspace=work.workspace.path;
  for (let round=0;round<2;round++) {
    const review=await p.orch.startVerify({project_dir:p.root,task_id:'task',review_id:'review'});await p.orch.wait(review.id);
    assert.match((await p.store.getJob(review.id)).error,/AGY_REVIEW_REJECTED: FAIL/);
    if (round===0) {work=await p.work();assert.equal(work.effective_complexity,'low');}
  }
  await assert.rejects(p.orch.startStageWork({project_dir:p.root,task_id:'task',job_id:work.id,feedback:'Repair'},[],{continuation:true}),/escalation_required/);
  const upgraded=await p.work();assert.equal(upgraded.status,'completed',upgraded.error);
  assert.equal(upgraded.escalated_from_job_id,work.id);assert.equal(upgraded.route_chain[0].effective_complexity,'medium');
  assert.equal(upgraded.workspace.path,workspace);assert.equal(upgraded.contract_digest,work.contract_digest);
  assert.equal(p.git('worktree','list','--porcelain').split('worktree ').length-1,2);
});
test('a contract can disable Worker escalation and reviewer quota fallback',async t=>{
  const p=await setup(t,{workerMode:'pass-low'});
  p.contract.executor_subtasks[0].fallback_policy.enabled=false;p.contract.reviewer_tasks[0].fallback_policy.enabled=false;
  await persistPlannerContract(p.root,'task',p.contract,'session');
  const work=await p.work();assert.equal(work.status,'completed',work.error);assert.equal(work.adaptive_escalation,false);assert.equal(work.route_chain.length,1);
  const started=await p.orch.startVerify({project_dir:p.root,task_id:'task',review_id:'review'});await p.orch.wait(started.id);
  const review=await p.store.getJob(started.id);assert.equal(review.status,'failed');assert.equal(review.review_route_attempts.length,1);assert.equal(review.model,'review-high');
});
test('medium to high review escalation starts a fresh thread even when the model id stays the same',async t=>{
  const p=await setup(t,{workerMode:'pass-mid',reviewerMode:'reject',baseComplexity:'mid'});
  let work=await p.work();assert.equal(work.status,'completed',work.error);assert.equal(work.effective_complexity,'medium');
  for (let round=0;round<2;round++) {
    const review=await p.orch.startVerify({project_dir:p.root,task_id:'task',review_id:'review'});await p.orch.wait(review.id);
    if (round===0) {work=await p.work();assert.equal(work.status,'completed',work.error);}
  }
  const upgraded=await p.work();assert.equal(upgraded.status,'completed',upgraded.error);
  assert.equal(upgraded.effective_complexity,'high');assert.equal(upgraded.route_chain.length,1);
  assert.equal(upgraded.model,work.model);assert.equal(upgraded.reasoning_effort,'high');
  assert.equal(upgraded.workspace.path,work.workspace.path);assert.equal(upgraded.escalated_from_job_id,work.id);
});
test('reviewers reporting quota with exit zero still fall back, without treating missing output as PASS',async t=>{
  const p=await setup(t,{reviewerMode:'quota-zero'}),work=await p.work();assert.equal(work.status,'completed',work.error);
  const started=await p.orch.startVerify({project_dir:p.root,task_id:'task',review_id:'review'});await p.orch.wait(started.id);
  const review=await p.store.getJob(started.id);assert.equal(review.status,'completed',review.error);
  assert.equal(review.model,'review-low');assert.equal(review.review_route_attempts.length,3);
});
for (const mode of ['reject','auth','mutate']) test(`review ${mode} failure never downgrades`,async t=>{
  const p=await setup(t,{reviewerMode:mode}),work=await p.work();assert.equal(work.status,'completed',work.error);
  const started=await p.orch.startVerify({project_dir:p.root,task_id:'task',review_id:'review'});await p.orch.wait(started.id);
  const review=await p.store.getJob(started.id);assert.equal(review.status,'failed');assert.equal(review.review_route_attempts.length,1);
  if (mode==='mutate') assert.match(review.error,/MUTATED_TARGET/);
});
for (const mode of ['quota','quota-zero']) test(`environment reviews share ${mode} fallback while remaining advisory and read-only`,async t=>{
  const p=await setup(t,{reviewerMode:mode});const before=p.git('status','--porcelain');
  const audit=await p.orch.gitLifecycle.audit(p.root);
  const started=await p.orch.gitLifecycle.review(p.root,{audit_id:audit.audit_id,complexity:'high'});await p.orch.wait(started.id);
  const review=await p.store.getJob(started.id);assert.equal(review.status,'completed',review.error);assert.equal(review.model,'review-low');
  assert.equal(review.review_route_attempts.length,3);const result=await p.orch.result(review.id);
  assert.deepEqual(review.review_route_attempts.map(a=>a.status),['failed','failed','completed']);
  assert.equal(result.evidence.advisory_only,true);assert.equal(result.evidence.code_acceptance,false);assert.equal(p.git('status','--porcelain'),before);
});
