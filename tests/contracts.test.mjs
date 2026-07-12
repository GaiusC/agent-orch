import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPlannerContract, loadPlannerSubtask, validatePlanSchema, persistPlan, loadPlan, loadPlans, ensureAdhocPlan, resolveJobPlan, buildLegacyPlanProjection, persistPlannerContract } from "../scripts/lib/contracts.mjs";
import { createPersistedPlannerContract } from "./fixtures/architecture.mjs";

test("planner contract is persisted with a verified digest and supplies auto complexity", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-contract-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await createPersistedPlannerContract(project, "task-1");
  const { contract, subtask } = await loadPlannerSubtask(project, "task-1", "impl-1");
  assert.equal(subtask.complexity, "low");
  assert.match(contract.contract_digest, /^[a-f0-9]{64}$/);
});

test("planner contract digest mismatch fails closed", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-contract-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const saved = await createPersistedPlannerContract(project, "task-1");
  const raw = JSON.parse(await fs.readFile(saved.file, "utf8"));
  raw.executor_subtasks[0].objective = "tampered";
  await fs.writeFile(saved.file, JSON.stringify(raw));
  await assert.rejects(() => loadPlannerSubtask(project, "task-1", "impl-1"), /digest mismatch/);
});

test("validatePlannerContractSchema rejects null/undefined", async () => {
  const { validatePlannerContractSchema } = await import("../scripts/lib/contracts.mjs");
  assert.ok(validatePlannerContractSchema(null).length > 0);
  assert.ok(validatePlannerContractSchema(undefined).length > 0);
});

test("validatePlannerContractSchema rejects missing contract_id", async () => {
  const { validatePlannerContractSchema } = await import("../scripts/lib/contracts.mjs");
  const bad = { contract_version: 1, executor_subtasks: [{ subtask_id: "s1", role: "executor", objective: "test", complexity: "low" }] };
  assert.ok(validatePlannerContractSchema(bad).length > 0);
});

test("validatePlannerContractSchema rejects missing contract_version", async () => {
  const { validatePlannerContractSchema } = await import("../scripts/lib/contracts.mjs");
  const bad = { contract_id: "c1", executor_subtasks: [{ subtask_id: "s1", role: "executor", objective: "test", complexity: "low" }] };
  assert.ok(validatePlannerContractSchema(bad).length > 0);
});

test("validatePlannerContractSchema rejects executor subtasks with provider", async () => {
  const { validatePlannerContractSchema } = await import("../scripts/lib/contracts.mjs");
  const bad = { contract_id: "c1", contract_version: 1, executor_subtasks: [{ subtask_id: "s1", role: "executor", objective: "test", complexity: "low", provider: "cc" }] };
  assert.ok(validatePlannerContractSchema(bad).length > 0, "should reject provider in subtask");
});

test("validatePlannerContractSchema rejects empty executor_subtasks", async () => {
  const { validatePlannerContractSchema } = await import("../scripts/lib/contracts.mjs");
  assert.ok(validatePlannerContractSchema({ contract_id: "c1", contract_version: 1, executor_subtasks: [] }).length > 0);
});

test("validatePlannerContractSchema passes valid contract", async () => {
  const { validatePlannerContractSchema } = await import("../scripts/lib/contracts.mjs");
  const valid = { contract_id: "c1", contract_version: 1, executor_subtasks: [{ subtask_id: "s1", role: "executor", objective: "test", complexity: "low" }] };
  assert.deepEqual(validatePlannerContractSchema(valid), []);
});

test("shared contract accessors return typed values and are null-safe", async (t) => {
  const { getContractTaskId, getContractId, getContractVersion, getContractDigest, getExecutorSubtasks, getContractRequiredTests, getContractDependencies } = await import("../scripts/lib/contracts.mjs");

  const contract = {
    task_id: "task-1",
    contract_id: "contract-1",
    contract_version: 2,
    contract_digest: "digest-abc",
    executor_subtasks: [{
      subtask_id: "s1", role: "executor", complexity: "mid", objective: "Implement feature",
      depends_on: ["dep-1"], writable_paths: ["src/"], forbidden_paths: [".git/**"],
      required_tests: ["npm test"], acceptance_criteria: ["works"], fallback_policy: { enabled: true },
    }],
  };

  assert.equal(getContractTaskId(contract), "task-1");
  assert.equal(getContractId(contract), "contract-1");
  assert.equal(getContractVersion(contract), 2);
  assert.equal(getContractDigest(contract), "digest-abc");
  const subtasks = getExecutorSubtasks(contract);
  assert.equal(subtasks.length, 1);
  assert.equal(subtasks[0].complexity, "mid");
  assert.equal(subtasks[0].objective, "Implement feature");
  assert.deepEqual(getContractRequiredTests(contract), ["npm test"]);
  assert.deepEqual(getContractDependencies(contract), ["dep-1"]);

  // Null-safe
  assert.equal(getContractTaskId(null), "");
  assert.equal(getContractId(null), "");
  assert.equal(getContractVersion(null), 1);
  assert.equal(getContractDigest(null), null);
  assert.deepEqual(getExecutorSubtasks(null), []);
  assert.deepEqual(getContractRequiredTests(null), []);
  assert.deepEqual(getContractDependencies(null), []);
});

test("loadPlannerSubtask fails closed on missing contract", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-missing-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await assert.rejects(() => loadPlannerSubtask(project, "no-such-task", "impl-1"), /Missing active Planner contract/);
});

test("loadPlannerContract fails closed on missing contract", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-missing2-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await assert.rejects(() => loadPlannerContract(project, "no-such-task"), /Missing active Planner contract/);
});

test("loadPlannerSubtask fails on invalid subtask_id", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-bad-sub-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await createPersistedPlannerContract(project, "task-bad");
  await assert.rejects(() => loadPlannerSubtask(project, "task-bad", "no-such-subtask"), /Invalid executor subtask_id/);
});

