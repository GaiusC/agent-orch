# Agent Orch

Agent Orch is a Codex plugin that provides a stage-first MCP workflow for planning, implementation, independent review, acceptance, and durable continuation across CC, AGY, and Codex Worker.

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

`gpt-5.6-terra` is the default Planner/Accepter model. Generated `gpt-5.6-sol` project routes are migrated to `gpt-5.6-terra`; unrelated custom model names are preserved.

## Primary MCP contract

The default MCP surface is provider-neutral:

| Tool | Purpose |
| --- | --- |
| `stage-plan` | Persist the Planner contract and immutable Plan execution identity |
| `stage-work` | Execute one Planner subtask using configured provider routes |
| `stage-work-continue` | Continue the exact provider session and worktree |
| `stage-review` | Produce formal reviewer evidence bound to the current patch |
| `stage-accept` | Run the formal acceptance kernel with the Plan identity |
| `wait-for-job` | Wait for a locally managed asynchronous job |
| `status`, `result` | Inspect durable job state and evidence |
| `apply`, `cleanup`, `cancel` | Apply accepted work, remove worktrees, or stop jobs |
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
          { "provider": "codex", "model": "gpt-5.6-terra", "invocation": "in_session" }
        ]
      }
    },
    "work": {
      "routes": {
        "medium": [
          { "provider": "cc", "model": "deepseek-v4-flash" },
          { "provider": "agy_write", "model": "Claude Sonnet 4.6 (Thinking)" },
          { "provider": "codex_worker", "model": null }
        ]
      }
    },
    "review": {
      "routes": {
        "medium": [
          { "provider": "agy", "model": "Gemini 3.5 Flash (High)" }
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

## Tests

```powershell
npm test
npm run test:e2e-codex-mcp
```

The suite covers config migration, Windows paths, MCP cwd behavior, `mcp.enabled=false`, runtime environment capture, OAuth fail-fast, permission flags, StageRun lifecycle, immutable Plan identity, exact continuation, and provider routing.

`test:e2e-codex-mcp` performs a real Codex-hosted MCP call and defaults to `gpt-5.4-mini`; set `AGENT_ORCH_CODEX_MCP_MODEL` to probe another model. Release verification additionally performs real E2E work-stage invocations for CC, AGY, and Codex Worker and an independent reviewer gate.

## Dashboard

Agent Orch includes an inspection-oriented HTTP dashboard for reviewing project state, job history, contract DAGs, and live process status. The dashboard is a lightweight Python HTTP server (`dashboard/scripts/server.py`) launched by a PowerShell launcher (`dashboard/scripts/open-dashboard.ps1`).

### Launch and close

```powershell
# Launch (or reuse existing dashboard bound to this project)
agent-orch dashboard -ProjectDir <project> -PreferredPort 15788

# Close the dashboard for this project
agent-orch dashboard-close -ProjectDir <project> -PreferredPort 15788
```

The dashboard opens automatically in the default browser. Use the CLI from within the project directory.

### Port behavior

- The default starting port is `15788`. The launcher scans up to 50 ports upward from this base.
- If an existing dashboard is already running for the same project (matching server version and orchestrator directory), it is reused and the browser is opened to it.
- If a candidate port is occupied by another project's dashboard or an unrelated service, the launcher normally skips it and continues to the next port. It never reuses or hijacks a port bound to a different project. The launcher only fails if no candidate port is available in the range or if a race condition prevents binding.

### Project selection

The initial view shows **known projects** discovered from safe local sources:

1. The server-bound project directory (always included).
2. Codex Desktop thread `cwd` values from `~/.codex/state_5.sqlite`.
3. Parent directories containing `.agent-orchestrator`.
4. `~/.claude/projects/` settings files (Claude Code project folders).
5. Bounded scans of common workspace folders (`~/Documents/Codex`, `~/Documents/Hermes Build`, and sibling directories).
6. Recent Agent Orch `job.json` files that reference distinct project directories.

Projects with an `.agent-orchestrator` directory display an **Agent Orch** badge. Each project card shows job counts, running-job status, and available plans. You can manually add a project path or hide a discovered one; the reset button restores only hidden projects (manually added paths are preserved).

Click a project card, or pass `?project=<path>` as a URL parameter, to open the per-project dashboard.

### Dashboard views

**Contract DAG** — displays persisted Planner contracts as a grid of nodes with dependency edges. Each node shows the task identifier, state (planned, running, failed, applied, blocked, review_blocked, ready_for_acceptance), goal, and scoped read/write/forbidden paths. Switch between **DAG** and **Contracts** mode to show full contract metadata alongside the visualization. Click a node to select its latest job.

**Sidebar job list** — the left sidebar groups jobs by plan (formal, ad-hoc, or legacy) and task. Filter by status (All / Running / Done / Failed) and provider (All / CC / AGY / Codex), or search by task or job ID. Click a job to load its detail view.

**Job detail pane** — a tabbed detail view with:

| Tab | Content |
| --- | --- |
| Conversation | Transcript events from the CC or AGY session with assistant/tool filtering and 3-line tool folding |
| Conclusion | Generate a Simplified Chinese conclusion from the configured AGY model, rendered as sanitized Markdown |
| Debug / Live Log | Raw CLI debug output from the work stage |
| Stdout/Stderr | Standard output and error streams |
| Patch | `changes.patch` — the implementation diff |
| Git Status | Current isolated-worktree state |
| Raw job.json | Complete job metadata |

**Process column** — the right-side panel lists active Claude, AGY, orchestrator, and dashboard processes discovered via `Win32_Process`. Collapse to a compact dot summary when not needed.

### Durable data and conclusion behavior

- The primary source of all dashboard data is persisted files under `.agent-orchestrator/` (runs, state, plans, contracts, and audit conclusions).
- The server maintains bounded runtime caches — `TRANSCRIPT_CACHE`, `PROCESS_CACHE` (1-second TTL), and `CONCLUSION_JOBS` — to reduce repeated work. These are never written back to the orchestrator state.
- **Conclusion** is the only server-initiated write path. It invokes the configured AGY CLI to summarize a conversation transcript and writes the result to `.agent-orchestrator/audit-conclusions/<job-id>.json`. Conclusions use a temporary prompt file to avoid Windows command-line length limits. The result is also held in `CONCLUSION_JOBS` while the server runs.

### Safety

The dashboard is inspection-oriented: all GET endpoints read from disk and runtime caches without modifying orchestrator state. The one exception is the conclusion-generation endpoint (`POST /api/conclusion/`), which writes prompt files and results to the audit-conclusions directory. The vendor route (`/vendor/`) uses a strict allowlist (`marked.min.js`, `purify.min.js`) and rejects path-traversal attempts.

The Python HTTP server uses `server_address = ("", port)`, meaning it listens on **all network interfaces** with no built-in authentication. The launcher opens `http://127.0.0.1:<port>` in the default browser for convenient local access, but any machine that can reach the server's port can read job data and trigger conclusion generation. Restrict access through a local firewall, bind the server to a specific interface by editing the invocation, or run the dashboard only on a trusted machine or network.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| "No available dashboard port found near 15788" | All ports 15788–15837 are in use. Free a port or use `-PreferredPort`. |
| "Dashboard on port X is bound to Y, expected Z" | The port's existing dashboard belongs to a different project. Close it or use a different `-PreferredPort`. |
| "Orchestrator root folder not detected" | `init` has not been run or the project has no `.agent-orchestrator/`. Run `agent-orch init` first. |
| "Port X is occupied by a dashboard or service for another project" | A port race: the port was available during scan but claimed by another process before the dashboard could start. Retry or use a different `-PreferredPort`. |
| Dashboard did not become reachable | The Python HTTP server may have failed. Run `python dashboard/scripts/server.py --project-dir <project>` manually to see errors. |
| No projects appear | Project discovery depends on Codex Desktop, Claude Code settings, or `.agent-orchestrator` presence. Add the path manually with the **+** button. |

## Safety

- Keep `trusted: false` until the repository and writable paths have been reviewed.
- Use narrow `writable_paths` and explicit `forbidden_paths`.
- Do not commit `.agent-orchestrator/state/`, `.agent-orchestrator/runs/`, or runtime environment artifacts.
- Do not silently waive reviewer evidence or change provider/session identity during acceptance.
- Do not use automatic repair for configuration failures; return explicit remediation.

## License

MIT
