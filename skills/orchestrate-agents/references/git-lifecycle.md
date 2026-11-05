# Git lifecycle

Normal work ends in a commit and a closeout receipt. Dirty inherited work is
audited before execution, not copied into an automatic clone. A clean status is
not proof that a directory is disposable. Uncommitted work may remain when it
has an explicit owner/disposition; report that residual truthfully.

## Configuration and initialization

`init` and `resume` return an environment audit index when Git has a baseline.
New projects can establish their initial commit through reviewed exact-path
reconciliation. No-model-selection responses still write no project files.
`--GitPolicyFile <json>` supplies the user's policy; terminal init offers the
commit-policy choice. Existing policy survives resume.

```json
{
  "commit_policy": "ask",
  "target_branch": null,
  "max_worker_worktrees": 3,
  "max_worktrees": 5,
  "max_workspace_bytes": null,
  "allow_snapshot": false,
  "allow_in_place": false
}
```

`auto` authorizes only local commits after acceptance and final verification.
`ask` requires concrete per-milestone authorization. `manual` records a user-made
commit through `stage-finalize.record_commit` and verifies its accepted file
states; it does not create another commit. Push/release/history rewriting are
separate permissions. `target_branch` restricts the delivery branch if set.

For new task branches, use the separate `merge_policy` (ask by default). Commit,
merge and cleanup have independent states; a protected task commit may release
its directory while waiting for merge. Read [task-continuity.md](task-continuity.md)
for branch selection/reuse, owner/epoch handoff, pending-merge recovery, integration
and verified baseline carry. The original Plan and old review receipts stay intact.

The total worktree limit excludes the canonical source directory and includes
registered external linked worktrees. A worker cap and one integration slot
prevent unlimited expansion. `execution.workspace_wait_timeout_seconds` defaults
to 1800; capacity waits are cancellable and send one attention report. They never
create clones or evict unfinished work. The byte budget checks current linked
directories plus the estimated tracked checkout size before allocation; it is
admission control, not an operating-system disk quota. Dependencies, data and
artifacts should use configured external locations; no writable hardlink sharing
is introduced.

## Audit and provenance

Keep one existing project as the coordinator across new Plans and jobs. Audit
that original project first and include known historical coordinator copies in
`clone_paths`. Copying tracked files followed by `git init` creates another
independent repository just as a clone does for lifecycle purposes; its clean
status and separate worktree quota do not reconcile the original environment.
Do not create a clean coordinator first and audit only that copy afterward.

`stage-work` owns Worker worktree allocation. A new Plan, a failed job, a dirty
source, a provenance error or a long path does not itself authorize a separate
coordinator. Diagnose continuation errors with the original job/session and
recorded workspace ancestry. Missing legacy `owner_job_id` can be recovered only
from same-project, same-task continuation ancestry that resolves to the original
job's worktree; historical evidence is not rewritten. If recovery cannot prove
identity, preserve the workspace and report the blocker. A necessary relocation
needs a concrete source/destination, reason, reuse assessment and disposition of
existing directories; inspect it before treating a new repository as approved.

Runtime identity is stored in `.agent-orchestrator/project-identity.json` and the
Git common directory's `agent-orch/project-identity.json`, separately from model
routes. Copied identities, enclosing Git repositories, and the exact Codex
caller's session-header project identify the original source. CLI init/resume,
MCP stage mutations and Worker allocation validate the binding. A clean new copy
and its own audit cannot authorize execution. Read-only job inspection, cancel
and cleanup remain available for recovery; new execution requires registration.
New native Plans persist the project id and coordinator Git common directory;
copying their execution identity into another coordinator is refused even after
that coordinator is registered. Legacy Plan bytes remain unchanged.

New native Plans derive an omitted `repository_identity` from the actual Git
common directory before computing the contract digest; explicit existing labels
are retained. Older native Plans that omitted it can produce fresh repository
proof only when the immutable Plan project/common directory and contract digest,
the current project binding, and the recorded Work source/worktree repository all
agree. Recovery does not rewrite the contract, Plan identity or failed receipts.
After loading the repaired runtime, run a fresh native Review before Accept when
the review gate is required. Repeating Review with an older installed runtime
cannot repair the missing provenance. Unverifiable bindings remain blocked;
never fill receipts manually or use a placeholder repository label.

