import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { projectOrchestratorRoot, projectPlansRoot } from "./config.mjs";
import { matchesPathPattern, normalizeRelative, newId, nowIso, readJson, writeJsonAtomic } from "./utils.mjs";

// -- Strict schema validation for Planner contracts --

const VALID_ROLES = new Set(["executor", "reviewer"]);
const VALID_REVIEWER_TYPES = new Set(["verify"]);
const VALID_COMPLEXITIES = new Set(["low", "mid", "high"]);

/**
 * Validate a Planner contract's structure strictly, returning an array of
 * validation error strings.  Returns an empty array when the contract is valid.
 * This is a pure validation pass — it does NOT mutate or normalize the contract.
 */
export function validatePlannerContractSchema(contract) {
  const errors = [];

  if (!contract || typeof contract !== "object") {
    return ["Contract must be a non-null object"];
  }

  // task_id: required non-empty string (may be injected by persistPlannerContract
  // from the taskId parameter; normalizePlannerContract enforces this post-merge)
  const taskId = String(contract.task_id || "").trim();
  if (!taskId) {
    // Soft validation: warn but don't reject — task_id is added at persist time.
  }

  // contract_id: required non-empty string
  if (!contract.contract_id || !String(contract.contract_id).trim()) {
    errors.push("Planner contract is missing required field: contract_id");
  }

  // contract_version: required positive integer
  const version = Number(contract.contract_version);
  if (!Number.isInteger(version) || version < 1) {
    errors.push("Planner contract is missing or has invalid contract_version (must be a positive integer)");
  }

  // executor_subtasks: required non-empty array
  const subtasks = contract.executor_subtasks || contract.subtasks || [];
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    errors.push("Planner contract must have at least one executor_subtask");
  } else {
    subtasks.forEach((sub, i) => {
      const idx = `executor_subtasks[${i}]`;
      if (!sub || typeof sub !== "object") {
        errors.push(`${idx}: must be a non-null object`);
        return;
      }
      const sid = String(sub.subtask_id || "").trim();
      if (!sid) errors.push(`${idx}: missing subtask_id`);
      if (sub.role !== "executor") errors.push(`${idx}: role must be "executor"`);
      if (!sub.objective || !String(sub.objective).trim()) errors.push(`${idx}: missing objective`);
      if (sub.complexity && !VALID_COMPLEXITIES.has(normalizeComplexity(sub.complexity))) {
        errors.push(`${idx}: invalid complexity "${sub.complexity}"`);
      }
      if (sub.provider || sub.model || sub.executor) {
        errors.push(`${idx}: must not select provider, model, or executor (handled by registry)`);
      }
    });
  }

  // reviewer_tasks: optional but must be valid if present
  const reviews = contract.reviewer_tasks || contract.reviews || [];
  if (reviews.length > 0) {
    if (!Array.isArray(reviews)) {
      errors.push("reviewer_tasks must be an array");
    } else {
      reviews.forEach((rev, i) => {
        const idx = `reviewer_tasks[${i}]`;
        if (!rev || typeof rev !== "object") {
          errors.push(`${idx}: must be a non-null object`);
          return;
        }
        if (rev.role !== "reviewer") errors.push(`${idx}: role must be "reviewer"`);
        if (rev.type !== "verify") errors.push(`${idx}: type must be "verify"`);
        if (!rev.review_id || !String(rev.review_id).trim()) errors.push(`${idx}: missing review_id`);
        if (rev.complexity && !VALID_COMPLEXITIES.has(normalizeComplexity(rev.complexity))) {
          errors.push(`${idx}: invalid complexity "${rev.complexity}"`);
        }
      });
    }
  }

  return errors;
}

/**
 * Assert that a Planner contract passes validatePlannerContractSchema().
 * Throws on the first validation error, or a summary if multiple.
 */
export function assertPlannerContractValid(contract) {
  const errors = validatePlannerContractSchema(contract);
  if (errors.length > 0) {
    throw new Error(`Planner contract validation failed:\n  ${errors.join("\n  ")}`);
  }
}

// -- Shared accessors for Planner contract fields --

export function getContractTaskId(contract) {
  return String(contract?.task_id || "").trim();
}

export function getContractId(contract) {
  return String(contract?.contract_id || getContractTaskId(contract) || "").trim();
}

export function getContractVersion(contract) {
  return Number(contract?.contract_version || 1);
}

