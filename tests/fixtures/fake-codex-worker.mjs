import fs from "node:fs";
import path from "node:path";

const sessionId = "11111111-1111-4111-8111-111111111111";
fs.writeFileSync(path.join(process.cwd(), "feature.txt"), "good", "utf8");
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: sessionId })}\n`);
process.stdout.write(`${JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "Implemented and verified feature.txt." },
})}\n`);
