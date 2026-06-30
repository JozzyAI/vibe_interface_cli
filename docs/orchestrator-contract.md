# Orchestrator Contract

The canonical surface an external orchestrator (e.g. Symphony) calls to dispatch
and observe work on a Vibe node. Vibe is a **worker-node runtime**: the
orchestrator dispatches to Vibe over the relay; Vibe never polls the
orchestrator.

This document is the single source of truth for the CLI contract, success
outputs, the JSONL event schema, the structured error envelope, and exit codes.
Other docs point here rather than restating it.

---

## 1. Canonical command path

```bash
# One-time onboarding for the machine (writes ~/.config/vibe/profile.json).
vibe connect --relay wss://relay.example --token-file ~/.config/vibe/relay-token --yes

# Bring this machine online as a node (reads the profile).
vibe node daemon

# Dispatch and observe a run on a specific node.
vibe run start  --node <node_id> --agent mock --repo-url <git-url> --branch <branch> --prompt-file <path>
vibe run status <run_id>
vibe run stream <run_id>
vibe run stop   <run_id>
```

> The prompt is passed as a file: `--prompt-file <path>`. The controller reads
> the file locally and sends its text in the relay message, so the node never
> needs access to the controller's filesystem.

---

## 2. Profile / default behavior

After `vibe connect`, the remote run commands fill missing settings from the
profile, so an orchestrator does not repeat connection flags:

- `vibe run start`, `vibe run status`, `vibe run stream`, and `vibe run stop`
  read `relay_url`, `token_file`, and `vibe_dir` from the profile when not given
  on the CLI or environment.
- **`vibe run web` is intentionally excluded** from relay/token profile
  defaults — the personal web viewer still takes `--relay`/`--token-file`
  explicitly.

**Precedence (highest first): CLI flag > env var > profile > default.** Explicit
flags and environment variables always override the profile.

