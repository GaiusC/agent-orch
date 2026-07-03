# Routing, sessions, and cost

## Session policy

- Bind sessions by resolved project path, provider, and stable `task_id`.
- Continue the same session for the same goal, implementation, deterministic repair, and incremental acceptance feedback.
- Start a new session for an unrelated goal, project change, underlying model change, architecture reset, missing workspace, or polluted/oversized context.
- Never rely on ambiguous global `--continue`; Agent Orch uses explicit CC session UUIDs and AGY conversation IDs when available.
- Keep the isolated worktree until acceptance or abandonment. Cleanup clears its session binding.

## Routing policy

| Situation | Route |
| --- | --- |
| Code implementation or test repair | `agent-orch cc-exec` / `cc-continue` |
| Reproduction or environment diagnosis | `agent-orch agy-investigate` |
| Browser/UI/runtime verification | `agent-orch agy-verify` |
| Non-overlapping module | CC by default; AGY only with explicit disjoint-write permission |
| CC deterministic test failure | Same CC session, bounded repair loop |
| Architecture, dependency, schema, security, or scope change | Return to Codex |
| CC unavailable or repeatedly fails | Return to Codex; do not silently switch writers |
| Required AGY gate passes | Codex may accept after local diff and command inspection |
| Required AGY gate fails | Reject or send bounded repair feedback to the same CC session |
| AGY auth probe fails | Report the missing gate; continue only for low-risk deterministic work or after user approval |

## Contract sizing

- Use one contract for one coherent behavior change.
- Split broad work by boundary: data model, API behavior, worker/runtime behavior, UI behavior, deployment, and documentation.
- Prefer serial contracts when later work depends on earlier acceptance.
- Parallelize multiple CC contracts only when their writable paths are disjoint or they are read-only, and keep separate `task_id` values so sessions and worktrees remain isolated.
- Keep AGY verification serialized by default in local desktop workflows. A parallel smoke test on 2026-07-04 showed one of two concurrent AGY print-mode jobs completed while the other timed out after token/auth errors, while a follow-up sequential AGY job completed successfully.
- Parallelize AGY only after a local smoke test shows the current AGY account can run multiple print-mode jobs concurrently. If not proven, use one AGY gate at a time.
- Run CC and one AGY investigation in parallel when AGY is read-only and the CC contract does not depend on that investigation result. Otherwise, investigate first and implement second.
- Keep the same `task_id` for repair and acceptance feedback. Use a new `task_id` for a new contract.

## Model and cost policy

- Preserve ccswitch defaults unless a task-specific override is justified.
- Use low-cost models for narrow work, configured defaults for ordinary implementation, and expensive models only for difficult execution or high-risk verification.
- Changing the underlying model starts a new session unless the user explicitly accepts context transfer risk.
- Keep Codex tool results compact. Raw logs remain on disk.
- Avoid agent debate and duplicate implementations. Parallelize only independent, non-writing work.
