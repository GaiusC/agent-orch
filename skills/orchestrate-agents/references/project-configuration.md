# Project configuration

Agent Orch project configuration is `.agent-orchestrator/config.json`, version 2.

Required gates:

```json
{
  "version": 2,
  "trusted": true,
  "mcp": {
    "enabled": true,
    "expose_provider_tools": false
  },
  "host": {
    "provider": "codex"
  }
}
```

`trusted` authorizes worker execution. `mcp.enabled` authorizes non-health MCP tools. `mcp.expose_provider_tools` is diagnostic only and also requires the server environment opt-in.

Routes are configured under `stages.plan`, `stages.work`, `stages.review`, and `stages.accept`. Contracts cannot override routes.

The default in-session Codex Planner/Accepter model is `gpt-5.6-terra`, which exposes local MCP tools. Generated `gpt-5.6-sol` Planner/Accepter values are migrated to `gpt-5.6-terra`; unrelated custom model names remain unchanged.

Provider CLI settings:

- `cli.claude`, `cli.claude_permission_mode`;
- `cli.agy`, `cli.agy_write_permission_mode`, `cli.agy_env`;
- `cli.codex`;
- provider timeouts under `execution`.

`resume` writes `.agent-orchestrator/runtime-env.json`. Explicit `cli.agy_env` values override the captured environment.

Version 1 configuration is migrated to v2. Known obsolete AGY aliases and the known MCP-incompatible Codex Planner default are translated; unknown custom model names are retained.
