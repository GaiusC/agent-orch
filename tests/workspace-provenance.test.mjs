import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkerOrchestrator } from '../scripts/lib/orchestrator.mjs';

async function legacyFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-orch-legacy-owner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const jobDir = id => path.join(project, '.agent-orchestrator', 'runs', id);
  const workspace = { mode: 'isolated', path: path.join(jobDir('original'), 'worktree') };
  await fs.mkdir(workspace.path, { recursive: true });
  const jobs = new Map([
    ['original', { id: 'original', project_dir: project, task_id: 'task', subtask_id: 'impl', workspace }],
    ['continued', { id: 'continued', project_dir: project, task_id: 'task', subtask_id: 'impl', workspace, continued_from_job_id: 'original' }],
  ]);
  const orch = new WorkerOrchestrator({ jobDir, getJob: async id => jobs.get(id) || null });
  const session = { last_job_id: 'continued', workspace_path: workspace.path };
  const job = { type: 'stage_work_continue', project_dir: project, task_id: 'task' };
  return { root, project, jobs, orch, session, job, workspace };
}

test('legacy workspace owner resolves across recorded continuations without rewriting their records', async t => {
  const p = await legacyFixture(t);
  p.jobs.set('latest', { ...p.jobs.get('continued'), id: 'latest', continued_from_job_id: 'continued' });
  p.session.last_job_id = 'latest';
  const before = JSON.stringify([...p.jobs]);
  const recovered = await p.orch.sessionWorkspace(p.session, p.job);
  assert.equal(recovered.path, p.workspace.path);
  assert.equal(recovered.owner_job_id, 'original');
  assert.equal(JSON.stringify([...p.jobs]), before);
});

for (const reason of ['missing parent', 'cycle', 'foreign project', 'foreign task', 'foreign subtask', 'different workspace', 'wrong explicit owner']) {
  test(`legacy workspace recovery refuses ${reason}`, async t => {
    const p = await legacyFixture(t);
    const original = p.jobs.get('original');
    const continued = p.jobs.get('continued');
    if (reason === 'missing parent') p.jobs.delete('original');
    if (reason === 'cycle') continued.continued_from_job_id = 'continued';
    if (reason === 'foreign project') original.project_dir = p.root;
    if (reason === 'foreign task') original.task_id = 'other';
    if (reason === 'foreign subtask') original.subtask_id = 'other';
    if (reason === 'different workspace') original.workspace = { ...p.workspace, path: p.root };
    if (reason === 'wrong explicit owner') continued.workspace = { ...p.workspace, owner_job_id: 'continued' };
    await assert.rejects(p.orch.sessionWorkspace(p.session, p.job), /missing_workspace_provenance/);
    assert.equal(await p.orch.sessionWorkspace(p.session, { ...p.job, type: 'stage_work' }), null);
  });
}
