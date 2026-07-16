import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deepMerge, pathExists, readJson } from "./utils.mjs";
import { ccExecutorModel, normalizeTier, reviewerModel } from "./model-registry.mjs";

export const DEFAULT_CODEX_MCP_MODEL = "gpt-5.6-terra";
const INCOMPATIBLE_CODEX_MCP_MODELS = new Map([
  ["gpt-5.6-sol", DEFAULT_CODEX_MCP_MODEL],
]);

export const DEFAULT_CONFIG = {
  version: 2,
  mode: "cli",
  trusted: false,
  mcp: {
    enabled: false,
    expose_provider_tools: false,
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
    codex: process.env.AGENT_ORCH_CODEX_BIN || process.env.EAO_CODEX_BIN || "codex",
    claude_prefix_args: [],
    claude_permission_mode: "bypassPermissions",
    agy_prefix_args: [],
    agy_sandbox: false,
    agy_project: null,
    agy_project_id: null,
    agy_env: {},
    agy_write_permission_mode: "dangerously-skip-permissions",
    codex_worker_allow_windows_sandbox_bypass: true,
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
    codex_worker_timeout_seconds: 1800,
    max_log_bytes: 4 * 1024 * 1024,
    max_result_chars: 8000,
  },
  models: {
    codex: { planner: DEFAULT_CODEX_MCP_MODEL, accepter: DEFAULT_CODEX_MCP_MODEL, reasoning_effort: "high" },
    cc: { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" },
    agy: { low: "Gemini 3.5 Flash (Low)", medium: "Gemini 3.5 Flash (High)", high: "Gemini 3.1 Pro (High)" },
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
  stages: {
    plan: {
      default_complexity: "high",
      routes: {
        low: [{ provider: "codex", model: DEFAULT_CODEX_MCP_MODEL, invocation: "in_session" }],
        medium: [{ provider: "codex", model: DEFAULT_CODEX_MCP_MODEL, invocation: "in_session" }],
        high: [{ provider: "codex", model: DEFAULT_CODEX_MCP_MODEL, invocation: "in_session" }],
      },
    },
    work: {
      default_complexity: "medium",
      routes: {
        low: [
          { provider: "cc", model: "deepseek-v4-flash" },
          { provider: "agy_write", model: "Claude Sonnet 4.6 (Thinking)" },
          { provider: "codex_worker", model: null },
        ],
        medium: [
          { provider: "cc", model: "deepseek-v4-flash" },
          { provider: "agy_write", model: "Claude Sonnet 4.6 (Thinking)" },
          { provider: "codex_worker", model: null },
        ],
        high: [
          { provider: "cc", model: "deepseek-v4-pro" },
          { provider: "agy_write", model: "Claude Opus 4.6 (Thinking)" },
          { provider: "codex_worker", model: null },
        ],
      },
    },
    review: {
      default_complexity: "medium",
      routes: {
        low: [{ provider: "agy", model: "Gemini 3.5 Flash (Low)" }],
        medium: [{ provider: "agy", model: "Gemini 3.5 Flash (High)" }],
        high: [{ provider: "agy", model: "Gemini 3.1 Pro (High)" }],
      },
    },
    accept: {
      inherit_from: "plan",
    },
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
  const migrated = migrateProjectConfig(projectConfig);
  const config = deepMerge(DEFAULT_CONFIG, migrated);
  config.cli.claude = process.env.AGENT_ORCH_CLAUDE_BIN || process.env.EAO_CLAUDE_BIN || config.cli.claude;
  config.cli.agy = process.env.AGENT_ORCH_AGY_BIN || process.env.EAO_AGY_BIN || config.cli.agy;
  config.cli.codex = process.env.AGENT_ORCH_CODEX_BIN || process.env.EAO_CODEX_BIN || config.cli.codex;
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

function route(provider, model, invocation = "cli") {
  return { provider, model: model || null, invocation };
}

function legacyWorkProviders(config) {
  const explicit = config.routing?.executor_priority;
  if (Array.isArray(explicit) && explicit.length) {
    return explicit.map((provider) => provider === "agy" ? "agy_write" : provider);
  }
  if (config.routing?.auto === "agy_preferred") return ["agy_write", "cc", "codex_worker"];
  return ["cc", "agy_write", "codex_worker"];
}

function migrateLegacyAgyModel(value, fallback) {
  const known = {
    "gemini-3.5-flash": "Gemini 3.5 Flash (Low)",
    "Gemini 3.5 Flash": "Gemini 3.5 Flash (Low)",
    "gemini-3.1-pro": "Gemini 3.1 Pro (High)",
    "Gemini 3.1 Pro": "Gemini 3.1 Pro (High)",
  };
  return known[value] || value || fallback;
}

export function migrateCodexMcpModel(value, fallback = DEFAULT_CODEX_MCP_MODEL) {
  if (!value) return fallback;
  return INCOMPATIBLE_CODEX_MCP_MODELS.get(value) || value;
}

function migrateCodexMcpModels(config) {
  const migratedFrom = new Set();
  if (!config.models) config.models = {};
  if (!config.models.codex) config.models.codex = {};
  for (const role of ["planner", "accepter"]) {
    const current = config.models.codex[role];
    const next = migrateCodexMcpModel(current);
    if (current && current !== next) migratedFrom.add(current);
    config.models.codex[role] = next;
  }
  const routes = config.stages?.plan?.routes;
  if (routes && typeof routes === "object") {
    for (const complexity of ["low", "medium", "high"]) {
      if (!Array.isArray(routes[complexity])) continue;
      routes[complexity] = routes[complexity].map((entry) => {
        if (entry?.provider !== "codex" || entry?.invocation !== "in_session") return entry;
        const nextModel = migrateCodexMcpModel(entry.model);
        if (entry.model && entry.model !== nextModel) migratedFrom.add(entry.model);
        return { ...entry, model: nextModel };
      });
    }
  }
  if (migratedFrom.size) {
    config.migration = {
      ...(config.migration || {}),
      codex_mcp_model_from: [...migratedFrom],
      codex_mcp_model_to: DEFAULT_CODEX_MCP_MODEL,
    };
  }
  return config;
}

export function migrateProjectConfig(projectConfig = {}) {
  if (!projectConfig || typeof projectConfig !== "object" || Array.isArray(projectConfig)) return {};
  if (Number(projectConfig.version || 1) >= 2 && projectConfig.stages) {
    return migrateCodexMcpModels(structuredClone(projectConfig));
  }

  const migrated = structuredClone(projectConfig);
  const models = migrated.models || {};
  const workProviders = legacyWorkProviders(migrated);
  const workRoutes = {};
  for (const complexity of ["low", "medium", "high"]) {
    workRoutes[complexity] = workProviders.map((provider) => {
      if (provider === "cc") return route("cc", models.cc?.[complexity] || CC_MODEL_DEFAULTS[complexity]);
      if (provider === "agy_write") {
        const fallback = complexity === "high" ? "Claude Opus 4.6 (Thinking)" : "Claude Sonnet 4.6 (Thinking)";
        return route("agy_write", models.agy_write?.[complexity] || fallback);
      }
      if (provider === "codex_worker") return route("codex_worker", models.codex_worker?.[complexity] || null);
      return route(provider, null);
    });
  }
  migrated.version = 2;
  migrated.mcp = {
    enabled: migrated.mcp?.enabled === true,
    expose_provider_tools: migrated.mcp?.expose_provider_tools === true,
    ...(migrated.mcp || {}),
  };
  migrated.stages = {
    plan: {
      default_complexity: "high",
      routes: Object.fromEntries(["low", "medium", "high"].map((complexity) => [
        complexity,
        [route("codex", migrateCodexMcpModel(models.codex?.planner), "in_session")],
      ])),
    },
    work: { default_complexity: "medium", routes: workRoutes },
    review: {
      default_complexity: "medium",
      routes: {
        low: [route("agy", migrateLegacyAgyModel(models.agy?.low, "Gemini 3.5 Flash (Low)"))],
        medium: [route("agy", migrateLegacyAgyModel(models.agy?.medium, "Gemini 3.5 Flash (High)"))],
        high: [route("agy", migrateLegacyAgyModel(models.agy?.high, "Gemini 3.1 Pro (High)"))],
      },
    },
    accept: { inherit_from: "plan" },
  };
  migrated.migration = {
    ...(migrated.migration || {}),
    from_version: Number(projectConfig.version || 1),
    preserves_legacy_models: true,
  };
  return migrateCodexMcpModels(migrated);
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
