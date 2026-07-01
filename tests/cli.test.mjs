import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const pluginRoot = path.resolve(here, "..");
const cli = path.join(pluginRoot, "scripts", "agent-orch.mjs");
const fakeCc = path.join(here, "fixtures", "fake-cc.mjs");
const fakeAgy = path.join(here, "fixtures", "fake-agy.mjs");

function run(args, cwd = pluginRoot) {
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
  return project;
}

test("CLI initializes a project and runs a CC implementation to apply", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root);

  const init = run(["init", "-ProjectDir", project, "-ExistingProject"]);
  assert.equal(init.ok, true);
  assert.equal(init.mode, "cli");

  const configPath = path.join(project, ".agent-orchestrator", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.cli.claude = process.execPath;
  config.cli.agy = process.execPath;
  config.cli.claude_prefix_args = [fakeCc];
  config.cli.agy_prefix_args = [fakeAgy];
  config.execution.cc_timeout_seconds = 20;
  config.execution.max_cc_repair_rounds = 2;
  config.verification.commands = ["node verify.cjs"];
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const health = run(["health", "-ProjectDir", project]);
  assert.equal(health.ok, true);
  assert.equal(health.mcp_enabled, false);

  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(contractPath, `${JSON.stringify({
    task_id: "feature",
    goal: "Create feature.txt containing good",
    plan: "Implement the fixture and satisfy verification",
    complexity: "low",
  }, null, 2)}\n`);
  const executed = run(["cc-exec", "-ProjectDir", project, "-Contract", contractPath]);
  assert.equal(executed.job.status, "completed", executed.job.error);
  assert.equal(executed.evidence.verification.passed, true);
  assert.equal(await fs.stat(path.join(project, "feature.txt")).catch(() => null), null);

  const applied = run(["apply", "-ProjectDir", project, "-JobId", executed.job.id]);
  assert.equal(applied.applied, true);
  assert.equal(await fs.readFile(path.join(project, "feature.txt"), "utf8"), "good");
});
