import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../scripts/lib/state.mjs";

test("sessions are isolated by project, provider, and task", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new StateStore(root);
  await store.init();
  await store.setSession("C:/project-a", "cc", "task", { session_id: "one" });
  await store.setSession("C:/project-a", "agy", "task", { session_id: "two" });
  await store.setSession("C:/project-b", "cc", "task", { session_id: "three" });
  assert.equal((await store.getSession("C:/project-a", "cc", "task")).session_id, "one");
  assert.equal((await store.getSession("C:/project-a", "agy", "task")).session_id, "two");
  assert.equal((await store.getSession("C:/project-b", "cc", "task")).session_id, "three");
});

test("events rebuild current state and codex resume uses in-session roles", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-state-events-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"), { jobsRoot: path.join(root, "runs"), orchestratorRoot: root });
  await store.init();
  const job = await store.createJob({
    id: "cc-test",
    type: "cc_execute",
    provider: "cc",
    status: "completed",
    phase: "ready_for_acceptance",
    project_dir: "C:/project",
    task_id: "task",
    evidence_path: "C:/project/.agent-orchestrator/runs/cc-test/evidence.json",
    patch_path: "C:/project/.agent-orchestrator/runs/cc-test/changes.patch",
  });
  assert.equal(job.id, "cc-test");

  const resume = await store.resume({ projectDir: "C:/project", hostProvider: "codex" });
  assert.equal(resume.host_provider, "codex");
  assert.equal(resume.external_invocation_allowed.codex, false);
  assert.deepEqual(resume.in_session_roles, ["planner", "accepter", "coordinator"]);
  assert.equal(resume.ready_for_acceptance.length, 1);
  assert.match(resume.recommended_next_action, /Do not invoke Codex CLI/);

  const currentState = JSON.parse(await fs.readFile(path.join(root, "current-state.json"), "utf8"));
  assert.equal(currentState.ready_for_acceptance[0].id, "cc-test");
  const handoff = await fs.readFile(path.join(root, "handoff.generated.md"), "utf8");
  assert.match(handoff, /Agent Orch Generated Handoff/);
  assert.match(handoff, /cc-test/);
  const events = await fs.readFile(path.join(root, "events.jsonl"), "utf8");
  assert.match(events, /job.created/);
});

test("resume filters jobs to the requested project only", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"), { jobsRoot: path.join(root, "runs"), orchestratorRoot: root });
  await store.init();
  await store.createJob({
    id: "proj-a-job",
    type: "cc_execute",
    provider: "cc",
    status: "completed",
    phase: "ready_for_acceptance",
    project_dir: "C:/project-a",
    task_id: "task-a",
    evidence_path: "C:/project-a/.agent-orchestrator/runs/proj-a/evidence.json",
  });
  await store.createJob({
    id: "proj-b-job",
    type: "cc_execute",
    provider: "cc",
    status: "running",
    phase: "execute",
    project_dir: "C:/project-b",
    task_id: "task-b",
  });
  await store.createJob({
    id: "proj-b-job-2",
    type: "cc_execute",
    provider: "cc",
    status: "failed",
    phase: "execute",
    project_dir: "C:/project-b",
    task_id: "task-b2",
    error: "simulated failure",
  });

  // Resume for project-a only -- should only see proj-a-job
  const resumeA = await store.resume({ projectDir: "C:/project-a", hostProvider: "codex" });
  assert.equal(resumeA.ready_for_acceptance.length, 1);
  assert.equal(resumeA.ready_for_acceptance[0].id, "proj-a-job");
  assert.equal(resumeA.active_jobs.length, 0);
  assert.equal(resumeA.failed_jobs.length, 0);
  assert.equal(resumeA.recent_jobs.length, 1);

  // Resume for project-b only -- should see both project-b jobs
  const resumeB = await store.resume({ projectDir: "C:/project-b", hostProvider: "codex" });
  assert.equal(resumeB.ready_for_acceptance.length, 0);
  assert.equal(resumeB.active_jobs.length, 1);
  assert.equal(resumeB.active_jobs[0].id, "proj-b-job");
  assert.equal(resumeB.failed_jobs.length, 1);
  assert.equal(resumeB.failed_jobs[0].id, "proj-b-job-2");
  assert.equal(resumeB.recent_jobs.length, 2);

  // Resume with no projectDir -- should see all three jobs
  const resumeAll = await store.resume({ hostProvider: "codex" });
  assert.equal(resumeAll.ready_for_acceptance.length, 1);
  assert.equal(resumeAll.active_jobs.length, 1);
  assert.equal(resumeAll.failed_jobs.length, 1);
  assert.equal(resumeAll.recent_jobs.length, 3);
});

test("resume filters sessions to the requested project only", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"), { jobsRoot: path.join(root, "runs"), orchestratorRoot: root });
  await store.init();
  await store.setSession("C:/project-a", "cc", "task-1", { session_id: "a-cc-1" });
  await store.setSession("C:/project-a", "agy", "task-2", { session_id: "a-agy-2" });
  await store.setSession("C:/project-b", "cc", "task-3", { session_id: "b-cc-3" });

  // Resume for project-a only -- should only see project-a sessions
  const resumeA = await store.resume({ projectDir: "C:/project-a", hostProvider: "unknown" });
  const sessionKeysA = Object.keys(resumeA.sessions);
  assert.equal(sessionKeysA.length, 2);
  assert.ok(sessionKeysA.every((k) => k.includes("cc") || k.includes("agy")));

  // Resume for project-b only -- should only see project-b sessions
  const resumeB = await store.resume({ projectDir: "C:/project-b", hostProvider: "unknown" });
  const sessionKeysB = Object.keys(resumeB.sessions);
  assert.equal(sessionKeysB.length, 1);

  // Resume with no projectDir -- should see all sessions
  const resumeAll = await store.resume({ hostProvider: "unknown" });
  const sessionKeysAll = Object.keys(resumeAll.sessions);
  assert.ok(sessionKeysAll.length >= 3);
});
