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

New projects have no fixed model default. `init` asks for stage-wide models and
ordered Work fallbacks, then offers low/medium/high overrides. Accept inherits
the exact Plan identity. Choose a Plan model that matches the actual MCP-capable
host chat. Outside a TTY, collect user selections from `selection_required` and
rerun with `--RoutesFile <json>`. `--ModelCatalog <json>` supplies provider lists;
`--UseExistingRoutes` explicitly reuses routes. Never choose silently on behalf
of the user. Existing v2 model identities are preserved by `resume`.

Codex Worker routes accept `reasoning_effort` and `service_tier`. Both may be
`null` to inherit CLI settings. Supported reasoning depends on the selected
model; `fast` requests Fast service, while other tiers require model/account
support. Route options are retained across continuation and sandbox recovery.
The root `codex_worker` object can provide defaults for routes that omit these
fields. A route's explicit null overrides those defaults with CLI inheritance.
An incomplete template has `model_selection.complete: false` and cannot execute
stages until initialization completes.

Provider CLI settings:

- `cli.claude`, `cli.claude_permission_mode`;
- `cli.agy`, `cli.agy_write_permission_mode`, `cli.agy_env`;
- `cli.codex`;
- provider timeouts under `execution`.

Notifications use `.agent-orchestrator/notifications/` (per-consumer delivery ledgers)
and `runs/<job>/reporting/` (short agent reports). Consumers share cursors across
Hook and explicit wait delivery. Use stable, distinct chat consumer ids.
`notifications.hook_enabled: false` opts out of automatic Hook delivery without
disabling the wait tool. The reporting helper is outside the Git patch; Codex/CC
receive a bound report_progress MCP connection, and AGY uses the same protocol via
the helper CLI. Reporting cannot set completed/failed or invoke acceptance tools.

`resume` writes `.agent-orchestrator/runtime-env.json`. Explicit `cli.agy_env` values override the captured environment.

Version 1 configuration is migrated to v2. Known obsolete AGY aliases are translated; unknown custom model names are retained.

Git lifecycle policy is additive to configuration v2. See [git-lifecycle.md](git-lifecycle.md)
for environment audits, explicit reconciliation, commit_policy=ask|auto|manual,
bounded worktrees, reviewed parallel integration, finalization and safe retirement.
Missing policy defaults to asking before local commits. It never authorizes push
or silently commits inherited changes. `--GitPolicyFile` records a user-selected
policy during initialization; resume preserves it.
