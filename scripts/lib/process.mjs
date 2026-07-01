import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

async function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1500).unref();
  }
}

function appendLimited(stream, chunk, state, maxBytes) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, maxBytes - state.bytes);
  if (remaining > 0) stream.write(bytes.subarray(0, remaining));
  state.bytes += bytes.length;
  if (state.memoryBytes < maxBytes) {
    const memoryRemaining = maxBytes - state.memoryBytes;
    state.chunks.push(bytes.subarray(0, memoryRemaining));
    state.memoryBytes += Math.min(bytes.length, memoryRemaining);
  }
  if (state.bytes > maxBytes) state.truncated = true;
}

export async function runProcess({ command, args = [], cwd, timeoutSeconds = 600, logDir, logPrefix = "process", maxLogBytes = 4 * 1024 * 1024, env, shell = false, signal }) {
  await fsp.mkdir(logDir, { recursive: true });
  const stdoutPath = path.join(logDir, `${logPrefix}.stdout.log`);
  const stderrPath = path.join(logDir, `${logPrefix}.stderr.log`);
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "w" });
  const stderrStream = fs.createWriteStream(stderrPath, { flags: "w" });
  const stdoutState = { bytes: 0, memoryBytes: 0, chunks: [], truncated: false };
  const stderrState = { bytes: 0, memoryBytes: 0, chunks: [], truncated: false };
  const startedAt = Date.now();
  let child;
  let timedOut = false;
  let cancelled = false;

  const result = await new Promise((resolve, reject) => {
    child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      windowsHide: true,
      detached: process.platform !== "win32",
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(async () => {
      timedOut = true;
      await killTree(child);
    }, Math.max(1, timeoutSeconds) * 1000);
    timer.unref();

    const abort = async () => {
      cancelled = true;
      await killTree(child);
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    child.stdout.on("data", (chunk) => appendLimited(stdoutStream, chunk, stdoutState, maxLogBytes));
    child.stderr.on("data", (chunk) => appendLimited(stderrStream, chunk, stderrState, maxLogBytes));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, exitSignal) => {
      clearTimeout(timer);
      resolve({ code, signal: exitSignal });
    });
  }).finally(() => {
    stdoutStream.end();
    stderrStream.end();
  });

  return {
    command,
    args,
    cwd,
    exit_code: result.code,
    signal: result.signal,
    timed_out: timedOut,
    cancelled,
    duration_ms: Date.now() - startedAt,
    stdout: Buffer.concat(stdoutState.chunks).toString("utf8"),
    stderr: Buffer.concat(stderrState.chunks).toString("utf8"),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_truncated: stdoutState.truncated,
    stderr_truncated: stderrState.truncated,
  };
}

export async function commandExists(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const tmp = path.join(process.env.TEMP || process.env.TMPDIR || ".", `eao-health-${process.pid}`);
  const result = await runProcess({ command: locator, args: [command], cwd: process.cwd(), timeoutSeconds: 10, logDir: tmp, logPrefix: command.replaceAll(/[\\/:]/g, "_") });
  return { found: result.exit_code === 0, path: result.stdout.trim().split(/\r?\n/)[0] || null };
}
