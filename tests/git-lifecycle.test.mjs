import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, inventory, json } from '../scripts/lib/lifecycle-git.mjs';
import { WorkerOrchestrator } from '../scripts/lib/orchestrator.mjs';
import { StateStore } from '../scripts/lib/state.mjs';
import { createAutoPlannerContract, acceptReadyJob } from './fixtures/architecture.mjs';
import { fileURLToPath } from 'node:url';
import { reserveWorkspace } from '../scripts/lib/workspace-pool.mjs';
import { startIntegration } from '../scripts/lib/integration.mjs';
import { captureChanges } from '../scripts/lib/workspace.mjs';
import { createCompletedReviewerEvidence } from './fixtures/architecture.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-cc.mjs', import.meta.url));
async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-orch-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, '.agent-orchestrator'), { recursive: true });
  await fs.writeFile(path.join(source, '.gitignore'), '.agent-orchestrator/\n*.cache\n');
  await fs.writeFile(path.join(source, 'README.md'), 'original\n');
  await fs.writeFile(path.join(source, 'other.txt'), 'original\n');
  await fs.writeFile(path.join(source, 'verify.cjs'), "const fs=require('fs');if(fs.readFileSync('feature.txt','utf8')!=='good')process.exit(1);\n");
  await fs.writeFile(path.join(source, '.agent-orchestrator', 'config.json'), JSON.stringify({
    version: 2, trusted: true, mcp: { enabled: true }, host: { provider: 'codex' },
    cli: { claude: process.execPath, claude_prefix_args: [fixture] },
    execution: { cc_timeout_seconds: 20, max_cc_repair_rounds: 2 },
    review_gate: { require_agy_verify_for_implementation: false },
  }));
  await git(source, ['init']);
  await git(source, ['config', 'user.name', 'Lifecycle Tests']);
  await git(source, ['config', 'user.email', 'lifecycle@example.test']);
  await git(source, ['config', 'core.autocrlf', 'false']);
  await git(source, ['add', '.']); await git(source, ['commit', '-m', 'initial']);
  const store = new StateStore(path.join(source, '.agent-orchestrator', 'state'), { jobsRoot: path.join(source, '.agent-orchestrator', 'runs') });
  await store.init();
  const orch = new WorkerOrchestrator(store);
  return { root, source, store, orch, lifecycle: orch.gitLifecycle };
}
async function work(p, task = 'feature') {
  await createAutoPlannerContract(p.source, task);
  const started = await p.orch.startCc({ project_dir: p.source, task_id: task, goal: 'Create feature.txt containing good', complexity: 'low', acceptance_commands: ['node verify.cjs'] });
  await p.orch.wait(started.id);
  const job = await p.store.getJob(started.id);
  assert.equal(job.status, 'completed', job.error);
  await acceptReadyJob(p.orch, { projectDir: p.source, taskId: task, jobId: job.id });
  return p.store.getJob(job.id);
}

test('exact local commit preserves unrelated staged and unstaged changes', async t => {
  const p = await project(t);
  await fs.writeFile(path.join(p.source, 'README.md'), 'staged\n'); await git(p.source, ['add', 'README.md']);
  await fs.writeFile(path.join(p.source, 'README.md'), 'unstaged\n');
  await fs.writeFile(path.join(p.source, 'new file.txt'), 'task\n');
  const staged = await git(p.source, ['show', ':README.md']);
  const receipt = await p.lifecycle.commitExact(p.source, ['new file.txt'], 'feat: task only', path.join(p.root, 'commit'));
  assert.match(receipt.commit, /^[a-f0-9]{40}$/);
  assert.equal(await git(p.source, ['show', ':README.md']), staged);
  assert.equal(await fs.readFile(path.join(p.source, 'README.md'), 'utf8'), 'unstaged\n');
  assert.equal(await git(p.source, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), 'new file.txt');
});

