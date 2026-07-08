#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerOrchestrator } from "./lib/orchestrator.mjs";
import { StateStore } from "./lib/state.mjs";
import { assertProject, chooseModel, DEFAULT_CONFIG, loadProjectConfig, projectOrchestratorRoot, projectRunsRoot, projectStateRoot } from "./lib/config.mjs";
import { commandExists, runProcess } from "./lib/process.mjs";
import { deepMerge, newId, pathExists, readJson, writeJsonAtomic } from "./lib/utils.mjs";

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

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

function parseArray(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text);
  return text.split(";").map((item) => item.trim()).filter(Boolean);
}

async function readContract() {
  const value = args.Contract || args.contract;
  if (!value) return {};
  const text = String(value);
  if (await pathExists(text)) return readJson(text);
  return JSON.parse(text);
}

async function projectStore(projectDir) {
  const stateRoot = projectStateRoot(projectDir);
  const runsRoot = projectRunsRoot(projectDir);
  const store = new StateStore(stateRoot, { jobsRoot: runsRoot, orchestratorRoot: projectOrchestratorRoot(projectDir) });
  await store.init();
  return store;
}

async function orchestratorFor(projectDir) {
  return new WorkerOrchestrator(await projectStore(projectDir));
}

async function initProject() {
  const projectDir = projectDirArg();
  const orchestratorRoot = projectOrchestratorRoot(projectDir);
  await fs.mkdir(orchestratorRoot, { recursive: true });
  await fs.mkdir(projectStateRoot(projectDir), { recursive: true });
  await fs.mkdir(projectRunsRoot(projectDir), { recursive: true });
  const configPath = path.join(orchestratorRoot, "config.json");
  const existing = await pathExists(configPath) ? await readJson(configPath) : {};
  const base = deepMerge(DEFAULT_CONFIG, {
    trusted: true,
    mode: "cli",
    mcp: { enabled: false },
  });
  const next = deepMerge(base, existing);
  next.mode = "cli";
  next.mcp = { ...(next.mcp || {}), enabled: false };
  if (!next.roles) next.roles = {};
  next.roles.primary_writer = next.roles.primary_writer || "cc";
  next.roles.specialist = next.roles.specialist || "agy";
  next.roles.duplicate_implementation = false;
  if (!next.routing) next.routing = {};
  next.routing.auto = next.routing.auto || "agy_preferred";
  if (next.routing.agy_write_fallback_to_cc_on_quota === undefined) next.routing.agy_write_fallback_to_cc_on_quota = true;
  if (!next.models) next.models = {};
  if (!next.host) next.host = {};
  next.host.provider = next.host.provider || "unknown";
  next.host.in_session_roles = next.host.in_session_roles || ["planner", "accepter"];
  if (!next.providers) next.providers = {};
  next.providers.codex = {
    external_invocation: "disabled_when_host_is_codex",
    roles: ["planner", "accepter"],
    ...(next.providers.codex || {}),
  };
  next.providers.cc = { roles: ["executor"], invocation: "cli", ...(next.providers.cc || {}) };
  next.providers.agy = { roles: ["reviewer", "executor_fallback"], invocation: "cli", ...(next.providers.agy || {}) };
  if (!next.models.agy_write) {
    next.models.agy_write = { low: null, medium: "Claude Sonnet 4.6 (Thinking)", high: "Claude Opus 4.6 (Thinking)" };
  }
  // Two-tier CC policy: normalize null/missing values to deepseek defaults.
  // Preserve any explicit non-empty user model string.
  if (!next.models) next.models = {};
  if (!next.models.cc) next.models.cc = {};
  const ccDefaults = { low: "deepseek-v4-flash", medium: "deepseek-v4-flash", high: "deepseek-v4-pro" };
  for (const level of ["low", "medium", "high"]) {
    if (!next.models.cc[level]) next.models.cc[level] = ccDefaults[level];
  }
  if (!next.execution) next.execution = {};
  if (next.execution.agy_write_timeout_seconds === undefined) next.execution.agy_write_timeout_seconds = 1800;
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
    const pluginLauncher = path.join(scriptDir, "..", "skills", "audit-orch", "scripts", "open-dashboard.ps1");
    const launcher = [
      'param([int]$PreferredPort = 15788)',
      '$ErrorActionPreference = "Stop"',
      `$ProjectDir = Split-Path -Parent $PSScriptRoot`,
      `powershell -ExecutionPolicy Bypass -File "${pluginLauncher.replaceAll('"', '""')}" -ProjectDir $ProjectDir -PreferredPort $PreferredPort`,
      "",
    ].join("\n");
    await fs.writeFile(dashboardLauncher, launcher, "utf8");
  }
  const store = await projectStore(projectDir);
  await store.resume({ projectDir, hostProvider: next.host.provider || "unknown" });
  output({
    ok: true,
    project_dir: projectDir,
    config_path: configPath,
    continuity_docs: {
      project: path.join(orchestratorRoot, "PROJECT.md"),
      todo: path.join(orchestratorRoot, "TODO.md"),
      handoff: path.join(orchestratorRoot, "HANDOFF.md"),
      seeded: seededDocs,
    },
    dashboard_launcher: dashboardLauncher,
    existing_project: Boolean(args.ExistingProject || args.existingProject),
    mode: "cli",
  });
}

async function health() {
  const projectDir = projectDirArg();
  const config = await loadProjectConfig(projectDir);
  const claude = await commandExists(config.cli.claude);
  const agy = await commandExists(config.cli.agy);
  output({
    ok: claude.found && agy.found,
    mode: config.mode,
    mcp_enabled: config.mcp?.enabled === true,
    project_dir: projectDir,
    project_config: config.source,
    project_trusted: config.trusted,
    claude,
    agy,
  });
}

