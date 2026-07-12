import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHost, validateHostToolTrust, HOST_TOOL_ALLOW_LISTS } from "../scripts/lib/policy.mjs";

// -- Host normalization --

test("normalizeHost returns known hosts unchanged", () => {
  assert.equal(normalizeHost("codex"), "codex");
  assert.equal(normalizeHost("cc_desktop"), "cc_desktop");
  assert.equal(normalizeHost("claude_desktop"), "claude_desktop");
  assert.equal(normalizeHost("terminal"), "terminal");
  assert.equal(normalizeHost("unknown"), "unknown");
});

test("normalizeHost maps claude to claude_desktop", () => {
  assert.equal(normalizeHost("claude"), "claude_desktop");
});

test("normalizeHost maps unknown strings to unknown", () => {
  assert.equal(normalizeHost("random"), "unknown");
  assert.equal(normalizeHost(""), "unknown");
});

test("normalizeHost is case-insensitive and handles dashes/underscores", () => {
  assert.equal(normalizeHost("Codex"), "codex");
  assert.equal(normalizeHost("CC-DESKTOP"), "cc_desktop");
  assert.equal(normalizeHost("Claude_Desktop"), "claude_desktop");
});

// -- Tool allow-lists structure --

test("every known host has an allow-list entry", () => {
  for (const host of ["codex", "cc_desktop", "claude_desktop", "terminal", "unknown"]) {
    assert.ok(Array.isArray(HOST_TOOL_ALLOW_LISTS[host]), `${host} must have an allow-list`);
  }
});

test("codex host cannot call codex-exec or planner-plan", () => {
  const codex = HOST_TOOL_ALLOW_LISTS.codex;
  assert.equal(codex.includes("codex-exec"), false, "codex must not self-invoke codex-exec");
  assert.equal(codex.includes("codex-continue"), false, "codex must not self-invoke codex-continue");
  assert.equal(codex.includes("planner-plan"), false, "codex must not use planner-plan");
});

test("codex host can call workers, reviewers, and job controls", () => {
  const codex = HOST_TOOL_ALLOW_LISTS.codex;
  assert.ok(codex.includes("cc-exec"));
  assert.ok(codex.includes("cc-continue"));
  assert.ok(codex.includes("agy-exec"));
  assert.ok(codex.includes("agy-continue"));
  assert.ok(codex.includes("auto"));
  assert.ok(codex.includes("reviewer-investigate"));
  assert.ok(codex.includes("reviewer-verify"));
  assert.ok(codex.includes("accepter-accept"));
  assert.ok(codex.includes("status"));
  assert.ok(codex.includes("result"));
  assert.ok(codex.includes("cancel"));
  assert.ok(codex.includes("apply"));
  assert.ok(codex.includes("cleanup"));
  assert.ok(codex.includes("health"));
});

test("cc_desktop coordinator can call delegated workers, reviewers, acceptance, and apply", () => {
  const cc = HOST_TOOL_ALLOW_LISTS.cc_desktop;
  assert.ok(cc.includes("cc-exec"));
  assert.ok(cc.includes("cc-continue"));
  assert.ok(cc.includes("agy-exec"));
  assert.ok(cc.includes("agy-continue"));
  assert.ok(cc.includes("auto"));
  assert.ok(cc.includes("reviewer-investigate"));
  assert.ok(cc.includes("reviewer-verify"));
  assert.ok(cc.includes("accepter-accept"));
  assert.ok(cc.includes("apply"));
});

test("cc_desktop can call codex-exec, planner-plan, and maintenance tools", () => {
  const cc = HOST_TOOL_ALLOW_LISTS.cc_desktop;
  assert.ok(cc.includes("health"));
  assert.ok(cc.includes("codex-exec"));
  assert.ok(cc.includes("codex-continue"));
  assert.ok(cc.includes("planner-plan"));
  assert.ok(cc.includes("status"));
  assert.ok(cc.includes("result"));
  assert.ok(cc.includes("cleanup"));
  assert.ok(cc.includes("cancel"));
});