test('environment audit preserves index and never invents ownership; stale plan refuses execution', async t => {
  const p = await project(t);
  await fs.writeFile(path.join(p.source, 'README.md'), 'legacy\n');
  const before = await inventory(p.source);
  const audit = await p.lifecycle.audit(p.source, { detail: 'full', context: { goal: 'inspect only' } });
  assert.equal((await inventory(p.source)).fingerprint, before.fingerprint);
  assert.equal(audit.modifications[0].task_relation, 'unknown');
  const plan = await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, actions: [{ kind: 'preserve', paths: ['README.md'], reason: 'unknown historical edit' }], baseline: 'head' });
  await fs.writeFile(path.join(p.source, 'README.md'), 'changed again\n');
  await assert.rejects(p.lifecycle.reconcile(p.source, { mode: 'execute', audit_id: audit.audit_id, plan_id: plan.plan_id, confirm: true }), /stale/);
});

test('accepted task finalizes through real Git commit and worktree removal, idempotently', async t => {
  const p = await project(t);
  const job = await work(p);
  await assert.rejects(p.orch.cleanup(job.id), /committed/);
  await assert.rejects(p.orch.finalize(job.id), /approval/);
  const result = await p.orch.finalize(job.id, { confirm_commit: true });
  assert.equal(result.status, 'closed');
  assert.equal(await fs.stat(job.workspace.path).catch(() => null), null);
  assert.equal(await git(p.source, ['status', '--porcelain']), '');
  assert.equal((await p.orch.finalize(job.id, { confirm_commit: true })).commit_id, result.commit_id);
  assert.equal((await p.store.getJob(job.id)).continuation_available, false);
  const operations=(await p.store.readEvents({limit:0})).filter(e=>e.git_operation).map(e=>e.git_operation);
  for (const kind of ['workspace.created','patch.applied','delivery.committed','workspace.cleaned']) assert.equal(operations.filter(e=>e.kind===kind).length,1,kind);
  assert.equal(operations.find(e=>e.kind==='delivery.committed').commit_id,result.commit_id);
  assert.equal(operations.find(e=>e.kind==='delivery.committed').recovered,false);
});

test('failed final verification preserves applied files and worktree; retry commits once', async t => {
  const p = await project(t); const job = await work(p);
  await p.orch.apply(job.id);
  await p.store.updateJob(job.id, { acceptance_commands: ['node -e "process.exit(1)"'] });
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /verification failed/);
  assert.equal((await p.store.getJob(job.id)).closeout_phase, 'applied_pending_commit');
  assert((await p.store.readEvents({limit:0})).some(e=>e.git_operation?.kind==='finalization.blocked'));
  assert.ok(await fs.stat(job.workspace.path));
  await p.store.updateJob(job.id, { acceptance_commands: ['node verify.cjs'] });
  await p.orch.finalize(job.id, { confirm_commit: true });
  assert.equal(await git(p.source, ['rev-list', '--count', 'HEAD']), '2');
});

test('cleanup refuses ignored artifacts and active references; retry keeps its commit', async t => {
  const p = await project(t); const job = await work(p);
  await fs.writeFile(path.join(job.workspace.path, 'unique.cache'), 'irreplaceable');
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /ignored artifacts/);
  const committed = (await p.store.getJob(job.id)).commit_id;
  assert.ok(committed);
  await fs.unlink(path.join(job.workspace.path, 'unique.cache'));
  await p.store.createJob({ id: 'active-review', status: 'running', type: 'environment_review', project_dir: p.source, workspace: job.workspace });
  await assert.rejects(p.orch.cleanup(job.id), /active task/);
  await p.store.updateJob('active-review', { status: 'completed' });
  const result = await p.orch.finalize(job.id, { confirm_commit: true });
  assert.equal(result.commit_id, committed);
  assert.equal(await git(p.source, ['rev-list', '--count', 'HEAD']), '2');
});

test('WIP checkpoint preserves source branch, staged content and working files', async t => {
  const p = await project(t);
  await fs.writeFile(path.join(p.source, 'README.md'), 'half done\n');
  const before = await inventory(p.source);
  const audit = await p.lifecycle.audit(p.source);
  const plan = await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, actions: [{ kind: 'wip', paths: ['README.md'], reason: 'pause unfinished work', message: 'wip: preserve', branch: 'codex/paused' }], baseline: 'block' });
  await p.lifecycle.reconcile(p.source, { mode: 'execute', audit_id: audit.audit_id, plan_id: plan.plan_id, confirm: true });
  assert.equal((await inventory(p.source)).fingerprint, before.fingerprint);
  assert.equal(await git(p.source, ['show', 'codex/paused:README.md']), 'half done');
});

