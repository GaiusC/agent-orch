#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { DEFAULT_CODEX_MCP_MODEL, loadProjectConfig, projectOrchestratorRoot, projectRunsRoot, projectStateRoot } from "./lib/config.mjs";
import { validateHostToolTrust } from "./lib/policy.mjs";
import { runProcess, commandExists } from "./lib/process.mjs";
import { StateStore } from "./lib/state.mjs";
import { WorkerOrchestrator } from "./lib/orchestrator.mjs";
import { requireString } from "./lib/utils.mjs";
import { loadPlannerContract, loadPlannerSubtask, persistPlannerContract } from "./lib/contracts.mjs";
import { resolveStageRoutes } from "./lib/provider-registry.mjs";
import { StageRuntime } from "./lib/stage-runtime.mjs";

const commonTaskProperties = {
  project_dir: { type: "string", description: "Absolute path to the trusted project root." },
  task_id: { type: "string", description: "Stable task identifier used to bind sessions to this project and goal." },
  goal: { type: "string", description: "Concrete task goal." },
  plan: { type: "string", description: "Codex-approved implementation or investigation plan." },
  dependencies: { type: "array", items: { type: "string" }, description: "Task ids that must be applied before implementation can start." },
  read_paths: { type: "array", items: { type: "string" }, description: "Paths the worker may read but must not modify." },
  writable_paths: { type: "array", items: { type: "string" }, description: "Paths the worker may modify." },
  forbidden_paths: { type: "array", items: { type: "string" }, description: "Paths the worker must not read or modify." },
  review_waiver: { type: "boolean", description: "Request reviewer gate waiver when project policy allows it." },
};

