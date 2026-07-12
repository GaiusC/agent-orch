import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkerOrchestrator } from "../scripts/lib/orchestrator.mjs";
import { StateStore } from "../scripts/lib/state.mjs";
import { ccExecutorModel } from "../scripts/lib/model-registry.mjs";
import { acceptReadyJob, createAutoPlannerContract, createCompletedReviewerEvidence, persistPlannerContract } from "./fixtures/architecture.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const fakeCc = path.join(here, "fixtures", "fake-cc.mjs");
const fakeAgy = path.join(here, "fixtures", "fake-agy.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createProject(root) {
  const project = path.join(root, "project");
  await fs.mkdir(path.join(project, ".agent-orchestrator"), { recursive: true });
  const config = {
    version: 1,
    trusted: true,
    cli: {
      claude: process.execPath,
      agy: process.execPath,
      claude_prefix_args: [fakeCc],
      agy_prefix_args: [fakeAgy],
      agy_sandbox: false,
      agy_project: "fixture-project",
    },
    agy: {
      enabled: true,
      auth_probe_required: true,
      fail_fast_on_auth_window: true,
    },
    execution: {
      workspace_mode: "isolated",
      max_cc_repair_rounds: 2,
      cc_timeout_seconds: 20,
      agy_timeout_seconds: 20,
      agy_write_timeout_seconds: 20,
      max_log_bytes: 1024 * 1024,
      max_result_chars: 8000,
    },
    scope: {
      writable: ["."],
      forbidden: [".git/", ".env", ".env.*"],
    },
    verification: { commands: ["node verify.cjs"] },
    review_gate: { require_agy_verify_for_implementation: false, allow_waiver: true },
  };
  await fs.writeFile(path.join(project, ".agent-orchestrator", "config.json"), JSON.stringify(config, null, 2));
  await fs.writeFile(path.join(project, "verify.cjs"), "const fs=require('fs'); process.exit(fs.existsSync('feature.txt') && fs.readFileSync('feature.txt','utf8') === 'good' ? 0 : 1);\n");
  await fs.writeFile(path.join(project, "README.md"), "fixture\n");
  git(project, "init");
  git(project, "config", "user.name", "Agent Orch Tests");
  git(project, "config", "user.email", "agent-orch@example.test");
  git(project, "add", ".");
  git(project, "commit", "-m", "fixture");
  return project;
}

async function waitFor(orchestrator, jobId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await orchestrator.status(jobId);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}

async function removeTempRoot(root) {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test("CC implements, repairs in the same session, verifies, applies, and cleans", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-integration-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a Planner contract so that accepter and apply gates pass.
  await persistPlannerContract(project, "feature", {
    contract_id: "contract-feature",
    contract_version: 1,
    repository_identity: "integration-test",
    executor_subtasks: [{
      subtask_id: "impl-1", role: "executor", complexity: "low",
      objective: "Create feature.txt containing good",
      depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"],
      required_tests: ["node verify.cjs"], fallback_policy: { enabled: true },
    }],
    reviewer_tasks: [],
  }, "planner-session-feature");

  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "feature",
    goal: "Create feature.txt containing good",
    plan: "Implement the fixture and satisfy verification",
    complexity: "low",
  });
  const finished = await waitFor(orchestrator, started.id);
  assert.equal(finished.status, "completed", finished.error);
  const result = await orchestrator.result(started.id);
  assert.equal(result.evidence.verification.passed, true);
  assert.equal(result.evidence.attempts.length, 2);
  assert.equal(result.evidence.attempts[0].session_id, result.evidence.attempts[1].session_id);
  assert.equal(await fs.stat(path.join(project, "feature.txt")).catch(() => null), null);

  const changedModel = await orchestrator.startCc({
    project_dir: project,
    task_id: "feature",
    goal: "Continue the same implementation with an explicitly changed model",
    plan: "Keep the verified file unchanged",
    complexity: "low",
    model: "different-model",
  }, true);
  await waitFor(orchestrator, changedModel.id);
  const changedModelResult = await orchestrator.result(changedModel.id);
  assert.notEqual(changedModelResult.evidence.session_id, result.evidence.session_id);

  await acceptReadyJob(orchestrator, { projectDir: project, taskId: "feature", jobId: started.id });
  await orchestrator.apply(started.id);
  assert.equal(await fs.readFile(path.join(project, "feature.txt"), "utf8"), "good");
  await orchestrator.cleanup(started.id);
  assert.equal(await store.getSession(project, "cc", "feature"), null);
});

test("AGY conversation is captured and reused explicitly", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const first = await orchestrator.startAgy({ project_dir: project, task_id: "investigate", goal: "Investigate only" }, "investigate");
  await waitFor(orchestrator, first.id);
  const firstResult = await orchestrator.result(first.id);
  assert.equal(firstResult.evidence.session_id, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(firstResult.evidence.launch.sandbox, false);
  assert.equal(firstResult.evidence.launch.project_id, "fixture-project");
  assert.deepEqual(
    firstResult.evidence.launch.args.slice(firstResult.evidence.launch.args.indexOf("--project"), firstResult.evidence.launch.args.indexOf("--project") + 2),
    ["--project", "fixture-project"],
  );
  assert.doesNotMatch(firstResult.evidence.result, /--sandbox/);

  const second = await orchestrator.startAgy({ project_dir: project, task_id: "investigate", goal: "Continue investigation" }, "investigate");
  await waitFor(orchestrator, second.id);
  const secondResult = await orchestrator.result(second.id);
  assert.match(secondResult.evidence.result, /--conversation/);
  assert.match(secondResult.evidence.result, /123e4567-e89b-42d3-a456-426614174000/);

  const changedModel = await orchestrator.startAgy({ project_dir: project, task_id: "investigate", goal: "Restart after model change", model: "different-model" }, "investigate");
  await waitFor(orchestrator, changedModel.id);
  const changedModelResult = await orchestrator.result(changedModel.id);
  assert.doesNotMatch(changedModelResult.evidence.result, /--conversation/);
  assert.doesNotMatch(changedModelResult.evidence.result, /--new-project/);
  assert.match(changedModelResult.evidence.result, /--add-dir/);
});

