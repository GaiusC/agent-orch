#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { reportProgress } from "./lib/notifications.mjs";

const mcp = process.argv[2] === "--mcp";
const directory = process.argv[mcp ? 3 : 2];
if (!directory) throw new Error("A runtime-bound reporting directory is required");
if (!mcp) {
  const result = await reportProgress(directory, { checkpoint: process.argv[3], message: process.argv.slice(4).join(" ") });
  process.stdout.write(JSON.stringify(result) + "\n");
} else {
  // This server has no planning, worker-launch, acceptance or arbitrary-file tools.
  const server = new Server({ name: "agent-orch-progress", version: "0.8.1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "report_progress", description: "Report one short task checkpoint. Does not change job status or constitute verification evidence.",
    inputSchema: { type: "object", properties: { checkpoint: { type: "string", enum: ["inspection_done", "implementation_done", "testing", "reviewing", "finding", "blocked"] }, message: { type: "string", minLength: 1, maxLength: 240 } }, required: ["checkpoint", "message"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.name !== "report_progress") throw new Error("Only report_progress is allowed");
      const value = await reportProgress(directory, request.params.arguments || {});
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] }; }
  });
  await server.connect(new StdioServerTransport());
}
