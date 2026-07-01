# Routing, sessions, and cost

## Session policy

- Bind sessions by resolved project path, provider, and stable `task_id`.
- Continue the same session for the same goal, implementation, deterministic repair, and incremental acceptance feedback.
- Start a new session for an unrelated goal, project change, underlying model change, architecture reset, missing workspace, or polluted/oversized context.
- Never rely on ambiguous global `--continue`; the broker uses explicit CC session UUIDs and AGY conversation IDs.
- Keep the isolated worktree until acceptance or abandonment. Cleanup clears its session binding.

## Routing policy

| Situation | Route |
| --- | --- |
| Code implementation or test repair | CC |
| Reproduction or environment diagnosis | AGY investigate |
| Browser/UI/runtime verification | AGY verify |
| Non-overlapping module | CC by default; AGY only with explicit disjoint-write permission |
| CC deterministic test failure | Same CC session, bounded repair loop |
| Architecture, dependency, schema, security, or scope change | Return to Codex |
| CC unavailable or repeatedly fails | Return to Codex; do not silently switch writers |

## Model and cost policy

- Preserve ccswitch defaults unless a task-specific override is justified.
- Use low-cost models for narrow work, configured defaults for ordinary implementation, and expensive models only for difficult execution or high-risk verification.
- Changing the underlying model starts a new session unless the user explicitly accepts context transfer risk.
- Keep Codex tool results compact. Raw logs remain on disk.
- Avoid agent debate and duplicate implementations. Parallelize only independent, non-writing work.
