import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../scripts/lib/state.mjs";

test("sessions are isolated by project, provider, and task", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new StateStore(root);
  await store.init();
  await store.setSession("C:/project-a", "cc", "task", { session_id: "one" });
  await store.setSession("C:/project-a", "agy", "task", { session_id: "two" });
  await store.setSession("C:/project-b", "cc", "task", { session_id: "three" });
  assert.equal((await store.getSession("C:/project-a", "cc", "task")).session_id, "one");
  assert.equal((await store.getSession("C:/project-a", "agy", "task")).session_id, "two");
  assert.equal((await store.getSession("C:/project-b", "cc", "task")).session_id, "three");
});
