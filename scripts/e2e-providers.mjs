#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { persistPlannerContract } from "./lib/contracts.mjs";
import { WorkerOrchestrator } from "./lib/orchestrator.mjs";
import { captureRuntimeEnvironment } from "./lib/runtime-env.mjs";
import { StateStore } from "./lib/state.mjs";

const requested = process.argv.slice(2).filter((value) => !value.startsWith("-"));
const providers = requested.length ? requested : ["cc", "agy_write", "codex_worker"];
const runReview = process.argv.includes("--review");
const keep = process.argv.includes("--keep");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function waitFor(orchestrator, jobId, timeoutMs = 1_800_000) {
  const deadline = Date.now() + timeoutMs;
  let lastPhase = null;
  while (Date.now() < deadline) {
    const job = await orchestrator.status(jobId);
    if (job.phase !== lastPhase) {
      process.stdout.write(`${JSON.stringify({ event: "job.phase", job_id: jobId, provider: job.provider, status: job.status, phase: job.phase, runtime_state: job.runtime_state })}\n`);
      lastPhase = job.phase;
    }
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}

async function createProject(provider) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `agent-orch-real-${provider}-`));
  const projectDir = path.join(root, "project");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "README.md"), `Agent Orch real E2E fixture for ${provider}.\n`);
  await fs.writeFile(
    path.join(projectDir, "AGENTS.md"),
    "Only modify provider.txt. Do not modify tests, configuration, documentation, Git metadata, or external systems.\n",
  );
  await fs.writeFile(
    path.join(projectDir, "verify.cjs"),
    `const fs=require("fs"); const s=fs.readFileSync("provider.txt","utf8"); process.exit(s.includes("provider=${provider}") && s.includes("initial=true") ? 0 : 1);\n`,
  );
  git(projectDir, "init");
  git(projectDir, "config", "user.name", "Agent Orch E2E");
  git(projectDir, "config", "user.email", "agent-orch-e2e@example.test");
  git(projectDir, "add", ".");
  git(projectDir, "commit", "-m", "fixture");

  const route = provider === "cc"
    ? { provider, model: process.env.AGENT_ORCH_E2E_CC_MODEL || "deepseek-v4-flash", invocation: "cli" }
    : provider === "agy_write"
      ? { provider, model: process.env.AGENT_ORCH_E2E_AGY_MODEL || "Claude Sonnet 4.6 (Thinking)", invocation: "cli" }
      : { provider, model: process.env.AGENT_ORCH_E2E_CODEX_MODEL || null, invocation: "cli" };

  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    `${JSON.stringify({
      version: 2,
      trusted: true,
      mcp: { enabled: true, expose_provider_tools: false },
      host: { provider: "codex", in_session_roles: ["planner", "accepter", "coordinator"] },
      cli: {
        claude: process.env.AGENT_ORCH_CLAUDE_BIN || "claude",
        agy: process.env.AGENT_ORCH_AGY_BIN || "agy",
        codex: process.env.AGENT_ORCH_CODEX_BIN || "codex",
        claude_permission_mode: "bypassPermissions",
        agy_sandbox: false,
        agy_write_permission_mode: "dangerously-skip-permissions",
        agy_env: {},
      },
      agy: { enabled: true, fail_fast_on_auth_window: true },
      execution: {
        workspace_mode: "isolated",
        allow_dirty_in_place: false,
        max_cc_repair_rounds: 0,
        cc_timeout_seconds: 1200,
        agy_timeout_seconds: 1200,
        agy_write_timeout_seconds: 1200,
        codex_worker_timeout_seconds: 1200,
        max_log_bytes: 4194304,
        max_result_chars: 8000,
      },
      review_gate: { require_reviewer_for_implementation: runReview, allow_waiver: false },
      scope: { writable: ["provider.txt"], forbidden: [".git/", ".env", ".env.*"] },
      verification: { commands: ["node verify.cjs"] },
      stages: {
        work: { default_complexity: "low", routes: { low: [route], medium: [route], high: [route] } },
        review: {
          default_complexity: "low",
          routes: {
            low: [{ provider: "agy", model: "Gemini 3.5 Flash (Low)", invocation: "cli" }],
            medium: [{ provider: "agy", model: "Gemini 3.5 Flash (High)", invocation: "cli" }],
            high: [{ provider: "agy", model: "Gemini 3.1 Pro (High)", invocation: "cli" }],
          },
        },
      },
    }, null, 2)}\n`,
  );
  await captureRuntimeEnvironment(projectDir);
  return { root, projectDir, route };
}

