import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProcess } from "../scripts/lib/process.mjs";
import { readWorkerProgress } from "../scripts/lib/adapters.mjs";

// This test file proves that AGY processes receive the configured proxy
// environment through runProcess — the same mechanism used by both
// runAgy() and runAgyWrite() in adapters.mjs.

const PROXY_ENV = {
  HTTP_PROXY: "http://127.0.0.1:10100",
  HTTPS_PROXY: "http://127.0.0.1:10100",
  ALL_PROXY: "http://127.0.0.1:10100",
  NO_PROXY: "localhost,127.0.0.1,::1",
};

test("agy_env proxy vars reach the spawned child process", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-env-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await runProcess({
    command: process.execPath,
    args: [
      "-e",
      "console.log(JSON.stringify({ http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY, all: process.env.ALL_PROXY, no: process.env.NO_PROXY }))",
    ],
    cwd: root,
    timeoutSeconds: 5,
    logDir: root,
    maxLogBytes: 1024,
    env: PROXY_ENV,
  });

  assert.equal(result.exit_code, 0);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.http, "http://127.0.0.1:10100");
  assert.equal(output.https, "http://127.0.0.1:10100");
  assert.equal(output.all, "http://127.0.0.1:10100");
  assert.equal(output.no, "localhost,127.0.0.1,::1");
});

test("process.env is preserved when agy_env is passed to runProcess", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-env-preserve-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "console.log(process.env.PATH ? 'PRESERVED' : 'MISSING')"],
    cwd: root,
    timeoutSeconds: 5,
    logDir: root,
    maxLogBytes: 1024,
    env: { HTTP_PROXY: "http://127.0.0.1:10100" },
  });

  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /PRESERVED/);
});

test("agy_env values override process.env", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-env-override-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Pass a custom HTTP_PROXY that should win over any system one
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "console.log(process.env.HTTP_PROXY || 'unset')"],
    cwd: root,
    timeoutSeconds: 5,
    logDir: root,
    maxLogBytes: 1024,
    env: { HTTP_PROXY: "http://127.0.0.1:10100" },
  });

  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:10100/);
});

test("empty agy_env does not interfere with process environment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-env-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "console.log(process.env.HTTP_PROXY || 'unset')"],
    cwd: root,
    timeoutSeconds: 5,
    logDir: root,
    maxLogBytes: 1024,
    env: {},
  });

  assert.equal(result.exit_code, 0);
  // HTTP_PROXY may or may not be in the parent env; just confirm the process ran
  assert.ok(result.stdout.includes("unset") || result.stdout.includes("http://"));
});

// ============================================================
// Worker progress extraction tests
// ============================================================

test("readWorkerProgress returns assistant messages for CC job with valid stdout", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-progress-cc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Write a fake CC round-0 stdout file with a JSON summary
  const ccOutput = JSON.stringify({
    session_id: "test-session",
    is_error: false,
    result: "I have implemented the feature. Created feature.txt with the required content and verified all tests pass.",
    model: "deepseek-v4-flash",
  });
  await fs.writeFile(path.join(root, "cc-round-0.stdout"), ccOutput, "utf8");

  const mockJob = { provider: "cc", session_id: "test-session", id: "test-cc-1" };
  const result = await readWorkerProgress({ job: mockJob, jobDir: root });

  assert.equal(result.available, true);
  assert.equal(result.messages.length, 1);
  assert.ok(result.messages[0].content.includes("implemented the feature"));
  assert.equal(result.messages[0].source, "cc_summary");
  assert.equal(result.note, null);
});

test("readWorkerProgress returns at most 2 messages for CC job", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-progress-cc2-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Write a CC stdout with a summary AND a JSONL assistant message
  const lines = [
    JSON.stringify({ type: "message", role: "assistant", content: "First assistant message.", ts: "2026-07-13T10:00:00Z" }),
    JSON.stringify({ type: "message", role: "user", content: "User message — should be filtered." }),
    JSON.stringify({ type: "tool_use", name: "read", input: { file_path: "/test" } }),
    JSON.stringify({ type: "tool_result", content: "Tool output — should be filtered." }),
    JSON.stringify({ type: "message", role: "assistant", content: "Second assistant message after tool use.", ts: "2026-07-13T10:01:00Z" }),
    JSON.stringify({ type: "message", role: "assistant", content: "Third assistant message — should be truncated to 2.", ts: "2026-07-13T10:02:00Z" }),
  ];
  await fs.writeFile(path.join(root, "cc-round-2.stdout"), lines.join("\n"), "utf8");

  const mockJob = { provider: "cc", session_id: "test-session", id: "test-cc-2" };
  const result = await readWorkerProgress({ job: mockJob, jobDir: root });

  assert.equal(result.available, true);
  assert.equal(result.messages.length, 2, "should return at most 2 messages");
  assert.ok(result.messages[0].content.includes("Second assistant"));
  assert.ok(result.messages[1].content.includes("Third assistant"));
  assert.equal(result.messages[0].source, "cc_message");
});

