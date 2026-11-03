#!/usr/bin/env node
// Real CLI workers/reviewers in a disposable repository; never edits source Git state.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { git, inventory, save } from './lib/lifecycle-git.mjs';
import { StateStore } from './lib/state.mjs';
import { WorkerOrchestrator } from './lib/orchestrator.mjs';
import { persistPlannerContract } from './lib/contracts.mjs';
import { startIntegration } from './lib/integration.mjs';
import { captureRuntimeEnvironment } from './lib/runtime-env.mjs';

const workerModel = process.env.AGENT_ORCH_E2E_CODEX_MODEL;
const reviewerModel = process.env.AGENT_ORCH_E2E_REVIEW_MODEL;
if (!workerModel || !reviewerModel) throw new Error('Set explicit current AGENT_ORCH_E2E_CODEX_MODEL and AGENT_ORCH_E2E_REVIEW_MODEL');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-orch-git-real-'));
const project = path.join(root, 'project');
await fs.mkdir(path.join(project, '.agent-orchestrator'), { recursive: true });
const route = { provider: 'codex_worker', model: workerModel, reasoning_effort: 'high', service_tier: null, invocation: 'cli' };
const reviewRoute = { provider: 'agy', model: reviewerModel, invocation: 'cli' };
const tiers = item => ({ low: [item], medium: [item], high: [item] });
await fs.writeFile(path.join(project, '.gitignore'), '.agent-orchestrator/\n');
await fs.writeFile(path.join(project, 'README.md'), 'Real lifecycle E2E\n');
await fs.writeFile(path.join(project, 'AGENTS.md'), 'Only change the exact file named by your task. Do not commit, change Git metadata, or modify configuration. Runtime progress reporting is permitted.\n');
await fs.writeFile(path.join(project, 'verify.cjs'), "const f=require('fs');if(f.readFileSync('a.txt','utf8')!=='A\\n'||f.readFileSync('b.txt','utf8')!=='B\\n')process.exit(1);\n");
await git(project, ['init']); await git(project, ['config', 'user.name', 'Agent Orch Real E2E']); await git(project, ['config', 'user.email', 'real-e2e@example.test']);
await git(project, ['config', 'core.autocrlf', 'false']);
await git(project, ['add', '.']); await git(project, ['commit', '-m', 'fixture']);
await save(path.join(project, '.agent-orchestrator', 'config.json'), {
  version: 2, trusted: true, mcp: { enabled: true }, host: { provider: 'codex' },
  cli: { codex: process.env.AGENT_ORCH_CODEX_BIN || 'codex', agy: process.env.AGENT_ORCH_AGY_BIN || 'agy', agy_sandbox: false },
  execution: { workspace_mode: 'isolated', codex_worker_timeout_seconds: 300, agy_timeout_seconds: 300, max_cc_repair_rounds: 0 },
  git_lifecycle: { commit_policy: 'auto', max_worker_worktrees: 2, max_worktrees: 3 },
  review_gate: { require_reviewer_for_implementation: true, allow_waiver: false },
  stages: { work: { routes: tiers(route) }, review: { routes: tiers(reviewRoute) } },
});
await captureRuntimeEnvironment(project);
const store = new StateStore(path.join(project, '.agent-orchestrator', 'state'), { jobsRoot: path.join(project, '.agent-orchestrator', 'runs'), orchestratorRoot: path.join(project, '.agent-orchestrator') });
await store.init(); const orch = new WorkerOrchestrator(store);
const report = { root, project_dir: project, worker_model: workerModel, reviewer_model: reviewerModel, started_at: new Date().toISOString(), jobs: [] };
console.log(JSON.stringify({ event: 'fixture', ...report }));
async function wait(id) {
  while (true) {
    const events = await orch.notifications().wait({ project_dir: project, job_id: id, consumer_id: 'real-git-e2e', until: 'update', timeout_ms: 30000 });
    for (const event of events.events) console.log(JSON.stringify(event));
    const job = await store.getJob(id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      await orch.promises.get(id);
      report.jobs.push({ id, type: job.type, status: job.status, error: job.error || null });
      assert.equal(job.status, 'completed', job.error);
      return job;
    }
  }
}
async function contract(task, files, commands) {
  await persistPlannerContract(project, task, { contract_id: `contract-${task}`, contract_version: 1, repository_identity: await git(project, ['rev-parse', 'HEAD']),
    executor_subtasks: [{ subtask_id: 'impl', role: 'executor', complexity: 'low', objective: files.length === 1 ? `Create only ${files[0]} with exactly ${files[0] === 'a.txt' ? 'A' : 'B'} followed by a newline. Submit a short checkpoint using the runtime helper. Do not change anything else.` : 'Integrate both independent task results without changing unrelated files.', writable_paths: files, forbidden_paths: ['.git/**', '.env', '.env.*'], required_tests: commands, fallback_policy: { enabled: false } }],
    reviewer_tasks: [{ review_id: 'review', role: 'reviewer', type: 'verify', complexity: 'low', target_subtask_ids: ['impl'], required_checks: ['Inspect the current diff and independently run the executor required tests. Return VERDICT: PASS only if the exact requested files/content and scope are correct.'], fallback_policy: { enabled: false } }],
  }, `real-lifecycle-planner-${task}`);
}
async function reviewAccept(job) {
  const review = await orch.startVerify({ project_dir: project, task_id: job.task_id, review_id: 'review', model: reviewerModel }); await wait(review.id);
  await orch.accept({ project_dir: project, task_id: job.task_id, job_id: job.id, decision: 'accepted', session_id: `real-lifecycle-coordinator-${job.task_id}`, accepter_model: workerModel, summary: 'Synthetic E2E coordinator accepts exact file checks and independent AGY evidence; not a user-project acceptance.' });
}
try {
  await fs.writeFile(path.join(project, 'README.md'), 'Historical edit: preserve both index and working file\n');
  await git(project, ['add', 'README.md']);
  const historical = await inventory(project);
  const audit = await orch.gitLifecycle.audit(project, { context: { known_facts: ['README.md is an intentional preexisting staged edit; preserve it.'], unknowns: [] } });
  const environmental = await orch.gitLifecycle.review(project, { audit_id: audit.audit_id, complexity: 'low' }); await wait(environmental.id);
  const plan = await orch.gitLifecycle.reconcile(project, { audit_id: audit.audit_id, baseline: 'head', actions: [{ kind: 'preserve', paths: ['README.md'], reason: 'Deliberately preexisting fixture edit, outside worker tasks' }] });
  await orch.gitLifecycle.reconcile(project, { mode: 'execute', audit_id: audit.audit_id, plan_id: plan.plan_id, confirm: true });
  const commandsA = ["node -e \"if(require('fs').readFileSync('a.txt','utf8')!=='A\\n')process.exit(1)\""];
  const commandsB = ["node -e \"if(require('fs').readFileSync('b.txt','utf8')!=='B\\n')process.exit(1)\""];
  await contract('task-a', ['a.txt'], commandsA); await contract('task-b', ['b.txt'], commandsB);
  const a = await orch.startStageWork({ project_dir: project, task_id: 'task-a', subtask_id: 'impl' }, [route]);
  const b = await orch.startStageWork({ project_dir: project, task_id: 'task-b', subtask_id: 'impl' }, [route]);
  const [doneA, doneB] = await Promise.all([wait(a.id), wait(b.id)]);
  const overlap = Math.min(Date.parse(doneA.finished_at), Date.parse(doneB.finished_at)) - Math.max(Date.parse(doneA.started_at || doneA.created_at), Date.parse(doneB.started_at || doneB.created_at));
  assert.ok(overlap > 0, 'Workers must overlap in time'); report.worker_overlap_ms = overlap;
  await Promise.all([reviewAccept(doneA), reviewAccept(doneB)]);
  await contract('combined', ['a.txt', 'b.txt'], ['node verify.cjs']);
  const integrated = await startIntegration(orch, { project_dir: project, task_id: 'combined', subtask_id: 'impl', job_ids: [a.id, b.id] });
  const done = await wait(integrated.id); await reviewAccept(done);
  const result = await orch.finalize(done.id, { commit_message: 'feat: integrate independent A and B tasks' });
  assert.equal(result.status, 'closed');
  assert.equal(await git(project, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), 'a.txt\nb.txt');
  assert.equal(await git(project, ['show', ':README.md']), 'Historical edit: preserve both index and working file');
  assert.equal(await fs.readFile(path.join(project, 'README.md'), 'utf8'), 'Historical edit: preserve both index and working file\n');
  assert.equal((await orch.gitLifecycle.worktrees(project)).length, 1);
  report.finalization = result; report.historical_index_preserved = true; report.historical_file_preserved = true;
  report.delivery_commit_count = Number(await git(project, ['rev-list', '--count', 'HEAD'])) - 1;
  report.worktrees_remaining = 1; report.status = 'passed'; report.fixture_baseline = historical.head;
} catch (error) { report.status = 'failed'; report.error = error.stack; throw error; }
finally {
  report.finished_at = new Date().toISOString();
  await save(path.join(root, 'summary.json'), report);
  const output = process.env.AGENT_ORCH_E2E_SUMMARY;
  if (output) await save(path.resolve(output), report);
  console.log(JSON.stringify({ event: 'summary', ...report }));
}
