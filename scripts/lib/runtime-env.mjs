import path from "node:path";
import { nowIso, pathExists, readJson, writeJsonAtomic } from "./utils.mjs";

export const RUNTIME_ENV_KEYS = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "AGENT_ORCH_AGY_HOME",
  "EAO_AGY_HOME",
  "USERPROFILE",
  "HOME",
  "LOCALAPPDATA",
  "APPDATA",
]);

export function runtimeEnvPath(projectDir) {
  return path.join(path.resolve(projectDir), ".agent-orchestrator", "runtime-env.json");
}

export function selectRuntimeEnvironment(source = process.env) {
  return Object.fromEntries(
    RUNTIME_ENV_KEYS
      .filter((key) => typeof source[key] === "string" && source[key].trim())
      .map((key) => [key, source[key]]),
  );
}

export async function captureRuntimeEnvironment(projectDir, source = process.env) {
  const file = runtimeEnvPath(projectDir);
  const artifact = {
    version: 1,
    captured_at: nowIso(),
    env: selectRuntimeEnvironment(source),
  };
  await writeJsonAtomic(file, artifact);
  return { ...artifact, file };
}

export async function loadRuntimeEnvironment(projectDir) {
  const file = runtimeEnvPath(projectDir);
  if (!(await pathExists(file))) return { version: 1, captured_at: null, env: {}, file };
  const value = await readJson(file);
  return {
    version: Number(value.version || 1),
    captured_at: value.captured_at || null,
    env: selectRuntimeEnvironment(value.env || {}),
    file,
  };
}

export async function effectiveProviderEnvironment(projectDir, explicit = {}, current = process.env) {
  const captured = await loadRuntimeEnvironment(projectDir);
  return {
    ...selectRuntimeEnvironment(current),
    ...captured.env,
    ...Object.fromEntries(
      Object.entries(explicit || {})
        .filter(([key, value]) => typeof key === "string" && value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)]),
    ),
  };
}