test('exact commit handles deletions without swallowing unrelated staged changes', async t => {
  const p = await project(t);
  await fs.unlink(path.join(p.source, 'other.txt'));
  await p.lifecycle.commitExact(p.source, ['other.txt'], 'remove obsolete file', path.join(p.root, 'delete'));
  assert.equal(await git(p.source, ['status', '--porcelain']), '');
  assert.equal(await git(p.source, ['diff-tree', '--no-commit-id', '--name-status', '-r', 'HEAD']), 'D\tother.txt');
});

test('finalization refuses post-application task edits and preserves the worktree', async t => {
  const p = await project(t), job = await work(p);
  await p.orch.apply(job.id);
  await fs.writeFile(path.join(p.source, 'feature.txt'), 'another session');
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /APPLIED_CONTENT_CHANGED/);
  assert.ok(await fs.stat(job.workspace.path));
  assert.equal(await git(p.source, ['rev-list', '--count', 'HEAD']), '1');
});

test('dirty source requires reviewed disposition and preserves unrelated staged work', async t => {
  const p = await project(t);
  await fs.writeFile(path.join(p.source, 'README.md'), 'legacy staged\n'); await git(p.source, ['add', 'README.md']);
  const audit = await p.lifecycle.audit(p.source);
  const plan = await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, actions: [{ kind: 'preserve', paths: ['README.md'], reason: 'outside feature task' }], baseline: 'head' });
  await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, plan_id: plan.plan_id, mode: 'execute', confirm: true });
  const job = await work(p);
  await p.orch.finalize(job.id, { confirm_commit: true });
  assert.equal(await git(p.source, ['show', ':README.md']), 'legacy staged');
  assert.equal(await git(p.source, ['show', 'HEAD:README.md']), 'original');
});

test('workspace capacity waits without creating a clone, then cancellation frees the waiter', async t => {
  const p = await project(t);
  const config = { execution: { workspace_wait_timeout_seconds: 2 }, git_lifecycle: { max_worker_worktrees: 1, max_worktrees: 2 } };
  const first = await reserveWorkspace({ projectDir: p.source, jobDir: p.store.jobDir('first'), config });
  const controller = new AbortController();
  const waiting = reserveWorkspace({ projectDir: p.source, jobDir: p.store.jobDir('second'), config, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 1200)); controller.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal((await p.lifecycle.worktrees(p.source)).length, 2);
  assert.ok(await fs.stat(first.path));
  assert.equal(await fs.stat(path.join(p.store.jobDir('second'), 'worktree')).catch(() => null), null);
});

async function acceptedParallelInput(p, id, file, content) {
  await createAutoPlannerContract(p.source, id, { writablePaths: [file], requiredTests: ['node -e "process.exit(0)"'] });
  const workspace = await reserveWorkspace({ projectDir: p.source, jobDir: p.store.jobDir(id), config: { execution: {}, git_lifecycle: {} } });
  await fs.writeFile(path.join(workspace.path, file), content);
  const changes = await captureChanges({ workspace: workspace.path, jobDir: p.store.jobDir(id), writable: [file] });
  const evidencePath = path.join(p.store.jobDir(id), 'evidence.json');
  await fs.writeFile(evidencePath, JSON.stringify({ changes, workspace, verification: { configured: true, passed: true } }));
  await p.store.createJob({ id, type: 'stage_work', provider: 'cc', task_id: id, subtask_id: 'impl-1', project_dir: p.source, status: 'completed', phase: 'ready_for_acceptance',
    workspace, evidence_path: evidencePath, patch_path: changes.patch_path, session_id: `${id}-session`, acceptance_commands: [], requires_agy_review: false });
  await acceptReadyJob(p.orch, { projectDir: p.source, taskId: id, jobId: id });
  return p.store.getJob(id);
}

