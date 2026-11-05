import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computeContractDigest, persistPlannerContract } from "../scripts/lib/contracts.mjs";
import { WorkerOrchestrator } from "../scripts/lib/orchestrator.mjs";
import { StateStore } from "../scripts/lib/state.mjs";
import { StageRuntime } from "../scripts/lib/stage-runtime.mjs";
import { bindProject } from "../scripts/lib/project-identity.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const fakeCodex = path.join(here, "fixtures", "fake-codex-worker.mjs");
const fakeAgy = path.join(here, "fixtures", "fake-agy.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createProject(root) {
  const projectDir = path.join(root, "project");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "README.md"), "fixture\n");
  await fs.writeFile(
    path.join(projectDir, "verify.cjs"),
    "const fs=require('fs'); process.exit(fs.readFileSync('feature.txt','utf8') === 'good' ? 0 : 1);\n",
  );
  git(projectDir, "init");
  git(projectDir, "config", "user.name", "Agent Orch Tests");
  git(projectDir, "config", "user.email", "agent-orch@example.test");
  git(projectDir, "add", ".");
  git(projectDir, "commit", "-m", "fixture");
  await fs.mkdir(path.join(projectDir, ".agent-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".agent-orchestrator", "config.json"),
    `${JSON.stringify({
      version: 2,
      trusted: true,
      mcp: { enabled: true },
      host: { provider: "codex" },
      cli: {
        codex: process.execPath,
        codex_prefix_args: [fakeCodex],
        agy: process.execPath,
        agy_prefix_args: [fakeAgy],
        agy_env: { AGENT_ORCH_FAKE_AGY_MODE: "review-pass" },
      },
      execution: { codex_worker_timeout_seconds: 20, max_cc_repair_rounds: 0 },
      review_gate: { require_reviewer_for_implementation: false, allow_waiver: true },
      scope: { writable: ["."], forbidden: [".git/", ".env", ".env.*"] },
      verification: { commands: ["node verify.cjs"] },
    }, null, 2)}\n`,
  );
  await persistPlannerContract(projectDir, "feature", {
    contract_id: "feature-contract",
    contract_version: 1,
    repository_identity: "fixture",
    executor_subtasks: [{
      subtask_id: "impl",
      role: "executor",
      objective: "Create feature.txt containing good",
      complexity: "low",
      writable_paths: ["."],
      forbidden_paths: [".git/", ".env", ".env.*"],
      required_tests: ["node verify.cjs"],
      acceptance_criteria: ["verification passes"],
      fallback_policy: { enabled: false },
    }],
    reviewer_tasks: [{
      review_id: "review",
      role: "reviewer",
      type: "verify",
      complexity: "low",
      target_subtask_ids: ["impl"],
      required_checks: ["Inspect diff and run verification"],
      fallback_policy: { enabled: false },
    }],
  }, "planner-session");
  return projectDir;
}

async function waitFor(orchestrator, jobId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const job = await orchestrator.status(jobId);
    if (["completed", "failed", "cancelled"].includes(job.status)) return orchestrator.wait(jobId);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}

