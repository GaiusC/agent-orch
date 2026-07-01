#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { WorkerOrchestrator } from "./lib/orchestrator.mjs";
import { StateStore } from "./lib/state.mjs";
import { assertProject, DEFAULT_CONFIG, loadProjectConfig, projectOrchestratorRoot, projectRunsRoot, projectStateRoot } from "./lib/config.mjs";
import { commandExists, runProcess } from "./lib/process.mjs";
import { deepMerge, newId, pathExists, readJson, writeJsonAtomic } from "./lib/utils.mjs";

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

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
  const store = new StateStore(stateRoot, { jobsRoot: runsRoot });
  await store.init();
  return store;
}

async function orchestratorFor(projectDir) {
  return new WorkerOrchestrator(await projectStore(projectDir));
}

async function initProject() {
  const projectDir = projectDirArg();
  await fs.mkdir(projectOrchestratorRoot(projectDir), { recursive: true });
  await fs.mkdir(projectStateRoot(projectDir), { recursive: true });
  await fs.mkdir(projectRunsRoot(projectDir), { recursive: true });
  const configPath = path.join(projectOrchestratorRoot(projectDir), "config.json");
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
  await writeJsonAtomic(configPath, next);
  output({
    ok: true,
    project_dir: projectDir,
    config_path: configPath,
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
    args: [...(config.cli.agy_prefix_args || []), "models"],
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

async function main() {
  switch (command) {
    case "init": return initProject();
    case "health": return health();
    case "cc-exec": return runCc(false);
    case "cc-continue": return runCc(true);
    case "agy-investigate": return runAgy("investigate");
    case "agy-verify": return runAgy("verify");
    case "status": return jobCommand("status");
    case "result": return jobCommand("result");
    case "apply": return jobCommand("apply");
    case "cleanup": return jobCommand("cleanup");
    default:
      throw new Error(`Unknown command: ${command || "(missing)"}`);
  }
}

main().catch((error) => {
  output({ ok: false, error: error?.stack || error?.message || String(error) });
  process.exitCode = 1;
});