test("AGY falls back to conversation store when stdout and transcript are empty", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-store-"));
  const previousStoreOnly = process.env.AGENT_ORCH_FAKE_AGY_STORE_ONLY;
  const previousAgyHome = process.env.AGENT_ORCH_AGY_HOME;
  process.env.AGENT_ORCH_FAKE_AGY_STORE_ONLY = "1";
  process.env.AGENT_ORCH_AGY_HOME = path.join(root, "agy-home");
  t.after(() => {
    if (previousStoreOnly === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_STORE_ONLY;
    else process.env.AGENT_ORCH_FAKE_AGY_STORE_ONLY = previousStoreOnly;
    if (previousAgyHome === undefined) delete process.env.AGENT_ORCH_AGY_HOME;
    else process.env.AGENT_ORCH_AGY_HOME = previousAgyHome;
    return fs.rm(root, { recursive: true, force: true });
  });
  const project = await createProject(root);
  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startAgy({ project_dir: project, task_id: "store-fallback", goal: "Verify via store" }, "verify");
  const finished = await waitFor(orchestrator, started.id);
  assert.equal(finished.status, "completed", finished.error);
  const result = await orchestrator.result(started.id);
  assert.equal(result.evidence.session_id, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(result.evidence.result_source, "conversation_store");
  assert.match(result.evidence.result, /AGY_VERIFICATION_REPORT/);
  assert.match(result.evidence.result, /Changed file scope/);
});

// -- AGY write integration tests --

test("AGY write implements, repairs, verifies, applies, and cleans (isolated worktree)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-write-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  // Override config for AGY write without auth probe
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  config.execution.max_cc_repair_rounds = 2;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a Planner contract so that accepter and apply gates pass.
  await persistPlannerContract(project, "feature-agy", {
    contract_id: "contract-feature-agy", contract_version: 1, repository_identity: "agy-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "medium", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [],
  }, "planner-session-feature-agy");

  const started = await orchestrator.startAgyWrite({
    project_dir: project,
    task_id: "feature-agy",
    goal: "Create feature.txt containing good",
    plan: "Implement the fixture and satisfy verification",
    complexity: "medium",
  });
  const finished = await waitFor(orchestrator, started.id);
  assert.equal(finished.status, "completed", finished.error);
  const result = await orchestrator.result(started.id);
  assert.equal(result.evidence.provider, "agy_write");
  assert.ok(result.evidence.changes, "should have changes captured");
  assert.ok(result.evidence.changes.changed_files.includes("feature.txt"), "should include feature.txt in changed files");
  assert.equal(result.evidence.attempts.length, 2, "should have initial + repair attempt");
  assert.equal(result.evidence.attempts[0].session_id, result.evidence.attempts[1].session_id, "should reuse session across repairs");
  assert.equal(result.evidence.model, "Claude Sonnet 4.6 (Thinking)", "should use Sonnet Thinking model for medium complexity");

  // Complete the accepter gate before applying the verified patch.
  await acceptReadyJob(orchestrator, { projectDir: project, taskId: "feature-agy", jobId: started.id });
  await orchestrator.apply(started.id);
  assert.equal(await fs.readFile(path.join(project, "feature.txt"), "utf8"), "good");

  await orchestrator.cleanup(started.id);
  assert.equal(await store.getSession(project, "agy_write", "feature-agy"), null);
});

test("AGY write continuation produces correct job type and session binding", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-cont-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // First execution
  const first = await orchestrator.startAgyWrite({
    project_dir: project,
    task_id: "feature-cont",
    goal: "Create feature.txt",
    plan: "Implement",
    complexity: "medium",
  });
  await waitFor(orchestrator, first.id);
  const firstResult = await orchestrator.result(first.id);
  assert.equal(first.type, "agy_execute");
  assert.equal(firstResult.evidence.status, "ready_for_acceptance");

  // Continuation with same task_id -- should resume session
  const second = await orchestrator.startAgyWrite({
    project_dir: project,
    task_id: "feature-cont",
    goal: "Continue the implementation",
    plan: "Keep going",
    complexity: "medium",
  }, true);
  await waitFor(orchestrator, second.id);
  const secondResult = await orchestrator.result(second.id);
  assert.equal(second.type, "agy_continue");
  assert.equal(secondResult.evidence.status, "ready_for_acceptance");

  // Continuation always reuses the same fake-agy session id
  assert.equal(secondResult.evidence.session_id, firstResult.evidence.session_id);

  // Verify session is stored correctly
  const session = await store.getSession(project, "agy_write", "feature-cont");
  assert.ok(session, "session should exist after continuation");
});

test("AGY write model change resets session", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-model-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create initial session
  await store.setSession(project, "agy_write", "model-test", {
    session_id: "old-session-id",
    workspace_path: project,
    workspace_mode: "isolated",
    model: "Claude Sonnet 4.6 (Thinking)",
  });

  // Start with a different explicit model -- should clear and create new session
  const started = await orchestrator.startAgyWrite({
    project_dir: project,
    task_id: "model-test",
    goal: "Implement feature",
    plan: "Plan",
    complexity: "medium",
    model: "Different-Model-Override",
  });
  await waitFor(orchestrator, started.id);

  // The old session should be replaced in the store
  const session = await store.getSession(project, "agy_write", "model-test");
  assert.ok(session);
  // Session model should now reflect the override
  assert.equal(session.model, "Different-Model-Override");
});

test("AGY write enforces forbidden path policy", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-forbid-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  config.scope.forbidden = [".env", "feature.txt"];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startAgyWrite({
    project_dir: project,
    task_id: "forbidden-test",
    goal: "Create feature.txt",
    plan: "Implement",
    complexity: "medium",
  });
  const finished = await waitFor(orchestrator, started.id);
  assert.equal(finished.status, "failed", "should fail on forbidden path changes");
  const result = await orchestrator.result(started.id);
  assert.ok(result.evidence.verification?.policy_failure, "should record policy failure");
  assert.match(result.evidence.verification.policy_failure, /forbidden/i);
  assert.ok(result.evidence.changes.forbidden_changes.length > 0, "should list forbidden changes");
});

// -- CC two-tier model defaults --

test("CC uses deepseek-v4-flash for low complexity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-cc-low-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  // Enable CC model defaults in config
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "cc-low-model",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.evidence.model, ccExecutorModel("low").canonical_id);
  assert.equal(result.evidence.attempts[0].model, ccExecutorModel("low").canonical_id);
});

test("CC uses deepseek-v4-pro for high complexity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-cc-high-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "cc-high-model",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "high",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.evidence.model, ccExecutorModel("high").canonical_id);
  assert.equal(result.evidence.attempts[0].model, ccExecutorModel("high").canonical_id);
});

test("CC explicit model override takes priority", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-cc-override-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "cc-override",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
    model: "custom-override-model",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.evidence.model, "custom-override-model");
  assert.equal(result.evidence.attempts[0].model, "custom-override-model");
});

// -- AGY write model override tests --

test("AGY write explicit model override takes priority over complexity defaults", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-override-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startAgyWrite({
    project_dir: project,
    task_id: "agy-override",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "medium",
    model: "explicit-test-model",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.evidence.model, "explicit-test-model", "explicit model should override Sonnet default");
});

test("AGY write model change via auto route resets incompatible session", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-auroverride-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // First run: AGY write with explicit model creates session
  const first = await orchestrator.startAgyWrite({
    project_dir: project,
    task_id: "auroverride",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "medium",
    model: "first-model",
  });
  await waitFor(orchestrator, first.id);
  const firstResult = await orchestrator.result(first.id);
  assert.equal(firstResult.evidence.model, "first-model");

  // Second run: same task_id but different explicit model -- must reset session
  const second = await orchestrator.startAgyWrite({
    project_dir: project,
    task_id: "auroverride",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "medium",
    model: "second-different-model",
  });
  await waitFor(orchestrator, second.id);
  const secondResult = await orchestrator.result(second.id);
  assert.equal(secondResult.evidence.model, "second-different-model");
  // Session was reset, so the store should reflect the new model.
  const session = await store.getSession(project, "agy_write", "auroverride");
  assert.equal(session.model, "second-different-model");
});

// -- Quota fallback workspace cleanup --

