import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { autoRouteProvider, chooseAgyWriteModel, DEFAULT_CONFIG } from "../scripts/lib/config.mjs";
import { ccExecutorModel, agyExecutorFallback, plannerFallback, reviewerModel } from "../scripts/lib/model-registry.mjs";
import { WorkerOrchestrator } from "../scripts/lib/orchestrator.mjs";
import { StateStore } from "../scripts/lib/state.mjs";
import { createPersistedPlannerContract } from "./fixtures/architecture.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const cli = path.join(path.resolve(here, ".."), "scripts", "agent-orch.mjs");

function runCli(args, cwd) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 30000 }));
}

function runCliRaw(args, cwd) {
  return execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 30000 });
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createProject(root, overrides = {}) {
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "README.md"), "fixture\n");
  git(project, "init");
  git(project, "config", "user.name", "Agent Orch Tests");
  git(project, "config", "user.email", "agent-orch@example.test");
  git(project, "add", ".");
  git(project, "commit", "-m", "fixture");
  return project;
}

async function createAutoProject(root, executorPriority = ["cc", "agy"]) {
  const project = await createProject(root);
  const orchDir = path.join(project, ".agent-orchestrator");
  await fs.mkdir(orchDir, { recursive: true });
  await fs.writeFile(path.join(orchDir, "config.json"), JSON.stringify({
    trusted: true,
    routing: { executor_priority: executorPriority },
    review_gate: { require_reviewer_for_implementation: false, require_agy_verify_for_implementation: false },
  }));
  return project;
}

// -- Centralized routing and model registry --

test("autoRouteProvider uses the centralized CC-first executor priority for every Planner tier", () => {
  for (const tier of ["low", "medium", "high"]) {
    assert.equal(autoRouteProvider(DEFAULT_CONFIG, tier), "cc");
  }
});

test("autoRouteProvider only honors executor_priority, not retired routing.auto", () => {
  const ccFirst = { routing: { auto: "agy_preferred", executor_priority: ["cc", "agy"] } };
  const agyFirst = { routing: { auto: "cc_first", executor_priority: ["agy", "cc"] } };
  for (const tier of ["low", "medium", "high"]) {
    assert.equal(autoRouteProvider(ccFirst, tier), "cc");
    assert.equal(autoRouteProvider(agyFirst, tier), "agy");
  }
});

test("model registry fallback keys resolve to exact Thinking model strings for AGY CLI", () => {
  const agyExec = agyExecutorFallback();
  assert.equal(agyExec.logical_key, "fallback.agy_exec");
  assert.equal(agyExec.provider, "anthropic");
  assert.equal(agyExec.canonical_id, "Claude Sonnet 4.6 (Thinking)");
  assert.equal(agyExec.display_name, "Claude Sonnet 4.6 (Thinking)");

  const planner = plannerFallback();
  assert.equal(planner.logical_key, "fallback.planner");
  assert.equal(planner.provider, "anthropic");
  assert.equal(planner.canonical_id, "Claude Opus 4.6 (Thinking)");
  assert.equal(planner.display_name, "Claude Opus 4.6 (Thinking)");
});

test("chooseAgyWriteModel hardcoded fallback returns exact Thinking model strings", () => {
  // When config has no agy_write models (empty), the hardcoded fallback is used.
  const emptyConfig = {};
  assert.equal(chooseAgyWriteModel(emptyConfig, "low"), "Claude Sonnet 4.6 (Thinking)");
  assert.equal(chooseAgyWriteModel(emptyConfig, "medium"), "Claude Sonnet 4.6 (Thinking)");
  assert.equal(chooseAgyWriteModel(emptyConfig, "high"), "Claude Opus 4.6 (Thinking)");
});

test("model registry resolves executor and reviewer identities by role and tier", () => {
  assert.deepEqual(ccExecutorModel("medium"), {
    logical_key: "cc.exec.mid",
    provider: "cc",
    role: "executor",
    tier: "mid",
    display_name: "DeepSeek V4 Flash",
    canonical_id: "deepseek-v4-flash",
  });
  assert.deepEqual(reviewerModel("high"), {
    logical_key: "agy.review.high",
    provider: "agy",
    role: "reviewer",
    tier: "high",
    display_name: "Gemini 3.1 Pro (High)",
    canonical_id: "Gemini 3.1 Pro (High)",
  });
});

