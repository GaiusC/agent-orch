import path from "node:path";
import { runProcess } from "./process.mjs";
import { truncate, writeJsonAtomic } from "./utils.mjs";

export async function runVerification({ commands, workspace, jobDir, config, signal, round = 0 }) {
  const results = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const result = await runProcess({
      command,
      args: [],
      cwd: workspace,
      timeoutSeconds: config.execution.verification_timeout_seconds || config.execution.cc_timeout_seconds,
      logDir: jobDir,
      logPrefix: `verify-${round}-${index}`,
      maxLogBytes: config.execution.max_log_bytes,
      shell: true,
      signal,
    });
    results.push({
      command,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      cancelled: result.cancelled,
      duration_ms: result.duration_ms,
      stdout_path: result.stdout_path,
      stderr_path: result.stderr_path,
      output_summary: truncate(`${result.stdout}\n${result.stderr}`.trim(), 2000),
    });
    if (result.exit_code !== 0 || result.timed_out || result.cancelled) break;
  }
  const report = {
    configured: commands.length > 0,
    passed: commands.length > 0 && results.every((item) => item.exit_code === 0 && !item.timed_out && !item.cancelled),
    results,
  };
  const reportPath = path.join(jobDir, `verification-${round}.json`);
  await writeJsonAtomic(reportPath, report);
  return { ...report, report_path: reportPath };
}

export function verificationFailureContext(verification) {
  return verification.results
    .filter((item) => item.exit_code !== 0 || item.timed_out || item.cancelled)
    .map((item) => `Command: ${item.command}\nExit: ${item.exit_code}\nTimed out: ${item.timed_out}\nOutput:\n${item.output_summary}`)
    .join("\n\n");
}
