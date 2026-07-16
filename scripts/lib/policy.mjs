// Shared core policy: host identity, tool allow-lists, MCP gate, trust decisions.
// This module is the single source of truth for what each host is permitted to do
// via MCP tools.  Every MCP tool call must pass validateHostToolTrust before
// reaching lower-layer orchestration.

// -- Valid host identities --

export const VALID_HOSTS = new Set([
  "codex",
  "cc_desktop",
  "claude_desktop",
  "terminal",
  "unknown",
]);

export function normalizeHost(value) {
  const normalized = String(value || "unknown").trim().toLowerCase().replaceAll("-", "_");
  if (VALID_HOSTS.has(normalized)) return normalized;
  if (normalized === "claude") return "claude_desktop";
  return "unknown";
}

// -- Denial categories for structured responses --

export const DENIAL_CATEGORIES = {
  mcp_disabled: {
    category: "mcp_disabled",
    remediation: 'Set "mcp.enabled": true in .agent-orchestrator/config.json or run \'agent-orch mcp install\' to enable MCP for this project.',
  },
  unknown_host: {
    category: "unknown_host",
    remediation: 'Set "host.provider" in .agent-orchestrator/config.json to "codex", "cc_desktop", "claude_desktop", or "terminal", then resume the project.',
  },
  untrusted_project: {
    category: "untrusted_project",
    remediation: 'Review .agent-orchestrator/config.json and set "trusted": true after verifying the repository contents and scope.',
  },
  not_in_host_allow_list: {
    category: "not_in_host_allow_list",
    remediation: null, // Filled per-host below
  },
};

// -- Tool allow-lists per host --

// Tools that read state but never mutate project files or launch external workers.
const SAFE_DIAGNOSTIC_TOOLS = [
  "health",
  "status",
  "result",
  "cleanup",
  "cancel",
];

// Codex may persist its in-session plan, use CC/AGY workers, auto, reviewers,
// job controls, and diagnostic tools. planner-plan is persist-only: it records
// the contract produced by the current Codex host and does not invoke Codex CLI.
// Codex must NOT self-invoke via codex-exec / codex-continue.
// MCP maintenance (mcp status|install|repair|remove) is CLI-only.
const CODEX_TOOLS = [
  "stage-plan",
  "stage-work",
  "stage-work-continue",
  "stage-review",
  "stage-accept",
  "wait-for-job",
  "cc-exec",
  "cc-continue",
  "agy-exec",
  "agy-continue",
  "auto",
  "reviewer-investigate",
  "reviewer-verify",
  "planner-plan",
  "accepter-accept",
  "status",
  "result",
  "cancel",
  "apply",
  "cleanup",
  "health",
];

// CC Desktop is a coordinator.  It can drive the complete MCP workflow, but
// never becomes an executor itself: cc-exec/agy-exec start external workers.
// MCP maintenance remains CLI-only.
const CC_DESKTOP_TOOLS = [
  "stage-plan",
  "stage-work",
  "stage-work-continue",
  "stage-review",
  "stage-accept",
  "wait-for-job",
  "health",
  "codex-exec",
  "codex-continue",
  "planner-plan",
  "cc-exec",
  "cc-continue",
  "agy-exec",
  "agy-continue",
  "auto",
  "reviewer-investigate",
  "reviewer-verify",
  "accepter-accept",
  "status",
  "result",
  "cleanup",
  "cancel",
  "apply",
];

// Terminal gets diagnostic tools only.
// MCP maintenance is CLI-only.
const TERMINAL_TOOLS = [
  "health",
  "wait-for-job",
  "status",
  "result",
  "cleanup",
  "cancel",
];

// Unknown hosts are denied every tool.
const UNKNOWN_TOOLS = [];

export const HOST_TOOL_ALLOW_LISTS = {
  codex: CODEX_TOOLS,
  cc_desktop: CC_DESKTOP_TOOLS,
  claude_desktop: CC_DESKTOP_TOOLS,
  terminal: TERMINAL_TOOLS,
  unknown: UNKNOWN_TOOLS,
};

// -- Validation --