const tools = [
  {
    name: "stage-plan",
    description: "Persist the in-session Planner contract and immutable Plan execution identity. This stage does not invoke an external planner when Codex is the host.",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string" },
        task_id: { type: "string" },
        contract: { type: "object" },
        planner_session_id: { type: "string" },
      },
      required: ["project_dir", "task_id", "contract", "planner_session_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  {
    name: "stage-work",
    description: "Start the configured work-stage route for one persisted Planner subtask. Provider/model selection and retryable fallback are server-managed.",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string" },
        task_id: { type: "string" },
        subtask_id: { type: "string" },
        review_waiver: { type: "boolean" },
      },
      required: ["project_dir", "task_id", "subtask_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "stage-work-continue",
    description: "Continue the exact provider session and isolated worktree from a prior work-stage job. It never silently reroutes or creates an unrelated session.",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string" },
        task_id: { type: "string" },
        job_id: { type: "string" },
        feedback: { type: "string" },
      },
      required: ["project_dir", "task_id", "job_id", "feedback"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "stage-review",
    description: "Start the configured formal reviewer stage for a persisted review_id and bind its evidence to the implementation patch.",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string" },
        task_id: { type: "string" },
        review_id: { type: "string" },
      },
      required: ["project_dir", "task_id", "review_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  {
    name: "stage-accept",
    description: "Run the formal acceptance kernel using the immutable Plan execution identity. No provider/model/session fallback is allowed.",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string" },
        task_id: { type: "string" },
        job_id: { type: "string" },
        accepter_session_id: { type: "string" },
        decision: { type: "string", enum: ["accepted", "rejected"] },
        summary: { type: "string" },
        conditions: { type: "array", items: { type: "string" } },
        unresolved_risks: { type: "array", items: { type: "string" } },
      },
      required: ["project_dir", "task_id", "job_id", "accepter_session_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "wait-for-job",
    description: "Wait for a job managed by the current MCP process, then return durable status. If the MCP host restarted, status reports the preserved external PID/session state instead of declaring the worker dead.",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string" },
        job_id: { type: "string" },
      },
      required: ["project_dir", "job_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "health",
    description: "Check whether the local Claude Code and Antigravity CLI executables are available and inspect project trust configuration.",
    inputSchema: { type: "object", properties: { project_dir: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "cc-exec",
    description: "Delegate a Codex-approved coding task to Claude Code as the primary writer. Runs asynchronously in an isolated Git worktree, verifies it, and preserves the CC session.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTaskProperties,
        acceptance_commands: { type: "array", items: { type: "string" }, description: "Deterministic commands the broker must run after implementation." },
      },
      required: ["project_dir", "task_id", "goal", "plan"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "cc-continue",
    description: "Continue the exact Claude Code session for an existing project/task with incremental Codex feedback. Never use for an unrelated goal or after changing the underlying model.",
    inputSchema: {
      type: "object",
      properties: { ...commonTaskProperties, acceptance_commands: { type: "array", items: { type: "string" } } },
      required: ["project_dir", "task_id", "goal", "plan"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "reviewer-investigate",
    description: "Read-only investigation, always AGY low with CC low runtime-failure fallback. It is not formal review evidence and needs no Planner contract.",
    inputSchema: { type: "object", properties: { project_dir: { type: "string" }, task_id: { type: "string" }, objective: { type: "string" } }, required: ["project_dir", "objective"], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  {
    name: "reviewer-verify",
    description: "Formal patch-bound verification. Complexity and reviewer model are read from the persisted Planner contract; evidence is bound to the current patch digest.",
    inputSchema: { type: "object", properties: { project_dir: { type: "string" }, task_id: { type: "string" }, review_id: { type: "string" } }, required: ["project_dir", "task_id", "review_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  {
    name: "planner-plan",
    description: "Persist the fixed Planner's formal contract. The contract supplies executor/reviewer complexity, paths, tests, fallback permission, and acceptance criteria, never provider/model routing.",
    inputSchema: { type: "object", properties: { project_dir: { type: "string" }, task_id: { type: "string" }, contract: { type: "object" }, planner_session_id: { type: "string" } }, required: ["project_dir", "task_id", "contract", "planner_session_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  {
    name: "codex-exec",
    description: "Ask Codex CLI to execute a read-only planner or accepter contract when the current host is CC Desktop or another non-Codex coordinator. Codex must not modify files. Use mode=plan for planning or mode=accept for acceptance.",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string", description: "Absolute path to the trusted project root." },
        task_id: { type: "string", description: "Stable task id." },
        mode: { type: "string", enum: ["plan", "accept"], description: "Codex role for this task." },
        goal: { type: "string", description: "Task goal." },
        context: { type: "string", description: "Optional project/task context, evidence, or diff summary." },
        model: { type: "string", description: "Optional Codex model override." },
        reasoning_effort: { type: "string", description: "Optional Codex reasoning effort override." },
      },
      required: ["project_dir", "task_id", "mode", "goal"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  {
    name: "codex-continue",
    description: "Continue the same Codex CLI session for a planner or accepter contract with additional feedback or evidence. Use the same task_id. This supports plan first, then accept in the same Codex session.",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string", description: "Absolute path to the trusted project root." },
        task_id: { type: "string", description: "Stable task id from the original Codex execution." },
        mode: { type: "string", enum: ["plan", "accept"], description: "Codex role for this task." },
        goal: { type: "string", description: "Task goal." },
        context: { type: "string", description: "Original context, evidence, or diff summary." },
        feedback: { type: "string", description: "New feedback, missing checks, or updated evidence." },
        model: { type: "string", description: "Optional Codex model override." },
        reasoning_effort: { type: "string", description: "Optional Codex reasoning effort override." },
      },
      required: ["project_dir", "task_id", "mode", "goal", "feedback"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  {
    name: "agy-exec",
    description: "Delegate a Codex-approved coding task to Antigravity as the primary writer. Runs asynchronously in an isolated Git worktree, verifies it, and preserves the AGY session. Supports apply/cleanup semantics.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTaskProperties,
        acceptance_commands: { type: "array", items: { type: "string" }, description: "Deterministic commands the broker must run after implementation." },
      },
      required: ["project_dir", "task_id", "goal", "plan"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "agy-continue",
    description: "Continue the exact Antigravity write session for an existing project/task with incremental Codex feedback. Never use for an unrelated goal or after changing the underlying model.",
    inputSchema: {
      type: "object",
      properties: { ...commonTaskProperties, acceptance_commands: { type: "array", items: { type: "string" } } },
      required: ["project_dir", "task_id", "goal", "plan"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "auto",
    description: "Standard executor router/launcher. It loads the Planner contract and subtask complexity, then uses centralized priority and the model registry. Callers cannot select complexity, executor, provider, model, or fallback.",
    inputSchema: {
      type: "object",
      properties: { project_dir: { type: "string" }, task_id: { type: "string" }, subtask_id: { type: "string" } },
      required: ["project_dir", "task_id", "subtask_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "accepter-accept",
    description: "The sole formal acceptance MCP. It reuses the actual session that produced the current Planner contract, does no routing or fallback, and persists an acceptance artifact bound to contract, patch, and verification evidence.",
    inputSchema: { type: "object", properties: { project_dir: { type: "string" }, task_id: { type: "string" }, job_id: { type: "string" }, decision: { type: "string", enum: ["accepted", "rejected"] } }, required: ["project_dir", "task_id", "job_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  {
    name: "status",
    description: "Return compact status for an asynchronous CC or AGY job. Includes a `progress` field with at most the two newest assistant-only messages from the worker transcript (bounded, no tool calls, no raw logs). Raw logs and tool output remain local artifacts — use `result` for the full evidence pack. Use `progress.available` to distinguish \"job has no progress yet\" from \"job is not alive\".",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, project_dir: { type: "string", description: "Absolute path to the trusted project root (optional; resolved from job if omitted)." } }, required: ["job_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "result",
    description: "Return the compact Evidence Pack for a finished job. Raw logs stay on disk and are returned only as paths.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, project_dir: { type: "string", description: "Absolute path to the trusted project root (optional; resolved from job if omitted)." } }, required: ["job_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "cancel",
    description: "Cancel an active CC or AGY job and terminate its process tree.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, project_dir: { type: "string", description: "Absolute path to the trusted project root (optional; resolved from job if omitted)." } }, required: ["job_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "apply",
    description: "After Codex acceptance, apply a verified CC patch from its isolated worktree to the original project. This is the only normal path from worker output to the main workspace.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, project_dir: { type: "string", description: "Absolute path to the trusted project root (optional; resolved from job if omitted)." } }, required: ["job_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "cleanup",
    description: "Remove an isolated worktree and clear its bound session after the patch is applied or abandoned. Evidence and logs remain available.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, project_dir: { type: "string", description: "Absolute path to the trusted project root (optional; resolved from job if omitted)." } }, required: ["job_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
];

const PROVIDER_TOOL_NAMES = new Set([
  "cc-exec", "cc-continue", "agy-exec", "agy-continue", "auto",
  "reviewer-investigate", "reviewer-verify", "planner-plan",
  "codex-exec", "codex-continue", "accepter-accept",
]);
const PRIMARY_TOOL_NAMES = new Set([
  "stage-plan", "stage-work", "stage-work-continue", "stage-review", "stage-accept",
  "wait-for-job", "health", "status", "result", "cancel", "apply", "cleanup",
]);
const exposeProviderTools = process.env.AGENT_ORCH_EXPOSE_PROVIDER_TOOLS === "1";

// -- Project-scoped orchestrator cache --
// Each project gets its own StateStore rooted under .agent-orchestrator/,
// so job state, sessions, events, and handoff files live alongside the
// project config — not in a shared global directory.
const projectOrchestrators = new Map();

async function getProjectOrchestrator(projectDir) {
  const resolved = path.resolve(projectDir);
  let entry = projectOrchestrators.get(resolved);
  if (!entry) {
    const store = new StateStore(
      projectStateRoot(resolved),
      {
        jobsRoot: projectRunsRoot(resolved),
        orchestratorRoot: projectOrchestratorRoot(resolved),
      },
    );
    await store.init();
    const stageRuntime = new StageRuntime(store, resolved);
    await stageRuntime.init();
    const orchestrator = new WorkerOrchestrator(store, { stageRuntime });
    entry = { store, orchestrator, stageRuntime };
    projectOrchestrators.set(resolved, entry);
  }
  return entry;
}

// Resolve a job's project by searching all cached project stores.
// Used by job-control tools (status, result, cancel, apply, cleanup)
// that only receive a job_id and must discover the owning project for
// policy validation.
async function resolveJobOrchestrator(jobId) {
  for (const [projectDir, { store, orchestrator }] of projectOrchestrators) {
    const job = await store.getJob(jobId);
    if (job) return { projectDir, job, store, orchestrator };
  }
  // Fallback: try a legacy global store if present (migration path).
  // Once all job state is under project directories this path becomes dead code.
  return null;
}

const server = new Server(
  { name: "agent-orch-mcp", version: "0.4.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.filter((tool) => PRIMARY_TOOL_NAMES.has(tool.name) || (exposeProviderTools && PROVIDER_TOOL_NAMES.has(tool.name))),
}));

function response(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function denialResponse(denial) {
  return response(
    {
      allowed: false,
      error: denial.detail,
      reason: denial.reason,
      category: denial.category || denial.reason,
      host: denial.host,
      tool: denial.tool,
      detail: denial.detail,
      remediation: denial.remediation || null,
      policy_denial: true,
    },
    true,
  );
}

/**
 * Read project config for a given project_dir to determine host, trusted, and
 * mcp.enabled.  Returns safe defaults when the config cannot be loaded.
 */
async function projectPolicyContext(projectDir) {
  if (!projectDir || !String(projectDir).trim()) {
    return { host: "unknown", trusted: false, mcpEnabled: false, exposeProviderTools: false };
  }
  try {
    const config = await loadProjectConfig(projectDir);
    return {
      host: config.host?.provider || "unknown",
      trusted: config.trusted === true,
      mcpEnabled: config.mcp?.enabled === true,
      exposeProviderTools: config.mcp?.expose_provider_tools === true,
    };
  } catch {
    return { host: "unknown", trusted: false, mcpEnabled: false, exposeProviderTools: false };
  }
}

async function runCodexReadOnly(args, { continuation = false } = {}) {
  const projectDir = path.resolve(requireString(args, "project_dir"));
  const taskId = requireString(args, "task_id");
  const config = await loadProjectConfig(projectDir);
  if (config.host?.provider === "codex") {
    throw new Error("codex-exec/codex-continue are forbidden when host.provider is codex; use the current Codex session for planner/accepter work.");
  }
  const codexConfig = config.providers?.codex?.cli || {};
  const codexModels = config.models?.codex || {};
  const command = codexConfig.command || config.cli?.codex || "codex";
  const mode = String(args.mode || "plan");
  const model = args.model || codexConfig.model || (mode === "accept" ? codexModels.accepter : codexModels.planner) || DEFAULT_CODEX_MCP_MODEL;
  const effort = args.reasoning_effort || codexConfig.reasoning_effort || codexModels.reasoning_effort || "medium";
  const prompt = mode === "plan"
    ? [
        "You are Codex acting as a read-only Agent Orch planner for a non-Codex host coordinator.",
        "Do not modify files or external systems.",
        `Task id: ${requireString(args, "task_id")}`,
        `Goal: ${requireString(args, "goal")}`,
        args.context ? `Context:\n${args.context}` : null,
        continuation && args.feedback ? `Continuation feedback:\n${args.feedback}` : null,
        "Return a concise contract-oriented plan with: plan_id, contracts, dependencies, read_paths, writable_paths, forbidden_paths, acceptance_commands, parallel/serial ordering, risks, and reviewer gate recommendations.",
      ].filter(Boolean).join("\n\n")
    : [
        "You are Codex acting as a read-only Agent Orch accepter for a non-Codex host coordinator.",
        "Do not modify files or external systems.",
        `Task id: ${requireString(args, "task_id")}`,
        `Goal: ${requireString(args, "goal")}`,
        args.context ? `Context/evidence:\n${args.context}` : null,
        continuation && args.feedback ? `Continuation feedback or new evidence:\n${args.feedback}` : null,
        "Inspect the evidence and available project state read-only. Return ACCEPT, REJECT, or ACCEPT_WITH_RISKS with concrete reasons, missing checks, scope concerns, and next actions.",
      ].filter(Boolean).join("\n\n");
  const { store } = await getProjectOrchestrator(projectDir);
  const existingSession = continuation ? await store.getSession(projectDir, "codex", taskId) : null;
  if (continuation && !existingSession?.session_id) {
    throw new Error(`No Codex session found for task_id=${taskId}. Run codex-exec first.`);
  }
  const logDir = path.join(projectRunsRoot(projectDir), `codex-${mode}-${continuation ? "continue" : "exec"}-${Date.now()}`);
  const sharedArgs = [
    "--model", String(model),
    "-c", `model_reasoning_effort="${effort}"`,
    "-c", 'approval_policy="never"',
    "--skip-git-repo-check",
    "--sandbox", "read-only",
  ];
  const codexArgs = continuation
    ? ["exec", "resume", ...sharedArgs, existingSession.session_id, prompt]
    : ["exec", ...sharedArgs, prompt];
  const result = await runProcess({
    command,
    args: codexArgs,
    cwd: projectDir,
    timeoutSeconds: Number(codexConfig.timeout_seconds || 900),
    logDir,
    logPrefix: `codex-${mode}`,
    maxLogBytes: config.execution?.max_log_bytes || 4 * 1024 * 1024,
  });
  const sessionId = result.stdout.match(/session id:\s*([0-9a-f-]{36})/i)?.[1] || existingSession?.session_id || null;
  if (sessionId) {
    await store.setSession(projectDir, "codex", taskId, { session_id: sessionId, model: String(model), mode });
  }
  return {
    ok: result.exit_code === 0,
    mode,
    continuation,
    command,
    model,
    reasoning_effort: effort,
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_path: result.stdout_path,
    stderr_path: result.stderr_path,
    session_id: sessionId,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    // Resolve the effective project directory for policy validation.
    // For job-control tools that only take job_id, we look up the job
    // to find its owning project.
    let effectiveProjectDir = args.project_dir || args.projectDir || null;
    const isJobControlTool = ["status", "result", "cancel", "apply", "cleanup"].includes(name);
    let resolvedJobOrch = null;

    if (isJobControlTool) {
      const jobId = requireString(args, "job_id");
      resolvedJobOrch = await resolveJobOrchestrator(jobId);
      if (resolvedJobOrch) {
        effectiveProjectDir = effectiveProjectDir || resolvedJobOrch.projectDir;
      } else if (!effectiveProjectDir) {
        throw new Error(`Cannot resolve project for job ${jobId}. Provide project_dir explicitly or ensure the job was created in this server session.`);
      }
    }

    // Resolve policy context from the effective project directory.
    const ctx = await projectPolicyContext(effectiveProjectDir);
    if (PROVIDER_TOOL_NAMES.has(name) && !(exposeProviderTools && ctx.exposeProviderTools)) {
      throw new Error("Provider-specific MCP wrappers are disabled. Use stage-* tools, or enable both mcp.expose_provider_tools and AGENT_ORCH_EXPOSE_PROVIDER_TOOLS=1 for diagnostics.");
    }

    // Validate this tool call against host, trust, and MCP-enabled gates.
    const validation = validateHostToolTrust({
      host: ctx.host,
      tool: name,
      trusted: ctx.trusted,
      mcpEnabled: ctx.mcpEnabled,
    });
    if (!validation.allowed) {
      return denialResponse(validation);
    }

    // For project-scoped tools, get the per-project orchestrator.
    let orchestrator;
    let stageRuntime;
    if (effectiveProjectDir) {
      const entry = await getProjectOrchestrator(effectiveProjectDir);
      orchestrator = entry.orchestrator;
      stageRuntime = entry.stageRuntime;
    }

    // For job-control tools resolved via job lookup, use that project's orchestrator.
    if (resolvedJobOrch && !orchestrator) {
      orchestrator = resolvedJobOrch.orchestrator;
    }

    // Tool dispatch — only reachable after policy validation passes.
    switch (name) {
      case "stage-plan": {
        const projectDir = path.resolve(requireString(args, "project_dir"));
        const config = await loadProjectConfig(projectDir);
        const [route] = resolveStageRoutes(config, "plan", config.stages?.plan?.default_complexity || "high");
        const contract = await persistPlannerContract(projectDir, requireString(args, "task_id"), args.contract, requireString(args, "planner_session_id"));
        const identity = await stageRuntime.savePlanIdentity(args.task_id, {
          provider: route.provider,
          model: route.model,
          invocation: route.invocation,
          session_id: args.planner_session_id,
          contract_id: contract.contract_id,
          contract_digest: contract.contract_digest,
        });
        const stageRun = await stageRuntime.create("plan", {
          status: "completed",
          task_id: args.task_id,
          provider: route.provider,
          model: route.model,
          invocation: route.invocation,
          session_id: args.planner_session_id,
          contract_id: contract.contract_id,
          finished_at: new Date().toISOString(),
        });
        return response({ stage_run: stageRun, contract, plan_execution_identity: identity });
      }
      case "stage-work": {
        const projectDir = path.resolve(requireString(args, "project_dir"));
        const config = await loadProjectConfig(projectDir);
        const { subtask } = await loadPlannerSubtask(projectDir, requireString(args, "task_id"), requireString(args, "subtask_id"));
        const complexity = subtask.complexity === "mid" ? "medium" : subtask.complexity;
        const routes = resolveStageRoutes(config, "work", complexity);
        const stageRun = await stageRuntime.create("work", {
          task_id: args.task_id,
          subtask_id: args.subtask_id,
          route_chain: routes,
        });
        try {
          const job = await orchestrator.startStageWork(args, routes, { stageRunId: stageRun.stage_run_id });
          const linked = await stageRuntime.update(stageRun.stage_run_id, { job_id: job.id, provider: job.provider, model: job.model });
          return response({ stage_run: linked, job });
        } catch (error) {
          await stageRuntime.update(stageRun.stage_run_id, { status: "failed", error: error?.message || String(error), finished_at: new Date().toISOString() });
          throw error;
        }
      }
      case "stage-work-continue": {
        const stageRun = await stageRuntime.create("work", {
          task_id: args.task_id,
          continued_from_job_id: args.job_id,
        });
        try {
          const job = await orchestrator.startStageWork(args, [], { continuation: true, stageRunId: stageRun.stage_run_id });
          const linked = await stageRuntime.update(stageRun.stage_run_id, { job_id: job.id, provider: job.provider, model: job.model });
          return response({ stage_run: linked, job });
        } catch (error) {
          await stageRuntime.update(stageRun.stage_run_id, { status: "failed", error: error?.message || String(error), finished_at: new Date().toISOString() });
          throw error;
        }
      }
      case "stage-review": {
        const projectDir = path.resolve(requireString(args, "project_dir"));
        const config = await loadProjectConfig(projectDir);
        const contract = await loadPlannerContract(projectDir, requireString(args, "task_id"));
        const review = contract.reviewer_tasks.find((item) => item.review_id === requireString(args, "review_id"));
        if (!review) throw new Error(`Invalid reviewer review_id=${args.review_id}`);
        const complexity = review.complexity === "mid" ? "medium" : review.complexity;
        const [route] = resolveStageRoutes(config, "review", complexity);
        if (route.provider !== "agy") throw new Error(`Unsupported review provider: ${route.provider}`);
        const stageRun = await stageRuntime.create("review", {
          task_id: args.task_id,
          review_id: args.review_id,
          provider: route.provider,
          model: route.model,
          invocation: route.invocation,
        });
        try {
          const job = await orchestrator.startVerify({ ...args, stage_run_id: stageRun.stage_run_id, model: route.model });
          const linked = await stageRuntime.update(stageRun.stage_run_id, { job_id: job.id });
          return response({ stage_run: linked, job });
        } catch (error) {
          await stageRuntime.update(stageRun.stage_run_id, { status: "failed", error: error?.message || String(error), finished_at: new Date().toISOString() });
          throw error;
        }
      }
      case "stage-accept": {
        const projectDir = path.resolve(requireString(args, "project_dir"));
        const config = await loadProjectConfig(projectDir);
        const identity = await stageRuntime.loadPlanIdentity(requireString(args, "task_id"));
        const [route] = resolveStageRoutes(config, "accept", config.stages?.plan?.default_complexity || "high");
        const accepterSessionId = requireString(args, "accepter_session_id");
        for (const [field, actual, expected] of [
          ["provider", route.provider, identity.provider],
          ["model", route.model, identity.model],
          ["invocation", route.invocation, identity.invocation],
          ["session_id", accepterSessionId, identity.session_id],
        ]) {
          if ((actual || null) !== (expected || null)) {
            throw new Error(`acceptance_identity_mismatch: ${field} expected=${expected || "(null)"} actual=${actual || "(null)"}`);
          }
        }
        const stageRun = await stageRuntime.create("accept", {
          task_id: args.task_id,
          job_id: args.job_id,
          provider: route.provider,
          model: route.model,
          invocation: route.invocation,
          session_id: accepterSessionId,
        });
        try {
          const acceptance = await orchestrator.accept({
            ...args,
            session_id: accepterSessionId,
            accepter_provider: route.provider,
            accepter_model: route.model,
            accepter_invocation: route.invocation,
          });
          const completed = await stageRuntime.update(stageRun.stage_run_id, {
            status: "completed",
            acceptance_id: acceptance.acceptance_id,
            finished_at: new Date().toISOString(),
          });
          return response({ stage_run: completed, acceptance });
        } catch (error) {
          await stageRuntime.update(stageRun.stage_run_id, { status: "failed", error: error?.message || String(error), finished_at: new Date().toISOString() });
          throw error;
        }
      }
      case "wait-for-job": {
        const job = await orchestrator.wait(requireString(args, "job_id"));
        if (job.stage_run_id) await stageRuntime.syncWithJob(job.stage_run_id);
        return response(job);
      }
      case "health": {
        const entry = effectiveProjectDir ? await getProjectOrchestrator(effectiveProjectDir) : null;
        return response(entry ? await entry.orchestrator.health(effectiveProjectDir) : await fallbackHealth());
      }
      case "cc-exec": return response(await orchestrator.startCc(args, false));
      case "cc-continue": return response(await orchestrator.startCc(args, true));
      case "reviewer-investigate": return response(await orchestrator.startInvestigation(args));
      case "reviewer-verify": return response(await orchestrator.startVerify(args));
      case "planner-plan": return response(await persistPlannerContract(effectiveProjectDir, args.task_id, args.contract, args.planner_session_id));
      case "codex-exec": return response(await runCodexReadOnly(args, { continuation: false }));
      case "codex-continue": return response(await runCodexReadOnly(args, { continuation: true }));
      case "agy-exec": return response(await orchestrator.startAgyWrite(args, false));
      case "agy-continue": return response(await orchestrator.startAgyWrite(args, true));
      case "auto": return response(await orchestrator.startAuto(args));
      case "accepter-accept": return response(await orchestrator.accept(args));
      case "status": {
        const job = await orchestrator.status(requireString(args, "job_id"));
        if (job.stage_run_id) await stageRuntime.syncWithJob(job.stage_run_id);
        return response(job);
      }
      case "result": {
        const value = await orchestrator.result(requireString(args, "job_id"));
        if (value.job?.stage_run_id) await stageRuntime.syncWithJob(value.job.stage_run_id);
        return response(value);
      }
      case "cancel": return response(await orchestrator.cancel(requireString(args, "job_id")));
      case "apply": return response(await orchestrator.apply(requireString(args, "job_id")));
      case "cleanup": return response(await orchestrator.cleanup(requireString(args, "job_id")));
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return response({ error: error?.message || String(error), tool: name }, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Fallback health check when no project_dir is given.
async function fallbackHealth() {
  const claude = await commandExists(process.env.AGENT_ORCH_CLAUDE_BIN || process.env.EAO_CLAUDE_BIN || "claude");
  const agy = await commandExists(process.env.AGENT_ORCH_AGY_BIN || process.env.EAO_AGY_BIN || "agy");
  return {
    ok: claude.found && agy.found,
    claude,
    agy,
    data_dir: null,
    project_config: null,
    project_trusted: null,
    note: "No project_dir provided. Showing global CLI availability only. Provide project_dir for full project-scoped health check.",
  };
}