test("Codex Worker stage uses writable non-interactive execution and exact continuation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-stage-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = await createProject(root);
  const store = new StateStore(path.join(projectDir, ".agent-orchestrator", "state"), {
    jobsRoot: path.join(projectDir, ".agent-orchestrator", "runs"),
    orchestratorRoot: path.join(projectDir, ".agent-orchestrator"),
  });
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);
  const route = [{ provider: "codex_worker", model: "chosen-worker", invocation: "cli", reasoning_effort: "xhigh", service_tier: "fast" }];

  const started = await orchestrator.startStageWork({
    project_dir: projectDir,
    task_id: "feature",
    subtask_id: "impl",
  }, route);
  const finished = await waitFor(orchestrator, started.id);
  assert.equal(finished.status, "completed", finished.error);
  assert.equal(finished.provider, "codex_worker");
  assert.equal(finished.session_id, "11111111-1111-4111-8111-111111111111");
  const firstSession = await store.getSession(projectDir, "codex_worker", "feature");
  assert.ok(firstSession.workspace_path);
  assert.equal(firstSession.reasoning_effort, "xhigh");
  assert.equal(firstSession.service_tier, "fast");
  const startedJob = await store.getJob(started.id);
  assert.ok(startedJob.process_args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(startedJob.process_args.includes('service_tier="fast"'));
  await orchestrator.wait(started.id);
  const configFile = path.join(projectDir, ".agent-orchestrator", "config.json");
  const changedConfig = JSON.parse(await fs.readFile(configFile, "utf8"));
  changedConfig.codex_worker = { reasoning_effort: "low", service_tier: "other-speed" };
  await fs.writeFile(configFile, JSON.stringify(changedConfig));

  const continued = await orchestrator.startStageWork({
    project_dir: projectDir,
    task_id: "feature",
    job_id: started.id,
    feedback: "Recheck the same file and keep it good.",
  }, [], { continuation: true });
  const continuedFinished = await waitFor(orchestrator, continued.id);
  assert.equal(continuedFinished.status, "completed", continuedFinished.error);
  assert.equal(continuedFinished.provider, "codex_worker");
  assert.equal(continuedFinished.session_id, firstSession.session_id);
  const continuedSession = await store.getSession(projectDir, "codex_worker", "feature");
  assert.equal(continuedSession.workspace_path, firstSession.workspace_path);
  assert.equal(continuedSession.reasoning_effort, "xhigh");
  assert.equal(continuedSession.service_tier, "fast");
  const continuedJob = await store.getJob(continued.id);
  assert.equal(continuedJob.route_chain[0].reasoning_effort, "xhigh");
  assert.equal(continuedJob.attempts[0].service_tier, "fast");
  assert.ok(continuedJob.process_args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(continuedJob.process_args.includes('service_tier="fast"'));
  await orchestrator.wait(continued.id);

  // Older releases did not persist the original owner on continued jobs.
  // Reproduce a second continuation whose workspace still belongs to the first.
  const { owner_job_id: firstOwner, ...legacyFirst } = startedJob.workspace;
  const { owner_job_id: continuedOwner, ...legacyContinued } = continuedJob.workspace;
  assert.equal(firstOwner, started.id);
  assert.equal(continuedOwner, started.id);
  await store.updateJob(started.id, { workspace: legacyFirst });
  await store.updateJob(continued.id, { workspace: legacyContinued });
  const worktreesBefore = git(projectDir, "worktree", "list", "--porcelain");
  const resumed = await orchestrator.startStageWork({
    project_dir: projectDir,
    task_id: "feature",
    job_id: continued.id,
    feedback: "Continue the exact legacy session without allocating another workspace.",
  }, [], { continuation: true });
  const resumedFinished = await waitFor(orchestrator, resumed.id);
  assert.equal(resumedFinished.status, "completed", resumedFinished.error);
  const resumedJob = await store.getJob(resumed.id);
  assert.equal(resumedJob.workspace.path, firstSession.workspace_path);
  assert.equal(resumedJob.workspace.owner_job_id, started.id);
  assert.equal(resumedFinished.session_id, firstSession.session_id);
  assert.equal(git(projectDir, "worktree", "list", "--porcelain"), worktreesBefore);
  assert.deepEqual((await store.getJob(continued.id)).workspace, legacyContinued,
    "recover ownership in the new job without rewriting legacy evidence");
  assert.deepEqual((await store.getJob(started.id)).workspace, legacyFirst);
});

