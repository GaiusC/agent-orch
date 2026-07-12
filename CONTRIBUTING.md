# Contributing to Agent Orch

Thanks for contributing to Agent Orch.

## Getting Started

1. Fork the repository and create a feature branch from `main`.
2. Install dependencies with `npm ci`.
3. Run the checks before opening a pull request:

   ```bash
   npm test
   python -m unittest tests/test_audit_dashboard.py
   ```

## Contribution Guidelines

- Follow Semantic Versioning for release-affecting changes.
- Add or update tests for behavior changes.
- Update the README for user-facing commands, configuration, and migrations.
- Keep commits focused and describe the change clearly.
- Do not commit `.agent-orchestrator/` state, run artifacts, credentials, or local logs.

## Pull Requests

Explain the problem, the solution, and the verification you ran. A maintainer will review the change before merging.

## Project Layout

- `scripts/`: CLI, MCP server, and core modules.
- `skills/`: orchestration instructions and dashboard assets.
- `templates/`: default project configuration and continuity documents.
- `tests/`: Node.js and Python tests.
- `.codex-plugin/`: Codex plugin metadata.

## Reporting Bugs

Open a GitHub issue with reproduction steps, expected versus actual behavior, and your Node.js version and operating system. For security issues, follow [SECURITY.md](SECURITY.md) instead.
