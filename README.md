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

## End-to-end encryption (MVP 4B–4D)

Add `--encrypt` to any remote `vibe run start` command to enable E2E encryption:

```bash
vibe run start --node <id> --relay ws://... --token dev --agent mock --encrypt
```

### Encrypted today

| Surface | Wire type | HKDF context |
|---|---|---|
| `run_start` payload | `EncryptedRunStartMsg` | `vibe-run-start-v1` |
| `run_event` stream | `EncryptedRunEventMsg` | `vibe-run-event-v1` |
| `run_stop` request/ack | `EncryptedRunStopRequestMsg/Ack` | `vibe-run-stop-v1` |

### Not encrypted yet

| Surface | Notes |
|---|---|
| `approval_response` | No approval response path implemented yet — planned as MVP 4E |

### What the relay still sees (metadata)

- `from` / `to` (routing identifiers)
- `run_id` / `req_id`
- Timestamps, message type, ciphertext size / traffic timing

### What the relay cannot see

- Prompt content, workspace key, agent type
- Agent stdout / stderr / tool calls
- Event type, log messages, status transitions
- Stop reason, run result

All three keys (`run_start`, `run_event`, `run_stop`) are derived from the **same X25519 ECDH
exchange** at run_start time — no additional round-trips. CLI stdout schema is unchanged.

See [`docs/ENCRYPTED_RELAY_DEMO.md`](docs/ENCRYPTED_RELAY_DEMO.md) for the full walkthrough.

---

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

### Remote Claude Code

To run Claude Code on the remote node, add `--agent claude-code` to `run start` and optionally `--permission-mode unsafe-skip`. The CLI reads the prompt file locally and transmits its **text content** over the relay — the remote node never needs access to the controller's filesystem.

```bash
# Terminal 3 (continued from 3-terminal demo above)
result=$(vibe run start \
  --agent claude-code \
  --node my-node \
  --relay ws://localhost:7433 \
  --token dev \
  --workspace-key issue-123 \
  --prompt-file /tmp/task.md \
  --permission-mode unsafe-skip \
  --json)

run_id=$(echo "$result" | jq -r .run_id)

# Stream Claude's output back through relay
vibe run stream "$run_id" \
  --relay ws://localhost:7433 \
  --token dev

# Or stop if needed
vibe run stop "$run_id" \
  --relay ws://localhost:7433 \
  --token dev
```

> ⚠️ `--permission-mode unsafe-skip` allows Claude to execute code and modify files without prompting. Only use it in workspaces you fully control.

