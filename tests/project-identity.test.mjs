import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { bindProject, discoverHostProject } from '../scripts/lib/project-identity.mjs';
import { git, inventory, json, identity, save } from '../scripts/lib/lifecycle-git.mjs';
import { reserveWorkspace, releaseWorkspace } from '../scripts/lib/workspace-pool.mjs';
import { WorkerOrchestrator } from '../scripts/lib/orchestrator.mjs';
import { StateStore } from '../scripts/lib/state.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StageRuntime } from '../scripts/lib/stage-runtime.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-orch-binding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  async function repo(name) {
    const p = path.join(root, name);
    await fs.mkdir(path.join(p, '.agent-orchestrator'), { recursive: true });
    await fs.writeFile(path.join(p, '.gitignore'), '.agent-orchestrator/\ncopies/\n');
    await fs.writeFile(path.join(p, 'README.md'), 'source\n');
    await fs.writeFile(path.join(p, '.agent-orchestrator/config.json'), JSON.stringify({ version: 2, trusted: true, mcp: { enabled: true }, host: { provider: 'codex' }, git_lifecycle: { max_worker_worktrees: 2, max_worktrees: 2 } }));
    await git(p, ['init']);
    await git(p, ['config', 'user.name', 'Binding Tests']);
    await git(p, ['config', 'user.email', 'binding@example.test']);
    await git(p, ['add', '.']);
    await git(p, ['commit', '-m', 'fixture']);
    return p;
  }
  const source = await repo('source');
  const store = new StateStore(path.join(source, '.agent-orchestrator/state'), { jobsRoot: path.join(source, '.agent-orchestrator/runs') });
  await store.init();
  const lifecycle = new WorkerOrchestrator(store).gitLifecycle;
  return { root, source, repo, lifecycle };
}

async function enroll(p, target, extra = {}) {
  const audit = await p.lifecycle.audit(p.source, { clone_paths: [target] });
  const plan = await p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, mode: 'prepare', actions: [{ kind: 'register_coordinator', path: target, reason: 'Reviewed retained short-path coordinator' }], baseline: extra.baseline || 'head' });
  return { audit, plan, execute: () => p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, plan_id: plan.plan_id, mode: 'execute', confirm: true }) };
}

test('binding migrates in a sidecar without rewriting model routes and rejects copied identities', async t => {
  const p = await fixture(t);
  const config = path.join(p.source, '.agent-orchestrator/config.json');
  const before = await fs.readFile(config);
  const binding = await bindProject(p.source, { hostProjectDir: null });
  const target = await p.repo('copy');
  await fs.copyFile(path.join(p.source, '.agent-orchestrator/project-identity.json'), path.join(target, '.agent-orchestrator/project-identity.json'));
  await assert.rejects(bindProject(target, { hostProjectDir: null }), /RELOCATION_REQUIRED/);
  assert.deepEqual(await fs.readFile(config), before);
  assert.equal((await bindProject(p.source, { hostProjectDir: null })).project_id, binding.project_id);
});

test('fresh nested coordinator and fresh external coordinator cannot bypass the original identity', async t => {
  const p = await fixture(t);
  await bindProject(p.source, { hostProjectDir: null });
  const nested = await p.repo('source/copies/fresh');
  const external = await p.repo('external');
  await assert.rejects(bindProject(nested, { hostProjectDir: null }), /RELOCATION_REQUIRED/);
  await assert.rejects(bindProject(external, { hostProjectDir: p.source }), /RELOCATION_REQUIRED/);
  assert.equal(await json(path.join(external, '.agent-orchestrator/project-identity.json')), null);
});

test('an audit of a clean new copy alone does not approve execution or rewrite its config', async t => {
  const p = await fixture(t);
  const target = await p.repo('source/copies/fresh');
  const before = await fs.readFile(path.join(target, '.agent-orchestrator/config.json'));
  const audit = await p.lifecycle.audit(target);
  assert.equal(audit.project_identity.status, 'blocked');
  assert.equal(audit.action_required, true);
  await assert.rejects(bindProject(target, { hostProjectDir: null }), /IDENTITY_REQUIRED|RELOCATION_REQUIRED/);
  assert.deepEqual(await fs.readFile(path.join(target, '.agent-orchestrator/config.json')), before);
});

test('coordinator enrollment requires original audit, explicit approval and unchanged target evidence', async t => {
  const p = await fixture(t);
  const target = await p.repo('source/copies/short');
  const audit = await p.lifecycle.audit(p.source);
  await assert.rejects(p.lifecycle.reconcile(p.source, { audit_id: audit.audit_id, mode: 'prepare', actions: [{ kind: 'register_coordinator', path: target, reason: 'short path' }], baseline: 'head' }), /clone_paths/);
  const { audit: a, plan, execute } = await enroll(p, target);
  await assert.rejects(p.lifecycle.reconcile(p.source, { audit_id: a.audit_id, plan_id: plan.plan_id, mode: 'execute' }), /approval/);
  await fs.writeFile(path.join(target, 'README.md'), 'changed after audit\n');
  await assert.rejects(execute(), /ENVIRONMENT_CHANGED/);
});

