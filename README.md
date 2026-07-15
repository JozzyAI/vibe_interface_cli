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

- `vibe run start / stream / status / stop` — stable CLI contract any orchestrator can call (see [`docs/orchestrator-contract.md`](docs/orchestrator-contract.md) for the canonical command path, JSONL event schema, structured error envelope, and exit codes)
- **Agent Task API** — `vibe api serve` runs a REST + SSE **Agent Task Gateway** (Bearer-auth, loopback-default) over the run lifecycle, projecting the agent-neutral Task/event/error contract that A2A/MCP adapters will also map onto. Runs the **mock** agent locally, and — when started with `--relay` — executes **Claude Code / Codex on a remote node** via the existing `vibe run` remote contract: see [`docs/agent-task-api.md`](docs/agent-task-api.md)
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
vibe run attach <run_id>   # attach to a local run's live tmux session (see below)

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

## Connect a machine — `vibe connect`

One guided command to onboard a machine to a relay — it hides VIBE_DIR, node identity, pairing,
relay token, node_id, and advertised agents behind a single step. It creates or reuses a node
identity, writes a **reusable local profile** (`~/.config/vibe/profile.json`; honors
`$XDG_CONFIG_HOME`), and pairs with the relay **only after you confirm**. It **does not start a
daemon** — you start the node afterward with a bare `vibe node daemon` (it reads the profile). It
**never stores or prints the relay token** — only the token-file path.

```bash
# Preview first — shows exactly what would be created/written/paired, changes nothing:
vibe connect --name work-laptop --relay wss://… --token-file ~/.config/vibe/relay-token --dry-run

# Then connect (prompts before it pairs; --yes skips the prompt). Mock-only by default:
vibe connect --relay wss://… --token-file ~/.config/vibe/relay-token --yes

# After connecting, just start the node — it reads relay/token/VIBE_DIR/agents from the profile:
vibe node daemon

# Remote run commands read the same profile, so you can drop --relay/--token-file too:
vibe run doctor --node <node_id> --agent mock   # read-only readiness preflight (relay/auth/node/agent)
vibe run start  --node <node_id> --agent mock --workspace-key demo
vibe run stream <run_id>
vibe run status <run_id>
vibe run stop   <run_id>
```