To retain a necessary independent coordinator, audit the **original** project
with the copy's absolute path in `clone_paths`. Prepare and approve:

```json
{
  "kind": "register_coordinator",
  "path": "C:/projects/example-short",
  "reason": "Reviewed relocation required by path-length constraints"
}
```

Use the existing `environment-reconcile` prepare/execute protocol and an approved
`head` or `snapshot` baseline. The source and target audit fingerprints are
checked. A `block` baseline cannot execute through the copy. If the original
source changes, re-audit and renew registration. Existing unrelated modifications
still require explicit preserve/commit/WIP dispositions. Registration neither
copies files nor alters routes, old jobs, source history or remote state.

Registered coordinator checkouts and all their linked worktrees share the
canonical repository's lifecycle lock, pool registry and limits. The original
directory is excluded; each independent copy itself consumes a total-workspace
slot. A copy's higher local limits cannot raise the original policy. Active
legacy allocations in enrolled copies are included. Missing or replaced enrolled
repositories stop allocation for inspection instead of silently freeing slots.

This gate controls Agent Orch execution and allocation, not arbitrary host shell
filesystem operations. Without inherited identity, nesting or caller context,
an unrelated standalone repository cannot be inferred to be a copy. Do not erase
that provenance or omit known copies from the audit. Retaining evidence does not
require keeping every checkout:
normally finalize with cleanup enabled; retain a worktree only for a stated
active dependency, then close it after that dependency ends.

Call `environment-audit` with project_dir, a compact context packet, optional
explicit clone_paths, and optionally measure=true for directory-byte measurement.
Previously supplied clone paths are remembered. There is no global filesystem
scan. Default output is counts plus audit_id/fingerprint/evidence_path; full
inventories remain on disk. Read-only inspection does not run git add -N or
refresh the real index; it never edits source/branches/stashes.

On Windows, large preservation sets do not expand Git process arguments:
readiness creation and carry-forward read the complete NUL-delimited stage index
and filter exact paths in process. Matching retains every stage, Git ordering,
filename whitespace and the final NUL; pathspecs or case folding are not used.
Environment review passes only bounded metadata, a context preview, and the
audit file path/digest to the provider. The reviewer must read the complete
on-disk audit; the preview is not a substitute for evidence. Audit contents remain
untrusted evidence and the existing before/after fingerprint checks still apply.

The context packet distinguishes known facts with evidence, inferences, user
permissions, task goals, and unknowns. Historical changes are labeled
preexisting_or_external, task_relation=unknown, completion=unknown,
authorization=preserve. Reviewer prose cannot upgrade provenance or permission.
An environment reviewer runs on the configured Review route and reports through
the existing wait-for-job protocol. Its evidence has review_kind=environment,
advisory_only=true and code_acceptance=false, and is never formal review evidence.
Before/after fingerprints detect concurrent modifications; they cannot prove who
made them or undo an external writer. Git operations/conflicts block mutation,
while audits can still report them.

## Concrete reconciliation

Prepare with audit_id, mode=prepare, actions, and baseline=head|snapshot|block.
Every non-cleanup action names exact paths and a reason; commit/WIP also supplies
a message. Do not silently classify or commit user history.

Actions:
- preserve: retain the listed historical modifications.
- commit: submit an explicitly approved, complete group using an isolated index.
- wip: save selected unfinished content to a new explicit codex/ branch, without
  moving the original branch or changing its files/index by default.
  clear_saved_paths=true explicitly restores only the saved paths to source HEAD;
  this must appear in the approved plan. WIP is not code acceptance.
- cleanup: name a registered job. Normal cleanup requires a delivery commit;
  disposition=wip explicitly preserves a local checkpoint and staged/working
  patch receipts before retiring incomplete work. Active references, unresolved
  Git operations, or ignored unique artifacts block retirement.

Execute with the prepared plan_id, same audit_id, mode=execute, confirm=true.
Main-chat confirmation must reflect actual user authorization, not reviewer
opinion. Source/worktree fingerprints are rechecked. Completed actions are
journaled; repeated completed plans return already_reconciled. A concurrent change
or interruption with ambiguous state stops and requires inspection, never reset.
Unknown clones remain manual-only. There is no automatic discard action.

An approved HEAD baseline can preserve unrelated dirty files. A snapshot baseline
also needs allow_snapshot=true and captures the explicitly reviewed dirty file
set into a reachable local ref; sensitive paths are refused. Snapshots/WIP record
file state; index/working distinctions need their separate receipts. Snapshots
are exceptions for takeover/recovery, not the normal way to end completed work.

