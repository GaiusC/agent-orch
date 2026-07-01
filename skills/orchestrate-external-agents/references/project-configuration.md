# Project configuration

Copy `templates/project-config.json` from the plugin into `<project>/.agent-orchestrator/config.json`, review it, and set `trusted` to `true` only for a trusted repository.

## Required policy

```json
{
  "version": 1,
  "trusted": true,
  "roles": {
    "primary_writer": "cc",
    "specialist": "agy",
    "duplicate_implementation": false
  }
}
```

Keep `duplicate_implementation` false. The broker rejects CC implementation if CC is not the primary writer.

## Execution

- `workspace_mode`: use `isolated` by default. It creates a detached Git worktree and produces a patch.
- `allow_dirty_in_place`: keep false. Isolated execution requires a clean Git tree.
- `max_cc_repair_rounds`: deterministic failure repair rounds in the same CC session; default 2.
- `cc_timeout_seconds`, `agy_timeout_seconds`: hard worker limits.
- `max_log_bytes`: per-stream disk and memory cap.
- `max_result_chars`: maximum AGY result returned to Codex.

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
