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

## Quick start

```bash
npm install && npm run build

# Mock backend (no real agent, safe for testing)
vibe run start --agent mock --workspace-key test1
vibe run stream <run_id>
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

## State files

All state is local. No network required for MVP 0–1.

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

vibe symphony stream "$run_id" | while IFS= read -r line; do
  type=$(echo "$line" | jq -r .type)
  case "$type" in
    completed|failed|stopped) break ;;
  esac
done

vibe symphony status "$run_id"
```
