# Vibe Encrypted Relay Demo (MVP 4B–4D)

End-to-end encrypted demo for `run_start`, `run_event` stream, and `run_stop`.
The relay cannot read task payloads, agent output, or stop/control messages.

## What is encrypted

| Surface | Wire type | HKDF context |
|---|---|---|
| `run_start` payload | `EncryptedRunStartMsg` | `vibe-run-start-v1` |
| `run_event` stream | `EncryptedRunEventMsg` | `vibe-run-event-v1` |
| `run_stop` request/ack | `EncryptedRunStopRequestMsg` / `EncryptedRunStopAckMsg` | `vibe-run-stop-v1` |

## What the relay still sees (metadata)

- `from` / `to` (node IDs, `'cli'`, `'relay'`)
- `run_id` / `req_id`
- Timestamps (`ts`)
- Message type (`encrypted_run_event`, `encrypted_run_stop_request`, …)
- Ciphertext size (traffic timing)

## What the relay cannot see

- Prompt content / task description
- Agent stdout / stderr / tool calls
- `status`, `log`, `approval_required` event content
- Stop reason
- Run result / exit code

---

## Key derivation

All three keys come from the **same X25519 ECDH exchange** established during `run_start`.
No additional round-trips or key exchanges are needed for events or stops.

```
CLI ephemeral X25519 keypair (generated per run)
  ↓  ECDH with node's long-term X25519 public key
shared_secret

HKDF(shared_secret, 'vibe-run-start-v1') → run_start AES-256 key
HKDF(shared_secret, 'vibe-run-event-v1') → run_event AES-256 key  (stored in ~/.vibe/runs/<run_id>.json)
HKDF(shared_secret, 'vibe-run-stop-v1')  → run_stop  AES-256 key  (stored in ~/.vibe/runs/<run_id>.json)
```

Each encrypted message uses a fresh 12-byte random nonce (AES-256-GCM).
The auth tag (16 bytes) prevents ciphertext tampering.

---

## 3-terminal encrypted demo

### Prerequisites

```bash
npm install && npm run build && npm link   # install vibe globally
vibe node identity --json                  # auto-creates ~/.vibe/identity.json
```

### Terminal 1 — relay with pairing enforced

```bash
vibe relay dev --port 8787 --token dev --require-pairing
# [vibe-relay] listening on ws://127.0.0.1:8787
```

### Terminal 2 — node daemon

```bash
# Pair this node with the relay first (one-time)
vibe node pair --relay ws://localhost:8787 --token dev

# Start daemon
vibe node daemon --local --relay ws://localhost:8787 --token dev --node-id node-a
# [vibe-node] daemon started — node_id=node-a
# [vibe-node] registered ✓
```

### Terminal 3 — encrypted run

```bash
# Discover nodes (node-a should appear with encryption_public_key)
vibe node list --remote --relay ws://localhost:8787 --token dev --json

# Start an encrypted mock run
result=$(vibe run start \
  --node node-a \
  --relay ws://localhost:8787 \
  --token dev \
  --agent mock \
  --workspace-key e2e-demo \
  --encrypt \
  --json)
echo "$result"
run_id=$(echo "$result" | jq -r .run_id)

# Stream events — printed as plain VibeEvent JSONL (relay saw only ciphertext)
vibe run stream "$run_id" \
  --relay ws://localhost:8787 \
  --token dev \
  --jsonl
# {"type":"status","status":"running",...}
# {"type":"log","message":"Cloning repository...",...}
# {"type":"approval_required","message":"Proceed with modifying tracked files?",...}
# {"type":"status","status":"completed",...}

# Or stop mid-run
vibe run stop "$run_id" \
  --relay ws://localhost:8787 \
  --token dev \
  --json
# {"run_id":"...","status":"stopped",...}
```

**What you can verify**: while the run is active, check Terminal 1 (relay) — it shows no
prompt content, no log lines, no event payloads. Only routing metadata like `run_id` and
timestamps appear in relay stderr.

---

## Encrypted run with Claude Code

```bash
# Write a prompt
echo "List the files in the current directory." > /tmp/task.md

result=$(vibe run start \
  --node node-a \
  --relay ws://localhost:8787 \
  --token dev \
  --agent claude-code \
  --workspace-key claude-demo \
  --prompt-file /tmp/task.md \
  --permission-mode unsafe-skip \
  --encrypt \
  --json)

run_id=$(echo "$result" | jq -r .run_id)
vibe run stream "$run_id" --relay ws://localhost:8787 --token dev --jsonl
```

> ⚠️ `--permission-mode unsafe-skip` allows Claude to execute code without prompting.
> Only use in fully controlled workspaces.

---

## Encrypted Symphony dispatch

```yaml
# WORKFLOW.md
agent_kind: vibe
external:
  command: vibe
  agent: claude-code
  node: node-a
  relay: ws://localhost:8787
  token: dev
  permission_mode: unsafe-skip
  encrypt: true          # enables end-to-end encryption
```

---

## Encrypted surfaces (MVP 4B–4F)

| Surface | Status | HKDF context |
|---|---|---|
| `run_start` payload | ✅ encrypted (MVP 4B) | `vibe-run-start-v1` |
| `run_event` stream | ✅ encrypted (MVP 4C) | `vibe-run-event-v1` |
| `run_stop` request/ack | ✅ encrypted (MVP 4D) | `vibe-run-stop-v1` |
| `approval_response` request/ack | ✅ encrypted (MVP 4F) | `vibe-approval-response-v1` |

`approval_required` events are part of the `run_event` stream and are already encrypted by MVP 4C.
All four keys are derived from the single ECDH shared secret established at `run_start` time —
no additional key exchange is needed for stop or approval operations.

### Sending an approval response (terminal 1 — controller)

```bash
# After seeing an approval_required event from vibe run stream:
vibe approval respond \
  --run-id run_abc123 \
  --approval-id appr_xyz \
  --decision approve \
  --message "looks good" \
  --relay ws://localhost:9876 \
  --token dev
# → {"ok":true,"run_id":"run_abc123","approval_id":"appr_xyz","decision":"approve"}
```

The relay forwards the opaque ciphertext to the node daemon by `run_id` ownership. The node decrypts, appends an `approval_response` event to the run log, and returns an encrypted ack. The relay never sees the approval ID, decision, or message.

---

## Security notes

- **Plaintext relay dev mode**: `vibe relay dev` binds to `127.0.0.1` only.
  All WebSocket traffic is unauthenticated at the transport layer (no TLS).
  `--require-pairing` + Ed25519 signatures verify node identity, but the relay
  itself is not authenticated to the CLI (planned for a future release).
- **Key storage**: `event_aes_key`, `stop_aes_key`, and `approval_aes_key` are stored in
  `~/.vibe/runs/<run_id>.json` (mode 0600 directory). The node stores `stop_aes_key` and
  `approval_aes_key` in its own RunRecord. None of these keys are printed to stdout.
- **No forward secrecy today**: all session keys derive from a single ephemeral keypair.
  Compromise of the node's X25519 private key retroactively decrypts all runs.
  Per-message ephemeral keys (proper forward secrecy) are planned for a future milestone.
- **Outer envelope fields are unsigned in 4B–4D**: outer `from`/`to`/`ts` fields on
  encrypted envelopes are not signed (no client identity yet). AEAD auth tags protect
  payload integrity. Outer envelope signing is tracked as TODO(4E) in `src/relay/client.ts`.
