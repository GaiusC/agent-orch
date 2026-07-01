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
    execution: {
      workspace_mode: "isolated",
      max_cc_repair_rounds: 2,
      cc_timeout_seconds: 20,
      agy_timeout_seconds: 20,
      max_log_bytes: 1024 * 1024,
      max_result_chars: 8000,
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

test("CC implements, repairs in the same session, verifies, applies, and cleans", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-integration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
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
  t.after(() => fs.rm(root, { recursive: true, force: true }));
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
