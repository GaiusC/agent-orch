#!/usr/bin/env node
// Resume a retained, failed synthetic real-CLI integration. No new worker session.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { git, json, save, canonicalPath } from './lib/lifecycle-git.mjs';
import { StateStore } from './lib/state.mjs';
import { WorkerOrchestrator } from './lib/orchestrator.mjs';
import { startIntegration } from './lib/integration.mjs';

const previousPath = path.resolve(process.argv[2]);
const previous = await json(previousPath);
const rootKey = await canonicalPath(previous.root), tempKey = await canonicalPath(os.tmpdir());
if (!rootKey.startsWith(tempKey + path.sep) || !path.basename(previous.root).startsWith('agent-orch-git-real-')) throw new Error('Recovery script accepts only the synthetic temporary fixture');
const project = previous.project_dir;
const store = new StateStore(path.join(project, '.agent-orchestrator', 'state'), { jobsRoot: path.join(project, '.agent-orchestrator', 'runs'), orchestratorRoot: path.join(project, '.agent-orchestrator') });
await store.init(); const orch = new WorkerOrchestrator(store);
const integration = (await store.listJobs()).find(job => job.integration_job_ids && job.status === 'failed');
assert.ok(integration, 'A failed preserved integration is required');
const oldWorkers = integration.integration_job_ids;
const report = { previous_evidence: previousPath, project_dir: project, previous_failure: previous.error, integration_job_id: integration.id, original_worker_ids: oldWorkers, started_at: new Date().toISOString() };
async function wait(id) {
  while (true) {
    const updates = await orch.notifications().wait({ project_dir: project, job_id: id, consumer_id: 'real-git-recovery', until: 'update', timeout_ms: 30000 });
    for (const event of updates.events) console.log(JSON.stringify(event));
    const job = await store.getJob(id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) { await orch.promises.get(id); assert.equal(job.status, 'completed', job.error); return job; }
  }
}
try {
  assert.equal(await fs.readFile(path.join(project, 'README.md'), 'utf8'), 'Historical edit: preserve both index and working file\n');
  assert.equal((await fs.readFile(path.join(integration.workspace.path, 'a.txt'))).toString('hex'), '410d0a');
  await git(project, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(integration.workspace.path, 'a.txt'), 'A\n');
  await fs.writeFile(path.join(integration.workspace.path, 'b.txt'), 'B\n');
  const resumed = await startIntegration(orch, { project_dir: project, job_id: integration.id });
  assert.equal(resumed.id, integration.id); await wait(resumed.id);
  const review = await orch.startVerify({ project_dir: project, task_id: integration.task_id, review_id: 'review', model: previous.reviewer_model });
  await wait(review.id);
  await orch.accept({ project_dir: project, task_id: integration.task_id, job_id: integration.id, decision: 'accepted', accepter_model: previous.worker_model, session_id: 'real-recovery-coordinator', summary: 'Synthetic recovery: exact LF files and fresh AGY combination review verified.' });
  report.finalization = await orch.finalize(integration.id, { commit_message: 'feat: deliver reviewed parallel results after EOL repair' });
  assert.equal(report.finalization.status, 'closed');
  assert.equal((await orch.gitLifecycle.worktrees(project)).length, 1);
  assert.equal(await git(project, ['show', ':README.md']), 'Historical edit: preserve both index and working file');
  assert.equal(await git(project, ['rev-list', '--count', 'HEAD']), '2');
  report.no_new_workers = (await store.listJobs()).filter(job => job.provider === 'codex_worker').length === 2;
  report.historical_edit_preserved = true; report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; throw error; }
finally { report.finished_at = new Date().toISOString(); const output = process.env.AGENT_ORCH_E2E_SUMMARY || path.join(previous.root, 'recovery-summary.json'); await save(path.resolve(output), report); console.log(JSON.stringify(report)); }
