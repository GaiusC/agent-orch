import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StateStore } from "../scripts/lib/state.mjs";
import { WorkerOrchestrator } from "../scripts/lib/orchestrator.mjs";
import { JobNotifications, compactJob, prepareProgressChannel, reportProgress } from "../scripts/lib/notifications.mjs";
import { handleNotificationHook } from "../scripts/notify-hook.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function fixture(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-notify-"));
  t.after(() => fs.rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(project, ".agent-orchestrator");
  const store = new StateStore(path.join(root, "state"), { jobsRoot: path.join(root, "runs"), orchestratorRoot: root });
  await store.init();
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ version: 2, trusted: true, mcp: { enabled: true }, host: { provider: "codex" }, stages: {} }));
  const job = await store.createJob({ id: "job-1", project_dir: project, type: "stage_work", status: "running", phase: "executing", supervisor_pid: process.pid, created_at: new Date().toISOString() });
  const reporting = await prepareProgressChannel(store.jobDir(job.id), { projectDir: project, role: "worker" });
  const notifications = new JobNotifications(store);
  const args = { project_dir: project, job_id: job.id, timeout_ms: 0, until: "update", consumer_id: "test-chat" };
  return { project, root, store, job, reporting, notifications, args };
}

test("node reports are bounded, deduplicated, and cannot change authoritative job state", async t => {
  const f = await fixture(t);
  const input = { checkpoint: "inspection_done", message: "已确认接口可以复用。" };
  assert.equal((await reportProgress(f.reporting, input)).accepted, true);
  assert.equal((await reportProgress(f.reporting, input)).duplicate, true);
  assert.equal((await f.store.getJob(f.job.id)).status, "running");
  const first = await f.notifications.wait(f.args);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].source, "agent_report");
  assert.equal(first.cursor, 1);
  assert.equal((await f.notifications.wait({ ...f.args, cursor: first.cursor })).events.length, 0);
  await assert.rejects(() => reportProgress(f.reporting, { checkpoint: "completed", message: "claim" }), /checkpoint/);
  await reportProgress(f.reporting, { checkpoint: "testing", message: "测".repeat(1000) });
  assert.equal((await f.notifications.wait(f.args)).events[0].message.length, 240);
});

test("burst reports coalesce; terminal state takes priority and is not duplicated after restart", async t => {
  const f = await fixture(t);
  await reportProgress(f.reporting, { checkpoint: "inspection_done", message: "checked" });
  await reportProgress(f.reporting, { checkpoint: "testing", message: "testing" });
  assert.equal((await f.notifications.wait(f.args)).events[0].checkpoint, "testing");
  await reportProgress(f.reporting, { checkpoint: "implementation_done", message: "done" });
  await f.store.updateJob(f.job.id, { status: "completed", phase: "ready_for_acceptance" });
  const finished = await f.notifications.wait(f.args);
  assert.equal(finished.events.length, 1);
  assert.equal(finished.events[0].type, "terminal");
  const restarted = new JobNotifications(f.store);
  assert.equal((await restarted.wait({ ...f.args, cursor: 0 })).events.length, 0);
  await assert.rejects(() => reportProgress(f.reporting, { checkpoint: "testing", message: "late" }), /closed/);
});

test("wait is bounded, cancellable and terminal mode still returns attention", async t => {
  const f = await fixture(t);
  const start = Date.now();
  const timeout = await f.notifications.wait({ ...f.args, timeout_ms: 35 });
  assert.equal(timeout.timed_out, true);
  assert.ok(Date.now() - start < 1500);
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.notifications.wait({ ...f.args, signal: controller.signal })).cancelled, true);
  await reportProgress(f.reporting, { checkpoint: "blocked", message: "need a decision" });
  const attention = await f.notifications.wait({ ...f.args, until: "terminal" });
  assert.equal(attention.events[0].type, "attention");
});

test("a wait observes external completion and supports a batch without job/process promises", async t => {
  const f = await fixture(t);
  await f.store.createJob({ id: "job-2", project_dir: f.project, type: "agy_review", status: "completed", phase: "completed" });
  const batch = await f.notifications.wait({ project_dir: f.project, job_ids: ["job-1", "job-2"], timeout_ms: 0 });
  assert.equal(batch.events[0].role, "reviewer");
  const waiting = f.notifications.wait({ ...f.args, until: "terminal", timeout_ms: 2000 });
  await new Promise(resolve => setTimeout(resolve, 40));
  await f.store.updateJob(f.job.id, { status: "failed", phase: "failed", error: "CODEX_AUTH_REQUIRED: sign in\nprivate stack tail" });
  const failed = await waiting;
  assert.equal(failed.events[0].status, "failed");
  assert.doesNotMatch(JSON.stringify(failed), /private stack tail/);
});

test("same consumer is shared across Hook and wait, while independent consumers receive their own event", async t => {
  const f = await fixture(t);
  await f.notifications.register(f.job.id, "test-chat");
  await reportProgress(f.reporting, { checkpoint: "testing", message: "running tests" });
  const hook = await handleNotificationHook({ hook_event_name: "PostToolUse", session_id: "host-chat", tool_name: "mcp__agent_orch__stage_work", tool_input: { project_dir: f.project, consumer_id: "test-chat" }, tool_response: { structuredContent: { job: { id: f.job.id }, notification: { consumer_id: "test-chat" } } } }, { timeoutMs: 0 });
  assert.match(hook.hookSpecificOutput.additionalContext, /running tests/);
  assert.equal((await f.notifications.wait(f.args)).events.length, 0);
  assert.equal((await f.notifications.wait({ ...f.args, consumer_id: "another-chat" })).events.length, 1);
  assert.equal(await handleNotificationHook({ hook_event_name: "UserPromptSubmit", cwd: f.project, session_id: "host-chat" }, { timeoutMs: 0 }), null);
});

