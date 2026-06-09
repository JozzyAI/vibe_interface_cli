# Vibe Interface CLI

Vibe Interface CLI turns any paired machine into an orchestrator-ready worker node.

Most coding-agent orchestrators are tightly coupled to one execution model:

```
orchestrator → SSH host / local process / Codex app-server
```

Vibe introduces a different boundary:

```
orchestrator → Vibe Worker Contract → Vibe Node → coding agent backend
```

The orchestrator stays responsible for task planning, issue lifecycle, retries, and status
tracking. Vibe handles where and how the work runs.

This MVP proves the contract with [Symphony](https://github.com/JozzyAI/universe-symphony):
Symphony can dispatch work through an `ExternalExecutor` seam instead of only talking to
`codex app-server`. The worker runtime is Vibe. The coding agent is mock or Claude Code.
The relay is E2E encrypted.

**What is working:**

- `vibe run start / stream / status / stop` — stable CLI contract any orchestrator can call
- `vibe symphony start / stream / status / stop / approval respond` — Symphony-specific surface
- `vibe node daemon` — long-lived worker node, local or relay-connected
- `vibe relay dev` — dev relay with identity-based pairing and token auth
- `mock` backend — no API key, no agent; proves the full event loop including `approval_required`
- `claude-code` backend — spawns the Claude CLI, streams output back
- E2E encrypted control loop — `run_start`, `run_event`, `run_stop`, `approval_response` are
  AES-256-GCM encrypted; the relay routes ciphertext and never reads payload contents

**CLI reference:**

```
vibe run start  --agent <backend> --workspace-key <key> [--node auto|local|<id>] [options]
vibe run stream <run_id>
vibe run status <run_id>
vibe run stop   <run_id>

vibe symphony start  --issue-id <id> --agent <backend> [--node auto|local|<id>] [options]
vibe symphony stream <run_id>
vibe symphony status <run_id>
vibe symphony stop   <run_id> [--reason <reason>]
vibe approval respond --run-id <id> --approval-id <id> --decision approve|deny

vibe node list   [--remote --relay <url> --token <token>]
vibe node status <node_id>
vibe node pair   --relay <url> --token <token>
vibe node daemon --local [--relay <url> --token <token>]

vibe relay dev   --port <port> --token <token> [--require-pairing]
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
| `codex` | Spawns `codex exec` non-interactively. Requires OpenAI Codex CLI + `VIBE_ENABLE_CODEX=1`. |

### Codex CLI setup

**Install:**

```bash
npm install -g @openai/codex
which codex
codex --help
codex exec --help
```

**Authenticate** (run once interactively before Vibe uses it):

```bash
codex   # follow the auth flow, then exit
```

**Start node with Codex enabled:**

```bash
VIBE_ENABLE_CODEX=1 vibe node daemon \
  --local \
  --relay "$VIBE_RELAY_URL" \
  --token "$VIBE_RELAY_TOKEN"
```

Codex is only advertised when `VIBE_ENABLE_CODEX=1` **and** `codex` is found in `PATH`. If the
binary is missing, a warning is emitted to stderr and the node continues without advertising
the `codex` agent.

**Run a task with Codex:**

```bash
vibe run start --agent codex --workspace-key demo --prompt-file task.txt
```

**Symphony / Linear usage:**

Add the label `agent:codex` to a Linear issue. Symphony will dispatch to a node that advertises
the `codex` agent. The node binding must allow `codex` in its agent list.

**Permission mode:**

By default Codex runs with its own sandbox (`workspace-write`). Use `--permission-mode unsafe-skip`
to pass `--dangerously-bypass-approvals-and-sandbox` to `codex exec` — same semantics as
`claude-code` unsafe-skip:

```bash
vibe run start --agent codex --permission-mode unsafe-skip --prompt-file task.txt
```

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
| `approval_response` request/ack | `EncryptedApprovalResponseMsg/Ack` | `vibe-approval-response-v1` |

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
├── telegram-monitor-state.json  # last-seen snapshot for `vibe monitor telegram` (no secrets)
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

## Telegram monitor (read-only)

`vibe monitor telegram` runs a small bot that reports relay/node/run status to
a Telegram chat — nothing more. It is purely observational: it cannot approve,
deny, merge, start/stop runs, edit Linear issues, edit workflow files, or run
shell commands. There is no code path from a Telegram message to any mutation
anywhere in Vibe, Symphony, or Linear.

It alerts on:
- a node coming online / going offline, or being seen for the first time
- a node's active-run count or agent list changing
- a local run starting, finishing (completed/failed/stopped), or needing approval
- the relay becoming unreachable / failing auth, and recovering

…and answers six status-query commands on request: `/status`, `/nodes`, `/runs`,
`/symphony`, `/linear`, `/help`.

### 1. Create a bot with BotFather

1. Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`.
2. Follow the prompts to name it; BotFather replies with a token that looks like
   `123456789:ABCdefGhIJKlmNoPQRsTUVwxyz`. This is `TELEGRAM_BOT_TOKEN` — keep it secret.

### 2. Find your TELEGRAM_CHAT_ID

Send any message to your new bot, then call `getUpdates` with your token:
```bash
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9-]*'
```
The number after `"id":` is your `TELEGRAM_CHAT_ID` (negative for group chats).

### 3. Configure environment variables

| variable | required | purpose |
|---|---|---|
| `VIBE_RELAY_URL` | yes | relay WebSocket URL to poll for node status |
| `VIBE_RELAY_TOKEN` | yes | relay auth token |
| `TELEGRAM_BOT_TOKEN` | yes | bot token from BotFather |
| `TELEGRAM_CHAT_ID` | yes | chat to post alerts to and accept commands from |
| `SYMPHONY_WORKDIR` | no | enables `/symphony` — local tmux/log/WORKFLOW.md status |
| `LINEAR_API_KEY` | no | enables `/linear` — issue counts and Human Review/Merging summaries |

### 4. Run it

```bash
export VIBE_RELAY_URL=ws://localhost:7433
export VIBE_RELAY_TOKEN=dev
export TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyz
export TELEGRAM_CHAT_ID=123456789

vibe monitor telegram                  # polls + answers commands every 60s
vibe monitor telegram --poll-interval 30
```

**Locally / in tmux** — it's a long-running foreground process, so run it the
same way you'd run `vibe relay dev` or `vibe node daemon`:
```bash
tmux new -s vibe-monitor 'vibe monitor telegram'
```

**As a systemd unit** — set the env vars in the unit's `Environment=`/`EnvironmentFile=`
(not in the command line, where they'd be visible via `ps`), and let systemd
restart it on failure:
```ini
[Service]
EnvironmentFile=/etc/vibe-monitor.env
ExecStart=/usr/bin/vibe monitor telegram
Restart=on-failure
```

### Notes

- State (the last-seen snapshot used to detect changes) is stored at
  `~/.vibe/telegram-monitor-state.json` — node/run summaries and timestamps
  only, never secrets.
- All four secrets (`VIBE_RELAY_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `LINEAR_API_KEY`) are redacted from every error message and log line before
  it can be written or sent anywhere.

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
- **Encrypted approval_response (MVP 4F)**: `vibe approval respond` sends an encrypted approval
  decision. The relay routes by `run_id` without reading the payload. The node decrypts, appends
  an `approval_response` event to the run log, and returns an `encrypted_approval_response_ack`.
  Uses HKDF context `vibe-approval-response-v1`. All four keys (`run_start`, `run_event`,
  `run_stop`, `approval_response`) are derived from the same ECDH shared secret at run_start time
  and stored in the local RunRecord — no additional key exchange needed.
- **Note**: `approval_required` VibeEvents are already encrypted by MVP 4C (they are run_events).
  All approval surfaces are now end-to-end encrypted: the relay sees approval routing metadata but
  never the approval ID, decision, or message.
- **Run-local key storage**: `event_aes_key`, `stop_aes_key`, and `approval_aes_key` are stored
  in `~/.vibe/runs/<run_id>.json` on the controller machine for the lifetime of the run. Protect
  `~/.vibe/runs/` with normal filesystem permissions (the directory is created with mode 0700).
  Anyone with read access to that file can decrypt past event stream, stop, and approval traffic
  for that run. Future hardening may move run keys into the OS keychain or encrypted local storage.
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
| 4E | E2E encryption docs + demo script | ✅ done |
| 4F | Encrypt `approval_response` + `vibe approval respond` CLI (`vibe-approval-response-v1`) | ✅ done |
| 5A | Symphony UI status mapping — vibe fields in running + blocked payloads | ✅ done |
| 5B | Symphony approval API — `POST /approve` routes to `vibe approval respond` | ✅ done |
| 5C | Demo layer — `smoke_vibe_approval.sh` + `SYMPHONY_VIBE_APPROVAL_DEMO.md` | ✅ done |
| 5D | Test stabilization, release README, milestone tags | ✅ done |
