import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateProjectConfig } from "../scripts/lib/config.mjs";
import { resolveStageRoutes } from "../scripts/lib/provider-registry.mjs";
import { StageRuntime } from "../scripts/lib/stage-runtime.mjs";
import { StateStore } from "../scripts/lib/state.mjs";

test("v1 migration preserves custom models and creates stage routes", () => {
  const migrated = migrateProjectConfig({
    version: 1,
    mcp: { enabled: true },
    routing: { executor_priority: ["agy", "cc"] },
    models: {
      codex: { planner: "custom-planner" },
      cc: { low: "custom-cc-low", medium: "custom-cc-mid", high: "custom-cc-high" },
      agy_write: { low: "custom-agy-low", medium: "custom-agy-mid", high: "custom-agy-high" },
    },
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.stages.plan.routes.high[0].model, "custom-planner");
  assert.equal(migrated.stages.work.routes.low[0].provider, "agy_write");
  assert.equal(migrated.stages.work.routes.low[0].model, "custom-agy-low");
  assert.equal(migrated.stages.work.routes.low[1].model, "custom-cc-low");
});

test("generated Sol planner routes migrate to an MCP-capable Codex model", () => {
  const migrated = migrateProjectConfig({
    version: 2,
    models: {
      codex: {
        planner: "gpt-5.6-sol",
        accepter: "gpt-5.6-sol",
      },
    },
    stages: {
      plan: {
        routes: {
          low: [{ provider: "codex", model: "gpt-5.6-sol", invocation: "in_session" }],
          medium: [{ provider: "codex", model: "gpt-5.6-sol", invocation: "in_session" }],
          high: [{ provider: "codex", model: "gpt-5.6-sol", invocation: "in_session" }],
        },
      },
    },
  });
  assert.equal(migrated.models.codex.planner, "gpt-5.6-terra");
  assert.equal(migrated.models.codex.accepter, "gpt-5.6-terra");
  assert.equal(migrated.stages.plan.routes.high[0].model, "gpt-5.6-terra");
  assert.deepEqual(migrated.migration.codex_mcp_model_from, ["gpt-5.6-sol"]);
  assert.equal(migrated.migration.codex_mcp_model_to, "gpt-5.6-terra");
});

test("resolveStageRoutes rejects unsupported provider-stage combinations", () => {
  assert.throws(
    () => resolveStageRoutes({ stages: { review: { routes: { medium: [{ provider: "cc" }] } } } }, "review", "medium"),
    /does not support stage review/,
  );
});

test("plan execution identity is immutable", async (t) => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-stage-runtime-"));
  t.after(() => fs.rm(projectDir, { recursive: true, force: true }));
  const store = new StateStore(path.join(projectDir, ".agent-orchestrator", "state"), {
    jobsRoot: path.join(projectDir, ".agent-orchestrator", "runs"),
    orchestratorRoot: path.join(projectDir, ".agent-orchestrator"),
  });
  await store.init();
  const runtime = new StageRuntime(store, projectDir);
  await runtime.init();
  await runtime.savePlanIdentity("task", {
    provider: "codex",
    model: "gpt-test",
    invocation: "in_session",
    session_id: "session-1",
    contract_id: "contract",
    contract_digest: "digest",
  });
  await assert.rejects(
    runtime.savePlanIdentity("task", {
      provider: "codex",
      model: "different-model",
      invocation: "in_session",
      session_id: "session-1",
      contract_id: "contract",
      contract_digest: "digest",
    }),
    /immutable/,
  );
});

test("StageRun remains running until its linked job is terminal", async (t) => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-stage-sync-"));
  t.after(() => fs.rm(projectDir, { recursive: true, force: true }));
  const store = new StateStore(path.join(projectDir, ".agent-orchestrator", "state"), {
    jobsRoot: path.join(projectDir, ".agent-orchestrator", "runs"),
    orchestratorRoot: path.join(projectDir, ".agent-orchestrator"),
  });
  await store.init();
  const runtime = new StageRuntime(store, projectDir);
  const job = await store.createJob({ id: "job-1", project_dir: projectDir, task_id: "task", status: "running", phase: "executing" });
  const stage = await runtime.create("work", { task_id: "task", job_id: job.id });
  assert.equal((await runtime.syncWithJob(stage.stage_run_id)).status, "running");
  await store.updateJob(job.id, { status: "completed", phase: "ready_for_acceptance" });
  assert.equal((await runtime.syncWithJob(stage.stage_run_id)).status, "completed");
});
