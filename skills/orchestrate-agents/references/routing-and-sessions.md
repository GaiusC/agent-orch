# Routing, sessions, and cost

## Session policy

- Before starting or continuing substantial work, run `agent-orch resume -ProjectDir <project> -HostProvider <host>` and read `.agent-orchestrator/current-state.json`, `.agent-orchestrator/handoff.generated.md`, `.agent-orchestrator/PROJECT.md`, `.agent-orchestrator/TODO.md`, and `.agent-orchestrator/HANDOFF.md` so routing is grounded in persisted project state, not only the current chat.
- Bind sessions by resolved project path, provider, and stable `task_id`.
- For AGY write sessions, bind by `agy_write` provider namespace (distinct from read-only `agy` sessions).
- Continue the same session for the same goal, implementation, deterministic repair, and incremental acceptance feedback.
- Start a new session for an unrelated goal, project change, underlying model change, architecture reset, missing workspace, or polluted/oversized context.
- Never rely on ambiguous global `--continue`; Agent Orch uses explicit CC session UUIDs and AGY conversation IDs when available.
- Keep the isolated worktree until acceptance or abandonment. Cleanup clears its session binding.
- After acceptance, rejection, or abandonment, update `HANDOFF.md` and `TODO.md` with job IDs, evidence paths, completed contracts, remaining contracts, blockers, and the next recommended action.

## Host/provider policy

- `host_provider=codex`: planner/accepter work is performed by the current Codex session. Do not invoke Codex CLI for those roles.
- `host_provider=claude_desktop` or `cc_desktop`: the host may coordinate and continue CC work, but Codex acceptance must either happen back in Codex or through an explicitly configured accepter fallback.
- `host_provider=terminal`: use `resume` and project state to decide the next explicit command; do not infer hidden conversation context.
- External provider fallback must be recorded in events/current-state and reported to the user.

## Routing policy

| Situation | Route |
| --- | --- |
| Code implementation or test repair (default low) | `agent-orch cc-exec` / `cc-continue` |
| Code implementation or test repair (medium, AGY preferred) | `agent-orch auto` (routes to AGY with Claude Sonnet 4.6 (Thinking)) |
| Code implementation or test repair (high, AGY preferred) | `agent-orch auto` (routes to AGY with Claude Opus 4.6 (Thinking)) |
| Explicit AGY write execution | `agent-orch agy-exec` / `agy-continue` |
| Reproduction or environment diagnosis | `agent-orch agy-investigate` |
| Browser/UI/runtime verification | `agent-orch agy-verify` |
| Non-overlapping module | CC by default; AGY write only with explicit disjoint-write permission or auto router |
| CC deterministic test failure | Same CC session, bounded repair loop |
| Architecture, dependency, schema, security, or scope change | Return to Codex |
| CC unavailable or repeatedly fails | Return to Codex; do not silently switch writers |
| AGY write quota/credit/rate exhausted | Auto router falls back to CC with evidence; direct agy-exec reports the error |
| AGY write auth/permission/internal error | Report to Codex; do NOT silently fall back |
| AGY auth probe fails | Report the missing gate; continue only for low-risk deterministic work or after user approval |

## Automatic routing

The `auto` command routes implementation contracts based on complexity:

- **Low complexity**: routes to CC (uses configured CC models, preserving ccswitch defaults).
- **Medium complexity**: routes to AGY write with the exact model name `Claude Sonnet 4.6 (Thinking)`.
- **High complexity**: routes to AGY write with the exact model name `Claude Opus 4.6 (Thinking)`.

**Provider-aware calibration**: ordinary work estimated as CC-high may generally be treated as AGY-medium/Sonnet. Reserve AGY-high/Opus for exceptional complexity or risk.

### Quota fallback

When AGY write fails with an explicit quota/credit/rate-exhaustion error, the auto router:

1. Cleans up the failed AGY workspace and clears its session binding.
2. Automatically executes the same contract with CC.
3. Records route evidence (`auto_route.provider: "cc"`, `fallback_occurred: true`, `reason: "quota_exhaustion"`).

The fallback classifier is narrow and tested -- it only matches patterns like `429`, `RESOURCE_EXHAUSTED`, `quota exceeded`, `rate limit`, `credit exhausted`, `billing limit`, `usage limit`, etc. It explicitly excludes authentication, permission, internal, test, and arbitrary runtime failures.

To disable quota fallback, set `routing.agy_write_fallback_to_cc_on_quota: false` in project config.

### Migration compatibility

The default `routing.auto` value is `"agy_preferred"` (low -> CC, medium/high -> AGY write). Legacy project configs with `routing.auto` set to `"cc"` keep all-contract-CC behavior. Legacy configs with `"agy"` behave identically to `"agy_preferred"`. The auto router is a separate path that coexists with legacy CC commands.

## Contract sizing

- Use one contract for one coherent behavior change.
- Split broad work by boundary: data model, API behavior, worker/runtime behavior, UI behavior, deployment, and documentation.
- Prefer serial contracts when later work depends on earlier acceptance.
- Parallelize multiple CC contracts only when their writable paths are disjoint or they are read-only, and keep separate `task_id` values so sessions and worktrees remain isolated.
- When multiple disjoint contracts run in parallel, allocate one AGY write worker. Retain at most one concurrent AGY by default on this machine.
- Keep AGY investigation/verification serialized by default in local desktop workflows. A parallel smoke test on 2026-07-04 showed one of two concurrent AGY print-mode jobs completed while the other timed out after token/auth errors, while a follow-up sequential AGY job completed successfully.
- Parallelize AGY write only after a local smoke test shows the current AGY account can run multiple concurrent write jobs. If not proven, use one AGY write worker at a time.
- Run CC and one AGY investigation in parallel when AGY is read-only and the CC contract does not depend on that investigation result. Otherwise, investigate first and implement second.
- Keep the same `task_id` for repair and acceptance feedback. Use a new `task_id` for a new contract.

## Model and cost policy

- CC uses a two-tier default policy: low and medium complexity route to `deepseek-v4-flash`, high complexity routes to `deepseek-v4-pro`. This applies to direct cc-exec/cc-continue, low auto routing, and CC fallback after AGY quota exhaustion.
- Per-contract explicit model overrides take priority over CC complexity defaults in every path.
- AGY write models are separate from AGY investigation/verification models. Read-only AGY defaults (Gemini 3.5 Flash / Gemini 3.1 Pro) remain unchanged.
- AGY write uses Thinking models by default: `Claude Sonnet 4.6 (Thinking)` for medium, `Claude Opus 4.6 (Thinking)` for high.
- Use low-cost models for narrow work, configured defaults for ordinary implementation, and expensive models only for difficult execution or high-risk verification.
- Changing the underlying model starts a new session unless the user explicitly accepts context transfer risk.
- Provider-aware calibration: CC-high ~ AGY-medium/Sonnet. Reserve AGY-high/Opus for exceptional complexity or risk.
- Keep Codex tool results compact. Raw logs remain on disk.
- Avoid agent debate and duplicate implementations. Parallelize only independent, non-writing work.
