import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { autoRouteProvider, chooseAgyWriteModel } from "../scripts/lib/config.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const cli = path.join(path.resolve(here, ".."), "scripts", "agent-orch.mjs");
const fakeCc = path.join(here, "fixtures", "fake-cc.mjs");
const fakeAgy = path.join(here, "fixtures", "fake-agy.mjs");

function runCli(args, cwd) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 30000 }));
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createProject(root, overrides = {}) {
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "verify.cjs"), "const fs=require('fs'); process.exit(fs.existsSync('feature.txt') && fs.readFileSync('feature.txt','utf8') === 'good' ? 0 : 1);\n");
  await fs.writeFile(path.join(project, "README.md"), "fixture\n");
  git(project, "init");
  git(project, "config", "user.name", "Agent Orch Tests");
  git(project, "config", "user.email", "agent-orch@example.test");
  git(project, "add", ".");
  git(project, "commit", "-m", "fixture");

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
    agy: { auth_probe_required: false, enabled: true },
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
    ...overrides,
  };
  await fs.writeFile(path.join(project, ".agent-orchestrator", "config.json"), JSON.stringify(config, null, 2));
  return project;
}

// -- Config unit tests --

test("autoRouteProvider default (no routing.auto) is agy_preferred", () => {
  const config = {};
  assert.equal(autoRouteProvider(config, "low"), "cc");
  assert.equal(autoRouteProvider(config, "medium"), "agy");
  assert.equal(autoRouteProvider(config, "high"), "agy");
});

test("autoRouteProvider with agy_preferred routes low->cc, medium/high->agy", () => {
  const config = { routing: { auto: "agy_preferred" } };
  assert.equal(autoRouteProvider(config, "low"), "cc");
  assert.equal(autoRouteProvider(config, "medium"), "agy");
  assert.equal(autoRouteProvider(config, "high"), "agy");
});

test("autoRouteProvider with legacy cc routes all to cc", () => {
  const config = { routing: { auto: "cc" } };
  assert.equal(autoRouteProvider(config, "low"), "cc");
  assert.equal(autoRouteProvider(config, "medium"), "cc");
  assert.equal(autoRouteProvider(config, "high"), "cc");
});

test("autoRouteProvider with legacy agy preserves agy_preferred behavior", () => {
  const config = { routing: { auto: "agy" } };
  assert.equal(autoRouteProvider(config, "low"), "cc");
  assert.equal(autoRouteProvider(config, "medium"), "agy");
  assert.equal(autoRouteProvider(config, "high"), "agy");
});

test("chooseAgyWriteModel returns correct models by complexity", () => {
  const config = { models: {} };
  assert.equal(chooseAgyWriteModel(config, "medium"), "Claude Sonnet 4.6 (Thinking)");
  assert.equal(chooseAgyWriteModel(config, "high"), "Claude Opus 4.6 (Thinking)");
  assert.equal(chooseAgyWriteModel(config, "low"), null);
});

test("chooseAgyWriteModel respects config override", () => {
  const config = { models: { agy_write: { medium: "Custom Medium Model", high: "Custom High Model" } } };
  assert.equal(chooseAgyWriteModel(config, "medium"), "Custom Medium Model");
  assert.equal(chooseAgyWriteModel(config, "high"), "Custom High Model");
});

// -- CLI integration: auto routes low -> CC --

test("auto CLI command routes low complexity to CC", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-auto-low-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, JSON.stringify({
    task_id: "auto-low",
    goal: "Create feature.txt containing good",
    plan: "Implement and verify",
    complexity: "low",
  }, null, 2));

  const result = runCli(["auto", "-ProjectDir", project, "-Contract", contractPath]);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.job.status, "completed", result.job.error);
  assert.equal(result.evidence.status, "ready_for_acceptance");
});

// -- CLI integration: auto routes medium -> AGY write --