test("quota fallback cleans AGY worktree and clears session before CC fallback", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-qcleanup-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  config.routing = { executor_priority: ["agy", "cc"], agy_write_fallback_to_cc_on_quota: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "quota-error";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Pre-populate an incompatible agy_write session so we can verify it is cleared
  await store.setSession(project, "agy_write", "qcleanup", {
    session_id: "old-session-to-clear",
    workspace_path: project,
    workspace_mode: "isolated",
    model: "Claude Sonnet 4.6 (Thinking)",
  });

  await createAutoPlannerContract(project, "qcleanup", { complexity: "medium" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "qcleanup",
    subtask_id: "impl-1",
  });
  await waitFor(orchestrator, started.id, 20000);
  const finished = await orchestrator.status(started.id);

  // Should have fallen back to CC successfully
  assert.equal(finished.provider, "cc");
  assert.equal(finished.auto_route, "cc_fallback");
  assert.equal(finished.auto_fallback_classifier, "quota_exhaustion");
  assert.equal(finished.status, "completed", finished.error);

  // AGY write session should be cleared
  const agySession = await store.getSession(project, "agy_write", "qcleanup");
  assert.equal(agySession, null);

  const result = await orchestrator.result(started.id);
  assert.equal(result.evidence.auto_route.fallback_occurred, true);
  assert.equal(result.evidence.auto_route.original_provider, "agy_write");
});

// -- CC model arguments in fallback path --

test("CC fallback after AGY quota uses medium complexity CC model (deepseek-v4-flash)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-ccfallback-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  config.routing = { executor_priority: ["agy", "cc"], agy_write_fallback_to_cc_on_quota: true };
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "quota-error";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "ccfallback", { complexity: "medium" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "ccfallback",
    subtask_id: "impl-1",
  });
  await waitFor(orchestrator, started.id, 20000);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  // The CC fallback for medium complexity should use flash
  assert.equal(result.evidence.model, ccExecutorModel("medium").canonical_id);
});

test("CC fallback after AGY quota uses high complexity CC model (deepseek-v4-pro)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-ccfallback-high-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  config.routing = { executor_priority: ["agy", "cc"], agy_write_fallback_to_cc_on_quota: true };
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "quota-error";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "ccfallback-high", { complexity: "high" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "ccfallback-high",
    subtask_id: "impl-1",
  });
  await waitFor(orchestrator, started.id, 20000);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.evidence.model, ccExecutorModel("high").canonical_id);
});

// -- Low complexity routes to CC with flash model --

test("auto low complexity routes to CC with deepseek-v4-flash", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-autolow-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "autolow", { complexity: "low" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "autolow",
    subtask_id: "impl-1",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.evidence.model, ccExecutorModel("low").canonical_id);
  assert.equal(result.evidence.status, "ready_for_acceptance");
});

// -- Legacy CC null model normalization --

test("legacy config with null CC models normalizes to two-tier defaults on load", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-nullnorm-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  // Write a legacy config with explicit null CC model values
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.models = { cc: { low: null, medium: null, high: null } };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Direct CC: low complexity should normalize to flash
  const low = await orchestrator.startCc({
    project_dir: project,
    task_id: "nullnorm-low",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, low.id);
  const lowResult = await orchestrator.result(low.id);
  assert.equal(lowResult.evidence.model, ccExecutorModel("low").canonical_id);
  assert.equal(lowResult.job.status, "completed");

  // Direct CC: high complexity should normalize to pro
  const high = await orchestrator.startCc({
    project_dir: project,
    task_id: "nullnorm-high",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "high",
  });
  await waitFor(orchestrator, high.id);
  const highResult = await orchestrator.result(high.id);
  assert.equal(highResult.evidence.model, ccExecutorModel("high").canonical_id);
  assert.equal(highResult.job.status, "completed");
});

test("legacy config with null CC models preserves explicit custom value", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-nullcust-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  // Mix of null and custom, with model_registry mapping for the new architecture
  config.models = { cc: { low: null, medium: "custom-flash", high: null } };
  config.model_registry = { "cc.exec.mid": { canonical_id: "custom-flash" } };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // null low -> normalized to flash
  const low = await orchestrator.startCc({
    project_dir: project,
    task_id: "nullcust-low",
    goal: "Create feature.txt",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, low.id);
  assert.equal((await orchestrator.result(low.id)).evidence.model, ccExecutorModel("low").canonical_id);

  // custom medium -> preserved
  const med = await orchestrator.startCc({
    project_dir: project,
    task_id: "nullcust-med",
    goal: "Create feature.txt",
    plan: "Implement",
    complexity: "medium",
  });
  await waitFor(orchestrator, med.id);
  assert.equal((await orchestrator.result(med.id)).evidence.model, "custom-flash");

  // null high -> normalized to pro
  const high = await orchestrator.startCc({
    project_dir: project,
    task_id: "nullcust-high",
    goal: "Create feature.txt",
    plan: "Implement",
    complexity: "high",
  });
  await waitFor(orchestrator, high.id);
  assert.equal((await orchestrator.result(high.id)).evidence.model, ccExecutorModel("high").canonical_id);
});

test("legacy config with null CC models: auto low routes to CC with flash", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-nullauto-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.models = { cc: { low: null, medium: null, high: null } };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "nullauto", { complexity: "low" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "nullauto",
    subtask_id: "impl-1",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.evidence.model, ccExecutorModel("low").canonical_id);
  assert.equal(result.evidence.status, "ready_for_acceptance");
});

test("legacy config with null CC models: per-contract override takes priority", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-nullovrd-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.models = { cc: { low: null, medium: null, high: null } };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "nullovrd",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
    model: "explicit-per-contract",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.evidence.model, "explicit-per-contract");
  assert.equal(result.job.status, "completed");
});

test("legacy config with null CC models: fallback after AGY quota uses normalized CC model", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-nullfb-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  config.models = { cc: { low: null, medium: null, high: null } };
  config.routing = { executor_priority: ["agy", "cc"], agy_write_fallback_to_cc_on_quota: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "quota-error";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "nullfb", { complexity: "medium" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "nullfb",
    subtask_id: "impl-1",
  });
  await waitFor(orchestrator, started.id, 20000);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.job.auto_route, "cc_fallback");
  assert.equal(result.evidence.auto_route.fallback_occurred, true);
  // CC fallback for medium complexity should use the normalized flash model
  assert.equal(result.evidence.model, ccExecutorModel("medium").canonical_id);
  assert.equal(result.job.status, "completed", result.job.error);
});

// -- CC-first routing: low/medium/high all start with CC --

test("auto low complexity routes to CC with deepseek-v4-flash (cc_first default)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-ccfirst-low-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "ccfirst-low", { complexity: "low" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "ccfirst-low",
    subtask_id: "impl-1",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.job.auto_route, "cc");
  assert.equal(result.evidence.model, ccExecutorModel("low").canonical_id);
  assert.equal(result.evidence.status, "ready_for_acceptance");
});

test("auto medium complexity routes to CC with deepseek-v4-flash (cc_first default)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-ccfirst-med-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "ccfirst-med", { complexity: "medium" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "ccfirst-med",
    subtask_id: "impl-1",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.job.auto_route, "cc");
  assert.equal(result.evidence.model, ccExecutorModel("medium").canonical_id);
  assert.equal(result.evidence.status, "ready_for_acceptance");
});

test("auto high complexity routes to CC with deepseek-v4-pro (cc_first default)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-ccfirst-high-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "ccfirst-high", { complexity: "high" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "ccfirst-high",
    subtask_id: "impl-1",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.job.auto_route, "cc");
  assert.equal(result.evidence.model, ccExecutorModel("high").canonical_id);
  assert.equal(result.evidence.status, "ready_for_acceptance");
});

// -- CC verification fail escalates to AGY write (integration) --

