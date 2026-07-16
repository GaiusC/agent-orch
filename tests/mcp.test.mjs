import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const pluginRoot = path.resolve(here, "..");
const serverPath = path.join(pluginRoot, "scripts", "mcp-stdio-bridge.mjs");
const fakeCc = path.join(here, "fixtures", "fake-cc.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createProject({ mcpEnabled = true, trusted = true } = {}) {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-mcp-"));
  await fs.writeFile(path.join(projectDir, "README.md"), "fixture\n");
  await fs.writeFile(
    path.join(projectDir, "verify.cjs"),
    "const fs=require('fs'); process.exit(fs.existsSync('feature.txt') && fs.readFileSync('feature.txt','utf8') === 'good' ? 0 : 1);\n",
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
      trusted,
      host: { provider: "codex" },
      mcp: { enabled: mcpEnabled, expose_provider_tools: false },
      cli: {
        claude: process.execPath,
        claude_prefix_args: [fakeCc],
        claude_permission_mode: "bypassPermissions",
      },
      execution: { cc_timeout_seconds: 20, max_cc_repair_rounds: 2 },
      review_gate: { require_reviewer_for_implementation: false, allow_waiver: true },
      verification: { commands: ["node verify.cjs"] },
      scope: { writable: ["."], forbidden: [".git/", ".env", ".env.*"] },
      stages: {
        plan: { default_complexity: "high", routes: { low: [{ provider: "codex", model: "gpt-test", invocation: "in_session" }], medium: [{ provider: "codex", model: "gpt-test", invocation: "in_session" }], high: [{ provider: "codex", model: "gpt-test", invocation: "in_session" }] } },
        work: { default_complexity: "low", routes: { low: [{ provider: "cc", model: "fake-cc" }], medium: [{ provider: "cc", model: "fake-cc" }], high: [{ provider: "cc", model: "fake-cc" }] } },
        review: { default_complexity: "low", routes: { low: [{ provider: "agy", model: "fake-agy" }], medium: [{ provider: "agy", model: "fake-agy" }], high: [{ provider: "agy", model: "fake-agy" }] } },
        accept: { inherit_from: "plan" },
      },
    }, null, 2)}\n`,
  );
  return projectDir;
}

async function connect(env = process.env) {
  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env,
  });
  await client.connect(transport);
  return client;
}

function body(result) {
  return JSON.parse(result.content[0].text);
}

test("MCP exposes stage-first tools and hides provider wrappers by default", async () => {
  const client = await connect();
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const name of ["stage-plan", "stage-work", "stage-work-continue", "stage-review", "stage-accept", "wait-for-job", "status", "result", "apply", "cleanup", "health"]) {
      assert.ok(names.includes(name), `${name} should be exposed`);
    }
    for (const name of ["cc-exec", "agy-exec", "auto", "planner-plan", "codex-exec", "accepter-accept"]) {
      assert.equal(names.includes(name), false, `${name} should be hidden`);
    }
  } finally {
    await client.close();
  }
});

test("provider wrappers require both server and project diagnostic opt-in", async (t) => {
  const projectDir = await createProject();
  t.after(() => fs.rm(projectDir, { recursive: true, force: true }));
  const client = await connect({ ...process.env, AGENT_ORCH_EXPOSE_PROVIDER_TOOLS: "1" });
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "cc-exec"));
    const denied = await client.callTool({
      name: "cc-exec",
      arguments: { project_dir: projectDir, task_id: "x", goal: "x", plan: "x" },
    });
    assert.equal(denied.isError, true);
    assert.match(body(denied).error, /mcp\.expose_provider_tools/);
  } finally {
    await client.close();
  }
});

test("mcp.enabled=false blocks work stages but health remains available", async (t) => {
  const projectDir = await createProject({ mcpEnabled: false });
  t.after(() => fs.rm(projectDir, { recursive: true, force: true }));
  const client = await connect();
  try {
    const health = await client.callTool({ name: "health", arguments: { project_dir: projectDir } });
    assert.equal(health.isError, false);
    const work = await client.callTool({
      name: "stage-work",
      arguments: { project_dir: projectDir, task_id: "x", subtask_id: "x" },
    });
    assert.equal(work.isError, true);
    assert.equal(body(work).reason, "mcp_disabled");
  } finally {
    await client.close();
  }
});

test("stage-plan persists contract and immutable execution identity", async (t) => {
  const projectDir = await createProject();
  t.after(() => fs.rm(projectDir, { recursive: true, force: true }));
  const client = await connect();
  try {
    const result = await client.callTool({
      name: "stage-plan",
      arguments: {
        project_dir: projectDir,
        task_id: "feature",
        planner_session_id: "codex-session-1",
        contract: {
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
            fallback_policy: { enabled: true },
          }],
          reviewer_tasks: [],
        },
      },
    });
    assert.equal(result.isError, false, result.content[0].text);
    const value = body(result);
    assert.equal(value.stage_run.status, "completed");
    assert.equal(value.plan_execution_identity.session_id, "codex-session-1");
    assert.equal(value.plan_execution_identity.model, "gpt-test");
    assert.ok(await fs.stat(path.join(projectDir, ".agent-orchestrator", "plans", "feature.execution.json")));
  } finally {
    await client.close();
  }
});

test("stage-work launches configured provider and reaches terminal StageRun", async (t) => {
  const projectDir = await createProject();
  t.after(() => fs.rm(projectDir, { recursive: true, force: true }));
  const client = await connect();
  try {
    const plan = await client.callTool({
      name: "stage-plan",
      arguments: {
        project_dir: projectDir,
        task_id: "feature",
        planner_session_id: "codex-session-1",
        contract: {
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
            fallback_policy: { enabled: true },
          }],
          reviewer_tasks: [],
        },
      },
    });
    assert.equal(plan.isError, false, plan.content[0].text);
    const started = await client.callTool({
      name: "stage-work",
      arguments: { project_dir: projectDir, task_id: "feature", subtask_id: "impl" },
    });
    assert.equal(started.isError, false, started.content[0].text);
    const jobId = body(started).job.id;
    const finished = await client.callTool({
      name: "wait-for-job",
      arguments: { project_dir: projectDir, job_id: jobId },
    });
    assert.equal(finished.isError, false, finished.content[0].text);
    assert.equal(body(finished).status, "completed");
    assert.equal(body(finished).provider, "cc");
    const stageFile = path.join(projectDir, ".agent-orchestrator", "stages", `${body(started).stage_run.stage_run_id}.json`);
    const stageRun = JSON.parse(await fs.readFile(stageFile, "utf8"));
    assert.equal(stageRun.status, "completed");
    const accepted = await client.callTool({
      name: "stage-accept",
      arguments: {
        project_dir: projectDir,
        task_id: "feature",
        job_id: jobId,
        accepter_session_id: "codex-session-1",
        decision: "accepted",
        summary: "Fixture evidence accepted.",
      },
    });
    assert.equal(accepted.isError, false, accepted.content[0].text);
    assert.equal(body(accepted).acceptance.status, "accepted");
    const applied = await client.callTool({
      name: "apply",
      arguments: { project_dir: projectDir, job_id: jobId },
    });
    assert.equal(applied.isError, false, applied.content[0].text);
    assert.equal(await fs.readFile(path.join(projectDir, "feature.txt"), "utf8"), "good");
  } finally {
    await client.close();
  }
});

test("unknown tool is rejected", async () => {
  const client = await connect();
  try {
    const result = await client.callTool({ name: "nonexistent-tool", arguments: {} });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
  }
});