test('parallel results integrate, require fresh acceptance and close all worktrees after one delivery commit', async t => {
  const p = await project(t);
  const [a, b] = await Promise.all([acceptedParallelInput(p, 'input-a', 'a.txt', 'A\n'), acceptedParallelInput(p, 'input-b', 'b.txt', 'B\n')]);
  await createAutoPlannerContract(p.source, 'combined', { writablePaths: ['a.txt', 'b.txt'], requiredTests: ['node -e "const f=require(\'fs\');if(f.readFileSync(\'a.txt\',\'utf8\')!==\'A\\n\'||f.readFileSync(\'b.txt\',\'utf8\')!==\'B\\n\')process.exit(1)"'] });
  const started = await startIntegration(p.orch, { project_dir: p.source, task_id: 'combined', subtask_id: 'impl-1', job_ids: [a.id, b.id] });
  await p.orch.wait(started.id);
  const integrated = await p.store.getJob(started.id);
  assert.equal(integrated.status, 'completed', integrated.error);
  await assert.rejects(p.orch.finalize(started.id, { confirm_commit: true }), /acceptance/);
  // This fixture tests the gate; real-provider E2E separately supplies AGY evidence.
  await createCompletedReviewerEvidence(p.store, { projectDir: p.source, taskId: 'combined', implementationJob: integrated });
  await acceptReadyJob(p.orch, { projectDir: p.source, taskId: 'combined', jobId: started.id });
  const result = await p.orch.finalize(started.id, { confirm_commit: true });
  assert.equal(result.status, 'closed');
  assert.equal(await git(p.source, ['status', '--porcelain']), '');
  assert.equal(await git(p.source, ['rev-list', '--count', 'HEAD']), '2');
  assert.equal((await p.lifecycle.worktrees(p.source)).length, 1);
});

test('commit receipt recovers a crash after Git commit without committing twice', async t => {
  const p = await project(t), job = await work(p);
  const update = p.store.updateJob.bind(p.store); let injected = false;
  p.store.updateJob = async (id, patch) => {
    if (!injected && patch.commit_id) { injected = true; throw new Error('simulated receipt crash'); }
    return update(id, patch);
  };
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /receipt crash/);
  p.store.updateJob = update;
  const result = await p.orch.finalize(job.id, { confirm_commit: true });
  assert.equal(result.status, 'closed');
  assert.equal(await git(p.source, ['rev-list', '--count', 'HEAD']), '2');
  const committed=(await p.store.readEvents({limit:0})).find(e=>e.git_operation?.kind==='delivery.committed').git_operation;
  assert.equal(committed.recovered,true);assert.equal(committed.occurred_at,null);
});

test('cleanup intent recovers interruption after worktree removal', async t => {
  const p = await project(t), job = await work(p);
  const update = p.store.updateJob.bind(p.store); let injected = false;
  p.store.updateJob = async (id, patch) => {
    if (!injected && patch.cleaned_at) { injected = true; throw new Error('simulated cleanup crash'); }
    return update(id, patch);
  };
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /cleanup crash/);
  p.store.updateJob = update;
  assert.equal((await p.orch.finalize(job.id, { confirm_commit: true })).status, 'closed');
  assert.equal((await p.lifecycle.worktrees(p.source)).length, 1);
});

test('manual policy records an existing verified commit without creating another', async t => {
  const p = await project(t), job = await work(p);
  await p.orch.apply(job.id);
  await git(p.source, ['add', 'feature.txt']); await git(p.source, ['commit', '-m', 'manual delivery']);
  const commit = await git(p.source, ['rev-parse', 'HEAD']);
  const configPath = path.join(p.source, '.agent-orchestrator', 'config.json');
  const config = await json(configPath); config.git_lifecycle = { commit_policy: 'manual' }; await fs.writeFile(configPath, JSON.stringify(config));
  assert.equal((await p.orch.finalize(job.id, { record_commit: commit })).commit_id, commit);
  assert.equal(await git(p.source, ['rev-list', '--count', 'HEAD']), '2');
});

