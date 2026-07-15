# Node run event journal

A durable, bounded, **Node-local** journal of remote-run events so a Vibe Node
captures backend output **independently of whether a Gateway is attached**, and a
reconnecting consumer can resume **strictly after** the greatest Node remote-event
sequence it has consumed.

> **Scope.** This PR establishes the Node journal + the replay **protocol
> support** (capability + `after_sequence` cursor contract). It does **not** wire
> the Gateway's restart recovery to consume replay — that is **PR #64**. Not in
> scope: workflow runtime/APIs, natural-language compilation, UI, A2A. Module:
> [`src/node-journal/`](../src/node-journal) — `contract.ts`, `store.ts`,
> `sqlite-journal.ts`, `serialization.ts`, `retention.ts`. Persistence lives here,
> never inside `relay/client.ts`.

## Why a Node journal

The relay does **no** event buffering — a late/reconnecting subscriber currently
misses everything emitted while it was detached, and a Gateway restart loses the
in-flight remote stream. The Node journal makes the Node the durable source of
its own run events, so output is captured whether or not a client is listening
and can be replayed on reconnect.

## Two sequence domains — never interchangeable

| Domain | Owner | Scope | Cursor |
|--------|-------|-------|--------|
| **Node remote-run event sequence** | this journal | `remote_run_id`; starts at 0, strictly monotonic + contiguous; identifies Node/backend source events | `after_sequence` (this PR) |
| **Gateway canonical TaskEvent sequence** | the Gateway / `agent-task-contract` | the existing public task-event cursor; may include non-Node events | `next_event_id` / `Last-Event-ID` |

A Gateway task cursor **must never** be sent to the Node as `after_sequence`, and
a Node sequence is not a task cursor. PR #64 will persist the mapping
(`last_remote_event_sequence`); this PR does not couple them.

## Journal DB path & permissions

A **separate** file from the Gateway `control.sqlite`, derived from the Vibe data
directory: **`<vibe_dir>/node-run-journal.sqlite`** (configurable for tests). It
opens with **WAL**, `foreign_keys=ON`, a bounded `busy_timeout`, **refuses a
symlinked** path, and is **`0600`** where POSIX permits. Migrations are ordered,
transactional, and idempotent; an unknown **newer** schema **fails closed**; there
is no in-memory fallback in normal operation. Tests always inject temporary paths;
no production journal is created during the suite.

**Private local data.** Agent output can contain sensitive repository content, so
the journal file is user-only. It stores only the canonical remote-run event
protocol data — **never** relay/Gateway tokens, encryption keys, env dumps, native
credentials, prompt-file paths, or backend process internals.

## Append-before-publish

For every remote run event the Node capture loop (`tailRunEvents`):

1. assigns the next Node sequence and **durably appends** the event to the
   journal, then
2. only after a successful append, publishes/sends it to the relay.

If the append fails, the event is **not** published (it would not be replayable);
the failure is structured and the capture loop continues consuming backend output.
There is **one authoritative backend-output capture path per run**; a Gateway or
subscriber disconnect never stops capture, and the journal is the durable record.
`NodeRunEvent` is `{ remote_run_id, sequence, type, timestamp, payload }` — event
types are restricted to the existing RunEvent vocabulary, timestamps are ISO-8601
UTC, payloads are size-bounded, and persisted JSON is re-validated on read
(corruption → sanitized structured error).

## Replay cursor & metadata

`after_sequence` semantics: `-1` (`NO_EVENT_CONSUMED`) replays from sequence 0;
otherwise only events with `sequence > after_sequence` are returned. At
establishment the journal exposes `ReplayMetadata`:
`{ earliest_retained_sequence, latest_sequence, history_complete_for_request,
status, terminal, replay_capability }`. If the requested prefix was pruned,
`history_complete_for_request` is `false` and `earliest_retained_sequence` marks
the truncation — the retained suffix still replays; the missing prefix is **never
fabricated** and retained sequences are **never renumbered**.

## Replay → live synchronization (race-free)

