import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkerOrchestrator } from "../scripts/lib/orchestrator.mjs";
import { StateStore } from "../scripts/lib/state.mjs";
import { acceptReadyJob, persistPlannerContract } from "./fixtures/architecture.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const pluginRoot = path.resolve(here, "..");
const cli = path.join(pluginRoot, "scripts", "agent-orch.mjs");
const fakeCc = path.join(here, "fixtures", "fake-cc.mjs");
const fakeAgy = path.join(here, "fixtures", "fake-agy.mjs");

function run(args, cwd = pluginRoot) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 30000 }));
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createProject(root) {
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
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

test("CLI initializes a project and runs a CC implementation to apply (via orchestrator API)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  // Test CLI init
  const init = run(["init", "-ProjectDir", project, "-ExistingProject"]);
  assert.equal(init.ok, true);
  assert.equal(init.mode, "cli");
  assert.ok(init.dashboard_launcher.endsWith("open-dashboard.ps1"));
  assert.ok(await fs.stat(init.dashboard_launcher));

  // Test CLI resume
  const resumed = run(["resume", "-ProjectDir", project, "-HostProvider", "codex"]);
  assert.equal(resumed.host_provider, "codex");
  assert.equal(resumed.external_invocation_allowed.codex, false);
  assert.ok(resumed.in_session_roles.includes("planner"));

  // Configure for CC execution via orchestrator API
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.cli.claude = process.execPath;
  config.cli.agy = process.execPath;
  config.cli.claude_prefix_args = [fakeCc];
  config.cli.agy_prefix_args = [fakeAgy];
  config.execution.cc_timeout_seconds = 20;
  config.execution.max_cc_repair_rounds = 2;
  config.verification.commands = ["node verify.cjs"];
  config.review_gate = { require_agy_verify_for_implementation: false, allow_waiver: true };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  // Test CLI health
  const health = run(["health", "-ProjectDir", project]);
  assert.equal(health.ok, true);

  // Use WorkerOrchestrator API directly (as MCP tools would)
  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);

  // Persist a Planner contract so that accepter and apply gates pass.
  await persistPlannerContract(project, "feature", {
    contract_id: "contract-feature", contract_version: 1, repository_identity: "cli-test",
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Create feature.txt containing good", depends_on: [], writable_paths: ["."], forbidden_paths: [".git/**", ".env", ".env.*"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true } }],
    reviewer_tasks: [],
  }, "planner-session-cli");

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
  assert.equal(await fs.stat(path.join(project, "feature.txt")).catch(() => null), null);

  // The accepter is the only way to create the artifact required by apply.
  const acceptance = await acceptReadyJob(orchestrator, {
    projectDir: project,
    taskId: "feature",
    jobId: started.id,
  });
  assert.equal(acceptance.patch_digest, result.evidence.changes.patch_digest);

  // Apply via orchestrator API
  const applied = await orchestrator.apply(started.id);
  assert.equal(applied.applied, true);
  assert.equal(await fs.readFile(path.join(project, "feature.txt"), "utf8"), "good");
});

test("CLI MCP-only commands produce explicit error", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-mcponly-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Test that running a removed command gives MCP-only error
  try {
    run(["cc-exec"], root);
    assert.fail("Should have thrown");
  } catch (error) {
    const output = error.stdout ? JSON.parse(error.stdout) : { error: error.message };
    assert.match(output.error || JSON.stringify(output), /MCP|no longer available/);
  }

  try {
    run(["auto"], root);
    assert.fail("Should have thrown");
  } catch (error) {
    const output = error.stdout ? JSON.parse(error.stdout) : { error: error.message };
    assert.match(output.error || JSON.stringify(output), /MCP|no longer available/);
  }

  try {
    run(["apply"], root);
    assert.fail("Should have thrown");
  } catch (error) {
    const output = error.stdout ? JSON.parse(error.stdout) : { error: error.message };
    assert.match(output.error || JSON.stringify(output), /MCP|no longer available/);
  }
});
