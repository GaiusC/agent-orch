import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process.mjs";
import { pathExists, truncate } from "./utils.mjs";

async function readClaudeSettingsEnv() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const settingsPath = path.join(home, ".claude", "settings.json");
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const env = parsed?.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) return {};
    return Object.fromEntries(
      Object.entries(env)
        .filter(([key, value]) => typeof key === "string" && typeof value !== "object" && value !== null)
        .map(([key, value]) => [key, String(value)]),
    );
  } catch {
    return {};
  }
}

function contractPrompt({ role, goal, plan, acceptance, readPaths, writablePaths, forbiddenPaths, evidenceOnly = false }) {
  return [
    `Role: ${role}`,
    `Goal: ${goal}`,
    plan ? `Approved plan:\n${plan}` : null,
    readPaths?.length ? `Read-only paths: ${readPaths.join(", ")}` : null,
    writablePaths?.length ? `Writable paths: ${writablePaths.join(", ")}` : null,
    forbiddenPaths?.length ? `Forbidden paths: ${forbiddenPaths.join(", ")}` : null,
    acceptance?.length ? `Acceptance commands: ${acceptance.join("; ")}` : null,
    "Obey CLAUDE.md/AGENTS.md project rules when they do not conflict with this contract.",
    "Do not commit, push, publish, deploy, rotate credentials, or change remote systems.",
    evidenceOnly ? "Do not modify project files. Return concise findings and concrete evidence." : "Implement the approved plan completely, add or update tests as appropriate, and run relevant checks.",
    "At the end, summarize files changed, commands run, test results, deviations, and unresolved risks.",
  ].filter(Boolean).join("\n\n");
}

export function buildClaudeArgs({ prompt, sessionId, resume, model, permissionMode = "auto", maxBudgetUsd }) {
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", permissionMode];
  if (resume) args.push("--resume", sessionId);
  else args.push("--session-id", sessionId);
  if (model) args.push("--model", model);
  if (maxBudgetUsd) args.push("--max-budget-usd", String(maxBudgetUsd));
  return args;
}

function parseClaudeOutput(stdout, fallbackSessionId) {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return {
      session_id: parsed.session_id || fallbackSessionId,
      result: parsed.result ?? parsed,
      is_error: Boolean(parsed.is_error),
      usage: parsed.usage || null,
      cost_usd: parsed.total_cost_usd ?? null,
      model: parsed.model || null,
    };
  } catch {
    return { session_id: fallbackSessionId, result: trimmed, is_error: false, usage: null, cost_usd: null, model: null };
  }
}

export async function runClaude({ config, workspace, jobDir, goal, plan, acceptance, readPaths, writablePaths, forbiddenPaths, taskSession, model, repairContext, signal, round = 0 }) {
  const sessionId = taskSession?.session_id || crypto.randomUUID();
  const basePrompt = contractPrompt({
    role: "Primary implementation worker reporting to Codex",
    goal,
    plan,
    acceptance,
    readPaths,
    writablePaths,
    forbiddenPaths,
  });
  const prompt = repairContext
    ? `${basePrompt}\n\nThis is a continuation. Fix only the following verified failures without redesigning the approved plan:\n${repairContext}`
    : basePrompt;
  const args = buildClaudeArgs({
    prompt,
    sessionId,
    resume: Boolean(taskSession?.session_id),
    model,
    permissionMode: config.cli.claude_permission_mode || "auto",
    maxBudgetUsd: config.execution.cc_max_budget_usd,
  });
  args.unshift(...(config.cli.claude_prefix_args || []));
  const claudeSettingsEnv = await readClaudeSettingsEnv();
  const processResult = await runProcess({
    command: config.cli.claude,
    args,
    cwd: workspace,
    timeoutSeconds: config.execution.cc_timeout_seconds,
    logDir: jobDir,
    logPrefix: `cc-round-${round}`,
    maxLogBytes: config.execution.max_log_bytes,
    env: { ...claudeSettingsEnv, ...(config.cli.claude_env || {}) },
    signal,
  });
  return { ...processResult, parsed: parseClaudeOutput(processResult.stdout, sessionId), session_id: sessionId, model: model || null };
}

