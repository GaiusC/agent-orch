import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session-id");
const resumeIndex = args.indexOf("--resume");
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : args[resumeIndex + 1];
const target = path.join(process.cwd(), "feature.txt");
const isRepair = fs.existsSync(target);
fs.writeFileSync(target, isRepair ? "good" : "bad", "utf8");
process.stdout.write(JSON.stringify({
  session_id: sessionId,
  is_error: false,
  result: isRepair ? "repaired implementation" : "initial implementation",
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5 }
}));
