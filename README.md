# Agent Orch

Agent Orch is a Codex plugin that provides a stage-first MCP workflow for planning, implementation, independent review, acceptance, and durable continuation across CC, AGY, and Codex Worker.

Version 0.8.3 adds task-branch recommendations, explicit cross-chat handoff with
owner/epoch fencing, and separate commit, target-merge and workspace states.
Accepted results can be committed to a protected task ref and release their
worktree before merge. Advanced targets require a new independently reviewed
integration; conflicts remain for explicit resolution. Verified delivery receipts
can carry an approved dirty baseline forward without hiding unrelated edits.
Defaults are three Worker worktrees and five total auxiliary workspaces, with an
integration slot reserved when capacity permits. Existing model routes are kept.
Legacy Plans with missing repository identity recover only through verifiable
native Plan/Work provenance and fresh Review evidence, without rewriting receipts.
The Auditor shows ownership, task branches and pending merges separately. CI runs
on Windows and Linux without depending on installed provider CLIs or personal data.
See [task continuity and branches](skills/orchestrate-agents/references/task-continuity.md).

Version 0.8.2 fixes Windows `ENAMETOOLONG` in environment review and preservation
readiness. Git index records are read with fixed arguments and filtered by exact
paths in process, retaining NUL delimiters and all conflict stages. Environment
reviewers receive a bounded audit reference and digest, then read the complete
immutable audit from disk. Existing stale-state, read-only and acceptance gates
remain in force; project routes and historical records are preserved.

Version 0.8.1 binds runtime execution to the original Git project, recovers legacy
Worker workspace ancestry, and requires audited registration of additional
coordinator repositories. Registered coordinators and their linked worktrees
share the original project's workspace limits. Copying files and running
`git init` cannot substitute for reconciling the original environment. Identity
sidecars preserve current model routes and historical job records.

Version 0.8.0 adds catalog-based **use recommended / edit recommended / custom**
initialization, automatic current-host identity detection, bounded Worker
complexity upgrades and quota-only reviewer fallback. Existing project routes
remain unchanged until explicitly reconfigured.

Version 0.7 adds environment takeover audits, explicit Git commit policies,
recoverable task finalization, bounded worktree allocation, and independently
reviewed integration of parallel results. Existing uncommitted changes are
preserved; dirty state is never a reason to automatically clone the repository.
See [Git lifecycle](skills/orchestrate-agents/references/git-lifecycle.md).

Version 0.7.2 shows asynchronous finalization as a single delivery, preserving
supervisor links and legacy evidence. Existing model routes and job records are
retained.

Version 0.7.1 includes the updated local Auditor: manual-refresh project and plan
navigation, execution timelines, dependency graphs, Git history, and English /
Chinese controls. Durable Git operation receipts link execution evidence to
internal checkpoints and delivery commits. The server binds to loopback and
validates Host/Origin. The previous inspector remains available at `/legacy`.
See [Auditor documentation](dashboard/README.md).

The plugin follows the Codex plugin layout:

```text
.codex-plugin/plugin.json
.mcp.json
skills/
scripts/
templates/
tests/
```

The manifest points to the root `.mcp.json`; the plugin does not ship a competing `.codex/config.toml`.

## Codex host model compatibility

Agent Orch requires the active Codex host model to expose local MCP tools. With Codex CLI/Desktop `0.144.4`, the same installed `agent_orch` server was verified as follows:

| Host model | Agent Orch MCP |
| --- | --- |
| `gpt-5.6-terra` | PASS |
| `gpt-5.6-luna` | PASS |
| `gpt-5.5` | PASS |
| `gpt-5.4` | PASS |
| `gpt-5.4-mini` | PASS |
| `gpt-5.6-sol` | PASS — verified with a Sol-hosted task that made real `health` and `stage-plan` MCP calls |

These are historical compatibility observations, not a current model catalog.
Initialization requires user-selected models; v2 routes are not rewritten based
on old alias assumptions.

## Primary MCP contract

The default MCP surface is provider-neutral:

| Tool | Purpose |
| --- | --- |
| `environment-audit` | Collect read-only Git/worktree facts and explicit known clone paths; return a compact evidence index |
| `environment-reconcile` | Prepare exact actions, then execute an approved plan after checking for state changes |
| `task-handoff` | Inspect task ownership or explicitly prepare, claim and recover cross-chat authority |
| `stage-integrate` | Combine accepted results in a bounded integration worktree; require fresh review and acceptance |
| `stage-finalize` | Apply once, verify the actual target, commit exact task changes, and safely retire worktrees |
| `stage-plan` | Persist the Planner contract and immutable Plan execution identity |
| `stage-work` | Execute one Planner subtask using configured provider routes |
| `stage-work-continue` | Continue the exact provider session and worktree |
| `stage-review` | Formal patch-bound code review, or separate advisory environment review |
| `stage-accept` | Run the formal acceptance kernel with the Plan identity |
| `wait-for-job` | Bounded wait for checkpoint, attention or terminal events; 1-8 jobs with a shared consumer cursor |
| `status`, `result` | Small current snapshot / result summary by default; expand details explicitly |
| `apply`, `cleanup`, `cancel` | Compatibility apply/safe cleanup controls, or stop jobs; apply alone does not finalize |
| `health` | Check CC, AGY, Codex Worker, trust, and project configuration |

Provider-specific wrappers are hidden by default. Diagnostic exposure requires both:

```json
{
  "mcp": {
    "expose_provider_tools": true
  }
}
```

and MCP server environment `AGENT_ORCH_EXPOSE_PROVIDER_TOOLS=1`.

## Project setup

