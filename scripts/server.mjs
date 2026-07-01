#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StateStore } from "./lib/state.mjs";
import { WorkerOrchestrator } from "./lib/orchestrator.mjs";
import { requireString } from "./lib/utils.mjs";

const commonTaskProperties = {
  project_dir: { type: "string", description: "Absolute path to the trusted project root." },
  task_id: { type: "string", description: "Stable task identifier used to bind sessions to this project and goal." },
  goal: { type: "string", description: "Concrete task goal." },
  plan: { type: "string", description: "Codex-approved implementation or investigation plan." },
  complexity: { type: "string", enum: ["low", "medium", "high"], default: "medium" },
  model: { type: "string", description: "Optional explicit model override. Project routing is used when omitted." },
};

const tools = [
  {
    name: "worker_health",
    description: "Check whether the local Claude Code and Antigravity CLI executables are available and inspect project trust configuration.",
    inputSchema: { type: "object", properties: { project_dir: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "cc_execute_task",
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
    name: "cc_continue_task",
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
    name: "agy_investigate",
    description: "Ask Antigravity to investigate, reproduce, or gather evidence without duplicating CC implementation and without modifying project files.",
    inputSchema: { type: "object", properties: commonTaskProperties, required: ["project_dir", "task_id", "goal"], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  {
    name: "agy_verify",
    description: "Ask Antigravity for targeted runtime, browser, UI, environment, or compatibility verification. This is evidence gathering, not a second implementation.",
    inputSchema: { type: "object", properties: commonTaskProperties, required: ["project_dir", "task_id", "goal"], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  {
    name: "agy_execute_disjoint_subtask",
    description: "Allow Antigravity to implement a strictly disjoint subtask only when Codex has confirmed it does not overlap CC work.",
    inputSchema: {
      type: "object",
      properties: { ...commonTaskProperties, allow_write: { type: "boolean", const: true } },
      required: ["project_dir", "task_id", "goal", "plan", "allow_write"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "worker_status",
    description: "Return compact status for an asynchronous CC or AGY job.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "worker_result",
    description: "Return the compact Evidence Pack for a finished job. Raw logs stay on disk and are returned only as paths.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "worker_cancel",
    description: "Cancel an active CC or AGY job and terminate its process tree.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "worker_apply_result",
    description: "After Codex acceptance, apply a verified CC patch from its isolated worktree to the original project. This is the only normal path from worker output to the main workspace.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "worker_cleanup",
    description: "Remove an isolated worktree and clear its bound session after the patch is applied or abandoned. Evidence and logs remain available.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
];

const store = new StateStore();
await store.init();
const orchestrator = new WorkerOrchestrator(store);

const server = new Server(
  { name: "agent-orch-legacy-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

function response(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case "worker_health": return response(await orchestrator.health(args.project_dir));
      case "cc_execute_task": return response(await orchestrator.startCc(args, false));
      case "cc_continue_task": return response(await orchestrator.startCc(args, true));
      case "agy_investigate": return response(await orchestrator.startAgy(args, "investigate"));
      case "agy_verify": return response(await orchestrator.startAgy(args, "verify"));
      case "agy_execute_disjoint_subtask": return response(await orchestrator.startAgy(args, "disjoint_subtask"));
      case "worker_status": return response(await orchestrator.status(requireString(args, "job_id")));
      case "worker_result": return response(await orchestrator.result(requireString(args, "job_id")));
      case "worker_cancel": return response(await orchestrator.cancel(requireString(args, "job_id")));
      case "worker_apply_result": return response(await orchestrator.apply(requireString(args, "job_id")));
      case "worker_cleanup": return response(await orchestrator.cleanup(requireString(args, "job_id")));
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return response({ error: error?.message || String(error), tool: name }, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
