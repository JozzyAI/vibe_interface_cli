# Private Remote Viewer — workflow & release checkpoint

Watch a Vibe run from your browser — including a run owned by **another node**, reached
over the relay — **privately and read-only**. This is a personal/private workflow: there
are **no public share links and no end-to-end (E2E) capability links** (see
[Not implemented yet](#not-implemented-yet)).

Milestone status (CLI): complete after PRs #28–#31 — remote viewer MVP (#28), reconnect /
stream-state UX (#29), public-bind access-token gate (#30), and the active viewer registry
(#31). The real-relay path is proven end-to-end with a paired mock-only node.

---

## Security model

- **Read-only.** Only `GET` is served; any other method returns `405`. There is **no keyboard
  input, no terminal, no shell**, and **no browser-side stop/control button**. Stopping a run is
  a CLI operation only.
- **Private by default.** The viewer binds `127.0.0.1`. A non-loopback bind is refused unless you
  pass `--allow-public-bind`, which then requires an access token (below).
- **The relay token never reaches the browser.** It is used only for the node↔relay WebSocket. It
  is never placed in the viewer URL, the page, the `/api/pane` payload, process args, or logs.
- **The viewer access token is NOT the relay token.** It is a separate, locally-generated,
  one-time token that gates *only* the local viewer HTTP process when public-bound. It never
  touches the relay.
- **Redaction.** Event text is passed through secret-redaction before it reaches the browser.

---

## One-time setup: a paired, mock-only private node

The production relay runs with `--require-pairing`, so a node must be paired **once** before it
can register. Use a dedicated private node identity (kept separate from `~/.vibe`) that advertises
**mock only**, so it can never be handed a real paid agent job.

```bash
# Dedicated identity dir + a friendly label (created on first use).
export VIBE_DIR=~/.config/vibe/smoke-node
export VIBE_NODE_DISPLAY_NAME=my-private-node

# Pair ONCE with the relay (writes the relay's pairing store). Token via file, never argv.
node dist/src/index.js node pair \
  --relay wss://vibe-relay.dynastylab.ai \
  --token-file ~/.config/vibe/relay-token
# → { "node_id": "node_…", "status": "paired" }
```

The node's `node_id` is its **key-derived `identity.id`** (a `node_…`), not an arbitrary string —
the relay matches pairings by `node_id == identity.id`.

---

## Mock-only safety

Bring the node online advertising **mock only**, so a production dispatcher cannot assign it a
real `claude-code` job, and only ever start `--agent mock` runs:

```bash
export VIBE_NODE_ADVERTISE_AGENTS=mock      # node publishes exactly ["mock"] to the relay

node dist/src/index.js node daemon --local \
  --relay wss://vibe-relay.dynastylab.ai \
  --token-file ~/.config/vibe/relay-token   # registers as identity.id; no --node-id

# Confirm it advertises mock only:
node dist/src/index.js node list --remote \
  --relay wss://vibe-relay.dynastylab.ai --token-file ~/.config/vibe/relay-token --json
# → the node's "agents" should be exactly ["mock"]
```

> Never use `--agent auto` for this workflow. This guide only ever starts `--agent mock`.

---

## Quickstart: start a remote run and view it

```bash
RELAY=wss://vibe-relay.dynastylab.ai
TOKEN=~/.config/vibe/relay-token
NODE=node_…   # the paired node_id from setup

# 1. Start a mock run on the remote node.
node dist/src/index.js run start --node "$NODE" --agent mock --workspace-key demo \
  --relay "$RELAY" --token-file "$TOKEN" --json
# → { "run_id": "run_…", … }

# 2. Open the private read-only viewer for it.
node dist/src/index.js run web run_… --node "$NODE" \
  --relay "$RELAY" --token-file "$TOKEN"
# → read-only viewer at http://127.0.0.1:<port>  (Ctrl-C to stop)

# 3. Stop the RUN from the CLI (the viewer never stops the run).
node dist/src/index.js run stop run_… --node "$NODE" --relay "$RELAY" --token-file "$TOKEN"
```

Command shape:

```
vibe run web <run_id> --node <node_id> --relay <url> --token-file <path> \
  [--port <port>] [--host 127.0.0.1] [--allow-public-bind] [--json]
```

The page header shows `run_id`, `node_id`, `status`, the event `source`, a colour-coded
connection chip (`live` / `reconnecting` / `disconnected` / `ended`), and an "updated Ns ago"
indicator. The browser poller retries with capped backoff on a transient hiccup and never dies on
the first failure; if the relay stream gives up it shows `disconnected` and notes *the run may
still be active on the node*.

> **Fully offline check (no production relay, no paid agent):** point the same commands at an
> in-process `startRelayServer` + a local `vibe node daemon --local --relay ws://…` (mock-capable).

---

## Managing active viewers — `vibe run viewers`

Viewers bind ephemeral ports, so each `vibe run web …` records itself in a small local registry
(`~/.vibe/viewers.json`, `0600`) — no daemon required.

```
vibe run viewers list                 # active viewers: run_id, viewer_id, mode, url, pid, auth, age
vibe run viewers open <run_id|vw_id>  # print the viewer's URL again
vibe run viewers stop <run_id|vw_id>  # stop the LOCAL viewer process — NOT the remote run
```

- **`stop` stops the viewer, not the run.** `vibe run viewers stop` signals only the local viewer
  HTTP process (by its recorded pid). The run keeps going — use `vibe run stop` to stop the run.
- **No secrets stored.** The registry holds only the **base URL** (`http://host:port`), pid, and
  ids — never the relay token and never the viewer access token. `open` on a loopback viewer prints
  the full working URL; on a token-gated (public-bind) viewer it prints the base URL and notes that
  the one-time access token was shown only when the viewer started.
- **Self-pruning.** Liveness is the recorded pid (`process.kill(pid, 0)`), so a crashed viewer's
  record is dropped on the next `list` / `open` / `stop`.

---

## Public-bind access token

Loopback (`127.0.0.1`) is frictionless and needs no auth. When you bind a non-loopback host with
`--allow-public-bind`, the viewer generates a **one-time local access token**:

```bash
vibe run web run_… --node "$NODE" --relay "$RELAY" --token-file "$TOKEN" \
  --host 0.0.0.0 --allow-public-bind --json
# → url: "http://0.0.0.0:<port>/?access=<token>",  auth: "token"
```

- Requests without the token get `401`. The first authorized request sets an `HttpOnly`,
  `SameSite=Strict` cookie, so the browser's polls don't carry the token thereafter.
- This token is **local-only** — it gates this one HTTP process, dies with it, and **never touches
  the relay** (it is *not* the relay token). It is **not** a shareable capability link.

---

## Troubleshooting

Errors are structured JSON (`{ "error": true, "code": "…", "message": "…" }`):

| Code | Meaning | Fix |
| --- | --- | --- |
| `relay_required` | `--node` given without `--relay`. | Add `--relay <url>`. |
| `auth_token_error` | No / unreadable relay token. | Provide `--token-file <0600 path>` or `VIBE_RELAY_TOKEN` (never `--token <value>`). |
| `node_offline` | The owning node isn't online on the relay (or not registered). | Start the node daemon; confirm it appears in `node list --remote`. |
| `run_not_found` | The relay has no such run for that node. | Check the `run_id`; ensure the run was started on that node over the relay. |
| `public_bind_refused` | Non-loopback `--host` without `--allow-public-bind`. | Add `--allow-public-bind` (and use the printed `?access=` URL), or keep the default `127.0.0.1`. |
| `viewer_not_found` | `run viewers open/stop` target has no active viewer. | Run `vibe run viewers list`; the viewer may have exited (records self-prune on dead pid). |

For a public-bind viewer, a `401` in the browser means the URL is missing its `?access=<token>`
query — reopen the full URL printed when the viewer started.

---

## Not implemented yet

- **Public share links** — a relay-hosted, externally reachable viewer URL. Not built.
- **End-to-end (E2E) capability links** — e.g. `/share/<id>#k=<key>` with TTL/revoke. Not built.
- **Interactive terminal input** — the viewer is and remains strictly read-only.
