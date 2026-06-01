# vibe-interface-cli

Universal worker-node runtime for coding-agent orchestrators.

Provides a stable, machine-readable CLI contract that any orchestrator (e.g. Symphony) can call to start, stream, inspect, and stop coding-agent runs.

```
vibe run start  --agent <backend> --workspace-key <key> [options]
vibe run stream <run_id>
vibe run status <run_id>
vibe run stop   <run_id>

vibe symphony start  --issue-id <id> --agent <backend> [options]
vibe symphony stream <run_id>
vibe symphony status <run_id>
vibe symphony stop   <run_id> [--reason <reason>]
```

## 5-minute quickstart

```bash
git clone https://github.com/JozzyAI/vibe_interface_cli
cd vibe_interface_cli
npm install
npm run build
npm link          # exposes `vibe` as a global command

vibe --version    # 0.1.0
vibe --help
```

**Run a mock job (no API key, no agent needed):**

```bash
result=$(vibe run start --agent mock --workspace-key demo --json)
run_id=$(echo "$result" | jq -r .run_id)

vibe run stream "$run_id" --jsonl
# → streams log events, approval_required, then status:completed
```

**Use with Symphony (universe-symphony fork):**

```bash
# Clone and build vibe first (above), then:
cd path/to/universe-symphony/elixir
bash scripts/smoke_vibe_mock.sh

# Optional — requires `claude` in PATH:
bash scripts/smoke_vibe_claude.sh
```

**Symphony WORKFLOW.md config:**

```yaml
agent_kind: vibe
external:
  command: vibe
  agent: mock       # or claude-code
```

## Backends

| Backend | Description |
|---|---|
| `mock` | Internal fake runner. Emits synthetic events including `approval_required`. No network. |
| `claude-code` | Spawns `claude` CLI in stream-json mode. Requires Claude Code installed. |

## ⚠️ Safety: claude-code and `--dangerously-skip-permissions`

The `claude-code` backend can run Claude with `--dangerously-skip-permissions`, which allows Claude to execute code, write files, and run shell commands **without prompting for approval**.

This is **off by default**. You must explicitly opt in:

```bash
vibe run start --agent claude-code --permission-mode unsafe-skip --prompt-file task.txt
```

**Do not use `--permission-mode unsafe-skip` on untrusted workspaces, shared machines, or in production environments.** It is intended for local development and CI environments where the workspace is fully controlled.

## Architecture

```
Orchestrator (Symphony or any CLI caller)
  ↓
vibe run start / vibe symphony start      → returns run_id (JSON)
  ↓
Background runner (detached process)
  ↓ writes JSONL events to ~/.vibe/events/<run_id>.jsonl
  ↑
vibe run stream / vibe symphony stream    → tails event log (JSONL)
vibe run status / vibe symphony status   → reads run record (JSON)
vibe run stop   / vibe symphony stop     → kills runner, writes stopped
```

All state is local files. No network required for mock or claude-code backends.

## State files

```
~/.vibe/
├── config.json
├── runs/<run_id>.json       # RunRecord (status, metadata, workspace_path, ...)
└── events/<run_id>.jsonl    # append-only JSONL event log
```

## Event types

All events are JSONL with `{ type, run_id, ts, ... }`.

| type | fields |
|---|---|
| `status` | `status: queued\|running\|completed\|failed\|stopped\|cancelled` |
| `log` | `stream: stdout\|stderr`, `message: string` |
| `approval_required` | `approval_id: string`, `message: string` |
| `tool_call` | `tool: string`, `input?: unknown` |
| `error` | `message: string` |

## Development

```bash
npm run build          # clean build to dist/
npm test               # build + run 26 contract tests
npm run dev            # watch mode
```

## Symphony integration

```bash
result=$(vibe symphony start \
  --agent claude-code \
  --issue-id ISSUE-123 \
  --issue-title "Fix auth bug" \
  --repo-url https://github.com/org/repo \
  --branch main \
  --prompt-file task.txt \
  --permission-mode unsafe-skip)

run_id=$(echo "$result" | jq -r .run_id)

vibe symphony stream "$run_id" --jsonl | while IFS= read -r line; do
  type=$(echo "$line" | jq -r .type)
  case "$type" in
    completed|failed|stopped) break ;;
  esac
done

vibe symphony status "$run_id" --json
```