test("auto CLI command routes medium complexity to AGY write", async (t) => {
  const previousMode = process.env.AGENT_ORCH_FAKE_AGY_MODE;
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => {
    if (previousMode === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_MODE;
    else process.env.AGENT_ORCH_FAKE_AGY_MODE = previousMode;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-auto-med-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, JSON.stringify({
    task_id: "auto-med",
    goal: "Create feature.txt containing good",
    plan: "Implement and verify",
    complexity: "medium",
  }, null, 2));

  const result = runCli(["auto", "-ProjectDir", project, "-Contract", contractPath]);
  assert.equal(result.job.provider, "agy_write");
  assert.equal(result.job.status, "completed", result.job.error);
  assert.equal(result.evidence.status, "ready_for_acceptance");
  assert.equal(result.evidence.model, "Claude Sonnet 4.6 (Thinking)");
});

// -- CLI integration: auto routes high -> AGY write with Opus --

test("auto CLI command routes high complexity to AGY write with Opus model", async (t) => {
  const previousMode = process.env.AGENT_ORCH_FAKE_AGY_MODE;
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => {
    if (previousMode === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_MODE;
    else process.env.AGENT_ORCH_FAKE_AGY_MODE = previousMode;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-auto-high-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, JSON.stringify({
    task_id: "auto-high",
    goal: "Create feature.txt containing good",
    plan: "Implement and verify",
    complexity: "high",
  }, null, 2));

  const result = runCli(["auto", "-ProjectDir", project, "-Contract", contractPath]);
  assert.equal(result.job.provider, "agy_write");
  assert.equal(result.job.status, "completed", result.job.error);
  assert.equal(result.evidence.model, "Claude Opus 4.6 (Thinking)");
});

// -- Legacy config compatibility: primary_writer=cc still works with auto --

test("auto command works with legacy primary_writer=cc config", async (t) => {
  const previousMode = process.env.AGENT_ORCH_FAKE_AGY_MODE;
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => {
    if (previousMode === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_MODE;
    else process.env.AGENT_ORCH_FAKE_AGY_MODE = previousMode;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-legacy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Create config without routing section (simulating legacy config)
  const project = await createProject(root, { routing: undefined });
  // Manually remove routing field to simulate pre-upgrade config
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  let config = JSON.parse(await fs.readFile(configPath, "utf8"));
  delete config.routing;
  config.roles = { primary_writer: "cc", specialist: "agy", duplicate_implementation: false };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, JSON.stringify({
    task_id: "legacy-auto",
    goal: "Create feature.txt containing good",
    plan: "Implement and verify",
    complexity: "medium",
  }, null, 2));

  const result = runCli(["auto", "-ProjectDir", project, "-Contract", contractPath]);
  assert.equal(result.job.provider, "agy_write");
  assert.equal(result.job.status, "completed", result.job.error);
});

// -- AGY exec/continue CLI commands --

test("agy-exec CLI command produces ready_for_acceptance patch", async (t) => {
  const previousMode = process.env.AGENT_ORCH_FAKE_AGY_MODE;
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => {
    if (previousMode === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_MODE;
    else process.env.AGENT_ORCH_FAKE_AGY_MODE = previousMode;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agyexec-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, JSON.stringify({
    task_id: "agyexec",
    goal: "Create feature.txt containing good",
    plan: "Implement and verify",
    complexity: "medium",
  }, null, 2));

  const result = runCli(["agy-exec", "-ProjectDir", project, "-Contract", contractPath]);
  assert.equal(result.job.provider, "agy_write");
  assert.equal(result.job.status, "completed", result.job.error);
  assert.equal(result.evidence.status, "ready_for_acceptance");
  assert.equal(result.evidence.provider, "agy_write");

  // Apply and verify
  await fs.writeFile(path.join(project, "feature.txt"), "good", "utf8");
});

test("agy-continue CLI command works with same task_id", async (t) => {
  const previousMode = process.env.AGENT_ORCH_FAKE_AGY_MODE;
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "write-session";
  t.after(() => {
    if (previousMode === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_MODE;
    else process.env.AGENT_ORCH_FAKE_AGY_MODE = previousMode;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agycont-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, JSON.stringify({
    task_id: "agycont",
    goal: "Create feature.txt containing good",
    plan: "Implement and verify",
    complexity: "medium",
  }, null, 2));

  const first = runCli(["agy-exec", "-ProjectDir", project, "-Contract", contractPath]);
  assert.equal(first.job.status, "completed", first.job.error);

  const second = runCli(["agy-continue", "-ProjectDir", project, "-Contract", contractPath]);
  assert.equal(second.job.provider, "agy_write");
});
