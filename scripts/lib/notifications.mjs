import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { processExists } from "./process.mjs";
import { readJson, writeJsonAtomic } from "./utils.mjs";

export const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export const CHECKPOINTS = ["inspection_done", "implementation_done", "testing", "reviewing", "finding", "blocked"];
export const shortText = (value, limit = 240) => Array.from(String(value ?? "").replace(/[\x00-\x1f]+/g, " ").trim()).slice(0, limit).join("");
const hash = value => crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const validId = id => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id);
async function readLedger(file) {
  try { return await readJson(file); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { cursor: 0, offsets: {}, signatures: {}, jobs: [] };
  }
}

export async function withFileLock(file, action, signal) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 5000;
  let handle;
  while (!handle) {
    if (signal?.aborted) throw new Error("Notification operation cancelled");
    try {
      handle = await fs.open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
    } catch (error) {
      if (handle) { await handle.close(); await fs.unlink(file).catch(() => {}); throw error; }
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.stat(file).catch(() => null);
      const owner = await readJson(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 10000 && (!owner?.pid || !processExists(owner.pid))) {
        await fs.unlink(file).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Notification consumer is busy; retry the wait");
      await pause(25);
    }
  }
  try { return await action(); }
  finally { await handle.close(); await fs.unlink(file).catch(() => {}); }
}

export function runtimeState(job, managed = false) {
  if (TERMINAL.has(job.status)) return "terminal";
  if (job.process_pid && processExists(job.process_pid)) return "external_process_alive";
  if (managed || (job.supervisor_pid && processExists(job.supervisor_pid))) return "managed_in_process";
  if (Date.now() - Date.parse(job.created_at || "") < 15000) return "starting";
  return "interrupted";
}

export function compactJob(job, managed = false) {
  const runtime_state = runtimeState(job, managed);
  const attention = job.status === "failed" || runtime_state === "interrupted";
  const action_required = attention || job.phase === "ready_for_acceptance" || (job.status === "completed" && /review|verify/.test(job.type) && job.phase === "completed");
  const value = { id: job.id, status: job.status, phase: job.phase, runtime_state, action_required };
  for(const key of ['task_commit_id','task_branch','target_branch','delivery_status','integration_status','workspace_status']) if(job[key]) value[key]=job[key];
  if (job.adaptive_escalation) value.effective_complexity=job.effective_complexity;
  if (job.review_route_attempts?.length>1) value.actual_model=job.model;
  if (job.closeout_phase) {
    value.closeout_phase = job.closeout_phase;
    value.action_required = !['closed', 'committed', 'wip_preserved'].includes(job.closeout_phase);
    if (job.commit_id) value.commit_id = job.commit_id;
  }
  if (attention) value.error = { code: runtime_state === "interrupted" ? "JOB_INTERRUPTED" : errorCode(job.error), summary: shortText(job.error?.split("\n")[0] || (runtime_state === "interrupted" ? "Task interrupted; inspect preserved session and logs." : "Task failed; inspect verification and job details.")) };
  return value;
}

function errorCode(error) {
  return String(error || "").match(/\b(?:AGY|CODEX|JOB|TASK|BRANCH|TARGET|ENVIRONMENT|WORKSPACE)_[A-Z_]+\b/)?.[0] || "JOB_FAILED";
}

