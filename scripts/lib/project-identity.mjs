import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalPath, identity, inventory, git, json, save } from './lifecycle-git.mjs';
import { withFileLock } from './notifications.mjs';

const marker = common => path.join(common, 'agent-orch', 'project-identity.json');
const sidecar = root => path.join(root, '.agent-orchestrator', 'project-identity.json');
const same = async (a, b) => await canonicalPath(a) === await canonicalPath(b);
let hostDiscovery;

// Read only the exact caller's session header, never another chat's transcript.
export async function discoverHostProject({ threadId = process.env.CODEX_THREAD_ID, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(threadId || '')) return null;
  async function find(directory, depth = 0) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const file = entries.find(e => e.isFile() && e.name.endsWith(`${threadId}.jsonl`));
    if (file) return path.join(directory, file.name);
    if (depth >= 3) return null;
    for (const e of entries.filter(e => e.isDirectory() && /^\d{2,4}$/.test(e.name)).sort((a,b) => b.name.localeCompare(a.name))) {
      const found = await find(path.join(directory, e.name), depth + 1);
      if (found) return found;
    }
    return null;
  }
  const file = await find(path.join(codexHome, 'sessions'));
  if (!file) return null;
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'session_meta' && event.payload?.id === threadId && path.isAbsolute(event.payload.cwd || '')) return event.payload.cwd;
    }
    return null;
  } finally { await handle.close(); }
}

async function originHint(project, repo, hostProjectDir) {
  const hints = [];
  for (const file of [marker(repo.common), sidecar(project)]) {
    const saved = await json(file);
    if (saved) {
      if (saved.version !== 1 || !saved.project_id || !path.isAbsolute(saved.canonical_root || '') || !path.isAbsolute(saved.canonical_common || '')) throw new Error('PROJECT_IDENTITY_INVALID: inspect the existing identity; do not replace it');
      hints.push(saved.canonical_root);
    }
  }
  // A copied, newly initialized nested repository must not hide its parent.
  let parent = path.dirname(repo.root);
  while (parent !== path.dirname(parent)) {
    if (await fs.stat(path.join(parent, '.git')).catch(() => null)) {
      const outer = await identity(parent);
      if (!await same(outer.common, repo.common)) hints.push((await json(marker(outer.common)))?.canonical_root || outer.root);
      break;
    }
    parent = path.dirname(parent);
  }
  if (hostProjectDir && await fs.stat(hostProjectDir).catch(() => null)) {
    const host = await identity(hostProjectDir).catch(() => null);
    if (host && !await same(host.common, repo.common)) hints.push((await json(marker(host.common)))?.canonical_root || host.root);
  }
  if (hints.length) {
    const first = await identity(hints[0]);
    for (const hint of hints.slice(1)) if (!await same((await identity(hint)).common, first.common)) throw new Error('PROJECT_IDENTITY_CONFLICT: source, host and copied identity disagree');
    return first;
  }
  // Linked worktrees share the primary repository's identity and budget.
  const primary = (await git(project, ['worktree', 'list', '--porcelain', '-z'])).split('\0').find(x => x.startsWith('worktree '));
  return identity(primary ? primary.slice(9) : repo.root);
}

