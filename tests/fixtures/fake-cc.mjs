import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session-id");
const resumeIndex = args.indexOf("--resume");
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : args[resumeIndex + 1];
const modelIndex = args.indexOf("--model");
const passedModel = modelIndex >= 0 ? args[modelIndex + 1] : null;
const target = path.join(process.cwd(), "feature.txt");
const mode = process.env.AGENT_ORCH_FAKE_CC_MODE || "";

// always-fail: never repair - writes "bad" every round to trigger verification_failed.
// Tracks attempts via a counter file in the workspace parent so CC fallback runs succeed.
if (mode === "always-fail") {
  const counterFile = path.join(path.resolve(process.cwd(), ".."), ".fake-cc-always-fail-count");
  let count = 0;
  try { count = parseInt(fs.readFileSync(counterFile, "utf8").trim(), 10); } catch {}
  count += 1;
  fs.writeFileSync(counterFile, String(count), "utf8");
  // Write "bad" for the first 3 rounds (initial + 2 repairs), "good" on fallback
  const writeGood = count > 3;
  fs.writeFileSync(target, writeGood ? "good" : "bad", "utf8");
  process.stdout.write(JSON.stringify({
    session_id: sessionId,
    is_error: false,
    result: writeGood ? "fallback implementation successful" : "implementation attempted but verification will fail",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: passedModel || null,
  }));
} else if (mode === "fail-then-good") {
  // Writes "bad" on first round, "good" on subsequent rounds (simulates repair)
  const isRepair = fs.existsSync(target);
  fs.writeFileSync(target, isRepair ? "good" : "bad", "utf8");
  process.stdout.write(JSON.stringify({
    session_id: sessionId,
    is_error: false,
    result: isRepair ? "repaired implementation" : "initial implementation",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: passedModel || null,
  }));
} else {
  // Default: repair on retry
  const isRepair = fs.existsSync(target);
  fs.writeFileSync(target, isRepair ? "good" : "bad", "utf8");
  process.stdout.write(JSON.stringify({
    session_id: sessionId,
    is_error: false,
    result: isRepair ? "repaired implementation" : "initial implementation",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: passedModel || null,
  }));
}
