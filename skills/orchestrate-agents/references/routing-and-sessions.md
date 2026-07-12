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

- `host_provider=codex`: planner/accepter work is performed by the current Codex session. Do not invoke Codex CLI for those roles. Use MCP tools for all worker, reviewer, and job-control operations. MCP tools `codex-exec`, `codex-continue`, and `planner-plan` are blocked for codex hosts by policy.
- `host_provider=cc_desktop` or `claude_desktop`: the host may coordinate via MCP but is limited to `health`, `codex-exec`, `codex-continue`, `planner-plan`, `status`, `result`, `cancel`, `cleanup`. Worker launch, reviewers, auto, and apply are blocked.
- `host_provider=terminal`: minimum maintenance via MCP (`health`, `status`, `result`, `cancel`, `cleanup`). Use `resume` and project state to decide the next explicit command; do not infer hidden conversation context.
- External provider fallback must be recorded in events/current-state and reported to the user.

## Routing policy

All worker implementation, reviewer, and job-control operations are routed through MCP tools. The CLI only handles init, resume, health, dashboard, and MCP maintenance.

| Situation | MCP Tool |
| --- | --- |
| Code implementation or test repair (low/medium/high) | `auto` (routes to CC; escalates to AGY after CC verify failure) |
| Explicit CC execution | `cc-exec` / `cc-continue` |
| Explicit AGY write execution | `agy-exec` / `agy-continue` |
| Reproduction or environment diagnosis | `reviewer-investigate` |
| Browser/UI/runtime verification | `reviewer-verify` |
| Non-overlapping module | CC by default; AGY write only with explicit disjoint-write permission or auto router |
| CC deterministic test failure | Same CC session, bounded repair loop |
| CC verification fails after 2+ cycles | Auto router escalates to AGY write with Claude Sonnet 4.6 (Thinking) |
| Architecture, dependency, schema, security, or scope change | Return to Codex |
| CC unavailable or repeatedly fails | Return to Codex; do not silently switch writers |
| AGY write quota/credit/rate exhausted (during escalation) | Auto router falls back to CC high (deepseek-v4-pro) with evidence |
| AGY write auth/permission/internal error | Report to Codex; do NOT silently fall back |
| AGY auth probe fails | Report the missing gate; continue only for low-risk deterministic work or after user approval |

## MCP policy enforcement

The shared core policy module (`scripts/lib/policy.mjs`) enforces host-specific tool allow-lists at the MCP server level:

- **Codex** can use: `cc-exec`, `cc-continue`, `agy-exec`, `agy-continue`, `auto`, `reviewer-investigate`, `reviewer-verify`, `status`, `result`, `cancel`, `apply`, `cleanup`, `health`.
- **CC Desktop** can use: `health`, `codex-exec`, `codex-continue`, `planner-plan`, `status`, `result`, `cancel`, `cleanup`.
- **Terminal** can use: `health`, `status`, `result`, `cancel`, `cleanup`.
- **Unknown** hosts are denied all tools.

When `mcp.enabled` is false, only `health` is available. When `trusted` is false, only safe diagnostic tools (`health`, `status`, `result`, `cancel`, `cleanup`) are available.

## Automatic routing

The `auto` MCP tool routes all implementation contracts to CC by default:

- **Low complexity**: CC with `deepseek-v4-flash`.
- **Medium complexity**: CC with `deepseek-v4-flash`.
- **High complexity**: CC with `deepseek-v4-pro`.

### CC verification failure escalation

After CC completes with `verification_failed` and at least two verification/review cycles were attempted (initial attempt + at least one repair round), the auto router:

1. Cleans up the failed CC workspace and clears its session binding.
2. Executes the same contract with AGY write using the exact model `Claude Sonnet 4.6 (Thinking)`.
3. Records escalation evidence (`auto_route.provider: "agy_write"`, `fallback_occurred: true`, `original_provider: "cc"`, `reason: "cc_verification_failed"`).

The escalation requires `routing.cc_verify_fail_escalate_to_agy: true` (default) and AGY must be enabled.

### AGY quota fallback during escalation

When AGY write fails with a quota/credit/rate-exhaustion error during CC-to-AGY escalation:

1. Cleans up the failed AGY workspace and clears its session binding.
2. Executes the same contract with CC at high complexity using `deepseek-v4-pro`.
3. Records the full escalation chain evidence (`escalation_chain: ["cc", "agy_write", "cc_high"]`, `reason: "agy_quota_during_escalation"`).

