#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "./lib/state.mjs";
import { DEFAULT_CODEX_MCP_MODEL, DEFAULT_CONFIG, loadProjectConfig, migrateProjectConfig, projectOrchestratorRoot, projectRunsRoot, projectStateRoot } from "./lib/config.mjs";
import { commandExists, runProcess } from "./lib/process.mjs";
import { deepMerge, pathExists, readJson, writeJsonAtomic } from "./lib/utils.mjs";
import { captureRuntimeEnvironment } from "./lib/runtime-env.mjs";

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_ID = "agent_orch";
const LEGACY_MCP_SERVER_ID = "agent-orch";

// Tool names that have been removed from the CLI and are only available
// via MCP.  Calling one of these produces an explicit MCP-only error.
const MCP_ONLY_COMMANDS = new Set([
  "stage-plan",
  "stage-work",
  "stage-work-continue",
  "stage-review",
  "stage-accept",
  "wait-for-job",
  "auto",
  "cc-exec",
  "cc-continue",
  "agy-exec",
  "agy-continue",
  "reviewer-investigate",
  "reviewer-verify",
  "planner-plan",
  "status",
  "result",
  "apply",
  "cleanup",
]);

const HELP_TEXT = `Agent Orch CLI

Usage:
  agent-orch <command> [options]

Project commands:
  init               Initialize .agent-orchestrator in a project.
  health             Check configured CC/AGY CLI availability.
  resume             Rebuild and print current project state.

MCP maintenance commands:
  mcp status         Show MCP configuration status for this project.
  mcp install        Install or update the MCP server reference in .mcp.json.
  mcp repair         Repair MCP configuration and re-enable after migration.
  mcp remove         Remove the MCP server entry from .mcp.json.

Dashboard commands:
  dashboard          Start or reuse the read-only dashboard.
  dashboard-close    Stop the dashboard bound to this project.

Common options:
  -ProjectDir <path>            Project directory. Defaults to current directory.
  -HostProvider <name>          Host for init/resume, e.g. codex or cc_desktop.
  -PreferredPort <port>         Dashboard starting port, default 15788.

Examples:
  agent-orch init -ProjectDir . -HostProvider codex
  agent-orch init -ProjectDir . -HostProvider cc_desktop
  agent-orch resume -ProjectDir . -HostProvider codex
  agent-orch mcp status -ProjectDir .
  agent-orch mcp install -ProjectDir .
  agent-orch dashboard -ProjectDir . -PreferredPort 15788
  agent-orch dashboard-close -ProjectDir . -PreferredPort 15788

Stage, worker, reviewer, and job-control operations (stage-plan, stage-work,
stage-work-continue, stage-review, stage-accept, wait-for-job, status, result,
apply, cleanup) are only available through MCP tools. Provider-specific wrappers
are hidden by default.
The \`status\` tool returns a compact snapshot including bounded assistant-only
progress (at most two newest messages, no tool calls or raw logs). Raw
transcripts and tool output remain local artifacts — use \`result\` for full
evidence.
Use 'agent-orch mcp install' to set up the MCP server.
`;

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("-")) continue;
    const key = token.replace(/^-+/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function projectDirArg() {
  return path.resolve(String(args.ProjectDir || args.projectDir || process.cwd()));
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(HELP_TEXT);
}

function mcpOnlyError(name) {
  throw new Error(
    `The "${name}" command is no longer available through the CLI. ` +
    `Worker, reviewer, and job-control operations are only available through MCP tools. ` +
    `Run 'agent-orch mcp install -ProjectDir .' to set up MCP, then use the MCP tools directly. ` +
    `The CLI now only supports: init, resume, health, dashboard, dashboard-close, mcp status, mcp install, mcp repair, mcp remove.`,
  );
}

async function projectStore(projectDir) {
  const stateRoot = projectStateRoot(projectDir);
  const runsRoot = projectRunsRoot(projectDir);
  const store = new StateStore(stateRoot, { jobsRoot: runsRoot, orchestratorRoot: projectOrchestratorRoot(projectDir) });
  await store.init();
  return store;
}

function materializeProjectConfig(existing = {}, { trusted = true, hostProvider = null } = {}) {
  const explicitMcpEnabled = typeof existing?.mcp?.enabled === "boolean"
    ? existing.mcp.enabled
    : null;
  existing = migrateProjectConfig(existing);
  const existingHostRoles = existing?.host?.in_session_roles;
  const normalizedHostProvider = hostProvider || existing?.host?.provider || "unknown";
  const base = deepMerge(DEFAULT_CONFIG, {
    trusted,
    mode: "cli",
  });
  const next = deepMerge(base, existing);
  next.mode = "cli";

  // Codex and desktop hosts use MCP as the primary stage surface. Preserve an
  // explicit existing false until `mcp install` or `mcp repair` enables it.
  if (!next.mcp) next.mcp = {};
  const isMcpHost = ["codex", "cc_desktop", "claude_desktop"].includes(normalizedHostProvider);
  next.mcp.enabled = explicitMcpEnabled ?? isMcpHost;

  if (!next.roles) next.roles = {};
  next.roles.primary_writer = next.roles.primary_writer || "cc";
  next.roles.specialist = next.roles.specialist || "agy";
  next.roles.duplicate_implementation = false;
  if (!next.routing) next.routing = {};
  next.routing.auto = next.routing.auto || "cc_first";
  if (next.routing.agy_write_fallback_to_cc_on_quota === undefined) next.routing.agy_write_fallback_to_cc_on_quota = true;
  if (next.routing.cc_verify_fail_escalate_to_agy === undefined) next.routing.cc_verify_fail_escalate_to_agy = true;
  if (!next.host) next.host = {};
  next.host.provider = normalizedHostProvider;
  if (!existingHostRoles) {
    next.host.in_session_roles = ["cc_desktop", "claude_desktop"].includes(normalizedHostProvider)
      ? ["coordinator"]
      : normalizedHostProvider === "codex"
      ? ["planner", "accepter", "coordinator"]
      : ["coordinator"];
  } else {
    next.host.in_session_roles = next.host.in_session_roles || ["coordinator"];
  }
  if (!next.providers) next.providers = {};
  next.providers.codex = {
    ...(next.providers.codex || {}),
    external_invocation: "disabled_when_host_is_codex",
    invocation: normalizedHostProvider === "codex" ? "in_session" : "cli_verified_required",
    roles: ["planner", "accepter"],
  };
  next.providers.cc = { roles: ["executor"], invocation: "cli", ...(next.providers.cc || {}) };
  next.providers.agy = { roles: ["reviewer", "executor_fallback"], invocation: "cli", ...(next.providers.agy || {}) };
  if (!next.models) next.models = {};
  if (!next.models.codex) {
    next.models.codex = {
      planner: DEFAULT_CODEX_MCP_MODEL,
      accepter: DEFAULT_CODEX_MCP_MODEL,
      reasoning_effort: "high",
    };
  }
  if (!next.models.agy_write) {
    next.models.agy_write = { low: null, medium: "Claude Sonnet 4.6 (Thinking)", high: "Claude Opus 4.6 (Thinking)" };
  }
  if (!next.models.cc) next.models.cc = {};
  const ccDefaults = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  for (const level of ["low", "medium", "high"]) {
    if (!next.models.cc[level]) next.models.cc[level] = ccDefaults[level];
  }
  if (!next.execution) next.execution = {};
  if (next.execution.agy_write_timeout_seconds === undefined) next.execution.agy_write_timeout_seconds = 1800;
  return next;
}

// -- Project commands --

async function initProject() {
  const projectDir = projectDirArg();
  const hostProvider = args.HostProvider || args.hostProvider || args.Host || args.host || null;
  const orchestratorRoot = projectOrchestratorRoot(projectDir);
  await fs.mkdir(orchestratorRoot, { recursive: true });
  await fs.mkdir(projectStateRoot(projectDir), { recursive: true });
  await fs.mkdir(projectRunsRoot(projectDir), { recursive: true });
  const configPath = path.join(orchestratorRoot, "config.json");
  const existing = await pathExists(configPath) ? await readJson(configPath) : {};
  const next = materializeProjectConfig(existing, { trusted: true, hostProvider: hostProvider ? String(hostProvider) : null });
  await writeJsonAtomic(configPath, next);
  const templateRoot = path.resolve(scriptDir, "..", "templates");
  const seededDocs = [];
  for (const name of ["PROJECT.md", "TODO.md", "HANDOFF.md"]) {
    const target = path.join(orchestratorRoot, name);
    if (await pathExists(target)) continue;
    const template = await fs.readFile(path.join(templateRoot, name), "utf8");
    await fs.writeFile(target, template, "utf8");
    seededDocs.push(target);
  }
  const dashboardLauncher = path.join(orchestratorRoot, "open-dashboard.ps1");
  if (!(await pathExists(dashboardLauncher))) {
    const pluginLauncher = path.join(scriptDir, "..", "dashboard", "scripts", "open-dashboard.ps1");
    const launcher = [
      'param([int]$PreferredPort = 15788, [switch]$Close)',
      '$ErrorActionPreference = "Stop"',
      `$ProjectDir = Split-Path -Parent $PSScriptRoot`,
      '$ArgsList = @("-ExecutionPolicy", "Bypass", "-File", "' + pluginLauncher.replaceAll('"', '""') + '", "-ProjectDir", $ProjectDir, "-PreferredPort", [string]$PreferredPort)',
      'if ($Close) { $ArgsList += "-Close" }',
      'powershell @ArgsList',
      "",
    ].join("\n");
    await fs.writeFile(dashboardLauncher, launcher, "utf8");
  }
  const store = await projectStore(projectDir);
  const runtimeEnvironment = await captureRuntimeEnvironment(projectDir);
  await store.resume({ projectDir, hostProvider: next.host.provider || "unknown" });
  output({
    ok: true,
    project_dir: projectDir,
    config_path: configPath,
    mcp_enabled: next.mcp?.enabled === true,
    host_provider: next.host.provider,
    continuity_docs: {
      project: path.join(orchestratorRoot, "PROJECT.md"),
      todo: path.join(orchestratorRoot, "TODO.md"),
      handoff: path.join(orchestratorRoot, "HANDOFF.md"),
      seeded: seededDocs,
    },
    dashboard_launcher: dashboardLauncher,
    existing_project: Boolean(args.ExistingProject || args.existingProject),
    mode: "cli",
    runtime_environment: {
      file: runtimeEnvironment.file,
      captured_at: runtimeEnvironment.captured_at,
      keys: Object.keys(runtimeEnvironment.env),
    },
  });
}

async function health() {
  const projectDir = projectDirArg();
  const config = await loadProjectConfig(projectDir);
  const claude = await commandExists(config.cli.claude);
  const agy = await commandExists(config.cli.agy);
  const codexWorker = await commandExists(config.cli.codex);
  output({
    ok: claude.found && agy.found && codexWorker.found,
    mode: config.mode,
    mcp_enabled: config.mcp?.enabled === true,
    project_dir: projectDir,
    project_config: config.source,
    project_trusted: config.trusted,
    host_provider: config.host?.provider || "unknown",
    claude,
    agy,
    codex_worker: codexWorker,
  });
}

async function resumeProject() {
  const projectDir = projectDirArg();
  const configPath = path.join(projectOrchestratorRoot(projectDir), "config.json");
  const existing = await pathExists(configPath) ? await readJson(configPath) : {};
  const hostProvider = args.HostProvider || args.hostProvider || args.Host || args.host || existing.host?.provider || "unknown";
  await fs.mkdir(projectOrchestratorRoot(projectDir), { recursive: true });
  // resume: preserve existing mcp.enabled profile when no explicit HostProvider
  // is given that would override it; otherwise let materializeProjectConfig decide.
  const next = materializeProjectConfig(existing, { trusted: existing.trusted ?? false, hostProvider: String(hostProvider) });
  await writeJsonAtomic(configPath, next);
  const runtimeEnvironment = await captureRuntimeEnvironment(projectDir);
  const store = await projectStore(projectDir);
  const state = await store.resume({ projectDir, hostProvider: String(hostProvider) });
  output({
    ...state,
    mcp_enabled: next.mcp?.enabled === true,
    host_provider: next.host.provider,
    runtime_environment: {
      file: runtimeEnvironment.file,
      captured_at: runtimeEnvironment.captured_at,
      keys: Object.keys(runtimeEnvironment.env),
    },
  });
}

// -- MCP maintenance commands --

async function projectConfigPath(projectDir) {
  return path.join(projectOrchestratorRoot(projectDir), "config.json");
}

async function readProjectConfig(projectDir) {
  const p = await projectConfigPath(projectDir);
  if (!(await pathExists(p))) {
    throw new Error(`Project not initialized. Run 'agent-orch init -ProjectDir ${projectDir}' first.`);
  }
  return readJson(p);
}

async function writeProjectConfig(projectDir, config) {
  const p = await projectConfigPath(projectDir);
  await writeJsonAtomic(p, config);
}

async function mcpStatus() {
  const projectDir = projectDirArg();
  const config = await readProjectConfig(projectDir);
  const mcpJsonPath = path.join(projectDir, ".mcp.json");
  const mcpJson = await pathExists(mcpJsonPath) ? await readJson(mcpJsonPath) : null;
  const agentOrchEntry = mcpJson?.mcpServers?.[MCP_SERVER_ID]
    || mcpJson?.mcpServers?.[LEGACY_MCP_SERVER_ID]
    || null;

  output({
    ok: true,
    project_dir: projectDir,
    config_path: await projectConfigPath(projectDir),
    mcp_enabled: config.mcp?.enabled === true,
    host_provider: config.host?.provider || "unknown",
    trusted: config.trusted === true,
    mcp_json_exists: mcpJson !== null,
    mcp_json_path: mcpJsonPath,
    mcp_server_entry: agentOrchEntry,
    notes: config.mcp?.enabled !== true
      ? "MCP is disabled. Run 'agent-orch mcp install' or 'agent-orch mcp repair' to enable it."
      : "MCP is enabled and configured.",
  });
}

async function mcpInstall() {
  const projectDir = projectDirArg();
  const config = await readProjectConfig(projectDir);

  // Enable MCP in project config.
  if (!config.mcp) config.mcp = {};
  config.mcp.enabled = true;
  await writeProjectConfig(projectDir, config);

  // Write or update .mcp.json in the project root.
  const mcpJsonPath = path.join(projectDir, ".mcp.json");
  let mcpJson = await pathExists(mcpJsonPath) ? await readJson(mcpJsonPath) : {};
  if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
  delete mcpJson.mcpServers[LEGACY_MCP_SERVER_ID];
  mcpJson.mcpServers[MCP_SERVER_ID] = {
    command: "node",
    args: [path.relative(projectDir, path.resolve(scriptDir, "mcp-stdio-bridge.mjs")).replaceAll("\\", "/")],
    cwd: ".",
  };
  await writeJsonAtomic(mcpJsonPath, mcpJson);

  output({
    ok: true,
    project_dir: projectDir,
    mcp_enabled: true,
    config_path: await projectConfigPath(projectDir),
    mcp_json_path: mcpJsonPath,
    mcp_server_entry: mcpJson.mcpServers[MCP_SERVER_ID],
    message: "MCP server installed. Restart your MCP client to pick up the new configuration.",
  });
}

async function mcpRepair() {
  const projectDir = projectDirArg();
  const config = await readProjectConfig(projectDir);

  // Re-enable MCP in project config.
  if (!config.mcp) config.mcp = {};
  config.mcp.enabled = true;
  await writeProjectConfig(projectDir, config);

  // Repair .mcp.json entry.
  const mcpJsonPath = path.join(projectDir, ".mcp.json");
  let mcpJson = await pathExists(mcpJsonPath) ? await readJson(mcpJsonPath) : {};
  if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
  delete mcpJson.mcpServers[LEGACY_MCP_SERVER_ID];
  mcpJson.mcpServers[MCP_SERVER_ID] = {
    command: "node",
    args: [path.relative(projectDir, path.resolve(scriptDir, "mcp-stdio-bridge.mjs")).replaceAll("\\", "/")],
    cwd: ".",
  };
  await writeJsonAtomic(mcpJsonPath, mcpJson);

  output({
    ok: true,
    project_dir: projectDir,
    mcp_enabled: true,
    mcp_repaired: true,
    config_path: await projectConfigPath(projectDir),
    mcp_json_path: mcpJsonPath,
    message: "MCP configuration repaired and re-enabled. Restart your MCP client to pick up changes.",
  });
}

async function mcpRemove() {
  const projectDir = projectDirArg();
  const config = await readProjectConfig(projectDir);

  // Disable MCP in project config.
  if (!config.mcp) config.mcp = {};
  config.mcp.enabled = false;
  await writeProjectConfig(projectDir, config);

  // Remove current and legacy Agent Orch entries from .mcp.json.
  const mcpJsonPath = path.join(projectDir, ".mcp.json");
  if (await pathExists(mcpJsonPath)) {
    const mcpJson = await readJson(mcpJsonPath);
    if (mcpJson.mcpServers?.[MCP_SERVER_ID] || mcpJson.mcpServers?.[LEGACY_MCP_SERVER_ID]) {
      delete mcpJson.mcpServers[MCP_SERVER_ID];
      delete mcpJson.mcpServers[LEGACY_MCP_SERVER_ID];
      if (Object.keys(mcpJson.mcpServers).length === 0) delete mcpJson.mcpServers;
      await writeJsonAtomic(mcpJsonPath, mcpJson);
    }
  }

  output({
    ok: true,
    project_dir: projectDir,
    mcp_enabled: false,
    mcp_removed: true,
    config_path: await projectConfigPath(projectDir),
    mcp_json_path: mcpJsonPath,
    message: "MCP server entry removed from .mcp.json and MCP disabled in project config. Restart your MCP client to apply.",
  });
}

// -- Dashboard commands --

async function openDashboard() {
  const projectDir = projectDirArg();
  const preferredPort = Number(args.PreferredPort || args.preferredPort || 15788);
  const launcher = path.resolve(scriptDir, "..", "dashboard", "scripts", "open-dashboard.ps1");
  const result = await runProcess({
    command: "powershell",
    args: ["-ExecutionPolicy", "Bypass", "-File", launcher, "-ProjectDir", projectDir, "-PreferredPort", String(preferredPort)],
    cwd: projectDir,
    timeoutSeconds: 30,
    logDir: projectRunsRoot(projectDir),
    logPrefix: "dashboard-launch",
    maxLogBytes: 256 * 1024,
  });
  if (result.exit_code !== 0) throw new Error(`Dashboard launcher failed: ${result.stderr || result.stdout}`);
  const dashboardUrl = (result.stdout.match(/dashboard_url=(\S+)/) || [])[1] || null;
  const orchestratorDir = (result.stdout.match(/orchestrator_dir=(.+)/) || [])[1]?.trim() || null;
  const metadata = {
    dashboard_url: dashboardUrl,
    orchestrator_dir: orchestratorDir,
    preferred_port: preferredPort,
    started_at: new Date().toISOString(),
    stdout_path: result.stdout_path,
    stderr_path: result.stderr_path,
  };
  await writeJsonAtomic(path.join(projectOrchestratorRoot(projectDir), "dashboard.json"), metadata);
  output({ ok: true, ...metadata });
}

async function closeDashboard() {
  const projectDir = projectDirArg();
  const preferredPort = Number(args.PreferredPort || args.preferredPort || 15788);
  const launcher = path.resolve(scriptDir, "..", "dashboard", "scripts", "open-dashboard.ps1");
  const result = await runProcess({
    command: "powershell",
    args: ["-ExecutionPolicy", "Bypass", "-File", launcher, "-ProjectDir", projectDir, "-PreferredPort", String(preferredPort), "-Close"],
    cwd: projectDir,
    timeoutSeconds: 15,
    logDir: projectRunsRoot(projectDir),
    logPrefix: "dashboard-close",
    maxLogBytes: 256 * 1024,
  });
  if (result.exit_code !== 0) throw new Error(`Dashboard close failed: ${result.stderr || result.stdout}`);
  const stopped = (result.stdout.match(/stopped=(\S+)/) || [])[1] || "false";
  const dashboardUrl = (result.stdout.match(/dashboard_url=(\S+)/) || [])[1] || null;
  const orchestratorDir = (result.stdout.match(/orchestrator_dir=(.+)/) || [])[1]?.trim() || null;
  output({ ok: true, stopped: stopped === "true", dashboard_url: dashboardUrl, orchestrator_dir: orchestratorDir });
}

// -- Main dispatch --

async function main() {
  // MCP-only commands: fail with an explicit error.
  if (MCP_ONLY_COMMANDS.has(command)) return mcpOnlyError(command);

  switch (command) {
    case undefined:
    case "":
    case "help":
    case "--help":
    case "-h":
      return printHelp();
    case "init": return initProject();
    case "health": return health();
    case "resume": return resumeProject();
    case "dashboard": return openDashboard();
    case "dashboard-close": return closeDashboard();
    case "mcp":
      return dispatchMcpSubcommand();
    default:
      if (command && MCP_ONLY_COMMANDS.has(command)) return mcpOnlyError(command);
      throw new Error(`Unknown command: ${command || "(missing)"}`);
  }
}

async function dispatchMcpSubcommand() {
  const subcommand = process.argv[3];
  switch (subcommand) {
    case "status": return mcpStatus();
    case "install": return mcpInstall();
    case "repair": return mcpRepair();
    case "remove": return mcpRemove();
    default:
      throw new Error(`Unknown mcp subcommand: ${subcommand || "(missing)"}. Use: mcp status|install|repair|remove`);
  }
}

main().catch((error) => {
  output({ ok: false, error: error?.stack || error?.message || String(error) });
  process.exitCode = 1;
});