test('approved coordinator and root share capacity even when the copy raises its own limits', async t => {
  const p = await fixture(t);
  const target = await p.repo('source/copies/short');
  await (await enroll(p, target)).execute();
  const rootBinding = await bindProject(p.source, { hostProjectDir: null });
  assert.equal((await bindProject(target, { hostProjectDir: null })).project_id, rootBinding.project_id);
  assert.equal((await bindProject(p.source, { hostProjectDir: target })).project_id, rootBinding.project_id);
  const config = { execution: { workspace_wait_timeout_seconds: 0 }, git_lifecycle: { max_worker_worktrees: 999, max_worktrees: 999 } };
  const worker = await reserveWorkspace({ projectDir: target, jobDir: path.join(target, '.agent-orchestrator/runs/worker'), config });
  assert.equal(worker.mode, 'isolated');
  await assert.rejects(reserveWorkspace({ projectDir: p.source, jobDir: path.join(p.source, '.agent-orchestrator/runs/overflow'), config }), /WORKSPACE_CAPACITY_REQUIRED/);
  const registry = await json(path.join(rootBinding.canonical_common, 'agent-orch/workspaces.json'));
  assert.equal(registry.worker.path, worker.path);
});

test('source changes and block baselines deny registered coordinator execution until re-reconciliation', async t => {
  const p = await fixture(t);
  const target = await p.repo('source/copies/short');
  await (await enroll(p, target, { baseline: 'block' })).execute();
  await assert.rejects(bindProject(target, { hostProjectDir: null }), /SOURCE_RECONCILIATION_REQUIRED/);
  await (await enroll(p, target)).execute();
  await fs.writeFile(path.join(p.source, 'README.md'), 'new source change\n');
  await assert.rejects(bindProject(target, { hostProjectDir: null }), /SOURCE_CHANGED/);
});

test('independent coordinator checkouts themselves count against the original limit', async t => {
  const p = await fixture(t);
  await (await enroll(p, await p.repo('source/copies/one'))).execute();
  await (await enroll(p, await p.repo('source/copies/two'))).execute();
  const third = await p.repo('source/copies/three');
  await assert.rejects((await enroll(p, third)).execute(), /WORKSPACE_CAPACITY_REQUIRED/);
});

test('parallel processes cannot each allocate from a separate coordinator budget', async t => {
  const p = await fixture(t);
  const target = await p.repo('source/copies/short');
  await (await enroll(p, target)).execute();
  const moduleUrl = new URL('../scripts/lib/workspace-pool.mjs', import.meta.url).href;
  const run = promisify(execFile);
  const outputs = await Promise.all([p.source, target].map((project, n) => run(process.execPath, ['--input-type=module', '-e', `
    import { reserveWorkspace } from ${JSON.stringify(moduleUrl)};
    const project = process.argv[1], jobDir = process.argv[2];
    try {
      const workspace = await reserveWorkspace({projectDir:project, jobDir, config:{execution:{workspace_wait_timeout_seconds:0},git_lifecycle:{max_worktrees:999}}});
      console.log(JSON.stringify({ok:true,path:workspace.path}));
    } catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); }
  `, project, path.join(project, `.agent-orchestrator/runs/parallel-${n}`)], { env: { ...process.env, CODEX_THREAD_ID: '' }, windowsHide: true })));
  const results = outputs.map(x => JSON.parse(x.stdout));
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.match(results.find(x => !x.ok).error, /WORKSPACE_CAPACITY_REQUIRED/);
});

test('legacy workers in an enrolled copy consume the canonical worker cap', async t => {
  const p = await fixture(t);
  const configPath = path.join(p.source, '.agent-orchestrator/config.json');
  const config = await json(configPath);
  config.git_lifecycle = { max_worker_worktrees: 1, max_worktrees: 5 };
  await save(configPath, config);
  const target = await p.repo('source/copies/legacy');
  const oldPath = path.join(target, '.agent-orchestrator/runs/legacy/worktree');
  await git(target, ['worktree', 'add', '--detach', oldPath, 'HEAD']);
  await save(path.join((await identity(target)).common, 'agent-orch/workspaces.json'), { legacy: { owner_job_id: 'legacy', path: oldPath, kind: 'worker' } });
  await (await enroll(p, target)).execute();
  await assert.rejects(reserveWorkspace({ projectDir: p.source, jobDir: path.join(p.source, '.agent-orchestrator/runs/new-worker'), config: { execution: { workspace_wait_timeout_seconds: 0 } } }), /WORKSPACE_CAPACITY_REQUIRED/);
});