test("concurrent consumers using one ledger cannot both claim the same event", async t => {
  const f = await fixture(t);
  await reportProgress(f.reporting, { checkpoint: "testing", message: "once" });
  const results = await Promise.all([f.notifications.wait(f.args), new JobNotifications(f.store).wait(f.args)]);
  assert.equal(results.reduce((n, result) => n + result.events.length, 0), 1);
});

test("project boundaries, malformed cursor and path traversal are rejected", async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.notifications.wait({ ...f.args, project_dir: path.dirname(f.project) }), /requested project/);
  await assert.rejects(() => f.notifications.wait({ ...f.args, job_id: "../job-1" }), /job ids/);
  await assert.rejects(() => f.notifications.wait({ ...f.args, job_ids: ["job-1"] }), /not both/);
  await assert.rejects(() => f.notifications.wait({ ...f.args, cursor: 99 }), /ahead/);
  await assert.rejects(() => f.notifications.wait({ ...f.args, timeout_ms: 60001 }), /timeout_ms/);
});

test("live supervisor and live external worker are distinguished from interruption", async t => {
  const f = await fixture(t);
  assert.equal(compactJob(f.job).runtime_state, "managed_in_process");
  await f.store.updateJob(f.job.id, { created_at: "2020-01-01T00:00:00Z", supervisor_pid: 99999999, process_pid: process.pid });
  assert.equal(compactJob(await f.store.getJob(f.job.id)).runtime_state, "external_process_alive");
  await f.store.updateJob(f.job.id, { process_pid: 99999999 });
  const interrupted = await f.notifications.wait(f.args);
  assert.equal(interrupted.events[0].runtime_state, "interrupted");
  assert.equal((await f.notifications.wait(f.args)).events.length, 0);
});

test("summary queries omit transcript, command output and paths; explicit evidence remains accessible", async t => {
  const f = await fixture(t);
  const evidencePath = path.join(f.store.jobDir(f.job.id), "evidence.json");
  await fs.writeFile(evidencePath, JSON.stringify({ status: "ready_for_acceptance", verification: { configured: true, passed: true, results: [{ exit_code: 0, output_summary: "x".repeat(20000) }] }, attempts: [{ result_summary: "y".repeat(20000) }], changes: { changed_files: ["feature.txt"], patch_digest: "digest", forbidden_changes: [], unauthorized_changes: [] } }));
  await f.store.updateJob(f.job.id, { status: "completed", evidence_path: evidencePath, forbidden_paths: ["PRIVATE_PATH"] });
  const orchestrator = new WorkerOrchestrator(f.store);
  const status = await orchestrator.status(f.job.id, { detail: "summary" });
  assert.ok(Buffer.byteLength(JSON.stringify(status)) < 300);
  assert.equal(Object.hasOwn(status, "progress"), false);
  const summary = await orchestrator.result(f.job.id, { detail: "summary" });
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 1200);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_PATH|xxxxxxxx/);
  assert.equal((await orchestrator.result(f.job.id, { detail: "verification" })).evidence.results[0].output_summary.length, 20000);
  assert.equal((await orchestrator.result(f.job.id)).evidence.attempts[0].result_summary.length, 20000);
});

test("bound reporter works over MCP and CLI but exposes no coordinator tools", async t => {
  const f = await fixture(t);
  const helper = path.join(plugin, "scripts", "report-progress.mjs");
  const client = new Client({ name: "report-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [helper, "--mcp", f.reporting] }));
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["report_progress"]);
    const result = await client.callTool({ name: "report_progress", arguments: { checkpoint: "inspection_done", message: "MCP report" } });
    assert.equal(result.structuredContent.accepted, true);
    assert.equal((await client.callTool({ name: "stage-accept", arguments: {} })).isError, true);
  } finally { await client.close(); }
  execFileSync(process.execPath, [helper, f.reporting, "testing", "CLI report"], { encoding: "utf8" });
  assert.equal((await f.notifications.wait(f.args)).events[0].message, "CLI report");
});

test("bundled hook command actually reads stdin, delivers once and is silent after consumption", async t => {
  const f = await fixture(t);
  await f.notifications.register(f.job.id);
  await reportProgress(f.reporting, { checkpoint: "testing", message: "bundled command works" });
  const config = JSON.parse(await fs.readFile(path.join(plugin, "hooks", "hooks.json"), "utf8"));
  const command = config.hooks.PostToolUse[0].hooks[0].command;
  const script = command.match(/^node -e "(.*)"$/)[1];
  const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { project_dir: f.project }, tool_response: { structuredContent: {} } });
  const output = execFileSync(process.execPath, ["-e", script], { input, encoding: "utf8", env: { ...process.env, PLUGIN_ROOT: plugin } });
  assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /bundled command works/);
  assert.equal((await f.notifications.wait({ ...f.args, consumer_id: "default" })).events.length, 0);
});

test("corrupt consumer ledgers fail closed instead of replaying all old reports", async t => {
  const f = await fixture(t);
  const file = f.notifications.consumerFile("test-chat");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "not json");
  await assert.rejects(() => f.notifications.wait(f.args), SyntaxError);
});