async function runProvider(provider) {
  if (!["cc", "agy_write", "codex_worker"].includes(provider)) {
    throw new Error(`Unknown provider ${provider}`);
  }
  const { root, projectDir, route } = await createProject(provider);
  const taskId = `real-${provider}`;
  const reviewerTasks = runReview ? [{
    review_id: "independent-review",
    role: "reviewer",
    type: "verify",
    complexity: "low",
    target_subtask_ids: ["impl"],
    required_checks: ["Inspect the worktree diff, confirm only provider.txt changed, and confirm node verify.cjs passes."],
    fallback_policy: { enabled: false },
  }] : [];
  await persistPlannerContract(projectDir, taskId, {
    contract_id: `${taskId}-contract`,
    contract_version: 1,
    repository_identity: git(projectDir, "rev-parse", "HEAD"),
    executor_subtasks: [{
      subtask_id: "impl",
      role: "executor",
      objective: `Create provider.txt with exactly two lines: provider=${provider} and initial=true. Do not change any other file.`,
      complexity: "low",
      writable_paths: ["provider.txt"],
      forbidden_paths: [".git/", ".env", ".env.*"],
      required_tests: ["node verify.cjs"],
      acceptance_criteria: ["provider.txt has the required two lines", "node verify.cjs exits 0"],
      fallback_policy: { enabled: false },
    }],
    reviewer_tasks: reviewerTasks,
  }, `e2e-planner-${provider}`);

  const store = new StateStore(path.join(projectDir, ".agent-orchestrator", "state"), {
    jobsRoot: path.join(projectDir, ".agent-orchestrator", "runs"),
    orchestratorRoot: path.join(projectDir, ".agent-orchestrator"),
  });
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  process.stdout.write(`${JSON.stringify({ event: "provider.start", provider, project_dir: projectDir, route })}\n`);
  const started = await orchestrator.startStageWork({ project_dir: projectDir, task_id: taskId, subtask_id: "impl" }, [route]);
  const finished = await waitFor(orchestrator, started.id);
  if (finished.status !== "completed") throw new Error(`${provider} initial work failed: ${finished.error || finished.phase}`);
  const initialSession = await store.getSession(projectDir, provider, taskId);
  const initialContent = await fs.readFile(path.join(initialSession.workspace_path, "provider.txt"), "utf8");
  if (!initialContent.includes(`provider=${provider}`) || !initialContent.includes("initial=true")) {
    throw new Error(`${provider} produced unexpected initial content: ${initialContent}`);
  }

  const continued = await orchestrator.startStageWork({
    project_dir: projectDir,
    task_id: taskId,
    job_id: started.id,
    feedback: "Append a third line containing exactly continued=true to provider.txt. Do not change any other file.",
  }, [], { continuation: true });
  const continuedFinished = await waitFor(orchestrator, continued.id);
  if (continuedFinished.status !== "completed") throw new Error(`${provider} continuation failed: ${continuedFinished.error || continuedFinished.phase}`);
  const continuedSession = await store.getSession(projectDir, provider, taskId);
  if (continuedSession.session_id !== initialSession.session_id || continuedSession.workspace_path !== initialSession.workspace_path) {
    throw new Error(`${provider} continuation changed session or worktree identity`);
  }
  const continuedContent = await fs.readFile(path.join(continuedSession.workspace_path, "provider.txt"), "utf8");
  if (!continuedContent.includes("continued=true")) throw new Error(`${provider} continuation did not update provider.txt`);

  let review = null;
  if (runReview) {
    const reviewJob = await orchestrator.startVerify({
      project_dir: projectDir,
      task_id: taskId,
      review_id: "independent-review",
      model: "Gemini 3.5 Flash (Low)",
    });
    review = await waitFor(orchestrator, reviewJob.id);
    if (review.status !== "completed") throw new Error(`Reviewer gate failed for ${provider}: ${review.error || review.phase}`);
  }

  const result = {
    provider,
    ok: true,
    project_dir: projectDir,
    initial_job_id: started.id,
    continuation_job_id: continued.id,
    session_id: continuedSession.session_id,
    workspace_path: continuedSession.workspace_path,
    review_job_id: review?.id || null,
  };
  process.stdout.write(`${JSON.stringify({ event: "provider.complete", ...result })}\n`);
  if (!keep) process.stdout.write(`${JSON.stringify({ event: "artifact.retained", root, note: "Temporary E2E artifacts are retained for evidence inspection." })}\n`);
  return result;
}

const results = [];
try {
  for (const provider of providers) results.push(await runProvider(provider));
  process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error?.stack || error?.message || String(error), results })}\n`);
  process.exitCode = 1;
}
