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
