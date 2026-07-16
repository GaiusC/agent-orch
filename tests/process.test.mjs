import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProcess } from "../scripts/lib/process.mjs";

test("process runner captures output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-process-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('ok'); process.stderr.write('warn')"],
    cwd: root,
    timeoutSeconds: 5,
    logDir: root,
    maxLogBytes: 1024,
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "warn");
});

test("process runner times out and terminates", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-timeout-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    cwd: root,
    timeoutSeconds: 1,
    logDir: root,
  });
  assert.equal(result.timed_out, true);
});

test("process runner aborts immediately on interactive OAuth output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-oauth-abort-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "console.error('Open https://accounts.google.com/o/oauth2/auth to sign in'); setTimeout(() => {}, 10000)"],
    cwd: root,
    timeoutSeconds: 20,
    logDir: root,
    abortOnOutput: ({ text }) => text.includes("accounts.google.com") ? "oauth required" : null,
  });
  assert.equal(result.aborted_by_output, "oauth required");
  assert.ok(result.duration_ms < 5000);
});
