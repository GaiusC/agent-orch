// The only model mapping used by the runtime.  Logical keys are stable API
// contracts; display labels are never passed to a provider CLI.
export const MODEL_REGISTRY = Object.freeze({
  "cc.exec.low": { provider: "cc", role: "executor", tier: "low", display_name: "DeepSeek V4 Flash", canonical_id: "deepseek-v4-flash" },
  "cc.exec.mid": { provider: "cc", role: "executor", tier: "mid", display_name: "DeepSeek V4 Flash", canonical_id: "deepseek-v4-flash" },
  "cc.exec.high": { provider: "cc", role: "executor", tier: "high", display_name: "DeepSeek V4 Pro", canonical_id: "deepseek-v4-pro" },
  "agy.review.low": { provider: "agy", role: "reviewer", tier: "low", display_name: "Gemini 3.5 Flash", canonical_id: "gemini-3.5-flash" },
  "agy.review.mid": { provider: "agy", role: "reviewer", tier: "mid", display_name: "Gemini 3.5 Flash", canonical_id: "gemini-3.5-flash" },
  "agy.review.high": { provider: "agy", role: "reviewer", tier: "high", display_name: "Gemini 3.1 Pro", canonical_id: "gemini-3.1-pro" },
  "agy.investigate.low": { provider: "agy", role: "investigator", tier: "low", display_name: "Gemini 3.5 Flash", canonical_id: "gemini-3.5-flash" },
  "fallback.agy_exec": { provider: "anthropic", role: "executor", tier: "fallback", display_name: "Claude Sonnet 4.6 (Thinking)", canonical_id: "Claude Sonnet 4.6 (Thinking)" },
  "fallback.planner": { provider: "anthropic", role: "planner", tier: "fallback", display_name: "Claude Opus 4.6 (Thinking)", canonical_id: "Claude Opus 4.6 (Thinking)" },
  "planner.primary": { provider: "codex", role: "planner", tier: "high", display_name: "GPT-5.6 Sol", canonical_id: "gpt-5.6-sol" },
});

const TIERS = new Set(["low", "mid", "high"]);
export function normalizeTier(value) {
  const tier = String(value || "").toLowerCase();
  if (tier === "medium") return "mid";
  if (!TIERS.has(tier)) throw new Error(`Unknown complexity tier: ${value}`);
  return tier;
}

export function resolveModel(logicalKey, config = {}) {
  const entry = MODEL_REGISTRY[logicalKey];
  if (!entry) throw new Error(`Unknown model registry key: ${logicalKey}`);
  const configured = config.model_registry?.[logicalKey]?.canonical_id;
  return { logical_key: logicalKey, ...entry, canonical_id: configured || entry.canonical_id };
}

export function ccExecutorModel(complexity, config) {
  return resolveModel(`cc.exec.${normalizeTier(complexity)}`, config);
}

export function reviewerModel(complexity, config) {
  return resolveModel(`agy.review.${normalizeTier(complexity)}`, config);
}

export function investigatorPrimary(config) { return resolveModel("agy.investigate.low", config); }
export function investigatorFallback(config) { return resolveModel("cc.exec.low", config); }
export function agyExecutorFallback(config) { return resolveModel("fallback.agy_exec", config); }
export function plannerFallback(config) { return resolveModel("fallback.planner", config); }