test("auto reads the persisted Planner subtask and rejects caller-supplied routing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-auto-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createAutoProject(root);
  const persisted = await createPersistedPlannerContract(project, "task-1");
  const store = new StateStore(path.join(root, "state"));
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);
  orchestrator.launch = () => {};

  const started = await orchestrator.startAuto({ project_dir: project, task_id: "task-1", subtask_id: "impl-1" });
  assert.equal(started.provider, "cc");
  const job = await store.getJob(started.id);
  assert.equal(job.subtask_id, "impl-1");
  assert.equal(job.complexity, "low");
  assert.equal(job.contract_digest, persisted.contract_digest);

  await assert.rejects(
    () => orchestrator.startAuto({ project_dir: project, task_id: "task-1", subtask_id: "impl-1", complexity: "high" }),
    /server_managed_complexity/,
  );
  await assert.rejects(
    () => orchestrator.startAuto({ project_dir: project, task_id: "task-1", subtask_id: "impl-1", model: "caller-model" }),
    /server_managed_routing/,
  );
});

// -- DEFAULT_CONFIG review_gate --

test("DEFAULT_CONFIG includes review_gate with reviewer gate enabled", () => {
  assert.ok(DEFAULT_CONFIG.review_gate, "DEFAULT_CONFIG must have review_gate section");
  assert.equal(DEFAULT_CONFIG.review_gate.require_reviewer_for_implementation, true);
  assert.equal(DEFAULT_CONFIG.review_gate.require_agy_verify_for_implementation, true);
  assert.equal(DEFAULT_CONFIG.review_gate.allow_waiver, true);
});

// -- DEFAULT_CONFIG agy_env --

test("DEFAULT_CONFIG includes agy_env as empty object in cli section", () => {
  assert.ok(DEFAULT_CONFIG.cli, "DEFAULT_CONFIG must have cli section");
  assert.ok(DEFAULT_CONFIG.cli.agy_env, "DEFAULT_CONFIG.cli must have agy_env");
  assert.equal(typeof DEFAULT_CONFIG.cli.agy_env, "object");
  assert.equal(Object.keys(DEFAULT_CONFIG.cli.agy_env).length, 0);
});

test("agy_env merges from project config overriding defaults", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agyenv-merge-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);
  const orchDir = path.join(project, ".agent-orchestrator");
  await fs.mkdir(orchDir, { recursive: true });
  await fs.writeFile(
    path.join(orchDir, "config.json"),
    JSON.stringify({
      cli: {
        agy_env: {
          HTTP_PROXY: "http://127.0.0.1:10100",
          HTTPS_PROXY: "http://127.0.0.1:10100",
          ALL_PROXY: "http://127.0.0.1:10100",
          NO_PROXY: "localhost,127.0.0.1,::1",
        },
      },
    }),
  );

  const { loadProjectConfig } = await import("../scripts/lib/config.mjs");
  const config = await loadProjectConfig(project);
  assert.ok(config.cli.agy_env);
  assert.equal(config.cli.agy_env.HTTP_PROXY, "http://127.0.0.1:10100");
  assert.equal(config.cli.agy_env.HTTPS_PROXY, "http://127.0.0.1:10100");
  assert.equal(config.cli.agy_env.ALL_PROXY, "http://127.0.0.1:10100");
  assert.equal(config.cli.agy_env.NO_PROXY, "localhost,127.0.0.1,::1");
});

// -- CLI surface: MCP-only errors --

const MCP_ONLY_COMMANDS = [
  "auto", "cc-exec", "cc-continue", "agy-exec", "agy-continue",
  "reviewer-investigate", "reviewer-verify", "planner-plan",
  "status", "result", "apply", "cleanup",
];