Initialize and resume through the CLI:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 init -ProjectDir <project> -HostProvider codex
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 resume -ProjectDir <project> -HostProvider codex
```

`init` builds a recommendation from the discovered catalog and offers **use
recommended / edit recommended / custom**. The recommendation selects current
Worker candidates by model generation and provider priority with
medium/medium/high reasoning, Sonnet High / newest
Gemini High / previous Gemini generation High reviewers, and the actual host
for Plan/Accept. Accepting the matrix needs one total confirmation. Editing
changes only chosen rows; custom retains the detailed wizard. No model release
name is pinned in this policy. Missing catalog capabilities remain explicit.
The host identity is detected from exact current-thread metadata, or supplied
with `--HostModel`. Existing v2 model choices are preserved by `resume`.

Outside a terminal, `init` returns `selection_required: true` (exit code 2), with
candidates, provenance and `recommendation`, before writing project files. The
host should show the matrix and a single use/edit/custom option box, save the
exact approved selection as JSON, and run:

```powershell
node scripts/agent-orch.mjs init -ProjectDir <project> -HostProvider codex --RoutesFile <routes.json>
node scripts/agent-orch.mjs models --ModelCatalog <catalog.json>
```

Minimal routes JSON (replace each placeholder with the user's selection):

```json
{
  "plan": { "provider": "codex", "model": "<current host model>" },
  "work": [
    { "provider": "codex_worker", "model": "<selected worker>", "reasoning_effort": "high", "service_tier": "fast" }
  ],
  "review": { "provider": "agy", "model": "<selected reviewer>" }
}
```

For per-tier choices, use `{"stages":{"plan":{"routes":{"low":[...],"medium":[...],"high":[...]}},"work":{...},"review":{...},"accept":{"inherit_from":"plan"}}}`.
Every tier of a supplied stage must be present. Only explicitly selected Work
routes are enabled. Repeating `init` asks again; `--UseExistingRoutes` explicitly
reuses the existing routes. `resume` cannot initialize a project implicitly.

Recommended Work escalation is low → medium → high after timeout or exhausted
verification/repair, preserving partial work in one registered worktree and
separate attempt logs. After two consecutive explicit negative review rounds,
the next `stage-work` starts an upgraded attempt; exact continuation retains its
original model. A PASS resets the streak. Review quota fallback goes high →
medium → low while keeping the same patch/contract binding. A FAIL, permission
or auth error, mutation or cancellation stops instead of downgrading. Both
policies also respect a Planner task's explicit `fallback_policy.enabled`.
See [configuration details](skills/orchestrate-agents/references/project-configuration.md).

The candidate sources are the Codex local model cache (with its timestamp), CC's
configured models, and `agy models`. Cache/configuration entries do not prove live
availability. Discovery/auth failures are shown as warnings and never select a
fallback model. Exact custom ids are accepted. To supply a fresh provider catalog
or work offline, pass `--ModelCatalog <catalog.json>` with arrays under `codex`,
`cc`, and `agy`. Entries can be model-id strings or objects:

```json
{
  "codex": [{ "id": "<model id>", "reasoning_efforts": ["low", "high"], "service_tiers": ["priority"] }],
  "cc": ["<configured model id>"],
  "agy": ["<exact model display name>"]
}
```

Codex Worker `reasoning_effort` and `service_tier` are independent route options.
`null` means inherit the CLI setting, not force Standard speed. `fast` requests
Codex Fast mode; other tier identifiers may be entered if advertised by the
model/account. Listed reasoning capabilities are checked when available. Provider
validation remains authoritative. Values are passed to initial execution,
continuations, repairs, and Windows sandbox recovery; continuation preserves the
original route's options even if project configuration changes. For inherited
options, changes to the underlying CLI settings can still affect later turns.

`resume` performs two durable operations:

1. rebuilds `.agent-orchestrator/current-state.json` and the generated handoff;
2. captures an allowlisted provider runtime environment in `.agent-orchestrator/runtime-env.json`.

The runtime snapshot includes proxy, CA, AGY-home, and Windows home-resolution variables, but never arbitrary tokens or secrets. Every AGY invocation reloads this snapshot. Explicit `cli.agy_env` values override it.

If AGY prints an OAuth URL or an interactive sign-in request, Agent Orch terminates the invocation immediately with remediation instead of waiting for the normal provider timeout.

## Configuration v2

`.agent-orchestrator/config.json` uses provider-neutral stage routes:

```json
{
  "version": 2,
  "trusted": true,
  "mcp": {
    "enabled": true,
    "expose_provider_tools": false
  },
  "host": {
    "provider": "codex"
  },
  "stages": {
    "plan": {
      "routes": {
        "high": [
          { "provider": "codex", "model": "<selected host model>", "invocation": "in_session" }
        ]
      }
    },
    "work": {
      "routes": {
        "medium": [
          { "provider": "cc", "model": "<selected CC model>" },
          { "provider": "agy_write", "model": "<selected AGY worker>" },
          { "provider": "codex_worker", "model": "<selected Codex worker>" }
        ]
      }
    },
    "review": {
      "routes": {
        "medium": [
          { "provider": "agy", "model": "<selected reviewer>" }
        ]
      }
    },
    "accept": {
      "inherit_from": "plan"
    }
  }
}
```

Version 1 configurations are migrated in memory on load and written as v2 by `init`/`resume`. Custom model names are preserved; known obsolete AGY aliases are migrated to current CLI display names.

## Provider execution guarantees

- CC runs non-interactively in an isolated Git worktree with `bypassPermissions`.
- AGY write runs in the isolated worktree with explicit non-interactive write permission. AGY review receives headless tool permission, but Agent Orch compares the implementation patch digest before and after review, rejects conversation-store fallback text, and requires an explicit `VERDICT: PASS`.
- Codex Worker first runs with `--sandbox workspace-write` and `approval_policy="never"`. On Windows only, a recognized sandbox-helper startup failure is continued in the same thread with Codex's externally-isolated bypass flag; the Agent Orch worktree and path-policy gates remain enforced and the fallback is recorded in evidence.
- Provider PIDs, cwd, session IDs, models, and worktrees are persisted under `.agent-orchestrator/`.
- CC binds its session before launch. AGY and Codex Worker bind conversation/thread IDs as soon as they appear in output.
- After an MCP restart, `status - project_dir` checks the persisted OS PID. A missing in-memory promise is not treated as proof that the worker died.
- `stage-work-continue` never reroutes. It requires the exact original provider session and worktree and fails closed with remediation if either is missing.

Fallback only occurs for classified retryable provider/runtime failures such as executable unavailability, timeout, quota exhaustion, or transient connectivity. Authentication, sandbox, permission, forbidden-path, and read-only failures are surfaced directly.

## Acceptance

Worker output is never applied directly. `stage-accept` calls the formal acceptance kernel and requires:

- a persisted Planner contract;
- immutable Plan provider/model/invocation/session identity;
- current patch digest;
- deterministic verification evidence;
- reviewer evidence when the review gate is enabled;
- matching repository and workspace provenance.

`apply` validates the acceptance artifact again before applying the patch.

## MCP installation

The plugin manifest supplies its MCP server automatically when installed through Codex. Project-local MCP maintenance remains available for non-plugin hosts:

```powershell
agent-orch mcp status  -ProjectDir <project>
agent-orch mcp install -ProjectDir <project>
agent-orch mcp repair  -ProjectDir <project>
agent-orch mcp remove  -ProjectDir <project>
```

Generated `.mcp.json` entries use `cwd: "."` and forward-slash script paths so Windows project paths resolve consistently.

## Development and update flow

Always edit the source checkout, never the installed cache:

```text
C:\Users\<user>\plugins\agent-orch
```

Standard release loop:

1. Modify source, tests, README, and skill documentation.
2. Run `npm test`.
3. Validate the plugin:

   ```powershell
   python <CODEX_HOME>\skills\.system\plugin-creator\scripts\validate_plugin.py <source-root>
   ```

4. Bump the manifest cachebuster/version using the plugin-creator update helper.
5. Reinstall:

   ```powershell
   codex plugin add agent-orch@personal
   ```

6. Open a new Codex task. Existing tasks keep their previously loaded skill and MCP tool catalog.
7. Select an MCP-capable host model and verify that `health` and `stage-*` tools are callable while provider wrappers remain hidden.

Source and installed cache versions must match before release verification.
Source version 0.6.0 adds node reports, bounded event waiting and optional async
Hook delivery. Stage-start, status and result defaults are compact. Existing
clients needing full status/evidence must request `detail: "full"`; wait-for-job
retains single job_id input but now returns `{cursor, events}`. There is no
separate wait-for-change tool.
Source version 0.5.0 introduces explicit initialization selection (non-interactive
callers must supply routes), preserves v2 model identities, and adds independent
Codex Worker reasoning/service-tier options. Legacy v1 migration remains a
compatibility path; its historical registry is not used to select new-project models.

## Supervision and short reports

Workers/reviewers submit short checkpoints through the runtime-bound
`report_progress` MCP server (Codex/CC) or the supplied helper CLI (AGY and others).
Reports are advisory, deduplicated, length-limited, and stored outside the patch.
The runtime alone records completion after verification/evidence persistence.

The main chat calls `wait-for-job` with `until: "update"`, a stable `consumer_id`,
the latest `cursor`, and `timeout_ms` (default 30000, max 60000). Use `job_id` or
`job_ids` for up to 8 jobs. Default `until: "terminal"` ignores ordinary reports
but returns attention early. Empty timeouts are not failures. The waiter works
from disk after an MCP restart and does not read agent transcripts.

```json
{"project_dir":"<project>","job_ids":["<job-id>"],"consumer_id":"<chat-id>","until":"update","timeout_ms":30000}
```

Bundled async hooks deliver short events at active-turn safe points; they do not
wake idle chats. Review/trust the hook in Codex before use. Set project
`notifications.hook_enabled` to false to disable it. Hook and explicit waiting
share the same consumer ledger. Distinct chats need distinct consumer ids.

`status` defaults to a small snapshot; `detail: "progress"` or `"full"` is for
diagnostics. `result` defaults to a summary plus evidence index; request
`verification`, `changes`, `findings`, `attempts`, or `full` for inspection.
Neither a node report nor a result summary replaces formal review/acceptance.
See [protocol details](skills/orchestrate-agents/references/status-design-options.md).

## Tests

```powershell
npm test
npm run test:e2e-codex-mcp
```

The suite covers config migration, Windows paths, MCP cwd behavior, `mcp.enabled=false`, runtime environment capture, OAuth fail-fast, permission flags, StageRun lifecycle, immutable Plan identity, exact continuation, and provider routing.

`test:e2e-codex-mcp` performs a real Codex-hosted MCP call; set `AGENT_ORCH_CODEX_MCP_MODEL` explicitly to a currently available model. Release verification additionally performs real E2E work-stage invocations for CC, AGY, and Codex Worker and an independent reviewer gate.

## Dashboard

Agent Orch includes a manual-refresh Auditor workspace for plans, execution timelines, dependencies, and Git history. The dashboard is a lightweight Python HTTP server (`dashboard/scripts/server.py`) launched by a PowerShell launcher (`dashboard/scripts/open-dashboard.ps1`). The default UI uses `workspace.html`, `workspace.js`, `workspace.css` and `i18n.js`; the previous job inspector remains available at `/legacy` for compatibility.

### Launch and close

```powershell
# Launch (or reuse existing dashboard bound to this project)
agent-orch dashboard -ProjectDir <project> -PreferredPort 15788