`subscribe(remote_run_id, { afterSequence, onEvent, … })` is fully **synchronous**
and `append` is synchronous, so (single-threaded) an event is **either** read by
the replay snapshot **or** fanned out live after subscriber registration — never
both, never neither. Concretely: `subscribe` reads the retained events after the
cursor up to a snapshot cutoff (= current `last_sequence`), registers the
subscriber, then delivers replay; `append` fans out only events with `sequence >
cutoff`. This is an explicit ordering boundary, not timing/polling.

## Subscriber behavior & backpressure

Run execution is never coupled to a single subscriber: a disconnect never cancels
the run, capture continues, and a later subscriber can replay + tail. Each
subscriber has a **bounded** live queue; a slow subscriber that overflows is
dropped with a structured `subscriber_overflow` outcome (via `onOverflow`) — the
**journal is unaffected** and every event stays durable (a fresh subscriber
replays them all). Replay (a bounded pull the consumer requested) is delivered
directly, not through the live backpressure queue. `close()` aborts all
subscribers deterministically.

## Relay protocol (over the wire)

The replay path extends the existing relay stream request/response, additively:

- **`run_stream_subscribe`** gains an optional `after_sequence` (the NODE source
  cursor). Absent ⇒ the existing live-only behavior (backward-compatible).
- **`run_event`** gains an optional `source_sequence` (the NODE journal sequence
  of that event) so a live consumer can record its cursor.
- When a subscribe carries `after_sequence` **and** the owning Node is known, the
  relay forwards **`run_replay_open { run_id, after_sequence, subscriber_ref }`**
  to that Node and routes the Node's replies back to the requesting subscriber by
  `subscriber_ref`. Such a subscriber is **excluded** from the general `run_event`
  fan-out (it receives replay **and** live via `run_replay_event`, so no event is
  delivered twice).
- The Node serves that subscriber from its journal via the race-free coordinator:
  **`run_replay_meta { subscriber_ref, metadata }`** (the `ReplayMetadata`) once,
  then **`run_replay_event { subscriber_ref, source_sequence, event | encrypted }`**
  for replay-then-live, strictly in order. **Encrypted runs are re-encrypted** with
  the run's event key — the relay never sees plaintext (it only routes by
  `subscriber_ref`).
- On subscriber disconnect the relay sends **`run_replay_close`** to the Node,
  which closes the journal subscription; **capture continues** and the run is
  never cancelled. Journal-startup failures are sanitized — a `null` metadata is
  returned, never a DB path, SQL, token, or stack trace.

## Capability negotiation

The Node advertises **`run_event_replay_v1`** in its relay `capabilities` **only
when the journal actually opened**. Backward compatibility: a client that does not
see the capability treats replay as unavailable (live-only); an older client that
never sends `after_sequence` keeps receiving the normal live stream; a Gateway
task cursor is never silently interpreted as a Node cursor. No coordinated
production upgrade is required.

## Retention & truncation

Bounded, explicit, transactional, no scheduler (none runs at migrate/startup):
`pruneTerminalRuns(cutoff)` deletes terminal run journals older than a cutoff
(**active runs are never pruned**); `pruneRunEvents(remote_run_id, keepLast)`
keeps the newest `keepLast` events and advances `earliest_retained_sequence`
(retained sequence numbers never change), so truncation stays visible to replay
clients. Conservative maxima bound event payload bytes, events per run, and
retained terminal runs. New **active-run** events are never silently discarded to
satisfy a history limit — exceeding the per-run event cap is a structured
`events_per_run_exceeded` failure.

## Node restart semantics

This PR guarantees durable **journal data**, not native-agent process recovery:

- completed journal history **survives** a Node process restart and replays after
  reopening the journal;
- **active** Claude/Codex process reattachment after a Node restart is **not**
  provided here — the primary recovery case is **Gateway downtime while the Node
  keeps running**;
- an unknown external process is never fabricated as completed/failed without an
  existing authoritative status.

## Current limitations

- The **Gateway now consumes this replay** (persisting `last_remote_event_sequence`
  and clearing `history_incomplete` after a verified gap-free catch-up) — see
  [`durable-control-store.md`](durable-control-store.md#node-source-event-replay-recovery-gateway--node-run_event_replay_v1).
- No active-run process recovery across a **Node** restart (journal data survives
  and replays; the external Claude/Codex process does not reattach).
