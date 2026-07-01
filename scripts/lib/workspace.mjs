import fs from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process.mjs";
import { matchesPathPattern, pathExists } from "./utils.mjs";

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
  const head = await runGit(projectDir, ["rev-parse", "HEAD"], logDir, "git-head");
  return {
    is_git: true,
    root: rootResult.stdout.trim(),
    head: head.stdout.trim(),
    clean: status.stdout.trim().length === 0,
    status: status.stdout.trim(),
  };
}

export async function prepareWorkspace({ projectDir, jobDir, config, requestedMode }) {
  const git = await inspectGit(projectDir, jobDir);
  const mode = requestedMode || config.execution.workspace_mode || "isolated";
  if (mode === "in_place") {
    if (!config.execution.allow_dirty_in_place && git.is_git && !git.clean) {
      throw new Error("In-place execution is disabled for a dirty working tree.");
    }
    return { mode: "in_place", path: path.resolve(projectDir), original_project_dir: path.resolve(projectDir), git };
  }
  if (!git.is_git) throw new Error("Isolated implementation requires a Git repository. Use in_place only after explicitly allowing it in project config.");
  if (!git.clean) throw new Error("Isolated implementation requires a clean Git working tree. Commit or stash current changes first.");

  const worktree = path.join(jobDir, "worktree");
  if (!(await pathExists(worktree))) {
    const add = await runGit(git.root, ["worktree", "add", "--detach", worktree, git.head], jobDir, "git-worktree-add", { timeoutSeconds: 180 });
    if (add.exit_code !== 0) throw new Error(`Failed to create worktree: ${add.stderr || add.stdout}`);
  }
  return { mode: "isolated", path: worktree, original_project_dir: git.root, git };
}

export async function captureChanges({ workspace, jobDir, forbidden = [] }) {
  const emptyIntent = await runGit(workspace, ["add", "-N", "."], jobDir, "git-add-intent");
  if (emptyIntent.exit_code !== 0) throw new Error(`Unable to inventory new files: ${emptyIntent.stderr}`);
  const patchResult = await runGit(workspace, ["diff", "--binary", "--no-ext-diff"], jobDir, "git-diff", { maxLogBytes: 64 * 1024 * 1024 });
  const patchPath = path.join(jobDir, "changes.patch");
  await fs.writeFile(patchPath, patchResult.stdout, "utf8");
  const stat = await runGit(workspace, ["diff", "--stat", "--no-ext-diff"], jobDir, "git-diff-stat");
  const names = await runGit(workspace, ["diff", "--name-only", "--no-ext-diff"], jobDir, "git-diff-names");
  const files = names.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  return {
    patch_path: patchPath,
    patch_bytes: Buffer.byteLength(patchResult.stdout),
    diff_stat: stat.stdout.trim(),
    changed_files: files,
    forbidden_changes: files.filter((file) => forbidden.some((pattern) => matchesPathPattern(file, pattern))),
  };
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
  const remove = await runGit(originalProjectDir, ["worktree", "remove", "--force", workspacePath], logDir, "git-worktree-remove", { timeoutSeconds: 180 });
  if (remove.exit_code !== 0) throw new Error(`Failed to remove worktree: ${remove.stderr || remove.stdout}`);
  return { removed: true, path: workspacePath };
}
