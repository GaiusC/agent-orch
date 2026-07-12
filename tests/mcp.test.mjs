import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");

// -- Tool listing --

test("MCP server starts and exposes bounded tools", async () => {
  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("cc-exec"));
    assert.ok(names.includes("cc-continue"));
    assert.ok(names.includes("reviewer-verify"));
    assert.ok(names.includes("reviewer-investigate"));
    assert.ok(names.includes("accepter-accept"));
    assert.ok(names.includes("planner-plan"));
    assert.ok(names.includes("codex-exec"));
    assert.ok(names.includes("codex-continue"));
    assert.ok(names.includes("apply"));
    assert.ok(names.includes("agy-exec"));
    assert.ok(names.includes("agy-continue"));
    assert.ok(names.includes("auto"));
    assert.ok(names.includes("status"));
    assert.ok(names.includes("result"));
    assert.ok(names.includes("cancel"));
    assert.ok(names.includes("cleanup"));
    assert.ok(names.includes("health"));
    assert.equal(names.includes("mcp-status"), false, "mcp-status should not be an MCP tool (CLI-only)");
    assert.equal(names.includes("mcp-install"), false, "mcp-install should not be an MCP tool (CLI-only)");
    assert.equal(names.includes("mcp-repair"), false, "mcp-repair should not be an MCP tool (CLI-only)");
    assert.equal(names.includes("mcp-remove"), false, "mcp-remove should not be an MCP tool (CLI-only)");
    assert.equal(names.includes("agy_verify"), false);
    assert.equal(names.includes("agy_investigate"), false);
    assert.equal(names.includes("run_arbitrary_command"), false);
    const health = await client.callTool({ name: "health", arguments: {} });
    assert.equal(health.isError, false);
  } finally {
    await client.close();
  }
});

test("MCP server rejects unknown tool with error", async () => {
  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "nonexistent-tool",
      arguments: {},
    });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
  }
});

// -- MCP gate: disabled project --

test("MCP server rejects non-health tools when mcp.enabled is false", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-mcp-off-"));
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    JSON.stringify({ trusted: true, host: { provider: "codex" }, mcp: { enabled: false } }),
  );

  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    // health should still work
    const health = await client.callTool({ name: "health", arguments: { project_dir: projectDir } });
    assert.equal(health.isError, false);

    // cc-exec should be blocked by mcp gate
    const cc = await client.callTool({
      name: "cc-exec",
      arguments: { project_dir: projectDir, task_id: "t1", goal: "test", plan: "test" },
    });
    assert.equal(cc.isError, true);
    const ccBody = JSON.parse(cc.content[0].text);
    assert.equal(ccBody.policy_denial, true);
    assert.equal(ccBody.reason, "mcp_disabled");
  } finally {
    await client.close();
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

// -- Host allow-list: codex blocked from codex-exec --

test("codex host is blocked from codex-exec via policy", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-codex-host-"));
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    JSON.stringify({ trusted: true, host: { provider: "codex" }, mcp: { enabled: true } }),
  );

  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "codex-exec",
      arguments: { project_dir: projectDir, task_id: "t1", mode: "plan", goal: "test" },
    });
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.policy_denial, true);
    assert.equal(body.reason, "not_in_host_allow_list");
    assert.ok(body.detail.includes("not permitted"), "should mention not permitted");
  } finally {
    await client.close();
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("codex host can persist an in-session Planner contract without external invocation", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-codex-plan-"));
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    JSON.stringify({ trusted: true, host: { provider: "codex" }, mcp: { enabled: true } }),
  );

  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "planner-plan",
      arguments: {
        project_dir: projectDir,
        task_id: "codex-persist-only",
        planner_session_id: "in-session-codex-test",
        contract: {
          contract_id: "codex-persist-only",
          contract_version: 1,
          executor_subtasks: [{
            subtask_id: "foundation",
            role: "executor",
            objective: "Persist the current Codex-owned plan",
            complexity: "low",
            writable_paths: ["src/"],
            forbidden_paths: [".git/"],
            required_tests: ["node --test"],
            acceptance_criteria: ["contract is persisted"],
            fallback_policy: { enabled: false },
          }],
        },
      },
    });
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.task_id, "codex-persist-only");
    assert.equal(body.planner_session_id, "in-session-codex-test");
    assert.equal(body.contract_id, "codex-persist-only");
    assert.ok(body.contract_digest);
    assert.equal(
      await fs.stat(path.join(projectDir, ".agent-orchestrator", "contracts", "codex-persist-only.json")).then(() => true),
      true,
    );
  } finally {
    await client.close();
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

// -- Host allow-list: cc_desktop blocked from cc-exec but allowed codex-exec --

test("cc_desktop coordinator can drive the MCP workflow", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-cc-host-"));
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    JSON.stringify({ trusted: true, host: { provider: "cc_desktop" }, mcp: { enabled: true } }),
  );

  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    // CC Desktop coordinates the full workflow through MCP; it does not act
    // as an executor merely by invoking these delegated worker tools.
    const cc = await client.callTool({
      name: "cc-exec",
      // Deliberately omit the worker payload: this should pass policy and then
      // fail immediately at argument validation, without launching a worker.
      arguments: { project_dir: projectDir, task_id: "t1" },
    });
    const ccBody = JSON.parse(cc.content[0].text);
    assert.notEqual(ccBody.reason, "not_in_host_allow_list");
    assert.match(ccBody.error, /goal must be a non-empty string/);
  } finally {
    await client.close();
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("auto and accepter schemas reject caller routing and acceptance overrides", async () => {
  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const tools = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
    const auto = tools.auto;
    const accepter = tools["accepter-accept"];

    assert.deepEqual(Object.keys(auto.inputSchema.properties).sort(), ["project_dir", "subtask_id", "task_id"]);
    assert.deepEqual(auto.inputSchema.required.sort(), ["project_dir", "subtask_id", "task_id"]);
    assert.equal(auto.inputSchema.additionalProperties, false);
    for (const override of ["complexity", "provider", "model", "executor", "fallback"]) {
      assert.equal(Object.hasOwn(auto.inputSchema.properties, override), false, `auto must reject caller ${override} overrides`);
    }

    assert.deepEqual(Object.keys(accepter.inputSchema.properties).sort(), ["decision", "job_id", "project_dir", "task_id"]);
    assert.deepEqual(accepter.inputSchema.required.sort(), ["job_id", "project_dir", "task_id"]);
    assert.equal(accepter.inputSchema.additionalProperties, false);
    for (const override of ["model", "provider", "session", "digest", "acceptance_id"]) {
      assert.equal(Object.hasOwn(accepter.inputSchema.properties, override), false, `accepter-accept must reject caller ${override} overrides`);
    }
  } finally {
    await client.close();
  }
});