for (const cmd of MCP_ONLY_COMMANDS) {
  test(`CLI "${cmd}" fails with explicit MCP-only error`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `agent-orch-cli-${cmd}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = await createProject(root);

    try {
      runCliRaw([cmd, "-ProjectDir", project], root);
      assert.fail(`Expected ${cmd} to throw`);
    } catch (error) {
      const output = JSON.parse(error.stdout || error.message || "");
      // The error message should reference MCP
      const errorText = output.error || JSON.stringify(output);
      assert.match(errorText, /MCP|no longer available/, `${cmd} should mention MCP in error`);
    }
  });
}

// -- CLI surface: help --

test("CLI help shows new command surface", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-cli-help-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const output = runCliRaw(["--help"], root);
  assert.match(output, /mcp status/, "help should mention mcp status");
  assert.match(output, /mcp install/, "help should mention mcp install");
  assert.match(output, /mcp repair/, "help should mention mcp repair");
  assert.match(output, /mcp remove/, "help should mention mcp remove");
  // Worker commands should not be in the help
  assert.doesNotMatch(output, /^\s+cc-exec\b/m, "help should not list cc-exec as available");
  assert.doesNotMatch(output, /^\s+auto\b/m, "help should not list auto as available");
});

// -- CLI surface: init / resume --

test("CLI init enables the MCP stage surface for a Codex host", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-init-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const result = runCli(["init", "-ProjectDir", project, "-HostProvider", "codex"]);
  assert.equal(result.ok, true);
  assert.equal(result.mcp_enabled, true, "codex init should enable the stage MCP");
  assert.equal(result.host_provider, "codex");

  // Verify config was written
  const config = JSON.parse(await fs.readFile(path.join(project, ".agent-orchestrator", "config.json"), "utf8"));
  assert.equal(config.mcp.enabled, true);
  assert.equal(config.host.provider, "codex");
  assert.equal(config.models.codex.planner, "gpt-5.6-terra");
  assert.equal(config.models.codex.accepter, "gpt-5.6-terra");
});

test("CLI init with cc_desktop enables mcp", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-init-cc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const result = runCli(["init", "-ProjectDir", project, "-HostProvider", "cc_desktop"]);
  assert.equal(result.ok, true);
  assert.equal(result.mcp_enabled, true, "cc_desktop init should enable mcp");
  assert.equal(result.host_provider, "cc_desktop");

  const config = JSON.parse(await fs.readFile(path.join(project, ".agent-orchestrator", "config.json"), "utf8"));
  assert.equal(config.mcp.enabled, true);
});

test("CLI resume preserves mcp profile", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-resume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  // First init as cc_desktop (enables MCP)
  await runCli(["init", "-ProjectDir", project, "-HostProvider", "cc_desktop"]);

  // Then resume as codex (should preserve mcp.enabled)
  const result = runCli(["resume", "-ProjectDir", project, "-HostProvider", "codex"]);
  assert.ok(result.mcp_enabled, "resume should preserve mcp.enabled");

  const config = JSON.parse(await fs.readFile(path.join(project, ".agent-orchestrator", "config.json"), "utf8"));
  assert.equal(config.mcp.enabled, true, "mcp.enabled should survive resume");
  assert.equal(config.host.provider, "codex");
});

test("CLI init and resume preserve an explicit mcp.enabled=false", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-resume-disabled-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);
  const configRoot = path.join(project, ".agent-orchestrator");
  await fs.mkdir(configRoot, { recursive: true });
  await fs.writeFile(
    path.join(configRoot, "config.json"),
    JSON.stringify({ version: 2, trusted: true, mcp: { enabled: false }, host: { provider: "codex" }, stages: {} }, null, 2),
  );

  const initialized = runCli(["init", "-ProjectDir", project, "-HostProvider", "codex"]);
  assert.equal(initialized.mcp_enabled, false);
  const resumed = runCli(["resume", "-ProjectDir", project, "-HostProvider", "codex"]);
  assert.equal(resumed.mcp_enabled, false);

  const config = JSON.parse(await fs.readFile(path.join(configRoot, "config.json"), "utf8"));
  assert.equal(config.mcp.enabled, false);
});

// -- CLI surface: mcp maintenance commands --

test("CLI mcp status reports configuration", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-mcpstat-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);
  await runCli(["init", "-ProjectDir", project, "-HostProvider", "codex"]);

  const result = runCli(["mcp", "status", "-ProjectDir", project]);
  assert.equal(result.ok, true);
  assert.equal(result.mcp_enabled, true);
  assert.equal(result.host_provider, "codex");
  assert.equal(result.trusted, true);
});

test("CLI mcp install enables MCP and writes .mcp.json", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-mcpinst-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);
  await runCli(["init", "-ProjectDir", project, "-HostProvider", "codex"]);

  const result = runCli(["mcp", "install", "-ProjectDir", project]);
  assert.equal(result.ok, true);
  assert.equal(result.mcp_enabled, true);

  // Verify config
  const config = JSON.parse(await fs.readFile(path.join(project, ".agent-orchestrator", "config.json"), "utf8"));
  assert.equal(config.mcp.enabled, true);

  // Verify .mcp.json
  const mcpJson = JSON.parse(await fs.readFile(path.join(project, ".mcp.json"), "utf8"));
  assert.ok(mcpJson.mcpServers?.agent_orch, ".mcp.json should have agent_orch entry");
  assert.equal(mcpJson.mcpServers.agent_orch.cwd, ".");
  assert.ok(
    mcpJson.mcpServers.agent_orch.args[0].includes("/") &&
    !mcpJson.mcpServers.agent_orch.args[0].includes("\\"),
    "MCP script path should use portable forward slashes on Windows",
  );
  assert.equal(mcpJson.mcpServers.agent_orch.command, "node");
});

test("CLI mcp repair fixes broken configuration", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-mcprep-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);
  await runCli(["init", "-ProjectDir", project, "-HostProvider", "codex"]);

  // Simulate broken state
  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  let config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.mcp = { enabled: false };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  await fs.writeFile(
    path.join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "agent-orch": {
          command: "node",
          args: ["legacy/server.mjs"],
          cwd: "C:/legacy",
        },
      },
    }, null, 2),
  );

  const result = runCli(["mcp", "repair", "-ProjectDir", project]);
  assert.equal(result.ok, true);
  assert.equal(result.mcp_repaired, true);
  assert.equal(result.mcp_enabled, true);

  config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.mcp.enabled, true);
  const repairedMcp = JSON.parse(await fs.readFile(path.join(project, ".mcp.json"), "utf8"));
  assert.equal(repairedMcp.mcpServers?.["agent-orch"], undefined);
  assert.equal(repairedMcp.mcpServers?.agent_orch?.cwd, ".");
  assert.match(repairedMcp.mcpServers.agent_orch.args[0], /mcp-stdio-bridge\.mjs$/);
});

test("CLI mcp remove disables MCP and removes .mcp.json entry", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-mcprm-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);
  await runCli(["init", "-ProjectDir", project, "-HostProvider", "codex"]);
  await runCli(["mcp", "install", "-ProjectDir", project]);

  const result = runCli(["mcp", "remove", "-ProjectDir", project]);
  assert.equal(result.ok, true);
  assert.equal(result.mcp_removed, true);
  assert.equal(result.mcp_enabled, false);

  const config = JSON.parse(await fs.readFile(path.join(project, ".agent-orchestrator", "config.json"), "utf8"));
  assert.equal(config.mcp.enabled, false);

  const mcpJson = JSON.parse(await fs.readFile(path.join(project, ".mcp.json"), "utf8"));
  assert.equal(mcpJson.mcpServers?.agent_orch, undefined);
  assert.equal(mcpJson.mcpServers?.["agent-orch"], undefined);
});

// -- CLI surface: health includes mcp_enabled and host_provider --

test("CLI health reports mcp_enabled and host_provider", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-health-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);
  await runCli(["init", "-ProjectDir", project, "-HostProvider", "cc_desktop"]);

  const result = runCli(["health", "-ProjectDir", project]);
  assert.equal(result.ok, true);
  assert.equal(result.mcp_enabled, true);
  assert.equal(result.host_provider, "cc_desktop");
});
