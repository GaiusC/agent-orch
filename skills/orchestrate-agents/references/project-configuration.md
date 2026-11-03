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

New projects have no fixed model default. `init` discovers models and offers
**use recommended / edit recommended / custom**. Recommended uses the newest
versioned generation and provider priority for medium/high Work, and the next
ranked candidate for low Work, with medium/medium/high reasoning and inherited
CLI service tier. Sol/Terra are tie-breakers, not pinned future model families.
Review uses the newest Sonnet High, newest Gemini High and previous Gemini
generation High respectively for high/medium/low. Version names are a heuristic,
not proof of capability or quota. Missing families/capabilities are explicit.
Plan/Accept use the actual host identity from current thread metadata; if it is
unavailable provide the verified `--HostModel <id>` rather than an old default.

Outside a TTY, `selection_required` includes `recommendation`, its provenance and
the three choices without writing configuration. Show a single options question;
after approval, save that exact selection and use `--RoutesFile <json>`.
`--UseRecommendedRoutes` is an explicit approval flag for the discovered matrix;
use `--ModelCatalog <json>` to pin the reviewed catalog when automating it.
`--UseExistingRoutes` explicitly reuses routes. `resume` preserves existing v2
model identities; changing this initialization feature does not rewrite them.

Recommended policies are recorded under `stages.work.escalation` with
`enabled: true, review_failures_before_upgrade: 2`, and
`stages.review.quota_fallback: true`. Each recommended Work tier has one Codex
route; review arrays are ordered high → medium → low for high tasks and
medium → low for medium tasks. Low review has a single route.

Fallback also requires `fallback_policy.enabled: true` in the relevant Planner
subtask/review. Worker timeout or failed deterministic verification upgrades
one tier after the process exits. Partial work stays in the same registered
worktree; each attempt keeps separate logs, patches and model sessions. Two
consecutive explicit reviewer FAILs at a tier cause the next `stage-work` to
upgrade; exact `stage-work-continue` cannot change models. PASS resets the
streak. The high tier is the ceiling. Review uses at least the implementation's
effective complexity and falls back only for recognized quota, retaining the
original patch/contract binding and actual final model. Negative verdicts,
auth/permission errors, mutation or cancellation never trigger a cheaper review.
Environment reviews use the same quota chain but remain advisory-only.

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