test('commit hook failure preserves work and retries only after the hook is fixed', async t => {
  const p = await project(t), job = await work(p);
  const hook = path.join(p.source, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /Git commit failed/);
  assert.ok(await fs.stat(job.workspace.path));
  await fs.unlink(hook);
  assert.equal((await p.orch.finalize(job.id, { confirm_commit: true })).status, 'closed');
  assert.equal(await git(p.source, ['rev-list', '--count', 'HEAD']), '2');
});

test('a hook that injects extra files blocks cleanup and cannot be silently retried as accepted', async t => {
  const p = await project(t), job = await work(p);
  const hook = path.join(p.source, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hook, '#!/bin/sh\nprintf unexpected > surprise.txt\ngit add surprise.txt\n', { mode: 0o755 });
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /COMMIT_TREE_CHANGED/);
  await fs.unlink(hook);
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /COMMIT_TREE_CHANGED/);
  assert.ok(await fs.stat(job.workspace.path));
});

test('a merge conflict preserves all original workspaces and resumes after an explicit staged resolution', async t => {
  const p = await project(t);
  const [a, b] = await Promise.all([acceptedParallelInput(p, 'conflict-a', 'README.md', 'version A\n'), acceptedParallelInput(p, 'conflict-b', 'README.md', 'version B\n')]);
  await createAutoPlannerContract(p.source, 'resolve-combined', { writablePaths: ['README.md'], requiredTests: ['node -e "if(require(\'fs\').readFileSync(\'README.md\',\'utf8\')!==\'resolved\\n\')process.exit(1)"'] });
  const started = await startIntegration(p.orch, { project_dir: p.source, task_id: 'resolve-combined', subtask_id: 'impl-1', job_ids: [a.id, b.id] });
  await p.orch.wait(started.id);
  const conflicted = await p.store.getJob(started.id);
  assert.equal(conflicted.status, 'failed'); assert.match(conflicted.error, /INTEGRATION_CONFLICT/);
  assert.ok(await git(conflicted.workspace.path, ['ls-files', '--unmerged']));
  assert.equal(await fs.readFile(path.join(p.source, 'README.md'), 'utf8'), 'original\n');
  await fs.writeFile(path.join(conflicted.workspace.path, 'README.md'), 'resolved\n');
  await git(conflicted.workspace.path, ['add', 'README.md']);
  const resumed = await startIntegration(p.orch, { project_dir: p.source, job_id: started.id });
  assert.equal(resumed.id, started.id); await p.orch.wait(resumed.id);
  const done = await p.store.getJob(resumed.id); assert.equal(done.status, 'completed', done.error);
  await createCompletedReviewerEvidence(p.store, { projectDir: p.source, taskId: 'resolve-combined', implementationJob: done });
  await acceptReadyJob(p.orch, { projectDir: p.source, taskId: 'resolve-combined', jobId: done.id });
  await p.orch.finalize(done.id, { confirm_commit: true });
  assert.equal(await fs.readFile(path.join(p.source, 'README.md'), 'utf8'), 'resolved\n');
  assert.equal((await p.lifecycle.worktrees(p.source)).length, 1);
});

test('approved retirement preserves an unfinished task in reachable Git objects and releases its slot', async t => {
  const p = await project(t), job = await work(p);
  await p.store.updateJob(job.id, { status: 'failed', phase: 'failed', acceptance_status: null });
  const audit = await p.lifecycle.audit(p.source);
  const plan = await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, actions: [{ kind: 'cleanup', job_id: job.id, disposition: 'wip', reason: 'Save incomplete work before retiring the slot' }] });
  const retired = await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, plan_id: plan.plan_id, mode: 'execute', confirm: true });
  assert.equal(retired.receipts[0].status, 'wip_preserved');
  assert.equal(await git(p.source, ['show', `${retired.receipts[0].reference}:feature.txt`]), 'good');
  assert.equal((await p.lifecycle.worktrees(p.source)).length, 1);
  assert.equal((await p.store.getJob(job.id)).continuation_available, false);
});