**How prompt content is handled**: `vibe run start` reads the prompt file on the controller side and sends the text in the relay message. The node daemon writes it to a local temp file and passes that to the Claude runner. This design means the controller path is never required on the remote node, making the relay work across different machines.

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
npm test               # build + run 119 tests
npm run dev            # watch mode
```

## Symphony integration

### Local dispatch

```bash
result=$(vibe symphony start \
  --agent claude-code \
  --issue-id ISSUE-123 \
  --issue-title "Fix auth bug" \
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

### Remote dispatch over relay

```bash
result=$(vibe symphony start \
  --agent claude-code \
  --node my-node \
  --relay ws://localhost:7433 \
  --token dev \
  --issue-id ISSUE-123 \
  --issue-title "Fix auth bug" \
  --workspace-key ISSUE-123 \
  --prompt-file task.txt \
  --json)

run_id=$(echo "$result" | jq -r .run_id)

vibe symphony stream "$run_id" \
  --relay ws://localhost:7433 \
  --token dev \
  --jsonl
```

See [`docs/VIBE_RELAY_DEMO.md`](docs/VIBE_RELAY_DEMO.md) for a step-by-step 3-terminal walkthrough (mock and Claude Code variants).

See [`docs/ENCRYPTED_RELAY_DEMO.md`](docs/ENCRYPTED_RELAY_DEMO.md) for the end-to-end encrypted demo using `--encrypt` (MVP 4B–4D).

### Symphony Elixir (ExternalExecutor)

The [universe-symphony](https://github.com/JozzyAI/universe-symphony) fork integrates via
`SymphonyElixir.Codex.ExternalExecutor`, which calls `vibe symphony start/stream` under the hood.
Symphony does **not** use the Codex `AppServer` / JSON-RPC path when `agent_kind: vibe` is set.

WORKFLOW.md (remote node example):
```yaml
agent_kind: vibe
external:
  command: vibe
  agent: claude-code
  node: my-node
  relay: ws://localhost:7433
  token: dev
  permission_mode: unsafe-skip   # optional
```

Smoke tests (from `symphony/elixir/`):
```bash
bash scripts/smoke_vibe_relay.sh            # mock agent — no API key needed
bash scripts/smoke_vibe_relay_claude.sh     # Claude Code — skips if 'claude' not in PATH
```

---

## Identity and signing (MVP 4A)

Each node has a stable cryptographic identity stored at `~/.vibe/identity.json`.

```bash
# Show (or create) this node's identity — never prints private keys
vibe node identity --json
# → {"version":1,"kind":"node","id":"node_a1b2c3d4...","display_name":"Zhaoyi-PC",
#    "signing_alg":"Ed25519","signing_public_key":"...","encryption_alg":"X25519",
#    "encryption_public_key":"...","fingerprint":"SHA256:..."}

# Pair this node with a relay (sends public identity; relay stores it in memory)
vibe node pair --relay ws://localhost:7433 --token dev
# → {"relay_url":"ws://localhost:7433","paired_at":"...","node_id":"node_...","status":"paired"}
```

**Key design:**
- **Ed25519** — signs `node_register` and `node_heartbeat` messages (message authenticity)
- **X25519** — reserved for payload encryption in MVP 4B (not used yet)
- Payloads are still **plaintext** in 4A — signing proves origin, not confidentiality

**Relay modes:**
```bash
# Default: token-only dev mode (existing behavior, unchanged)
vibe relay dev --port 7433 --token dev

# Require-pairing: unpaired nodes and bad signatures are rejected
vibe relay dev --port 7433 --token dev --require-pairing
```

**Demo (3 terminals):**
```bash
# Terminal 1
vibe relay dev --port 7433 --token dev --require-pairing

# Terminal 2
vibe node identity --json
vibe node pair --relay ws://localhost:7433 --token dev
vibe node daemon --local --relay ws://localhost:7433 --token dev

# Terminal 3
vibe node list --remote --relay ws://localhost:7433 --token dev --json
```

**What require-pairing rejects:**
- `node_register` from a node that has not called `node pair` first
- `node_register` with no signature
- `node_register` with an invalid Ed25519 signature

**Identity file format:**
```
~/.vibe/identity.json   # chmod 0600 — contains private keys, never printed to stdout
~/.vibe/paired_relays.json  # list of relays this node has paired with
```

---

## Architecture notes

- **Symphony dispatch path**: `AgentRunner` → `ExternalExecutor.run/4` → `vibe symphony start/stream`.
  This bypasses `AppServer` (Codex JSON-RPC) entirely. `codex.command` and the Codex path are untouched.
- **Plaintext relay**: `vibe relay dev` is for local development only. It binds to `127.0.0.1` and
  sends all messages as unencrypted JSON over WebSocket. **Do not expose to the internet.**
- **Signed plaintext (MVP 4A)**: Messages carry an optional `signature` field (Ed25519). In
  `--require-pairing` mode, the relay verifies signatures against stored public identities.
  Payloads are still plaintext — signing proves origin, not confidentiality.
- **Encrypted run_start (MVP 4B)**: `--encrypt` on `vibe run start` / `vibe symphony start` encrypts
  the sensitive payload (prompt, workspace_key, agent, metadata, permission_mode, repo_url, branch)
  using ephemeral X25519 + AES-256-GCM. The relay sees only routing metadata — it cannot read the
  payload.
- **Encrypted run_event stream (MVP 4C)**: When a run is started with `--encrypt`, each `run_event`
  payload is also encrypted by the node before forwarding. The relay fans out opaque
  `encrypted_run_event` envelopes. `vibe run stream` decrypts locally and prints the same VibeEvent
  JSONL schema — output is unchanged from the caller's perspective. Key derivation reuses the ECDH
  shared secret from `run_start` with a separate HKDF context (`vibe-run-event-v1`). Relay metadata
  still visible: `run_id`, `node_id`, timestamps, message sizes.
- **Encrypted run_stop (MVP 4D)**: `vibe run stop` on an encrypted run automatically sends an
  `encrypted_run_stop_request`. The relay routes by `run_id` ownership without reading the payload.
  The node decrypts, executes the stop, and returns an `encrypted_run_stop_ack`. The CLI decrypts
  and returns the same `RunRecord` JSON as the plaintext path. Uses HKDF context `vibe-run-stop-v1`.
  Both `event_aes_key` and `stop_aes_key` are derived from the same ECDH shared secret at run_start
  time and stored in the local RunRecord — no additional key exchange needed.
- **Remaining plaintext surfaces**: Approval response relay (MVP 4E, if/when implemented).
- **Note**: `approval_required` VibeEvents are already encrypted by MVP 4C (they are run_events).
- **Prompt content over relay**: The controller reads the prompt file and sends text in the
  `run_start` message (`prompt_content`). The worker node writes a local temp file. Controller
  filesystem paths are never sent over the wire.

---

## Milestones

| MVP | Feature | Status |
|-----|---------|--------|
| 0 | `run start/stream/status/stop` — local mock | ✅ done |
| 1A | Claude Code backend — local | ✅ done |
| 1B | `run start` → terminal event loop | ✅ done |
| 2A | `symphony start/stream/status/stop` | ✅ done |
| 2B | Symphony Elixir ExternalExecutor | ✅ done |
| 3A | `vibe relay dev` — WebSocket relay server | ✅ done |
| 3B | `vibe node daemon --local` — heartbeat, register | ✅ done |
| 3C | Remote `run start/stream` over relay | ✅ done |
| 3D | Remote `run stop` over relay | ✅ done |
| 3E | Claude Code backend over relay | ✅ done |
| 3F | Symphony relay dispatch + ExternalExecutor relay pass-through | ✅ done |
| 4A | Identity + pairing + signed plaintext envelope | ✅ done |
| 4B | Encrypt `run_start` payload (X25519 + AES-256-GCM, relay-blind) | ✅ done |
| 4C | Encrypt `run_event` stream (same ECDH key material, domain-separated context) | ✅ done |
| 4D | Encrypt `run_stop` request/ack (`vibe-run-stop-v1` HKDF context) | ✅ done |
| 4E | Encrypt approval response (if/when approval_response path is added) | planned |