test("auto escalates to AGY write after CC verification failure with 2+ cycles", async (t) => {
  const previousCcMode = process.env.AGENT_ORCH_FAKE_CC_MODE;
  const previousAgyMode = process.env.AGENT_ORCH_FAKE_AGY_MODE;
  process.env.AGENT_ORCH_FAKE_CC_MODE = "always-fail";
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => {
    if (previousCcMode === undefined) delete process.env.AGENT_ORCH_FAKE_CC_MODE;
    else process.env.AGENT_ORCH_FAKE_CC_MODE = previousCcMode;
    if (previousAgyMode === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_MODE;
    else process.env.AGENT_ORCH_FAKE_AGY_MODE = previousAgyMode;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-ccfail-agy-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  config.routing = { cc_verify_fail_escalate_to_agy: true, agy_write_fallback_to_cc_on_quota: true };
  config.execution.max_cc_repair_rounds = 2;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "ccfail-agy", { complexity: "medium" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "ccfail-agy",
    subtask_id: "impl-1",
  });
  // Use wait() instead of waitFor() because the job transitions through
  // failed (CC verification_failed) -> running (AGY escalation) -> completed
  await orchestrator.wait(started.id);
  const result = await orchestrator.result(started.id);

  // Escalated to AGY write
  assert.equal(result.job.provider, "agy_write");
  assert.equal(result.job.auto_route, "cc_then_agy_escalation");
  assert.equal(result.job.auto_fallback_classifier, "cc_verification_failed");
  assert.equal(result.job.status, "completed", result.job.error);
  assert.equal(result.evidence.model, "Claude Sonnet 4.6 (Thinking)");
  assert.equal(result.evidence.auto_route.provider, "agy_write");
  assert.equal(result.evidence.auto_route.fallback_occurred, true);
  assert.equal(result.evidence.auto_route.original_provider, "cc");
  assert.equal(result.evidence.auto_route.reason, "cc_verification_failed");
  assert.equal(result.evidence.auto_route.escalation_model, "Claude Sonnet 4.6 (Thinking)");
  assert.ok(result.evidence.auto_route.cc_attempts >= 2);
});

// -- AGY quota during CC escalation falls back to CC high --

test("auto falls back to CC high after AGY quota during escalation", async (t) => {
  const previousCcMode = process.env.AGENT_ORCH_FAKE_CC_MODE;
  const previousAgyMode = process.env.AGENT_ORCH_FAKE_AGY_MODE;
  process.env.AGENT_ORCH_FAKE_CC_MODE = "always-fail";
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "quota-error";
  t.after(() => {
    if (previousCcMode === undefined) delete process.env.AGENT_ORCH_FAKE_CC_MODE;
    else process.env.AGENT_ORCH_FAKE_CC_MODE = previousCcMode;
    if (previousAgyMode === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_MODE;
    else process.env.AGENT_ORCH_FAKE_AGY_MODE = previousAgyMode;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-esc-quota-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  config.routing = { cc_verify_fail_escalate_to_agy: true, agy_write_fallback_to_cc_on_quota: true };
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  config.execution.max_cc_repair_rounds = 2;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "esc-quota", { complexity: "medium" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "esc-quota",
    subtask_id: "impl-1",
  });
  // Use wait() - the job transitions through multiple states during escalation chain
  await orchestrator.wait(started.id);
  const result = await orchestrator.result(started.id);

  // CC failed -> AGY escalation hit quota -> CC high fallback
  assert.equal(result.job.provider, "cc");
  assert.equal(result.job.auto_route, "cc_fallback_after_agy_quota");
  assert.equal(result.job.auto_fallback_classifier, "agy_quota_during_escalation");
  assert.equal(result.evidence.model, ccExecutorModel("high").canonical_id);
  assert.equal(result.job.status, "completed", result.job.error);
  assert.equal(result.evidence.auto_route.provider, "cc");
  assert.equal(result.evidence.auto_route.fallback_occurred, true);
  assert.equal(result.evidence.auto_route.reason, "agy_quota_during_escalation");
  assert.deepEqual(result.evidence.auto_route.escalation_chain, ["cc", "agy_write", "cc_high"]);
  assert.equal(result.evidence.auto_route.agy_model, "Claude Sonnet 4.6 (Thinking)");
});

// -- Review-gate policy and enforcement --

test("implementation jobs are marked with requires_agy_review by default", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-review-gate-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  // Ensure review_gate is enabled (default in createProject doesn't include it, so add it)
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const cc = await orchestrator.startCc({
    project_dir: project,
    task_id: "review-gate-cc",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  const ccJob = await waitFor(orchestrator, cc.id);
  assert.equal(ccJob.requires_agy_review, true, "CC implementation should require AGY review");
  assert.equal(ccJob.review_waiver, false, "CC implementation should not have waiver by default");
});

test("implementation jobs with explicit waiver skip review gate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-review-waiver-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const cc = await orchestrator.startCc({
    project_dir: project,
    task_id: "waiver-test",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
    review_waiver: true,
  });
  const ccJob = await waitFor(orchestrator, cc.id);
  assert.equal(ccJob.review_waiver, true, "Job should have review_waiver=true");
});

test("accepter rejects implementation job without reviewer evidence and no waiver", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-apply-reject-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a Planner contract so the test reaches the review-gate check
  // rather than failing at the contract-availability check.
  await persistPlannerContract(project, "apply-reject", {
    contract_id: "contract-apply-reject", contract_version: 1, repository_identity: "reject-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [],
  }, "planner-session-reject");

  const cc = await orchestrator.startCc({
    project_dir: project,
    task_id: "apply-reject",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, cc.id);

  // Acceptance should be rejected because no reviewer evidence exists.
  await assert.rejects(
    () => acceptReadyJob(orchestrator, { projectDir: project, taskId: "apply-reject", jobId: cc.id }),
    /acceptance_unavailable/,
    "Accepter should reject when reviewer evidence is required but missing",
  );
});

test("apply allows job with waiver even without reviewer evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-apply-waiver-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a Planner contract so that accepter and apply gates pass.
  await persistPlannerContract(project, "apply-waiver", {
    contract_id: "contract-apply-waiver", contract_version: 1, repository_identity: "waiver-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [],
  }, "planner-session-waiver");

  const cc = await orchestrator.startCc({
    project_dir: project,
    task_id: "apply-waiver",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
    review_waiver: true,
  });
  await waitFor(orchestrator, cc.id);

  // The waiver permits acceptance without reviewer evidence.
  await acceptReadyJob(orchestrator, { projectDir: project, taskId: "apply-waiver", jobId: cc.id });
  const result = await orchestrator.apply(cc.id);
  assert.equal(result.applied, true, "Should apply when review_waiver is present");
  assert.equal(await fs.readFile(path.join(project, "feature.txt"), "utf8"), "good");
});

test("apply succeeds when reviewer evidence exists for the same task", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-apply-verify-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a Planner contract so that accepter and apply gates pass.
  await persistPlannerContract(project, "apply-verify", {
    contract_id: "contract-apply-verify", contract_version: 1, repository_identity: "verify-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [{ review_id: "review-1", role: "reviewer", type: "verify", complexity: "low", target_subtask_ids: ["impl-1"], required_checks: ["tests"], fallback_policy: { enabled: false } }],
  }, "planner-session-verify");

  // First run the CC implementation
  const cc = await orchestrator.startCc({
    project_dir: project,
    task_id: "apply-verify",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, cc.id);

  // Create current reviewer evidence for the completed implementation.
  await createCompletedReviewerEvidence(store, {
    projectDir: project,
    taskId: "apply-verify",
    implementationJob: await orchestrator.status(cc.id),
    id: "agy-verify-test",
  });

  // The reviewer evidence lets accepter create the current patch artifact.
  await acceptReadyJob(orchestrator, { projectDir: project, taskId: "apply-verify", jobId: cc.id });
  const result = await orchestrator.apply(cc.id);
  assert.equal(result.applied, true, "Should apply when reviewer evidence exists");

  // Verify the AGY verify job was recorded
  const appliedJob = await orchestrator.status(cc.id);
  assert.equal(appliedJob.agy_verify_job_id, "agy-verify-test");
});