function findUuid(value) {
  if (typeof value === "string") {
    const match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    return match?.[0] || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = findUuid(item); if (found) return found; }
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) { const found = findUuid(item); if (found) return found; }
  }
  return null;
}

async function cachedAgyConversation(workspace) {
  const cache = path.join(agyCliRoot(), "cache", "last_conversations.json");
  if (!(await pathExists(cache))) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(cache, "utf8"));
    const resolved = path.resolve(workspace);
    for (const [key, value] of Object.entries(parsed)) {
      if (path.resolve(key).toLowerCase() === resolved.toLowerCase()) return findUuid(value);
    }
  } catch {}
  return null;
}

async function discoverAgyConversation({ workspace, stdout, cliLogPath, existingSessionId, cachedBefore }) {
  if (existingSessionId) return existingSessionId;
  try {
    const log = await fs.readFile(cliLogPath, "utf8");
    const created = log.match(/Created conversation\s+([0-9a-f-]{36})/i)?.[1];
    if (created) return created;
    const active = log.match(/Print mode:\s+conversation=([0-9a-f-]{36})/i)?.[1];
    if (active) return active;
  } catch {}
  const fromOutput = findUuid(stdout);
  if (fromOutput) return fromOutput;
  const cachedAfter = await cachedAgyConversation(workspace);
  return cachedAfter && cachedAfter !== cachedBefore ? cachedAfter : null;
}

function agyProjectId(config) {
  return config.cli.agy_project || config.cli.agy_project_id || null;
}

function sanitizedAgyArgs(args) {
  const sanitized = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    sanitized.push(arg);
    if (["--print", "--prompt", "-p", "--prompt-interactive", "-i"].includes(arg) && i + 1 < args.length) {
      const prompt = args[i + 1] || "";
      sanitized.push(`[prompt redacted chars=${prompt.length}]`);
      i += 1;
    }
  }
  return sanitized;
}