export function resultSummary(job, evidence) {
  const summary = { job: compactJob(job), evidence_available: Boolean(evidence), next_action: "inspect_failure" };
  if (!evidence) {
    summary.next_action = TERMINAL.has(job.status) ? "inspect_job_details" : "wait_for_job";
    return summary;
  }
  if (evidence.finalization) {
    const result = evidence.finalization;
    summary.finalization = { status: result.status, commit_id: result.commit_id, cleanup: result.cleanup, remaining_count: result.remaining_path_count ?? result.remaining_paths?.length ?? 0,
      ...(result.task_commit_id?{task_commit_id:result.task_commit_id,integration_status:result.integration_status,workspace_status:result.workspace_status}: {}) };
    summary.evidence_path = job.evidence_path;
    summary.details = ['full']; summary.next_action = result.status === 'closed' ? 'none' : 'inspect_closeout';
    return summary;
  }
  const verification = evidence.verification;
  summary.evidence = {
    status: evidence.status,
    ...(verification ? { verification: { configured: verification.configured, passed: verification.passed, commands: verification.results?.length || 0, failed_commands: verification.results?.filter(item => item.exit_code !== 0 || item.timed_out || item.cancelled).length || 0 } } : {}),
    ...(evidence.changes ? { changes: { count: evidence.changes.changed_files?.length || 0, patch_digest: evidence.changes.patch_digest, forbidden_count: evidence.changes.forbidden_changes?.length || 0, unauthorized_count: evidence.changes.unauthorized_changes?.length || 0 } } : {}),
    ...(evidence.mode === "review" ? { review_verdict: /VERDICT:\s*(PASS|FAIL)/i.exec(evidence.result || "")?.[1]?.toUpperCase() || "unknown", evidence_state: evidence.review_evidence ? "recorded_patch_bound_review_requires_validation" : "missing_review_evidence" } : {}),
  };
  summary.details = ["verification", "changes", "findings", "attempts", "full"];
  summary.evidence_path = job.evidence_path;
  if (job.status === "completed") summary.next_action = evidence.mode === "review" ? "inspect_acceptance_evidence" : job.requires_agy_review ? "inspect_then_review" : "inspect_acceptance_evidence";
  if (job.closeout_phase) summary.next_action = job.closeout_phase === 'closed' ? 'none' : 'stage_finalize';
  return summary;
}

export async function prepareProgressChannel(jobDir, { projectDir, role }) {
  const directory = path.join(jobDir, "reporting");
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomic(path.join(directory, "binding.json"), { job_id: path.basename(jobDir), project_dir: projectDir, role });
  return directory;
}

export async function reportProgress(directory, input) {
  if (!CHECKPOINTS.includes(input.checkpoint)) throw new Error("Unknown progress checkpoint");
  const message = shortText(input.message);
  if (!message) throw new Error("Progress message must not be empty");
  const binding = await readJson(path.join(directory, "binding.json"));
  const job = await readJson(path.join(directory, "..", "job.json")).catch(() => null);
  if (!job || job.id !== binding.job_id || path.resolve(job.project_dir) !== path.resolve(binding.project_dir) || TERMINAL.has(job.status)) throw new Error("Reporting channel is closed or not bound to an active job");
  return withFileLock(path.join(directory, "progress.lock"), async () => {
    const file = path.join(directory, "progress.jsonl");
    const previous = await readJson(path.join(directory, "last.json")).catch(() => null);
    const key = hash(JSON.stringify([input.checkpoint, message]));
    if (previous?.key === key) return { accepted: false, duplicate: true };
    const count = previous?.count || 0;
    // Bound normal node reports. Attention remains available even after the cap.
    if (input.checkpoint === "blocked" ? (previous?.attention_count || 0) >= 4 : count >= 16) return { accepted: false, limit_reached: true };
    const event = { job_id: binding.job_id, role: binding.role, type: input.checkpoint === "blocked" ? "attention" : "progress", checkpoint: input.checkpoint, message, source: "agent_report", timestamp: new Date().toISOString() };
    await fs.appendFile(file, JSON.stringify(event) + "\n", "utf8");
    await writeJsonAtomic(path.join(directory, "last.json"), { key, count: count + 1, attention_count: (previous?.attention_count || 0) + (input.checkpoint === "blocked" ? 1 : 0) });
    return { accepted: true };
  });
}

export class JobNotifications {
  constructor(store, { managed = () => false } = {}) { this.store = store; this.managed = managed; }

  consumerFile(consumer = "default") {
    if (typeof consumer !== "string" || !consumer.trim() || consumer.length > 200) throw new Error("Invalid consumer_id");
    return path.join(this.store.orchestratorRoot, "notifications", `${hash(consumer)}.json`);
  }

  async register(jobId, consumer = "default") {
    const file = this.consumerFile(consumer);
    await withFileLock(file + ".lock", async () => {
      const state = await readLedger(file);
      state.jobs = [...new Set([...state.jobs, jobId])];
      await writeJsonAtomic(file, state);
    });
  }

  async subscribed(consumer = "default") {
    return (await readLedger(this.consumerFile(consumer))).jobs;
  }