test('unborn repositories can audit and create only an approved initial file set', async t => {
  const p = await project(t);
  const empty = path.join(p.root, 'new-project'); await fs.mkdir(empty);
  await git(empty, ['init']); await git(empty, ['config', 'user.name', 'New Project']); await git(empty, ['config', 'user.email', 'new@example.test']);
  await fs.writeFile(path.join(empty, 'initial.txt'), 'initial');
  const receipt = await p.lifecycle.commitExact(empty, ['initial.txt'], 'initial baseline', path.join(p.root, 'initial-commit'));
  assert.ok(receipt.commit); assert.equal(await git(empty, ['rev-list', '--count', 'HEAD']), '1');
  assert.equal((await inventory(empty)).changes.length, 0);
});

test('snapshot opt-in cannot silently authorize committing inherited edits in a task file', async t => {
  const p = await project(t);
  const configPath = path.join(p.source, '.agent-orchestrator', 'config.json');
  const config = await json(configPath); config.git_lifecycle = { allow_snapshot: true }; await fs.writeFile(configPath, JSON.stringify(config));
  await fs.writeFile(path.join(p.source, 'feature.txt'), 'historical unfinished content');
  const before = await inventory(p.source);
  const audit = await p.lifecycle.audit(p.source);
  const plan = await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, baseline: 'snapshot', actions: [{ kind: 'preserve', paths: ['feature.txt'], reason: 'Keep the inherited implementation as a task baseline, not permission to commit it' }] });
  await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, plan_id: plan.plan_id, mode: 'execute', confirm: true });
  const job = await work(p);
  assert.notEqual(job.workspace.base_commit, before.head);
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /PREEXISTING_CONTENT_NEEDS_DECISION/);
  assert.equal((await inventory(p.source)).fingerprint, before.fingerprint);
  assert.ok(await fs.stat(job.workspace.path));
});

test('unchanged approved historical residuals survive task commits without another reconciliation', async t => {
  const p = await project(t);
  await fs.writeFile(path.join(p.source, 'README.md'), 'approved legacy content\n'); await git(p.source, ['add', 'README.md']);
  const audit = await p.lifecycle.audit(p.source);
  const plan = await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, baseline: 'head', actions: [{ kind: 'preserve', paths: ['README.md'], reason: 'Preserve unrelated historical work across milestones' }] });
  await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, plan_id: plan.plan_id, mode: 'execute', confirm: true });
  const job = await work(p); await p.orch.finalize(job.id, { confirm_commit: true });
  const next = await reserveWorkspace({ projectDir: p.source, jobDir: p.store.jobDir('next-milestone'), config: { execution: {}, git_lifecycle: {} } });
  assert.equal(await fs.readFile(path.join(next.path, 'README.md'), 'utf8'), 'original\n');
  assert.equal(await git(p.source, ['show', ':README.md']), 'approved legacy content');
});

test('retired process ids cannot block cleanup after the worker exit was recorded', async t => {
  const p = await project(t), job = await work(p);
  await p.store.updateJob(job.id, { process_pid: process.pid, process_exited_at: new Date().toISOString() });
  assert.equal((await p.orch.finalize(job.id, { confirm_commit: true })).status, 'closed');
});

test('an accepted worktree mutation is rejected before application or commit', async t => {
  const p = await project(t), job = await work(p);
  await fs.writeFile(path.join(job.workspace.path, 'feature.txt'), 'unreviewed');
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /ACCEPTED_WORKTREE_CHANGED/);
  assert.equal(await fs.stat(path.join(p.source, 'feature.txt')).catch(() => null), null);
});

test('workspace byte admission refuses allocation without deleting or cloning anything', async t => {
  const p = await project(t);
  await assert.rejects(reserveWorkspace({ projectDir: p.source, jobDir: p.store.jobDir('over-budget'), config: { execution: { workspace_wait_timeout_seconds: 0 }, git_lifecycle: { max_workspace_bytes: 1 } } }), /WORKSPACE_CAPACITY_REQUIRED/);
  assert.equal((await p.lifecycle.worktrees(p.source)).length, 1);
});

