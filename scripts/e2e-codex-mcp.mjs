#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model = process.env.AGENT_ORCH_CODEX_MCP_MODEL || "gpt-5.4-mini";
const codex = process.env.AGENT_ORCH_CODEX_BIN || "codex";
const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-codex-mcp-e2e-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: pluginRoot,
    encoding: "utf8",
    timeout: 180_000,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

try {
  const initialized = run(process.execPath, [
    path.join(pluginRoot, "scripts", "agent-orch.mjs"),
    "init",
    "-ProjectDir",
    projectDir,
    "-HostProvider",
    "codex",
  ]);
  if (initialized.status !== 0) {
    throw new Error(`project init failed: ${initialized.stderr || initialized.stdout}`);
  }

  const prompt = [
    "Call the agent_orch stage-plan MCP tool exactly once.",
    `project_dir: ${projectDir}`,
    "task_id: codex-mcp-e2e",
    "planner_session_id: codex-mcp-e2e-session",
    'contract: {"contract_id":"codex-mcp-e2e-contract","contract_version":1,"repository_identity":"temporary-e2e","executor_subtasks":[{"subtask_id":"probe","role":"executor","objective":"Verify Codex can call the Agent Orch stage MCP surface","complexity":"low","writable_paths":["."],"forbidden_paths":[".git/",".env",".env.*"],"required_tests":[],"acceptance_criteria":["stage-plan returns completed"],"fallback_policy":{"enabled":true}}],"reviewer_tasks":[]}',
    "Do not use shell commands or resource listing. Return only the stage status.",
  ].join("\n");

  const result = run(codex, [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    model,
    "-c",
    "mcp_servers.agent_orch.command='node'",
    "-c",
    "mcp_servers.agent_orch.args=['scripts/mcp-stdio-bridge.mjs']",
    "-c",
    `mcp_servers.agent_orch.cwd='${pluginRoot.replaceAll("\\", "/")}'`,
    "-c",
    "mcp_servers.agent_orch.enabled_tools=['stage-plan']",
    "-C",
    projectDir,
    "--json",
    "-",
  ], { input: prompt });

  const events = String(result.stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const call = events.find((event) =>
    event.type === "item.completed"
    && event.item?.type === "mcp_tool_call"
    && event.item?.server === "agent_orch"
    && event.item?.tool === "stage-plan");
  const stageStatus = call?.item?.result?.structured_content?.stage_run?.status || null;
  const passed = result.status === 0 && call?.item?.status === "completed" && stageStatus === "completed";

  console.log(JSON.stringify({
    ok: passed,
    model,
    codex_exit_code: result.status,
    mcp_call_status: call?.item?.status || "missing",
    stage_status: stageStatus,
    stderr: passed ? "" : String(result.stderr || "").slice(-4000),
  }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await fs.rm(projectDir, { recursive: true, force: true });
}
