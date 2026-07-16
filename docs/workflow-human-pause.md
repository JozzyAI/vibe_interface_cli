# Workflow human pauses (durable input / approval)

The Workflow Runtime can pause a workflow for a **human response** before a step's
Agent Task runs — a durable **input** capture or an **approval** gate. This is an
INTERNAL runtime capability (ControlStore + runtime methods) — there are **no REST or
MCP endpoints** for it yet.

## Declaring a pause

Any `agent_task` step may declare an optional `pause_before` gate:

```json
{ "id": "deploy", "type": "agent_task", "agent_role": "ops",
  "prompt_template": "…", "output_schema": "…",
  "pause_before": { "kind": "approval", "prompt": "Approve deploy to prod?", "choices": ["yes", "no"] } }
```

- `kind`: `input` (capture a bounded value) or `approval` (gate execution).
- `prompt`: bounded human-facing text (≤ 2000 chars).
- `choices`: optional bounded list of allowed answers / options.

## State model

```
running ──pause_before(input)────▶ waiting_input ──answer + resume──▶ running ──▶ (task runs)
running ──pause_before(approval)─▶ waiting_approval ──approve + resume──▶ running ──▶ (task runs)
                                   waiting_approval ──reject──▶ failed          (documented policy)
```

- `waiting_input` and `waiting_approval` are **non-terminal, resumable** states (like
  `blocked`). Only `completed` / `failed` / `cancelled` are terminal.
- **No Agent Task runs while waiting.** The pause is evaluated BEFORE the task is created.
- **Approval-rejection policy:** an explicit rejection **fails** the workflow
  (`workflow.failed`, reason `approval_rejected`) and releases its workspace leases.

## Durable requests (ControlStore schema v9)

A pause creates a durable `workflow_human_requests` row (at most one active per step
execution; deterministic `request_id` = `hr_` + sha256(step_execution_id)): `kind`,
`prompt`, `choices`, `status` (`pending` → `answered` / `approved` / `rejected`),
`response_value`, timestamps. Bounded; carries no secrets. It survives a runtime
restart — the pending request is exactly recoverable.

## Consuming an input response (`pause.response`)

An input-paused step's prompt may reference the answered value with the fixed
namespace **`pause.response`** — the current step's own answered input pause:

```json
{ "id": "gate", "type": "agent_task", "agent_role": "solo",
  "prompt_template": "Proceed with the value the operator gave: {{ pause.response }}",
  "output_schema": "o",
  "pause_before": { "kind": "input", "prompt": "Enter the value" } }
```

- Valid **only** on a step whose `pause_before.kind = "input"` — using it elsewhere fails
  spec validation (`template_pause_without_input_gate`). No other human-context paths
  exist (no arbitrary `human.*`).
- The response is **bounded**, **durably persisted**, and rendered **deterministically**
  (plain substitution — never evaluated). The same request + step execution are reused
  on resume, so the value is byte-for-byte stable across a restart.
- A prompt referencing `pause.response` **cannot start before a response exists**: the
  pause gate holds the task until answered, and the renderer treats a missing response
  as a required miss (render fails → no task) as a second line of defense.
- **Approval** pauses inject nothing — they are execution gates only.

## Runtime methods

- `getPendingRequest(workflowId)` — the request currently awaiting a human (or null).
- `answerInput(requestId, value)` — record an input answer. **Idempotent** (same value);
  a **different** value **fails closed** (`conflicting input response`).
- `decideApproval(requestId, approved)` — record an approval. **Idempotent**; a
  conflicting later decision **fails closed**. A rejection is definitive (fails the
  workflow + releases leases).
- `resumeWorkflow(workflowId)` — once the request is answered/approved, transition
  `waiting_*` → running and re-drive the pump from the **same checkpoint**: the SAME
  step resumes — **no duplicate step or Agent Task** (the step-execution id and the
  Gateway idempotency key are stable). Idempotent; a still-pending request or a terminal
  workflow is a safe no-op.

## Guarantees

- The response record and every transition are **atomic** with the workflow status
  change; a conflicting second response fails closed.
- **Workspace leases stay active** while a workflow waits; a cancellation while waiting
  releases them through the existing lease lifecycle.
- **Limits and `started_at` do not reset** across a pause/resume — the runtime clock and
  counters continue from where they were.
