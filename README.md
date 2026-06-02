# vibe-interface-cli

Universal worker-node runtime for coding-agent orchestrators.

Provides a stable, machine-readable CLI contract that any orchestrator (e.g. Symphony) can call to start, stream, inspect, and stop coding-agent runs — locally or on remote nodes over a relay.

```
vibe run start  --agent <backend> --workspace-key <key> [--node auto|local|<id>] [options]
vibe run stream <run_id>
vibe run status <run_id>
vibe run stop   <run_id>

vibe symphony start  --issue-id <id> --agent <backend> [--node auto|local|<id>] [options]
vibe symphony stream <run_id>
vibe symphony status <run_id>
vibe symphony stop   <run_id> [--reason <reason>]

vibe node list   [--remote --relay <url> --token <token>]
vibe node status <node_id>
vibe node daemon --local [--relay <url> --token <token> --node-id <id>]

vibe relay dev   --port <port> --token <token>
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

**Inspect available nodes:**

```bash
vibe node list --json
# → [{"node_id":"local","name":"Local Machine","status":"online","agents":["mock","claude-code"],...}]

vibe node status local --json
```

**Run a mock job (no API key, no agent needed):**

```bash
result=$(vibe run start --agent mock --workspace-key demo --node auto --json)
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

### Local mode (default)

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

### Remote mode (relay)

```
CLI / Symphony
  │  vibe run start --node <id> --relay ws://localhost:7433 --token dev
  │  vibe run stream <run_id>   --relay ws://localhost:7433 --token dev
  │  vibe run stop   <run_id>   --relay ws://localhost:7433 --token dev
  ▼
vibe relay dev  (plaintext WS relay, 127.0.0.1 only)
  │  run_start  →  run_start_ack
  │  run_stream_subscribe  →  run_event fanout
  │  run_stop_request  →  run_stop_ack
  ▼
vibe node daemon --local --relay ...  (worker node, any machine)
  ↓
Background runner (mock / claude-code)
  ↓ writes JSONL events locally, tails and forwards to relay as run_event
```

Run ownership is tracked by the relay (`run_id → node_id`) so stop requests route to the correct node. The daemon is a long-lived process — remote stop kills only the runner, never the daemon.

## Relay (MVP 3D — dev mode)

> ⚠️ **Plaintext localhost relay — development only.**
> All WebSocket traffic is unencrypted and the server binds to `127.0.0.1` only.
> Do not expose to the internet. E2E encryption is planned for a future release.

### 3-terminal demo

```bash
# Terminal 1 — start relay
vibe relay dev --port 7433 --token dev
# [vibe-relay] listening on ws://127.0.0.1:7433

# Terminal 2 — register this machine as a remote node
vibe node daemon --local --relay ws://localhost:7433 --token dev --node-id my-node
# [vibe-node] daemon started — node_id=my-node
# [vibe-node] registered with relay ws://localhost:7433
# [vibe-node] heartbeat every 5000ms

# Terminal 3 — CLI: discover, start, stream, and stop a remote run
vibe node list --remote --relay ws://localhost:7433 --token dev --json
# → [{"node_id":"my-node","transport":"relay","status":"online",...}]

result=$(vibe run start \
  --agent mock \
  --node my-node \
  --relay ws://localhost:7433 \
  --token dev \
  --workspace-key demo-remote)
run_id=$(echo "$result" | jq -r .run_id)

# Stream all events until completed
vibe run stream "$run_id" \
  --relay ws://localhost:7433 \
  --token dev
# → {"type":"status","status":"running",...}
# → {"type":"log","message":"Cloning repository...",...}
# → ...
# → {"type":"approval_required","message":"Proceed with modifying tracked files?",...}
# → {"type":"status","status":"completed",...}

# Or stop mid-run instead
vibe run stop "$run_id" \
  --relay ws://localhost:7433 \
  --token dev
# → {"run_id":"...","status":"stopped",...}
```

Token auth is enforced at the HTTP upgrade level — wrong or missing token gets HTTP 401 before the WebSocket handshake completes.

Remote nodes appear with `transport: "relay"` in the node list. Local node list (`vibe node list` without `--remote`) is unaffected by relay state.

Env knobs:

| Variable | Default | Description |
|---|---|---|
| `VIBE_NODE_HEARTBEAT_MS` | `5000` | Interval between heartbeat writes |
| `VIBE_NODE_STALE_MS` | `15000` | Age after which a heartbeat is considered stale (marks node offline) |
| `VIBE_NODE_STATE_FILE` | `~/.vibe/node-local.json` | Override state file path |

## State files

```
~/.vibe/
├── config.json
├── node-local.json          # NodeDaemonState (written by `vibe node daemon --local`, removed on exit)
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

## Troubleshooting

**Wrong or missing token → HTTP 401**
```
error: Unexpected server response: 401
```
Check that `--token` matches the value passed to `vibe relay dev --token`.

**Relay not running → ECONNREFUSED**
```
error: connect ECONNREFUSED 127.0.0.1:7433
```
Start the relay first: `vibe relay dev --port 7433 --token dev`

**Node offline → node_offline error**
```
error: node_offline: Owning node is offline: my-node
```
The node daemon registered but its WebSocket connection dropped. Restart `vibe node daemon --local --relay ...`.

**Run not found in relay → run_not_found error**
```
error: run_not_found: Run not found in relay: run_abc123
```
The relay has no ownership record for this run_id. The run either was not started via relay, or the relay restarted (relay state is in-memory only).

**Node daemon killed (not stale yet) → node shows online but run_start fails**
If the daemon process exits ungracefully the registry entry remains until the WS connection closes (usually immediate). Wait a moment and try again; the node will disappear from the list.

## Development

```bash
npm run build          # clean build to dist/
npm test               # build + run 74 tests
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