test("terminal only has minimum maintenance set", () => {
  const term = HOST_TOOL_ALLOW_LISTS.terminal;
  assert.ok(term.includes("health"));
  assert.ok(term.includes("status"));
  assert.ok(term.includes("result"));
  assert.ok(term.includes("cleanup"));
  assert.ok(term.includes("cancel"));
  assert.equal(term.includes("cc-exec"), false);
  assert.equal(term.includes("apply"), false);
  assert.equal(term.includes("codex-exec"), false);
  // MCP maintenance is CLI-only, not in MCP tool allow-lists
  assert.equal(term.includes("mcp-status"), false);
  assert.equal(term.includes("mcp-install"), false);
  assert.equal(term.includes("mcp-repair"), false);
  assert.equal(term.includes("mcp-remove"), false);
});

test("unknown host has empty allow-list", () => {
  assert.deepEqual(HOST_TOOL_ALLOW_LISTS.unknown, []);
});

// -- validateHostToolTrust: MCP gate --

test("mcpEnabled=false blocks all tools except health", () => {
  for (const tool of ["cc-exec", "auto", "status", "apply", "codex-exec", "planner-plan"]) {
    const result = validateHostToolTrust({ host: "codex", tool, trusted: true, mcpEnabled: false });
    assert.equal(result.allowed, false, `${tool} should be blocked when mcp disabled`);
    assert.equal(result.reason, "mcp_disabled");
  }
  // health should work even when mcp is disabled
  const health = validateHostToolTrust({ host: "codex", tool: "health", trusted: true, mcpEnabled: false });
  assert.equal(health.allowed, true);
  // MCP maintenance tools (mcp-status, etc.) are CLI-only and NOT available as MCP tools
  for (const tool of ["mcp-status", "mcp-install", "mcp-repair", "mcp-remove"]) {
    const result = validateHostToolTrust({ host: "codex", tool, trusted: true, mcpEnabled: false });
    assert.equal(result.allowed, false, `${tool} should be blocked (CLI-only, not MCP tool) when mcp disabled`);
  }
});

test("mcpEnabled=true allows normal tool validation", () => {
  const result = validateHostToolTrust({ host: "codex", tool: "cc-exec", trusted: true, mcpEnabled: true });
  assert.equal(result.allowed, true);
});

// -- validateHostToolTrust: Unknown host --

test("unknown host is denied all tools", () => {
  const result = validateHostToolTrust({ host: "unknown", tool: "health", trusted: true, mcpEnabled: true });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "unknown_host");
});

// -- validateHostToolTrust: Trust gate --

test("trusted=false blocks worker/executor/apply tools", () => {
  const blocked = ["cc-exec", "agy-exec", "auto", "apply", "codex-exec", "codex-continue", "planner-plan", "reviewer-investigate", "reviewer-verify"];
  for (const tool of blocked) {
    const result = validateHostToolTrust({ host: "codex", tool, trusted: false, mcpEnabled: true });
    assert.equal(result.allowed, false, `${tool} should be blocked when untrusted`);
    assert.equal(result.reason, "untrusted_project", `${tool} reason should be untrusted_project`);
  }
});

test("trusted=false allows safe diagnostic tools", () => {
  const allowed = ["health", "status", "result", "cleanup", "cancel"];
  for (const tool of allowed) {
    const result = validateHostToolTrust({ host: "codex", tool, trusted: false, mcpEnabled: true });
    assert.equal(result.allowed, true, `${tool} should be allowed even when untrusted`);
  }
});

// -- validateHostToolTrust: Host allow-list --

test("codex tools not in codex allow-list are denied", () => {
  const result = validateHostToolTrust({ host: "codex", tool: "codex-exec", trusted: true, mcpEnabled: true });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "not_in_host_allow_list");
});

test("cc_desktop can use both Codex coordination and delegated worker tools", () => {
  const codexExec = validateHostToolTrust({ host: "cc_desktop", tool: "codex-exec", trusted: true, mcpEnabled: true });
  assert.equal(codexExec.allowed, true);

  const ccExec = validateHostToolTrust({ host: "cc_desktop", tool: "cc-exec", trusted: true, mcpEnabled: true });
  assert.equal(ccExec.allowed, true);
});

