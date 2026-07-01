# Project configuration

Initialize a project with the Agent Orch CLI or copy `templates/project-config.json` into `<project>/.agent-orchestrator/config.json`, review it, and set `trusted` to `true` only for a trusted repository.

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
  }
}
```

Keep `duplicate_implementation` false. Codex should reject CC implementation if CC is not the primary writer.

## Execution

- `workspace_mode`: use `isolated` by default. It creates a detached Git worktree and produces a patch.
- `allow_dirty_in_place`: keep false. Isolated execution requires a clean Git tree.
- `max_cc_repair_rounds`: deterministic failure repair rounds in the same CC session; default 2.
- `cc_timeout_seconds`, `agy_timeout_seconds`: hard worker limits.
- `max_log_bytes`: per-stream disk and memory cap.
- `max_result_chars`: maximum AGY result returned to Codex.
- `.agent-orchestrator/state`: session registry and local state.
- `.agent-orchestrator/runs`: job evidence, logs, and patches.

## Antigravity CLI

- `agy.enabled`: keep true when AGY should remain available as a verifier.
- `agy.auth_probe_required`: keep true by default. The CLI checks AGY availability before launching longer work.
- `agy.fail_fast_on_auth_window`: documents that Codex should stop quickly if AGY cannot use silent auth.
- `cli.agy_sandbox`: set false when the local AGY install cannot access its normal silent-auth state from sandboxed print mode.
- `cli.agy_project` / `cli.agy_project_id`: optional existing Antigravity project identifier. When set, the broker passes `--project <id>` to avoid creating implicit projects for each worker probe.
- `cli.agy_prefix_args`: advanced escape hatch for site-specific wrapper arguments. Prefer the dedicated AGY fields above for project binding and sandbox behavior.

## Models

Set provider model names per complexity only when the installed CLI and current account support them. A null value preserves CLI/ccswitch defaults.

```json
{
  "models": {
    "cc": { "low": null, "medium": null, "high": null },
    "agy": {
      "low": "Gemini 3.5 Flash (Medium)",
      "medium": "Gemini 3.1 Pro (Low)",
      "high": "Gemini 3.1 Pro (High)"
    }
  }
}
```

Do not force a Claude model name when ccswitch should select GLM, DeepSeek, or another configured backend. Record an explicit override only when the user requests it. The default AGY routing uses Flash for low-risk work and escalates Pro reasoning effort with complexity; replace the labels if the installed AGY version exposes different names.

## Scope and verification

`scope.writable` documents allowed implementation paths. `scope.forbidden` is enforced against the generated patch. Configure real project commands under `verification.commands`, ordered from fastest to broadest. Stop at the first failure.

Treat configuration as executable policy because verification commands run in a shell. Review repository-provided configuration before setting `trusted` to true.

## Legacy MCP

MCP is no longer the default path. Use it only when a single-account environment can keep Codex MCP configuration stable. The default project config should keep `mcp.enabled` false.
