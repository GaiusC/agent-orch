import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deepMerge, pathExists, readJson } from "./utils.mjs";

export const DEFAULT_CONFIG = {
  version: 1,
  trusted: false,
  roles: {
    primary_writer: "cc",
    specialist: "agy",
    duplicate_implementation: false,
  },
  cli: {
    claude: process.env.EAO_CLAUDE_BIN || "claude",
    agy: process.env.EAO_AGY_BIN || "agy",
    claude_prefix_args: [],
    agy_prefix_args: [],
  },
  execution: {
    workspace_mode: "isolated",
    allow_dirty_in_place: false,
    max_cc_repair_rounds: 2,
    cc_timeout_seconds: 1800,
    agy_timeout_seconds: 900,
    max_log_bytes: 4 * 1024 * 1024,
    max_result_chars: 8000,
  },
  models: {
    cc: { low: null, medium: null, high: null },
    agy: { low: "Gemini 3.5 Flash (Medium)", medium: "Gemini 3.1 Pro (Low)", high: "Gemini 3.1 Pro (High)" },
  },
  scope: {
    writable: ["."],
    forbidden: [".git/", ".env", ".env.*"],
  },
  verification: {
    commands: [],
  },
};

export function dataRoot() {
  return path.resolve(process.env.EAO_DATA_DIR || path.join(os.homedir(), ".external-agent-orchestrator"));
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
  config.cli.claude = process.env.EAO_CLAUDE_BIN || config.cli.claude;
  config.cli.agy = process.env.EAO_AGY_BIN || config.cli.agy;
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
  return config.models?.[provider]?.[level] || undefined;
}
