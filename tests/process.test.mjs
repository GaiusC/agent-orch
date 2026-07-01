import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProcess } from "../scripts/lib/process.mjs";

test("process runner captures output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eao-process-"));
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eao-timeout-"));
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