function buildDenial({ allowed, reason, detail, host, tool, category, remediation }) {
  return {
    allowed,
    reason,
    detail,
    host,
    tool,
    category: category || reason,
    remediation: remediation || DENIAL_CATEGORIES[reason]?.remediation || null,
  };
}

/**
 * Validate whether a host may call a given MCP tool under the current trust
 * and MCP-enabled settings.  Returns `{ allowed: false, ...denial }` on
 * rejection, or `{ allowed: true }` when the call may proceed.
 *
 * Checks are applied in order:
 *  1. MCP gate          – mcp.enabled must be true for non-health tools.
 *  2. Host recognition  – unknown hosts are denied.
 *  3. Trust gate        – trusted=false blocks worker/planner/apply tools.
 *  4. Tool allow-list   – host-specific explicit allow-list.
 */
export function validateHostToolTrust({ host, tool, trusted, mcpEnabled }) {
  const normalizedHost = normalizeHost(host);

  // 1. MCP gate: when mcp.enabled is false, only health is permitted.
  //    MCP maintenance (status, install, repair, remove) is CLI-only via
  //    `agent-orch mcp <subcommand>`, not through MCP tools.
  if (!mcpEnabled) {
    if (tool === "health") return { allowed: true };
    return buildDenial({
      allowed: false,
      reason: "mcp_disabled",
      detail: `MCP is disabled for this project. Set "mcp.enabled": true in .agent-orchestrator/config.json or run 'agent-orch mcp install' to enable it. Only the health tool is available when MCP is disabled.`,
      host: normalizedHost,
      tool,
      category: "mcp_disabled",
    });
  }

  // 2. Unknown hosts are denied everything.
  if (normalizedHost === "unknown") {
    return buildDenial({
      allowed: false,
      reason: "unknown_host",
      detail: `Host identity could not be determined. Set "host.provider" in .agent-orchestrator/config.json to "codex", "cc_desktop", "claude_desktop", or "terminal", then resume the project. Unknown hosts are not permitted to use any MCP tools.`,
      host: normalizedHost,
      tool,
      category: "unknown_host",
    });
  }

  const allowList = HOST_TOOL_ALLOW_LISTS[normalizedHost] || [];

  // 3. Trust gate: when trusted=false, only safe diagnostics
  //    are allowed.  Worker/executor/apply tools are blocked.
  if (!trusted) {
    if (SAFE_DIAGNOSTIC_TOOLS.includes(tool)) {
      if (tool === "health") return { allowed: true };
      // status/result/cleanup/cancel still need the host allow-list check
      if (allowList.includes(tool)) return { allowed: true };
      return buildDenial({
        allowed: false,
        reason: "not_in_host_allow_list",
        detail: `Host "${normalizedHost}" is not permitted to use the "${tool}" tool.`,
        host: normalizedHost,
        tool,
        category: "not_in_host_allow_list",
      });
    }
    // Worker, external execution, and apply are consistently blocked.
    return buildDenial({
      allowed: false,
      reason: "untrusted_project",
      detail: `The project is not trusted (trusted: false). Only safe diagnostic tools (${SAFE_DIAGNOSTIC_TOOLS.join(", ")}) are available. Worker execution, external Codex invocation, and apply are blocked. Review .agent-orchestrator/config.json and set "trusted": true after verifying the repository.`,
      host: normalizedHost,
      tool,
      category: "untrusted_project",
    });
  }

  // 4. Host tool allow-list: the tool must be in the host's explicit allow-list.
  if (!allowList.includes(tool)) {
    if (tool === "health") return { allowed: true }; // health is always allowed for recognized trusted hosts
    const available = allowList.length
      ? `Available tools for host "${normalizedHost}": ${allowList.join(", ")}.`
      : `Host "${normalizedHost}" is not permitted to use any MCP tools.`;
    return buildDenial({
      allowed: false,
      reason: "not_in_host_allow_list",
      detail: `Host "${normalizedHost}" is not permitted to use the "${tool}" tool. ${available}`,
      host: normalizedHost,
      tool,
      category: "not_in_host_allow_list",
    });
  }

  return { allowed: true };
}
