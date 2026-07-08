import fs from "node:fs/promises";
import path from "node:path";
import { dataRoot } from "./config.mjs";
import { newId, nowIso, projectKey, readJson, truncate, writeJsonAtomic } from "./utils.mjs";

const IN_SESSION_ROLES_BY_HOST = {
  codex: ["planner", "accepter", "coordinator"],
};

export class StateStore {
  constructor(root = dataRoot(), options = {}) {
    this.root = root;
    this.jobsRoot = options.jobsRoot || path.join(root, "jobs");
    this.sessionsFile = path.join(root, "sessions.json");
    this.orchestratorRoot = options.orchestratorRoot || (path.basename(root) === "state" ? path.dirname(root) : root);
    this.eventsFile = options.eventsFile || path.join(this.orchestratorRoot, "events.jsonl");
    this.currentStateFile = options.currentStateFile || path.join(this.orchestratorRoot, "current-state.json");
    this.generatedHandoffFile = options.generatedHandoffFile || path.join(this.orchestratorRoot, "handoff.generated.md");
  }

  async init() {
    await fs.mkdir(this.jobsRoot, { recursive: true });
    await fs.mkdir(this.orchestratorRoot, { recursive: true });
    if (!(await fs.stat(this.sessionsFile).catch(() => null))) await writeJsonAtomic(this.sessionsFile, { version: 1, sessions: {} });
  }

  jobDir(jobId) {
    return path.join(this.jobsRoot, jobId);
  }

  jobFile(jobId) {
    return path.join(this.jobDir(jobId), "job.json");
  }

  async createJob(job) {
    await fs.mkdir(this.jobDir(job.id), { recursive: true });
    const value = { ...job, created_at: nowIso(), updated_at: nowIso() };
    await writeJsonAtomic(this.jobFile(job.id), value);
    await this.recordEvent("job.created", value);
    return value;
  }

