import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeStageRoute } from "./provider-registry.mjs";
import { readJson } from "./utils.mjs";
import { effectiveProviderEnvironment } from "./runtime-env.mjs";

const execFileAsync = promisify(execFile);
export const TIERS = ["low", "medium", "high"];
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function normalizeWorkerOptions(options = {}) {
  const reasoning_effort = options.reasoning_effort ?? null;
  const service_tier = options.service_tier ?? null;
  if (reasoning_effort !== null && !REASONING_EFFORTS.includes(reasoning_effort)) {
    throw new Error(`Unsupported reasoning_effort: ${reasoning_effort}`);
  }
  if (service_tier !== null && (typeof service_tier !== "string" || !/^[a-z][a-z0-9_-]*$/.test(service_tier))) {
    throw new Error("service_tier must be a non-empty tier identifier or null (inherit CLI setting)");
  }
  return { reasoning_effort, service_tier };
}

function explicitRoute(value, stage) {
  const route = normalizeStageRoute(value, stage);
  if (typeof route.model !== "string" || !route.model.trim() || /[\r\n\0]/.test(route.model)) {
    throw new Error(`Model selection required for ${stage}/${route.provider}`);
  }
  route.model = route.model.trim();
  if (route.invocation !== (stage === "plan" ? "in_session" : "cli")) throw new Error(`Invalid ${stage} invocation`);
  if (route.provider === "codex_worker") normalizeWorkerOptions(value);
  return route;
}

// Accept a short stage-wide selection or full tier-specific stages. Never fill
// missing models from the compatibility registry used by legacy projects.
export function normalizeModelSelection(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Routes must be an object");
  const stages = {};
  for (const stage of ["plan", "work", "review"]) {
    const value = input.stages?.[stage] ?? input[stage];
    if (!value) throw new Error(`Missing ${stage} model selection`);
    const routes = {};
    for (const tier of TIERS) {
      const selected = value.routes ? value.routes[tier] : value;
      const chain = Array.isArray(selected) ? selected : [selected];
      if (!selected || !chain.length) throw new Error(`Missing ${stage}/${tier} routes`);
      routes[tier] = chain.map(entry => explicitRoute(entry, stage));
      if (stage !== "work" && routes[tier].length !== 1) throw new Error(`${stage} must have exactly one route`);
      if (stage === "plan" && routes[tier][0].invocation !== "in_session") throw new Error("Plan must use the host in_session invocation");
    }
    const default_complexity = value.default_complexity || (stage === "plan" ? "high" : "medium");
    if (!TIERS.includes(default_complexity)) throw new Error(`Invalid ${stage}.default_complexity`);
    stages[stage] = { default_complexity, routes };
  }
  const accept = input.stages?.accept ?? input.accept;
  if (accept && (accept.inherit_from !== "plan" || accept.routes)) throw new Error("Accept must inherit the immutable Plan identity");
  stages.accept = { inherit_from: "plan" };
  return stages;
}

export function applyModelSelection(config, input) {
  const stages = normalizeModelSelection(input);
  const next = structuredClone(config);
  next.version = 2;
  next.stages = stages;
  next.model_selection = { complete: true, selected_at: new Date().toISOString() };
  // Explicit nulls prevent DEFAULT_CONFIG's legacy models from leaking in via deepMerge.
  next.models = {
    codex: { planner: stages.plan.routes.high[0].model, accepter: stages.plan.routes.high[0].model, reasoning_effort: null },
    cc: {}, agy: {}, agy_write: {}, codex_worker: {},
  };
  for (const tier of TIERS) {
    for (const provider of ["cc", "agy", "agy_write", "codex_worker"]) {
      const stage = provider === "agy" ? "review" : "work";
      next.models[provider][tier] = stages[stage].routes[tier].find(route => route.provider === provider)?.model ?? null;
    }
  }
  next.codex_worker = normalizeWorkerOptions(config.codex_worker);
  return next;
}

export function validateCatalogSelection(stages, catalog) {
  for (const tier of TIERS) {
    for (const route of stages.work.routes[tier]) {
      if (route.provider !== "codex_worker") continue;
      const entry = catalog.providers.codex.find(model => model.id === route.model);
      if (!entry) continue; // Exact custom ids are allowed; provider remains authoritative.
      if (route.reasoning_effort && entry.reasoning_efforts.length && !entry.reasoning_efforts.includes(route.reasoning_effort)) {
        throw new Error(`Model ${route.model} does not advertise reasoning_effort=${route.reasoning_effort}`);
      }
      const serviceTier = route.service_tier === "fast" ? "priority" : route.service_tier;
      if (serviceTier && entry.service_tiers.length && !entry.service_tiers.includes(serviceTier) && !entry.service_tiers.includes(route.service_tier)) {
        throw new Error(`Model ${route.model} does not advertise service_tier=${route.service_tier}`);
      }
    }
  }
}

