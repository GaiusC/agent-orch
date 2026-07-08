import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyAgyQuotaError } from "../scripts/lib/adapters.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const cli = path.join(path.resolve(here, ".."), "scripts", "agent-orch.mjs");
const fakeCc = path.join(here, "fixtures", "fake-cc.mjs");
const fakeAgy = path.join(here, "fixtures", "fake-agy.mjs");

function runCli(args, cwd) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 30000 }));
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createProject(root) {
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "verify.cjs"), "const fs=require('fs'); process.exit(fs.existsSync('feature.txt') && fs.readFileSync('feature.txt','utf8') === 'good' ? 0 : 1);\n");
  await fs.writeFile(path.join(project, "README.md"), "fixture\n");
  git(project, "init");
  git(project, "config", "user.name", "Agent Orch Tests");
  git(project, "config", "user.email", "agent-orch@example.test");
  git(project, "add", ".");
  git(project, "commit", "-m", "fixture");

  await fs.mkdir(path.join(project, ".agent-orchestrator"), { recursive: true });
  const config = {
    version: 1,
    trusted: true,
    routing: { auto: "agy_preferred", agy_write_fallback_to_cc_on_quota: true },
    cli: {
      claude: process.execPath,
      agy: process.execPath,
      claude_prefix_args: [fakeCc],
      agy_prefix_args: [fakeAgy],
      agy_sandbox: false,
    },
    agy: { auth_probe_required: false, enabled: true },
    execution: {
      workspace_mode: "isolated",
      max_cc_repair_rounds: 2,
      cc_timeout_seconds: 20,
      agy_timeout_seconds: 20,
      agy_write_timeout_seconds: 20,
      max_log_bytes: 1024 * 1024,
      max_result_chars: 8000,
    },
    verification: { commands: ["node verify.cjs"] },
  };
  await fs.writeFile(path.join(project, ".agent-orchestrator", "config.json"), JSON.stringify(config, null, 2));
  return project;
}

// -- Unit tests: quota error classifier --

test("classifyAgyQuotaError detects RESOURCE_EXHAUSTED", () => {
  assert.equal(classifyAgyQuotaError("", "RESOURCE_EXHAUSTED: Quota exceeded"), true);
});

test("classifyAgyQuotaError detects quota exceeded message", () => {
  assert.equal(classifyAgyQuotaError("Error: quota exceeded for your account."), true);
  assert.equal(classifyAgyQuotaError("Your quota has been reached. Try again later."), true);
});

test("classifyAgyQuotaError detects rate limit / 429", () => {
  assert.equal(classifyAgyQuotaError("429 Too Many Requests"), true);
  assert.equal(classifyAgyQuotaError("", "rate limit reached"), true);
});

test("classifyAgyQuotaError detects credit exhaustion", () => {
  assert.equal(classifyAgyQuotaError("", "credits exhausted for this billing period"), true);
  assert.equal(classifyAgyQuotaError("insufficient credits to complete this request"), true);
});

test("classifyAgyQuotaError detects billing/usage limits", () => {
  assert.equal(classifyAgyQuotaError("billing limit reached"), true);
  assert.equal(classifyAgyQuotaError("usage limit exceeded for this month"), true);
  assert.equal(classifyAgyQuotaError("", "daily usage limit"), true);
});

test("classifyAgyQuotaError detects too many requests", () => {
  assert.equal(classifyAgyQuotaError("too many requests, please try again later"), true);
});

test("classifyAgyQuotaError returns false for non-quota errors", () => {
  assert.equal(classifyAgyQuotaError("authentication required"), false);
  assert.equal(classifyAgyQuotaError("", "unauthorized"), false);
  assert.equal(classifyAgyQuotaError("permission denied"), false);
  assert.equal(classifyAgyQuotaError("access denied"), false);
  assert.equal(classifyAgyQuotaError("failed to construct executor"), false);
  assert.equal(classifyAgyQuotaError("neither PlanModel nor RequestedModel specified"), false);
  assert.equal(classifyAgyQuotaError("model output error"), false);
  assert.equal(classifyAgyQuotaError("invalid tool call error"), false);
  assert.equal(classifyAgyQuotaError("internal server error"), false);
  assert.equal(classifyAgyQuotaError("sandbox error: cannot start"), false);
  assert.equal(classifyAgyQuotaError("", ""), false);
  assert.equal(classifyAgyQuotaError("Some generic error message", ""), false);
});

