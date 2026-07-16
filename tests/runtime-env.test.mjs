import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureRuntimeEnvironment, effectiveProviderEnvironment, loadRuntimeEnvironment, selectRuntimeEnvironment } from "../scripts/lib/runtime-env.mjs";

test("runtime environment captures only the provider allowlist", async (t) => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-runtime-env-"));
  t.after(() => fs.rm(projectDir, { recursive: true, force: true }));
  const captured = await captureRuntimeEnvironment(projectDir, {
    HTTP_PROXY: "http://127.0.0.1:10100",
    HTTPS_PROXY: "http://127.0.0.1:10100",
    SECRET_TOKEN: "must-not-persist",
  });
  assert.deepEqual(Object.keys(captured.env).sort(), ["HTTPS_PROXY", "HTTP_PROXY"]);
  const loaded = await loadRuntimeEnvironment(projectDir);
  assert.equal(loaded.env.HTTP_PROXY, "http://127.0.0.1:10100");
  assert.equal(loaded.env.SECRET_TOKEN, undefined);
});

test("explicit agy_env overrides captured and current proxy values", async (t) => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-runtime-merge-"));
  t.after(() => fs.rm(projectDir, { recursive: true, force: true }));
  await captureRuntimeEnvironment(projectDir, { HTTP_PROXY: "http://captured:1", NO_PROXY: "localhost" });
  const effective = await effectiveProviderEnvironment(
    projectDir,
    { HTTP_PROXY: "http://explicit:2" },
    { HTTP_PROXY: "http://current:3", HTTPS_PROXY: "http://current:4" },
  );
  assert.equal(effective.HTTP_PROXY, "http://explicit:2");
  assert.equal(effective.HTTPS_PROXY, "http://current:4");
  assert.equal(effective.NO_PROXY, "localhost");
});

test("selectRuntimeEnvironment preserves Windows AGY home resolution keys", () => {
  const selected = selectRuntimeEnvironment({
    USERPROFILE: "C:\\Users\\Example",
    LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
    AGENT_ORCH_AGY_HOME: "D:\\agy-home",
  });
  assert.equal(selected.USERPROFILE, "C:\\Users\\Example");
  assert.equal(selected.AGENT_ORCH_AGY_HOME, "D:\\agy-home");
});
