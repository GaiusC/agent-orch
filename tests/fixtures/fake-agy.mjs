import fs from "node:fs/promises";
import path from "node:path";

const id = "123e4567-e89b-42d3-a456-426614174000";
const args = process.argv.slice(2);
const mode = process.env.AGENT_ORCH_FAKE_AGY_MODE || "";

// -- Store-only mode (existing behavior) --
if (process.env.AGENT_ORCH_FAKE_AGY_STORE_ONLY === "1" || process.env.EAO_FAKE_AGY_STORE_ONLY === "1") {
  const logFlag = args.indexOf("--log-file");
  if (logFlag >= 0 && args[logFlag + 1]) {
    await fs.writeFile(args[logFlag + 1], `Print mode: silent auth succeeded\nCreated conversation ${id}\n`, "utf8");
  }
  const home = process.env.AGENT_ORCH_AGY_HOME || process.env.EAO_AGY_HOME;
  if (!home) throw new Error("AGENT_ORCH_AGY_HOME is required for store-only fake AGY");
  const store = path.join(home, ".gemini", "antigravity-cli", "conversations");
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(
    path.join(store, `${id}.db-wal`),
    Buffer.from(`\0\0noise\n# AGY_VERIFICATION_REPORT\n\n1. Changed file scope: docs only.\n2. Risks: none.\n2(bot-noise`),
  );
  process.exit(0);
}

// -- Quota error mode --
if (mode === "quota-error") {
  process.stderr.write("Error: RESOURCE_EXHAUSTED: Quota exceeded for this account. Please try again later or upgrade your plan.\n");
  process.exit(1);
}

// -- Quota rate-limit mode --
if (mode === "rate-limit") {
  process.stderr.write("429 Too Many Requests: rate limit reached. Daily usage limit exceeded.\n");
  process.exit(1);
}

// -- Auth error mode --
if (mode === "auth-error") {
  process.stderr.write("Error: authentication required. Please login with agy auth.\n");
  process.exit(1);
}

// -- Internal error mode --
if (mode === "internal-error") {
  process.stderr.write("Error: failed to construct executor: internal server error.\n");
  process.exit(1);
}

// -- Write mode (creates feature.txt for acceptance testing) --
if (mode === "write") {
  const printIdx = args.indexOf("--print");
  const prompt = printIdx >= 0 ? args[printIdx + 1] || "" : "";
  const isRepair = prompt.includes("This is a continuation");
  const target = path.join(process.cwd(), "feature.txt");
  if (isRepair && (await fs.stat(target).catch(() => null))) {
    await fs.writeFile(target, "good", "utf8");
  } else {
    await fs.writeFile(target, "bad", "utf8");
  }
  process.stdout.write(`conversation=${id}\nCreated conversation ${id}\n`);
  process.exit(0);
}

// -- Write mode with explicit session and repair support --
if (mode === "write-session") {
  const logFlag = args.indexOf("--log-file");
  const logPath = logFlag >= 0 ? args[logFlag + 1] : null;
  if (logPath) {
    await fs.writeFile(logPath, `Print mode: silent auth succeeded\nCreated conversation ${id}\n`, "utf8");
  }

  const target = path.join(process.cwd(), "feature.txt");
  const existing = await fs.stat(target).catch(() => null);
  if (existing) {
    await fs.writeFile(target, "good", "utf8");
  } else {
    await fs.writeFile(target, "bad", "utf8");
  }
  process.stdout.write(`conversation=${id}\n`);
  process.exit(0);
}

// -- Default read-only mode --
process.stdout.write(`conversation=${id}\nargs=${JSON.stringify(process.argv.slice(2))}`);
