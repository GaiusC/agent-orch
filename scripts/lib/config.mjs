import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deepMerge, pathExists, readJson } from "./utils.mjs";
import { ccExecutorModel, normalizeTier, reviewerModel } from "./model-registry.mjs";

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
    in_session_roles: ["coordinator"],
  },
  providers: {
    codex: {
      roles: ["planner", "accepter"],
      external_invocation: "disabled_when_host_is_codex",
      invocation: "in_session_when_host_is_codex",
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
    executor_priority: ["cc", "agy"],
    agy_executor_runtime_failure_threshold: 2,
  },
  review_gate: {
    require_reviewer_for_implementation: true,
    require_agy_verify_for_implementation: true,
    allow_waiver: true,
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
    agy_env: {},
  },
  agy: {
    enabled: true,
    launch: "cli",
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
    codex: { planner: "gpt-5.6-sol", accepter: "gpt-5.6-sol", reasoning_effort: "high" },
    cc: { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" },
    agy: { low: "gemini-3.5-flash", medium: "gemini-3.5-flash", high: "gemini-3.1-pro" },
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

export function projectPlansRoot(projectDir) {
  return path.join(projectOrchestratorRoot(projectDir), "plans");
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

export function chooseModel(config, provider, complexity = "medium", modelOverride) {
  if (modelOverride) return modelOverride;
  const tier = normalizeTier(complexity);
  if (provider === "cc") return ccExecutorModel(tier, config).canonical_id;
  if (provider === "agy") return reviewerModel(tier, config).canonical_id;
  throw new Error(`Unknown model provider: ${provider}`);
}

export function chooseAgyWriteModel(config, complexity = "medium") {
  const level = normalizeTier(complexity);
  const override = config.models?.agy_write?.[level] || (level === "mid" ? config.models?.agy_write?.medium : null);
  if (override) return override;
  // Provider-aware calibration: CC-high ~ AGY-medium/Sonnet; AGY-high/Opus for exceptional risk.
  if (level === "mid") return "Claude Sonnet 4.6 (Thinking)";
  if (level === "high") return "Claude Opus 4.6 (Thinking)";
  return "Claude Sonnet 4.6 (Thinking)";
}

export function autoRouteProvider(config, complexity) {
  normalizeTier(complexity);
  // A missing policy is normalized to the documented CC-first default; it is
  // not a caller override and remains centralized here.
  const priority = config.routing?.executor_priority || ["cc"];
  if (!Array.isArray(priority) || priority.length === 0) throw new Error("executor_priority must be a non-empty centralized policy");
  const provider = priority[0];
  if (!['cc', 'agy'].includes(provider)) throw new Error(`Unknown executor priority provider: ${provider}`);
  return provider;
}