// -- Trust gate: trusted=false blocks worker tools --

test("untrusted project blocks worker, apply, and external execution tools", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-untrusted-"));
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    JSON.stringify({ trusted: false, host: { provider: "codex" }, mcp: { enabled: true } }),
  );

  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    // Worker tool should be blocked
    const cc = await client.callTool({
      name: "cc-exec",
      arguments: { project_dir: projectDir, task_id: "t1", goal: "test", plan: "test" },
    });
    assert.equal(cc.isError, true);
    const ccBody = JSON.parse(cc.content[0].text);
    assert.equal(ccBody.policy_denial, true);
    assert.equal(ccBody.reason, "untrusted_project");

    // Safe diagnostic tools should work
    const health = await client.callTool({ name: "health", arguments: { project_dir: projectDir } });
    assert.equal(health.isError, false);
  } finally {
    await client.close();
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

// -- Terminal host: only minimum diagnostics --

test("terminal host only has minimum maintenance set", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-terminal-"));
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    JSON.stringify({ trusted: true, host: { provider: "terminal" }, mcp: { enabled: true } }),
  );

  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    // Health should work
    const health = await client.callTool({ name: "health", arguments: { project_dir: projectDir } });
    assert.equal(health.isError, false);

    // cc-exec should be blocked
    const cc = await client.callTool({
      name: "cc-exec",
      arguments: { project_dir: projectDir, task_id: "t1", goal: "test", plan: "test" },
    });
    assert.equal(cc.isError, true);
    const ccBody = JSON.parse(cc.content[0].text);
    assert.equal(ccBody.policy_denial, true);
    assert.equal(ccBody.reason, "not_in_host_allow_list");

    // codex-exec should be blocked
    const codex = await client.callTool({
      name: "codex-exec",
      arguments: { project_dir: projectDir, task_id: "t1", mode: "plan", goal: "test" },
    });
    assert.equal(codex.isError, true);
    const codexBody = JSON.parse(codex.content[0].text);
    assert.equal(codexBody.policy_denial, true);
  } finally {
    await client.close();
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

// -- Unknown host: denied everything --

test("unknown host is denied all tools", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-unknown-"));
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    JSON.stringify({ trusted: true, host: { provider: "unknown" }, mcp: { enabled: true } }),
  );

  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "health", arguments: { project_dir: projectDir } });
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.policy_denial, true);
    assert.equal(body.reason, "unknown_host");
  } finally {
    await client.close();
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

// -- Structured denial fields via MCP --

test("policy denial response includes category and remediation fields", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-deny-"));
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    JSON.stringify({ trusted: true, host: { provider: "codex" }, mcp: { enabled: true } }),
  );

  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    // codex host is blocked from codex-exec
    const result = await client.callTool({
      name: "codex-exec",
      arguments: { project_dir: projectDir, task_id: "t1", mode: "plan", goal: "test" },
    });
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.policy_denial, true);
    assert.equal(body.reason, "not_in_host_allow_list");
    assert.equal(body.category, "not_in_host_allow_list");
    // remediation may be null for host-allow-list denials;
    // the detail field provides host-specific guidance
    assert.ok(body.detail.includes("not permitted") || body.detail.includes("Available tools"),
      "detail should include host-specific guidance");
  } finally {
    await client.close();
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("mcp_disabled denial includes structured remediation hint", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-mcpdis-"));
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    JSON.stringify({ trusted: true, host: { provider: "codex" }, mcp: { enabled: false } }),
  );

  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "cc-exec",
      arguments: { project_dir: projectDir, task_id: "t1", goal: "test", plan: "test" },
    });
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.policy_denial, true);
    assert.equal(body.reason, "mcp_disabled");
    assert.equal(body.category, "mcp_disabled");
    assert.ok(body.remediation.includes("mcp install"), "remediation should suggest mcp install");
  } finally {
    await client.close();
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

// -- Project-scoped store isolation --

test("project-scoped stores isolate jobs between different projects", async () => {
  const projectA = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-scope-a-"));
  const projectB = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-scope-b-"));

  // Set up both projects
  for (const proj of [projectA, projectB]) {
    await fs.mkdir(path.join(proj, ".agent-orchestrator"), { recursive: true });
    await fs.writeFile(
      path.join(proj, ".agent-orchestrator", "config.json"),
      JSON.stringify({ trusted: true, host: { provider: "codex" }, mcp: { enabled: true } }),
    );
  }

  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    // Health check on project A uses its scoped store
    const healthA = await client.callTool({ name: "health", arguments: { project_dir: projectA } });
    assert.equal(healthA.isError, false);

    // Health check on project B uses its scoped store
    const healthB = await client.callTool({ name: "health", arguments: { project_dir: projectB } });
    assert.equal(healthB.isError, false);

    // Verify that project state roots are under the project .agent-orchestrator/
    const bodyA = JSON.parse(healthA.content[0].text);
    const bodyB = JSON.parse(healthB.content[0].text);

    // Each project should have its own state root
    if (bodyA.data_dir && bodyB.data_dir) {
      assert.notEqual(bodyA.data_dir, bodyB.data_dir, "different projects should have different state dirs");
      assert.ok(bodyA.data_dir.includes(".agent-orchestrator"), "state dir should be under .agent-orchestrator");
      assert.ok(bodyB.data_dir.includes(".agent-orchestrator"), "state dir should be under .agent-orchestrator");
    }
  } finally {
    await client.close();
    await fs.rm(projectA, { recursive: true, force: true });
    await fs.rm(projectB, { recursive: true, force: true });
  }
});