`vibe run doctor` reports a readiness envelope (`{ ok, checks, code? }`, exit `0` ready / `1` not) — see [`docs/orchestrator-contract.md`](docs/orchestrator-contract.md#8-readiness-preflight-vibe-run-doctor).

Both `vibe node daemon` and the remote run commands (`run start` / `run stream` / `run status` / `run stop`) fill
missing settings from the profile (`vibe_dir`, `relay_url`, `token_file`; the daemon also fills
`advertise_agents`), so you don't repeat them. Precedence is **CLI flag > env var > profile >
default**, so explicit flags/env still override the profile; with **no profile**, everything behaves
exactly as before (`vibe node daemon` still requires `--local`). Re-running `vibe connect` also
reuses the saved profile. The profile stores only the **token-file path** — never the token value.
(`vibe run web` is unaffected — it still takes `--relay`/`--token-file` explicitly.)

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

## Agent Task API — `vibe api serve` (Gateway v1)

A **REST + SSE** HTTP API in front of the run lifecycle: any caller (Symphony,
CI, an MCP host, a bot) can start an agent task and stream its events over one
uniform, agent-neutral contract — without knowing which harness runs underneath.
Full contract: [`docs/agent-task-api.md`](docs/agent-task-api.md).

```bash
# Start the gateway. Loopback-only by default; a dedicated Bearer token is created
# once at 0600 (its value is never printed — only the file path). Add --relay (or a
# connect profile) to enable remote Claude Code / Codex execution on an online node.
vibe api serve --host 127.0.0.1 --port 8787 \
  --token-file ~/.cache/vibe/api-token \
  --relay ws://<relay-host>:7433 --relay-token-file ~/.config/vibe/relay-token

TOKEN=$(cat ~/.cache/vibe/api-token); BASE=http://127.0.0.1:8787

# List agents (local mock + each online remote node's advertised agents)
curl -H "Authorization: Bearer $TOKEN" $BASE/v1/agents

# Start a remote Claude Code task (202; run_start is ENCRYPTED for the node)
TASK=$(curl -s -X POST $BASE/v1/tasks -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agent":"claude-code","node_id":"node_<id>",
       "input":{"text":"Fix the failing auth test"},
       "workspace":{"workspace_key":"my-task-1"}}' | jq -r .task_id)

# Stream canonical events (id: / event: / data: <TaskEvent>) until the terminal one
curl -N -H "Authorization: Bearer $TOKEN" $BASE/v1/tasks/$TASK/events

# Authoritative status, and idempotent cancel (POST, not DELETE)
curl -H "Authorization: Bearer $TOKEN" $BASE/v1/tasks/$TASK
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/v1/tasks/$TASK/cancel
```

**Gateway v1 at a glance** (see the [contract doc](docs/agent-task-api.md) for detail):

- **Auth:** dedicated `Authorization: Bearer` token (never the relay/terminal
  token), constant-time compared, loopback-only unless `--allow-bind`.
- **Supported request fields:** `agent`, `node_id`, `input.text`,
  `workspace.workspace_key` (opaque `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` — not a
  path), `execution.permission_mode`, `metadata`. **Deferred fields fail closed**
  (400): `workspace.path`/`repo_url`/`branch`, `execution.timeout_seconds`.
- **Remote execution is encrypted** — `run_start` is encrypted for the target
  node (no plaintext fallback); the node independently contains the workspace
  within its workspace root.
- **Durability is process-local:** task→run mappings and SSE replay history are
  in-memory only; a gateway restart loses them (the run store is unaffected).
  Bounds: `MAX_ACTIVE_TASKS=32`, `MAX_RETAINED_COMPLETED_TASKS=100`,
  `MAX_EVENTS_PER_TASK=1000`, `MAX_BODY_BYTES=1 MiB`.
- **Baseline:** [`docs/agent-gateway-v1-baseline.md`](docs/agent-gateway-v1-baseline.md).
- **MCP:** `vibe mcp serve` exposes the gateway as MCP tools for local hosts (Claude Desktop, Cursor) — a pure HTTP client of the gateway: see [`docs/mcp-server.md`](docs/mcp-server.md). Host setup (Claude Code, Cursor), the seven-tool reference, and the recommended run/wait/resume workflow: [`docs/mcp-client-integrations.md`](docs/mcp-client-integrations.md).
- **Workflow contract (v1):** a declarative, JSON-first multi-agent workflow spec (e.g. a Codex-planner → Claude-Code-executor → Codex-review loop) — types + a pure validator: see [`docs/workflow-contract.md`](docs/workflow-contract.md).
- **Workflow Runtime (v1):** a minimal deterministic, durable planner/executor runtime that executes a validated spec over the durable control store + Agent Gateway, surviving runtime/Gateway restarts without duplicating Agent Tasks (internal runtime only — no NL generation, REST/MCP, or UI): see [`docs/workflow-runtime.md`](docs/workflow-runtime.md).
- **Durable control store:** a local SQLite (`better-sqlite3`, WAL) persistence layer for tasks/events and workflow/execution state — foundation only, not yet wired into the running gateway: see [`docs/durable-control-store.md`](docs/durable-control-store.md).
- **Node run event journal:** a durable, Node-local SQLite journal of remote-run events (append-before-publish) so a Node captures output without a Gateway attached and a reconnecting client can resume via a Node `after_sequence` cursor — distinct from the Gateway task-event domain: see [`docs/node-run-journal.md`](docs/node-run-journal.md).

## Backends

| Backend | Description |
|---|---|
| `mock` | Internal fake runner. Emits synthetic events including `approval_required`. No network. |
| `claude-code` | Spawns `claude` CLI in stream-json mode. Requires Claude Code installed. |
| `codex` | Spawns `codex exec` non-interactively. Requires OpenAI Codex CLI + `VIBE_ENABLE_CODEX=1`. |
| `opencode` | Reserved `AgentBackend` value; no adapter yet (`run start --agent opencode` fails fast — there is nothing to dispatch to). |

### `--agent auto` (local runs only)

`vibe run start --agent auto` picks a backend at start time instead of requiring one up front: it
tries `claude-code` → `codex` → `opencode` → `mock`, in that order, and uses the first one whose CLI
binary is actually on `PATH` (`mock` has no binary and is always available, so `auto` never fails to
start something — see `src/runtime/router.ts`). This is independent of, and runs before, the
Meta-Agent Runtime's mid-run `--fallback-agent` chain (below): the router picks what to *start*;
the runtime decides whether to *switch* after a failure. `--agent auto` is not supported with
`--relay` (remote dispatch) — pass an explicit backend there.

> **Manual smoke tests: use `--agent mock`, not `--agent auto`.** On a machine where a real
> `claude` / `codex` / `opencode` binary is on `PATH`, `auto` resolves to that real backend and
> **spawns the real (paid) CLI**. For a local-only, no-cost smoke that exercises the full run
> lifecycle, always pass `--agent mock` explicitly. Reserve `auto` for real work.

### Mock runner test knobs

For exercising the run lifecycle without any real agent:

- `VIBE_MOCK_FAIL_REASON=<reason>` — fail with classifier-recognized text instead of completing.
  Supported: `session_limit`, `usage_limit`, `quota_exceeded`, `rate_limited`, `context_limit`,
  `auth_expired`, `tests_failed`, `command_not_found` (simulates the agent's CLI binary going
  missing — exit code 127, classified `command_not_found`, recoverable).
- `VIBE_MOCK_RUN_MS=<ms>` — total time to a terminal outcome (default ~4.4s if unset). `0` completes
  immediately; a larger value is useful for testing "still running" / stop-mid-run behavior.

### Local run sessions (`run attach`, optional tmux)

A local run is backed by a detached supervisor process. Its `session_id` is a **stable reference**
to that session, persisted in the run record:

- **Default:** the supervisor is a plain detached process and `session_id` is its PID. Watch it with
  `vibe run stream <run_id>`; terminal status stays readable via `vibe run status <run_id>` after exit.
- **Opt-in tmux (`VIBE_USE_TMUX=1`):** the supervisor runs inside a tmux session named
  `vibe-run-<run_id>`, and `session_id` is that name. You can then `vibe run attach <run_id>` to drop
  into the live session and watch the runner directly. `vibe run stop` tears the tmux session down.

```bash
# Inspectable, attachable local mock run
VIBE_USE_TMUX=1 VIBE_MOCK_RUN_MS=20000 vibe run start --agent mock --workspace-key demo --json
vibe run attach <run_id>        # interactive: attaches to the vibe-run-<run_id> tmux session
vibe run attach <run_id> --json # non-interactive: prints { mode, attach_command, ... }
```

`vibe run attach` returns a structured error rather than hanging when there is nothing to attach to:
`session_not_found` for a finished run, `session_not_attachable` for an active run started without
tmux (use `run stream` instead). tmux is optional — if it is not installed, runs transparently fall
back to the detached-process model.

> tmux env note: tmux-backed runs forward only a **non-secret** env allowlist (`VIBE_DIR`, `PATH`,
> `VIBE_MOCK_*`) onto the `tmux new-session` argv, so relay tokens and other secrets are never exposed
> in process arguments.

### Personal Local Web Viewer

`vibe run web <run_id>` serves a **personal, local, read-only** browser view of a run's live session.
It is intentionally minimal and private:

- **Private by default:** binds `127.0.0.1` only. No relay, no public share links, no E2E capability
  links. Binding a non-loopback host is refused unless you pass `--allow-public-bind` (which prints a
  warning).
- **Public-bind auth gate:** loopback needs no auth (frictionless). When you `--allow-public-bind`,
  the viewer generates a **one-time local access token** and prints it in the URL
  (`http://<host>:<port>/?access=<token>`); requests without it get `401`. The first authorized
  request sets an `HttpOnly` cookie so the browser's polls don't carry the token thereafter. This is a
  **local gate only** — the token never touches the relay (it is not the relay token) and it is not a
  shareable capability link.
- **Read-only:** only `GET` is served (any other method returns `405`); there is no keyboard/terminal
  input and no shell is exposed. The single tmux interaction is the read-only `tmux capture-pane -p`.
- **tmux-backed runs:** the run must have a live tmux session (start it with `VIBE_USE_TMUX=1`). A
  detached-PID run returns a structured `session_not_web_attachable` (use `vibe run stream` instead);
  an unknown run exits `3`; if tmux is not installed it returns `web_viewer_dependency_missing`.
- **What it shows:** the live tmux pane when it has output, otherwise the run's redacted event log
  (so structured-output agents like the mock runner are still visible). Output is passed through the
  same secret-redaction as the event log before reaching the browser.
- **Clean shutdown:** when the run stops, the viewer keeps serving and shows the session as ended.

```
vibe run web <run_id> [--port <port>] [--host 127.0.0.1] [--allow-public-bind] [--json]
```

```bash
# Personal local viewer for a tmux-backed mock run
VIBE_USE_TMUX=1 VIBE_MOCK_RUN_MS=20000 vibe run start --agent mock --workspace-key demo --json
vibe run web <run_id> --port 7681          # then open http://127.0.0.1:7681
vibe run web <run_id> --port 7681 --json   # prints { url, host, port, mode:"read-only", ... }
vibe run stop <run_id>                     # viewer then shows the session as ended
```

### Personal Remote Web Viewer

> **Full guide:** [docs/private-remote-viewer.md](docs/private-remote-viewer.md) — the end-to-end
> private remote viewer workflow (paired mock-only node setup, quickstart, `run viewers`,
> public-bind access token, troubleshooting, and the security model).

Pass `--node <node_id>` to view a run owned by **another node**, reached over the relay. Same
private, read-only guarantees as the local viewer — it just sources its data from the relay
stream instead of a local tmux pane.

- **Private by default:** binds `127.0.0.1` only; non-loopback bind refused without
  `--allow-public-bind`. No public share URL, no E2E capability link.
- **Public-bind auth gate:** loopback is frictionless; a `--allow-public-bind` viewer requires a
  one-time local access token (printed in the URL as `?access=<token>`, then carried via an
  `HttpOnly` cookie), returning `401` otherwise. Local gate only — never the relay token, not a
  shareable link.
- **Read-only:** only `GET` is served (`405` otherwise); no keyboard input, no shell. Stop a
  remote run with `vibe run stop <run_id> --node <id> --relay <url>` — never from the browser.
- **Reuses the relay APIs:** one background subscription (`remoteStream`) fills an in-memory
  buffer the browser polls; events are passed through secret-redaction before display.
- **Token hygiene:** the relay token comes from `--token-file <path>` or `VIBE_RELAY_TOKEN` —
  never `--token <value>` (which would leak into process args).
- **Live connection state:** the page header shows `run_id`, `node_id`, `status`, the event
  `source`, and a colour-coded connection chip — `live` → `reconnecting` (transient relay
  blip; the browser keeps polling with backoff, it never gives up on the first hiccup) →
  `ended` (run finished) or `disconnected` (relay stream gave up — *the run may still be
  active on the node*), plus an "updated Ns ago" freshness indicator.
- **Structured errors:** an offline node returns `node_offline`, an unknown run `run_not_found`,
  a missing/invalid token `auth_token_error`, a missing relay `relay_required`; a public bind is
  refused with `public_bind_refused`.

```
vibe run web <run_id> --node <node_id> --relay <url> [--token-file <path>] \
  [--port <port>] [--host 127.0.0.1] [--allow-public-bind] [--json]
```

**Quickstart** (against the production relay, with a paired node — token via file, never argv):

```bash
vibe run start --node <node_id> --agent mock --workspace-key demo \
  --relay wss://vibe-relay.dynastylab.ai --token-file ~/.config/vibe/relay-token --json
# → { "run_id": "run_…", … }
vibe run web run_… --node <node_id> \
  --relay wss://vibe-relay.dynastylab.ai --token-file ~/.config/vibe/relay-token
# → opens a read-only viewer at http://127.0.0.1:<port> — watch live events in the browser
vibe run stop run_… --node <node_id> \
  --relay wss://vibe-relay.dynastylab.ai --token-file ~/.config/vibe/relay-token   # stop is CLI-only
```

For a fully offline check, point the same commands at an in-process `startRelayServer` + a local
`vibe node daemon --local --relay ws://…` (mock-capable) — no production relay, no paid agent.

### Active Viewer Registry

Viewers bind ephemeral ports, so the URL is easy to lose. Every `vibe run web …` (local or remote)
records itself in a small local registry (`~/.vibe/viewers.json`, `0600`) so you can rediscover
and manage active viewers — no daemon, no service:

```
vibe run viewers list                 # active viewers: run_id, viewer_id, mode, url, pid, auth, age
vibe run viewers open <run_id|vw_id>  # print the viewer's URL again
vibe run viewers stop <run_id|vw_id>  # stop the LOCAL viewer process (NOT the remote run)
```

- **No secrets stored:** the registry holds only the **base URL** (`http://host:port`) and pid —
  never the relay token and never the public-bind access token. `open` on a loopback viewer prints
  the full working URL; on a token-gated (public-bind) viewer it prints the base URL and notes that
  the one-time access token was shown only when the viewer started.
- **Self-pruning:** liveness is the recorded pid (`process.kill(pid, 0)`), so a crashed viewer's
  record is dropped on the next `list`/`open`/`stop` — no stale entries pile up.
- `vibe run viewers stop` signals only the local viewer HTTP process; the run itself keeps going
  (use `vibe run stop` for that).

### Web terminal (`vibe terminal`) — interactive, write-capable

`vibe run web` is **read-only**. `vibe terminal serve` is a separate, **write-capable** browser
terminal (xterm.js) bound to an **existing local tmux session** — you type in the browser and the
keystrokes go to the session. This is the Terminal Mode MVP: **local tmux only** (no relay, no agent
launching yet). You create the session; the terminal attaches to it.

```bash
# create a session yourself first, then serve it:
tmux new -d -s work 'bash'
vibe terminal serve --session work            # binds 127.0.0.1:8790, prints a URL with a one-time control token
# open the printed http://127.0.0.1:8790/?control=… in a browser and type
```

Because it is write-capable, it is stricter than the read-only viewer:

- **Loopback-only by default.** A non-loopback bind requires the explicit **`--allow-control-bind`**
  (a stronger, separate flag — *not* the viewer's `--allow-public-bind`) and prints a loud warning.
  For phone/LAN access, prefer loopback + an SSH tunnel.
- **A one-time control token** (distinct from the read-only viewer access token) gates **both** the
  page and the WebSocket; it arrives via `?control=` and is stored as an HttpOnly cookie (JS never
  sees it). Missing session ⇒ a clean `tmux_session_not_found` error.
- **No secrets/keystrokes logged.** The server never logs the token or typed input.

```bash
vibe terminal serve --session work --host 192.168.1.50 --port 8790 --allow-control-bind   # LAN (discouraged)
```

**Remote mode** (`--node`) bridges the browser to a tmux session on a *remote* node over the relay —
phone/VPN → gateway → relay → node → tmux → Claude Code. Relay/token default from the connect
profile, and `--url-file` keeps the write-capable URL out of your scrollback:

```bash
vibe terminal serve --node <node_id> --session remote-claude \
  --host 192.168.1.89 --port 8790 --allow-control-bind --url-file ~/.cache/vibe/terminal-url
```

> **Full guide:** [docs/remote-terminal.md](docs/remote-terminal.md) — the LAN/VPN pattern, profile
> defaults, safe URL handling, security, and cleanup.

Deferred: remote session creation/lifecycle (`--create`, `terminal list/stop`), launching agents in
one command (`--command claude`), and node-pty.

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

### Remote relay transport smoke (mock only, secure token)

The same `start → status → stream → stop` contract you run locally also works over
the relay. The snippet below is a copy-paste smoke that keeps the **token out of
process args** (no `--token <value>`): the CLI reads it from a `0600` file via
`--token-file`, and the daemon reads it from the `VIBE_RELAY_TOKEN` env. Use the
**mock** agent only — never `--agent auto` — so no paid CLI is invoked.

```bash
# Throwaway state + a 0600 token file (token never lands in argv).
export VIBE_DIR="$(mktemp -d)"
tokfile="$VIBE_DIR/relay.token"
printf 'dev-smoke-token' > "$tokfile" && chmod 600 "$tokfile"

# Terminal 1 — relay (dev mode, loopback only).
vibe relay dev --port 7433 --token dev-smoke-token

# Terminal 2 — node daemon; token via env, not argv.
VIBE_RELAY_TOKEN=dev-smoke-token \
  vibe node daemon --local --relay ws://127.0.0.1:7433 --node-id smoke-node

# Terminal 3 — drive the contract with --token-file.
relay=ws://127.0.0.1:7433
vibe node list --remote --relay "$relay" --token-file "$tokfile" --json
# → [{"node_id":"smoke-node","transport":"relay",...}]

run_id=$(vibe run start --node smoke-node --agent mock --workspace-key demo \
  --relay "$relay" --token-file "$tokfile" --json | jq -r .run_id)

vibe run status "$run_id" --relay "$relay" --token-file "$tokfile" --json   # node-authoritative record (or drop the flags after `vibe connect`)
vibe run stream "$run_id" --relay "$relay" --token-file "$tokfile"   # JSONL until completed
vibe run stop   "$run_id" --relay "$relay" --token-file "$tokfile"   # → {"status":"stopped",...}
```

Unknown runs surface `run_not_found`, and a run whose owning node has gone offline
surfaces `node_offline` — the relay never invents a terminal status. Automated
coverage of this contract (fake relay + real mock daemon, isolated `VIBE_DIR`,
no token leakage) lives in `test/relay-transport-smoke.test.ts`.

#### Against a real relay (manual, mock-only)

To verify the same contract over a **real** relay (the automated test uses a
fake in-process one), use `scripts/real-relay-smoke.sh`. A real relay needs a
real token, so this is a manual runbook — never wired into CI.

```bash
npm run build && chmod +x dist/src/index.js
I_CONFIRM_DISPATCH_PAUSED=1 \
RELAY_URL=wss://vibe-relay.dynastylab.ai \
VIBE_RELAY_TOKEN_FILE=/path/to/0600-token-file \
  bash scripts/real-relay-smoke.sh
```

The script is safe by construction:

- **Dispatch gate.** It refuses to run unless `I_CONFIRM_DISPATCH_PAUSED=1`.
  By default a node daemon advertises every agent it can run (including
  `claude-code`), so while the node is online a production orchestrator that is
  actively dispatching could hand it a real, paid job. Pair this gate with the
  mock-only advertise valve below, and only run when dispatch is paused.
- **Mock-only advertise.** Set `VIBE_NODE_ADVERTISE_AGENTS=mock` (or
  `vibe node daemon --advertise-agent mock`) so the node publishes **exactly**
  `["mock"]` to the relay. An orchestrator then can't dispatch `claude-code` to
  it even if dispatch is live — the structural safety valve. This only changes
  what the node advertises; local runs are unaffected.
- **Isolated.** It brings the node up under a throwaway `VIBE_DIR` and a
  throwaway `node-id`, so it never disturbs this machine's real `~/.vibe` or the
  persistent node identity.
- **Token hygiene.** The token is taken from `--token-file` (or copied from
  `VIBE_RELAY_TOKEN` into a private `0600` temp file); it is never passed as
  `--token <value>`, never echoed, and the run asserts it never appears in any
  command output.
- **Mock only.** Every run it issues is `--agent mock`; it never uses
  `--agent auto`. On exit it tears down the daemon and checks for stragglers.

##### Mock-only advertise allowlist

Before any real-relay smoke, restrict what the node advertises so a production
orchestrator can only ever dispatch the mock agent to it:

```bash
# Bring a throwaway node online advertising ONLY mock (token via env/file, never argv):
VIBE_NODE_ADVERTISE_AGENTS=mock \
VIBE_RELAY_TOKEN_FILE=/path/to/0600-token-file \
  vibe node daemon --local \
    --relay wss://vibe-relay.dynastylab.ai \
    --node-id "smoke-$(date +%s)"          # throwaway node-id
# equivalently: vibe node daemon --local --advertise-agent mock ...

# Drive runs with the mock agent only — never --agent auto:
vibe run start --node "<node-id>" --agent mock --json
```

Rules of the safe real-relay smoke:

- **Advertise mock only** — `VIBE_NODE_ADVERTISE_AGENTS=mock` (or repeatable /
  comma-separated `--advertise-agent`). The node publishes exactly `["mock"]`;
  an empty or unknown allowlist fails fast with a structured error.
- **Throwaway node-id** — never the machine's persistent identity.
- **Token via `--token-file` or `VIBE_RELAY_TOKEN`** — never `--token <value>`.
- **`--agent mock` for every run** — never `--agent auto` (it would pick a real,
  paid CLI if one is installed).

The valve only filters what is published to the relay; the node's local runner
support (`resolveAgents`) and local runs are unchanged.

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

After `vibe connect`, `vibe symphony start/status/stream/stop` read the same
profile defaults as `vibe run` (relay / token-file / VIBE_DIR; precedence
**CLI flag > env var > profile > default**), so you don't repeat `--relay` /
`--token-file`. Remote failures emit the same structured error envelope as
`vibe run` — see [`docs/orchestrator-contract.md`](docs/orchestrator-contract.md).

```bash
result=$(vibe symphony start \
  --agent claude-code \
  --node my-node \
  --issue-id ISSUE-123 \
  --issue-title "Fix auth bug" \
  --workspace-key ISSUE-123 \
  --prompt-file task.txt \
  --json)

run_id=$(echo "$result" | jq -r .run_id)

vibe symphony stream "$run_id" --jsonl

# (Without a profile, pass --relay ws://localhost:7433 --token-file <path> explicitly.)
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