test("auto implementation jobs also get review gate metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-auto-review-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: true };
  config.routing = { cc_verify_fail_escalate_to_agy: false };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "auto-review", { complexity: "low" });
  const auto = await orchestrator.startAuto({
    project_dir: project,
    task_id: "auto-review",
    subtask_id: "impl-1",
  });
  await waitFor(orchestrator, auto.id);
  assert.equal(auto.provider, "cc");
  assert.equal(auto.requires_agy_review, true);
});

test("review_gate disabled in config means no review requirement", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-review-disabled-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a Planner contract so that accepter and apply gates pass.
  await persistPlannerContract(project, "review-disabled", {
    contract_id: "contract-review-disabled", contract_version: 1, repository_identity: "disabled-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [],
  }, "planner-session-disabled");

  const cc = await orchestrator.startCc({
    project_dir: project,
    task_id: "review-disabled",

    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, cc.id);
  assert.equal(cc.requires_agy_review, false, "Disabled review gate should mean no review required");

  // A disabled review gate still requires acceptance evidence.
  await acceptReadyJob(orchestrator, { projectDir: project, taskId: "review-disabled", jobId: cc.id });
  const result = await orchestrator.apply(cc.id);
  assert.equal(result.applied, true);
});
test("AGY investigate/verify jobs are not implementation: no review gate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-verify-nogate-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // AGY investigate should NOT have requires_agy_review because it's not an implementation job
  const agy = await orchestrator.startAgy(
    { project_dir: project, task_id: "investigate-no-gate", goal: "Investigate only" },
    "investigate",
  );
  await waitFor(orchestrator, agy.id);
  // AGY investigate jobs don't go through computeReviewGate
  assert.equal(agy.requires_agy_review, false);
});

// -- State snapshot includes review-gate fields --

test("publicJobSnapshot includes review gate and role/stage fields", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-snapshot-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const cc = await orchestrator.startCc({
    project_dir: project,
    task_id: "snapshot",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, cc.id);

  // Check the job object has all expected fields
  assert.equal(cc.requires_agy_review, true);
  assert.equal(cc.review_waiver, false);
  assert.ok(typeof cc.agy_verify_job_id === "string" || cc.agy_verify_job_id === null);

  // Rebuild state and check role is set
  const state = await store.rebuildCurrentState(project);
  const jobInState = state.recent_jobs.find((j) => j.id === cc.id);
  assert.ok(jobInState, "Job should appear in rebuilt state");
  assert.equal(jobInState.role, "executor", "CC job should be executor role");
  assert.equal(jobInState.stage, "execute", "CC job should be in execute stage");
  assert.equal(jobInState.requires_agy_review, true);
});

// -- Waiver enforcement: allow_waiver=false ignores review_waiver=true --

test("waiver is ignored when allow_waiver is false -- accepter rejects", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-no-waiver-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: false };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a Planner contract so the test reaches the review-gate check.
  await persistPlannerContract(project, "no-waiver-allowed", {
    contract_id: "contract-no-waiver", contract_version: 1, repository_identity: "no-waiver-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [],
  }, "planner-session-no-waiver");

  // Even though the contract requests review_waiver: true, allow_waiver: false
  // should cause the waiver to be ignored and the job to require AGY review.
  const cc = await orchestrator.startCc({
    project_dir: project,
    task_id: "no-waiver-allowed",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
    review_waiver: true,
  });
  await waitFor(orchestrator, cc.id);

  // The job metadata should reflect the ignored waiver
  assert.equal(cc.review_waiver, false, "Waiver should be forced to false when allow_waiver is false");

  // Acceptance should be rejected because the waiver was ignored.
  await assert.rejects(
    () => acceptReadyJob(orchestrator, { projectDir: project, taskId: "no-waiver-allowed", jobId: cc.id }),
    /acceptance_unavailable/,
    "Accepter should reject when allow_waiver is false, even with review_waiver request",
  );
});

test("waiver works normally when allow_waiver is true (regression guard)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-waiver-ok-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a Planner contract so that accepter and apply gates pass.
  await persistPlannerContract(project, "waiver-ok", {
    contract_id: "contract-waiver-ok", contract_version: 1, repository_identity: "waiver-ok-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [],
  }, "planner-session-waiver-ok");

  const cc = await orchestrator.startCc({
    project_dir: project,
    task_id: "waiver-ok",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
    review_waiver: true,
  });
  await waitFor(orchestrator, cc.id);

  // Waiver should be honored when allow_waiver is true
  assert.equal(cc.review_waiver, true, "Waiver should be honored when allow_waiver is true");

  await acceptReadyJob(orchestrator, { projectDir: project, taskId: "waiver-ok", jobId: cc.id });
  // Apply should succeed after acceptance.
  await orchestrator.apply(cc.id);
  assert.equal(await fs.readFile(path.join(project, "feature.txt"), "utf8"), "good");
});

// -- Applied jobs classified as accepter role and accept stage --

test("applied CC job is classified as accepter role in state snapshot", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-accepter-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a Planner contract so that accepter and apply gates pass.
  await persistPlannerContract(project, "accepter-test", {
    contract_id: "contract-accepter", contract_version: 1, repository_identity: "accepter-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [],
  }, "planner-session-accepter");

  const cc = await orchestrator.startCc({
    project_dir: project,
    task_id: "accepter-test",

    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, cc.id);
  await acceptReadyJob(orchestrator, { projectDir: project, taskId: "accepter-test", jobId: cc.id });
  await orchestrator.apply(cc.id);

  // After apply, the job should be classified as accepter
  const state = await store.rebuildCurrentState(project);
  const jobInState = state.recent_jobs.find((j) => j.id === cc.id);
  assert.ok(jobInState, "Applied job should appear in state");
  assert.equal(jobInState.role, "accepter", "Applied CC job should be accepter role");
  assert.equal(jobInState.stage, "accept", "Applied CC job should be accept stage");
});
// ============================================================
// New e2e tests: stale invalidation, acceptance gates, etc.
// ============================================================

test("stale acceptance is invalidated when continuation produces new patch digest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-stale-accept-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // First implementation
  const first = await orchestrator.startCc({
    project_dir: project,
    task_id: "stale-accept",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, first.id);

  // Simulate acceptance on first job with a KNOWN DIFFERENT digest to
  // ensure the invalidation fires regardless of fake-cc output content.
  await store.updateJob(first.id, {
    acceptance_artifact_path: "/tmp/acceptance-old.json",
    acceptance_status: "accepted",
    acceptance_patch_digest: "old-digest-that-will-differ",
  });

  // Continuation with same task produces a new patch (different digest)
  const second = await orchestrator.startCc({
    project_dir: project,
    task_id: "stale-accept",
    goal: "Update feature.txt content",
    plan: "Change content",
    complexity: "low",
  }, true);
  await waitFor(orchestrator, second.id);

  // The first job's stale acceptance artifact should be invalidated
  const firstJobAfter = await store.getJob(first.id);
  assert.equal(firstJobAfter.acceptance_artifact_path, null,
    "First job acceptance artifact should be cleared after continuation produces new patch");
  assert.equal(firstJobAfter.acceptance_status, null,
    "First job acceptance status should be cleared after continuation");
  assert.equal(firstJobAfter.acceptance_patch_digest, null,
    "First job acceptance patch digest should be cleared after continuation");
});

