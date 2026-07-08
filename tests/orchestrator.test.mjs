import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkerOrchestrator } from "../scripts/lib/orchestrator.mjs";
import { StateStore } from "../scripts/lib/state.mjs";

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
  assert.equal(result.evidence.status, "ready_for_acceptance");
  assert.equal(result.evidence.provider, "agy_write");
  assert.ok(result.evidence.changes, "should have changes captured");
  assert.ok(result.evidence.changes.changed_files.includes("feature.txt"), "should include feature.txt in changed files");
  assert.equal(result.evidence.attempts.length, 2, "should have initial + repair attempt");
  assert.equal(result.evidence.attempts[0].session_id, result.evidence.attempts[1].session_id, "should reuse session across repairs");
  assert.equal(result.evidence.model, "Claude Sonnet 4.6 (Thinking)", "should use Sonnet Thinking model for medium complexity");

  // Apply and verify patch
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
  assert.equal(result.evidence.model, "deepseek-v4-flash");
  assert.equal(result.evidence.attempts[0].model, "deepseek-v4-flash");
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
  assert.equal(result.evidence.model, "deepseek-v4-pro");
  assert.equal(result.evidence.attempts[0].model, "deepseek-v4-pro");
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
  config.routing = { auto: "agy_preferred", agy_write_fallback_to_cc_on_quota: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // First run: auto route medium with explicit model creates session
  const first = await orchestrator.startAuto({
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
  const second = await orchestrator.startAuto({
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
  // Session was reset, so the evidence should have a different session context
  // The fake-agy always returns the same UUID, so the evidence session_id won't change.
  // But the store should reflect the new model.
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
  config.routing = { auto: "agy_preferred", agy_write_fallback_to_cc_on_quota: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  // AGY will fail with quota error (no session persisted first)
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

  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "qcleanup",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "medium",
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
  config.routing = { auto: "agy_preferred", agy_write_fallback_to_cc_on_quota: true };
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "quota-error";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "ccfallback",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "medium",
  });
  await waitFor(orchestrator, started.id, 20000);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  // The CC fallback for medium complexity should use flash
  assert.equal(result.evidence.model, "deepseek-v4-flash");
});

test("CC fallback after AGY quota uses high complexity CC model (deepseek-v4-pro)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-ccfallback-high-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.agy.auth_probe_required = false;
  config.cli.agy_prefix_args = [fakeAgy];
  config.routing = { auto: "agy_preferred", agy_write_fallback_to_cc_on_quota: true };
  config.models = config.models || {};
  config.models.cc = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "quota-error";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "ccfallback-high",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "high",
  });
  await waitFor(orchestrator, started.id, 20000);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.evidence.model, "deepseek-v4-pro");
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

  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "autolow",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.evidence.model, "deepseek-v4-flash");
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
  assert.equal(lowResult.evidence.model, "deepseek-v4-flash");
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
  assert.equal(highResult.evidence.model, "deepseek-v4-pro");
  assert.equal(highResult.job.status, "completed");
});

test("legacy config with null CC models preserves explicit custom value", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-nullcust-"));
  t.after(() => removeTempRoot(root));
  const project = await createProject(root);
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  // Mix of null and custom
  config.models = { cc: { low: null, medium: "custom-flash", high: null } };
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
  assert.equal((await orchestrator.result(low.id)).evidence.model, "deepseek-v4-flash");

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
  assert.equal((await orchestrator.result(high.id)).evidence.model, "deepseek-v4-pro");
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

  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "nullauto",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "low",
  });
  await waitFor(orchestrator, started.id);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.evidence.model, "deepseek-v4-flash");
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
  config.routing = { auto: "agy_preferred", agy_write_fallback_to_cc_on_quota: true };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  process.env.AGENT_ORCH_FAKE_AGY_MODE = "quota-error";
  t.after(() => { delete process.env.AGENT_ORCH_FAKE_AGY_MODE; });

  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  const started = await orchestrator.startAuto({
    project_dir: project,
    task_id: "nullfb",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "medium",
  });
  await waitFor(orchestrator, started.id, 20000);
  const result = await orchestrator.result(started.id);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.job.auto_route, "cc_fallback");
  assert.equal(result.evidence.auto_route.fallback_occurred, true);
  // CC fallback for medium complexity should use the normalized flash model
  assert.equal(result.evidence.model, "deepseek-v4-flash");
  assert.equal(result.job.status, "completed", result.job.error);
});