To disable quota fallback, set `routing.agy_write_fallback_to_cc_on_quota: false` in project config. To disable CC-to-AGY escalation, set `routing.cc_verify_fail_escalate_to_agy: false`.

**Provider-aware calibration**: ordinary work estimated as CC-high may generally be treated as AGY-medium/Sonnet. Reserve AGY-high/Opus for exceptional complexity or risk.

### Legacy automatic routing (`agy_preferred`)

Configs with `routing.auto: "agy_preferred"` preserve the original behavior:

- **Low complexity**: routes to CC.
- **Medium complexity**: routes to AGY write with `Claude Sonnet 4.6 (Thinking)`.
- **High complexity**: routes to AGY write with `Claude Opus 4.6 (Thinking)`.

On AGY quota exhaustion, falls back to CC with the configured complexity model.

### Legacy direct CC routing (`cc`)

Configs with `routing.auto: "cc"` route all contracts to CC without escalation to AGY on verification failure. This is the minimal path with no external provider dependency.

### Migration compatibility

The default `routing.auto` value is `"cc_first"` (all complexities route to CC; AGY escalation after CC verification failure). Legacy project configs with `routing.auto` set to `"agy_preferred"` or `"agy"` keep their original behavior. Legacy configs with `"cc"` keep all-contract-CC behavior without escalation.

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

- CC uses a two-tier default policy: low and medium complexity route to `deepseek-v4-flash`, high complexity routes to `deepseek-v4-pro`. This applies to direct cc-exec/cc-continue, all auto routing, and CC high fallback after AGY quota during escalation.
- Per-contract explicit model overrides take priority over CC complexity defaults in every path.
- AGY write escalation (after CC verification failure) uses `Claude Sonnet 4.6 (Thinking)` exactly, regardless of the original contract complexity.
- AGY write models for direct agy-exec/agy-continue are separate from AGY investigation/verification models. Read-only AGY defaults (Gemini 3.5 Flash / Gemini 3.1 Pro) remain unchanged.
- AGY write uses Thinking models by default: `Claude Sonnet 4.6 (Thinking)` for medium, `Claude Opus 4.6 (Thinking)` for high.
- Use low-cost models for narrow work, configured defaults for ordinary implementation, and expensive models only for difficult execution or high-risk verification.
- Changing the underlying model starts a new session unless the user explicitly accepts context transfer risk.
- Provider-aware calibration: CC-high ~ AGY-medium/Sonnet. Reserve AGY-high/Opus for exceptional complexity or risk.
- Keep Codex tool results compact. Raw logs remain on disk.
- Avoid agent debate and duplicate implementations. Parallelize only independent, non-writing work.

## Review gate

Implementation jobs (CC or AGY write) require reviewer evidence before `apply` by default. This additional gate ensures an independent review has examined the implementation output before changes land in the project.

### Default behavior

When `review_gate.require_reviewer_for_implementation` is `true` (the default):

1. Every CC execute/continue, AGY execute/continue, and auto-execute job is created with `requires_agy_review: true`.
2. Before `apply`, the orchestrator searches for a completed reviewer verification job with the same `project_dir` and `task_id`.
3. If no matching reviewer evidence exists, `apply` is rejected with a clear error message.
4. Reviewer investigate/verify jobs are exempt - they are review work, not implementation.

Legacy projects may still use `require_agy_verify_for_implementation`; setting that legacy field to `false` is honored as a compatibility opt-out.

### Waivers

When `review_gate.allow_waiver` is `true` (the default), a job can bypass the review gate by setting `review_waiver: true` in the contract metadata. Waived jobs record the waiver in their job metadata and in the dashboard.

To enforce the gate without exception, set `allow_waiver: false` in the project config.

### Disabling the gate

Set `require_reviewer_for_implementation: false` to disable the review gate entirely. All implementation jobs will apply without requiring reviewer evidence.

### Dashboard visibility

The review-gate status is visible at multiple levels:

- **Project summary**: `review_blocked` count shows ready-for-acceptance jobs still requiring reviewer evidence.
- **Job detail**: `requires_agy_review`, `review_waiver`, `reviewer_job_id`, and legacy `agy_verify_job_id` fields show the gate status for each job.
- **Current state**: `review_gate_summary` lists total jobs requiring review and jobs ready but blocked.
- **Handoff**: recommends running `reviewer-verify` when blocked jobs are detected.