export function getContractDigest(contract) {
  return contract?.contract_digest || null;
}

export function getExecutorSubtasks(contract) {
  const raw = contract?.executor_subtasks || contract?.subtasks || [];
  return raw.filter((s) => s?.role === "executor").map((s) => ({
    subtask_id: String(s.subtask_id || "").trim(),
    complexity: s.complexity || "low",
    objective: String(s.objective || "").trim(),
    depends_on: stringList(s.depends_on),
    writable_paths: stringList(s.writable_paths),
    forbidden_paths: stringList(s.forbidden_paths),
    required_tests: stringList(s.required_tests),
    acceptance_criteria: stringList(s.acceptance_criteria),
    fallback_policy: { enabled: s.fallback_policy?.enabled === true },
  }));
}

export function getReviewerTasks(contract) {
  const raw = contract?.reviewer_tasks || contract?.reviews || [];
  return raw.filter((r) => r?.role === "reviewer").map((r) => ({
    review_id: String(r.review_id || "").trim(),
    complexity: r.complexity || "low",
    target_subtask_ids: stringList(r.target_subtask_ids),
    required_checks: stringList(r.required_checks),
    fallback_policy: { enabled: r.fallback_policy?.enabled === true },
  }));
}

export function getContractGoal(contract) {
  const subtasks = getExecutorSubtasks(contract);
  return subtasks[0]?.objective || "";
}

export function getContractWritablePaths(contract) {
  const subtasks = getExecutorSubtasks(contract);
  return subtasks.flatMap((s) => s.writable_paths).filter(Boolean);
}

export function getContractForbiddenPaths(contract) {
  const subtasks = getExecutorSubtasks(contract);
  return subtasks.flatMap((s) => s.forbidden_paths).filter(Boolean);
}

export function getContractRequiredTests(contract) {
  const subtasks = getExecutorSubtasks(contract);
  return subtasks.flatMap((s) => s.required_tests).filter(Boolean);
}

export function getContractAcceptanceCriteria(contract) {
  const subtasks = getExecutorSubtasks(contract);
  return subtasks.flatMap((s) => s.acceptance_criteria).filter(Boolean);
}

export function getContractDependencies(contract) {
  const subtasks = getExecutorSubtasks(contract);
  return subtasks.flatMap((s) => s.depends_on).filter(Boolean);
}

export async function loadContracts(projectDir) {
  const contractsDir = path.join(projectOrchestratorRoot(projectDir), "contracts");
  const entries = await fs.readdir(contractsDir, { withFileTypes: true }).catch(() => []);
  const contracts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(contractsDir, entry.name);
    const value = await readJson(file);
    contracts.push(normalizeContract(value, file));
  }
  return contracts.sort((a, b) => a.task_id.localeCompare(b.task_id));
}

