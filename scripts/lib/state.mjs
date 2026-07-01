import fs from "node:fs/promises";
import path from "node:path";
import { dataRoot } from "./config.mjs";
import { nowIso, projectKey, readJson, writeJsonAtomic } from "./utils.mjs";

export class StateStore {
  constructor(root = dataRoot()) {
    this.root = root;
    this.jobsRoot = path.join(root, "jobs");
    this.sessionsFile = path.join(root, "sessions.json");
  }

  async init() {
    await fs.mkdir(this.jobsRoot, { recursive: true });
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
    return next;
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
    return registry.sessions[this.sessionKey(projectDir, provider, taskId)];
  }

  async clearSession(projectDir, provider, taskId) {
    const registry = await this.sessions();
    delete registry.sessions[this.sessionKey(projectDir, provider, taskId)];
    await writeJsonAtomic(this.sessionsFile, registry);
  }
}