function safeAgyEnvSnapshot() {
  const keys = ["USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "AGENT_ORCH_AGY_HOME", "EAO_AGY_HOME"];
  return Object.fromEntries(keys.map((key) => [key, process.env[key] ? { present: true, value: process.env[key] } : { present: false }]));
}

export function buildAgyArgs({ prompt, conversationId, model, timeoutSeconds, sandbox = false, projectId = null, workspace = null }) {
  const args = ["--print", prompt, "--print-timeout", `${timeoutSeconds}s`];
  if (projectId) args.push("--project", projectId);
  if (conversationId) args.push("--conversation", conversationId);
  else if (!projectId) args.push("--new-project");
  if (workspace) args.push("--add-dir", workspace);
  if (model) args.push("--model", model);
  if (sandbox) args.push("--sandbox");
  return args;
}

function agyHomeDir() {
  return process.env.AGENT_ORCH_AGY_HOME || process.env.EAO_AGY_HOME || os.homedir();
}

function agyCliRoot() {
  return path.join(agyHomeDir(), ".gemini", "antigravity-cli");
}

async function readAgyTranscript(conversationId) {
  if (!conversationId) return "";
  const transcript = path.join(
    agyCliRoot(),
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  if (!(await pathExists(transcript))) return "";
  try {
    const lines = (await fs.readFile(transcript, "utf8")).split(/\r?\n/).filter(Boolean);
    const modelMessages = [];
    for (const line of lines) {
      const item = JSON.parse(line);
      if (item.source === "MODEL" && typeof item.content === "string" && item.content.trim()) modelMessages.push(item.content.trim());
    }
    return modelMessages.at(-1) || "";
  } catch {
    return "";
  }
}

function printableText(buffer) {
  let output = "";
  for (const byte of buffer) {
    output += byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) ? String.fromCharCode(byte) : " ";
  }
  return output;
}

function bestAgyStoreExcerpt(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const markers = [
    /^#\s+[A-Z0-9_ -]{6,}/gm,
    /\*\*[A-Z][^*\n]{4,80}\*\*/g,
  ];
  let start = -1;
  for (const marker of markers) {
    for (const match of normalized.matchAll(marker)) {
      if ((match.index ?? -1) > start) start = match.index;
    }
    if (start >= 0) break;
  }
  if (start < 0) {
    const runs = normalized.match(/[ -~\t\n]{400,}/g) || [];
    return runs.at(-1)?.trim() || "";
  }
  const tail = normalized.slice(start);
  const stop = tail.search(/\n\s*\d+\(bot-|<EPHEMERAL_MESSAGE>|<USER_REQUEST>|command\(\*\)/);
  return tail.slice(0, stop > 0 ? stop : 4000).trim();
}

async function readAgyConversationStore(conversationId) {
  if (!conversationId) return "";
  const base = path.join(agyCliRoot(), "conversations");
  const candidates = [
    path.join(base, `${conversationId}.db-wal`),
    path.join(base, `${conversationId}.db`),
  ];
  for (const file of candidates) {
    if (!(await pathExists(file))) continue;
    try {
      const text = printableText(await fs.readFile(file));
      const excerpt = bestAgyStoreExcerpt(text);
      if (excerpt) return excerpt;
    } catch {}
  }
  return "";
}

async function readTail(file, maxChars = 4000) {
  if (!file || !(await pathExists(file))) return "";
  try {
    const text = await fs.readFile(file, "utf8");
    return truncate(text, maxChars);
  } catch {
    return "";
  }
}

// -- Worker progress extraction (bounded, assistant-only, at most 2 newest) --

/**
 * Read the bounded tail of an AGY transcript JSONL file and return at most the
 * two newest MODEL-source (assistant) messages.  Never exposes tool calls,
 * tool arguments, tool output, or user messages.
 *
 * @param {string|null} conversationId
 * @param {number} [maxChars=16000] bounded tail read limit
 * @returns {Promise<Array<{content:string, timestamp:string|null, source:string}>>}
 */
async function readAgyProgress(conversationId, maxChars = 16000) {
  if (!conversationId) return [];
  const transcript = path.join(
    agyCliRoot(),
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  if (!(await pathExists(transcript))) return [];
  try {
    const text = await readTail(transcript, maxChars);
    if (!text) return [];
    const modelMessages = [];
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if (item.source === "MODEL" && typeof item.content === "string" && item.content.trim()) {
        modelMessages.push({
          content: item.content.trim(),
          timestamp: item.ts || item.timestamp || null,
          source: "agy_transcript",
        });
      }
    }
    return modelMessages.slice(-2);
  } catch {
    return [];
  }
}

/**
 * Read the bounded tail of the latest CC round's stdout file and extract
 * assistant messages.  Supports two formats:
 *
 * 1. Single JSON object with a `result` string field (CC --output-format json
 *    final summary).
 * 2. JSONL where each line may have `type: "message"` with `role: "assistant"`,
 *    or a final summary line with a `result` field.
 *
 * Returns at most the two newest non-empty assistant messages.
 *
 * @param {string} jobDir – absolute path to the job directory on disk
 * @param {number} [maxChars=16000]
 * @returns {Promise<Array<{content:string, timestamp:string|null, source:string}>>}
 */
async function readCcProgress(jobDir, maxChars = 16000) {
  // Discover the latest round's stdout file
  let entries;
  try { entries = await fs.readdir(jobDir, { withFileTypes: true }); } catch { return []; }
  const stdoutFiles = entries
    .filter((e) => e.isFile() && /^cc-round-\d+\.stdout$/.test(e.name))
    .map((e) => ({ name: e.name, round: parseInt(e.name.match(/\d+/)[0], 10) }))
    .sort((a, b) => b.round - a.round);
  if (!stdoutFiles.length) return [];
  const text = await readTail(path.join(jobDir, stdoutFiles[0].name), maxChars);
  if (!text) return [];

  const messages = [];
  const lines = text.split(/\n/).filter(Boolean);

  // First pass: look for a summary JSON object (last line most likely)
  // CC produces a single JSON object with --output-format json
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (typeof parsed.result === "string" && parsed.result.trim()) {
        messages.push({
          content: parsed.result.trim(),
          timestamp: parsed.ts || parsed.timestamp || null,
          source: "cc_summary",
        });
        break;
      }
    } catch { continue; }
  }

  // Second pass: collect JSONL assistant message lines (streaming text)
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.type === "message" && item.role === "assistant" && typeof item.content === "string" && item.content.trim()) {
        messages.push({
          content: item.content.trim(),
          timestamp: item.ts || item.timestamp || null,
          source: "cc_message",
        });
      }
    } catch { continue; }
  }

  // Deduplicate by content (summary may duplicate a message)
  const seen = new Set();
  const unique = [];
  for (const m of messages) {
    const key = m.content.slice(0, 200);
    if (!seen.has(key)) { seen.add(key); unique.push(m); }
  }

  return unique.slice(-2);
}

