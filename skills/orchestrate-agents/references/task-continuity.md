# Task continuity, branches and closure (0.8.3)

## Identity and handoff

Use the user's original project. `task_id` identifies the logical deliverable;
`owner_session_id` and monotonic `epoch` identify the current coordinator. Native
Plan provider/model/session/contract identity stays immutable. Runtime authority
lives in `tasks/<task_id>.json`; never edit it manually.

1. `task-handoff {mode:"inspect",task_id}` returns compact owner, epoch, branches,
   active job counts and evidence path.
2. The current owner uses `prepare`, `expected_epoch`, reason and optional
   `to_session_id`; retain its handoff id.
3. The destination uses `claim`, exact epoch/id, actual session identity,
   `confirm:true` reflecting the user's transfer instruction and concrete reason.
4. If the original chat is unavailable, explicitly approved `recover` names
   `from_session_id` and current epoch. Time alone never grants ownership.

In-flight authorized workers continue with their existing worktree/model/session;
the previous coordinator is fenced. Separate observers keep independent consumer
cursors. A provider/invocation change needs a new independent Plan. A host-model
change requires `allow_model_change:true` and verified host identity. Finalization
in progress blocks transfer. Legacy jobs supervised by another live old runtime
must first reconnect to the upgraded runtime; do not spoof the old owner.

## Branch recommendation and initialization

The target comes from recorded binding, explicit `git_lifecycle.target_branch`,
local origin default, then current branch. It is never guessed as `main`.
An independent deliverable recommends a new `codex/<task-id>` ref. Continue the
recorded binding for the same task. Review existing history before explicit reuse;
branch names do not prove ownership. Pass `reuse_from_task_id` for a known prior
task; all its subtasks must be committed, workspaces retired and providers stopped.
The predecessor is then superseded and cannot resume writing that branch.

Use `stage-plan.branch` with mode create/reuse/current and `confirm:true`, or
prepare/execute `environment-reconcile` action `bind_branch` with a task id,
reason, choice and epoch. New tasks without a choice cannot start Work. Legacy
jobs continue under compatibility gates. Recommended automatic branch creation
requires the user's explicit `branch_policy:"recommended_auto"` approval.

`--UseRecommendedGitPolicy` approves fresh managed branches, accepted exact local
auto-commits, merge by confirmation and safe cleanup. Existing model routes are
preserved; existing Git policies remain unless explicitly changed. Options include
`commit_policy:ask|auto|manual`, `merge_policy:ask|auto`, `delete_task_branches`,
`allow_verified_baseline_advance`, worker/total limits and integration reservation.
There is no implicit push, remote publication or history-rewrite authorization.

## Commit, merge and retire are separate

- Commit after independent Review and native Accept, with deterministic final
  checks and exact paths. Worker prose, unfinished code, unresolved conflicts,
  secret files, unclear ownership and failed review do not authorize delivery.
- New task branches commit in the owned detached workspace with normal hooks.
  Preserve a durable ref, tree, patch digest, acceptance and evidence hashes first.
  Cleanup can then release the directory while `committed_pending_merge` remains.
- Merge only under the separate policy. Never advance a branch checked out by
  another workspace. A clean checked-out target uses normal fast-forward merge
  with ignored-file protection; an unchecked target uses expected-tip CAS.
- When target/history diverges, make a new integration Plan. Use 2-8 accepted
  `job_ids`, or one committed pending `target_job_id`. Fresh independent Review
  and Accept bind the new combined patch. Conflicts remain in its workspace.
- Delete only managed merged branches at their exact expected tip, with every
  subtask delivered and no active job/worktree/reference. Unknown history,
  retained artifacts or external commits defer deletion. Durable task refs and
  evidence survive cleanup and GC. No automatic rebase or force merge is offered.

Normal cleanup refuses unique ignored/untracked artifacts or live processes.
For abandoned work, prepare an explicit `cleanup` action with `disposition:wip`;
retain reachable checkpoint plus staged/working patches before directory removal.
The original session cannot continue after removal. Environment commit/WIP/cleanup
actions also enforce task ownership and the epoch captured when prepared.

## Baseline and capacity

Defaults: three managed Worker worktrees, five total auxiliary workspace slots;
the original checkout is not an extra slot. External linked worktrees and audited
coordinator copies consume the shared original project's total. Reserve one slot
for integration when total exceeds worker limit. Existing explicit caps remain.
At capacity wait or return attention; never clone to evade limits.

Only a chain of accepted, repository-bound delivery receipts may carry a dirty
HEAD baseline forward. Preserved file bytes and staged entries must match,
committed paths must be disjoint, and unrelated index entries/flags must remain
unchanged. An index stat refresh can be recognized semantically. Unknown edits,
ref moves, external commits or changed historical content require a fresh audit.
Queued, unstarted task branches may adopt a verified/explicitly approved newer
target at slot admission. Running work keeps its baseline. Task branches refuse
silently replacing their base with a dirty snapshot; reconcile inherited changes
to reviewed commits first. Legacy readiness without the new fields needs one
fresh audit.

## Legacy repository identity

An old native contract missing `repository_identity` is not rewritten. Recovery
requires matching immutable Plan project/common directory, contract digest,
recorded Work origin and actual shared worktree ancestry. Generate a fresh native
Review with the derived provenance, then Accept in the rightful original owner or
explicit successor. Prior null Review receipts remain historical and cannot be
patched into acceptance evidence. Foreign, missing or inconsistent proof fails
closed. Auditor state is a view, never an acceptance authority.