## Task finalization and recovery

Git operations also produce durable audit receipts in `runs/<job>/git-operations/`
and project into the existing `events.jsonl`. Auditor combines these with Plan,
Work, Review and Accept records. Worktree bases and integration input/checkpoint
objects are internal evidence, not delivery commits or invented feature branches.
Only finalization (or a verified recorded manual commit) establishes delivery.
Do not hand-edit receipts or infer missing occurrence times from file mtimes.
Retries reuse successful operation IDs; conflicts and blocked attempts remain
visible. Auditor refresh is manual and does not monitor arbitrary external Git
commands.

After formal Review/Accept, use stage-finalize with job_id, optional commit_message,
confirm_commit under ask policy, and cleanup (default true). It validates the
accepted patch, applies once, checks actual target content, reruns acceptance
commands, stages only exact task paths in a temporary index, and creates a local
commit. Unrelated staged/unstaged modifications remain untouched. Commit hooks
are honored; unexpected hook changes stop closeout and are never silently adopted.

Use background=true with consumer_id for long final checks. The tool immediately
returns a runtime finalization job; supervise it through the existing wait-for-job
and result endpoints. Its compact result contains commit/cleanup status and a
remaining-path count, while full details remain in evidence. Synchronous mode is
retained for short calls and library users. Cancellation interrupts verification;
an already-started atomic commit is recorded before cleanup is left pending.

Commit ids, intended trees, parent ids, index state and cleanup intentions are
persisted. Resume handles interrupted commit receipt recording or worktree removal
without duplicate application/commits. Ambiguous files/index or a changed commit
tree require manual inspection. No automated reset of the user's branch occurs.

Closeout phases distinguish applied_pending_commit, committed_pending_cleanup,
committed, closed and wip_preserved. closed means task delivery and workspace
retirement succeeded; it does not mean all historical modifications vanished.
Result/status summaries include closeout state and commit id without transcripts.

Cleanup checks exact registered paths and shared repository identity, live process
and reviewer references, independent worktree commits, extra staged/untracked/
ignored data, and patch identity. Evidence and reachable Git refs survive.
Exact provider-session continuation becomes unavailable after retirement.

Approved historical residuals are carried across the plugin's own commits only
when their working content and staged entries remain identical, so unchanged
legacy edits do not trigger the same question at every milestone. New or changed
residuals invalidate that readiness. If a task modifies a file that already had
historical edits, automatic whole-file commit is refused: reconcile those edits
first, or deliberately make and record a manual commit. Snapshot creation alone
does not authorize committing inherited content.

## Parallel integration

Start independent workers from recorded baselines; retain task results and exact
sessions. Dependent tasks wait for the appropriate integrated/applied state.
Create a separate Planner task/subtask for the combined deliverable, with the
union of allowed paths and meaningful combination tests.

Call stage-integrate with that task/subtask and 2-8 accepted job_ids. Runtime saves
input trees under local refs, serially merges into one bounded integration
worktree and runs combination verification. Conflict state is preserved; resolve
and stage it there, then resume stage-integrate with the same job_id. Combination
test failures can be repaired there and resumed. Original workers are untouched.
Checkpoint commits inside the owned integration workspace are recovery artifacts,
not delivery acceptance. The final patch is bound to the integration baseline.

Fresh independent code Review and Accept of the combined patch are mandatory,
even if each input passed. Finalize makes one delivery commit and retires source
worktrees only after that commit exists. Integration does not automatically
substitute another baseline if the main branch changed; investigate/rebase via
an explicit new integration task instead of overwriting newer work.

## Real validation

`node --test tests/git-lifecycle.test.mjs` uses real temporary Git repositories,
commits, worktrees, merge conflicts, hooks and injected interruption points.
`scripts/e2e-git-lifecycle.mjs` additionally uses real parallel Codex CLI workers,
AGY environment/code reviewers, combination review, exact commit and cleanup.
Set explicit AGENT_ORCH_E2E_CODEX_MODEL/AGENT_ORCH_E2E_REVIEW_MODEL; optional
AGENT_ORCH_E2E_SUMMARY records the evidence index. Temp artifacts are retained.
This does not assert installation or desktop-host hook activation.
