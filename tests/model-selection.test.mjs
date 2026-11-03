import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyModelSelection, discoverModelCatalog, normalizeModelSelection, normalizeCatalog, parseAgyModels, promptModelSelection, validateCatalogSelection } from "../scripts/lib/model-selection.mjs";
import { loadProjectConfig } from "../scripts/lib/config.mjs";
import { resolveStageRoutes } from "../scripts/lib/provider-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routes = {
  plan: { provider: "codex", model: "host-chosen-now" },
  work: [{ provider: "codex_worker", model: "worker-chosen-now", reasoning_effort: "xhigh", service_tier: "fast" }],
  review: { provider: "agy", model: "review-chosen-now" },
};
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-orch-model-selection-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const catalogFile = path.join(dir, "catalog.json");
  const routesFile = path.join(dir, "routes.json");
  await fs.writeFile(catalogFile, JSON.stringify({ codex: ["host-chosen-now", "worker-chosen-now"], cc: [], agy: ["review-chosen-now"] }));
  await fs.writeFile(routesFile, JSON.stringify(routes));
  const run = (...args) => spawnSync(process.execPath, [path.join(root, "scripts", "agent-orch.mjs"), ...args, "--ProjectDir", dir, "--ModelCatalog", catalogFile], { encoding: "utf8", timeout: 15000 });
  return { dir, catalogFile, routesFile, run };
}

test("non-interactive init asks for model selection with no project side effects, including on repeat init", async t => {
  const { dir, run, routesFile } = await fixture(t);
  let result = run("init");
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).selection_required, true);
  await assert.rejects(fs.stat(path.join(dir, ".agent-orchestrator")), { code: "ENOENT" });
  assert.equal(run("init", "--RoutesFile", routesFile).status, 0);
  const before = await fs.readFile(path.join(dir, ".agent-orchestrator", "config.json"), "utf8");
  result = run("init");
  assert.equal(result.status, 2);
  assert.equal(await fs.readFile(path.join(dir, ".agent-orchestrator", "config.json"), "utf8"), before);
});

test("explicit initialization and resume never inject fixed model names or rewrite selected models", async t => {
  const { dir, run, routesFile } = await fixture(t);
  const initialized = run("init", "--HostProvider", "codex", "--RoutesFile", routesFile);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(run("resume").status, 0);
  const config = await loadProjectConfig(dir);
  const text = JSON.stringify(config);
  assert.doesNotMatch(text, /gpt-5\.|deepseek|Gemini|Claude Sonnet|Claude Opus/);
  assert.equal(config.models.cc.low, null);
  assert.deepEqual(resolveStageRoutes(config, "work", "low")[0], { ...routes.work[0], invocation: "cli" });
  assert.equal(resolveStageRoutes(config, "accept", "high")[0].model, routes.plan.model);
});

test("invalid or partial routes fail before writing project files; resume cannot bypass selection", async t => {
  const { dir, run, routesFile } = await fixture(t);
  assert.notEqual(run("resume").status, 0);
  assert.notEqual(run("init", "--UseExistingRoutes").status, 0);
  await fs.writeFile(routesFile, JSON.stringify({ ...routes, work: [{ provider: "cc", model: null }] }));
  assert.notEqual(run("init", "--RoutesFile", routesFile).status, 0);
  await assert.rejects(fs.stat(path.join(dir, ".agent-orchestrator")), { code: "ENOENT" });
});

test("per-tier overrides and arbitrary future model ids survive normalization", () => {
  const stages = normalizeModelSelection(routes);
  stages.work.routes.high[0].model = "future-worker-model";
  const config = applyModelSelection({ verification: { commands: ["node verify.cjs"] } }, { stages });
  assert.equal(config.stages.work.routes.low[0].model, "worker-chosen-now");
  assert.equal(config.stages.work.routes.high[0].model, "future-worker-model");
  assert.deepEqual(config.verification.commands, ["node verify.cjs"]);
  assert.throws(() => normalizeModelSelection({ ...routes, accept: { provider: "codex", model: "other" } }), /Accept must inherit/);
  assert.throws(() => normalizeModelSelection({ ...routes, work: [{ ...routes.work[0], reasoning_effort: "magic" }] }), /reasoning_effort/);
  assert.throws(() => normalizeModelSelection({ ...routes, work: [{ ...routes.work[0], service_tier: 'fast"\ninjected=true' }] }), /service_tier/);
});

test("reselection retains root Worker defaults while explicit null selects CLI inheritance", () => {
  const config = applyModelSelection({ codex_worker: { reasoning_effort: "high", service_tier: "fast" } }, {
    ...routes, work: [{ provider: "codex_worker", model: "worker" }],
  });
  assert.deepEqual(config.codex_worker, { reasoning_effort: "high", service_tier: "fast" });
  assert.equal(Object.hasOwn(config.stages.work.routes.low[0], "reasoning_effort"), false);
  const explicit = normalizeModelSelection({ ...routes, work: [{ provider: "codex_worker", model: "worker", reasoning_effort: null, service_tier: null }] });
  assert.equal(explicit.work.routes.low[0].reasoning_effort, null);
});