export async function bindProject(project, { hostProjectDir, create = true, checkFresh = true } = {}) {
  const repo = await identity(project).catch(error => {
    throw new Error(`PROJECT_IDENTITY_GIT_REQUIRED: ${error.message}`);
  });
  if (hostProjectDir === undefined) {
    hostProjectDir = await (hostDiscovery ||= discoverHostProject());
    if (process.env.CODEX_THREAD_ID && !hostProjectDir && !await json(marker(repo.common)) && !await json(sidecar(project))) throw new Error('PROJECT_HOST_IDENTITY_UNAVAILABLE: cannot establish a fresh coordinator without the exact caller project; restore caller metadata before retrying');
  }
  const origin = await originHint(project, repo, hostProjectDir);
  const file = marker(origin.common);
  const binding = await withFileLock(file + '.lock', async () => {
    let family = await json(file);
    if (!family) {
      if (!await same(origin.common, repo.common)) throw new Error(`PROJECT_IDENTITY_REQUIRED: audit original project ${origin.root} and register this coordinator there before execution`);
      if (!create) return { status: 'unbound', canonical_root: origin.root, canonical_common: origin.common };
      if (await json(sidecar(project))) throw new Error('PROJECT_IDENTITY_MISSING: existing sidecar lost its canonical Git identity; inspect and restore it rather than creating a new identity');
      family = { version: 1, project_id: crypto.randomUUID(), canonical_root: origin.root, canonical_common: origin.common, coordinators: [], created_at: new Date().toISOString() };
      await save(file, family);
    }
    if (family.version !== 1 || !family.project_id || !Array.isArray(family.coordinators) || !await same(family.canonical_common, origin.common) || !await same(family.canonical_root, origin.root)) throw new Error('PROJECT_IDENTITY_INVALID: canonical repository identity changed');
    const local = await json(sidecar(project));
    const commonMarker = await json(marker(repo.common));
    for (const saved of [local, commonMarker].filter(Boolean)) {
      if (saved.project_id !== family.project_id || !await same(saved.canonical_common, family.canonical_common)) throw new Error('PROJECT_IDENTITY_MISMATCH: copied or conflicting identity cannot authorize a new repository');
    }
    const canonical = await same(repo.common, family.canonical_common);
    const member = canonical ? null : family.coordinators.find(m => path.resolve(m.common) === path.resolve(repo.common));
    if (!canonical && (!member || !await same(member.root, repo.root))) throw new Error(`PROJECT_IDENTITY_RELOCATION_REQUIRED: audit ${family.canonical_root} with clone_paths and prepare register_coordinator for ${repo.root}`);
    if (member && !commonMarker) throw new Error('PROJECT_IDENTITY_MEMBER_CHANGED: registered coordinator lost its Git identity; re-audit and renew registration');
    const binding = { version: 1, project_id: family.project_id, canonical_root: family.canonical_root, canonical_common: family.canonical_common, coordinator_root: repo.root, coordinator_common: repo.common };
    if (create && !local) await save(sidecar(project), binding);
    return { ...binding, status: 'bound', family, member };
  });
  if (binding.member && checkFresh) {
    const source = await inventory(binding.canonical_root);
    if (source.fingerprint !== binding.member.source_fingerprint) throw new Error('PROJECT_IDENTITY_SOURCE_CHANGED: re-audit the original project and renew the coordinator registration');
    const ready = await json(path.join(binding.canonical_root, '.agent-orchestrator', 'environment', 'readiness.json'));
    if (ready?.fingerprint !== source.fingerprint || !['head', 'snapshot'].includes(ready.baseline)) throw new Error('PROJECT_IDENTITY_SOURCE_RECONCILIATION_REQUIRED: approve the original project baseline before coordinator execution');
  }
  return binding;
}

export async function inspectProjectBinding(project) {
  try {
    const binding = await bindProject(project, { create: false, checkFresh: false });
    const { family, member, ...compact } = binding;
    return compact;
  } catch (error) { return { status: 'blocked', error: error.message }; }
}

export async function familyRepositories(binding) {
  const family = await json(marker(binding.canonical_common));
  if (!family || family.project_id !== binding.project_id) throw new Error('PROJECT_IDENTITY_MISMATCH: canonical binding disappeared');
  const repositories = [{ root: family.canonical_root, common: family.canonical_common }, ...family.coordinators];
  for (const member of repositories) {
    const actual = await identity(member.root);
    if (!await same(actual.common, member.common)) throw new Error('PROJECT_IDENTITY_MEMBER_CHANGED: inspect registered coordinators before allocating');
    if ((await json(marker(member.common)))?.project_id !== family.project_id) throw new Error('PROJECT_IDENTITY_MEMBER_CHANGED: registered Git identity is missing or was replaced');
  }
  return repositories;
}