function modelEntry(value, source) {
  const raw = typeof value === "string" ? { id: value } : value;
  const id = raw?.id ?? raw?.slug ?? raw?.model;
  if (typeof id !== "string" || !id.trim()) throw new Error("Catalog entries require a model id");
  return {
    id: id.trim(), label: raw.label || raw.display_name || id,
    reasoning_efforts: raw.reasoning_efforts ?? raw.supported_reasoning_levels?.map(level => level.effort) ?? [],
    service_tiers: raw.service_tiers?.map(tier => typeof tier === "string" ? tier : tier.id) ?? [],
    source,
  };
}

export function normalizeCatalog(input, source = "supplied catalog") {
  const providers = input.providers ?? input;
  return Object.fromEntries(["codex", "cc", "agy"].map(provider => {
    const entries = providers[provider] ?? [];
    if (!Array.isArray(entries)) throw new Error(`Catalog ${provider} must be an array`);
    return [provider, entries.map(entry => modelEntry(entry, source))];
  }));
}

export function parseAgyModels(stdout) {
  const text = String(stdout).replace(/\x1b\[[0-9;]*m/g, "");
  try {
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : parsed.models || []).map(entry => modelEntry(entry, "agy models"));
  } catch {}
  // Only recognize explicit list/table rows; ignore banners, quota and auth output.
  return text.split(/\r?\n/).flatMap(line => {
    const columns = line.trim().match(/^([a-z0-9][a-z0-9._:/-]*)\t+(.+)$/i);
    if (columns && !/^(model|name|id)$/i.test(columns[1])) {
      return [modelEntry({ id: columns[1], label: columns[2].trim() }, "agy models")];
    }
    const match = line.match(/^\s*(?:\d+[.)]|[-*•]|[│|])\s+(.+?)\s*$/);
    if (!match) return [];
    const id = match[1].split(/\s*[│|]\s*|\s{2,}/)[0].trim();
    if (!id || /^(model|name|id)$/i.test(id)) return [];
    return [modelEntry(id, "agy models")];
  });
}

export async function discoverModelCatalog({ catalogFile, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), agy, cli = {}, projectDir, queryAgy = true } = {}) {
  if (catalogFile) return { providers: normalizeCatalog(await readJson(catalogFile), path.resolve(catalogFile)), warnings: [], fetched_at: new Date().toISOString() };
  const providers = { codex: [], cc: [], agy: [] };
  const warnings = [];
  await Promise.all([
    (async () => {
      try {
        const cache = await readJson(path.join(codexHome, "models_cache.json"));
        providers.codex = (cache.models || []).filter(model => model.visibility !== "hide").map(model => modelEntry(model, `Codex cache (${cache.fetched_at || "date unknown"})`));
        warnings.push("Codex candidates come from a local cache; availability and capabilities may have changed.");
      } catch { warnings.push("Codex model cache unavailable; supply a catalog or enter an exact model id."); }
    })(),
    (async () => {
      const settings = await readJson(path.join(claudeHome, "settings.json")).catch(() => ({}));
      const env = { ...(settings.env || {}), ...process.env, ...(cli.claude_env || {}) };
      const ids = [settings.model, ...Object.entries(env).filter(([key]) => /^ANTHROPIC_(?:MODEL|DEFAULT_.*_MODEL)$/.test(key)).map(([, value]) => value)].filter(Boolean);
      providers.cc = [...new Set(ids)].map(id => modelEntry(id, "Claude configured model (not live availability)"));
      if (!providers.cc.length) warnings.push("CC has no discovered configured models; supply a catalog or enter an exact model id.");
    })(),
    (async () => {
      if (!queryAgy) return;
      try {
        const env = projectDir ? await effectiveProviderEnvironment(projectDir, cli.agy_env) : (cli.agy_env || {});
        const command = agy || process.env.AGENT_ORCH_AGY_BIN || process.env.EAO_AGY_BIN || cli.agy || "agy";
        const { stdout } = await execFileAsync(command, [...(cli.agy_prefix_args || []), "models"], { timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } });
        if (/please sign in|not logged|authentication required/i.test(stdout)) throw new Error("auth");
        providers.agy = parseAgyModels(stdout);
      } catch {}
      if (!providers.agy.length) warnings.push("AGY model listing unavailable or unrecognized; authenticate in your working shell, supply a catalog, or enter an exact model id. No fallback model was chosen.");
    })(),
  ]);
  return { providers, warnings, fetched_at: new Date().toISOString() };
}