/**
 * Best-effort bounded progress extractor for CC and AGY worker jobs.
 * Reads a bounded tail of known/discoverable worker transcripts, selects
 * assistant/model messages only, and returns at most the two newest
 * non-empty messages with safe metadata.
 *
 * Never exposes raw transcript paths, tool calls, tool arguments, or
 * tool output through the returned progress.
 *
 * @param {object} opts
 * @param {object} opts.job   – full job object from the state store
 * @param {string} opts.jobDir – absolute path to the job's disk directory
 * @returns {Promise<{available:boolean, messages:Array, note:string|null}>}
 */
export async function readWorkerProgress({ job, jobDir }) {
  const provider = job?.provider || "";
  const sessionId = job?.session_id || null;

  let messages = [];

  if (provider === "cc") {
    messages = await readCcProgress(jobDir);
  } else if (provider === "agy" || provider === "agy_write") {
    messages = await readAgyProgress(sessionId);
  }

  if (!messages || messages.length === 0) {
    return {
      available: false,
      messages: [],
      note: `No assistant progress available yet for this ${provider || "unknown"} job.`,
    };
  }

  // Bound each message's content length
  const trimmed = messages.slice(0, 2).map((m) => ({
    content: truncate(m.content, 2000),
    timestamp: m.timestamp || null,
    source: m.source || null,
  }));

  return { available: true, messages: trimmed, note: null };
}

export async function runAgy({ config, workspace, jobDir, goal, plan, readPaths, writablePaths, forbiddenPaths, taskSession, model, signal, mode = "investigate" }) {
  const evidenceOnly = mode !== "disjoint_subtask";
  const prompt = mode === "plan"
    ? [
        "You are a planner producing a contract-oriented plan for the host orchestrator.",
        `Planning goal: ${goal}`,
        plan ? `Context: ${plan}` : null,
        readPaths?.length ? `Read-only paths: ${readPaths.join(", ")}` : null,
        forbiddenPaths?.length ? `Forbidden paths: ${forbiddenPaths.join(", ")}` : null,
        "Read-only: do not modify files or external systems.",
        "Return a concise plan with proposed contracts, dependencies, read_paths, writable_paths, forbidden_paths, acceptance commands, and parallel/serial ordering. Do not execute implementation.",
      ].filter(Boolean).join("\n\n")
    : evidenceOnly
    ? [
        mode === "review" ? "You are a reviewer reporting acceptance evidence to the host orchestrator." : "You are a specialist reporting evidence to the host orchestrator.",
        `Task: ${goal}`,
        plan ? `Context: ${plan}` : null,
        readPaths?.length ? `Read-only paths: ${readPaths.join(", ")}` : null,
        forbiddenPaths?.length ? `Forbidden paths: ${forbiddenPaths.join(", ")}` : null,
        "Read-only: do not modify files or external systems.",
        "After any necessary tool use, provide a concise final answer with concrete evidence. Do not stop at a plan.",
      ].filter(Boolean).join("\n\n")
    : [
        "You are implementing a strictly disjoint subtask for Codex.",
        `Task: ${goal}`,
        plan ? `Approved plan: ${plan}` : null,
        readPaths?.length ? `Read-only paths: ${readPaths.join(", ")}` : null,
        writablePaths?.length ? `Writable paths: ${writablePaths.join(", ")}` : null,
        forbiddenPaths?.length ? `Forbidden paths: ${forbiddenPaths.join(", ")}` : null,
        "Do not commit, push, publish, deploy, or modify anything outside the approved paths.",
        "Complete the task, run relevant checks, and provide a concise final answer. Do not stop at a plan.",
      ].filter(Boolean).join("\n\n");
  const cachedBefore = await cachedAgyConversation(workspace);
  const cliLogPath = path.join(jobDir, `agy-${mode}.cli.log`);
  const projectId = agyProjectId(config);
  const sandbox = config.cli.agy_sandbox === true;
  const args = buildAgyArgs({
    prompt,
    conversationId: taskSession?.session_id,
    model,
    timeoutSeconds: config.execution.agy_timeout_seconds,
    sandbox,
    projectId,
    workspace,
  });
  args.unshift(...(config.cli.agy_prefix_args || []));
  args.push("--log-file", cliLogPath);
  const launch = {
    command: config.cli.agy,
    args: sanitizedAgyArgs(args),
    cwd: workspace,
    sandbox,
    project_id: projectId,
    env: safeAgyEnvSnapshot(),
  };
  const processResult = await runProcess({
    command: config.cli.agy,
    args,
    cwd: workspace,
    timeoutSeconds: config.execution.agy_timeout_seconds + 30,
    logDir: jobDir,
    logPrefix: `agy-${mode}`,
    maxLogBytes: config.execution.max_log_bytes,
    env: config.cli.agy_env || {},
    signal,
  });
  const sessionId = await discoverAgyConversation({
    workspace,
    stdout: processResult.stdout,
    cliLogPath,
    existingSessionId: taskSession?.session_id,
    cachedBefore,
  });
  const transcriptResult = await readAgyTranscript(sessionId || taskSession?.session_id);
  const storeResult = processResult.stdout.trim() || transcriptResult ? "" : await readAgyConversationStore(sessionId || taskSession?.session_id);
  const cliLogTail = await readTail(cliLogPath, 4000);
  const resultText = processResult.stdout.trim() || transcriptResult || storeResult;
  return {
    ...processResult,
    session_id: sessionId || taskSession?.session_id || null,
    model: model || null,
    result: truncate(resultText, config.execution.max_result_chars),
    result_source: processResult.stdout.trim() ? "stdout" : transcriptResult ? "transcript" : storeResult ? "conversation_store" : "none",
    cli_log_path: cliLogPath,
    cli_log_tail: cliLogTail,
    launch,
  };
}

