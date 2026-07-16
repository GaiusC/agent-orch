const PROVIDERS = {
  codex: {
    id: "codex",
    stages: ["plan", "accept"],
    invocation: "in_session",
    continuation: true,
    writable: false,
  },
  cc: {
    id: "cc",
    stages: ["work"],
    invocation: "cli",
    continuation: true,
    writable: true,
  },
  agy_write: {
    id: "agy_write",
    stages: ["work"],
    invocation: "cli",
    continuation: true,
    writable: true,
  },
  codex_worker: {
    id: "codex_worker",
    stages: ["work"],
    invocation: "cli",
    continuation: true,
    writable: true,
  },
  agy: {
    id: "agy",
    stages: ["review"],
    invocation: "cli",
    continuation: true,
    writable: false,
  },
};

export const PROVIDER_REGISTRY = Object.freeze(
  Object.fromEntries(Object.entries(PROVIDERS).map(([key, value]) => [key, Object.freeze(value)])),
);

export function providerDefinition(provider) {
  const value = PROVIDER_REGISTRY[provider];
  if (!value) throw new Error(`Unknown provider: ${provider}`);
  return value;
}

export function assertProviderSupportsStage(provider, stage) {
  const definition = providerDefinition(provider);
  if (!definition.stages.includes(stage)) {
    throw new Error(`Provider ${provider} does not support stage ${stage}`);
  }
  return definition;
}

export function normalizeStageRoute(route, stage) {
  const normalized = typeof route === "string" ? { provider: route } : { ...(route || {}) };
  const provider = String(normalized.provider || "").trim();
  assertProviderSupportsStage(provider, stage);
  return {
    provider,
    model: normalized.model || null,
    invocation: normalized.invocation || providerDefinition(provider).invocation,
  };
}

export function resolveStageRoutes(config, stage, complexity = "medium") {
  const normalizedComplexity = complexity === "mid" ? "medium" : complexity;
  const stageConfig = config.stages?.[stage];
  if (!stageConfig) throw new Error(`Missing stages.${stage} configuration`);
  if (stage === "accept" && stageConfig.inherit_from) {
    return resolveStageRoutes(config, stageConfig.inherit_from, normalizedComplexity);
  }
  const routeValue = stageConfig.routes?.[normalizedComplexity] || stageConfig.routes?.medium || stageConfig.routes?.high;
  const list = Array.isArray(routeValue) ? routeValue : [routeValue];
  const routes = list.filter(Boolean).map((route) => normalizeStageRoute(route, stage));
  if (!routes.length) throw new Error(`No route configured for stage=${stage} complexity=${normalizedComplexity}`);
  return routes;
}