test('reconciliation never approves omitted changes and can preserve sensitive paths without staging them', async t => {
  const p = await project(t);
  await fs.writeFile(path.join(p.source, 'README.md'), 'legacy');
  await fs.writeFile(path.join(p.source, '.env'), 'FIXTURE_ONLY=not-a-secret\n');
  const audit = await p.lifecycle.audit(p.source);
  await assert.rejects(p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, baseline: 'head', actions: [{ kind: 'preserve', paths: ['README.md'], reason: 'Only one path was reviewed' }] }), /Every inherited modification/);
  const plan = await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, baseline: 'head', actions: [{ kind: 'preserve', paths: ['README.md', '.env'], reason: 'Keep all inherited contents; do not add credentials to Git' }] });
  await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, plan_id: plan.plan_id, mode: 'execute', confirm: true });
  assert.equal(await git(p.source, ['diff', '--cached', '--name-only']), '');
  await assert.rejects(p.lifecycle.commitExact(p.source, ['.env'], 'must not commit', path.join(p.root, 'blocked-sensitive')), /Unsafe/);
});

test('application intent recovers interruption after patch application without applying twice', async t => {
  const p = await project(t), job = await work(p);
  const update = p.store.updateJob.bind(p.store); let injected = false;
  p.store.updateJob = async (id, patch) => {
    if (!injected && patch.applied_at) { injected = true; throw new Error('simulated application receipt crash'); }
    return update(id, patch);
  };
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /application receipt crash/);
  p.store.updateJob = update;
  assert.equal((await p.orch.finalize(job.id, { confirm_commit: true })).status, 'closed');
  assert.equal((await p.store.getJob(job.id)).application_recovered, true);
  assert.equal(await git(p.source, ['rev-list', '--count', 'HEAD']), '2');
});

test('explicit in-place policy commits and retires the task without removing the source directory', async t => {
  const p = await project(t);
  const configPath = path.join(p.source, '.agent-orchestrator', 'config.json');
  const config = await json(configPath); config.execution.workspace_mode = 'in_place'; config.git_lifecycle = { allow_in_place: true }; await fs.writeFile(configPath, JSON.stringify(config));
  const job = await work(p);
  assert.equal(job.workspace.mode, 'in_place');
  assert.equal((await p.orch.finalize(job.id, { confirm_commit: true })).status, 'closed');
  assert.ok(await fs.stat(p.source));
  assert.equal((await p.store.getJob(job.id)).continuation_available, false);
  assert.equal((await p.lifecycle.worktrees(p.source)).length, 1);
});

test('switching the source branch during a task blocks automatic delivery', async t => {
  const p = await project(t), job = await work(p);
  await git(p.source, ['switch', '-c', 'other-target']);
  await assert.rejects(p.orch.finalize(job.id, { confirm_commit: true }), /SOURCE_BRANCH_CHANGED/);
  assert.equal(await git(p.source, ['rev-list', '--count', 'HEAD']), '1');
  assert.ok(await fs.stat(job.workspace.path));
});

test('known independent clones are inventoried with unique ignored data but never automatically deleted', async t => {
  const p = await project(t), clone = path.join(p.root, 'old-clone');
  await git(p.root, ['clone', '--no-local', p.source, clone]);
  await fs.writeFile(path.join(clone, 'unique.cache'), 'unique retained output');
  const audit = await p.lifecycle.audit(p.source, { clone_paths: [clone], detail: 'full', measure: true });
  assert.equal(audit.clones[0].shared_repository, false);
  assert.equal(audit.clones[0].disposition, 'manual_only');
  assert.ok(audit.clones[0].ignored_paths.includes('unique.cache'));
  assert.ok(audit.clones[0].disk_bytes > 0);
  await assert.rejects(p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, actions: [{ kind: 'delete_clone', path: clone }] }), /never deleted/);
  assert.equal((await p.lifecycle.audit(p.source)).clones, 1);
  assert.equal(await fs.readFile(path.join(clone, 'unique.cache'), 'utf8'), 'unique retained output');
});