// ===================================================================
// Plan model tests
// ===================================================================

test("validatePlanSchema rejects invalid plans", async () => {
  const { validatePlanSchema } = await import("../scripts/lib/contracts.mjs");
  assert.ok(validatePlanSchema(null).length > 0);
  assert.ok(validatePlanSchema({}).length > 0);
  assert.ok(validatePlanSchema({ plan_id: "p1" }).length > 0, "missing type");
  assert.ok(validatePlanSchema({ plan_id: "p1", type: "invalid" }).length > 0, "invalid type");
  assert.deepEqual(validatePlanSchema({ plan_id: "p1", type: "formal" }), [], "valid formal plan");
  assert.deepEqual(validatePlanSchema({ plan_id: "p1", type: "adhoc" }), [], "valid adhoc plan");
  assert.deepEqual(validatePlanSchema({ plan_id: "p1", type: "legacy" }), [], "valid legacy plan");
});

test("persistPlan and loadPlan round-trip", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-plan-rt-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const saved = await persistPlan(project, { plan_id: "plan-test-1", name: "Test Plan", type: "formal", description: "A test plan" });
  assert.equal(saved.plan_id, "plan-test-1");
  assert.equal(saved.type, "formal");
  assert.ok(saved.created_at);
  assert.ok(saved.file);

  const loaded = await loadPlan(project, "plan-test-1");
  assert.ok(loaded);
  assert.equal(loaded.plan_id, "plan-test-1");
  assert.equal(loaded.type, "formal");
});

test("ensureAdhocPlan creates a single ad-hoc plan per project", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-adhoc-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));

  const first = await ensureAdhocPlan(project);
  assert.equal(first.type, "adhoc");
  assert.ok(first.plan_id);
  assert.match(first.name, /Ad-hoc/);

  const second = await ensureAdhocPlan(project);
  assert.equal(second.plan_id, first.plan_id, "should reuse the same ad-hoc plan");

  const allPlans = await loadPlans(project);
  assert.equal(allPlans.length, 1);
});

test("persistPlannerContract creates a formal plan with plan_id on contract", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-plan-contract-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));

  const saved = await persistPlannerContract(project, "plan-task-1", {
    contract_id: "contract-plan-test",
    contract_version: 1,
    executor_subtasks: [{ subtask_id: "impl-1", role: "executor", objective: "test", complexity: "low" }],
    reviewer_tasks: [],
  }, "session-1");

  // Contract should have a plan_id
  assert.ok(saved.plan_id, "contract should have plan_id after persist");

  // Plan should exist on disk
  const plan = await loadPlan(project, saved.plan_id);
  assert.ok(plan, "plan should be loadable");
  assert.equal(plan.type, "formal");

  const allPlans = await loadPlans(project);
  assert.ok(allPlans.length >= 1);
});

test("resolveJobPlan: direct execution uses ad-hoc plan", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-resolve-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));

  const result = await resolveJobPlan(project, "task-direct", { jobType: "cc_execute" });
  assert.ok(result.plan_id, "should have a plan_id");
  assert.equal(result.plan_type, "adhoc");
  assert.equal(result.association_reason, "auto_adhoc");
});

test("resolveJobPlan: planner-backed work uses contract plan", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-resolve2-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));

  const saved = await persistPlannerContract(project, "task-plan", {
    contract_id: "contract-plan", contract_version: 1,
    executor_subtasks: [{ subtask_id: "s1", role: "executor", objective: "test", complexity: "low" }],
    reviewer_tasks: [],
  }, "session-plan");

  const result = await resolveJobPlan(project, "task-plan", {
    contract: saved,
    jobType: "auto_execute",
  });
  assert.equal(result.plan_id, saved.plan_id);
  assert.equal(result.plan_type, "formal");
  assert.equal(result.association_reason, "planner_contract");
});

test("resolveJobPlan: continuation inherits plan from prior jobs", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-inherit-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));

  const priorJobs = [{
    id: "cc-prior-1", task_id: "task-inherit",
    plan_id: "plan-inherited", plan_type: "adhoc",
    created_at: "2026-07-01T00:00:00Z",
  }];

  const result = await resolveJobPlan(project, "task-inherit", {
    existingJobs: priorJobs,
    jobType: "cc_continue",
  });
  assert.equal(result.plan_id, "plan-inherited");
  assert.equal(result.association_reason, "inherited");
});

test("resolveJobPlan: no plan_id on prior jobs falls back to ad-hoc", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-noinherit-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));

  const priorJobs = [{ id: "old", task_id: "task-no-plan" }];
  const result = await resolveJobPlan(project, "task-no-plan", {
    existingJobs: priorJobs,
    jobType: "cc_execute",
  });
  assert.ok(result.plan_id);
  assert.equal(result.plan_type, "adhoc");
  assert.equal(result.association_reason, "auto_adhoc");
});

test("buildLegacyPlanProjection groups unmapped jobs", async () => {
  const jobs = [
    { id: "job-1", task_id: "t1", plan_id: "plan-1" },
    { id: "job-2", task_id: "t2" },
    { id: "job-3", task_id: "t3" },
    { id: "job-4", task_id: "t4", plan_id: "plan-2" },
  ];
  const legacy = buildLegacyPlanProjection(jobs);
  assert.equal(legacy.type, "legacy");
  assert.equal(legacy.job_count, 2);
  assert.deepEqual([...legacy.job_ids].sort(), ["job-2", "job-3"]);
  assert.equal(legacy.read_only, true);
});

test("loadPlans returns empty array for missing plans dir", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-noplans-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const plans = await loadPlans(project);
  assert.deepEqual(plans, []);
});
