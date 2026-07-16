import fs from "node:fs/promises";
import path from "node:path";
import { projectOrchestratorRoot, projectPlansRoot } from "./config.mjs";
import { newId, nowIso, pathExists, readJson, writeJsonAtomic } from "./utils.mjs";

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

export class StageRuntime {
  constructor(store, projectDir) {
    this.store = store;
    this.projectDir = path.resolve(projectDir);
    this.root = path.join(projectOrchestratorRoot(this.projectDir), "stages");
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(projectPlansRoot(this.projectDir), { recursive: true });
  }

  file(stageRunId) {
    return path.join(this.root, `${stageRunId}.json`);
  }

  async create(stage, details = {}) {
    await this.init();
    const stageRun = {
      stage_run_id: details.stage_run_id || newId(`stage-${stage}`),
      stage,
      status: details.status || "running",
      project_dir: this.projectDir,
      created_at: nowIso(),
      updated_at: nowIso(),
      ...details,
    };
    await writeJsonAtomic(this.file(stageRun.stage_run_id), stageRun);
    return stageRun;
  }

  async get(stageRunId) {
    if (!(await pathExists(this.file(stageRunId)))) return null;
    return readJson(this.file(stageRunId));
  }

  async update(stageRunId, patch) {
    const current = await this.get(stageRunId);
    if (!current) throw new Error(`Unknown stage run: ${stageRunId}`);
    const next = { ...current, ...patch, updated_at: nowIso() };
    await writeJsonAtomic(this.file(stageRunId), next);
    return next;
  }

  async syncWithJob(stageRunId, job = null) {
    const stageRun = await this.get(stageRunId);
    if (!stageRun) return null;
    const linkedJob = job || (stageRun.job_id ? await this.store.getJob(stageRun.job_id) : null);
    if (!linkedJob) return stageRun;
    const terminal = TERMINAL_JOB_STATUSES.has(linkedJob.status);
    return this.update(stageRunId, {
      status: terminal ? linkedJob.status : "running",
      phase: linkedJob.phase || null,
      provider: linkedJob.provider || stageRun.provider || null,
      model: linkedJob.model || stageRun.model || null,
      session_id: linkedJob.session_id || stageRun.session_id || null,
      job_id: linkedJob.id,
      finished_at: terminal ? (linkedJob.finished_at || nowIso()) : null,
      error: linkedJob.error || null,
    });
  }

  planIdentityFile(taskId) {
    return path.join(projectPlansRoot(this.projectDir), `${taskId}.execution.json`);
  }

  async savePlanIdentity(taskId, identity) {
    const file = this.planIdentityFile(taskId);
    if (await pathExists(file)) {
      const existing = await readJson(file);
      const stableFields = ["provider", "model", "invocation", "session_id", "contract_id", "contract_digest"];
      for (const field of stableFields) {
        if ((existing[field] || null) !== (identity[field] || null)) {
          throw new Error(`Plan execution identity is immutable for task_id=${taskId}; ${field} changed`);
        }
      }
      return { ...existing, file };
    }
    const value = {
      version: 1,
      task_id: taskId,
      created_at: nowIso(),
      ...identity,
    };
    await writeJsonAtomic(file, value);
    return { ...value, file };
  }

  async loadPlanIdentity(taskId) {
    const file = this.planIdentityFile(taskId);
    if (!(await pathExists(file))) throw new Error(`Missing Plan execution identity for task_id=${taskId}`);
    return { ...(await readJson(file)), file };
  }
}