test('erasing an enrolled coordinator Git marker cannot create a new independent budget', async t => {
  const p = await fixture(t);
  const target = await p.repo('source/copies/short');
  await (await enroll(p, target)).execute();
  await fs.unlink(path.join((await identity(target)).common, 'agent-orch/project-identity.json'));
  await assert.rejects(bindProject(target, { hostProjectDir: null }), /MEMBER_CHANGED/);
  await assert.rejects(reserveWorkspace({ projectDir: p.source, jobDir: path.join(p.source, '.agent-orchestrator/runs/new'), config: { execution: { workspace_wait_timeout_seconds: 0 } } }), /MEMBER_CHANGED/);
});

test('legacy cleanup releases its old registry without enrolling an unapproved coordinator', async t => {
  const p = await fixture(t);
  await bindProject(p.source, { hostProjectDir: null });
  const target = await p.repo('source/copies/legacy-cleanup');
  const registry = path.join((await identity(target)).common, 'agent-orch/workspaces.json');
  await save(registry, { legacy: { owner_job_id: 'legacy', path: path.join(target, '.agent-orchestrator/runs/legacy/worktree') } });
  await releaseWorkspace(target, 'legacy');
  assert.deepEqual(await json(registry), {});
  assert.equal(await json(path.join(target, '.agent-orchestrator/project-identity.json')), null);
  await assert.rejects(bindProject(target, { hostProjectDir: null }), /RELOCATION_REQUIRED/);
});

test('host project detection reads only exact session header identity', async t => {
  const p = await fixture(t);
  const home = path.join(p.root, 'codex');
  const id = '11111111-1111-4111-8111-111111111111';
  const sessions = path.join(home, 'sessions/2026/11/04');
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: p.source } }) + '\n');
  assert.equal(await discoverHostProject({ threadId: id, codexHome: home }), p.source);
  assert.equal(await discoverHostProject({ threadId: '22222222-2222-4222-8222-222222222222', codexHome: home }), null);
});

test('CLI init and resume reject a fresh nested coordinator before changing routes', async t => {
  const p = await fixture(t);
  const target = await p.repo('source/copies/fresh');
  const config = path.join(target, '.agent-orchestrator/config.json');
  const before = await fs.readFile(config);
  for (const command of ['init', 'resume']) {
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/agent-orch.mjs', import.meta.url)), command, '-ProjectDir', target, '-UseExistingRoutes'], { env: { ...process.env, CODEX_THREAD_ID: '' }, windowsHide: true }), error => /PROJECT_IDENTITY_REQUIRED|RELOCATION_REQUIRED/.test(error.stdout));
    assert.deepEqual(await fs.readFile(config), before);
  }
});

test('even an approved coordinator cannot reuse a copied native Plan execution identity', async t => {
  const p = await fixture(t);
  const target = await p.repo('source/copies/short');
  await (await enroll(p, target)).execute();
  const original = await bindProject(p.source, { hostProjectDir: null });
  const child = await bindProject(target, { hostProjectDir: null });
  const a = new StageRuntime({}, p.source), b = new StageRuntime({}, target);
  await a.savePlanIdentity('copied', { provider: 'codex', model: 'host', project_id: original.project_id, coordinator_common: original.coordinator_common });
  await fs.mkdir(path.dirname(b.planIdentityFile('copied')), { recursive: true });
  await fs.copyFile(a.planIdentityFile('copied'), b.planIdentityFile('copied'));
  await assert.rejects(b.assertProjectIdentity('copied', child), /PLAN_PROJECT_IDENTITY_MISMATCH/);
  await b.savePlanIdentity('new-plan', { provider: 'codex', model: 'host', project_id: child.project_id, coordinator_common: child.coordinator_common });
  await b.assertProjectIdentity('new-plan', child);
});

test('MCP denies a foreign stage-plan before writing contracts, even with fresh config and a clean copy', async t => {
  const p = await fixture(t);
  const target = await p.repo('external');
  const home = path.join(p.root, 'host');
  const id = '11111111-1111-4111-8111-111111111111';
  const dir = path.join(home, 'sessions/2026/11/04');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: p.source } }) + '\n');
  const client = new Client({ name: 'identity-regression', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../scripts/mcp-stdio-bridge.mjs', import.meta.url))], env: { ...process.env, CODEX_HOME: home, CODEX_THREAD_ID: id } }));
  t.after(() => client.close());
  for (const name of ['stage-plan', 'stage-work']) {
    const result = await client.callTool({ name, arguments: name === 'stage-plan' ? { project_dir: target, task_id: 'bypass', planner_session_id: id, contract: {} } : { project_dir: target, task_id: 'bypass', subtask_id: 'impl' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /PROJECT_IDENTITY_REQUIRED/);
  }
  assert.equal(await fs.stat(path.join(target, '.agent-orchestrator/plans/bypass.json')).catch(() => null), null);
  assert.equal((await inventory(target)).changes.length, 0);
});