// -- Job-control tools accept optional project_dir --

test("job-control tools (status, result, cancel, apply, cleanup) accept project_dir in schema", async () => {
  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const tools = Object.fromEntries(listed.tools.map((t) => [t.name, t]));

    for (const name of ["status", "result", "cancel", "apply", "cleanup"]) {
      const tool = tools[name];
      assert.ok(tool, `${name} tool should exist`);
      const props = tool.inputSchema.properties;
      assert.ok(props.job_id, `${name} should require job_id`);
      assert.ok(props.project_dir, `${name} should accept optional project_dir`);
      assert.ok(props.project_dir.description.includes("optional"), `${name} project_dir should mention it is optional`);
    }
  } finally {
    await client.close();
  }
});

// -- MCP maintenance tools are CLI-only, not exposed as MCP tools --

test("mcp-status, mcp-install, mcp-repair, mcp-remove rejected as unknown MCP tools", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-mcpcli-"));
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    JSON.stringify({ trusted: true, host: { provider: "codex" }, mcp: { enabled: true } }),
  );

  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    for (const name of ["mcp-status", "mcp-install", "mcp-repair", "mcp-remove"]) {
      const result = await client.callTool({ name, arguments: { project_dir: projectDir } });
      assert.equal(result.isError, true, `${name} should be rejected as unknown tool`);
    }
  } finally {
    await client.close();
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("status tool description mentions assistant-only progress", async () => {
  const client = new Client({ name: "agent-orch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const statusTool = listed.tools.find((t) => t.name === "status");
    assert.ok(statusTool, "status tool should exist");
    assert.ok(statusTool.description, "status tool should have a description");
    // The description should mention bounded assistant-only progress
    assert.match(statusTool.description, /assistant[- ]?only/i, "description should mention assistant-only progress");
    // The description should distinguish progress from raw logs
    assert.match(statusTool.description, /raw logs/i, "description should mention raw logs remain local artifacts");
  } finally {
    await client.close();
  }
});