test("terminal can use health but not auto", () => {
  const health = validateHostToolTrust({ host: "terminal", tool: "health", trusted: true, mcpEnabled: true });
  assert.equal(health.allowed, true);

  const auto = validateHostToolTrust({ host: "terminal", tool: "auto", trusted: true, mcpEnabled: true });
  assert.equal(auto.allowed, false);
});

// -- Denial details are structured --

test("denial response includes reason, detail, host, tool, category, and remediation", () => {
  const result = validateHostToolTrust({ host: "codex", tool: "codex-exec", trusted: true, mcpEnabled: true });
  assert.equal(result.allowed, false);
  assert.ok(typeof result.reason === "string");
  assert.ok(typeof result.detail === "string");
  assert.ok(typeof result.category === "string");
  assert.equal(result.host, "codex");
  assert.equal(result.tool, "codex-exec");
  // category must be present in structured denials
  assert.equal(result.category, "not_in_host_allow_list");
  // remediation may be null for not_in_host_allow_list (host-specific),
  // but the detail field provides concrete guidance
  assert.ok(result.detail.includes("not permitted") || result.detail.includes("Available tools"),
    "detail should include host-specific guidance");
});

test("mcp_disabled denial includes category and remediation", () => {
  const result = validateHostToolTrust({ host: "codex", tool: "cc-exec", trusted: true, mcpEnabled: false });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "mcp_disabled");
  assert.equal(result.category, "mcp_disabled");
  assert.ok(result.remediation.includes("mcp install"), "remediation should mention mcp install");
});

test("untrusted_project denial includes category and remediation", () => {
  const result = validateHostToolTrust({ host: "codex", tool: "cc-exec", trusted: false, mcpEnabled: true });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "untrusted_project");
  assert.equal(result.category, "untrusted_project");
  assert.ok(result.remediation.includes("trusted"), "remediation should mention trusted");
});

test("unknown_host denial includes category and remediation", () => {
  const result = validateHostToolTrust({ host: "unknown", tool: "health", trusted: true, mcpEnabled: true });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "unknown_host");
  assert.equal(result.category, "unknown_host");
  assert.ok(result.remediation.includes("host.provider"), "remediation should mention host.provider");
});

// -- Full matrix: host x tool x trust x mcp --

test("full matrix: codex x all tools x trusted=true x mcpEnabled=true", () => {
  const codexAllowed = HOST_TOOL_ALLOW_LISTS.codex;
  const allTools = ["cc-exec", "cc-continue", "agy-exec", "agy-continue", "auto", "reviewer-investigate", "reviewer-verify", "accepter-accept", "status", "result", "cancel", "apply", "cleanup", "health", "codex-exec", "codex-continue", "planner-plan"];
  for (const tool of allTools) {
    const result = validateHostToolTrust({ host: "codex", tool, trusted: true, mcpEnabled: true });
    if (codexAllowed.includes(tool)) {
      assert.equal(result.allowed, true, `codex should be allowed to use ${tool}`);
    } else {
      assert.equal(result.allowed, false, `codex should NOT be allowed to use ${tool}`);
    }
  }
});

test("full matrix: cc_desktop x all tools x trusted=true x mcpEnabled=true", () => {
  const ccAllowed = HOST_TOOL_ALLOW_LISTS.cc_desktop;
  const allTools = ["cc-exec", "cc-continue", "agy-exec", "agy-continue", "auto", "reviewer-investigate", "reviewer-verify", "accepter-accept", "status", "result", "cancel", "apply", "cleanup", "health", "codex-exec", "codex-continue", "planner-plan"];
  for (const tool of allTools) {
    const result = validateHostToolTrust({ host: "cc_desktop", tool, trusted: true, mcpEnabled: true });
    if (ccAllowed.includes(tool)) {
      assert.equal(result.allowed, true, `cc_desktop should be allowed to use ${tool}`);
    } else {
      assert.equal(result.allowed, false, `cc_desktop should NOT be allowed to use ${tool}`);
    }
  }
});
