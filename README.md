# Tamandua

Build your agent team in [pi](https://github.com/mariozechner/pi-coding-agent) with one command.

You don't need to hire a dev team. You need to define one. Tamandua gives you a team of specialized AI agents — planner, developer, verifier, tester, reviewer — that work together in reliable, repeatable workflows. One install. Zero infrastructure.

### Install from GitHub

```bash
curl -fsSL https://raw.githubusercontent.com/igorhvr/tamandua/main/scripts/install.sh | bash
```

Or just tell your pi agent: **"install github.com/igorhvr/tamandua"**

### Install from local checkout

```bash
git clone https://github.com/igorhvr/tamandua.git
cd tamandua
./build-and-install
```

Or step by step:

```bash
./build        # npm install + tsc
./install      # symlink into ~/.local/bin
```

The `build` script handles everything: checks Node.js >= 22, runs `npm install`, compiles TypeScript. The `install` script creates a symlink at `~/.local/bin/tamandua` pointed at your checkout — so you can keep the source wherever you like and `tamandua` stays in sync. Both call into `scripts/install.sh` internally.

That's it. Run `tamandua workflow list` to see available workflows.

> **Not on npm.** Tamandua is installed from source (or GitHub), not the npm registry.

> **Requires Node.js >= 22.** If `tamandua` fails with a `node:sqlite` error, make sure you're running real Node.js 22+, not Bun's node wrapper.

---

## What You Get: Agent Team Workflows

### feature-dev `7 agents`

Drop in a feature request. Get back a tested PR. The planner decomposes your task into stories. Each story gets implemented, verified, and tested in isolation. Failures retry automatically. Nothing ships without a code review.

```
plan → setup → implement → verify → test → PR → review
```

### feature-dev-merge `6 agents`

Use this when you want feature-dev story-by-story rigor, but need the run to end with one squashed merge commit back onto the original branch. Setup captures `ORIGINAL_BRANCH`, and the final merger step performs the squash merge after testing passes.

```
plan → setup → implement → verify → test → finalize_merge
```

### security-audit-github-pr `7 agents`

Point it at a repo. Get back a security fix PR with regression tests. Scans for vulnerabilities, ranks by severity, patches each one, re-audits after all fixes are applied.

```
scan → prioritize → setup → fix → verify → test → PR
```

### bug-fix-github-pr `6 agents`

Paste a bug report. Get back a fix with a regression test. Triager reproduces it, investigator finds root cause, fixer patches, verifier confirms. Zero babysitting.

```
triage → investigate → setup → fix → verify → PR
```

---

## Why It Works

- **Deterministic workflows** — Same workflow, same steps, same order. Not "hopefully the agent remembers to test."
- **Agents verify each other** — The developer doesn't mark their own homework. A separate verifier checks every story against acceptance criteria.
- **Fresh context, every step** — Each agent gets a clean session. No context window bloat. No hallucinated state from 50 messages ago.
- **Retry and escalate** — Failed steps retry automatically. If retries exhaust, it escalates to you. Nothing fails silently.

---

## How It Works

1. **Define** — Agents and steps in YAML. Each agent gets a persona, workspace, and strict acceptance criteria. No ambiguity about who does what.
2. **Install** — One command provisions everything: agent workspaces, polling, subagent permissions. No Docker, no queues, no external services.
3. **Run** — Agents poll for work independently. Claim a step, do the work, pass context to the next agent. SQLite tracks state. The scheduler keeps it moving.

### Minimal by design

YAML + SQLite + polling. That's it. No Redis, no Kafka, no container orchestrator. Tamandua is a TypeScript CLI with zero external dependencies. It runs wherever pi runs.

---

## Quick Example

```bash
$ tamandua workflow install feature-dev
✓ Installed workflow: feature-dev

$ tamandua workflow run feature-dev "Add user authentication with OAuth"
Run: a1fdf573
Workflow: feature-dev
Status: running

$ tamandua workflow status "OAuth"
Run: a1fdf573
Workflow: feature-dev
Steps:
  [done   ] plan (planner)
  [done   ] setup (setup)
  [running] implement (developer)  Stories: 3/7 done
  [pending] verify (verifier)
  [pending] test (tester)
  [pending] pr (developer)
  [pending] review (reviewer)
```

---

## Build Your Own

The bundled workflows are starting points. Define your own agents, steps, retry logic, and verification gates in plain YAML and Markdown. If you can write a prompt, you can build a workflow.

```yaml
id: my-workflow
name: My Custom Workflow
agents:
  - id: researcher
    name: Researcher
    workspace:
      files:
        AGENTS.md: agents/researcher/AGENTS.md

steps:
  - id: research
    agent: researcher
    input: |
      Research {{task}} and report findings.
      Reply with STATUS: done and FINDINGS: ...
    expects: "STATUS: done"
```

Full guide: [docs/creating-workflows.md](docs/creating-workflows.md)

---

## Security

You're installing agent teams that run code on your machine. We take that seriously.

- **Curated repo only** — Tamandua only installs workflows from the official repository. No arbitrary remote sources.
- **Reviewed for prompt injection** — Every workflow is reviewed for prompt injection attacks and malicious agent files before merging.
- **Community contributions welcome** — Want to add a workflow? Submit a PR. All submissions go through careful security review before they ship.
- **Transparent by default** — Every workflow is plain YAML and Markdown. You can read exactly what each agent will do before you install it.

---

## Commands

### Lifecycle

| Command | Description |
|---------|-------------|
| `tamandua install` | Install all bundled workflows |
| `tamandua uninstall [--force]` | Full teardown (agents, crons, DB) |

### Workflows

| Command | Description |
|---------|-------------|
| `tamandua workflow run <id> <task>` | Start a run |
| `tamandua workflow status <query>` | Check run status |
| `tamandua workflow runs` | List all runs |
| `tamandua workflow resume <run-id>` | Resume a failed run |
| `tamandua workflow list` | List available workflows |
| `tamandua workflow install <id>` | Install a single workflow |
| `tamandua workflow uninstall <id>` | Remove a single workflow |

### Management

| Command | Description |
|---------|-------------|
| `tamandua dashboard` | Start the web dashboard (also starts remote MCP on `http://localhost:3338/mcp`) |
| `tamandua logs [<lines>|<run-id>|#<run-number>]` | View recent log entries |
| `tamandua logs-tail [<lines>|<run-id>|#<run-number>]` | Follow recent activity as new events arrive |

When you start the management dashboard (`tamandua dashboard`), Tamandua automatically starts the remote MCP server too.

- Dashboard: `http://localhost:3334` (or your custom `--port`)
- MCP endpoint: `http://localhost:3338/mcp` (fixed port)

Use `tamandua dashboard status` to verify both endpoints are up.

---

## Requirements

- Node.js >= 22
- [pi](https://github.com/mariozechner/pi-coding-agent) installed on the host
  - Tamandua uses pi for AI agent execution. Agents run via `pi --print` in non-interactive mode.
- `gh` CLI for PR creation steps

---

## License

[MIT](LICENSE)

---

## Origins

Tamandua began as a fork of [antfarm](https://github.com/snarktank/antfarm) and pursues the same goal — orchestrating teams of AI agents through deterministic, repeatable workflows — but is built on top of [pi](https://github.com/mariozechner/pi-coding-agent) instead of OpenClaw. Credit to the original authors for the design and inspiration.

---

Built with Tamanduás in mind.