test("formal AGY review requires current-turn PASS output and preserves patch digest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-stage-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = await createProject(root);
  const store = new StateStore(path.join(projectDir, ".agent-orchestrator", "state"), {
    jobsRoot: path.join(projectDir, ".agent-orchestrator", "runs"),
    orchestratorRoot: path.join(projectDir, ".agent-orchestrator"),
  });
  await store.init();
  const orchestrator = new WorkerOrchestrator(store);
  const started = await orchestrator.startStageWork({
    project_dir: projectDir,
    task_id: "feature",
    subtask_id: "impl",
  }, [{ provider: "codex_worker", model: null, invocation: "cli" }]);
  const finished = await waitFor(orchestrator, started.id);
  assert.equal(finished.status, "completed", finished.error);

  const review = await orchestrator.startVerify({
    project_dir: projectDir,
    task_id: "feature",
    review_id: "review",
    model: "Gemini 3.5 Flash (Low)",
  });
  const reviewed = await waitFor(orchestrator, review.id);
  assert.equal(reviewed.status, "completed", reviewed.error);
  const result = await orchestrator.result(review.id);
  assert.equal(result.evidence.result_source, "stdout");
  assert.match(result.evidence.result, /VERDICT: PASS/);
  assert.equal(result.evidence.review_evidence.implementation_job_id, started.id);
});

