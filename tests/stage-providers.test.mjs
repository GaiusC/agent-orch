import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistPlannerContract } from "../scripts/lib/contracts.mjs";
import { WorkerOrchestrator } from "../scripts/lib/orchestrator.mjs";
import { StateStore } from "../scripts/lib/state.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const fakeCodex = path.join(here, "fixtures", "fake-codex-worker.mjs");
const fakeAgy = path.join(here, "fixtures", "fake-agy.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createProject(root) {
  const projectDir = path.join(root, "project");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "README.md"), "fixture\n");
  await fs.writeFile(
    path.join(projectDir, "verify.cjs"),
    "const fs=require('fs'); process.exit(fs.readFileSync('feature.txt','utf8') === 'good' ? 0 : 1);\n",
  );
  git(projectDir, "init");
  git(projectDir, "config", "user.name", "Agent Orch Tests");
  git(projectDir, "config", "user.email", "agent-orch@example.test");
  git(projectDir, "add", ".");
  git(projectDir, "commit", "-m", "fixture");
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    `${JSON.stringify({
      version: 2,
      trusted: true,
      mcp: { enabled: true },
      host: { provider: "codex" },
      cli: {
        codex: process.execPath,
        codex_prefix_args: [fakeCodex],
        agy: process.execPath,
        agy_prefix_args: [fakeAgy],
        agy_env: { AGENT_ORCH_FAKE_AGY_MODE: "review-pass" },
      },
      execution: { codex_worker_timeout_seconds: 20, max_cc_repair_rounds: 0 },
      review_gate: { require_reviewer_for_implementation: false, allow_waiver: true },
      scope: { writable: ["."], forbidden: [".git/", ".env", ".env.*"] },
      verification: { commands: ["node verify.cjs"] },
    }, null, 2)}\n`,
  );
  await persistPlannerContract(projectDir, "feature", {
    contract_id: "feature-contract",
    contract_version: 1,
    repository_identity: "fixture",
    executor_subtasks: [{
      subtask_id: "impl",
      role: "executor",
      objective: "Create feature.txt containing good",
      complexity: "low",
      writable_paths: ["."],
      forbidden_paths: [".git/", ".env", ".env.*"],
      required_tests: ["node verify.cjs"],
      acceptance_criteria: ["verification passes"],
      fallback_policy: { enabled: false },
    }],
    reviewer_tasks: [{
      review_id: "review",
      role: "reviewer",
      type: "verify",
      complexity: "low",
      target_subtask_ids: ["impl"],
      required_checks: ["Inspect diff and run verification"],
      fallback_policy: { enabled: false },
    }],
  }, "planner-session");
  return projectDir;
}

async function waitFor(orchestrator, jobId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const job = await orchestrator.status(jobId);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}

test("Codex Worker stage uses writable non-interactive execution and exact continuation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-stage-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = await createProject(root);
  const store = new StateStore(path.join(projectDir, ".agent-orchestrator", "state"), {
    jobsRoot: path.join(projectDir, ".agent-orchestrator", "runs"),
    orchestratorRoot: path.join(projectDir, ".agent-orchestrator"),
  });
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);
  const route = [{ provider: "codex_worker", model: null, invocation: "cli" }];

  const started = await orchestrator.startStageWork({
    project_dir: projectDir,
    task_id: "feature",
    subtask_id: "impl",
  }, route);
  const finished = await waitFor(orchestrator, started.id);
  assert.equal(finished.status, "completed", finished.error);
  assert.equal(finished.provider, "codex_worker");
  assert.equal(finished.session_id, "11111111-1111-4111-8111-111111111111");
  const firstSession = await store.getSession(projectDir, "codex_worker", "feature");
  assert.ok(firstSession.workspace_path);

  const continued = await orchestrator.startStageWork({
    project_dir: projectDir,
    task_id: "feature",
    job_id: started.id,
    feedback: "Recheck the same file and keep it good.",
  }, [], { continuation: true });
  const continuedFinished = await waitFor(orchestrator, continued.id);
  assert.equal(continuedFinished.status, "completed", continuedFinished.error);
  assert.equal(continuedFinished.provider, "codex_worker");
  assert.equal(continuedFinished.session_id, firstSession.session_id);
  const continuedSession = await store.getSession(projectDir, "codex_worker", "feature");
  assert.equal(continuedSession.workspace_path, firstSession.workspace_path);
});

test("formal AGY review requires current-turn PASS output and preserves patch digest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-stage-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = await createProject(root);
  const store = new StateStore(path.join(projectDir, ".agent-orchestrator", "state"), {
    jobsRoot: path.join(projectDir, ".agent-orchestrator", "runs"),
    orchestratorRoot: path.join(projectDir, ".agent-orchestrator"),
  });
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);
  const started = await orchestrator.startStageWork({
    project_dir: projectDir,
    task_id: "feature",
    subtask_id: "impl",
  }, [{ provider: "codex_worker", model: null, invocation: "cli" }]);
  const finished = await waitFor(orchestrator, started.id);
  assert.equal(finished.status, "completed", finished.error);

  const review = await orchestrator.startVerify({
    project_dir: projectDir,
    task_id: "feature",
    review_id: "review",
    model: "Gemini 3.5 Flash (Low)",
  });
  const reviewed = await waitFor(orchestrator, review.id);
  assert.equal(reviewed.status, "completed", reviewed.error);
  const result = await orchestrator.result(review.id);
  assert.equal(result.evidence.result_source, "stdout");
  assert.match(result.evidence.result, /VERDICT: PASS/);
  assert.equal(result.evidence.review_evidence.implementation_job_id, started.id);
});