// -- AGY write-mode execution (isolated worktree + patch + verification) --

export function classifyAgyQuotaError(output, stderr = "") {
  if (!output && !stderr) return false;
  const combined = [output, stderr].filter(Boolean).join(" ");
  const quotaPatterns = [
    /429/i,
    /RESOURCE_EXHAUSTED/i,
    /quota\s+exceeded/i,
    /rate\s+limit/i,
    /credit[s]?\s+(exhausted|depleted|insufficient|expired)/i,
    /billing\s+limit/i,
    /usage\s+(limit|quota|exceeded|capped)/i,
    /too\s+many\s+requests/i,
    /usage\s+exceeded/i,
    /payment\s+required/i,
    /insufficient\s+(credits?|quota|balance)/i,
    /exceeded\s+(your\s+)?(current\s+)?quota/i,
    /quota\s+(has\s+been|was)\s+(reached|exhausted|exceeded)/i,
    /limit[s]?\s+(have\s+been\s+)?reached/i,
    /daily\s+(usage\s+)?limit/i,
    /monthly\s+(usage\s+)?limit/i,
    /try\s+again\s+later.*(?:quota|limit|rate)/i,
  ];
  const nonQuotaPatterns = [
    /authentication\s+(required|failed|error)/i,
    /unauthorized/i,
    /permission\s+denied/i,
    /access\s+denied/i,
    /forbidden/i,
    /failed\s+to\s+construct\s+executor/i,
    /neither\s+PlanModel\s+nor\s+RequestedModel\s+specified/i,
    /model\s+output\s+error/i,
    /invalid\s+tool\s+call\s+error/i,
    /internal\s+(server\s+)?error/i,
    /sandbox\s+error/i,
  ];

  // Non-quota errors take priority -- if we see those, never classify as quota
  if (nonQuotaPatterns.some((re) => re.test(combined))) return false;
  return quotaPatterns.some((re) => re.test(combined));
}