test("model-specific capabilities are checked when advertised, including Fast priority alias", () => {
  const providers = normalizeCatalog({ codex: [{ id: "worker-chosen-now", reasoning_efforts: ["xhigh"], service_tiers: ["priority"] }] });
  const stages = normalizeModelSelection(routes);
  validateCatalogSelection(stages, { providers });
  stages.work.routes.low[0].reasoning_effort = "low";
  assert.throws(() => validateCatalogSelection(stages, { providers }), /does not advertise/);
});

test("discovery uses local model ids and capability metadata, with an honest cache provenance", async t => {
  const { dir } = await fixture(t);
  await fs.writeFile(path.join(dir, "models_cache.json"), JSON.stringify({ fetched_at: "fixture-date", models: [{ slug: "runtime-model", supported_reasoning_levels: [{ effort: "high" }], service_tiers: [{ id: "priority" }] }] }));
  const catalog = await discoverModelCatalog({ codexHome: dir, claudeHome: dir, queryAgy: false });
  assert.equal(catalog.providers.codex[0].id, "runtime-model");
  assert.deepEqual(catalog.providers.codex[0].reasoning_efforts, ["high"]);
  assert.match(catalog.providers.codex[0].source, /fixture-date/);
  assert.ok(catalog.warnings.some(warning => /cache/.test(warning)));
  assert.deepEqual(parseAgyModels("Fetching models...\n1. Live Reviewer (High)\n2. Other Model\n" ).map(entry => entry.id), ["Live Reviewer (High)", "Other Model"]);
  assert.deepEqual(parseAgyModels("Error: Please sign in to view available models."), []);
  const tabular = parseAgyModels("model\tname\ngemini-live-high\tGemini Live (High)\nclaude-live-medium\tClaude Live (Medium)\n");
  assert.deepEqual(tabular.map(entry => ({ id: entry.id, label: entry.label })), [
    { id: "gemini-live-high", label: "Gemini Live (High)" },
    { id: "claude-live-medium", label: "Claude Live (Medium)" },
  ]);
});

test("discovery honors configured CLI arguments and provider environment without exposing it", async t => {
  const { dir } = await fixture(t);
  const catalog = await discoverModelCatalog({ codexHome: dir, claudeHome: dir, projectDir: dir, cli: {
    agy: process.execPath,
    agy_prefix_args: ["-e", "process.stdout.write(JSON.stringify([process.env.FIXTURE_MODEL]))"],
    agy_env: { FIXTURE_MODEL: "live-provider-model", PRIVATE_FIXTURE_TOKEN: "never-return-this" },
    claude_env: { ANTHROPIC_MODEL: "configured-cc-model" },
  } });
  assert.equal(catalog.providers.agy[0].id, "live-provider-model");
  assert.ok(catalog.providers.cc.some(entry => entry.id === "configured-cc-model"));
  assert.doesNotMatch(JSON.stringify(catalog), /never-return-this|PRIVATE_FIXTURE_TOKEN/);
});

test("wizard selects stage-wide routes with independent Worker controls and explicit Accept confirmation", async () => {
  const answers = ["1", "3", "2", "2", "2", "n", "1", "n", "y"];
  const output = [];
  const providers = normalizeCatalog({ codex: [{ id: "host", reasoning_efforts: ["high"], service_tiers: ["priority"] }, { id: "worker", reasoning_efforts: ["high"], service_tiers: ["priority"] }], agy: ["review"] });
  const selection = await promptModelSelection({ catalog: { providers, warnings: [] }, ask: async () => { assert.ok(answers.length); return answers.shift(); }, write: text => output.push(text) });
  assert.equal(selection.stages.work.routes.low[0].model, "worker");
  assert.equal(selection.stages.work.routes.high[0].reasoning_effort, "high");
  assert.equal(selection.stages.work.routes.high[0].service_tier, "fast");
  assert.equal(answers.length, 0);
  assert.ok(output.join("").includes("Accept inherits"));
});

test("wizard supports a tier override and cancellation before persistence", async () => {
  const providers = normalizeCatalog({ codex: ["host"], cc: ["base-worker", "high-worker"], agy: ["review"] });
  const answers = ["1", "1", "1", "n", "1", "y", "n", "n", "n", "n", "n", "y", "1", "2", "n", "n", "n", "n", "y"];
  const selection = await promptModelSelection({ catalog: { providers, warnings: [] }, ask: async () => { assert.ok(answers.length); return answers.shift(); }, write: () => {} });
  assert.equal(selection.stages.work.routes.low[0].model, "base-worker");
  assert.equal(selection.stages.work.routes.high[0].model, "high-worker");
  assert.equal(answers.length, 0);
  const cancelled = ["1", "1", "1", "n", "1", "n", "n"];
  await assert.rejects(() => promptModelSelection({ catalog: { providers, warnings: [] }, ask: async () => { assert.ok(cancelled.length); return cancelled.shift(); }, write: () => {} }), /cancelled/);
});

test("unselected project template contains no fixed model names and cannot execute stages", async () => {
  const template = JSON.parse(await fs.readFile(path.join(root, "templates", "project-config.json"), "utf8"));
  assert.doesNotMatch(JSON.stringify(template), /gpt-|Gemini|deepseek|Claude Sonnet|Claude Opus/);
  assert.throws(() => resolveStageRoutes(template, "work"), /Model selection required/);
});