# Close the dashboard for this project
agent-orch dashboard-close -ProjectDir <project> -PreferredPort 15788
```

The dashboard opens automatically in the default browser. Use the CLI from within the project directory.

The header **EN / 中文** toggle switches the interface language and remembers it
for the current host/port. Language changes preserve the current view and reuse
the loaded snapshot. User content and original evidence are not translated.

To create or update the desktop **Agent Orch Auditor** shortcut, run
`dashboard/scripts/install-auditor-shortcut.ps1`. It backs up the old shortcut,
preserves its icon, and points it to the current source launcher with `-ProjectHome`
and preferred port `43188`, using a hidden PowerShell window. Run it again after
moving the checkout or changing the launcher. See [Auditor documentation](dashboard/README.md)
for exact commands, verification and shortcut recovery.

### Port behavior

- The default starting port is `15788`. The launcher scans up to 50 ports upward from this base.
- If an existing dashboard is already running for the same project (matching server version and orchestrator directory), it is reused and the browser is opened to it.
- If a candidate port is occupied by another project's dashboard or an unrelated service, the launcher normally skips it and continues to the next port. It never reuses or hijacks a port bound to a different project. The launcher only fails if no candidate port is available in the range or if a race condition prevents binding.

### Project selection

The root URL opens the project homepage; an explicit project/thread URL opens
that workspace. Use the project button in the header to select **known projects** discovered from safe local sources:

1. The server-bound project directory (always included).
2. Codex Desktop thread `cwd` values from `~/.codex/state_5.sqlite`.
3. Parent directories containing `.agent-orchestrator`.
4. `~/.claude/projects/` settings files (Claude Code project folders).
5. Bounded scans of common workspace folders (`~/Documents/Codex`, `~/Documents/Hermes Build`, and sibling directories).
6. Recent Agent Orch `job.json` files that reference distinct project directories.

The project picker also accepts an explicit local path. A project without `.agent-orchestrator` can still display its Git history when the server is started directly with `python dashboard/scripts/server.py --project-dir <path>`.

Pass `?project=<path>` to open a particular project. `?thread=<local-chat-UUID>` resolves that exact chat's `cwd` from Codex's local read-only index, preserving worktree identity. Conflicting thread/project values and unknown chat IDs fail explicitly. Page selection never changes shared server globals. This binds a page to a chat; it does not detect the currently visible chat or guarantee automatic right-panel opening on application launch.

### Dashboard views

**Plan history** — the sidebar presents plans by recorded creation time, with a compact node/line history, readable titles, and execution summaries. It reads all job records instead of truncating at 30, preserves empty manifests, retries and failures, and keeps unassociated historical stages in an explicit group. Contracts, subtasks, reviewer tasks, jobs and StageRuns retain their separate identities. Search/provider/status filters are removed from the default UI.

**Execution view** — the main timeline has actual event times, per-unit lanes, work durations, continuation links and clickable stage/job records. Missing timestamps remain unknown. The dependency view draws directed SVG edges from declared subtask dependencies; dashed arrows denote reviewer targets. It never invents task dependencies from timestamps. Review PASS summaries require current contract and patch bindings, and old-contract executions cannot complete a new contract. Execution, acceptance and delivery states remain distinct.

**Git history** — the second sidebar mode shows branches, exact parent edges and commit subjects, strictly ordered by committer time before pagination. A dashed working-tree node connects to the actual HEAD and shows staged, unstaged and untracked counts. Clicking a commit opens its message and diff. Plan/commit navigation uses explicit `commit_id` or finalization receipts plus live Git-object/reachability checks; absence of a mapping is labeled **提交未关联**, not proof that no commit exists. No fetch, checkout, commit or index refresh is performed.

**Job details** open on demand with execution metadata, sanitized Markdown reports, conversation/tool records, patch, stdout/stderr and evidence. Raw logs and IDs are collapsed by default. The compatibility inspector at `/legacy` retains its previous detailed tabs:

| Tab | Content |
| --- | --- |
| Conversation | Transcript events from the CC or AGY session with assistant/tool filtering and 3-line tool folding |
| Conclusion | Generate a Simplified Chinese conclusion from the configured AGY model, rendered as sanitized Markdown |
| Debug / Live Log | Raw CLI debug output from the work stage |
| Stdout/Stderr | Standard output and error streams |
| Patch | `changes.patch` — the implementation diff |
| Git Status | Current isolated-worktree state |
| Raw job.json | Complete job metadata |

Opening `/` without a project/thread restores the project homepage. Project cards support explicit directories, hiding, restoring, and existing `agentOrchAuditProjectPreferences` custom/hidden paths. In a project, **All projects** returns home and the project name opens the quick switcher. Project links retain their explicit context.

Plan timelines include a separate Git lane and chronological Git operation records. Operations expose repository/worktree identity, before/after SHA, source execution, patch digest and durable evidence; Git commits link back to related plans. The sidebar distinguishes delivery commits from baselines and internal integration checkpoints. **Show internal checkpoints** is opt-in and includes `refs/agent-orch/*` without changing the repository. A worktree is not represented as a branch unless Git actually has that branch.

The runtime writes immutable per-operation receipts under `runs/<job>/git-operations/` before projecting them to the existing `events.jsonl`. Stable operation IDs prevent duplicate successful events on retry and repair an interrupted projection. Conflicts/blocked attempts remain separate records. Existing jobs, integration evidence and finalization receipts are read as legacy facts without rewriting them; missing occurrence times and unknown ownership remain explicit. This records operations performed by Agent Orch, not arbitrary external Git commands.

The new UI has no persistent process column or nested frames. At narrow panel widths, history and detail use a single-column navigation with a back action. It reads once on opening and thereafter only on explicit user actions (refresh, first Git load, branch selection, loading older commits, or opening details). Switching browser focus does not refresh the data.

### Durable data and conclusion behavior

- The primary source of all dashboard data is persisted files under `.agent-orchestrator/` (runs, state, plans, contracts, and audit conclusions).
- The server maintains bounded runtime caches — `TRANSCRIPT_CACHE`, `PROCESS_CACHE` (1-second TTL), and `CONCLUSION_JOBS` — to reduce repeated work. These are never written back to the orchestrator state.
- **Conclusion** is the only server-initiated write path. It invokes the configured AGY CLI to summarize a conversation transcript and writes the result to `.agent-orchestrator/audit-conclusions/<job-id>.json`. Conclusions use a temporary prompt file to avoid Windows command-line length limits. The result is also held in `CONCLUSION_JOBS` while the server runs.

### Safety

The dashboard is inspection-oriented: all GET endpoints read from disk and runtime caches without modifying orchestrator state. The one exception is the conclusion-generation endpoint (`POST /api/conclusion/`), which writes prompt files and results to the audit-conclusions directory. The vendor route (`/vendor/`) uses a strict allowlist (`marked.min.js`, `purify.min.js`) and rejects path-traversal attempts.

The server binds to `127.0.0.1` and validates the HTTP Host/Origin. Wildcard CORS is removed. There is no remote hosting or account authentication; this remains a local desktop tool. The new workspace only reads data; conclusion generation remains an explicit action in the compatibility inspector.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| "No available dashboard port found near 15788" | All ports 15788–15837 are in use. Free a port or use `-PreferredPort`. |
| "Dashboard on port X is bound to Y, expected Z" | The port's existing dashboard belongs to a different project. Close it or use a different `-PreferredPort`. |
| "Orchestrator root folder not detected" | `init` has not been run or the project has no `.agent-orchestrator/`. Run `agent-orch init` first. |
| "Port X is occupied by a dashboard or service for another project" | A port race: the port was available during scan but claimed by another process before the dashboard could start. Retry or use a different `-PreferredPort`. |
| Dashboard did not become reachable | The Python HTTP server may have failed. Run `python dashboard/scripts/server.py --project-dir <project>` manually to see errors. |
| No projects appear | Open the project picker and enter a local directory explicitly. Discovery depends on Codex Desktop, Claude Code settings, or `.agent-orchestrator` presence. |

## Safety

- Keep `trusted: false` until the repository and writable paths have been reviewed.
- Use narrow `writable_paths` and explicit `forbidden_paths`.
- Do not commit `.agent-orchestrator/state/`, `.agent-orchestrator/runs/`, or runtime environment artifacts.
- Do not silently waive reviewer evidence or change provider/session identity during acceptance.
- Do not use automatic repair for configuration failures; return explicit remediation.

## License

MIT