  async getJob(jobId) {
    try {
      return await readJson(this.jobFile(jobId));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async updateJob(jobId, patch) {
    const current = await this.getJob(jobId);
    if (!current) throw new Error(`Unknown job: ${jobId}`);
    const next = { ...current, ...patch, updated_at: nowIso() };
    await writeJsonAtomic(this.jobFile(jobId), next);
    await this.recordEvent("job.updated", next, { patch_keys: Object.keys(patch) });
    return next;
  }

  async listJobs() {
    const entries = await fs.readdir(this.jobsRoot, { withFileTypes: true }).catch(() => []);
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = await this.getJob(entry.name);
      if (job) jobs.push(job);
    }
    return jobs.sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
  }

  async recordEvent(type, subject = {}, extra = {}) {
    const timestamp = nowIso();
    const event = {
      event_id: newId("evt"),
      type,
      timestamp,
      project_dir: subject.project_dir || subject.workspace?.original_project_dir || null,
      task_id: subject.task_id || null,
      job_id: subject.id || subject.job_id || null,
      stage: stageFor(subject.phase || type),
      role: roleFor(subject.provider, subject.type, subject.phase || type),
      provider: subject.provider || extra.provider || null,
      model: subject.model || subject.model_override || null,
      status: subject.status || null,
      phase: subject.phase || null,
      execution_mode: extra.execution_mode || executionModeFor(subject.provider),
      message: truncate(extra.message || subject.error || "", 1000),
      artifact_paths: artifactPaths(subject),
      ...extra,
    };
    await fs.mkdir(path.dirname(this.eventsFile), { recursive: true });
    await fs.appendFile(this.eventsFile, `${JSON.stringify(event)}\n`, "utf8");
    await this.rebuildCurrentState(event.project_dir);
    return event;
  }

  async readEvents({ limit = 200 } = {}) {
    const text = await fs.readFile(this.eventsFile, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    const events = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    return limit ? events.slice(-limit) : events;
  }

  async rebuildCurrentState(projectDir = null) {
    const jobs = await this.listJobs();
    const events = await this.readEvents({ limit: 50 });
    const sessions = await this.sessions().catch(() => ({ sessions: {} }));
    const state = buildCurrentState({ projectDir, jobs, events, sessions });
    await writeJsonAtomic(this.currentStateFile, state);
    await this.writeGeneratedHandoff(state);
    return state;
  }

  async resume({ projectDir = null, hostProvider = "unknown" } = {}) {
    const state = await this.rebuildCurrentState(projectDir);
    const normalizedHost = normalizeHostProvider(hostProvider);
    const inSessionRoles = IN_SESSION_ROLES_BY_HOST[normalizedHost] || [];
    const resume = {
      ...state,
      host_provider: normalizedHost,
      in_session_roles: inSessionRoles,
      external_invocation_allowed: {
        codex: !(normalizedHost === "codex"),
        cc: true,
        agy: true,
      },
      recommended_next_action: recommendNextAction(state, normalizedHost),
    };
    await writeJsonAtomic(this.currentStateFile, resume);
    await this.writeGeneratedHandoff(resume);
    return resume;
  }

  async writeGeneratedHandoff(state) {
    const lines = [
      "# Agent Orch Generated Handoff",
      "",
      `Generated: ${nowIso()}`,
      `Project: ${state.project_dir || "(unknown)"}`,
      `Host provider: ${state.host_provider || "(not specified)"}`,
      "",
      "## Current State",
      "",
      `- Active jobs: ${state.active_jobs.length}`,
      `- Ready for acceptance: ${state.ready_for_acceptance.length}`,
      `- Failed jobs: ${state.failed_jobs.length}`,
      `- Recent jobs: ${state.recent_jobs.length}`,
      "",
      "## Recommended Next Action",
      "",
      state.recommended_next_action || recommendNextAction(state, state.host_provider || "unknown"),
      "",
      "## Ready For Acceptance",
      "",
      ...listOrNone(state.ready_for_acceptance.map((job) => `- ${job.id} (${job.provider}) task=${job.task_id} evidence=${job.evidence_path || "n/a"}`)),
      "",
      "## Active Jobs",
      "",
      ...listOrNone(state.active_jobs.map((job) => `- ${job.id} (${job.provider}) phase=${job.phase} task=${job.task_id}`)),
      "",
      "## Failed Jobs",
      "",
      ...listOrNone(state.failed_jobs.map((job) => `- ${job.id} (${job.provider}) phase=${job.phase} error=${truncate(job.error || "", 200)}`)),
      "",
      "## Resume Instructions",
      "",
      "1. Run `agent-orch resume -ProjectDir <project> -HostProvider <host>` before continuing.",
      "2. Treat job evidence and patches as claims until the accepter inspects them.",
      "3. When `host_provider` is `codex`, planner/accepter work is in-session; do not invoke Codex CLI.",
      "",
    ];
    await fs.writeFile(this.generatedHandoffFile, `${lines.join("\n")}\n`, "utf8");
  }

  async sessions() {
    return readJson(this.sessionsFile);
  }

  sessionKey(projectDir, provider, taskId) {
    return `${projectKey(projectDir)}:${provider}:${taskId}`;
  }

  async getSession(projectDir, provider, taskId) {
    const registry = await this.sessions();
    return registry.sessions[this.sessionKey(projectDir, provider, taskId)] ?? null;
  }

  async setSession(projectDir, provider, taskId, session) {
    const registry = await this.sessions();
    registry.sessions[this.sessionKey(projectDir, provider, taskId)] = {
      ...session,
      project_dir: path.resolve(projectDir),
      provider,
      task_id: taskId,
      updated_at: nowIso(),
    };
    await writeJsonAtomic(this.sessionsFile, registry);
    await this.recordEvent("session.bound", registry.sessions[this.sessionKey(projectDir, provider, taskId)], { provider });
    return registry.sessions[this.sessionKey(projectDir, provider, taskId)];
  }

  async clearSession(projectDir, provider, taskId) {
    const registry = await this.sessions();
    delete registry.sessions[this.sessionKey(projectDir, provider, taskId)];
    await writeJsonAtomic(this.sessionsFile, registry);
    await this.recordEvent("session.cleared", { project_dir: path.resolve(projectDir), provider, task_id: taskId }, { provider });
  }
}

function normalizeHostProvider(value) {
  const normalized = String(value || "unknown").trim().toLowerCase().replaceAll("-", "_");
  if (["codex", "claude_desktop", "cc_desktop", "terminal", "unknown"].includes(normalized)) return normalized;
  if (normalized === "claude") return "claude_desktop";
  return "unknown";
}

function buildCurrentState({ projectDir, jobs, events, sessions }) {
  const activeJobs = jobs.filter((job) => ["queued", "running"].includes(job.status));
  const ready = jobs.filter((job) => job.status === "completed" && job.phase === "ready_for_acceptance");
  const failed = jobs.filter((job) => job.status === "failed");
  return {
    version: 1,
    project_dir: projectDir || jobs[0]?.project_dir || null,
    generated_at: nowIso(),
    active_jobs: activeJobs.map(publicJobSnapshot),
    ready_for_acceptance: ready.map(publicJobSnapshot),
    failed_jobs: failed.map(publicJobSnapshot),
    recent_jobs: jobs.slice(0, 20).map(publicJobSnapshot),
    recent_events: events,
    sessions: sessions.sessions || {},
  };
}

function publicJobSnapshot(job) {
  return {
    id: job.id,
    type: job.type,
    provider: job.provider,
    status: job.status,
    phase: job.phase,
    project_dir: job.project_dir,
    task_id: job.task_id,
    model: job.model || job.model_override || null,
    session_id: job.session_id || null,
    auto_route: job.auto_route || null,
    auto_fallback_classifier: job.auto_fallback_classifier || null,
    evidence_path: job.evidence_path || null,
    patch_path: job.patch_path || null,
    error: job.error || null,
    created_at: job.created_at,
    updated_at: job.updated_at,
    finished_at: job.finished_at || null,
  };
}

function recommendNextAction(state, hostProvider) {
  if (state.ready_for_acceptance?.length) {
    if (hostProvider === "codex") return "Current Codex session should inspect evidence/diff and accept, reject, or continue the same task_id. Do not invoke Codex CLI.";
    return "Ask the configured accepter to inspect ready_for_acceptance evidence before applying.";
  }
  if (state.active_jobs?.length) return "Wait for active jobs or inspect their logs in the dashboard.";
  if (state.failed_jobs?.length) return "Inspect failed job evidence and continue the same task_id with focused repair feedback.";
  return "Create or continue the next contract from project TODO/plan.";
}

function artifactPaths(subject) {
  const paths = {};
  for (const key of ["evidence_path", "patch_path"]) {
    if (subject[key]) paths[key] = subject[key];
  }
  return paths;
}

function executionModeFor(provider) {
  if (!provider) return null;
  if (provider === "codex") return "in_session";
  return "cli";
}

function roleFor(provider, type = "", phase = "") {
  if (provider === "agy" && /verify|investigate/.test(type)) return "reviewer";
  if (provider === "agy_write" || provider === "cc") return "executor";
  if (provider === "codex" && /accept/.test(phase)) return "accepter";
  return "coordinator";
}

function stageFor(value) {
  const text = String(value || "");
  if (/verify|review/.test(text)) return "review";
  if (/accept|appl/.test(text)) return "accept";
  if (/repair/.test(text)) return "repair";
  if (/clean/.test(text)) return "cleanup";
  if (/handoff/.test(text)) return "handoff";
  if (/queue|prepar|execut|ready|fail|complete|session|job/.test(text)) return "execute";
  return "plan";
}

function listOrNone(items) {
  return items.length ? items : ["- None"];
}