// Retiring an already validated legacy worktree must not enroll its coordinator.
export async function cleanupProjectBinding(project) {
  const repo = await identity(project);
  const local = await json(marker(repo.common));
  if (!local) return { canonical_root: repo.root, canonical_common: repo.common };
  const family = await json(marker(local.canonical_common));
  const member = family?.coordinators?.some(m => path.resolve(m.common) === path.resolve(repo.common));
  if (!family || family.project_id !== local.project_id || (!await same(repo.common, family.canonical_common) && !member)) throw new Error('PROJECT_IDENTITY_MISMATCH: inspect cleanup registry provenance');
  return { canonical_root: family.canonical_root, canonical_common: family.canonical_common };
}

export async function sharedWorkspacePaths(binding) {
  const repositories = await familyRepositories(binding);
  const paths = [];
  for (const repo of repositories) {
    const registered = (await git(repo.root, ['worktree', 'list', '--porcelain', '-z'])).split('\0').filter(x => x.startsWith('worktree ')).map(x => x.slice(9));
    paths.push(...registered);
  }
  const unique = new Map();
  for (const p of paths) unique.set(await canonicalPath(p), p);
  unique.delete(await canonicalPath(binding.canonical_root));
  return [...unique.values()];
}

export async function canonicalPolicy(binding, fallback = {}) {
  const config = await json(path.join(binding.canonical_root, '.agent-orchestrator', 'config.json'), {});
  const local = await same(binding.coordinator_common, binding.canonical_common) ? fallback : {};
  const policy = { max_worker_worktrees: 2, max_worktrees: 3, max_workspace_bytes: null, ...local, ...config.git_lifecycle };
  if (![policy.max_worker_worktrees, policy.max_worktrees].every(n => Number.isInteger(n) && n >= 1)) throw new Error('Invalid canonical workspace capacity policy');
  return policy;
}

// Called under the canonical repository lifecycle lock after exact audit checks.
export async function registerCoordinator(project, target, { audit_id, source_fingerprint, target_fingerprint, reason }) {
  const binding = await bindProject(project);
  if (!await same(binding.canonical_root, project)) throw new Error('Coordinator registration must run from the original project');
  const repo = await identity(target);
  if (await same(repo.common, binding.canonical_common)) throw new Error('A linked worktree already shares the project identity; do not register it as an independent coordinator');
  if ((await inventory(target)).fingerprint !== target_fingerprint) throw new Error('ENVIRONMENT_CHANGED: coordinator changed since audit');
  if ((await inventory(project)).fingerprint !== source_fingerprint) throw new Error('ENVIRONMENT_CHANGED: original project changed before coordinator registration');
  const file = marker(binding.canonical_common);
  return withFileLock(file + '.lock', async () => {
    const family = await json(file);
    for (const existing of [await json(marker(repo.common)), await json(sidecar(target))].filter(Boolean)) {
      if (existing.project_id !== family.project_id) throw new Error('PROJECT_IDENTITY_MISMATCH: target already belongs to another project');
    }
    const prior = family.coordinators.find(m => path.resolve(m.common) === path.resolve(repo.common));
    const policy = await canonicalPolicy(binding);
    if (!prior) {
      const used = await sharedWorkspacePaths(binding);
      // Enrollment counts the independent checkout and any of its linked workers.
      const targetWorktrees = (await git(target, ['worktree', 'list', '--porcelain', '-z'])).split('\0').filter(x => x.startsWith('worktree '));
      if (used.length + targetWorktrees.length > policy.max_worktrees) throw new Error('WORKSPACE_CAPACITY_REQUIRED: coordinator copies share the original project limit');
    }
    const member = { root: repo.root, common: repo.common, source_fingerprint, audit_id, target_fingerprint, reason, registered_at: new Date().toISOString() };
    family.coordinators = family.coordinators.filter(m => path.resolve(m.common) !== path.resolve(repo.common));
    family.coordinators.push(member);
    // Publish the family first; interrupted registration remains unambiguous.
    await save(file, family);
    const local = { version: 1, project_id: family.project_id, canonical_root: family.canonical_root, canonical_common: family.canonical_common, coordinator_root: repo.root, coordinator_common: repo.common };
    await save(marker(repo.common), local);
    await save(sidecar(target), local);
    return { project_id: family.project_id, coordinator: repo.root, audit_id, shared_limit: policy.max_worktrees };
  });
}
