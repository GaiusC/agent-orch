const id = "123e4567-e89b-42d3-a456-426614174000";
const args = process.argv.slice(2);

if (process.env.AGENT_ORCH_FAKE_AGY_STORE_ONLY === "1" || process.env.EAO_FAKE_AGY_STORE_ONLY === "1") {
  const logFlag = args.indexOf("--log-file");
  if (logFlag >= 0 && args[logFlag + 1]) {
    await import("node:fs/promises").then(({ default: fs }) =>
      fs.writeFile(args[logFlag + 1], `Print mode: silent auth succeeded\nCreated conversation ${id}\n`, "utf8")
    );
  }
  const fs = (await import("node:fs/promises")).default;
  const path = (await import("node:path")).default;
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

process.stdout.write(`conversation=${id}\nargs=${JSON.stringify(process.argv.slice(2))}`);
