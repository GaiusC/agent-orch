import fs from "node:fs/promises";
import path from "node:path";
import { assertProject, autoRouteProvider, chooseAgyWriteModel, chooseModel } from "./config.mjs";
import { commandExists } from "./process.mjs";
import { classifyAgyQuotaError, runAgy, runAgyWrite, runClaude } from "./adapters.mjs";
import { applyPatch, captureChanges, cleanupWorkspace, inspectGit, prepareWorkspace } from "./workspace.mjs";
import { runVerification, verificationFailureContext } from "./verify.mjs";
import { asStringArray, newId, nowIso, pathExists, requireString, truncate, writeJsonAtomic } from "./utils.mjs";

export class WorkerOrchestrator {
  constructor(store) {
    this.store = store;
    this.controllers = new Map();
    this.promises = new Map();
  }

  async health(projectDir) {
    const config = projectDir ? await assertProject(projectDir, { requireTrusted: false }) : null;
    const claude = await commandExists(config?.cli?.claude || process.env.AGENT_ORCH_CLAUDE_BIN || process.env.EAO_CLAUDE_BIN || "claude");
    const agy = await commandExists(config?.cli?.agy || process.env.AGENT_ORCH_AGY_BIN || process.env.EAO_AGY_BIN || "agy");
    return {
      ok: claude.found && agy.found,
      claude,
      agy,
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
    const id = newId("cc");
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
      complexity: ["low", "medium", "high"].includes(args.complexity) ? args.complexity : "medium",
      model_override: typeof args.model === "string" ? args.model : null,
      acceptance_commands: acceptance,
      continuation,
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
    const id = newId("agy");
    const job = await this.store.createJob({
      id,
      type: `agy_${mode}`,
      provider: "agy",
      status: "queued",
      phase: "queued",
      project_dir: projectDir,
      task_id: taskId,
      goal,
      plan: typeof args.plan === "string" ? args.plan : "",
      complexity: ["low", "medium", "high"].includes(args.complexity) ? args.complexity : "medium",
      model_override: typeof args.model === "string" ? args.model : null,
      mode,
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
    const id = newId("agy");
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
      complexity: ["low", "medium", "high"].includes(args.complexity) ? args.complexity : "medium",
      model_override: typeof args.model === "string" ? args.model : null,
      acceptance_commands: acceptance,
      continuation,
    });
    this.launch(job, (signal) => this.executeAgyWrite(job, config, signal));
    return this.publicJob(job);
  }

  // -- Automatic routing (complexity -> provider + quota fallback) --

  async startAuto(args) {
    const projectDir = path.resolve(requireString(args, "project_dir"));
    const taskId = requireString(args, "task_id");
    const goal = requireString(args, "goal");
    const config = await assertProject(projectDir);
    if (config.roles.duplicate_implementation !== false) throw new Error("duplicate_implementation must remain false for this workflow.");
    const complexity = ["low", "medium", "high"].includes(args.complexity) ? args.complexity : "medium";
    const provider = autoRouteProvider(config, complexity);
    const acceptance = asStringArray(args.acceptance_commands, "acceptance_commands") || config.verification.commands || [];
    const id = newId("auto");
    const job = await this.store.createJob({
      id,
      type: "auto_execute",
      provider,
      status: "queued",
      phase: "queued",
      project_dir: projectDir,
      task_id: taskId,
      goal,
      plan: typeof args.plan === "string" ? args.plan : "",
      complexity,
      model_override: typeof args.model === "string" ? args.model : null,
      acceptance_commands: acceptance,
      auto_route: provider,
    });
    this.launch(job, (signal) => this.executeAuto(job, config, signal));
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
      .finally(() => {
        this.controllers.delete(job.id);
        this.promises.delete(job.id);
      });
    this.promises.set(job.id, promise);
  }

  async executeCc(job, config, signal) {
    const jobDir = this.store.jobDir(job.id);
    await this.executeCcImpl(job, config, signal, jobDir);
  }

  async executeAgy(job, config, signal) {
    const jobDir = this.store.jobDir(job.id);
    await this.store.updateJob(job.id, { status: "running", phase: "executing", started_at: nowIso() });
    let taskSession = await this.store.getSession(job.project_dir, "agy", job.task_id);
    const model = chooseModel(config, "agy", job.complexity, job.model_override);
    if (taskSession && (taskSession.model || null) !== (model || null)) {
      await this.store.clearSession(job.project_dir, "agy", job.task_id);
      taskSession = null;
    }
    await this.store.updateJob(job.id, { model: model || null });
    const run = await runAgy({
      config,
      workspace: job.project_dir,
      jobDir,
      goal: job.goal,
      plan: job.plan,
      taskSession,
      model,
      signal,
      mode: job.mode,
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
    if (!run.session_id) throw new Error("AGY completed without a discoverable conversation ID; refusing an untracked session.");
    await this.store.setSession(job.project_dir, "agy", job.task_id, {
      session_id: run.session_id,
      workspace_path: job.project_dir,
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
        taskSession,
        model,
        repairContext,
        signal,
        round,
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

      changes = await captureChanges({ workspace: workspaceInfo.path, jobDir, forbidden: config.scope.forbidden });
      if (changes.forbidden_changes.length) {
        verification = { configured: job.acceptance_commands.length > 0, passed: false, results: [], policy_failure: `Forbidden paths changed: ${changes.forbidden_changes.join(", ")}` };
        break;
      }
      verification = await runVerification({ commands: job.acceptance_commands, workspace: workspaceInfo.path, jobDir, config, signal, round });
      if (verification.passed || !verification.configured) break;
      if (round < rounds) {
        repairContext = verificationFailureContext(verification);
        await this.store.updateJob(job.id, { phase: "repairing", verification, changes });
      }
    }

    const ready = changes.forbidden_changes.length === 0 && (verification.passed || !verification.configured);
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

  // -- Auto routing execution (complexity -> provider + quota fallback to CC) --

  async executeAuto(job, config, signal) {
    const jobDir = this.store.jobDir(job.id);
    const provider = job.auto_route || "cc";

    if (provider === "cc") {
      // Low complexity -> CC directly
      await this.store.updateJob(job.id, { provider: "cc", status: "running", phase: "executing", started_at: nowIso(), auto_route: "cc" });
      try {
        await this.executeCcImpl(job, config, signal, jobDir);
      } catch (error) {
        // CC failures bubble up normally -- no fallback
        throw error;
      }
      return;
    }

    // Medium/high complexity -> AGY write, with quota fallback
    await this.store.updateJob(job.id, { provider: "agy_write", status: "running", phase: "executing", started_at: nowIso(), auto_route: "agy_write" });
    try {
      await this.executeAgyWriteImpl(job, config, signal, jobDir);
      // Successful AGY write -- record route evidence
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
        // Quota exhausted -- clean up failed AGY workspace and fall back to CC.
        // Use the job's stored workspace as the primary source; the session
        // workspace is a secondary fallback for pre-session failures.
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
          const evidencePath = path.join(jobDir, "evidence.json");
          if (await pathExists(evidencePath)) {
            const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
            evidence.auto_route = evidence.auto_route || job.auto_route_evidence || {
              provider: "cc",
              fallback_occurred: true,
              original_provider: "agy_write",
              reason: "quota_exhaustion",
              original_error: truncate(errorText, 500),
            };
            await writeJsonAtomic(evidencePath, evidence);
          }
        } catch (ccError) {
          throw ccError; // Both AGY and CC failed
        }
        return;
      }
      // Non-quota error -- do NOT fall back silently
      throw error;
    }
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
        taskSession,
        model,
        repairContext,
        signal,
        round,
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

      changes = await captureChanges({ workspace: workspaceInfo.path, jobDir, forbidden: config.scope.forbidden });
      if (changes.forbidden_changes.length) {
        verification = { configured: job.acceptance_commands.length > 0, passed: false, results: [], policy_failure: `Forbidden paths changed: ${changes.forbidden_changes.join(", ")}` };
        break;
      }
      verification = await runVerification({ commands: job.acceptance_commands, workspace: workspaceInfo.path, jobDir, config, signal, round });
      if (verification.passed || !verification.configured) break;
      if (round < rounds) {
        repairContext = verificationFailureContext(verification);
        await this.store.updateJob(job.id, { phase: "repairing", verification, changes });
      }
    }

    const ready = changes.forbidden_changes.length === 0 && (verification.passed || !verification.configured);
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
        taskSession,
        model,
        repairContext,
        signal,
        round,
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

      changes = await captureChanges({ workspace: workspaceInfo.path, jobDir, forbidden: config.scope.forbidden });
      if (changes.forbidden_changes.length) {
        verification = { configured: job.acceptance_commands.length > 0, passed: false, results: [], policy_failure: `Forbidden paths changed: ${changes.forbidden_changes.join(", ")}` };
        break;
      }
      verification = await runVerification({ commands: job.acceptance_commands, workspace: workspaceInfo.path, jobDir, config, signal, round });
      if (verification.passed || !verification.configured) break;
      if (round < rounds) {
        repairContext = verificationFailureContext(verification);
        await this.store.updateJob(job.id, { phase: "repairing", verification, changes });
      }
    }

    const ready = changes.forbidden_changes.length === 0 && (verification.passed || !verification.configured);
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
    return this.publicJob(job);
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
    this.controllers.get(jobId)?.abort();
    await this.store.updateJob(jobId, { status: "cancelled", phase: "cancelled", finished_at: nowIso() });
    return { job_id: jobId, cancelled: true };
  }

  async apply(jobId) {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (job.status !== "completed" || job.phase !== "ready_for_acceptance") throw new Error("Only a completed job ready for acceptance can be applied.");
    const evidence = JSON.parse(await fs.readFile(job.evidence_path, "utf8"));
    if (evidence.changes.forbidden_changes.length) throw new Error("Cannot apply a patch containing forbidden-path changes.");
    if (job.workspace.mode === "in_place") return { applied: false, already_in_place: true, project_dir: job.project_dir };
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
      session_id: job.session_id || null,
      model: job.model || job.model_override || null,
      auto_route: job.auto_route || null,
      auto_fallback_reason: job.auto_fallback_reason || null,
      auto_fallback_classifier: job.auto_fallback_classifier || null,
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