  async progress(jobId, offset) {
    const file = path.join(this.store.jobDir(jobId), "reporting", "progress.jsonl");
    let handle;
    try {
      handle = await fs.open(file, "r");
      const stat = await handle.stat();
      if (offset > stat.size) throw new Error("Progress log was truncated; preserved cursor cannot be reused");
      const buffer = Buffer.alloc(Math.min(65536, stat.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (end < 0) return { offset, events: [] };
      const lines = buffer.subarray(0, end).toString("utf8").split("\n");
      const events = lines.filter(Boolean).map(line => JSON.parse(line));
      // A bound reporter is the only normal writer; still whitelist its fields.
      return { offset: offset + end + 1, events: events.filter(event => event.job_id === jobId).map(event => ({ job_id: jobId, role: event.role === "reviewer" ? "reviewer" : "worker", type: event.type === "attention" ? "attention" : "progress", checkpoint: shortText(event.checkpoint, 32), message: shortText(event.message), source: "agent_report" })) };
    } catch (error) { if (error.code === "ENOENT") return { offset, events: [] }; throw error; }
    finally { await handle?.close(); }
  }

  async wait({ project_dir, job_id, job_ids, consumer_id = "default", cursor, until = "terminal", timeout_ms = 30000, signal } = {}) {
    if (job_id && job_ids) throw new Error("Provide job_id or job_ids, not both");
    const ids = job_ids ?? (job_id ? [job_id] : []);
    if (!Array.isArray(ids) || !ids.length || ids.length > 8 || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) throw new Error("Select 1-8 unique job ids");
    if (!["update", "terminal"].includes(until)) throw new Error("until must be update or terminal");
    if (!Number.isInteger(timeout_ms) || timeout_ms < 0 || timeout_ms > 60000) throw new Error("timeout_ms must be 0-60000");
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error("Invalid cursor");
    const file = this.consumerFile(consumer_id);
    const deadline = Date.now() + timeout_ms;
    do {
      if (signal?.aborted) return { events: [], cancelled: true };
      const result = await withFileLock(file + ".lock", async () => {
        const state = await readLedger(file);
        if (cursor > state.cursor) throw new Error("Cursor is ahead of this project/consumer ledger");
        const events = [],terminal_states=[];
        for (const id of ids) {
          const job = await this.store.getJob(id);
          if (!job || path.resolve(job.project_dir) !== path.resolve(project_dir)) throw new Error(`Unknown job in requested project: ${id}`);
          const progress = await this.progress(id, state.offsets[id] || 0);
          state.offsets[id] = progress.offset;
          const runtime = runtimeState(job, this.managed(id));
          if(TERMINAL.has(job.status)) terminal_states.push({job_id:id,status:job.status,phase:job.phase});
          const signature = TERMINAL.has(job.status) ? `terminal:${job.status}` : runtime === "interrupted" ? "interrupted" : null;
          if (signature && state.signatures[id] !== signature) {
            events.push({ job_id: id, role: /review|verify/.test(job.type) ? "reviewer" : "worker", type: runtime === "interrupted" ? "attention" : "terminal", status: job.status, phase: job.phase, runtime_state: runtime, next_action: runtime === "interrupted" ? "inspect_session" : job.status === "completed" ? "inspect_result" : "inspect_failure", ...(job.error || runtime === "interrupted" ? { message: shortText(job.error?.split("\n")[0] || "Task interrupted; inspect preserved session.") } : {}) });
            state.signatures[id] = signature;
          } else if (!TERMINAL.has(job.status)) {
            const attention = progress.events.filter(event => event.type === "attention").at(-1);
            const update = until === "update" ? progress.events.filter(event => event.type === "progress").at(-1) : null;
            if (attention) events.push(attention);
            else if (update) events.push(update);
          }
        }
        if (events.length) state.cursor += 1;
        state.jobs = [...new Set([...state.jobs, ...ids])].filter(id => !state.signatures[id]?.startsWith("terminal:"));
        await writeJsonAtomic(file, state);
        return { cursor: state.cursor, events, ...(terminal_states.length===ids.length?{terminal:true,terminal_states}: {}) };
      }, signal);
      if (result.events.length || result.terminal) return result;
      if (Date.now() >= deadline) return { ...result, timed_out: true };
      await pause(Math.min(250, Math.max(0, deadline - Date.now())));
    } while (true);
  }
}
