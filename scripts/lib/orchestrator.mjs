import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { assertProject, autoRouteProvider, chooseAgyWriteModel, chooseModel } from "./config.mjs";
import { commandExists, processExists, terminateProcessTree } from "./process.mjs";
import { classifyAgyQuotaError, readWorkerProgress, runAgy, runAgyWrite, runClaude, runCodexWorker } from "./adapters.mjs";
import { applyPatch, captureChanges, cleanupWorkspace, inspectGit, prepareWorkspace } from "./workspace.mjs";
import { runVerification, verificationFailureContext } from "./verify.mjs";
import { asStringArray, newId, nowIso, pathExists, requireString, truncate, writeJsonAtomic } from "./utils.mjs";
import { assertCanStartImplementation, assertCanStartVerify, getContractId, getContractVersion, getContractDigest, getContractRequiredTests, loadPlannerContract, loadPlannerSubtask, normalizeContract, resolveJobPlan } from "./contracts.mjs";
import { agyExecutorFallback, investigatorFallback, investigatorPrimary, reviewerModel } from "./model-registry.mjs";
import { invalidateAcceptance, assertAcceptanceArtifactValid, saveAcceptance, validateAcceptanceForCurrentPatch } from "./acceptance.mjs";

// -- Formal review evidence builder --

function buildReviewEvidence({ job, contract, patchDigest, repository, workspace, tests, model, status, findings = null, implementationJob = null }) {
  return {
    status: status || "completed",
    job_id: job?.id || null,
    task_id: job?.task_id || null,
    review_id: job?.review_id || null,
    contract_id: getContractId(contract),
    contract_version: getContractVersion(contract),
    contract_digest: getContractDigest(contract),
    patch_digest: patchDigest || null,
    repository_identity: contract?.repository_identity || repository || null,
    workspace: workspace || null,
    tests: tests || [],
    actual_model: model || job?.model || null,
    provider: job?.provider || "agy",
    findings: findings || null,
    implementation_job_id: implementationJob?.id || null,
    created_at: nowIso(),
  };
}

// -- Stale artifact invalidation (delegated to acceptance.mjs) --

async function invalidateStaleArtifacts(store, projectDir, taskId, currentPatchDigest) {
  await invalidateAcceptance({ store, projectDir, taskId, currentPatchDigest });
}

// -- Acceptance artifact validation (exposed for testing) --

// -- Acceptance artifact validation (delegated to acceptance.mjs) --
// validateAcceptanceArtifact is imported via assertAcceptanceArtifactValid.