test("classifyAgyQuotaError prefers non-quota classification", () => {
  // Even if "limit" appears, auth takes priority
  assert.equal(classifyAgyQuotaError("authentication failed: usage limit"), false);
});

// -- Integration: auto with quota fallback to CC --

test("auto falls back to CC on AGY quota exhaustion", async (t) => {
  const previousMode = process.env.AGENT_ORCH_FAKE_AGY_MODE;
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "quota-error";
  t.after(() => {
    if (previousMode === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_MODE;
    else process.env.AGENT_ORCH_FAKE_AGY_MODE = previousMode;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-quota-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, JSON.stringify({
    task_id: "quota-fallback",
    goal: "Create feature.txt containing good",
    plan: "Implement and verify",
    complexity: "medium",
  }, null, 2));

  const result = runCli(["auto", "-ProjectDir", project, "-Contract", contractPath]);
  // Should have fallen back to CC
  assert.equal(result.job.provider, "cc");
  assert.equal(result.job.auto_route, "cc_fallback");
  assert.equal(result.job.auto_fallback_classifier, "quota_exhaustion");
  assert.equal(result.job.status, "completed", result.job.error);
  assert.equal(result.evidence.status, "ready_for_acceptance");
  assert.equal(result.evidence.auto_route.fallback_occurred, true);
  assert.equal(result.evidence.auto_route.original_provider, "agy_write");
  assert.equal(result.evidence.auto_route.reason, "quota_exhaustion");
});

test("auto falls back to CC on AGY rate limit", async (t) => {
  const previousMode = process.env.AGENT_ORCH_FAKE_AGY_MODE;
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "rate-limit";
  t.after(() => {
    if (previousMode === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_MODE;
    else process.env.AGENT_ORCH_FAKE_AGY_MODE = previousMode;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-ratelim-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, JSON.stringify({
    task_id: "ratelimit-fallback",
    goal: "Create feature.txt containing good",
    plan: "Implement and verify",
    complexity: "high",
  }, null, 2));

  const result = runCli(["auto", "-ProjectDir", project, "-Contract", contractPath]);
  assert.equal(result.job.provider, "cc");
  assert.equal(result.job.auto_route, "cc_fallback");
  assert.equal(result.job.auto_fallback_classifier, "quota_exhaustion");
  assert.equal(result.job.status, "completed", result.job.error);
});

// -- Integration: no silent fallback for non-quota errors --

test("auto does NOT fall back for AGY auth errors", async (t) => {
  const previousMode = process.env.AGENT_ORCH_FAKE_AGY_MODE;
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "auth-error";
  t.after(() => {
    if (previousMode === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_MODE;
    else process.env.AGENT_ORCH_FAKE_AGY_MODE = previousMode;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-nofb-auth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, JSON.stringify({
    task_id: "auth-no-fallback",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "medium",
  }, null, 2));

  const result = runCli(["auto", "-ProjectDir", project, "-Contract", contractPath]);
  // Auth error should surface -- job should be failed, not fallback to CC
  assert.equal(result.job.status, "failed");
  assert.notEqual(result.job.provider, "cc");
  assert.equal(result.job.auto_route, "agy_write");
});

test("auto does NOT fall back for AGY internal errors", async (t) => {
  const previousMode = process.env.AGENT_ORCH_FAKE_AGY_MODE;
  process.env.AGENT_ORCH_FAKE_AGY_MODE = "internal-error";
  t.after(() => {
    if (previousMode === undefined) delete process.env.AGENT_ORCH_FAKE_AGY_MODE;
    else process.env.AGENT_ORCH_FAKE_AGY_MODE = previousMode;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-nofb-int-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, JSON.stringify({
    task_id: "internal-no-fallback",
    goal: "Create feature.txt containing good",
    plan: "Implement",
    complexity: "medium",
  }, null, 2));

  const result = runCli(["auto", "-ProjectDir", project, "-Contract", contractPath]);
  // Internal error should surface -- not fall back to CC
  assert.equal(result.job.status, "failed");
  assert.notEqual(result.job.provider, "cc");
});
