import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { runProcess } from "./process.mjs";
import { matchesPathPattern, pathExists } from "./utils.mjs";
import { inventory, identity, git as lifecycleGit, repositoryLock, internal } from "./lifecycle-git.mjs";
import { reserveWorkspace, releaseWorkspace } from "./workspace-pool.mjs";

function relevantStatus(rawStatus) {
  return rawStatus
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const file = line.slice(3).replaceAll("\\", "/");
      return !(file === ".agent-orchestrator" || file.startsWith(".agent-orchestrator/"));
    })
    .join("\n");
}

async function runGit(projectDir, args, logDir, prefix, options = {}) {
  return runProcess({
    command: "git",
    args,
    cwd: projectDir,
    logDir,
    logPrefix: prefix,
    timeoutSeconds: options.timeoutSeconds || 120,
    maxLogBytes: options.maxLogBytes || 32 * 1024 * 1024,
  });
}

export async function inspectGit(projectDir, logDir) {
  const inside = await runGit(projectDir, ["rev-parse", "--is-inside-work-tree"], logDir, "git-inside").catch(() => null);
  if (!inside || inside.exit_code !== 0 || inside.stdout.trim() !== "true") return { is_git: false, clean: false };
  const rootResult = await runGit(projectDir, ["rev-parse", "--show-toplevel"], logDir, "git-root");
  const status = await runGit(projectDir, ["status", "--porcelain=v1", "--untracked-files=all"], logDir, "git-status");
  const relevant = relevantStatus(status.stdout);
  const head = await runGit(projectDir, ["rev-parse", "HEAD"], logDir, "git-head");
  return {
    is_git: true,
    root: rootResult.stdout.trim(),
    head: head.stdout.trim(),
    clean: relevant.length === 0,
    status: relevant,
    raw_status: status.stdout.trim(),
  };
}

export async function prepareWorkspace({ projectDir, jobDir, config, requestedMode, signal, onWait }) {
  const git = await inspectGit(projectDir, jobDir);
  const mode = requestedMode || config.execution.workspace_mode || "isolated";
  if (mode === "in_place") {
    if (config.git_lifecycle?.allow_in_place !== true) throw new Error("In-place work requires explicit git_lifecycle.allow_in_place policy opt-in.");
    if (!config.execution.allow_dirty_in_place && git.is_git && !git.clean) {
      throw new Error("In-place execution is disabled for a dirty working tree.");
    }
    return { mode: "in_place", path: path.resolve(projectDir), original_project_dir: path.resolve(projectDir), git, source_inventory: await inventory(projectDir), base_commit: git.head };
  }
  if (!git.is_git) throw new Error("Isolated implementation requires a Git repository. Use in_place only after explicitly allowing it in project config.");
  return reserveWorkspace({ projectDir, jobDir, config, signal, onWait });
}

export async function captureChanges({ workspace, jobDir, forbidden = [], writable = [] }) {
  const emptyIntent = await runGit(workspace, ["add", "-N", "."], jobDir, "git-add-intent");
  if (emptyIntent.exit_code !== 0) throw new Error(`Unable to inventory new files: ${emptyIntent.stderr}`);
  const patchResult = await runGit(workspace, ["diff", "--binary", "--no-ext-diff"], jobDir, "git-diff", { maxLogBytes: 64 * 1024 * 1024 });
  const patchPath = path.join(jobDir, "changes.patch");
  await fs.writeFile(patchPath, patchResult.stdout, "utf8");
  const stat = await runGit(workspace, ["diff", "--stat", "--no-ext-diff"], jobDir, "git-diff-stat");
  const names = await runGit(workspace, ["diff", "--name-only", "--no-ext-diff"], jobDir, "git-diff-names");
  const files = names.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const unauthorized = writable.length
    ? files.filter((file) => !writable.some((pattern) => allowsPath(pattern, file)))
    : [];
  return {
    patch_path: patchPath,
    patch_digest: crypto.createHash("sha256").update(patchResult.stdout).digest("hex"),
    patch_bytes: Buffer.byteLength(patchResult.stdout),
    diff_stat: stat.stdout.trim(),
    changed_files: files,
    forbidden_changes: files.filter((file) => forbidden.some((pattern) => matchesPathPattern(file, pattern))),
    unauthorized_changes: unauthorized,
  };
}

function allowsPath(pattern, file) {
  const normalized = String(pattern || "").replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === "./" || normalized === "**" || normalized === "**/*") return true;
  return matchesPathPattern(file, pattern);
}

export async function applyPatch({ originalProjectDir, patchPath, logDir }) {
  const check = await runGit(originalProjectDir, ["apply", "--check", "--whitespace=nowarn", patchPath], logDir, "git-apply-check");
  if (check.exit_code !== 0) throw new Error(`Patch no longer applies cleanly: ${check.stderr || check.stdout}`);
  const apply = await runGit(originalProjectDir, ["apply", "--whitespace=nowarn", patchPath], logDir, "git-apply");
  if (apply.exit_code !== 0) throw new Error(`Failed to apply patch: ${apply.stderr || apply.stdout}`);
  return { applied: true, project_dir: originalProjectDir, patch_path: patchPath };
}

export async function cleanupWorkspace({ originalProjectDir, workspacePath, mode, logDir }) {
  if (mode !== "isolated" || !workspacePath || !(await pathExists(workspacePath))) return { removed: false };
  return repositoryLock(originalProjectDir, async () => {
    const target = await identity(workspacePath), source = await identity(originalProjectDir);
    if (target.common !== source.common || target.root === source.root || path.resolve(workspacePath) !== path.resolve(logDir, 'worktree')) throw new Error('Unregistered cleanup path');
    const state = await inventory(workspacePath);
    const extras = (await lifecycleGit(workspacePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).split('\0').filter(file => file && !internal(file.replace(/\/$/, '')));
    if (state.changes.length || extras.length || Object.values(state.operations).some(Boolean)) return { removed: false, preserved: true, reason: 'unfinished_work_requires_reviewed_retirement' };
    await lifecycleGit(originalProjectDir, ['worktree', 'remove', workspacePath]);
    await releaseWorkspace(originalProjectDir, path.basename(logDir));
    return { removed: true, path: workspacePath };
  });
}