The profile stores only the **token-file path** (`token_file`) — never the token
value. See [Token secrecy](#6-token-secrecy).

---

## 3. Success outputs

| command | stdout | exit |
|---|---|---|
| `vibe run start` | one `RunRecord` JSON object | `0` |
| `vibe run status` | one `RunRecord` JSON object | `0` |
| `vibe run stream` | `RunEvent` JSONL (one event per line) until a terminal status | `0` |
| `vibe run stop` | the updated `RunRecord` JSON object | `0` |

`RunRecord` (key fields; defined in `src/types.ts`):

```json
{
  "run_id": "run_m0abc1_f3a9b2",
  "session_id": "mock_run_m0abc1_f3a9b2",
  "node_id": "my-node",
  "node_selector": "my-node",
  "agent": "mock",
  "status": "running",
  "workspace_path": "/home/user/.vibe/workspaces/demo",
  "repo_url": "https://github.com/org/repo",
  "branch": "main",
  "created_at": "2026-06-30T10:00:00.000Z",
  "updated_at": "2026-06-30T10:00:01.000Z"
}
```

`status` is one of: `queued`, `running`, `completed`, `failed`, `stopped`,
`cancelled`, `blocked`.

---

## 4. Remote error contract

A remote failure of `run start`, `run status`, `run stream`, or `run stop`
prints a **structured JSON error envelope to stdout** and a **short one-line
human message to stderr** (`error: <code>: <message>`), then exits with the
mapped code.

Envelope (stdout):

```json
{
  "error": true,
  "code": "node_offline",
  "message": "node_offline: Owning node is offline: my-node",
  "run_id": "run_m0abc1_f3a9b2",
  "ts": "2026-06-30T10:00:02.000Z"
}
```

`run_id` is present for `status`/`stream`/`stop`; it is omitted for `start`
(no run exists yet). The **`code` is the stable contract to branch on**; the
human `message` is best-effort and may change.

Stable codes:

| code | meaning |
|---|---|
| `relay_unavailable` | relay unreachable: refused / DNS / timeout / closed before a reply |
| `node_offline` | owning node unknown to the relay or not connected |
| `unauthorized` | relay rejected the token (HTTP 401/403, pairing required) |
| `run_not_found` | the run id is unknown to the owning node / relay |
| `agent_not_supported` | the node does not offer the requested agent |
| `already_terminal` | stop requested on a run already in a terminal state |
| `remote_error` | a relay/node error with a code not mapped specifically |
| `unknown_error` | unclassifiable (non-coded message / non-Error throw) |

Exit codes (intentionally small — the structured `code`, not the exit code, is
the branching contract):

| exit | meaning |
|---|---|
| `0` | success |
| `3` | `run_not_found` |
| `1` | all other failures |

Remote `run_not_found` exits `3` to match the local missing-run behavior
(`vibe run status`/`stop`/`stream` against a run that does not exist locally).

---

## 5. RunEvent JSONL schema

`vibe run stream` emits one JSON object per line. Every event carries
`run_id`, an optional `session_id`, and `ts`. The `type` field selects the
shape (defined in `src/types.ts`):

| `type` | additional fields | when |
|---|---|---|
| `status` | `status` | a run-status transition (see terminal note below) |
| `log` | `stream` (`stdout`/`stderr`), `message` | a log line from the agent |
| `tool_call` | `tool`, `input?` | the agent invoked a tool |
| `approval_required` | `approval_id`, `message` | the agent needs a decision |
| `approval_response` | `approval_id`, `decision` (`approve`/`deny`), `message?` | a decision was recorded |
| `pr_created` | `url` | a pull request was opened |
| `error` | `message`, `code?` | a diagnostic / failure event |

**Terminal completion, failure, and stop are represented as a `status` event**
whose `status` is one of `completed`, `failed`, `stopped`, or `cancelled` — the
stream ends after the first such event. There are **no** `completed` / `failed`
/ `stopped` event *types*, and there is **no** `.data.*` envelope; fields live at
the top level of each event object.

Example tail of a stream:

```json
{"run_id":"run_…","type":"log","stream":"stdout","message":"Cloning repository...","ts":"…"}
{"run_id":"run_…","type":"approval_required","approval_id":"apr_…","message":"Proceed?","ts":"…"}
{"run_id":"run_…","type":"status","status":"completed","ts":"…"}
```

If a remote stream cannot be re-established after reconnect attempts are
exhausted, it emits a structured terminal so the caller never hangs silently:
an `error` event with `code:"stream_disconnected"` followed by a
`status` event with `status:"failed"`.

---

## 6. Token secrecy

- The token **value** must never appear in stdout, stderr, logs, or the profile.
- The profile stores only the **token-file path** (`token_file`); the value is
  read at call time from that file (or `VIBE_RELAY_TOKEN`).
- The relay token is supplied via `--token-file <path>` or the
  `VIBE_RELAY_TOKEN` environment variable. (`--token <value>` exists but is
  deprecated because it is visible in process args; a one-line stderr warning is
  emitted when it is used — the value is never printed.)
- A remote `RunRecord` returned over the relay is redacted by the node before
  persistence, so secrets never round-trip into the record an orchestrator sees.

---

## 7. VIBE_DIR consistency

- The `vibe run` namespace resolves `VIBE_DIR` uniformly (env `VIBE_DIR` >
  `profile.vibe_dir` > default `~/.vibe`), so `run start` writes run records and
  `run status`/`stream`/`stop` read them from the same directory.
- When **no relay** is configured (no `--relay`, no env, no profile relay),
  `vibe run status` and `vibe run stream` stay on the **local** path: they read
  the local run record and exit `3` if it is not found. The remote path is taken
  only when a relay is resolved.

---

## 8. Readiness preflight (`vibe run doctor`)

A **read-only** check an orchestrator can run *before* dispatching, to confirm
the remote path is usable. It starts nothing and stops nothing.

```bash
vibe run doctor --node <node_id> --agent mock
```

- `--node <node_id>` is **required**.
- `--agent <agent>` is **optional**; when given, the node's agent advertisement
  is checked and an `agent` entry is added to `checks`. When omitted, only
  `relay` / `auth` / `node` are checked.
- `--relay` / `--token-file` (and `--token`) follow the same profile/default
  resolution and precedence as the other remote run commands, so after
  `vibe connect` they can be dropped.

Output is a **readiness envelope** (distinct from the [error envelope](#4-remote-error-contract)
above) — it reports a list of checks, not a single fatal error:

```json
{
  "ok": false,
  "checks": [
    { "name": "relay", "ok": true },
    { "name": "auth", "ok": true },
    { "name": "node", "ok": false, "detail": "node my-node is offline" }
  ],
  "code": "node_offline",
  "ts": "2026-06-30T10:00:00.000Z"
}
```

- `ok` — overall readiness.
- `checks[]` — ordered `relay` -> `auth` -> `node` -> (`agent` when requested);
  each `{ name, ok, detail? }`.
- `code` — present only when `ok:false`; it **reuses the stable code vocabulary**
  from the [error contract](#4-remote-error-contract): `relay_unavailable`,
  `unauthorized`, `node_offline`, `agent_not_supported`. It is the code of the
  first failing check.

Exit codes (binary):

| exit | meaning |
|---|---|
| `0` | ready (`ok:true`) |
| `1` | not ready (`ok:false`) |

The token value never appears in the output; only the token-file **path** is
read (see [Token secrecy](#6-token-secrecy)).

---

## See also

- `README.md` — installation, backends, the relay demos, and safety notes.
- `docs/symphony-integration.md` — Symphony-specific integration notes.
- `docs/private-remote-viewer.md` — the personal remote web viewer (separate
  from this dispatch contract).