function collectAgyVerifyEvidence(jobs, projectDir, taskId, implementationJob = null) {
  // Find a completed reviewer evidence job for the same project and task.
  if (!jobs || !jobs.length) return null;
  const candidates = jobs.filter((j) => {
    const jProj = j.project_dir ? path.resolve(j.project_dir) : "";
    const targetProj = projectDir ? path.resolve(projectDir) : "";
    const verifyTime = Date.parse(j.finished_at || j.updated_at || j.created_at || "");
    const implementationTime = implementationJob ? Date.parse(implementationJob.finished_at || implementationJob.updated_at || implementationJob.created_at || "") : null;
    return (
      j.provider === "agy" &&
      ["agy_verify", "agy_review"].includes(j.type) &&
      j.task_id === taskId &&
      j.status === "completed" &&
      jProj === targetProj &&
      (!implementationJob || !Number.isFinite(implementationTime) || (Number.isFinite(verifyTime) && verifyTime >= implementationTime))
    );
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    String(b.finished_at || b.updated_at || "").localeCompare(
      String(a.finished_at || a.updated_at || "")
    )
  );
  return candidates[0];
}

function computeReviewGate(config, jobType, jobMetadata) {
  const gate = config?.review_gate || {};
  const requireGate = gate.require_agy_verify_for_implementation === false
    ? false
    : gate.require_reviewer_for_implementation !== false;
  const allowWaiver = gate.allow_waiver !== false;
  const requestedWaiver = jobMetadata?.review_waiver === true;
  // Only implementation job types require the review gate
  const isImplementation =
    jobType === "auto_execute" ||
    jobType === "cc_execute" ||
    jobType === "cc_continue" ||
    jobType === "agy_execute" ||
    jobType === "agy_continue" ||
    jobType === "stage_work" ||
    jobType === "stage_work_continue";
  // When allow_waiver is false, ignore any requested waiver.
  const effectiveWaiver = requestedWaiver && allowWaiver;
  return {
    requires_agy_review: isImplementation && requireGate,
    review_waiver: effectiveWaiver,
    allow_waiver: allowWaiver,
  };
}

function isRetryableProviderFailure(detail) {
  const text = String(detail || "");
  if (/AGY_AUTH_REQUIRED|authentication required|please (?:sign in|log in)|accounts\.google\.com/i.test(text)) return false;
  if (/permission denied|access denied|sandbox|read-only|outside writable_paths|forbidden paths/i.test(text)) return false;
  return [
    /ENOENT|not recognized as an internal or external command|command not found/i,
    /timed out|timeout/i,
    /429|RESOURCE_EXHAUSTED|quota|rate limit|too many requests/i,
    /temporarily unavailable|service unavailable|connection reset|ECONNRESET|ECONNREFUSED/i,
  ].some((pattern) => pattern.test(text));
}

function mergedForbidden(config, job) {
  return Array.from(new Set([...(config.scope?.forbidden || []), ...(job.forbidden_paths || [])]));
}

function implementationContract(args, acceptance, config) {
  return normalizeContract({
    ...args,
    writable_paths: args.writable_paths || config.scope?.writable || ["."],
    forbidden_paths: args.forbidden_paths || config.scope?.forbidden || [],
    acceptance_commands: acceptance,
  });
}

export class WorkerOrchestrator {
  constructor(store, { stageRuntime = null } = {}) {
    this.store = store;
    this.stageRuntime = stageRuntime;
    this.controllers = new Map();
    this.promises = new Map();
  }

  async health(projectDir) {
    const config = projectDir ? await assertProject(projectDir, { requireTrusted: false }) : null;
    const claude = await commandExists(config?.cli?.claude || process.env.AGENT_ORCH_CLAUDE_BIN || process.env.EAO_CLAUDE_BIN || "claude");
    const agy = await commandExists(config?.cli?.agy || process.env.AGENT_ORCH_AGY_BIN || process.env.EAO_AGY_BIN || "agy");
    const codexWorker = await commandExists(config?.cli?.codex || process.env.AGENT_ORCH_CODEX_BIN || process.env.EAO_CODEX_BIN || "codex");
    return {
      ok: claude.found && agy.found && codexWorker.found,
      claude,
      agy,
      codex_worker: codexWorker,
      data_dir: this.store.root,
      project_config: config?.source || null,
      project_trusted: config?.trusted ?? null,
    };
  }

  async startCc(args, continuation = false) {
    const projectDir = path.resolve(requireString(args, "project_dir"));
    const taskId = requireString(args, "task_id");
    const goal = requireString(args, "goal");
    const config = await assertProject(projectDir);
    if (config.roles.primary_writer !== "cc") throw new Error("Project policy does not designate CC as the primary writer.");
    if (config.roles.duplicate_implementation !== false) throw new Error("duplicate_implementation must remain false for this workflow.");
    const acceptance = asStringArray(args.acceptance_commands, "acceptance_commands") || config.verification.commands || [];
    const contract = implementationContract(args, acceptance, config);
    await assertCanStartImplementation({ contract, jobs: await this.store.listJobs() });
    const id = newId("cc");
    const reviewGate = computeReviewGate(config, continuation ? "cc_continue" : "cc_execute", args);
    const allJobs = await this.store.listJobs();
    const plan = await resolveJobPlan(projectDir, taskId, {
      existingJobs: allJobs,
      jobType: continuation ? "cc_continue" : "cc_execute",
    });
    const job = await this.store.createJob({
      id,
      type: continuation ? "cc_continue" : "cc_execute",
      provider: "cc",
      status: "queued",
      phase: "queued",
      project_dir: projectDir,
      task_id: taskId,
      goal,
      plan: typeof args.plan === "string" ? args.plan : "",
      plan_id: plan.plan_id,
      plan_type: plan.plan_type,
      association_reason: plan.association_reason,
      complexity: ["low", "medium", "high"].includes(args.complexity) ? args.complexity : "medium",
      model_override: typeof args.model === "string" ? args.model : null,
      dependencies: contract.dependencies,
      read_paths: contract.read_paths,
      writable_paths: contract.writable_paths,
      forbidden_paths: contract.forbidden_paths,
      acceptance_commands: acceptance,
      continuation,
      requires_agy_review: reviewGate.requires_agy_review,
      review_waiver: reviewGate.review_waiver,
    });
    this.launch(job, (signal) => this.executeCc(job, config, signal));
    return this.publicJob(job);
  }

  async startAgy(args, mode) {
    const projectDir = path.resolve(requireString(args, "project_dir"));
    const taskId = requireString(args, "task_id");
    const goal = requireString(args, "goal");
    const config = await assertProject(projectDir);
    if (config.agy?.enabled === false) throw new Error("AGY is disabled in project config.");
    if (mode === "disjoint_subtask" && args.allow_write !== true) throw new Error("AGY write tasks require allow_write=true and must be disjoint from CC implementation.");
    const contract = normalizeContract(args);
    if (mode === "verify") await assertCanStartVerify({ contract, jobs: await this.store.listJobs() });
    const id = newId("agy");
    const allJobs = await this.store.listJobs();
    const plan = await resolveJobPlan(projectDir, taskId, {
      existingJobs: allJobs,
      jobType: `agy_${mode}`,
    });
    const job = await this.store.createJob({
      id,
      type: `agy_${mode}`,
      provider: "agy",
      status: "queued",
      phase: "queued",
      project_dir: projectDir,
      task_id: taskId,
      review_id: args.review_id || null,
      plan_id: plan.plan_id,
      plan_type: plan.plan_type,
      association_reason: plan.association_reason,
      goal,
      plan: typeof args.plan === "string" ? args.plan : "",
      complexity: ["low", "medium", "high"].includes(args.complexity) ? args.complexity : "medium",
      model_override: typeof args.model === "string" ? args.model : null,
      dependencies: contract.dependencies,
      read_paths: contract.read_paths,
      writable_paths: contract.writable_paths,
      forbidden_paths: contract.forbidden_paths,
      mode,
      stage_run_id: args.stage_run_id || null,
    });
    this.launch(job, (signal) => this.executeAgy(job, config, signal));
    return this.publicJob(job);
  }

  // -- AGY write (isolated worktree, patch capture, verification, apply/cleanup) --

  async startAgyWrite(args, continuation = false) {
    const projectDir = path.resolve(requireString(args, "project_dir"));
    const taskId = requireString(args, "task_id");
    const goal = requireString(args, "goal");
    const config = await assertProject(projectDir);
    if (config.agy?.enabled === false) throw new Error("AGY is disabled in project config.");
    if (config.roles.duplicate_implementation !== false) throw new Error("duplicate_implementation must remain false for this workflow.");
    const acceptance = asStringArray(args.acceptance_commands, "acceptance_commands") || config.verification.commands || [];
    const contract = implementationContract(args, acceptance, config);
    await assertCanStartImplementation({ contract, jobs: await this.store.listJobs() });
    const id = newId("agy");
    const reviewGate = computeReviewGate(config, continuation ? "agy_continue" : "agy_execute", args);
    const allJobs = await this.store.listJobs();
    const plan = await resolveJobPlan(projectDir, taskId, {
      existingJobs: allJobs,
      jobType: continuation ? "agy_continue" : "agy_execute",
    });
    const job = await this.store.createJob({
      id,
      type: continuation ? "agy_continue" : "agy_execute",
      provider: "agy_write",
      status: "queued",
      phase: "queued",
      project_dir: projectDir,
      task_id: taskId,
      goal,
      plan: typeof args.plan === "string" ? args.plan : "",
      plan_id: plan.plan_id,
      plan_type: plan.plan_type,
      association_reason: plan.association_reason,
      complexity: ["low", "medium", "high"].includes(args.complexity) ? args.complexity : "medium",
      model_override: typeof args.model === "string" ? args.model : null,
      dependencies: contract.dependencies,
      read_paths: contract.read_paths,
      writable_paths: contract.writable_paths,
      forbidden_paths: contract.forbidden_paths,
      acceptance_commands: acceptance,
      continuation,
      requires_agy_review: reviewGate.requires_agy_review,
      review_waiver: reviewGate.review_waiver,
    });
    this.launch(job, (signal) => this.executeAgyWrite(job, config, signal));
    return this.publicJob(job);
  }

  // -- Automatic routing (complexity -> provider + quota fallback) --

  async startAuto(args) {
    const projectDir = path.resolve(requireString(args, "project_dir"));
    const taskId = requireString(args, "task_id");
    const config = await assertProject(projectDir);
    if (config.roles.duplicate_implementation !== false) throw new Error("duplicate_implementation must remain false for this workflow.");
    for (const field of ["complexity", "executor", "provider", "model", "reasoning_effort", "fallback_target"]) {
      if (Object.hasOwn(args, field)) throw new Error(field === "complexity" ? "server_managed_complexity" : "server_managed_routing");
    }
    const { contract: plannerContract, subtask } = await loadPlannerSubtask(projectDir, taskId, requireString(args, "subtask_id"));
    const goal = subtask.objective;
    const complexity = subtask.complexity === "mid" ? "medium" : subtask.complexity;
    const provider = autoRouteProvider(config, complexity);
    const acceptance = subtask.required_tests.length ? subtask.required_tests : (config.verification.commands || []);
    const contract = implementationContract({
      task_id: `${taskId}:${subtask.subtask_id}`,
      goal,
      dependencies: subtask.depends_on,
      writable_paths: subtask.writable_paths,
      forbidden_paths: subtask.forbidden_paths,
    }, acceptance, config);
    await assertCanStartImplementation({ contract, jobs: await this.store.listJobs() });
    const id = newId("auto");
    const reviewGate = computeReviewGate(config, "auto_execute", args);
    const plan = await resolveJobPlan(projectDir, taskId, {
      contract: plannerContract,
      jobType: "auto_execute",
      existingJobs: await this.store.listJobs(),
    });
    const job = await this.store.createJob({
      id,
      type: "auto_execute",
      provider,
      status: "queued",
      phase: "queued",
      project_dir: projectDir,
      task_id: taskId,
      subtask_id: subtask.subtask_id,
      plan_id: plan.plan_id,
      plan_type: plan.plan_type,
      association_reason: plan.association_reason,
      goal,
      plan: JSON.stringify({ planner_contract: plannerContract.file, subtask_id: subtask.subtask_id }),
      complexity,
      model_override: null,
      dependencies: contract.dependencies,
      read_paths: contract.read_paths,
      writable_paths: contract.writable_paths,
      forbidden_paths: contract.forbidden_paths,
      acceptance_commands: acceptance,
      auto_route: provider,
      planner_session_id: plannerContract.planner_session_id,
      contract_id: plannerContract.contract_id,
      contract_version: plannerContract.contract_version,
      contract_digest: plannerContract.contract_digest,
      routing: { requested_complexity: complexity, selected_executor: provider },
      requires_agy_review: reviewGate.requires_agy_review,
      review_waiver: reviewGate.review_waiver,
    });
    this.launch(job, (signal) => this.executeAuto(job, config, signal));
    return this.publicJob(job);
  }

  async startStageWork(args, routes, { continuation = false, stageRunId = null } = {}) {
    const projectDir = path.resolve(requireString(args, "project_dir"));
    const taskId = requireString(args, "task_id");
    const config = await assertProject(projectDir);
    const allJobs = await this.store.listJobs();
    let plannerContract;
    let subtask;
    let prior = null;

    if (continuation) {
      prior = allJobs.find((item) => item.id === requireString(args, "job_id") && item.project_dir === projectDir && item.task_id === taskId);
      if (!prior) throw new Error("stage_work_continue_unknown_job");
      if (["queued", "running"].includes(prior.status)) {
        const alive = prior.process_pid ? processExists(prior.process_pid) : this.promises.has(prior.id);
        throw new Error(alive
          ? `stage_work_continue_process_alive: job ${prior.id} is still running`
          : `stage_work_continue_interrupted: job ${prior.id} has no live process; inspect status before continuing`);
      }
      const sessionProvider = prior.provider;
      const session = await this.store.getSession(projectDir, sessionProvider, taskId);
      if (!session?.session_id || !session?.workspace_path || !(await pathExists(session.workspace_path))) {
        throw new Error(`stage_work_continue_missing_session: provider=${sessionProvider} task_id=${taskId}. Preserve the original session/worktree or start a new explicitly approved work stage.`);
      }
      plannerContract = await loadPlannerContract(projectDir, taskId);
      subtask = plannerContract.executor_subtasks.find((item) => item.subtask_id === prior.subtask_id);
      if (!subtask) throw new Error(`Missing original Planner subtask ${prior.subtask_id}`);
      routes = [{
        provider: prior.provider,
        model: prior.model || prior.model_override || session.model || null,
        invocation: prior.route_invocation || "cli",
      }];
    } else {
      ({ contract: plannerContract, subtask } = await loadPlannerSubtask(projectDir, taskId, requireString(args, "subtask_id")));
    }

    const goal = continuation
      ? `${subtask.objective}\n\nContinuation feedback:\n${requireString(args, "feedback")}`
      : subtask.objective;
    const complexity = subtask.complexity === "mid" ? "medium" : subtask.complexity;
    const acceptance = subtask.required_tests.length ? subtask.required_tests : (config.verification.commands || []);
    const contract = implementationContract({
      task_id: `${taskId}:${subtask.subtask_id}`,
      goal,
      dependencies: subtask.depends_on,
      writable_paths: subtask.writable_paths,
      forbidden_paths: subtask.forbidden_paths,
    }, acceptance, config);
    await assertCanStartImplementation({ contract, jobs: allJobs });
    const routeChain = (routes || []).map((route) => ({
      provider: route.provider,
      model: route.model || null,
      invocation: route.invocation || "cli",
    }));
    if (!routeChain.length) throw new Error("stage_work_missing_route");
    const reviewGate = computeReviewGate(config, continuation ? "stage_work_continue" : "stage_work", args);
    const job = await this.store.createJob({
      id: newId("work"),
      type: continuation ? "stage_work_continue" : "stage_work",
      provider: routeChain[0].provider,
      status: "queued",
      phase: "queued",
      project_dir: projectDir,
      task_id: taskId,
      subtask_id: subtask.subtask_id,
      goal,
      plan: JSON.stringify({ planner_contract: plannerContract.file, subtask_id: subtask.subtask_id }),
      plan_id: plannerContract.plan_id || null,
      plan_type: "formal",
      contract_id: plannerContract.contract_id,
      contract_version: plannerContract.contract_version,
      contract_digest: plannerContract.contract_digest,
      complexity,
      model_override: routeChain[0].model,
      dependencies: contract.dependencies,
      read_paths: contract.read_paths,
      writable_paths: contract.writable_paths,
      forbidden_paths: contract.forbidden_paths,
      acceptance_commands: acceptance,
      continuation,
      continued_from_job_id: prior?.id || null,
      route_chain: routeChain,
      route_invocation: routeChain[0].invocation,
      stage_run_id: stageRunId,
      requires_agy_review: reviewGate.requires_agy_review,
      review_waiver: reviewGate.review_waiver,
    });
    this.launch(job, (signal) => this.executeStageWork(job, config, signal));
    return this.publicJob(job);
  }

  async wait(jobId) {
    const promise = this.promises.get(jobId);
    if (promise) await promise;
    return this.status(jobId);
  }

  launch(job, runner) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const promise = runner(controller.signal)
      .catch(async (error) => {
        const current = await this.store.getJob(job.id);
        if (current?.status !== "cancelled") {
          await this.store.updateJob(job.id, { status: "failed", phase: "failed", error: truncate(error?.stack || error?.message || String(error), 8000), finished_at: nowIso() });
        }
      })
      .finally(async () => {
        if (job.stage_run_id && this.stageRuntime) {
          const current = await this.store.getJob(job.id).catch(() => null);
          await this.stageRuntime.syncWithJob(job.stage_run_id, current).catch(() => {});
        }
        this.controllers.delete(job.id);
        this.promises.delete(job.id);
      });
    this.promises.set(job.id, promise);
  }

  processHooks(job, { provider = job.provider, workspace = null, workspaceMode = null, model = null } = {}) {
    return {
      onSpawn: async ({ pid, command, args, cwd }) => {
        await this.store.updateJob(job.id, {
          process_pid: pid,
          process_command: command,
          process_args: args,
          process_cwd: cwd,
          process_started_at: nowIso(),
        });
      },
      onSession: async (sessionId) => {
        if (!sessionId) return;
        await this.store.setSession(job.project_dir, provider, job.task_id, {
          session_id: sessionId,
          workspace_path: workspace,
          workspace_mode: workspaceMode,
          model: model || null,
          last_job_id: job.id,
          process_pid: (await this.store.getJob(job.id))?.process_pid || null,
        });
        await this.store.updateJob(job.id, { session_id: sessionId, model: model || null });
      },
    };
  }

  async executeStageWork(job, config, signal) {
    const routes = job.route_chain || [];
    const attempts = [];
    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index];
      await this.store.updateJob(job.id, {
        provider: route.provider,
        model_override: route.model || null,
        route_invocation: route.invocation,
        route_index: index,
        route_attempts: attempts,
      });
      try {
        const routedJob = { ...job, provider: route.provider, model_override: route.model || null };
        if (route.provider === "cc") await this.executeCcImpl(routedJob, config, signal, this.store.jobDir(job.id));
        else if (route.provider === "agy_write") await this.executeAgyWriteImpl(routedJob, config, signal, this.store.jobDir(job.id));
        else if (route.provider === "codex_worker") await this.executeCodexWorkerImpl(routedJob, config, signal, this.store.jobDir(job.id));
        else throw new Error(`Unsupported work provider: ${route.provider}`);
        attempts.push({ ...route, status: "completed", finished_at: nowIso() });
        await this.store.updateJob(job.id, { route_attempts: attempts });
        return;
      } catch (error) {
        const detail = error?.stack || error?.message || String(error);
        const retryable = isRetryableProviderFailure(detail);
        attempts.push({ ...route, status: "failed", retryable, error: truncate(detail, 2000), finished_at: nowIso() });
        await this.store.updateJob(job.id, { route_attempts: attempts });
        if (!retryable || index === routes.length - 1 || job.continuation) throw error;
        const current = await this.store.getJob(job.id);
        const workspace = current?.workspace;
        if (workspace?.path) {
          await cleanupWorkspace({
            originalProjectDir: job.project_dir,
            workspacePath: workspace.path,
            mode: workspace.mode,
            logDir: this.store.jobDir(job.id),
          }).catch(() => {});
        }
        await this.store.clearSession(job.project_dir, route.provider, job.task_id).catch(() => {});
        await this.store.updateJob(job.id, {
          status: "running",
          phase: "fallback",
          process_pid: null,
          workspace: null,
          error: null,
        });
      }
    }
  }

  async executeCc(job, config, signal) {
    const jobDir = this.store.jobDir(job.id);
    await this.executeCcImpl(job, config, signal, jobDir);
  }

  async executeAgy(job, config, signal) {
    const jobDir = this.store.jobDir(job.id);
    await this.store.updateJob(job.id, { status: "running", phase: "executing", started_at: nowIso() });
    let implementationJob = null;
    let implementationPatchDigest = null;
    let reviewWorkspace = job.project_dir;
    let reviewPlan = job.plan;
    if (job.mode === "review") {
      const jobs = await this.store.listJobs();
      implementationJob = jobs
        .filter((item) =>
          item.task_id === job.task_id &&
          ["cc_execute", "agy_execute", "auto_execute", "cc_continue", "agy_continue", "stage_work", "stage_work_continue"].includes(item.type) &&
          item.status === "completed" &&
          item.phase === "ready_for_acceptance")
        .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))[0] || null;
      if (!implementationJob?.workspace?.path || !(await pathExists(implementationJob.workspace.path))) {
        throw new Error("review_target_unavailable: implementation worktree is missing");
      }
      reviewWorkspace = implementationJob.workspace.path;
      reviewPlan = [
        job.plan,
        `Implementation job: ${implementationJob.id}`,
        `Evidence: ${implementationJob.evidence_path || "(missing)"}`,
        `Patch: ${implementationJob.patch_path || "(missing)"}`,
        "Inspect the current worktree diff and run only read-only verification commands.",
      ].filter(Boolean).join("\n");
      if (implementationJob.evidence_path && await pathExists(implementationJob.evidence_path)) {
        const implementationEvidence = JSON.parse(await fs.readFile(implementationJob.evidence_path, "utf8"));
        implementationPatchDigest = implementationEvidence.changes?.patch_digest || null;
      }
    }
    let taskSession = await this.store.getSession(job.project_dir, "agy", job.task_id);
    const model = chooseModel(config, "agy", job.complexity, job.model_override);
    if (taskSession && (taskSession.model || null) !== (model || null)) {
      await this.store.clearSession(job.project_dir, "agy", job.task_id);
      taskSession = null;
    }
    await this.store.updateJob(job.id, { model: model || null });
    const run = await runAgy({
      config,
      workspace: reviewWorkspace,
      jobDir,
      goal: job.goal,
      plan: reviewPlan,
      readPaths: job.read_paths || [],
      writablePaths: job.writable_paths || [],
      forbiddenPaths: mergedForbidden(config, job),
      taskSession,
      model,
      signal,
      mode: job.mode,
      processHooks: this.processHooks(job, { provider: "agy", workspace: reviewWorkspace, workspaceMode: "read_only_specialist", model }),
    });
    if (run.cancelled || signal.aborted) throw new Error("AGY task cancelled");
    if (run.timed_out) throw new Error("AGY task timed out");
    if (run.exit_code !== 0) {
      const detail = [
        run.stderr || run.stdout,
        run.cli_log_tail ? `AGY CLI log tail:\n${run.cli_log_tail}` : null,
      ].filter(Boolean).join("\n\n");
      throw new Error(`AGY execution failed: ${truncate(detail, 3000)}`);
    }
    if (/(failed to construct executor|neither PlanModel nor RequestedModel specified|model output error|invalid tool call error)/i.test(run.result || "")) {
      throw new Error(`AGY completed with an internal error: ${truncate(run.result, 3000)}`);
    }
    if (job.mode === "review") {
      if (!run.result || run.result_source === "conversation_store") {
        throw new Error("AGY_REVIEW_UNAVAILABLE: reviewer produced no trustworthy current-turn output");
      }
      if (/no output produced|soft-denying tool confirmation|tool required the .* permission/i.test(run.cli_log_tail || "")) {
        throw new Error("AGY_REVIEW_UNAVAILABLE: reviewer tools were denied in headless mode");
      }
      const verdict = run.result.match(/VERDICT:\s*(PASS|FAIL)/i)?.[1]?.toUpperCase() || null;
      if (verdict !== "PASS") {
        throw new Error(`AGY_REVIEW_REJECTED: ${verdict || "missing explicit verdict"}\n${truncate(run.result, 3000)}`);
      }
      const postReviewChanges = await captureChanges({
        workspace: reviewWorkspace,
        jobDir,
        forbidden: mergedForbidden(config, implementationJob),
        writable: implementationJob.writable_paths || [],
      });
      if (!implementationPatchDigest || postReviewChanges.patch_digest !== implementationPatchDigest) {
        throw new Error("AGY_REVIEW_MUTATED_TARGET: patch digest changed during read-only review");
      }
    }
    if (!run.session_id) throw new Error("AGY completed without a discoverable conversation ID; refusing an untracked session.");
    await this.store.setSession(job.project_dir, "agy", job.task_id, {
      session_id: run.session_id,
      workspace_path: reviewWorkspace,
      workspace_mode: "read_only_specialist",
      model: model || null,
      last_job_id: job.id,
    });
    const evidence = {
      status: "completed",
      job_id: job.id,
      task_id: job.task_id,
      provider: "agy",
      mode: job.mode,
      session_id: run.session_id,
      model: model || null,
      duration_ms: run.duration_ms,
      result: run.result,
      result_source: run.result_source,
      stdout_path: run.stdout_path,
      stderr_path: run.stderr_path,
      cli_log_path: run.cli_log_path,
      launch: run.launch,
    };

    // When in review mode, enrich evidence with formal review provenance
    // bound to the Planner contract and current patch digest.
    if (job.mode === "review") {
      const contract = await loadPlannerContract(job.project_dir, job.task_id).catch(() => null);
      let patchDigest = null;
      if (implementationJob?.patch_path) {
        patchDigest = crypto.createHash("sha256").update(await fs.readFile(implementationJob.patch_path)).digest("hex");
      }
      const reviewEvidence = buildReviewEvidence({
        job,
        contract,
        patchDigest,
        repository: contract?.repository_identity || null,
        workspace: implementationJob?.workspace || null,
        tests: job.acceptance_commands || [],
        model: model || job.model || null,
        status: "completed",
        findings: run.result ? { summary: truncate(run.result, 5000), source: run.result_source } : null,
        implementationJob,
      });
      evidence.review_evidence = reviewEvidence;
      const evidencePath = path.join(jobDir, "evidence.json");
      await writeJsonAtomic(evidencePath, evidence);
      await this.store.updateJob(job.id, { status: "completed", phase: "completed", evidence_path: evidencePath, session_id: run.session_id, model: model || null, finished_at: nowIso() });
      return;
    }

    const evidencePath = path.join(jobDir, "evidence.json");
    await writeJsonAtomic(evidencePath, evidence);
    await this.store.updateJob(job.id, { status: "completed", phase: "completed", evidence_path: evidencePath, session_id: run.session_id, model: model || null, finished_at: nowIso() });
  }

  // -- AGY write execution (isolated worktree, patch, verification, ready_for_acceptance) --

  async executeAgyWrite(job, config, signal) {
    const jobDir = this.store.jobDir(job.id);
    await this.store.updateJob(job.id, { status: "running", phase: "preparing", started_at: nowIso() });
    let taskSession = await this.store.getSession(job.project_dir, "agy_write", job.task_id);
    const model = job.model_override || chooseAgyWriteModel(config, job.complexity);
    // Reset session when the explicit model changes
    if (taskSession && (taskSession.model || null) !== (model || null)) {
      await this.store.clearSession(job.project_dir, "agy_write", job.task_id);
      taskSession = null;
    }
    let workspaceInfo;
    if (taskSession?.workspace_path && await pathExists(taskSession.workspace_path)) {
      workspaceInfo = {
        mode: taskSession.workspace_mode,
        path: taskSession.workspace_path,
        original_project_dir: job.project_dir,
        git: await inspectGit(job.project_dir, jobDir),
      };
    } else {
      if (taskSession) await this.store.clearSession(job.project_dir, "agy_write", job.task_id);
      taskSession = null;
      workspaceInfo = await prepareWorkspace({ projectDir: job.project_dir, jobDir, config, requestedMode: undefined });
    }
    await this.store.updateJob(job.id, { phase: "executing", workspace: workspaceInfo, model: model || null });

    let repairContext;
    let verification;
    let changes;
    const rounds = Math.max(0, Number(config.execution.max_cc_repair_rounds || 0));
    const attempts = [];

    for (let round = 0; round <= rounds; round += 1) {
      const run = await runAgyWrite({
        config,
        workspace: workspaceInfo.path,
        jobDir,
        goal: job.goal,
        plan: job.plan,
        acceptance: job.acceptance_commands,
        readPaths: job.read_paths || [],
        writablePaths: job.writable_paths || [],
        forbiddenPaths: mergedForbidden(config, job),
        taskSession,
        model,
        repairContext,
        signal,
        round,
        processHooks: this.processHooks(job, { provider: "agy_write", workspace: workspaceInfo.path, workspaceMode: workspaceInfo.mode, model }),
      });
      taskSession = await this.store.setSession(job.project_dir, "agy_write", job.task_id, {
        session_id: run.session_id,
        workspace_path: workspaceInfo.path,
        workspace_mode: workspaceInfo.mode,
        model: model || null,
        last_job_id: job.id,
      });
      attempts.push({
        round,
        exit_code: run.exit_code,
        timed_out: run.timed_out,
        cancelled: run.cancelled,
        duration_ms: run.duration_ms,
        session_id: run.session_id,
        model: model || null,
        cost_usd: run.parsed.cost_usd,
        usage: run.parsed.usage,
        result_summary: truncate(typeof run.parsed.result === "string" ? run.parsed.result : JSON.stringify(run.parsed.result), 3000),
      });
      await this.store.updateJob(job.id, { phase: "verifying", attempts, session_id: run.session_id, model: model || null });
      if (run.cancelled || signal.aborted) throw new Error("AGY write task cancelled");
      if (run.timed_out) throw new Error("AGY write task timed out");
      if (run.exit_code !== 0 || run.parsed.is_error) throw new Error(`AGY write execution failed: ${truncate(run.stderr || JSON.stringify(run.parsed.result), 3000)}`);

      changes = await captureChanges({ workspace: workspaceInfo.path, jobDir, forbidden: mergedForbidden(config, job), writable: job.writable_paths || [] });
      if (changes.forbidden_changes.length || changes.unauthorized_changes.length) {
        const failures = [];
        if (changes.forbidden_changes.length) failures.push(`Forbidden paths changed: ${changes.forbidden_changes.join(", ")}`);
        if (changes.unauthorized_changes.length) failures.push(`Changes outside writable_paths: ${changes.unauthorized_changes.join(", ")}`);
        verification = { configured: job.acceptance_commands.length > 0, passed: false, results: [], policy_failure: failures.join("; ") };
        break;
      }
      verification = await runVerification({ commands: job.acceptance_commands, workspace: workspaceInfo.path, jobDir, config, signal, round });
      if (verification.passed || !verification.configured) break;
      if (round < rounds) {
        repairContext = verificationFailureContext(verification);
        await this.store.updateJob(job.id, { phase: "repairing", verification, changes });
      }
    }

    const ready = changes.forbidden_changes.length === 0 && changes.unauthorized_changes.length === 0 && (verification.passed || !verification.configured);
    // Invalidate stale review/acceptance artifacts for this task when a new
    // patch digest is produced by a continuation.
    if (ready && changes.patch_digest) {
      await invalidateStaleArtifacts(this.store, job.project_dir, job.task_id, changes.patch_digest);
    }
    const evidence = {
      status: ready ? "ready_for_acceptance" : "verification_failed",
      job_id: job.id,
      task_id: job.task_id,
      provider: "agy_write",
      session_id: taskSession?.session_id || null,
      model: model || null,
      workspace: workspaceInfo,
      changes,
      verification,
      attempts,
      warnings: verification.configured ? [] : ["No acceptance commands were configured; Codex must perform additional acceptance before applying."],
    };
    const evidencePath = path.join(jobDir, "evidence.json");
    await writeJsonAtomic(evidencePath, evidence);
    await this.store.updateJob(job.id, {
      status: ready ? "completed" : "failed",
      phase: ready ? "ready_for_acceptance" : "verification_failed",
      evidence_path: evidencePath,
      patch_path: changes.patch_path,
      workspace: workspaceInfo,
      session_id: taskSession?.session_id || null,
      model: model || null,
      finished_at: nowIso(),
    });
  }

  // -- Auto routing execution (CC-first with AGY escalation on verify failure) --

  async executeAuto(job, config, signal) {
    const jobDir = this.store.jobDir(job.id);
    const provider = job.auto_route || "cc";

    if (provider === "agy") {
      // Legacy agy_preferred path for medium/high: AGY write with quota fallback.
      await this.store.updateJob(job.id, { provider: "agy_write", status: "running", phase: "executing", started_at: nowIso(), auto_route: "agy_write" });
      try {
        await this.executeAgyWriteImpl(job, config, signal, jobDir);
        const evidencePath = path.join(jobDir, "evidence.json");
        if (await pathExists(evidencePath)) {
          const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
          evidence.auto_route = { provider: "agy_write", fallback_occurred: false };
          await writeJsonAtomic(evidencePath, evidence);
        }
      } catch (error) {
        const errorText = error?.stack || error?.message || String(error);
        const isQuotaError = classifyAgyQuotaError(errorText);
        if (isQuotaError && config.routing?.agy_write_fallback_to_cc_on_quota !== false) {
          const runningJob = await this.store.getJob(job.id);
          const jobWorkspace = runningJob?.workspace;
          const agySession = await this.store.getSession(job.project_dir, "agy_write", job.task_id);
          const workspaceToClean = jobWorkspace?.path || agySession?.workspace_path;
          if (workspaceToClean) {
            await cleanupWorkspace({
              originalProjectDir: job.project_dir,
              workspacePath: workspaceToClean,
              mode: jobWorkspace?.mode || agySession?.workspace_mode || "isolated",
              logDir: jobDir,
            }).catch(() => {});
          }
          try { await this.store.clearSession(job.project_dir, "agy_write", job.task_id); } catch {}
          await this.store.updateJob(job.id, {
            provider: "cc",
            phase: "executing",
            auto_route: "cc_fallback",
            auto_fallback_reason: truncate(errorText, 500),
            auto_fallback_classifier: "quota_exhaustion",
          });
          try {
            await this.executeCcImpl({
              ...job,
              provider: "cc",
              auto_route: "cc_fallback",
              auto_fallback_classifier: "quota_exhaustion",
              auto_fallback_reason: truncate(errorText, 500),
              auto_route_evidence: {
                provider: "cc",
                fallback_occurred: true,
                original_provider: "agy_write",
                reason: "quota_exhaustion",
                original_error: truncate(errorText, 500),
              },
            }, config, signal, jobDir);
            const fbEvidencePath = path.join(jobDir, "evidence.json");
            if (await pathExists(fbEvidencePath)) {
              const fbEvidence = JSON.parse(await fs.readFile(fbEvidencePath, "utf8"));
              fbEvidence.auto_route = fbEvidence.auto_route || job.auto_route_evidence || {
                provider: "cc",
                fallback_occurred: true,
                original_provider: "agy_write",
                reason: "quota_exhaustion",
                original_error: truncate(errorText, 500),
              };
              await writeJsonAtomic(fbEvidencePath, fbEvidence);
            }
          } catch (ccError) {
            throw ccError;
          }
          return;
        }
        throw error; // Non-quota error - do NOT fall back silently
      }
      return;
    }

    // CC-first path (default): all complexities start with CC.
    await this.store.updateJob(job.id, { provider: "cc", status: "running", phase: "executing", started_at: nowIso(), auto_route: "cc" });

    // Run CC implementation
    try {
      await this.executeCcImpl(job, config, signal, jobDir);
    } catch (error) {
      // CC execution error (timeout, cancellation, execution failure) - bubble up.
      throw error;
    }

    // Check CC result for verification failure that warrants AGY escalation
    const ccJob = await this.store.getJob(job.id);
    let ccEvidence = null;
    if (ccJob?.evidence_path && await pathExists(ccJob.evidence_path)) {
      ccEvidence = JSON.parse(await fs.readFile(ccJob.evidence_path, "utf8"));
    }

    // Escalate to AGY write only when:
    // - CC completed with verification_failed (not execution error)
    // - At least 2 verification cycles were attempted (initial + at least one repair)
    // - Escalation is enabled in config
    // - AGY is enabled and available
    if (
      ccEvidence &&
      ccEvidence.status === "verification_failed" &&
      ccEvidence.attempts &&
      ccEvidence.attempts.length >= 2 &&
      config.routing?.cc_verify_fail_escalate_to_agy !== false &&
      config.agy?.enabled !== false
    ) {
      const ccAttemptCount = ccEvidence.attempts.length;

      // Clean up CC workspace before AGY write
      const ccWorkspace = ccJob?.workspace;
      if (ccWorkspace?.path) {
        await cleanupWorkspace({
          originalProjectDir: job.project_dir,
          workspacePath: ccWorkspace.path,
          mode: ccWorkspace.mode || "isolated",
          logDir: jobDir,
        }).catch(() => {});
      }
      try { await this.store.clearSession(job.project_dir, "cc", job.task_id); } catch {}

      const agyModel = "Claude Sonnet 4.6 (Thinking)";
      await this.store.updateJob(job.id, {
        provider: "agy_write",
        phase: "executing",
        auto_route: "cc_then_agy_escalation",
        auto_fallback_reason: `CC verification failed after ${ccAttemptCount} cycles; escalating to AGY write`,
        auto_fallback_classifier: "cc_verification_failed",
      });

      try {
        await this.executeAgyWriteImpl({
          ...job,
          provider: "agy_write",
          auto_route: "cc_then_agy_escalation",
          model_override: agyModel,
        }, config, signal, jobDir);

        // Record escalation evidence
        const agyEvidencePath = path.join(jobDir, "evidence.json");
        if (await pathExists(agyEvidencePath)) {
          const agyEvidence = JSON.parse(await fs.readFile(agyEvidencePath, "utf8"));
          agyEvidence.auto_route = {
            provider: "agy_write",
            fallback_occurred: true,
            original_provider: "cc",
            reason: "cc_verification_failed",
            cc_attempts: ccAttemptCount,
            escalation_model: agyModel,
            cc_evidence_status: ccEvidence.status,
          };
          await writeJsonAtomic(agyEvidencePath, agyEvidence);
        }
      } catch (agyError) {
        const agyErrorText = agyError?.stack || agyError?.message || String(agyError);
        const isQuotaError = classifyAgyQuotaError(agyErrorText);

        if (isQuotaError && config.routing?.agy_write_fallback_to_cc_on_quota !== false) {
          // AGY quota exhausted during escalation -> fall back to CC high/deepseek-v4-pro
          const runningJob = await this.store.getJob(job.id);
          const jobWorkspace = runningJob?.workspace;
          const agySession = await this.store.getSession(job.project_dir, "agy_write", job.task_id);
          const workspaceToClean = jobWorkspace?.path || agySession?.workspace_path;
          if (workspaceToClean) {
            await cleanupWorkspace({
              originalProjectDir: job.project_dir,
              workspacePath: workspaceToClean,
              mode: jobWorkspace?.mode || agySession?.workspace_mode || "isolated",
              logDir: jobDir,
            }).catch(() => {});
          }
          try { await this.store.clearSession(job.project_dir, "agy_write", job.task_id); } catch {}

          await this.store.updateJob(job.id, {
            provider: "cc",
            phase: "executing",
            auto_route: "cc_fallback_after_agy_quota",
            auto_fallback_reason: truncate(agyErrorText, 500),
            auto_fallback_classifier: "agy_quota_during_escalation",
          });

          try {
            await this.executeCcImpl({
              ...job,
              provider: "cc",
              complexity: "high",
              auto_route: "cc_fallback_after_agy_quota",
            }, config, signal, jobDir);

            // Record full escalation chain evidence
            const ccFbEvidencePath = path.join(jobDir, "evidence.json");
            if (await pathExists(ccFbEvidencePath)) {
              const fbEvidence = JSON.parse(await fs.readFile(ccFbEvidencePath, "utf8"));
              fbEvidence.auto_route = {
                provider: "cc",
                fallback_occurred: true,
                original_provider: "agy_write",
                reason: "agy_quota_during_escalation",
                escalation_chain: ["cc", "agy_write", "cc_high"],
                cc_attempts: ccAttemptCount,
                agy_model: agyModel,
                agy_quota_error: truncate(agyErrorText, 500),
              };
              await writeJsonAtomic(ccFbEvidencePath, fbEvidence);
            }
          } catch (ccError) {
            throw ccError; // Both AGY and CC fallback failed
          }
          return;
        }
        // Non-quota AGY error during escalation - surface it; do NOT silently fall back
        throw agyError;
      }
    }
    // If CC passed verification or wasn't eligible for escalation, the CC result stands.
  }

  // -- Shared implementation helpers (used by both executeCc and executeAuto) --

  async executeCcImpl(job, config, signal, jobDir) {
    await this.store.updateJob(job.id, { status: "running", phase: "preparing", started_at: nowIso() });
    let taskSession = await this.store.getSession(job.project_dir, "cc", job.task_id);
    const model = chooseModel(config, "cc", job.complexity, job.model_override);
    let workspaceInfo;
    if (taskSession?.workspace_path && await pathExists(taskSession.workspace_path)) {
      workspaceInfo = {
        mode: taskSession.workspace_mode,
        path: taskSession.workspace_path,
        original_project_dir: job.project_dir,
        git: await inspectGit(job.project_dir, jobDir),
      };
    } else {
      if (taskSession) await this.store.clearSession(job.project_dir, "cc", job.task_id);
      taskSession = null;
      workspaceInfo = await prepareWorkspace({ projectDir: job.project_dir, jobDir, config, requestedMode: undefined });
    }
    await this.store.updateJob(job.id, { phase: "executing", workspace: workspaceInfo });
    if (taskSession && (taskSession.model || null) !== (model || null)) {
      await this.store.clearSession(job.project_dir, "cc", job.task_id);
      taskSession = null;
    }
    let repairContext;
    let verification;
    let changes;
    const rounds = Math.max(0, Number(config.execution.max_cc_repair_rounds || 0));
    const attempts = [];

    for (let round = 0; round <= rounds; round += 1) {
      const run = await runClaude({
        config,
        workspace: workspaceInfo.path,
        jobDir,
        goal: job.goal,
        plan: job.plan,
        acceptance: job.acceptance_commands,
        readPaths: job.read_paths || [],
        writablePaths: job.writable_paths || [],
        forbiddenPaths: mergedForbidden(config, job),
        taskSession,
        model,
        repairContext,
        signal,
        round,
        processHooks: this.processHooks(job, { provider: "cc", workspace: workspaceInfo.path, workspaceMode: workspaceInfo.mode, model }),
      });
      taskSession = await this.store.setSession(job.project_dir, "cc", job.task_id, {
        session_id: run.session_id,
        workspace_path: workspaceInfo.path,
        workspace_mode: workspaceInfo.mode,
        model: model || null,
        last_job_id: job.id,
      });
      attempts.push({
        round,
        exit_code: run.exit_code,
        timed_out: run.timed_out,
        cancelled: run.cancelled,
        duration_ms: run.duration_ms,
        session_id: run.session_id,
        model: model || null,
        cli_model: run.parsed.model || null,
        cost_usd: run.parsed.cost_usd,
        usage: run.parsed.usage,
        result_summary: truncate(typeof run.parsed.result === "string" ? run.parsed.result : JSON.stringify(run.parsed.result), 3000),
      });
      await this.store.updateJob(job.id, { phase: "verifying", attempts, session_id: run.session_id, model: model || null });
      if (run.cancelled || signal.aborted) throw new Error("CC task cancelled");
      if (run.timed_out) throw new Error("CC task timed out");
      if (run.exit_code !== 0 || run.parsed.is_error) throw new Error(`CC execution failed: ${truncate(run.stderr || JSON.stringify(run.parsed.result), 3000)}`);

      changes = await captureChanges({ workspace: workspaceInfo.path, jobDir, forbidden: mergedForbidden(config, job), writable: job.writable_paths || [] });
      if (changes.forbidden_changes.length || changes.unauthorized_changes.length) {
        const failures = [];
        if (changes.forbidden_changes.length) failures.push(`Forbidden paths changed: ${changes.forbidden_changes.join(", ")}`);
        if (changes.unauthorized_changes.length) failures.push(`Changes outside writable_paths: ${changes.unauthorized_changes.join(", ")}`);
        verification = { configured: job.acceptance_commands.length > 0, passed: false, results: [], policy_failure: failures.join("; ") };
        break;
      }
      verification = await runVerification({ commands: job.acceptance_commands, workspace: workspaceInfo.path, jobDir, config, signal, round });
      if (verification.passed || !verification.configured) break;
      if (round < rounds) {
        repairContext = verificationFailureContext(verification);
        await this.store.updateJob(job.id, { phase: "repairing", verification, changes });
      }
    }

    const ready = changes.forbidden_changes.length === 0 && changes.unauthorized_changes.length === 0 && (verification.passed || !verification.configured);
    // Invalidate stale review/acceptance artifacts for this task when a new
    // patch digest is produced by a continuation.
    if (ready && changes.patch_digest) {
      await invalidateStaleArtifacts(this.store, job.project_dir, job.task_id, changes.patch_digest);
    }
    const evidence = {
      status: ready ? "ready_for_acceptance" : "verification_failed",
      job_id: job.id,
      task_id: job.task_id,
      provider: job.provider || "cc",
      session_id: taskSession?.session_id || null,
      model: model || null,
      workspace: workspaceInfo,
      changes,
      verification,
      attempts,
      auto_route: job.auto_route_evidence || undefined,
      warnings: verification.configured ? [] : ["No acceptance commands were configured; Codex must perform additional acceptance before applying."],
    };
    const evidencePath = path.join(jobDir, "evidence.json");
    await writeJsonAtomic(evidencePath, evidence);
    await this.store.updateJob(job.id, {
      status: ready ? "completed" : "failed",
      phase: ready ? "ready_for_acceptance" : "verification_failed",
      evidence_path: evidencePath,
      patch_path: changes.patch_path,
      workspace: workspaceInfo,
      session_id: taskSession?.session_id || null,
      model: model || null,
      finished_at: nowIso(),
    });
  }

  async executeCodexWorkerImpl(job, config, signal, jobDir) {
    await this.store.updateJob(job.id, { status: "running", phase: "preparing", started_at: nowIso() });
    let taskSession = await this.store.getSession(job.project_dir, "codex_worker", job.task_id);
    const model = job.model_override || config.models?.codex_worker?.[job.complexity] || null;
    if (taskSession && (taskSession.model || null) !== (model || null)) {
      await this.store.clearSession(job.project_dir, "codex_worker", job.task_id);
      taskSession = null;
    }
    let workspaceInfo;
    if (taskSession?.workspace_path && await pathExists(taskSession.workspace_path)) {
      workspaceInfo = {
        mode: taskSession.workspace_mode,
        path: taskSession.workspace_path,
        original_project_dir: job.project_dir,
        git: await inspectGit(job.project_dir, jobDir),
      };
    } else {
      if (taskSession) await this.store.clearSession(job.project_dir, "codex_worker", job.task_id);
      taskSession = null;
      workspaceInfo = await prepareWorkspace({ projectDir: job.project_dir, jobDir, config, requestedMode: undefined });
    }
    await this.store.updateJob(job.id, { phase: "executing", workspace: workspaceInfo, model: model || null });

    let repairContext;
    let verification;
    let changes;
    const rounds = Math.max(0, Number(config.execution.max_cc_repair_rounds || 0));
    const attempts = [];

    for (let round = 0; round <= rounds; round += 1) {
      const run = await runCodexWorker({
        config,
        workspace: workspaceInfo.path,
        jobDir,
        goal: job.goal,
        plan: job.plan,
        acceptance: job.acceptance_commands,
        readPaths: job.read_paths || [],
        writablePaths: job.writable_paths || [],
        forbiddenPaths: mergedForbidden(config, job),
        taskSession,
        model,
        repairContext,
        signal,
        round,
        processHooks: this.processHooks(job, { provider: "agy_write", workspace: workspaceInfo.path, workspaceMode: workspaceInfo.mode, model }),
      });
      if (!run.session_id) {
        throw new Error("Codex Worker completed without a thread id; refusing an untracked continuation.");
      }
      taskSession = await this.store.setSession(job.project_dir, "codex_worker", job.task_id, {
        session_id: run.session_id,
        workspace_path: workspaceInfo.path,
        workspace_mode: workspaceInfo.mode,
        model: model || null,
        last_job_id: job.id,
      });
      attempts.push({
        round,
        exit_code: run.exit_code,
        timed_out: run.timed_out,
        cancelled: run.cancelled,
        duration_ms: run.duration_ms,
        session_id: run.session_id,
        model: model || null,
        result_summary: truncate(run.parsed.result, 3000),
        sandbox_fallback: run.sandbox_fallback || null,
      });
      await this.store.updateJob(job.id, { phase: "verifying", attempts, session_id: run.session_id, model: model || null });
      if (run.cancelled || signal.aborted) throw new Error("Codex Worker task cancelled");
      if (run.timed_out) throw new Error("Codex Worker task timed out");
      if (run.exit_code !== 0 || run.parsed.is_error) {
        throw new Error(`Codex Worker execution failed: ${truncate(run.stderr || run.parsed.result, 3000)}`);
      }

      changes = await captureChanges({ workspace: workspaceInfo.path, jobDir, forbidden: mergedForbidden(config, job), writable: job.writable_paths || [] });
      if (changes.forbidden_changes.length || changes.unauthorized_changes.length) {
        const failures = [];
        if (changes.forbidden_changes.length) failures.push(`Forbidden paths changed: ${changes.forbidden_changes.join(", ")}`);
        if (changes.unauthorized_changes.length) failures.push(`Changes outside writable_paths: ${changes.unauthorized_changes.join(", ")}`);
        verification = { configured: job.acceptance_commands.length > 0, passed: false, results: [], policy_failure: failures.join("; ") };
        break;
      }
      verification = await runVerification({ commands: job.acceptance_commands, workspace: workspaceInfo.path, jobDir, config, signal, round });
      if (verification.passed || !verification.configured) break;
      if (round < rounds) {
        repairContext = verificationFailureContext(verification);
        await this.store.updateJob(job.id, { phase: "repairing", verification, changes });
      }
    }

    const ready = changes.forbidden_changes.length === 0 && changes.unauthorized_changes.length === 0 && (verification.passed || !verification.configured);
    if (ready && changes.patch_digest) {
      await invalidateStaleArtifacts(this.store, job.project_dir, job.task_id, changes.patch_digest);
    }
    const evidence = {
      status: ready ? "ready_for_acceptance" : "verification_failed",
      job_id: job.id,
      task_id: job.task_id,
      provider: "codex_worker",
      session_id: taskSession?.session_id || null,
      model: model || null,
      workspace: workspaceInfo,
      changes,
      verification,
      attempts,
      warnings: verification.configured ? [] : ["No acceptance commands were configured; accepter must perform additional checks before applying."],
    };
    const evidencePath = path.join(jobDir, "evidence.json");
    await writeJsonAtomic(evidencePath, evidence);
    await this.store.updateJob(job.id, {
      status: ready ? "completed" : "failed",
      phase: ready ? "ready_for_acceptance" : "verification_failed",
      evidence_path: evidencePath,
      patch_path: changes.patch_path,
      workspace: workspaceInfo,
      session_id: taskSession?.session_id || null,
      model: model || null,
      finished_at: nowIso(),
    });
  }

  async executeAgyWriteImpl(job, config, signal, jobDir) {
    await this.store.updateJob(job.id, { status: "running", phase: "preparing" });
    let taskSession = await this.store.getSession(job.project_dir, "agy_write", job.task_id);
    const model = job.model_override || chooseAgyWriteModel(config, job.complexity);
    if (taskSession && (taskSession.model || null) !== (model || null)) {
      await this.store.clearSession(job.project_dir, "agy_write", job.task_id);
      taskSession = null;
    }
    let workspaceInfo;
    if (taskSession?.workspace_path && await pathExists(taskSession.workspace_path)) {
      workspaceInfo = {
        mode: taskSession.workspace_mode,
        path: taskSession.workspace_path,
        original_project_dir: job.project_dir,
        git: await inspectGit(job.project_dir, jobDir),
      };
    } else {
      if (taskSession) await this.store.clearSession(job.project_dir, "agy_write", job.task_id);
      taskSession = null;
      workspaceInfo = await prepareWorkspace({ projectDir: job.project_dir, jobDir, config, requestedMode: undefined });
    }
    await this.store.updateJob(job.id, { phase: "executing", workspace: workspaceInfo, model: model || null });

    let repairContext;
    let verification;
    let changes;
    const rounds = Math.max(0, Number(config.execution.max_cc_repair_rounds || 0));
    const attempts = [];

    for (let round = 0; round <= rounds; round += 1) {
      const run = await runAgyWrite({
        config,
        workspace: workspaceInfo.path,
        jobDir,
        goal: job.goal,
        plan: job.plan,
        acceptance: job.acceptance_commands,
        readPaths: job.read_paths || [],
        writablePaths: job.writable_paths || [],
        forbiddenPaths: mergedForbidden(config, job),
        taskSession,
        model,
        repairContext,
        signal,
        round,
        processHooks: this.processHooks(job, { provider: "codex_worker", workspace: workspaceInfo.path, workspaceMode: workspaceInfo.mode, model }),
      });
      taskSession = await this.store.setSession(job.project_dir, "agy_write", job.task_id, {
        session_id: run.session_id,
        workspace_path: workspaceInfo.path,
        workspace_mode: workspaceInfo.mode,
        model: model || null,
        last_job_id: job.id,
      });
      attempts.push({
        round,
        exit_code: run.exit_code,
        timed_out: run.timed_out,
        cancelled: run.cancelled,
        duration_ms: run.duration_ms,
        session_id: run.session_id,
        model: model || null,
        cost_usd: run.parsed.cost_usd,
        usage: run.parsed.usage,
        result_summary: truncate(typeof run.parsed.result === "string" ? run.parsed.result : JSON.stringify(run.parsed.result), 3000),
      });
      await this.store.updateJob(job.id, { phase: "verifying", attempts, session_id: run.session_id, model: model || null });
      if (run.cancelled || signal.aborted) throw new Error("AGY write task cancelled");
      if (run.timed_out) throw new Error("AGY write task timed out");
      if (run.exit_code !== 0 || run.parsed.is_error) throw new Error(`AGY write execution failed: ${truncate(run.stderr || JSON.stringify(run.parsed.result), 3000)}`);

      changes = await captureChanges({ workspace: workspaceInfo.path, jobDir, forbidden: mergedForbidden(config, job), writable: job.writable_paths || [] });
      if (changes.forbidden_changes.length || changes.unauthorized_changes.length) {
        const failures = [];
        if (changes.forbidden_changes.length) failures.push(`Forbidden paths changed: ${changes.forbidden_changes.join(", ")}`);
        if (changes.unauthorized_changes.length) failures.push(`Changes outside writable_paths: ${changes.unauthorized_changes.join(", ")}`);
        verification = { configured: job.acceptance_commands.length > 0, passed: false, results: [], policy_failure: failures.join("; ") };
        break;
      }
      verification = await runVerification({ commands: job.acceptance_commands, workspace: workspaceInfo.path, jobDir, config, signal, round });
      if (verification.passed || !verification.configured) break;
      if (round < rounds) {
        repairContext = verificationFailureContext(verification);
        await this.store.updateJob(job.id, { phase: "repairing", verification, changes });
      }
    }

    const ready = changes.forbidden_changes.length === 0 && changes.unauthorized_changes.length === 0 && (verification.passed || !verification.configured);
    const evidence = {
      status: ready ? "ready_for_acceptance" : "verification_failed",
      job_id: job.id,
      task_id: job.task_id,
      provider: "agy_write",
      session_id: taskSession?.session_id || null,
      model: model || null,
      workspace: workspaceInfo,
      changes,
      verification,
      attempts,
      warnings: verification.configured ? [] : ["No acceptance commands were configured; Codex must perform additional acceptance before applying."],
    };
    const evidencePath = path.join(jobDir, "evidence.json");
    await writeJsonAtomic(evidencePath, evidence);
    await this.store.updateJob(job.id, {
      status: ready ? "completed" : "failed",
      phase: ready ? "ready_for_acceptance" : "verification_failed",
      evidence_path: evidencePath,
      patch_path: changes.patch_path,
      workspace: workspaceInfo,
      session_id: taskSession?.session_id || null,
      model: model || null,
      finished_at: nowIso(),
    });
  }

  async status(jobId) {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    const jobDir = this.store.jobDir(jobId);
    const progress = await readWorkerProgress({ job, jobDir });
    const livePid = job.process_pid ? processExists(job.process_pid) : false;
    const runtimeState = ["queued", "running"].includes(job.status)
      ? livePid
        ? "external_process_alive"
        : this.promises.has(job.id)
          ? "managed_in_process"
          : "interrupted"
      : "terminal";
    return {
      ...this.publicJob(job),
      progress,
      runtime_state: runtimeState,
      process_alive: livePid,
      remediation: runtimeState === "interrupted"
        ? "The MCP host restarted or the provider process ended without a terminal record. Inspect local logs and the preserved session/worktree; use stage-work-continue only when the exact session is still present."
        : null,
    };
  }

  async startInvestigation(args) {
    const projectDir = path.resolve(requireString(args, "project_dir"));
    const config = await assertProject(projectDir);
    const taskId = String(args.task_id || `investigate-${Date.now()}`);
    const allJobs = await this.store.listJobs();
    const plan = await resolveJobPlan(projectDir, taskId, {
      existingJobs: allJobs,
      jobType: "reviewer_investigate",
    });
    const job = await this.store.createJob({
      id: newId("investigate"), type: "reviewer_investigate", provider: "agy", status: "queued", phase: "queued",
      project_dir: projectDir, task_id: taskId, goal: requireString(args, "objective"), plan: "", complexity: "low", mode: "investigate",
      plan_id: plan.plan_id, plan_type: plan.plan_type, association_reason: plan.association_reason,
      routing: { primary: investigatorPrimary(config), fallback: investigatorFallback(config), fallback_only_for: "runtime_provider_failure" },
    });
    this.launch(job, (signal) => this.executeAgy(job, config, signal));
    return this.publicJob(job);
  }

  async startVerify(args) {
    const projectDir = path.resolve(requireString(args, "project_dir"));
    const contract = await loadPlannerContract(projectDir, requireString(args, "task_id"));
    const review = contract.reviewer_tasks.find((item) => item.review_id === args.review_id);
    if (!review) throw new Error(`Invalid reviewer review_id=${args.review_id}`);
    const complexity = review.complexity === "mid" ? "medium" : review.complexity;
    return this.startAgy({
      project_dir: projectDir,
      task_id: args.task_id,
      goal: review.required_checks.join("; ") || `Verify ${args.review_id}`,
      plan: "",
      review_id: args.review_id,
      complexity,
      model: args.model,
      stage_run_id: args.stage_run_id,
    }, "review");
  }

  async accept(args) {
    const projectDir = path.resolve(requireString(args, "project_dir"));
    const taskId = requireString(args, "task_id");
    const jobs = await this.store.listJobs();
    const job = jobs.find((item) => item.id === requireString(args, "job_id") && item.project_dir === projectDir && item.task_id === taskId && item.status === "completed" && item.phase === "ready_for_acceptance");
    if (!job) throw new Error("acceptance_unavailable");
    const verification = collectAgyVerifyEvidence(jobs, projectDir, taskId, job);
    if (job.requires_agy_review && !job.review_waiver && !verification) throw new Error("acceptance_unavailable");
    const evidence = JSON.parse(await fs.readFile(job.evidence_path, "utf8"));
    const patchDigest = evidence.changes?.patch_digest || crypto.createHash("sha256").update(await fs.readFile(job.patch_path)).digest("hex");

    // Require a Planner contract — fail closed if missing or invalid.
    let contract;
    try {
      contract = await loadPlannerContract(projectDir, taskId);
    } catch (err) {
      throw new Error(`acceptance_unavailable: ${err.message}`);
    }

    // Use the shared saveAcceptance() with full provenance schema.
    return saveAcceptance({
      jobDir: this.store.jobDir(job.id),
      job,
      contract,
      evidence,
      patchDigest,
      verification,
      decision: args.decision || "accepted",
      accepterHost: "codex",
      accepterProvider: args.accepter_provider || "codex",
      accepterModel: args.accepter_model || "gpt-5.6-terra",
      accepterSessionId: args.session_id || job.session_id || null,
      summary: args.summary || `Accepted via Codex`,
      conditions: Array.isArray(args.conditions) ? args.conditions : [],
      unresolvedRisks: Array.isArray(args.unresolved_risks) ? args.unresolved_risks : [],
      updateJob: (patch) => this.store.updateJob(job.id, patch),
    });
  }

  async result(jobId) {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    let evidence = null;
    if (job.evidence_path && await pathExists(job.evidence_path)) evidence = JSON.parse(await fs.readFile(job.evidence_path, "utf8"));
    return { job: this.publicJob(job), evidence };
  }

  async cancel(jobId) {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    const controller = this.controllers.get(jobId);
    if (controller) controller.abort();
    else if (job.process_pid && processExists(job.process_pid)) await terminateProcessTree(job.process_pid);
    await this.store.updateJob(jobId, { status: "cancelled", phase: "cancelled", finished_at: nowIso() });
    return { job_id: jobId, cancelled: true };
  }

  async apply(jobId) {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);

    // Gate 1: Job must be completed and ready for acceptance
    if (job.status !== "completed" || job.phase !== "ready_for_acceptance") throw new Error("Only a completed job ready for acceptance can be applied.");

    // Gate 2: Acceptance artifact must exist with accepted status
    if (job.acceptance_status !== "accepted" || !job.acceptance_artifact_path) throw new Error("A valid acceptance artifact is required before apply.");

    // Gate 3: Contract must exist.
    const contract = await loadPlannerContract(job.project_dir, job.task_id);
    if (!contract) throw new Error(`No Planner contract found for task ${job.task_id}. A contract is required before apply.`);

    // Gate 4: Review-gate enforcement
    if (job.requires_agy_review && !job.review_waiver) {
      const allJobs = await this.store.listJobs();
      const agyEvidence = collectAgyVerifyEvidence(allJobs, job.project_dir, job.task_id, job);
      if (!agyEvidence) {
        throw new Error(
          `Job requires reviewer evidence before apply. ` +
          `Run reviewer-verify for task "${job.task_id}" or set review_waiver: true ` +
          `on the job contract to bypass this gate.`
        );
      }
      await this.store.updateJob(jobId, {
        agy_verify_job_id: agyEvidence.id,
        agy_verify_evidence_path: agyEvidence.evidence_path || null,
        reviewer_job_id: agyEvidence.id,
        reviewer_evidence_path: agyEvidence.evidence_path || null,
      });
    }

    // Gate 5: Evidence and patch integrity checks
    const evidence = JSON.parse(await fs.readFile(job.evidence_path, "utf8"));

    // Gate 5a: Patch digest must match acceptance artifact
    if (evidence.changes?.patch_digest && evidence.changes.patch_digest !== job.acceptance_patch_digest) {
      throw new Error("Acceptance artifact patch digest does not match the current patch.");
    }

    // Gate 5b: No forbidden path changes
    if (evidence.changes.forbidden_changes.length) throw new Error("Cannot apply a patch containing forbidden-path changes.");

    // Gate 5c: No unauthorized changes outside writable_paths
    if (evidence.changes.unauthorized_changes?.length) throw new Error("Cannot apply a patch containing changes outside writable_paths.");

    // Gate 5d: Verification must have passed.  Provider unavailability
    // (e.g. AGY quota exhaustion during review) must be surfaced as
    // verification_unavailable, not a silent verified=false.
    if (evidence.verification) {
      if (evidence.verification.status === "verification_unavailable") {
        throw new Error(`Verification provider was unavailable for job ${jobId}. Cannot apply.`);
      }
      if (!evidence.verification.passed && evidence.verification.configured !== false) {
        throw new Error(`Verification did not pass for job ${jobId}. Cannot apply.`);
      }
    }

    // Gate 6: Acceptance artifact provenance must match the current contract.
    // Uses the shared validateAcceptanceForCurrentPatch() which checks
    // schema validity, contract_id/version/digest match, patch_digest match,
    // and status === "accepted".
    const currentPatchDigest = evidence.changes?.patch_digest || null;
    await validateAcceptanceForCurrentPatch({
      artifactPath: job.acceptance_artifact_path,
      contract,
      currentPatchDigest,
    });

    // Gate 7: Workspace mode check
    if (job.workspace.mode === "in_place") return { applied: false, already_in_place: true, project_dir: job.project_dir };

    // Gate 8: Git apply check (done inside applyPatch)
    const result = await applyPatch({ originalProjectDir: job.workspace.original_project_dir, patchPath: job.patch_path, logDir: this.store.jobDir(jobId) });
    await this.store.updateJob(jobId, { applied_at: nowIso(), phase: "applied" });
    return result;
  }

  async cleanup(jobId) {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (["queued", "running"].includes(job.status)) throw new Error("Cancel or wait for the job before cleanup.");
    const result = await cleanupWorkspace({
      originalProjectDir: job.workspace?.original_project_dir || job.project_dir,
      workspacePath: job.workspace?.path,
      mode: job.workspace?.mode,
      logDir: this.store.jobDir(jobId),
    });
    // Clear session for the job's provider
    if (job.provider && job.task_id) {
      const sessionProvider = job.provider === "agy_write" ? "agy_write" : job.provider;
      await this.store.clearSession(job.project_dir, sessionProvider, job.task_id);
    }
    await this.store.updateJob(jobId, { cleaned_at: nowIso(), phase: job.applied_at ? "applied_and_cleaned" : "cleaned" });
    return result;
  }

  publicJob(job) {
    return {
      id: job.id,
      type: job.type,
      provider: job.provider,
      status: job.status,
      phase: job.phase,
      project_dir: job.project_dir,
      task_id: job.task_id,
      review_id: job.review_id || null,
      session_id: job.session_id || null,
      model: job.model || job.model_override || null,
      plan_id: job.plan_id || null,
      plan_type: job.plan_type || null,
      contract_id: job.contract_id || null,
      association_reason: job.association_reason || null,
      auto_route: job.auto_route || null,
      auto_fallback_reason: job.auto_fallback_reason || null,
      auto_fallback_classifier: job.auto_fallback_classifier || null,
      dependencies: job.dependencies || [],
      read_paths: job.read_paths || [],
      writable_paths: job.writable_paths || [],
      forbidden_paths: job.forbidden_paths || [],
      acceptance_commands: job.acceptance_commands || [],
      requires_agy_review: job.requires_agy_review || false,
      review_waiver: job.review_waiver || false,
      agy_verify_job_id: job.agy_verify_job_id || null,
      agy_verify_evidence_path: job.agy_verify_evidence_path || null,
      reviewer_job_id: job.reviewer_job_id || job.agy_verify_job_id || null,
      reviewer_evidence_path: job.reviewer_evidence_path || job.agy_verify_evidence_path || null,
      acceptance_artifact_path: job.acceptance_artifact_path || null,
      acceptance_status: job.acceptance_status || null,
      routing: job.routing || null,
      route_chain: job.route_chain || null,
      route_attempts: job.route_attempts || [],
      route_index: Number.isInteger(job.route_index) ? job.route_index : null,
      stage_run_id: job.stage_run_id || null,
      process_pid: job.process_pid || null,
      process_cwd: job.process_cwd || null,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at || null,
      finished_at: job.finished_at || null,
      evidence_path: job.evidence_path || null,
      patch_path: job.patch_path || null,
      error: job.error || null,
    };
  }
}