function taskArgs(contract) {
  const taskId = args.TaskId || args.taskId || contract.task_id || contract.taskId;
  const goal = args.Goal || args.goal || contract.goal;
  const plan = args.Plan || args.plan || contract.plan || "";
  if (!taskId) throw new Error("TaskId is required.");
  if (!goal) throw new Error("Goal is required.");
  return {
    project_dir: projectDirArg(),
    task_id: String(taskId),
    goal: String(goal),
    plan: String(plan),
    complexity: args.Complexity || args.complexity || contract.complexity || "medium",
    model: args.Model || args.model || contract.model,
    acceptance_commands: parseArray(args.AcceptanceCommands || args.acceptanceCommands) || contract.acceptance_commands,
  };
}

async function runCc(continuation) {
  const contract = await readContract();
  const task = taskArgs(contract);
  const orchestrator = await orchestratorFor(task.project_dir);
  const started = await orchestrator.startCc(task, continuation);
  const finished = await orchestrator.wait(started.id);
  const result = await orchestrator.result(started.id);
  output({ job: finished, evidence: result.evidence });
}

async function probeAgy(config, projectDir) {
  if (config.agy?.auth_probe_required === false) return { skipped: true };
  const probeId = newId("agy-probe");
  const logDir = path.join(projectRunsRoot(projectDir), probeId);
  const result = await runProcess({
    command: config.cli.agy,
    args: [...(config.cli.agy_prefix_args || []), "--help"],
    cwd: projectDir,
    timeoutSeconds: 30,
    logDir,
    logPrefix: "agy-auth-probe",
    maxLogBytes: config.execution.max_log_bytes,
  });
  return {
    ok: result.exit_code === 0 && !result.timed_out,
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    stdout_path: result.stdout_path,
    stderr_path: result.stderr_path,
  };
}

async function runAgy(mode) {
  const contract = await readContract();
  const task = taskArgs(contract);
  const config = await assertProject(task.project_dir);
  const probe = await probeAgy(config, task.project_dir);
  if (probe.ok === false) {
    throw new Error(`AGY auth probe failed before launch. stdout=${probe.stdout_path} stderr=${probe.stderr_path}`);
  }
  const orchestrator = await orchestratorFor(task.project_dir);
  const started = await orchestrator.startAgy(task, mode);
  const finished = await orchestrator.wait(started.id);
  const result = await orchestrator.result(started.id);
  output({ job: finished, evidence: result.evidence, agy_probe: probe });
}

async function runAgyWrite(continuation) {
  const contract = await readContract();
  const task = taskArgs(contract);
  const config = await assertProject(task.project_dir);
  const probe = await probeAgy(config, task.project_dir);
  if (probe.ok === false) {
    throw new Error(`AGY auth probe failed before launch. stdout=${probe.stdout_path} stderr=${probe.stderr_path}`);
  }
  const orchestrator = await orchestratorFor(task.project_dir);
  const started = await orchestrator.startAgyWrite(task, continuation);
  const finished = await orchestrator.wait(started.id);
  const result = await orchestrator.result(started.id);
  output({ job: finished, evidence: result.evidence, agy_probe: probe });
}

async function runAuto() {
  const contract = await readContract();
  const task = taskArgs(contract);
  const orchestrator = await orchestratorFor(task.project_dir);
  const started = await orchestrator.startAuto(task);
  const finished = await orchestrator.wait(started.id);
  const result = await orchestrator.result(started.id);
  output({ job: finished, evidence: result.evidence });
}

async function jobCommand(kind) {
  const projectDir = projectDirArg();
  const jobId = args.JobId || args.jobId;
  if (!jobId) throw new Error("JobId is required.");
  const orchestrator = await orchestratorFor(projectDir);
  if (kind === "status") return output(await orchestrator.status(String(jobId)));
  if (kind === "result") return output(await orchestrator.result(String(jobId)));
  if (kind === "apply") return output(await orchestrator.apply(String(jobId)));
  if (kind === "cleanup") return output(await orchestrator.cleanup(String(jobId)));
  throw new Error(`Unknown job command: ${kind}`);
}

async function resumeProject() {
  const projectDir = projectDirArg();
  const hostProvider = args.HostProvider || args.hostProvider || args.Host || args.host || "unknown";
  const store = await projectStore(projectDir);
  output(await store.resume({ projectDir, hostProvider: String(hostProvider) }));
}

async function openDashboard() {
  const projectDir = projectDirArg();
  const preferredPort = Number(args.PreferredPort || args.preferredPort || 15788);
  const launcher = path.resolve(scriptDir, "..", "skills", "audit-orch", "scripts", "open-dashboard.ps1");
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

async function main() {
  switch (command) {
    case "init": return initProject();
    case "health": return health();
    case "cc-exec": return runCc(false);
    case "cc-continue": return runCc(true);
    case "agy-investigate": return runAgy("investigate");
    case "agy-verify": return runAgy("verify");
    case "agy-exec": return runAgyWrite(false);
    case "agy-continue": return runAgyWrite(true);
    case "auto": return runAuto();
    case "status": return jobCommand("status");
    case "result": return jobCommand("result");
    case "apply": return jobCommand("apply");
    case "cleanup": return jobCommand("cleanup");
    case "resume": return resumeProject();
    case "dashboard": return openDashboard();
    default:
      throw new Error(`Unknown command: ${command || "(missing)"}`);
  }
}

main().catch((error) => {
  output({ ok: false, error: error?.stack || error?.message || String(error) });
  process.exitCode = 1;
});
