import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from '../scripts/lib/lifecycle-git.mjs';
import { StateStore } from '../scripts/lib/state.mjs';
import { recordGitOperation } from '../scripts/lib/git-events.mjs';

async function fixture(t) {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(),'orch-git-events-'));
  t.after(async () => {
    assert.equal(await fs.realpath(path.dirname(projectDir)),await fs.realpath(os.tmpdir()));
    assert(path.basename(projectDir).startsWith('orch-git-events-'));
    await fs.rm(projectDir,{recursive:true,force:true,maxRetries:5});
  });
  await git(projectDir,['init']);
  const store=new StateStore(path.join(projectDir,'.agent-orchestrator','state'),{jobsRoot:path.join(projectDir,'.agent-orchestrator','runs')});
  const job=await store.createJob({id:'work-example',task_id:'task',project_dir:projectDir,status:'completed'});
  return {projectDir,store,job,jobDir:store.jobDir(job.id),kind:'patch.applied',before_head:'a'.repeat(40),after_head:'b'.repeat(40)};
}

test('successful operations replay once with immutable timestamps and repository identity',async t=>{
  const input=await fixture(t),first=await recordGitOperation(input);
  const replay=await recordGitOperation({...input,occurred_at:'2099-01-01T00:00:00Z'});
  assert.deepEqual(replay,first);
  assert(first.repository_common_dir);assert.equal(first.job_id,input.job.id);
  assert.equal((await input.store.readEvents({limit:0})).filter(e=>e.git_operation).length,1);
});

test('a receipt survives event-projection failure and retry repairs the log without a second operation',async t=>{
  const input=await fixture(t),real=input.store.recordEvent.bind(input.store);
  input.store.recordEvent=async()=>{throw new Error('simulated projection interruption');};
  await assert.rejects(recordGitOperation(input),/projection interruption/);
  const [file]=await fs.readdir(path.join(input.jobDir,'git-operations'));
  const durable=JSON.parse(await fs.readFile(path.join(input.jobDir,'git-operations',file),'utf8'));
  input.store.recordEvent=real;
  const recovered=await recordGitOperation(input);assert.deepEqual(recovered,durable);
  assert.equal((await input.store.readEvents({limit:0})).filter(e=>e.git_operation).length,1);
});

test('unknown recovery times stay unknown and failed attempts coexist with successful closeout',async t=>{
  const input=await fixture(t);
  const unknown=await recordGitOperation({...input,kind:'workspace.created',recovered:true});
  assert.equal(unknown.occurred_at,null);assert(unknown.recorded_at);
  await recordGitOperation({...input,kind:'workspace.cleanup_blocked',key:'attempt-1',status:'failed',error:'active reviewer'});
  await recordGitOperation({...input,kind:'workspace.cleaned'});
  const operations=(await input.store.readEvents({limit:0})).filter(e=>e.git_operation).map(e=>e.git_operation);
  assert.equal(operations.length,3);assert.equal(operations[1].status,'failed');assert.equal(operations[2].status,'completed');
});
