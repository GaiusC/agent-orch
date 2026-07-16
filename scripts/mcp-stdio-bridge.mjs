#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(scriptDir, "server.mjs");

const child = spawn(process.execPath, [serverPath], {
  cwd: path.dirname(scriptDir),
  env: process.env,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stop(signal));
}

process.on("exit", () => {
  if (!child.killed) child.kill();
});

child.on("error", (error) => {
  process.stderr.write(`Agent Orch MCP bridge failed to start the server: ${error.message}\n`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal && !stopping) {
    process.stderr.write(`Agent Orch MCP server exited from signal ${signal}.\n`);
  }
  process.exitCode = code ?? (stopping ? 0 : 1);
});