test("legacy native Plan without repository identity can recover through fresh review without rewriting history", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-legacy-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = await createProject(root);
  const configFile = path.join(projectDir, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));
  config.review_gate = { require_reviewer_for_implementation: true, allow_waiver: false };
  await fs.writeFile(configFile, JSON.stringify(config));

  // Model a 0.8.2 Plan that already ran without this optional contract field.
  const contractFile = path.join(projectDir, ".agent-orchestrator", "contracts", "feature.json");
  const contract = JSON.parse(await fs.readFile(contractFile, "utf8"));
  delete contract.repository_identity;
  contract.contract_digest = computeContractDigest(contract);
  await fs.writeFile(contractFile, JSON.stringify(contract));
  const binding = await bindProject(projectDir);
  const store = new StateStore(path.join(projectDir, ".agent-orchestrator", "state"), {
    jobsRoot: path.join(projectDir, ".agent-orchestrator", "runs"),
    orchestratorRoot: path.join(projectDir, ".agent-orchestrator"),
  });
  await store.init();
  const runtime = new StageRuntime(store, projectDir);
  const identity = await runtime.savePlanIdentity("feature", {
    project_id: binding.project_id, coordinator_common: binding.coordinator_common,
    provider: "codex", model: "fixture-host", invocation: "in_session", session_id: "planner-session",
    contract_id: contract.contract_id, contract_digest: contract.contract_digest,
  });
  const contractBefore = await fs.readFile(contractFile);
  const planBefore = await fs.readFile(identity.file);
  const orchestrator = new WorkerOrchestrator(store);
  const work = await orchestrator.startStageWork({ project_dir: projectDir, task_id: "feature", subtask_id: "impl" },
    [{ provider: "codex_worker", model: "fixture-worker", invocation: "cli" }]);
  const finished = await waitFor(orchestrator, work.id);
  assert.equal(finished.status, "completed", finished.error);

  const first = await orchestrator.startVerify({ project_dir: projectDir, task_id: "feature", review_id: "review", model: "fixture-reviewer" });
  assert.equal((await waitFor(orchestrator, first.id)).status, "completed");
  const firstJob = await store.getJob(first.id);
  const oldEvidence = JSON.parse(await fs.readFile(firstJob.evidence_path, "utf8"));
  oldEvidence.review_evidence.repository_identity = null;
  delete oldEvidence.review_evidence.repository_provenance;
  await fs.writeFile(firstJob.evidence_path, JSON.stringify(oldEvidence));
  const oldEvidenceBefore = await fs.readFile(firstJob.evidence_path);
  const accept = () => orchestrator.accept({ project_dir: projectDir, task_id: "feature", job_id: work.id,
    accepter_provider: "codex", accepter_model: "fixture-host", session_id: "planner-session" });
  await assert.rejects(accept, /REPOSITORY_IDENTITY_REVIEW_REQUIRED/,
    "Do not repair or silently bless an old review receipt missing repository provenance");

  const second = await orchestrator.startVerify({ project_dir: projectDir, task_id: "feature", review_id: "review", model: "fixture-reviewer" });
  const reviewed = await waitFor(orchestrator, second.id);
  assert.equal(reviewed.status, "completed", reviewed.error);
  const result = await orchestrator.result(second.id);
  const reviewIdentity = result.evidence.review_evidence;
  assert.match(reviewIdentity.repository_identity, /^git-common:[a-f0-9]{64}$/);
  assert.equal(reviewIdentity.repository_provenance.source, "verified_native_plan");
  assert.equal(reviewIdentity.repository_provenance.project_id, binding.project_id);
  assert.equal(reviewIdentity.contract_digest, contract.contract_digest);

  // A copied Plan, absent binding or mismatched work ancestry must not authorize fallback.
  const originalPlan = JSON.parse(planBefore.toString());
  for (const patch of [{ project_id: "foreign-project" }, { coordinator_common: path.join(root, "foreign.git") }, { contract_digest: "foreign-contract" }]) {
    await fs.writeFile(identity.file, JSON.stringify({ ...originalPlan, ...patch }));
    await assert.rejects(accept, /REPOSITORY_IDENTITY_MISMATCH/);
  }
  await fs.rm(identity.file);
  await assert.rejects(accept, /REPOSITORY_IDENTITY_UNAVAILABLE/);
  await fs.writeFile(identity.file, planBefore);
  const workJob = await store.getJob(work.id);
  await store.updateJob(work.id, { workspace: { ...workJob.workspace, source_inventory: { ...workJob.workspace.source_inventory, common: path.join(root, "foreign.git") } } });
  await assert.rejects(accept, /REPOSITORY_IDENTITY_MISMATCH/);
  await store.updateJob(work.id, { workspace: workJob.workspace });

  const foreign = path.join(root, "foreign");
  await fs.mkdir(foreign);
  git(foreign, "init");
  await store.updateJob(work.id, { workspace: { ...workJob.workspace, path: foreign } });
  await assert.rejects(accept, /REPOSITORY_IDENTITY_MISMATCH/);
  await store.updateJob(work.id, { workspace: workJob.workspace });

  const artifact = await accept();
  assert.equal(artifact.status, "accepted");
  assert.equal(artifact.repository_identity, reviewIdentity.repository_identity);
  assert.equal(artifact.contract_digest, contract.contract_digest);
  assert.deepEqual(await fs.readFile(contractFile), contractBefore);
  assert.deepEqual(await fs.readFile(identity.file), planBefore);
  assert.deepEqual(await fs.readFile(firstJob.evidence_path), oldEvidenceBefore);

  const acceptedJob = await store.getJob(work.id);
  const acceptanceBefore = await fs.readFile(acceptedJob.acceptance_artifact_path);
  await fs.writeFile(acceptedJob.acceptance_artifact_path, JSON.stringify({ ...artifact, repository_identity: "foreign-repository" }));
  await assert.rejects(() => orchestrator.apply(work.id), /REPOSITORY_IDENTITY_MISMATCH/);
  await fs.writeFile(acceptedJob.acceptance_artifact_path, acceptanceBefore);
  assert.equal((await orchestrator.apply(work.id)).applied, true,
    "The normal apply gate must validate the runtime repository proof too");
  const closed = await orchestrator.finalize(work.id, { confirm_commit: true });
  assert.equal(closed.status, "closed");
  assert.match(closed.commit_id, /^[a-f0-9]{40}$/);
  assert.equal(await fs.stat(workJob.workspace.path).then(() => true, () => false), false);
  assert.deepEqual(await fs.readFile(contractFile), contractBefore);
  assert.deepEqual(await fs.readFile(identity.file), planBefore);
  assert.deepEqual(await fs.readFile(firstJob.evidence_path), oldEvidenceBefore);
});
