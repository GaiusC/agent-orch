import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deepMerge, pathExists, readJson } from "./utils.mjs";

export const DEFAULT_CONFIG = {
  version: 1,
  mode: "cli",
  trusted: false,
  mcp: {
    enabled: false,
  },
  roles: {
    primary_writer: "cc",
    specialist: "agy",
    duplicate_implementation: false,
  },
  host: {
    provider: "unknown",
    in_session_roles: ["planner", "accepter"],
  },
  providers: {
    codex: {
      roles: ["planner", "accepter"],
      external_invocation: "disabled_when_host_is_codex",
    },
    cc: {
      roles: ["executor"],
      invocation: "cli",
    },
    agy: {
      roles: ["reviewer", "executor_fallback"],
      invocation: "cli",
    },
  },
  routing: {
    auto: "cc_first",
    agy_write_fallback_to_cc_on_quota: true,
    cc_verify_fail_escalate_to_agy: true,
  },
  cli: {
    claude: process.env.AGENT_ORCH_CLAUDE_BIN || process.env.EAO_CLAUDE_BIN || "claude",
    agy: process.env.AGENT_ORCH_AGY_BIN || process.env.EAO_AGY_BIN || "agy",
    claude_prefix_args: [],
    claude_permission_mode: "bypassPermissions",
    agy_prefix_args: [],
    agy_sandbox: false,
    agy_project: null,
    agy_project_id: null,
  },
  agy: {
    enabled: true,
    launch: "codex_cli",
    auth_probe_required: true,
    fail_fast_on_auth_window: true,
  },
  execution: {
    workspace_mode: "isolated",
    allow_dirty_in_place: false,
    max_cc_repair_rounds: 2,
    cc_timeout_seconds: 1800,
    agy_timeout_seconds: 900,
    agy_write_timeout_seconds: 1800,
    max_log_bytes: 4 * 1024 * 1024,
    max_result_chars: 8000,
  },
  models: {
    cc: { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" },
    agy: { low: "Gemini 3.5 Flash", medium: "Gemini 3.1 Pro", high: "Gemini 3.1 Pro" },
    agy_write: {
      low: null,
      medium: "Claude Sonnet 4.6 (Thinking)",
      high: "Claude Opus 4.6 (Thinking)",
    },
  },
  scope: {
    writable: ["."],
    forbidden: [".git/", ".env", ".env.*"],
  },
  verification: {
    commands: [],
  },
};

export const CC_MODEL_DEFAULTS = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };

export function dataRoot() {
  return path.resolve(process.env.AGENT_ORCH_DATA_DIR || process.env.EAO_DATA_DIR || path.join(os.homedir(), ".agent-orch"));
}

export function projectOrchestratorRoot(projectDir) {
  return path.join(path.resolve(projectDir), ".agent-orchestrator");
}

export function projectStateRoot(projectDir) {
  return path.join(projectOrchestratorRoot(projectDir), "state");
}

export function projectRunsRoot(projectDir) {
  return path.join(projectOrchestratorRoot(projectDir), "runs");
}

export async function loadProjectConfig(projectDir) {
  const root = path.resolve(projectDir);
  const candidates = [
    path.join(root, ".agent-orchestrator", "config.json"),
    path.join(root, ".agent-orchestrator.json"),
  ];
  let source;
  let projectConfig = {};
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      projectConfig = await readJson(candidate);
      source = candidate;
      break;
    }
  }
  const config = deepMerge(DEFAULT_CONFIG, projectConfig);
  config.cli.claude = process.env.AGENT_ORCH_CLAUDE_BIN || process.env.EAO_CLAUDE_BIN || config.cli.claude;
  config.cli.agy = process.env.AGENT_ORCH_AGY_BIN || process.env.EAO_AGY_BIN || config.cli.agy;
  // Normalize null CC model values from legacy configs to two-tier defaults.
  if (!config.models) config.models = {};
  if (!config.models.cc) config.models.cc = {};
  for (const level of ["low", "medium", "high"]) {
    if (!config.models.cc[level]) config.models.cc[level] = CC_MODEL_DEFAULTS[level];
  }
  config.project_dir = root;
  config.source = source ?? null;
  return config;
}

export async function assertProject(projectDir, { requireTrusted = true } = {}) {
  const root = path.resolve(projectDir);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Project directory does not exist: ${root}`);
  const config = await loadProjectConfig(root);
  if (requireTrusted && !config.trusted) {
    throw new Error(`Project is not trusted. Create .agent-orchestrator/config.json with \"trusted\": true after reviewing it.`);
  }
  return config;
}

export function chooseModel(config, provider, complexity = "medium", override) {
  if (override) return override;
  const level = ["low", "medium", "high"].includes(complexity) ? complexity : "medium";
  const value = config.models?.[provider]?.[level];
  if (value) return value;
  // Fall back to CC two-tier defaults when value is null or missing.
  if (provider === "cc" && CC_MODEL_DEFAULTS[level]) return CC_MODEL_DEFAULTS[level];
  return undefined;
}

export function chooseAgyWriteModel(config, complexity = "medium") {
  const level = ["low", "medium", "high"].includes(complexity) ? complexity : "medium";
  const override = config.models?.agy_write?.[level];
  if (override) return override;
  // Provider-aware calibration: CC-high ~ AGY-medium/Sonnet; AGY-high/Opus for exceptional risk.
  if (level === "medium") return "Claude Sonnet 4.6 (Thinking)";
  if (level === "high") return "Claude Opus 4.6 (Thinking)";
  return null;
}

export function autoRouteProvider(config, complexity) {
  const policy = config.routing?.auto || "cc_first";
  // cc_first (default): all complexities start with CC; AGY escalation after CC verify failure.
  // Legacy values: "agy_preferred" (low -> CC, medium/high -> AGY write) and "cc" (all -> CC).
  if (policy === "cc_first") {
    return "cc";
  }
  if (policy === "agy_preferred" || policy === "agy") {
    if (complexity === "low") return "cc";
    return "agy";
  }
  // policy === "cc": all complexities route to CC (legacy default)
  return "cc";
}
