# Routing and sessions

## Routing

`stage-work` reads the Planner subtask complexity and resolves the corresponding `stages.work.routes` chain. The caller cannot pass provider, model, or fallback overrides.

The default chain is CC, AGY write, then Codex Worker. A route advances only for classified retryable provider/runtime failures. Verification failure remains implementation evidence and does not automatically become a provider outage.

## Permissions

- CC: `bypassPermissions`.
- AGY write: explicit non-interactive permission in an isolated worktree.
- AGY review: headless tool permission plus a before/after patch-digest guard; current-turn output and `VERDICT: PASS` are mandatory.
- Codex Worker: `workspace-write` and approval policy `never`.

## Continuation

Sessions are keyed by project, provider, and task. They also record model and worktree.

`stage-work-continue` requires:

- prior work job;
- same task;
- terminal prior process;
- exact prior provider/model;
- persisted session id;
- existing original worktree.

No fallback is permitted during continuation.

## AGY environment

AGY receives current allowlisted environment, the last `resume` snapshot, and explicit `cli.agy_env`, in that precedence order. OAuth output aborts immediately with remediation.
