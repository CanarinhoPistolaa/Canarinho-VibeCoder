# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in canarinho, please report it privately by opening a GitHub security advisory.

## Security Model

canarinho runs AI agents that execute code on your machine. We take security seriously.

### Workflow Safety

- **Curated repo only** — canarinho only installs workflows from the official repository. No arbitrary remote sources.
- **Prompt injection review** — Every bundled workflow is reviewed for prompt injection attacks before being merged.
- **No external commands in YAML** — Workflow steps use template placeholders (`{{key}}`), not shell interpolation, preventing command injection through workflow input.

### Agent Boundaries

- **Role-based access** — Each agent role restricts what it can do:
  - `analysis` roles cannot write files
  - `verification` roles cannot modify code they verify
  - `testing` roles cannot write production code
- **Separate workspaces** — Each agent has its own workspace directory
- **Fresh context** — Each agent step runs in a clean session

### Data Storage

- All state is stored locally under `~/.canarinho/`
- No data is sent to remote servers except through the configured AI provider
- API keys are read from pi's existing config (`~/.pi/agent/auth.json`)
- No credentials are stored in workflow definitions

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes |

## Dependencies

canarinho has minimal dependencies:
- `yaml` for parsing workflow definitions
- `json5` for reading OpenClaw config (fallback compatibility)

All other functionality uses Node.js standard library.
