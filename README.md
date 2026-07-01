# Agent Orch

Agent Orch is a local Codex plugin for supervising external coding agents without depending on a Codex MCP server. Codex plans and accepts the work, Claude Code implements, and Antigravity provides targeted investigation or verification when its local auth is usable.

The default path is Skill + CLI:

- Claude Code is the primary writer.
- Antigravity is a non-duplicating specialist and verifier.
- Codex owns task planning, scope boundaries, and final acceptance.
- Worker changes are produced in an isolated Git worktree by default and applied only after acceptance.
- Sessions are reused by project, provider, task id, and model to keep context stable.

## Requirements

- Codex CLI/Desktop with plugin support.
- Node.js 18.18 or newer.
- Git.
- Local `claude` CLI.
- Local `agy` CLI if AGY verification is desired.

## Install

```powershell
git clone git@github.com:GaiusC/agent-orch.git
cd agent-orch
npm install
```

Add the cloned plugin to a personal Codex plugin marketplace, then install:

```powershell
codex plugin add agent-orch@personal
```

Open a new Codex session after installation.

## Project Setup

Initialize each target project:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin-root>\scripts\agent-orch.ps1 init -ProjectDir <project>
```

For a partially built project, add `-ExistingProject`.

This creates:

```text
.agent-orchestrator/
  config.json
  state/
  runs/
```

Review `.agent-orchestrator/config.json`, keep `duplicate_implementation` false, and configure real verification commands before accepting worker output.

## Usage

In a Codex session for a configured project:

```text
Use agent-orch. Plan this change, delegate implementation to CC, use AGY only for targeted verification, and apply the patch only after acceptance.
```

Codex should call `scripts\agent-orch.ps1`, inspect evidence under `.agent-orchestrator\runs`, request same-session repair if needed, and apply the patch only after verification.

## Legacy MCP

The previous MCP server remains in the repository for legacy use, but it is not registered by default. The CLI path is recommended for multi-account Codex setups and environments where MCP startup or AGY OAuth state is unstable.

## Safety Notes

- Keep `duplicate_implementation` false unless you have a very specific reason.
- Do not commit `.agent-orchestrator/state/` or `.agent-orchestrator/runs/`.
- Review project-provided `.agent-orchestrator/config.json` before setting `trusted` to true.
- Treat worker output as a claim; Codex still needs to verify diffs, forbidden paths, and acceptance commands.

## License

MIT
