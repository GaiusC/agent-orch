import fs from 'node:fs/promises';
import path from 'node:path';
import { git, identity, inventory, json, save, repositoryLock, scopedTree, removeIndex, canonicalPath } from './lifecycle-git.mjs';
import { recordGitOperation } from './git-events.mjs';
import { bindProject, canonicalPolicy, sharedWorkspacePaths, familyRepositories, cleanupProjectBinding } from './project-identity.mjs';

export async function directoryBytes(directory, stopAfter = Infinity) {
  let bytes = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else bytes += (await fs.stat(target)).size;
      if (bytes > stopAfter) return bytes;
    }
  }
  return bytes;
}

export async function reserveWorkspace({ projectDir, jobDir, config, signal, kind = 'worker', baseCommit = null, onWait }) {
  const worktree = path.join(jobDir, 'worktree');
  const owner = path.basename(jobDir);
  const binding = await bindProject(projectDir);
  const deadline = Date.now() + 1000 * (config.execution.workspace_wait_timeout_seconds ?? 1800);
  let notified = false;
  while (true) {
    if (signal?.aborted) throw new Error('Workspace allocation cancelled');
    const allocation = await repositoryLock(binding.canonical_root, async () => {
      await bindProject(projectDir);
      const policy = await canonicalPolicy(binding, config.git_lifecycle || {});
      const repo = await identity(projectDir);
      const registryFile = path.join(binding.canonical_common, 'agent-orch', 'workspaces.json');
      const registry = await json(registryFile, {});
      const registeredPaths = [binding.canonical_root, ...await sharedWorkspacePaths(binding)];
      const registeredKeys = await Promise.all(registeredPaths.map(canonicalPath));
      // Include pre-binding allocations from an approved coordinator's old pool.
      for (const member of await familyRepositories(binding)) {
        if (await canonicalPath(member.common) === await canonicalPath(binding.canonical_common)) continue;
        const inherited = await json(path.join(member.common, 'agent-orch', 'workspaces.json'), {});
        for (const [id, entry] of Object.entries(inherited)) {
          if (!registeredKeys.includes(await canonicalPath(entry.path))) continue;
          if (registry[id] && await canonicalPath(registry[id].path) !== await canonicalPath(entry.path)) throw new Error('Worktree owner collision across coordinator repositories');
          registry[id] ||= entry;
        }
      }
      const worktreeKey = await canonicalPath(worktree);
      if (registry[owner] && !registeredKeys.includes(worktreeKey)) delete registry[owner];
      if (registry[owner]) {
        const source = await inventory(projectDir);
        if (path.resolve(registry[owner].path) !== path.resolve(worktree)) throw new Error('Worktree owner collision');
        await recordGitOperation({projectDir,jobDir,job:await json(path.join(jobDir,'job.json'),{}),kind:'workspace.created',workspace:worktree,before_head:source.head,after_head:registry[owner].base_commit,ref:null,recovered:true,occurred_at:registry[owner].created_at});
        return { mode: 'isolated', path: worktree, original_project_dir: repo.root, git: { is_git: true, root: repo.root, head: source.head }, base_commit: registry[owner].base_commit, source_inventory: source, owner_job_id: owner };
      }
      const present = [];
      for (const entry of Object.values(registry)) if (registeredKeys.includes(await canonicalPath(entry.path))) present.push(entry);
      const linkedCount = Math.max(0, registeredPaths.length - 1);
      const maxWorkers = policy.max_worker_worktrees ?? 2, maxTotal = policy.max_worktrees ?? 3;
      if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || !Number.isInteger(maxTotal) || maxTotal < 1) throw new Error('Invalid worktree capacity policy');
      if (linkedCount >= maxTotal || (kind === 'worker' && present.filter(e => e.kind === 'worker').length >= maxWorkers)) return null;
      if (kind === 'integration' && present.some(entry => entry.kind === 'integration')) return null;
      const source = await inventory(projectDir);
      if (!source.head) throw new Error('Create a reviewed initial commit before allocating worker worktrees');
      if (Object.values(source.operations).some(Boolean)) throw new Error('Unfinished Git operation prevents allocation');
      let base = baseCommit || source.head;
      if (!baseCommit && source.changes.length) {
        const readiness = await json(path.join(projectDir, '.agent-orchestrator', 'environment', 'readiness.json'));
        if (!readiness || readiness.fingerprint !== source.fingerprint || !['head', 'snapshot'].includes(readiness.baseline)) throw new Error('ENVIRONMENT_RECONCILIATION_REQUIRED: dirty source needs an audited, explicitly approved baseline; do not clone to bypass it');
        if (readiness.baseline === 'snapshot') {
          if (policy.allow_snapshot !== true) throw new Error('Snapshot baselines require project policy opt-in');
          const files = [...new Set(source.changes.flatMap(c => [c.path, c.from].filter(Boolean)))];
          const staged = await scopedTree(projectDir, files, path.join(jobDir, 'baseline'));
          try {
            base = await git(projectDir, ['commit-tree', staged.tree, '-p', source.head, '-m', `Agent Orch approved baseline ${owner}`]);
            await git(projectDir, ['update-ref', `refs/agent-orch/baselines/${owner}`, base]);
          } finally { await removeIndex(staged.index); }
        }
      }
      if (policy.max_workspace_bytes != null) {
        if (!Number.isSafeInteger(policy.max_workspace_bytes) || policy.max_workspace_bytes < 1) throw new Error('Invalid workspace byte budget');
        let used = 0;
        for (const directory of registeredPaths.slice(1)) used += await directoryBytes(directory, policy.max_workspace_bytes);
        const estimate = (await git(projectDir, ['ls-tree', '-r', '-l', base])).split('\n').reduce((sum, line) => sum + Number(line.match(/^\d+ \S+ \S+\s+(\d+)\t/)?.[1] || 0), 0);
        if (used + estimate > policy.max_workspace_bytes) return null;
      }
      await git(projectDir, ['worktree', 'add', '--detach', worktree, base]);
      registry[owner] = { owner_job_id: owner, path: worktree, project_dir: repo.root, kind, base_commit: base, created_at: new Date().toISOString() };
      await save(registryFile, registry);
      await recordGitOperation({projectDir,jobDir,job:await json(path.join(jobDir,'job.json'),{}),kind:'workspace.created',workspace:worktree,before_head:source.head,after_head:base,ref:null,occurred_at:registry[owner].created_at});
      return { mode: 'isolated', path: worktree, original_project_dir: repo.root, git: { is_git: true, root: repo.root, head: source.head }, base_commit: base, source_inventory: source, owner_job_id: owner };
    });
    if (allocation) return allocation;
    if (!notified) { notified = true; await onWait?.(); }
    if (Date.now() >= deadline) throw new Error('WORKSPACE_CAPACITY_REQUIRED: capacity/storage budget exhausted; preserve pending work and release a reviewed slot');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

// Caller holds the repository lifecycle lock.
export async function releaseWorkspace(project, owner) {
  // Cleanup of retained historical work remains possible after source drift.
  const binding = await cleanupProjectBinding(project);
  const registryFile = path.join(binding.canonical_common, 'agent-orch', 'workspaces.json');
  const release = async () => {
    const registry = await json(registryFile, {});
    delete registry[owner];
    await save(registryFile, registry);
  };
  if (await canonicalPath((await identity(project)).common) === await canonicalPath(binding.canonical_common)) return release();
  return repositoryLock(binding.canonical_root, release);
}