export function contractPromptAgyWrite({ goal, plan, acceptance, readPaths, writablePaths, forbiddenPaths }) {
  return [
    "Role: Primary implementation worker reporting to Codex",
    `Goal: ${goal}`,
    plan ? `Approved plan:\n${plan}` : null,
    readPaths?.length ? `Read-only paths: ${readPaths.join(", ")}` : null,
    writablePaths?.length ? `Writable paths: ${writablePaths.join(", ")}` : null,
    forbiddenPaths?.length ? `Forbidden paths: ${forbiddenPaths.join(", ")}` : null,
    acceptance?.length ? `Acceptance commands: ${acceptance.join("; ")}` : null,
    "Obey CLAUDE.md/AGENTS.md project rules when they do not conflict with this contract.",
    "Do not commit, push, publish, deploy, rotate credentials, or change remote systems.",
    "Implement the approved plan completely, add or update tests as appropriate, and run relevant checks.",
    "At the end, summarize files changed, commands run, test results, deviations, and unresolved risks.",
  ].filter(Boolean).join("\n\n");
}

export async function runAgyWrite({ config, workspace, jobDir, goal, plan, acceptance, readPaths, writablePaths, forbiddenPaths, taskSession, model, repairContext, signal, round = 0 }) {
  const sessionId = taskSession?.session_id || crypto.randomUUID();
  const basePrompt = contractPromptAgyWrite({
    goal,
    plan,
    acceptance,
    readPaths,
    writablePaths,
    forbiddenPaths,
  });
  const prompt = repairContext
    ? `${basePrompt}\n\nThis is a continuation. Fix only the following verified failures without redesigning the approved plan:\n${repairContext}`
    : basePrompt;
  const cachedBefore = await cachedAgyConversation(workspace);
  const cliLogPath = path.join(jobDir, `agy-write-round-${round}.cli.log`);
  const projectId = agyProjectId(config);
  const sandbox = config.cli.agy_sandbox === true;
  const timeoutSeconds = config.execution.agy_write_timeout_seconds || config.execution.agy_timeout_seconds;
  const args = buildAgyArgs({
    prompt,
    conversationId: taskSession?.session_id,
    model,
    timeoutSeconds,
    sandbox,
    projectId,
    workspace,
  });
  args.unshift(...(config.cli.agy_prefix_args || []));
  args.push("--log-file", cliLogPath);

  const launch = {
    command: config.cli.agy,
    args: sanitizedAgyArgs(args),
    cwd: workspace,
    sandbox,
    project_id: projectId,
    env: safeAgyEnvSnapshot(),
  };

  const processResult = await runProcess({
    command: config.cli.agy,
    args,
    cwd: workspace,
    timeoutSeconds: timeoutSeconds + 30,
    logDir: jobDir,
    logPrefix: `agy-write-round-${round}`,
    maxLogBytes: config.execution.max_log_bytes,
    env: config.cli.agy_env || {},
    signal,
  });

  const resultSessionId = await discoverAgyConversation({
    workspace,
    stdout: processResult.stdout,
    cliLogPath,
    existingSessionId: taskSession?.session_id,
    cachedBefore,
  });

  const transcriptResult = await readAgyTranscript(resultSessionId || taskSession?.session_id);
  const storeResult = processResult.stdout.trim() || transcriptResult ? "" : await readAgyConversationStore(resultSessionId || taskSession?.session_id);
  const cliLogTail = await readTail(cliLogPath, 4000);
  const resultText = processResult.stdout.trim() || transcriptResult || storeResult;

  return {
    ...processResult,
    parsed: {
      session_id: resultSessionId || taskSession?.session_id || sessionId,
      result: truncate(resultText, config.execution.max_result_chars),
      is_error: processResult.exit_code !== 0,
      usage: null,
      cost_usd: null,
    },
    session_id: resultSessionId || taskSession?.session_id || sessionId,
    model: model || null,
    result: truncate(resultText, config.execution.max_result_chars),
    result_source: processResult.stdout.trim() ? "stdout" : transcriptResult ? "transcript" : storeResult ? "conversation_store" : "none",
    cli_log_path: cliLogPath,
    cli_log_tail: cliLogTail,
    launch,
  };
}