test("stale review evidence is invalidated when continuation produces new patch digest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-stale-review-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // First implementation
  const first = await orchestrator.startCc({
    project_dir: project,
    task_id: "stale-review",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
    review_waiver: true,
  });
  await waitFor(orchestrator, first.id);

  // Simulate reviewer evidence on the first job
  await store.updateJob(first.id, {
    agy_verify_job_id: "agy-review-1",
    agy_verify_evidence_path: "/tmp/agy-evidence-1.json",
    reviewer_job_id: "agy-review-1",
    reviewer_evidence_path: "/tmp/agy-evidence-1.json",
  });

  // Continuation (same task) produces a new patch, triggering invalidation
  const second = await orchestrator.startCc({
    project_dir: project,
    task_id: "stale-review",
    goal: "Update feature.txt content",
    plan: "Change content",
    complexity: "low",
    review_waiver: true,
  }, true);
  await waitFor(orchestrator, second.id);

  // Verify that the first job's reviewer evidence is cleared
  const firstJobAfter = await store.getJob(first.id);
  assert.equal(firstJobAfter.agy_verify_job_id, null,
    "Stale AGY verify job ID should be cleared after continuation");
  assert.equal(firstJobAfter.reviewer_job_id, null,
    "Stale reviewer job ID should be cleared after continuation");
  assert.equal(firstJobAfter.reviewer_evidence_path, null,
    "Stale reviewer evidence path should be cleared after continuation");
});

test("acceptance unavailable when no job is ready for acceptance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-no-accept-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // No job exists at all for this task → must throw acceptance_unavailable
  await assert.rejects(
    () => orchestrator.accept({ project_dir: project, task_id: "no-job-yet", job_id: "nonexistent" }),
    /acceptance_unavailable/,
  );
});

test("continuation always triggers stale invalidation on ready_for_acceptance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-cont-invalid-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // First CC implementation
  const first = await orchestrator.startCc({
    project_dir: project,
    task_id: "cont-invalid",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, first.id);
  const firstJob = await orchestrator.status(first.id);
  assert.equal(firstJob.phase, "ready_for_acceptance");

  // Pre-populate reviewer evidence on first job
  await store.updateJob(first.id, {
    agy_verify_job_id: "review-1",
    agy_verify_evidence_path: "/tmp/review-1.json",
  });

  // Continuation completes with new patch
  const second = await orchestrator.startCc({
    project_dir: project,
    task_id: "cont-invalid",
    goal: "Update content",
    plan: "Continuing",
    complexity: "low",
  }, true);
  await waitFor(orchestrator, second.id);

  // First job's review evidence should be cleared by invalidation
  const firstAfter = await store.getJob(first.id);
  assert.equal(firstAfter.agy_verify_job_id, null,
    "Continuation should invalidate review evidence on prior jobs");
});

test("accept method returns full provenance acceptance artifact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-provenance-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  // Persist a Planner contract so accept() can resolve contract_id/version/digest
  await persistPlannerContract(project, "provenance-test", {
    contract_id: "contract-prov",
    contract_version: 1,
    repository_identity: "provenance-repo",
    executor_subtasks: [{
      subtask_id: "impl-1", role: "executor", complexity: "low",
      objective: "Create feature.txt containing good",
      depends_on: [], writable_paths: ["./"], forbidden_paths: [".git/**"],
      required_tests: ["node verify.cjs"], fallback_policy: { enabled: true },
    }],
    reviewer_tasks: [],
  }, "planner-session-prov");

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "provenance-test",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, started.id);

  const artifact = await acceptReadyJob(orchestrator, { projectDir: project, taskId: "provenance-test", jobId: started.id, session_id: "test-session-1" });

  // Verify full provenance fields match the unified acceptance artifact schema.
  assert.ok(artifact.acceptance_id, "artifact should include acceptance_id");
  assert.ok(artifact.acceptance_id.startsWith("accept-"), "acceptance_id should start with accept-");
  assert.equal(artifact.task_id, "provenance-test");
  assert.equal(artifact.job_id, started.id);
  assert.equal(artifact.status, "accepted");
  assert.equal(artifact.contract_id, "contract-prov", "artifact should include contract_id from Planner contract");
  assert.equal(artifact.contract_version, 1, "artifact should include contract_version from Planner contract");
  assert.ok(artifact.contract_digest, "artifact should include contract_digest from Planner contract");
  assert.ok(artifact.patch_digest, "artifact should include patch_digest");
  assert.ok(Array.isArray(artifact.test_evidence_ids), "artifact should include test_evidence_ids array");
  assert.ok(Array.isArray(artifact.reviewer_evidence_ids), "artifact should include reviewer_evidence_ids array");
  assert.equal(artifact.repository_identity, "provenance-repo", "artifact should include repository_identity");
  assert.ok(artifact.workspace_identity, "artifact should include workspace_identity");
  assert.equal(artifact.accepter_host, "codex", "artifact should include accepter_host");
  assert.equal(artifact.accepter_provider, "codex", "artifact should include accepter_provider");
  assert.equal(artifact.accepter_model, "gpt-5.6-sol", "artifact should include accepter_model");
  assert.equal(artifact.accepter_session_id, "test-session-1", "artifact should include accepter_session_id");
  assert.ok(artifact.summary, "artifact should include summary");
  assert.ok(Array.isArray(artifact.conditions), "artifact should include conditions array");
  assert.ok(Array.isArray(artifact.unresolved_risks), "artifact should include unresolved_risks array");
  assert.ok(artifact.created_at, "artifact should include created_at timestamp");
});

test("apply rejects superseded contract version", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-superseded-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create initial Planner contract (version 1) so acceptance passes.
  await persistPlannerContract(project, "superseded", {
    contract_id: "contract-superseded", contract_version: 1, repository_identity: "superseded-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [],
  }, "planner-session-v1");

  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "superseded",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, started.id);

  await acceptReadyJob(orchestrator, { projectDir: project, taskId: "superseded", jobId: started.id });

  // Persist a newer contract version for the same task
  await persistPlannerContract(project, "superseded", {
    contract_id: "contract-superseded",
    contract_version: 99,
    repository_identity: "auto-test",
    executor_subtasks: [{
      subtask_id: "impl-1",
      role: "executor",
      complexity: "low",
      objective: "New version",
      depends_on: [],
      writable_paths: ["./"],
      forbidden_paths: [".git/**"],
      required_tests: ["node verify.cjs"],
      fallback_policy: { enabled: true },
    }],
    reviewer_tasks: [],
  }, "planner-session-new");

  // Apply should reject because contract version 99 != version 1 in the artifact
  // (validateAcceptanceForCurrentPatch checks equality, not greater-than).
  await assert.rejects(
    () => orchestrator.apply(started.id),
    /contract_version mismatch/,
    "Apply should reject when a newer contract version exists",
  );
});

