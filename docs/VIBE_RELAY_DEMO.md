# Vibe Relay Live Demo

End-to-end walkthrough: Symphony → relay → remote Vibe Node → Claude Code (or mock).

> **Security note:** The relay runs in plaintext localhost dev mode. Do not expose it to the
> public internet. E2E encryption is planned for MVP 4.

---

## Prerequisites

```bash
# vibe CLI
cd /path/to/vibe-interface-cli && npm install && npm run build && npm link
vibe --version   # → 0.x.x

# Claude Code (only needed for the Claude Code demo)
claude --version
```

---

## Demo A — mock agent (no API key needed)

Three terminals, same machine.

### Terminal 1 — relay

```bash
vibe relay dev --port 7433 --token dev
```

Expected output:
```
[relay] Vibe relay listening on ws://localhost:7433  token=dev
```

### Terminal 2 — worker node

```bash
vibe node daemon --local \
  --relay ws://localhost:7433 \
  --token dev \
  --node-id my-node
```

Expected output:
```
[daemon] registered node_id=my-node  relay=ws://localhost:7433
[daemon] heartbeat loop started  interval=5000ms
```

### Terminal 3 — Symphony dispatch (mock)

```bash
# Confirm node is online
vibe node list --remote --relay ws://localhost:7433 --token dev

# Dispatch a job
vibe symphony start \
  --agent mock \
  --node my-node \
  --relay ws://localhost:7433 \
  --token dev \
  --issue-id demo-1 \
  --issue-title "Demo issue" \
  --workspace-key demo-1 \
  --json
# → {"run_id":"run_...","status":"running","node_id":"my-node",...}

# Stream events
RUN_ID=<run_id from above>
vibe symphony stream "$RUN_ID" \
  --relay ws://localhost:7433 \
  --token dev \
  --jsonl
```

Expected stream:
```json
{"type":"status","status":"running","run_id":"run_..."}
{"type":"log","message":"[mock] Analyzing repo…","run_id":"run_..."}
{"type":"log","message":"[mock] Running tests…","run_id":"run_..."}
{"type":"log","message":"[mock] Applying changes…","run_id":"run_..."}
{"type":"status","status":"completed","run_id":"run_..."}
```

### Automated smoke test (mock)

```bash
bash elixir/scripts/smoke_vibe_relay.sh
```

---

## Demo B — Claude Code agent

Same 3-terminal setup, different agent.

### Terminal 2 — worker node (same as Demo A)

```bash
vibe node daemon --local \
  --relay ws://localhost:7433 \
  --token dev \
  --node-id cc-node
```

### Terminal 3 — Symphony dispatch (Claude Code)

```bash
# Write a prompt
cat > /tmp/demo-prompt.md <<'EOF'
Print "Hello from remote Vibe Node" and nothing else.
Do not create any files.
EOF

# Dispatch to Claude Code
vibe symphony start \
  --agent claude-code \
  --node cc-node \
  --relay ws://localhost:7433 \
  --token dev \
  --issue-id demo-cc-1 \
  --issue-title "Claude Code relay demo" \
  --workspace-key demo-cc-1 \
  --prompt-file /tmp/demo-prompt.md \
  --json

# Stream (streams claude output as log events until completed/failed)
vibe symphony stream "$RUN_ID" \
  --relay ws://localhost:7433 \
  --token dev \
  --jsonl
```

### Automated smoke test (Claude Code)

```bash
bash elixir/scripts/smoke_vibe_relay_claude.sh
# Skips cleanly if 'claude' is not in PATH.
# Accepts status=failed as non-error (claude may need auth or trust).
```

---

## Demo C — Symphony Elixir dispatch

For full Elixir integration, add relay config to `WORKFLOW.md`:

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

Then run:
```bash
cd symphony/elixir && mix symphony.run
```

Symphony's `ExternalExecutor` calls `vibe symphony start/stream` automatically.

---

## Architecture

```
Symphony (Elixir)
  ↓  ExternalExecutor.run/4
  ↓  System.cmd: vibe symphony start --relay ... → run_id
  ↓  Port.open:  vibe symphony stream <run_id> --relay ... → JSONL

vibe symphony start (controller side)
  ↓  WebSocket → relay → WebSocket → daemon (worker node)
  ↓  run_start msg  (prompt_content sent inline — not a file path)
  ↓  run_ack msg    (run_id, status=running)

daemon (worker node)
  ↓  writes prompt to local temp file
  ↓  spawns _mock-runner OR _claude-runner
  ↓  tailRunEvents: polls JSONL file → forwards run_event msgs over relay

vibe symphony stream (controller side)
  ↓  WebSocket → relay → WebSocket → daemon
  ↓  receives run_event msgs → prints JSONL to stdout

Symphony / orchestrator reads JSONL stdout until terminal event.
```

**Key design decisions:**

- Prompt file path is **not** sent over the relay. The controller reads the file and sends
  `prompt_content` (text). The worker node writes a local temp file. This makes the path
  independent of cross-machine filesystem layouts.

- The relay is a **dumb message bus** — it routes by `to`/`from` node IDs, no business logic.

- Encryption is **not implemented** in the relay dev mode. All messages are plaintext JSON
  over WebSocket. E2E encryption (per-session key exchange, encrypted payloads) is planned
  for MVP 4.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `node_not_found: Node not found: my-node` | Node daemon not registered | Confirm daemon is running and connected before dispatching |
| `status=failed` after claude-code start | Claude not authenticated | Run `claude --version` and authenticate |
| `stream_timeout` | Run never started on node | Check node daemon logs; `vibe node list --remote` should show node as `online` |
| Relay exits immediately | Port already in use | `lsof -i :7433` and kill the process, or use a different `--port` |
| `ERROR: vibe CLI not found` | vibe not in PATH | Run `cd vibe-interface-cli && npm run build && npm link` |
