# Project configuration

Initialize a project with the Agent Orch CLI or copy `templates/project-config.json` into `<project>/.agent-orchestrator/config.json`, review it, and set `trusted` to `true` only for a trusted repository.

`init` also seeds `.agent-orchestrator/PROJECT.md`, `.agent-orchestrator/TODO.md`, and `.agent-orchestrator/HANDOFF.md` when they do not already exist. Treat these files as the project continuity surface for future Codex, CC, and AGY sessions. Do not overwrite user-maintained versions.

For a new project or early project framing, run a `grill-me` session before implementation if the goal, users, scope, architecture, or definition of done is still unresolved. Record the decisions in `PROJECT.md`, translate next work into `TODO.md` contracts, and keep `HANDOFF.md` accurate after each accepted or abandoned Agent Orch job.

## Required policy

```json
{
  "version": 1,
  "mode": "cli",
  "trusted": true,
  "mcp": { "enabled": false },
  "roles": {
    "primary_writer": "cc",
    "specialist": "agy",
    "duplicate_implementation": false
  },
  "host": {
    "provider": "unknown",
    "in_session_roles": ["coordinator"]
  },
  "providers": {
    "codex": {
      "roles": ["planner", "accepter"],
      "external_invocation": "disabled_when_host_is_codex"
    },
    "cc": { "roles": ["executor"], "invocation": "cli" },
    "agy": { "roles": ["reviewer", "executor_fallback"], "invocation": "cli" }
  }
}
```

Keep `duplicate_implementation` false. Codex should reject implementation if duplication is enabled.

When the current host is Codex, `providers.codex.external_invocation` must disable planner/accepter self-invocation. Planning and acceptance happen in the current Codex session, while workers are launched through MCP tools.

## MCP gate

`mcp.enabled` is the single project-level gate for MCP tool access:

- When `true`, MCP tools are available subject to host allow-list and trust validation.
- When `false`, only the `health` MCP tool is available; all other tools return a structured denial.
- `cc_desktop` / `claude_desktop` `init` and `resume` enable `mcp.enabled: true` automatically.
- `codex` and `terminal` hosts keep `mcp.enabled: false` by default (MCP tools are accessed via the plugin's auto-registered MCP server; terminal hosts manage MCP manually).
- `resume` without an explicit host provider preserves the existing `mcp.enabled` value.
- Run `agent-orch mcp install` to enable MCP and write the `.mcp.json` server entry.
- Run `agent-orch mcp repair` to fix broken MCP configuration.
- Run `agent-orch mcp remove` to disable MCP and remove the `.mcp.json` entry.
- Run `agent-orch mcp status` to inspect current MCP configuration.

## Host policy

The `host.provider` field determines which MCP tools are available via the shared policy module:

| Host | Allowed MCP Tools |
| --- | --- |
| `codex` | `cc-exec`, `cc-continue`, `agy-exec`, `agy-continue`, `auto`, `reviewer-investigate`, `reviewer-verify`, `status`, `result`, `cancel`, `apply`, `cleanup`, `health` |
| `cc_desktop` / `claude_desktop` | `health`, `codex-exec`, `codex-continue`, `planner-plan`, `status`, `result`, `cancel`, `cleanup` |
| `terminal` | `health`, `status`, `result`, `cancel`, `cleanup` |
| `unknown` | none |

When `trusted: false`, only safe diagnostic tools are available regardless of host: `health`, `status`, `result`, `cancel`, `cleanup`.

## Continuity and generated state

- `agent-orch resume -ProjectDir <project> -HostProvider <host>` is the first command for every host.
- `.agent-orchestrator/events.jsonl` is the append-only machine timeline.
- `.agent-orchestrator/current-state.json` is the latest resumable state.
- `.agent-orchestrator/handoff.generated.md` is generated from machine state and should be read before handwritten handoff notes.
- `.agent-orchestrator/open-dashboard.ps1` is seeded by `init` for direct dashboard access.

## Routing

- `routing.auto`: `"cc_first"` (default) routes all complexities to CC. After two failed CC verification/review cycles, escalates to AGY write with `Claude Sonnet 4.6 (Thinking)`. Legacy values: `"agy_preferred"` (low to CC, medium/high to AGY write with Thinking models) and `"cc"` (all to CC without escalation) remain compatible.
- `routing.agy_write_fallback_to_cc_on_quota`: default `true`. When AGY write fails with a quota/credit/rate-exhaustion error, the auto router cleans up the AGY workspace and retries with CC. Set to `false` only when you want quota errors to surface directly.
- `routing.cc_verify_fail_escalate_to_agy`: default `true`. When CC completes with `verification_failed` after at least two verification/review cycles, the auto router escalates the contract to AGY write using `Claude Sonnet 4.6 (Thinking)`. Set to `false` to disable this escalation and let CC failures stand as-is.

## Execution

- `workspace_mode`: use `isolated` by default. It creates a detached Git worktree and produces a patch.
- `allow_dirty_in_place`: keep false. Isolated execution requires a clean Git tree.
- `max_cc_repair_rounds`: deterministic failure repair rounds in the same session; default 2.
- `cc_timeout_seconds`, `agy_timeout_seconds`, `agy_write_timeout_seconds`: hard worker limits.
- `max_log_bytes`: per-stream disk and memory cap.
- `max_result_chars`: maximum result returned to Codex.
- `.agent-orchestrator/state`: session registry and local state.
- `.agent-orchestrator/runs`: job evidence, logs, and patches.

## Antigravity CLI

- `agy.enabled`: keep true when AGY should remain available as a verifier or writer.
- `agy.auth_probe_required`: keep true by default. The CLI checks AGY availability before launching longer work.
- `agy.fail_fast_on_auth_window`: documents that Codex should stop quickly if AGY cannot use silent auth.
- `cli.agy_sandbox`: default false for local desktop workflows where sandboxed print mode cannot access normal silent-auth state.
- `cli.agy_project` / `cli.agy_project_id`: optional existing Antigravity project identifier. When set, the broker passes `--project <id>` to avoid creating implicit projects for each worker probe.
- `cli.agy_prefix_args`: advanced escape hatch for site-specific wrapper arguments. Prefer the dedicated AGY fields above for project binding and sandbox behavior.

## Claude Code CLI

- `cli.claude_permission_mode`: default `bypassPermissions` for Agent Orch worker sessions. CC already runs against an isolated worktree by default, and Codex accepts or rejects the resulting patch after inspection. Use a stricter value only when the local CC account can complete non-interactive Bash and edit work without blocking.
- `cli.claude_prefix_args`: wrapper arguments for site-specific launch needs. Prefer `claude_permission_mode` over wrapper hacks for approval behavior.

## Models

Set provider model names per complexity only when the installed CLI and current account support them. A null value preserves CLI/ccswitch defaults.

```json
{
  "models": {
    "cc": { "low": "deepseek-v4-flash", "medium": "deepseek-v4-flash", "high": "deepseek-v4-pro" },
    "agy": {
      "low": "Gemini 3.5 Flash",
      "medium": "Gemini 3.1 Pro",
      "high": "Gemini 3.1 Pro"
    },
    "agy_write": {
      "low": null,
      "medium": "Claude Sonnet 4.6 (Thinking)",
      "high": "Claude Opus 4.6 (Thinking)"
    }
  }
}
```

- `models.cc`: two-tier policy. Low and medium complexity use `deepseek-v4-flash`; high complexity uses `deepseek-v4-pro`. An explicit per-contract model override takes precedence over these defaults. All CC paths use this tiering: direct cc-exec/cc-continue, low auto routing, and CC fallback after AGY quota exhaustion. **Migration**: legacy configs with `null` CC model values are automatically normalized to these two-tier defaults at load time and on `init`; any non-empty user model string is preserved.
- `models.agy`: read-only investigation/verification models. Use AGY CLI model names, not UI labels with effort suffixes.
- `models.agy_write`: separate write-mode model configuration. Defaults to Thinking models: `Claude Sonnet 4.6 (Thinking)` for medium, `Claude Opus 4.6 (Thinking)` for high. These are the exact model names passed to `agy --model`.

AGY write models are independent of AGY investigation models. Read-only defaults (Gemini 3.5 Flash / Pro) are not affected by agy_write configuration.

## Scope and verification

`scope.writable` documents allowed implementation paths. `scope.forbidden` is enforced against the generated patch. Configure real project commands under `verification.commands`, ordered from fastest to broadest. Stop at the first failure.

Treat configuration as executable policy because verification commands run in a shell. Review repository-provided configuration before setting `trusted` to true.

## Review gate

The review gate ensures implementation jobs receive independent verification before changes are applied. It is enabled by default.

```json
{
  "review_gate": {
    "require_reviewer_for_implementation": true,
    "allow_waiver": true
  }
}
```

- **`require_reviewer_for_implementation`** (default `true`): When enabled, CC execute/continue, AGY execute/continue, and auto-execute jobs are marked as requiring reviewer evidence. The `apply` command requires a completed reviewer verification job for the same `project_dir` and `task_id` before the patch can land. Reviewer investigate/verify jobs are exempt. Legacy `require_agy_verify_for_implementation: false` is still honored for older projects.
- **`allow_waiver`** (default `true`): When enabled, a job can bypass the review gate by setting `review_waiver: true` in the contract metadata. Waived jobs record the waiver in job metadata and the dashboard. Set to `false` to require reviewer evidence on every implementation without exception.

**Disabling the gate**: Set `require_reviewer_for_implementation` to `false` to disable review-gate enforcement entirely. All implementation jobs will apply without requiring reviewer evidence.

**Dashboard visibility**: The review-gate status appears in:
- Project summary (`review_blocked` count, per-job `requires_agy_review` / `review_waiver` fields)
- Current state (`review_gate_summary` with blocked job IDs)
- Handoff generation (recommends `reviewer-verify` for blocked jobs)


## Workflow policy

For substantial changes, create small contracts and require a reviewer gate for high-risk behavior. See [role-boundaries-and-workflow.md](role-boundaries-and-workflow.md).

## MCP-driven architecture

Agent Orch is now MCP-driven. Worker implementation, reviewer, and job-control operations are only available through MCP tools. The CLI is restricted to project lifecycle (init, resume, health), dashboard, and MCP maintenance (mcp status, mcp install, mcp repair, mcp remove).

The shared core policy module (`scripts/lib/policy.mjs`) enforces host identity, tool allow-lists, and trust decisions before any lower-layer execution. See [routing-and-sessions.md](routing-and-sessions.md) for the complete host x tool matrix.

To enable MCP: run `agent-orch init -ProjectDir . -HostProvider cc_desktop` (which enables mcp.enabled) or run `agent-orch mcp install` on an existing project.