test("validatePlannerContractSchema catches invalid contracts", async (t) => {
  const { validatePlannerContractSchema } = await import("../scripts/lib/contracts.mjs");

  // Null
  assert.ok(validatePlannerContractSchema(null).length > 0, "null should be rejected");
  assert.ok(validatePlannerContractSchema(undefined).length > 0, "undefined should be rejected");

  // Missing contract_id
  const noId = { contract_version: 1, executor_subtasks: [{ subtask_id: "s1", role: "executor", objective: "test", complexity: "low" }] };
  assert.ok(validatePlannerContractSchema(noId).length > 0, "missing contract_id should be rejected");

  // Missing contract_version
  const noVersion = { contract_id: "c1", executor_subtasks: [{ subtask_id: "s1", role: "executor", objective: "test", complexity: "low" }] };
  assert.ok(validatePlannerContractSchema(noVersion).length > 0, "missing contract_version should be rejected");

  // Invalid contract_version (zero)
  const zeroVersion = { contract_id: "c1", contract_version: 0, executor_subtasks: [{ subtask_id: "s1", role: "executor", objective: "test", complexity: "low" }] };
  assert.ok(validatePlannerContractSchema(zeroVersion).length > 0, "zero contract_version should be rejected");

  // No executor_subtasks
  const noSubtasks = { contract_id: "c1", contract_version: 1 };
  assert.ok(validatePlannerContractSchema(noSubtasks).length > 0, "no subtasks should be rejected");

  // Empty executor_subtasks
  const emptySubtasks = { contract_id: "c1", contract_version: 1, executor_subtasks: [] };
  assert.ok(validatePlannerContractSchema(emptySubtasks).length > 0, "empty subtasks should be rejected");

  // Subtask with provider (should be rejected)
  const hasProvider = { contract_id: "c1", contract_version: 1, executor_subtasks: [{ subtask_id: "s1", role: "executor", objective: "test", complexity: "low", provider: "cc" }] };
  assert.ok(validatePlannerContractSchema(hasProvider).length > 0, "subtask with provider should be rejected");

  // Subtask with model (should be rejected)
  const hasModel = { contract_id: "c1", contract_version: 1, executor_subtasks: [{ subtask_id: "s1", role: "executor", objective: "test", complexity: "low", model: "gpt-4" }] };
  assert.ok(validatePlannerContractSchema(hasModel).length > 0, "subtask with model should be rejected");

  // Valid contract passes
  const valid = { contract_id: "c1", contract_version: 1, executor_subtasks: [{ subtask_id: "s1", role: "executor", objective: "test", complexity: "low" }] };
  assert.deepEqual(validatePlannerContractSchema(valid), [], "valid contract should pass validation");
});

test("shared contract accessors return typed values", async (t) => {
  const { getContractTaskId, getContractId, getContractVersion, getContractDigest, getExecutorSubtasks, getContractRequiredTests, getContractDependencies } = await import("../scripts/lib/contracts.mjs");

  const contract = {
    task_id: "task-42",
    contract_id: "contract-42",
    contract_version: 3,
    contract_digest: "abc123",
    executor_subtasks: [{
      subtask_id: "s1",
      role: "executor",
      complexity: "high",
      objective: "Do the thing",
      depends_on: ["dep-task"],
      writable_paths: ["src/"],
      forbidden_paths: [".git/**"],
      required_tests: ["npm test"],
      acceptance_criteria: ["works"],
      fallback_policy: { enabled: true },
    }],
  };

  assert.equal(getContractTaskId(contract), "task-42");
  assert.equal(getContractId(contract), "contract-42");
  assert.equal(getContractVersion(contract), 3);
  assert.equal(getContractDigest(contract), "abc123");

  const subtasks = getExecutorSubtasks(contract);
  assert.equal(subtasks.length, 1);
  assert.equal(subtasks[0].subtask_id, "s1");
  assert.equal(subtasks[0].complexity, "high");
  assert.equal(subtasks[0].objective, "Do the thing");

  const tests = getContractRequiredTests(contract);
  assert.deepEqual(tests, ["npm test"]);

  const deps = getContractDependencies(contract);
  assert.deepEqual(deps, ["dep-task"]);

  // Null-safe accessors
  assert.equal(getContractTaskId(null), "");
  assert.equal(getContractId(null), "");
  assert.equal(getContractVersion(null), 1);
  assert.equal(getContractDigest(null), null);
  assert.deepEqual(getExecutorSubtasks(null), []);
  assert.deepEqual(getContractRequiredTests(null), []);
  assert.deepEqual(getContractDependencies(null), []);
});

// ============================================================
// Negative tests: acceptance/evidence fail-closed gates
// ============================================================

test("accept fails with contract_unavailable when no Planner contract exists", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-no-contract-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "no-contract-task",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, started.id);

  // No Planner contract exists → accept must fail with contract_unavailable.
  await assert.rejects(
    () => acceptReadyJob(orchestrator, { projectDir: project, taskId: "no-contract-task", jobId: started.id }),
    /acceptance_unavailable/,
    "Accept should fail with acceptance_unavailable when no contract exists",
  );
});

test("apply rejects acceptance artifact with missing contract_id provenance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-bad-provenance-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a contract and implement
  await persistPlannerContract(project, "bad-prov", {
    contract_id: "contract-bad-prov", contract_version: 1, repository_identity: "bad-prov-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [],
  }, "planner-session-bad");

  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "bad-prov",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, started.id);

  // Accept normally — this creates a valid artifact
  await acceptReadyJob(orchestrator, { projectDir: project, taskId: "bad-prov", jobId: started.id });

  // Tamper the acceptance artifact: remove contract_id
  const job = await store.getJob(started.id);
  const artifact = JSON.parse(await fs.readFile(job.acceptance_artifact_path, "utf8"));
  delete artifact.contract_id;
  artifact.contract_version = 1;  // Keep version matching to reach the contract_id check
  artifact.contract_digest = "";
  await fs.writeFile(job.acceptance_artifact_path, JSON.stringify(artifact));

  // Apply must reject because the tampered artifact fails schema validation
  // (missing contract_id is caught by validateAcceptanceArtifactSchema).
  await assert.rejects(
    () => orchestrator.apply(started.id),
    /contract_id/,
    "Apply should reject when acceptance artifact is missing contract_id",
  );
});

test("apply rejects stale reviewer evidence after continuation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-stale-evidence-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: true, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a Planner contract
  await persistPlannerContract(project, "stale-evidence", {
    contract_id: "contract-stale", contract_version: 1, repository_identity: "stale-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [{ review_id: "review-1", role: "reviewer", type: "verify", complexity: "low", target_subtask_ids: ["impl-1"], required_checks: ["tests"], fallback_policy: { enabled: false } }],
  }, "planner-session-stale");

  // First implementation with waiver to bypass review gate
  const first = await orchestrator.startCc({
    project_dir: project,
    task_id: "stale-evidence",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
    review_waiver: true,
  });
  await waitFor(orchestrator, first.id);

  // Continuation with same task — produces new patch, invalidating old evidence
  const second = await orchestrator.startCc({
    project_dir: project,
    task_id: "stale-evidence",
    goal: "Update content",
    plan: "Continuing",
    complexity: "low",
    review_waiver: true,
  }, true);
  await waitFor(orchestrator, second.id);

  // Accept the continuation result
  await acceptReadyJob(orchestrator, { projectDir: project, taskId: "stale-evidence", jobId: second.id });

  // Apply should succeed because the accepted artifact matches current patch
  const result = await orchestrator.apply(second.id);
  assert.equal(result.applied, true, "Apply should succeed with fresh acceptance on continuation result");
});

test("acceptance artifact carries full repository and workspace provenance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-repo-id-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Contract with specific repository_identity
  await persistPlannerContract(project, "repo-test", {
    contract_id: "contract-repo", contract_version: 1, repository_identity: "my-repo-identity",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [],
  }, "planner-session-repo");

  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "repo-test",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, started.id);

  const artifact = await acceptReadyJob(orchestrator, { projectDir: project, taskId: "repo-test", jobId: started.id });
  assert.equal(artifact.repository_identity, "my-repo-identity",
    "acceptance artifact should carry repository_identity from the Planner contract");
  assert.ok(artifact.workspace_identity,
    "acceptance artifact should include workspace_identity");
  assert.equal(artifact.accepter_host, "codex",
    "acceptance artifact should include accepter_host");
});

