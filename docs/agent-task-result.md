# AgentTaskResult — first-class durable task results

The **AgentTaskResult** is the authoritative *control result* of an Agent Task.
The Workflow Runtime routes on it — it no longer reconstructs control output by
concatenating or searching the complete task event history.

```
Task events        → streaming, UI, replay, audit, debugging
AgentTaskResult    → the stable FINAL result produced by the Agent Task Harness
Workflow step output → AgentTaskResult.final_output after strict workflow-schema validation
```

## Task Events vs. AgentTaskResult

Event history remains available for UI, replay, audit, diagnostics, and future
evidence. But a **complete first-class result means event-history truncation
alone can no longer force the Workflow Runtime to reconstruct control output from
events.** Intermediate events may contain misleading JSON; the result wins.

## Result contract

```ts
interface AgentTaskResultV1 {
  schema_version: '1'
  final_output: { kind: 'text'; text: string }
  process_exit_code?: number | null
  finalized_at: string
  content_hash: string          // sha256 of final_output.text (integrity + idempotency)
  evidence_refs: EvidenceRef[]  // runtime-derived, bounded
  artifact_refs: ArtifactRef[]
}
```

`content_hash` is validated on every read; an unknown newer `schema_version` fails
closed. See `src/lib/agent-task-result.ts`.

## Result status

- **pending** — the backend has not finalized a result yet.
- **available** — a stable, bounded result is durably persisted.
- **missing** — the backend ended but produced no authoritative final result.
- **invalid** — the result envelope itself was malformed / corrupted.

`result_status = available` means **only** that the Agent Task produced a stable
final output. It is **not** proof that code is correct, tests passed, or the
workflow objective is complete.

## Provider adapter responsibility

Each Provider Backend Adapter supplies its authoritative final output through its
**own** completion path — never by scanning the event history. The Agent Task
Harness understands only a generic final result; it never parses workflow schemas
(`planner_decision` / `executor_handoff`).

- **mock** — `VIBE_MOCK_OUTPUT` is the authoritative final output (unset → `missing`).
- **claude-code** — the stream-json terminal `result` message (`finalOutputStrategy:'explicit'`).
- **codex** — `codex exec` stdout **mixes** reasoning/progress with the final
  answer (verified against codex-cli 0.139.0), so it is **not** an authoritative
  result channel. The adapter passes `--output-last-message <file>` and reads that
  dedicated final-message file as the authoritative output
  (`finalOutputStrategy:'last-message-file'`) — never the mixed stdout, never a
  heuristic scrape. An empty final-message file → `missing`. (Raw full-stdout is
  deliberately not a supported strategy.)

If a backend cannot provide an authoritative final result, the result is persisted
`missing` — never guessed.

**Duplicate detection** compares the **complete normalized immutable envelope**
(`schema_version`, `final_output`, `process_exit_code`, `content_hash`,
`evidence_refs`, `artifact_refs`) — not merely `content_hash`. `finalized_at` is
excluded from equality (the first finalization's timestamp is preserved), so
re-finalizing identical content never conflicts on the timestamp; a differing
envelope for the same run/task fails closed.

**Temporary outage vs. old capability.** An **online old Node** that does not
advertise `run_result_v1` yields an authoritative `missing`. A **temporarily
offline/unreachable** capable Node does **not** immediately become `missing` — the
Gateway retries with bounded backoff and does **not** publish the terminal state
until result resolution reaches an authoritative available/missing/invalid outcome.

## Node result persistence + relay protocol

The Node journal (schema **v2**) has an immutable `run_results` table keyed by
`remote_run_id`: identity is immutable, exact duplicates are idempotent, a
conflicting hash is a structured corruption conflict, persisted JSON is
revalidated on read, and an unknown newer schema fails closed. No token, key,
credential, PID, or prompt-file path enters the row.

The node advertises the **`run_result_v1`** capability when durable result storage
is available. The Gateway retrieves the result by exact `remote_run_id` via
`run_result_get` / `run_result_ack` — including after Gateway downtime. For an
**encrypted** run the node returns the result content **encrypted end-to-end**
(the run event key); the relay never sees plaintext result content. Old nodes
without the capability degrade explicitly to `missing`.

## Gateway result persistence + terminalization

ControlStore schema **v6** adds a `task_results` table keyed by the **public
task_id** plus a bounded `tasks.result_status` projection. The result is never
derived from Gateway event history; the API token, relay token, and encryption
keys never enter result rows.

Terminalization ordering (atomic within the Gateway DB where practical):

1. obtain the authoritative Node/local result, or determine it is `missing`;
2. persist result status/result;
3. persist the terminal task transition + the terminal event;
4. commit;
5. publish terminal state/event.

Across Node and Gateway we rely on **durable identity, idempotent retrieval, and
recovery convergence** — *not* an "end-to-end exactly once" claim. Recovery
handles: result persisted on Node but not Gateway, Gateway crash before/after the
result fetch, a terminal status observed before result retrieval, repeated
result fetch, a temporarily offline Node, and an old Node without the capability.
A final output is never lost merely because the authoritative status is already
terminal.

## Public task projection

`GET /v1/tasks/:id` gains a backward-compatible `result_status` and (when
available) `result`. Clients that ignore the fields keep working. The result never
contains unbounded native logs or full event history.

## Workflow Runtime consumption

For a completed Agent Task the runtime routes on the result, never on events:

- **available** → parse `final_output.text` with the strict JSON parser →
  validate against the step output schema → persist step output, update
  `context_binding`, route.
- **missing** → transition to **blocked** with reason `task_result_missing`
  (never guess from events).
- **invalid** → fail the step/workflow with `task_result_invalid`.

History completeness is recorded as diagnostic evidence, never used as a hidden
fallback.

## Success-level separation (precise language)

- process exit success is **not** task-result validation;
- task-result availability is **not** workflow output-schema validity;
- workflow output-schema validity is **not** external verification;
- a reviewer `status=complete` is a **requested outcome**, not proof of correctness.

We say **idempotent persistence**, **create-or-return**, **effectively-once
terminal transition**, and **recovery convergence** — never "end-to-end exactly
once".

## Not yet implemented

No verified-evidence / completion policy, no test verifier. Whether completion is
*verified* is future work. The Workflow API/MCP PR (#67) remains **blocked**
pending this result work and durable workflow workspace leasing.