export function selectionRequest(catalog) {
  return {
    ok: false, selection_required: true, catalog,
    stages: ["plan", "work (ordered provider/model chain)", "review", "accept (inherits Plan)"],
    complexity: "Select stage-wide models first, optionally override low/medium/high.",
    next: "Ask the user to select routes, then run init --RoutesFile <json>. No project files have been changed.",
    routes_example: { plan: { provider: "codex", model: "<host model>" }, work: [{ provider: "codex_worker", model: "<selected model>", reasoning_effort: "medium", service_tier: "fast" }], review: { provider: "agy", model: "<selected reviewer>" }, accept: { inherit_from: "plan" } },
  };
}

export async function promptModelSelection({ catalog, ask, write }) {
  const choose = async (label, entries, { custom = true } = {}) => {
    write(`\n${label}\n${entries.map((entry, i) => `  ${i + 1}. ${entry.label ?? entry.id}`).join("\n")}\n${custom ? "  Or enter an exact value.\n" : ""}`);
    while (true) {
      const answer = (await ask("> ")).trim();
      if (!answer) { write("A selection is required.\n"); continue; }
      const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
      if (entries[index]) return entries[index].id;
      if (custom && !/^\d+$/.test(answer)) return answer;
      write("Choose a listed number.\n");
    }
  };
  const chooseRoute = async (stage, provider) => {
    const key = provider === "codex_worker" ? "codex" : provider === "agy_write" ? "agy" : provider;
    const entries = catalog.providers[key];
    const model = await choose(`${stage}: ${provider} model`, entries.map(entry => ({ ...entry, label: `${entry.label} [${entry.id}; ${entry.source}]` })));
    const route = { provider, model };
    if (provider === "codex_worker") {
      const entry = entries.find(item => item.id === model);
      const effort = await choose("Worker reasoning (model-dependent; inherit uses CLI setting)", [{ id: "inherit" }, ...(entry?.reasoning_efforts.length ? entry.reasoning_efforts : REASONING_EFFORTS).map(id => ({ id }))], { custom: false });
      const speed = await choose("Worker service tier (availability depends on model/account; inherit uses CLI setting)", [{ id: "inherit" }, ...[...new Set(["fast", ...(entry?.service_tiers || [])])].map(id => ({ id }))]);
      route.reasoning_effort = effort === "inherit" ? null : effort;
      route.service_tier = speed === "inherit" ? null : speed;
    }
    return route;
  };
  const selectStage = async stage => {
    if (stage !== "work") return chooseRoute(stage, stage === "plan" ? "codex" : "agy");
    const chain = [];
    write("Work: select providers in fallback order. Only selected routes will be enabled.\n");
    do {
      const provider = await choose("Work provider", [{ id: "cc" }, { id: "agy_write" }, { id: "codex_worker" }], { custom: false });
      chain.push(await chooseRoute(stage, provider));
    } while (/^(y|yes)$/i.test((await ask("Add another fallback route? [y/N] ")).trim()));
    return chain;
  };
  for (const warning of catalog.warnings) write(`${warning}\n`);
  write("Plan must match the current host model; selecting a model here does not switch the host chat.\n");
  const selection = {};
  for (const stage of ["plan", "work", "review"]) selection[stage] = await selectStage(stage);
  const stages = normalizeModelSelection(selection);
  if (/^(y|yes)$/i.test((await ask("Override models for specific complexity tiers? [y/N] ")).trim())) {
    for (const stage of ["plan", "work", "review"]) {
      for (const tier of TIERS) {
        if (/^(y|yes)$/i.test((await ask(`Override ${stage}/${tier}? [y/N] `)).trim())) {
          const value = await selectStage(stage);
          stages[stage].routes[tier] = (Array.isArray(value) ? value : [value]).map(entry => explicitRoute(entry, stage));
        }
      }
    }
  }
  write("Accept inherits the exact Plan model/session identity.\n");
  if (!/^(y|yes)$/i.test((await ask("Use Plan identity for Accept and save these routes? [y/N] ")).trim())) throw new Error("Initialization cancelled; no project files changed");
  return { stages };
}