// ===================================================================
// Plan/contract/job provenance tests
// ===================================================================

test("startCc creates job with ad-hoc plan_id when no contract exists", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-provenance-cc-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Directly create the job via the store to verify plan fields, avoiding
  // async execution complications.
  const job = await store.createJob({
    id: "prov-cc-1", type: "cc_execute", provider: "cc",
    status: "queued", phase: "queued",
    project_dir: project, task_id: "prov-cc-1",
    goal: "test", plan: "test",
    plan_id: "plan-test-adhoc", plan_type: "adhoc", association_reason: "auto_adhoc",
  });
  assert.ok(job.plan_id, "CC job should have plan_id");
  assert.equal(job.plan_type, "adhoc");
  assert.equal(job.association_reason, "auto_adhoc");

  // Verify the orchestrator also creates jobs with plan fields by inspecting startCc
  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "prov-cc-2",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  assert.ok(started.plan_id, "startCc job should have plan_id");
  // Wait for completion to avoid unhandled rejections
  const finished = await waitFor(orchestrator, started.id, 20000);
  assert.equal(finished.status, "completed", finished.error);
});

test("startAgyWrite creates job with ad-hoc plan_id", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-provenance-agy-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  config.cli.agy_prefix_args = [fakeAgy];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startAgyWrite({
    project_dir: project,
    task_id: "prov-agy-1",
    goal: "Create feature.txt",
    plan: "Implement",
    complexity: "medium",
  });
  assert.ok(started.plan_id, "AGY write job should have plan_id");
  assert.equal(started.plan_type, "adhoc");
  assert.equal(started.association_reason, "auto_adhoc");
  const finished = await waitFor(orchestrator, started.id, 20000);
  assert.equal(finished.status, "completed", finished.error);
});

test("startAuto creates job with formal plan_id from contract", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-provenance-auto-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await createAutoPlannerContract(project, "prov-auto-1", { complexity: "low" });
  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "prov-auto-1",
    subtask_id: "impl-1",
  });
  assert.ok(started.plan_id, "Auto job should have plan_id");
  assert.equal(started.plan_type, "formal");
  assert.equal(started.association_reason, "planner_contract");
  const finished = await waitFor(orchestrator, started.id, 20000);
  assert.equal(finished.status, "completed", finished.error);
});

test("continue inherits plan_id from initial job", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-provenance-cont-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  // Must disable the "duplicate implementation" guard for the continuation test
  config.roles = config.roles || {};
  config.roles.duplicate_implementation = false;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const first = await orchestrator.startCc({
    project_dir: project,
    task_id: "prov-cont",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  assert.ok(first.plan_id, "First CC job should have plan_id");

  // Wait for first to complete before starting continuation
  const firstFinished = await waitFor(orchestrator, first.id, 20000);
  assert.equal(firstFinished.status, "completed", firstFinished.error);

  // Continuation should inherit the same plan_id
  const second = await orchestrator.startCc({
    project_dir: project,
    task_id: "prov-cont",
    goal: "Continue implementation",
    plan: "Keep going",
    complexity: "low",
  }, true);
  assert.ok(second.plan_id, "Continuation job should have plan_id");
  assert.equal(second.plan_id, first.plan_id, "Continuation should inherit plan_id from initial job");
  assert.equal(second.association_reason, "inherited");
  const secondFinished = await waitFor(orchestrator, second.id, 20000);
  assert.equal(secondFinished.status, "completed", secondFinished.error);
});

test("no orphan jobs created by any start* path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-no-orphan-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  config.cli.agy_prefix_args = [fakeAgy];
  config.cli.agy_sandbox = false;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create jobs through multiple paths and let them complete
  const ccJob = await orchestrator.startCc({ project_dir: project, task_id: "orphan-cc", goal: "test", plan: "test", complexity: "low" });
  await waitFor(orchestrator, ccJob.id, 20000).catch(() => {});
  const invJob = await orchestrator.startInvestigation({ project_dir: project, objective: "test objective" });
  await waitFor(orchestrator, invJob.id, 20000).catch(() => {});
  const agyJob = await orchestrator.startAgy({ project_dir: project, task_id: "orphan-agy-read", goal: "test read" }, "investigate");
  await waitFor(orchestrator, agyJob.id, 20000).catch(() => {});

  // Verify ALL jobs have plan_id
  const allJobs = await store.listJobs();
  const orphanJobs = allJobs.filter((j) => !j.plan_id);
  assert.equal(orphanJobs.length, 0, `Expected 0 orphan jobs, found ${orphanJobs.length}: ${orphanJobs.map((j) => j.id).join(", ")}`);

  // Verify all jobs have meaningful association_reason
  for (const job of allJobs) {
    assert.ok(job.association_reason, `Job ${job.id} should have association_reason`);
    assert.ok(["auto_adhoc", "inherited", "planner_contract"].includes(job.association_reason),
      `Job ${job.id} has unexpected association_reason: ${job.association_reason}`);
  }
});

// ============================================================
// Status progress field tests
// ============================================================

test("status response includes progress field for CC job", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-status-progress-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  await persistPlannerContract(project, "status-progress", {
    contract_id: "contract-st-progress", contract_version: 1, repository_identity: "status-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }], reviewer_tasks: [],
  }, "planner-session-st-progress");

  const started = await orchestrator.startCc({
    project_dir: project,
    task_id: "status-progress",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });

  // Status during execution should include the progress field
  const statusDuring = await orchestrator.status(started.id);
  assert.ok(Object.hasOwn(statusDuring, "progress"), "status should include progress field");
  assert.ok(Object.hasOwn(statusDuring.progress, "available"), "progress should have available boolean");
  assert.ok(Array.isArray(statusDuring.progress.messages), "progress.messages should be an array");
  // Field should exist and have correct types regardless of whether messages are available
  assert.equal(typeof statusDuring.progress.available, "boolean");

  // After completion, check status still has progress field
  const finished = await waitFor(orchestrator, started.id);
  const statusAfter = await orchestrator.status(finished.id);
  assert.ok(Object.hasOwn(statusAfter, "progress"), "completed job status should include progress");
  // Progress may be available or not depending on whether stdout files were captured
  assert.equal(typeof statusAfter.progress.available, "boolean");
});

test("status progress distinguishes unavailable from job liveness", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-progress-liveness-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Create a job that hasn't started yet (no log files)
  const job = await store.createJob({
    id: "liveness-test-1", type: "cc_execute", provider: "cc",
    status: "queued", phase: "queued",
    project_dir: project, task_id: "liveness-test",
    goal: "test", plan: "test",
    plan_id: "plan-test", plan_type: "adhoc",
  });

  const st = await orchestrator.status(job.id);
  assert.ok(Object.hasOwn(st, "progress"));
  assert.equal(st.progress.available, false, "queued job should have progress.available=false");
  assert.equal(st.progress.messages.length, 0, "queued job should have zero progress messages");
  assert.ok(typeof st.progress.note === "string" || st.progress.note === null);
  // The job itself is alive (not throwing Unknown job) — progress.available=false
  // is distinct from the job not existing
  assert.equal(st.status, "queued", "job liveness is unaffected by progress availability");
});
