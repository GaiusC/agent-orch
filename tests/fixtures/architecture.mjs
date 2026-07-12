import fs from "node:fs/promises";
import path from "node:path";
import { persistPlannerContract } from "../../scripts/lib/contracts.mjs";

export { persistPlannerContract };

export function createExecutorSubtaskFixture(overrides = {}) {
  return { subtask_id: "impl-1", role: "executor", complexity: "low", objective: "Implement fixture", depends_on: [], writable_paths: ["feature.txt"], forbidden_paths: [".git/**"], required_tests: ["node verify.cjs"], fallback_policy: { enabled: true }, acceptance_criteria: ["feature works"], ...overrides };
}

/** Create a low-complexity executor subtask (routes to CC flash). */
export function createLowExecutorSubtask(overrides = {}) {
  return createExecutorSubtaskFixture({ complexity: "low", ...overrides });
}

/** Create a mid-complexity executor subtask (routes to CC flash). */
export function createMidExecutorSubtask(overrides = {}) {
  return createExecutorSubtaskFixture({ complexity: "mid", ...overrides });
}

/** Create a high-complexity executor subtask (routes to CC pro). */
export function createHighExecutorSubtask(overrides = {}) {
  return createExecutorSubtaskFixture({ complexity: "high", ...overrides });
}

/** Create a Planner contract with a single executor subtask at the given tier. */
export function createPlannerContractForTier(projectDir, taskId, tier, overrides = {}) {
  const subtaskFns = { low: createLowExecutorSubtask, mid: createMidExecutorSubtask, high: createHighExecutorSubtask };
  const fn = subtaskFns[tier] || createLowExecutorSubtask;
  return persistPlannerContract(projectDir, taskId, {
    contract_id: `contract-${taskId}`,
    contract_version: 1,
    repository_identity: "auto-test",
    executor_subtasks: [fn(overrides)],
    reviewer_tasks: [],
  }, `planner-session-${taskId}`);
}

export function createPlannerContractFixture(overrides = {}) {
  return { contract_id: "contract-1", contract_version: 1, repository_identity: "fixture", executor_subtasks: [createExecutorSubtaskFixture()], reviewer_tasks: [{ review_id: "review-1", role: "reviewer", type: "verify", complexity: "low", target_subtask_ids: ["impl-1"], required_checks: ["tests"], fallback_policy: { enabled: false } }], ...overrides };
}

export async function createPersistedPlannerContract(projectDir, taskId = "task-1", overrides = {}) {
  return persistPlannerContract(projectDir, taskId, createPlannerContractFixture(overrides), "planner-session-1");
}

export function createAcceptanceFixture(overrides = {}) {
  return { decision: "accepted", task_id: "task-1", job_id: "job-1", patch_digest: "digest", reviewer_job_id: "review-1", ...overrides };
}

export async function writeAcceptanceFixture(jobDir, fixture = createAcceptanceFixture()) {
  const file = path.join(jobDir, "acceptance.json");
  await fs.writeFile(file, JSON.stringify(fixture, null, 2));
  return file;
}

// Exercise the production accepter path rather than constructing an artifact
// that can drift from the gate enforced by WorkerOrchestrator.apply().
export async function acceptReadyJob(orchestrator, { projectDir, taskId, jobId, decision = "accepted", session_id = null }) {
  const args = {
    project_dir: projectDir,
    task_id: taskId,
    job_id: jobId,
    decision,
  };
  if (session_id) args.session_id = session_id;
  return orchestrator.accept(args);
}

export function createReviewerEvidenceFixture(overrides = {}) {
  return {
    id: "agy-verify-1",
    type: "agy_verify",
    provider: "agy",
    status: "completed",
    phase: "completed",
    goal: "Verify implementation",
    plan: "",
    complexity: "low",
    acceptance_commands: [],
    evidence: { status: "completed" },
    ...overrides,
  };
}

export async function createCompletedReviewerEvidence(store, { projectDir, taskId, implementationJob, ...overrides }) {
  const fixture = createReviewerEvidenceFixture(overrides);
  const evidencePath = path.join(store.jobDir(fixture.id), "evidence.json");
  await fs.mkdir(store.jobDir(fixture.id), { recursive: true });
  await fs.writeFile(evidencePath, JSON.stringify(fixture.evidence));
  await store.createJob({
    ...fixture,
    project_dir: projectDir,
    task_id: taskId,
    evidence_path: evidencePath,
    // Reviewer evidence must be newer than the implementation it accepts.
    finished_at: new Date(Date.parse(implementationJob.finished_at || 0) + 1).toISOString(),
  });
  return fixture;
}

/**
 * Create a Planner contract for auto-route tests.  The subtask complexity
 * drives executor routing and model selection; the objective becomes the
 * goal passed to the executor worker.
 */
export async function createAutoPlannerContract(projectDir, taskId, { subtaskId = "impl-1", complexity = "low", objective = "Create feature.txt containing good", writablePaths = ["feature.txt"], requiredTests = ["node verify.cjs"] } = {}) {
  return persistPlannerContract(projectDir, taskId, {
    contract_id: `contract-${taskId}`,
    contract_version: 1,
    repository_identity: "auto-test",
    executor_subtasks: [{
      subtask_id: subtaskId,
      role: "executor",
      complexity,
      objective,
      depends_on: [],
      writable_paths: writablePaths,
      forbidden_paths: [".git/**", ".env", ".env.*"],
      required_tests: requiredTests,
      fallback_policy: { enabled: true },
      acceptance_criteria: ["feature works"],
    }],
    reviewer_tasks: [],
  }, `planner-session-${taskId}`);
}