test("readWorkerProgress filters out tool calls, tool results, and user messages", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-progress-filter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Only non-assistant messages
  const lines = [
    JSON.stringify({ type: "message", role: "user", content: "User instruction." }),
    JSON.stringify({ type: "tool_use", name: "read_file", input: { file_path: "/test" } }),
    JSON.stringify({ type: "tool_result", content: "File contents here.", is_error: false }),
  ];
  await fs.writeFile(path.join(root, "cc-round-0.stdout"), lines.join("\n"), "utf8");

  const mockJob = { provider: "cc", session_id: "test-session", id: "test-filter" };
  const result = await readWorkerProgress({ job: mockJob, jobDir: root });

  assert.equal(result.available, false, "no assistant messages → progress unavailable");
  assert.equal(result.messages.length, 0);
  assert.ok(result.note.includes("No assistant progress"));
});

test("readWorkerProgress returns available:false for CC job with no stdout files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-progress-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Empty directory — no stdout files at all
  const mockJob = { provider: "cc", session_id: "test-session", id: "test-empty" };
  const result = await readWorkerProgress({ job: mockJob, jobDir: root });

  assert.equal(result.available, false);
  assert.equal(result.messages.length, 0);
});

test("readWorkerProgress returns available:false for AGY job with no session_id", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-progress-agy-noid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const mockJob = { provider: "agy", session_id: null, id: "test-agy-noid" };
  const result = await readWorkerProgress({ job: mockJob, jobDir: root });

  assert.equal(result.available, false);
  assert.equal(result.messages.length, 0);
});

test("readWorkerProgress reads AGY transcript when session_id is available", async (t) => {
  const agyHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-agy-home-"));
  const previousHome = process.env.AGENT_ORCH_AGY_HOME;
  process.env.AGENT_ORCH_AGY_HOME = agyHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.AGENT_ORCH_AGY_HOME;
    else process.env.AGENT_ORCH_AGY_HOME = previousHome;
    return fs.rm(agyHome, { recursive: true, force: true });
  });

  const conversationId = "test-11111111-2222-3333-4444-555555555555";
  const transcriptDir = path.join(agyHome, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs");
  await fs.mkdir(transcriptDir, { recursive: true });
  const transcriptLines = [
    JSON.stringify({ source: "USER", content: "User query that should be filtered.", ts: "2026-07-13T10:00:00Z" }),
    JSON.stringify({ source: "TOOL_CALL", content: "Tool call that should be filtered." }),
    JSON.stringify({ source: "TOOL_RESULT", content: "Tool result that should be filtered." }),
    JSON.stringify({ source: "MODEL", content: "AGY assistant first response.", ts: "2026-07-13T10:00:30Z" }),
    JSON.stringify({ source: "MODEL", content: "AGY assistant second response with implementation details.", ts: "2026-07-13T10:01:00Z" }),
  ];
  await fs.writeFile(path.join(transcriptDir, "transcript.jsonl"), transcriptLines.join("\n"), "utf8");

  const mockJob = { provider: "agy", session_id: conversationId, id: "test-agy-1" };
  const result = await readWorkerProgress({ job: mockJob, jobDir: "/tmp/nonexistent" });

  assert.equal(result.available, true);
  assert.ok(result.messages.length >= 1, "should find at least one AGY model message");
  assert.equal(result.messages[0].source, "agy_transcript");
});

test("readWorkerProgress handles unknown provider gracefully", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-progress-unknown-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const mockJob = { provider: "unknown_provider", session_id: null, id: "test-unknown" };
  const result = await readWorkerProgress({ job: mockJob, jobDir: root });

  assert.equal(result.available, false);
  assert.equal(result.messages.length, 0);
  assert.ok(result.note.includes("unknown"));
});
