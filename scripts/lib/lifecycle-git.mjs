import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withFileLock } from './notifications.mjs';

const execute = promisify(execFile);
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const internal = file => file === '.agent-orchestrator' || file.startsWith('.agent-orchestrator/');
export const sensitive = file => /(^|\/)(?:\.git|\.env(?:\..*)?|id_rsa|id_ed25519)(\/|$)/i.test(file);
export const safeId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw new Error('Invalid lifecycle identifier');
  return value;
};
export async function canonicalPath(value) {
  let resolved;
  try { resolved = await fs.realpath(value); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const absolute = path.resolve(value);
    const parent = path.dirname(absolute);
    resolved = parent === absolute ? absolute : path.join(await canonicalPath(parent), path.basename(absolute));
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export function safePath(value, { preserve = false } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.includes(':') || value.split('/').some(p => !p || p === '..' || p === '.') || path.isAbsolute(value) || internal(value) || /(^|\/)\.git(\/|$)/i.test(value) || (!preserve && sensitive(value))) throw new Error(`Unsafe lifecycle path: ${value}`);
  return value;
}
export async function git(cwd, args, options = {}) {
  try {
    const result = await execute('git', ['-c', `safe.directory=${path.resolve(cwd).replaceAll('\\', '/')}`, '--literal-pathspecs', ...args], {
      cwd, windowsHide: true, encoding: options.binary ? 'buffer' : 'utf8', maxBuffer: 128 * 1024 * 1024,
      timeout: 120000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options.env },
    });
    return options.binary ? result.stdout : result.stdout.trimEnd();
  } catch (error) {
    if (options.allowFailure) return null;
    throw new Error(`Git ${args[0]} failed: ${String(error.stderr || error.message).slice(0, 1500)}`);
  }
}
export async function json(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function save(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temporary, file);
}
export async function fileState(root, file) {
  const target = path.resolve(root, file);
  // Do not hash through directory junctions/symlinks into another project.
  let parent = path.dirname(target);
  while (parent !== path.resolve(root)) {
    if (!parent.startsWith(path.resolve(root) + path.sep)) throw new Error('Path escaped repository');
    const info = await fs.lstat(parent).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error(`Linked parent is not supported: ${file}`);
    parent = path.dirname(parent);
  }
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink()) return { type: 'link', digest: digest(await fs.readlink(target)) };
    if (!info.isFile()) throw new Error(`Non-file path requires manual handling: ${file}`);
    return { type: 'file', bytes: info.size, digest: digest(await fs.readFile(target)) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function identity(cwd) {
  const root = await fs.realpath(await git(cwd, ['rev-parse', '--show-toplevel']));
  const common = await fs.realpath(path.resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir'])));
  return { root, common, key: digest(common.toLowerCase()).slice(0, 24) };
}
export async function gitFileState(cwd, file) {
  const state = await fileState(cwd, file);
  if (!state || state.type === 'link') return state;
  return { type: 'file', blob: await git(cwd, ['hash-object', `--path=${file}`, '--', file]) };
}
export async function inventory(cwd) {
  const repo = await identity(cwd);
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  const branch = await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true });
  const raw = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = raw.split('\0');
  const changes = [];
  for (let n = 0; n < parts.length; n++) {
    if (!parts[n]) continue;
    const status = parts[n].slice(0, 2), file = parts[n].slice(3);
    const from = /[RC]/.test(status) ? parts[++n] : undefined;
    if (!internal(file)) changes.push({ path: file, status, ...(from ? { from } : {}) });
  }
  const tracked = (await git(cwd, ['ls-files', '-z'])).split('\0').filter(file => file && !internal(file));
  const files = Object.create(null);
  for (const file of [...new Set([...tracked, ...changes.flatMap(c => [c.path, c.from].filter(Boolean))])].sort()) files[file] = await fileState(cwd, file);
  const indexPath = path.resolve(cwd, await git(cwd, ['rev-parse', '--git-path', 'index']));
  const index = await fs.readFile(indexPath).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
  const operations = {};
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_START']) {
    const target = path.resolve(cwd, await git(cwd, ['rev-parse', '--git-path', name]));
    operations[name] = Boolean(await fs.stat(target).catch(() => null));
  }
  const value = { ...repo, head, branch, index_digest: digest(index), changes, files, operations };
  return { ...value, fingerprint: digest(value) };
}
export async function repositoryLock(cwd, action) {
  const repo = await identity(cwd);
  return withFileLock(path.join(repo.common, 'agent-orch', 'lifecycle.lock'), action);
}
export async function scopedTree(cwd, files, directory, base = 'HEAD') {
  const index = path.join(directory, `index-${crypto.randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(cwd, base ? ['read-tree', base] : ['read-tree', '--empty'], { env });
    for (const file of files) {
      safePath(file);
      await fileState(cwd, file);
      await git(cwd, ['add', '-A', '--', file], { env });
    }
    return { tree: await git(cwd, ['write-tree'], { env }), index, env };
  } catch (error) { await fs.rm(index, { force: true }); throw error; }
}
export async function removeIndex(index) {
  await fs.rm(index, { force: true });
  await fs.rm(`${index}.lock`, { force: true });
}
export async function assertNoOperation(cwd) {
  const state = await inventory(cwd);
  if (Object.values(state.operations).some(Boolean) || state.changes.some(c => c.status.includes('U') || ['AA', 'DD'].includes(c.status))) throw new Error('Unresolved Git operation requires manual handling');
  return state;
}
