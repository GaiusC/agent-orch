# External Agent Orchestrator

External Agent Orchestrator is a local Codex plugin that delegates implementation to Claude Code CLI, uses Antigravity CLI for targeted investigation or verification, and keeps Codex responsible for planning, routing, acceptance, and user communication.

The design is intentionally conservative:

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
- Local `agy` CLI.

## Install

Clone this repository, install dependencies, and add it to a personal Codex plugin marketplace.

```powershell
git clone git@github.com:GaiusC/external-agent-orchestrator.git
cd external-agent-orchestrator
npm install
```

Create or update `%USERPROFILE%\.agents\plugins\marketplace.json` so it points at the cloned plugin directory, then install it with Codex:

```powershell
codex plugin add external-agent-orchestrator@personal
```

Open a new Codex session after installation.

## Project Setup

In each target project, copy the template config:

```powershell
mkdir .agent-orchestrator
copy <plugin-root>\templates\project-config.json .agent-orchestrator\config.json
```

Review the file carefully, set `"trusted": true`, and configure real verification commands before launching workers.

At minimum:

```json
{
  "version": 1,
  "trusted": true,
  "roles": {
    "primary_writer": "cc",
    "specialist": "agy",
    "duplicate_implementation": false
  }
}
```

## Usage

In a Codex session for a configured project, say for example:

```text
Use external-agent-orchestrator. Plan this change, delegate implementation to CC, use AGY only for targeted verification, and apply the patch only after acceptance.
```

Codex should call the plugin tools to health-check workers, launch CC implementation, inspect the evidence pack, request same-session repair if needed, and apply the patch only after verification.

## Safety Notes

- Keep `duplicate_implementation` false unless you have a very specific reason.
- Do not commit `.agent-orchestrator/state/` or worker logs.
- Review project-provided `.agent-orchestrator/config.json` before setting `trusted` to true.
- Treat worker output as a claim; Codex still needs to verify diffs, forbidden paths, and acceptance commands.

## License

MIT
