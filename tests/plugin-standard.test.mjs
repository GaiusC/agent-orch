import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("plugin skill declares its bundled MCP server as a Codex tool dependency", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const mcpConfig = JSON.parse(await fs.readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const skillMetadata = await fs.readFile(
    path.join(pluginRoot, "skills", "orchestrate-agents", "agents", "openai.yaml"),
    "utf8",
  );

  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.openaiCapabilities, undefined);
  assert.deepEqual(mcpConfig.mcpServers?.agent_orch?.args, ["scripts/mcp-stdio-bridge.mjs"]);
  for (const serverName of Object.keys(mcpConfig.mcpServers || {})) {
    assert.match(skillMetadata, /type:\s*["']?mcp["']?/);
    assert.match(
      skillMetadata,
      new RegExp(`value:\\s*["']?${serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?`),
    );
    assert.match(skillMetadata, /transport:\s*["']?stdio["']?/);
  }
});