export async function persistPlannerContract(projectDir, taskId, contract, plannerSession) {
  assertPlannerContractValid(contract);
  // Ensure a Plan exists for this contract; plan_id is stored on the contract.
  const plan = await ensurePlanForContract(projectDir, taskId, contract);
  const normalized = normalizePlannerContract({
    ...contract,
    task_id: taskId,
    planner_session_id: plannerSession,
    contract_id: contract.contract_id || taskId,
    contract_version: contract.contract_version || 1,
    plan_id: plan.plan_id,
  });
  normalized.contract_digest = computeContractDigest(normalized);
  const dir = path.join(projectOrchestratorRoot(projectDir), "contracts");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${taskId}.json`);
  await writeJsonAtomic(file, normalized);
  return { ...normalized, file };
}

export async function loadPlannerSubtask(projectDir, taskId, subtaskId) {
  const file = path.join(projectOrchestratorRoot(projectDir), "contracts", `${taskId}.json`);
  const contract = await readJson(file).catch(() => null);
  if (!contract) throw new Error(`Missing active Planner contract for task_id=${taskId}`);
  const normalized = normalizePlannerContract(contract, file);
  const subtask = normalized.executor_subtasks.find((item) => item.subtask_id === subtaskId);
  if (!subtask) throw new Error(`Invalid executor subtask_id=${subtaskId} for task_id=${taskId}`);
  return { contract: normalized, subtask };
}

export async function loadPlannerContract(projectDir, taskId) {
  const file = path.join(projectOrchestratorRoot(projectDir), "contracts", `${taskId}.json`);
  const contract = await readJson(file).catch(() => null);
  if (!contract) throw new Error(`Missing active Planner contract for task_id=${taskId}`);
  const normalized = normalizePlannerContract(contract, file);
  // Ensure plan_id exists on the loaded contract (backfill for pre-provenance contracts)
  if (!normalized.plan_id) {
    try {
      const plan = await ensurePlanForContract(projectDir, taskId, normalized);
      normalized.plan_id = plan.plan_id;
    } catch {
      // Non-critical: proceed without plan_id for legacy contracts
    }
  }
  return normalized;
}

export function normalizePlannerContract(contract, file = null) {
  const taskId = String(contract.task_id || "").trim();
  if (!taskId) throw new Error(`Planner contract is missing task_id${file ? `: ${file}` : ""}`);
  const executor_subtasks = Array.isArray(contract.executor_subtasks || contract.subtasks)
    ? (contract.executor_subtasks || contract.subtasks).map(normalizeExecutorSubtask)
    : [];
  const reviewer_tasks = Array.isArray(contract.reviewer_tasks || contract.reviews)
    ? (contract.reviewer_tasks || contract.reviews).map(normalizeReviewerTask)
    : [];
  if (!executor_subtasks.length) throw new Error(`Planner contract ${taskId} has no executor_subtasks`);
  const planId = String(contract.plan_id || contract.planId || "").trim();
  const normalized = { ...contract, task_id: taskId, plan_id: planId || undefined, contract_id: String(contract.contract_id || taskId), contract_version: Number(contract.contract_version || 1), executor_subtasks, reviewer_tasks, file };
  if (contract.contract_digest && contract.contract_digest !== computeContractDigest(normalized)) throw new Error(`Planner contract digest mismatch for ${taskId}`);
  return normalized;
}

export function computeContractDigest(contract) {
  const { contract_digest, file, ...canonical } = contract;
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function normalizeExecutorSubtask(value) {
  const subtask_id = String(value.subtask_id || "").trim();
  const complexity = normalizeComplexity(value.complexity);
  if (!subtask_id || value.role !== "executor" || !String(value.objective || "").trim()) {
    throw new Error("Executor subtask requires subtask_id, role=executor, objective, and complexity");
  }
  if (value.provider || value.model || value.executor) throw new Error("Planner contracts must not select provider, model, or executor");
  return {
    ...value,
    subtask_id,
    complexity,
    depends_on: stringList(value.depends_on),
    writable_paths: stringList(value.writable_paths),
    forbidden_paths: stringList(value.forbidden_paths),
    required_tests: stringList(value.required_tests),
    acceptance_criteria: stringList(value.acceptance_criteria),
    fallback_policy: { enabled: value.fallback_policy?.enabled === true },
  };
}

function normalizeReviewerTask(value) {
  if (value.role !== "reviewer" || value.type !== "verify") throw new Error("Reviewer task requires role=reviewer and type=verify");
  return { ...value, complexity: normalizeComplexity(value.complexity), target_subtask_ids: stringList(value.target_subtask_ids), required_checks: stringList(value.required_checks), fallback_policy: { enabled: value.fallback_policy?.enabled === true } };
}

function normalizeComplexity(value) {
  const complexity = String(value || "").toLowerCase() === "medium" ? "mid" : String(value || "").toLowerCase();
  if (!["low", "mid", "high"].includes(complexity)) throw new Error(`Unknown complexity: ${value}`);
  return complexity;
}

export function normalizeContract(contract, file = null) {
  const taskId = String(contract.task_id || contract.taskId || "").trim();
  if (!taskId) throw new Error(`Contract is missing task_id${file ? `: ${file}` : ""}`);
  return {
    ...contract,
    task_id: taskId,
    file,
    dependencies: stringList(contract.dependencies || contract.depends_on || contract.dependsOn),
    read_paths: stringList(contract.read_paths || contract.readPaths),
    writable_paths: stringList(contract.writable_paths || contract.writablePaths),
    forbidden_paths: stringList(contract.forbidden_paths || contract.forbiddenPaths),
    acceptance_commands: stringList(contract.acceptance_commands || contract.acceptanceCommands),
  };
}

export function validateImplementationContract(contract) {
  const missing = [];
  if (!contract.task_id) missing.push("task_id");
  if (!contract.goal) missing.push("goal");
  if (!contract.writable_paths?.length) missing.push("writable_paths");
  if (!contract.forbidden_paths?.length) missing.push("forbidden_paths");
  if (!contract.acceptance_commands?.length) missing.push("acceptance_commands");
  if (missing.length) throw new Error(`Contract ${contract.task_id || "(unknown)"} missing required field(s): ${missing.join(", ")}`);
}

export function buildContractDag({ contracts, jobs }) {
  const latestByTask = latestJobsByTask(jobs);
  const nodes = contracts.map((contract) => {
    const taskJobs = jobs.filter((job) => job.task_id === contract.task_id);
    const latest = latestByTask.get(contract.task_id) || null;
    const implementation = latestImplementationJob(taskJobs);
    const verify = latestVerifyJob(taskJobs);
    const state = contractState(contract, implementation, verify, jobs);
    return {
      task_id: contract.task_id,
      plan_id: contract.plan_id || null,
      goal: contract.goal || "",
      file: contract.file,
      dependencies: contract.dependencies,
      read_paths: contract.read_paths,
      writable_paths: contract.writable_paths,
      forbidden_paths: contract.forbidden_paths,
      acceptance_commands: contract.acceptance_commands,
      state,
      latest_job_id: latest?.id || null,
      implementation_job_id: implementation?.id || null,
      verify_job_id: verify?.id || null,
      status: latest?.status || null,
      phase: latest?.phase || null,
      provider: latest?.provider || null,
      blocked_by: blockedBy(contract, jobs),
    };
  });
  const edges = contracts.flatMap((contract) =>
    contract.dependencies.map((source) => ({ source, target: contract.task_id }))
  );
  return { nodes, edges };
}

export function assertCanStartImplementation({ contract, jobs }) {
  validateImplementationContract(contract);
  const activeSameTask = jobs.find((job) =>
    job.task_id === contract.task_id && ["queued", "running"].includes(job.status)
  );
  if (activeSameTask) throw new Error(`Task ${contract.task_id} already has an active job: ${activeSameTask.id}`);

  const unmet = blockedBy(contract, jobs);
  if (unmet.length) throw new Error(`Task ${contract.task_id} is blocked by incomplete dependencies: ${unmet.join(", ")}`);

  const activeOverlap = findActiveWritableOverlap(contract, jobs);
  if (activeOverlap) {
    throw new Error(`Task ${contract.task_id} writable_paths overlap active job ${activeOverlap.job.id}: ${activeOverlap.path}`);
  }
}

export function assertCanStartVerify({ contract, jobs }) {
  const activeVerify = jobs.find((job) =>
    job.task_id === contract.task_id && ["agy_verify", "agy_review"].includes(job.type) && ["queued", "running"].includes(job.status)
  );
  if (activeVerify) throw new Error(`Task ${contract.task_id} already has an active verify job: ${activeVerify.id}`);
  const implementation = latestImplementationJob(jobs.filter((job) => job.task_id === contract.task_id));
  if (!implementation) return;
  if (!(implementation.status === "completed" && implementation.phase === "ready_for_acceptance")) {
    throw new Error(`Cannot verify ${contract.task_id}: implementation job ${implementation.id} is ${implementation.status}/${implementation.phase}, not ready_for_acceptance.`);
  }
}

function blockedBy(contract, jobs) {
  return contract.dependencies.filter((dependency) => {
    const dependencyJobs = jobs.filter((job) => job.task_id === dependency);
    return !dependencyJobs.some((job) => job.status === "completed" && ["applied", "applied_and_cleaned"].includes(job.phase));
  });
}

function findActiveWritableOverlap(contract, jobs) {
  const writable = contract.writable_paths || [];
  if (!writable.length) return null;
  for (const job of jobs) {
    if (!["queued", "running"].includes(job.status)) continue;
    const otherWritable = stringList(job.writable_paths);
    for (const left of writable) {
      for (const right of otherWritable) {
        if (pathsOverlap(left, right)) return { job, path: `${left} <-> ${right}` };
      }
    }
  }
  return null;
}

function pathsOverlap(left, right) {
  const a = normalizeRelative(left);
  const b = normalizeRelative(right);
  if (!a || !b) return false;
  return matchesPathPattern(a, b) || matchesPathPattern(b, a) || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function latestJobsByTask(jobs) {
  const map = new Map();
  for (const job of jobs) {
    const current = map.get(job.task_id);
    if (!current || String(job.updated_at || job.created_at || "") > String(current.updated_at || current.created_at || "")) {
      map.set(job.task_id, job);
    }
  }
  return map;
}

function latestImplementationJob(jobs) {
  return jobs
    .filter((job) => ["auto_execute", "cc_execute", "cc_continue", "agy_execute", "agy_continue", "stage_work", "stage_work_continue"].includes(job.type))
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))[0] || null;
}

function latestVerifyJob(jobs) {
  return jobs
    .filter((job) => ["agy_verify", "agy_review"].includes(job.type) && job.status === "completed")
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))[0] || null;
}

function contractState(contract, implementation, verify, jobs) {
  const blockers = blockedBy(contract, jobs);
  if (implementation?.status === "completed" && implementation.phase === "applied_and_cleaned") return "applied";
  if (implementation?.status === "completed" && implementation.phase === "applied") return "applied";
  if (implementation?.status === "completed" && implementation.phase === "ready_for_acceptance") {
    if (implementation.requires_agy_review && !implementation.review_waiver && !verify) return "review_blocked";
    return "ready_for_acceptance";
  }
  if (implementation?.status === "failed") return "failed";
  if (implementation?.status === "running" || implementation?.status === "queued") return "running";
  if (blockers.length) return "blocked";
  return "planned";
}

function stringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return [String(value)].filter(Boolean);
}

// ===================================================================
// Plan model — durable plan manifest grouping contracts and jobs
// ===================================================================

export const PLAN_TYPE_FORMAL = "formal";
export const PLAN_TYPE_ADHOC = "adhoc";
export const PLAN_TYPE_LEGACY = "legacy";
export const PLAN_TYPES = [PLAN_TYPE_FORMAL, PLAN_TYPE_ADHOC, PLAN_TYPE_LEGACY];

const ADHOC_PLAN_NAME = "Ad-hoc / Test Plan";
const LEGACY_PLAN_NAME = "Legacy / Migration Plan";
const ADHOC_PLAN_ID_CACHE = new Map();

/**
 * Validate a Plan object's structure. Returns array of error strings;
 * empty array means valid.
 */
export function validatePlanSchema(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") return ["Plan must be a non-null object"];
  if (!plan.plan_id || !String(plan.plan_id).trim()) errors.push("Plan missing plan_id");
  if (!PLAN_TYPES.includes(plan.type)) errors.push(`Plan type must be one of: ${PLAN_TYPES.join(", ")}`);
  return errors;
}

/**
 * Load all plans from a project's plans directory.
 */
export async function loadPlans(projectDir) {
  const plansDir = projectPlansRoot(projectDir);
  const entries = await fs.readdir(plansDir, { withFileTypes: true }).catch(() => []);
  const plans = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(plansDir, entry.name);
    const plan = await readJson(filePath).catch(() => null);
    if (plan && plan.plan_id && PLAN_TYPES.includes(plan.type)) {
      plan.file = filePath;
      plans.push(plan);
    }
  }
  return plans.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

/**
 * Load a single plan by plan_id from a project.
 */
export async function loadPlan(projectDir, planId) {
  const filePath = path.join(projectPlansRoot(projectDir), `${planId}.json`);
  const plan = await readJson(filePath).catch(() => null);
  if (!plan) return null;
  plan.file = filePath;
  return plan;
}

/**
 * Persist a plan to disk (create or update).
 */
export async function persistPlan(projectDir, plan) {
  const errors = validatePlanSchema(plan);
  if (errors.length) throw new Error(`Plan schema invalid: ${errors.join("; ")}`);
  const plansDir = projectPlansRoot(projectDir);
  await fs.mkdir(plansDir, { recursive: true });
  const filePath = path.join(plansDir, `${plan.plan_id}.json`);
  const now = nowIso();
  const value = {
    ...plan,
    plan_id: plan.plan_id,
    name: plan.name || "",
    type: plan.type || PLAN_TYPE_ADHOC,
    project_dir: path.resolve(projectDir),
    description: plan.description || "",
    task_ids: stringList(plan.task_ids),
    created_at: plan.created_at || now,
    updated_at: now,
    file: filePath,
  };
  await writeJsonAtomic(filePath, value);
  return value;
}

/**
 * Ensure a project has exactly one ad-hoc plan, creating it if needed.
 * Returns the ad-hoc plan.
 */
export async function ensureAdhocPlan(projectDir) {
  const resolved = path.resolve(projectDir);
  const cached = ADHOC_PLAN_ID_CACHE.get(resolved);
  if (cached) {
    const existing = await loadPlan(projectDir, cached);
    if (existing) return existing;
    ADHOC_PLAN_ID_CACHE.delete(resolved);
  }

  // Check for an existing ad-hoc plan on disk
  const allPlans = await loadPlans(projectDir);
  const existingAdhoc = allPlans.find((p) => p.type === PLAN_TYPE_ADHOC);
  if (existingAdhoc) {
    ADHOC_PLAN_ID_CACHE.set(resolved, existingAdhoc.plan_id);
    return existingAdhoc;
  }

  // Create a new ad-hoc plan
  const plan = await persistPlan(projectDir, {
    plan_id: newId("plan"),
    name: ADHOC_PLAN_NAME,
    type: PLAN_TYPE_ADHOC,
    description: "Auto-created plan for ad-hoc / direct execution tasks without a formal Planner contract.",
    task_ids: [],
  });
  ADHOC_PLAN_ID_CACHE.set(resolved, plan.plan_id);
  return plan;
}

/**
 * Get or create a formal plan for a specific task/contract.  When a contract
 * already references a plan_id, that plan is loaded.  Otherwise a new formal
 * plan is created and the plan_id stored on the contract.
 */
export async function ensurePlanForContract(projectDir, taskId, contract) {
  // If the contract already carries a plan_id, load it.
  const existingPlanId = contract?.plan_id || contract?.planId || null;
  if (existingPlanId) {
    const existing = await loadPlan(projectDir, existingPlanId);
    if (existing) return existing;
  }

  // Create a new formal plan for this task.
  const plan = await persistPlan(projectDir, {
    plan_id: newId("plan"),
    name: `Plan for ${taskId}`,
    type: PLAN_TYPE_FORMAL,
    description: contract?.goal ? `Formal plan: ${contract.goal}` : `Formal plan for task ${taskId}`,
    task_ids: [taskId],
  });
  return plan;
}

/**
 * Resolve the plan_id for a new job given the execution context.
 * - planner-backed work (auto): use contract's plan_id
 * - direct execution (cc-exec/agy-exec): use ad-hoc plan
 * - investigation/verify: inherit from prior jobs for the same task
 * Returns { plan_id, plan_type, association_reason }
 */
export async function resolveJobPlan(projectDir, taskId, { contract, jobType, existingJobs } = {}) {
  // Planner-backed work: use contract's plan_id
  if (contract?.plan_id) {
    const plan = await loadPlan(projectDir, contract.plan_id);
    if (plan) {
      return { plan_id: plan.plan_id, plan_type: plan.type, association_reason: "planner_contract" };
    }
  }

  // Formal execution types: auto, verify — require planner context.
  // If no plan_id on contract, create a formal plan.
  if (contract && (jobType === "auto_execute" || jobType === "agy_review" || jobType === "agy_verify")) {
    const plan = await ensurePlanForContract(projectDir, taskId, contract);
    return { plan_id: plan.plan_id, plan_type: PLAN_TYPE_FORMAL, association_reason: "planner_contract" };
  }

  // Continue/review/investigate: try to inherit from an existing job for the same task
  if (existingJobs && existingJobs.length > 0) {
    const priorJob = existingJobs
      .filter((j) => j.plan_id)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    if (priorJob.length > 0) {
      return { plan_id: priorJob[0].plan_id, plan_type: priorJob[0].plan_type || PLAN_TYPE_ADHOC, association_reason: "inherited" };
    }
  }

  // Direct execution: create/use the project's shared ad-hoc plan
  const adhoc = await ensureAdhocPlan(projectDir);
  return { plan_id: adhoc.plan_id, plan_type: PLAN_TYPE_ADHOC, association_reason: "auto_adhoc" };
}

/**
 * Build a read-only Legacy plan projection from jobs that have no plan_id.
 * Returns a plan-like object with type "legacy" and a list of job references.
 */
export function buildLegacyPlanProjection(jobs) {
  const legacyJobs = jobs.filter((j) => !j.plan_id);
  return {
    plan_id: "__legacy__",
    name: LEGACY_PLAN_NAME,
    type: PLAN_TYPE_LEGACY,
    description: "Read-only grouping of historical jobs that were created before plan/contract provenance was introduced.",
    task_ids: [...new Set(legacyJobs.map((j) => j.task_id).filter(Boolean))],
    job_count: legacyJobs.length,
    job_ids: legacyJobs.map((j) => j.id),
    created_at: null,
    updated_at: null,
    read_only: true,
  };
}
