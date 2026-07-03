import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix = "run") {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

export function projectKey(projectDir) {
  return crypto.createHash("sha256").update(path.resolve(projectDir).toLowerCase()).digest("hex").slice(0, 16);
}

export function normalizeRelative(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
}

export function matchesPathPattern(file, pattern) {
  const candidate = normalizeRelative(file);
  const normalized = normalizeRelative(pattern);
  if (!normalized) return false;
  if (normalized.endsWith("/")) return candidate === normalized.slice(0, -1) || candidate.startsWith(normalized);
  if (!normalized.includes("*")) return candidate === normalized || candidate.startsWith(`${normalized}/`);
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(candidate);
}

export function truncate(text, maxChars = 8000) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head;
  return `${value.slice(0, head)}\n...[truncated ${value.length - maxChars} chars]...\n${value.slice(-tail)}`;
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function requireString(args, key) {
  const value = args?.[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

export function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim() || undefined;
}

export function asStringArray(value, key) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value;
}

export function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return structuredClone(base);
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object" && !Array.isArray(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = structuredClone(value);
    }
  }
  return output;
}

export async function readJson(file) {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temp, file);
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY"].includes(error?.code) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
