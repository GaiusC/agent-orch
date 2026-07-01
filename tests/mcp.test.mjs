import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");

test("MCP server starts and exposes bounded tools", async () => {
  const client = new Client({ name: "eao-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "server.mjs")],
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("cc_execute_task"));
    assert.ok(names.includes("agy_verify"));
    assert.ok(names.includes("worker_apply_result"));
    assert.equal(names.includes("run_arbitrary_command"), false);
    const health = await client.callTool({ name: "worker_health", arguments: {} });
    assert.equal(health.isError, false);
  } finally {
    await client.close();
  }
});
