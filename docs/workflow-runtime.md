# Workflow Runtime (v1)

A minimal, **deterministic**, **durable** planner/executor Workflow Runtime that
executes a validated [`WorkflowSpec`](../src/workflow/contract.ts) over the durable
[ControlStore](./durable-control-store.md) and the durable
[Agent Gateway](./agent-task-api.md). It runs the canonical loop:

> **Codex planner → Claude Code executor → Codex review → (loop back to executor | complete | blocked | failed)**

It survives Workflow-Runtime **or** Gateway process restarts **without creating a
second Agent Task, step execution, edge, terminal event, or counter increment**.

This is an **internal runtime/service only**. There is deliberately **no**
natural-language workflow generation, workflow REST endpoint, workflow MCP tool,
UI/map, A2A, arbitrary shell/HTTP step, approval flow, artifact transfer, or
multi-host scheduler in this version.

## Architecture & module boundary

All workflow orchestration lives in `src/workflow/` and depends only on two
abstractions — `ControlStore` and `AgentTaskClient`. It contains **no SQL** (every
durable mutation goes through a narrow atomic store composite) and never reaches
into `agent-gateway.ts`, `relay/client.ts`, the Node daemon, or the MCP server.

| Module | Responsibility |
| --- | --- |
| `runtime.ts` | The state machine + one authoritative in-process pump per workflow |
| `recovery.ts` | Stable `step_execution_id` minting + durable phase classification |
| `task-client.ts` | The `AgentTaskClient` interface + `GatewayAgentTaskClient` adapter |
| `input-values.ts` | Validate/normalize workflow input values against the spec |
| `prompt-renderer.ts` | Deterministic `{{ … }}` rendering (no evaluation) |
| `output-parser.ts` | Bounded stdout extraction + strict single-JSON parsing |
| `output-validator.ts` | Validate parsed output against the step's `OutputSchema` |
| `routing.ts` | Deterministic single-edge selection |
| `errors.ts` | Stable, sanitized error/block reason codes |

The production `AgentTaskClient` is `GatewayAgentTaskClient` over the existing
Gateway HTTP client. Focused tests inject a deterministic fake implementing the
same interface.

## Deterministic runtime vs. a future LLM compiler

This runtime executes an **already-validated** spec. It performs no
natural-language compilation — a spec is authored (or, later, compiled + explicitly
approved) and passed to `createWorkflow`. The runtime's own behavior is fully
deterministic: the same durable state always produces the same next action, which
is what makes idempotent crash recovery possible.

## State machine

```
workflow:  ready → running → completed | failed | blocked | cancelled
step:      pending/running → completed | failed | cancelled
```

`completed`, `failed`, and `cancelled` are terminal. **`blocked` is non-terminal**
but is NOT auto-resumed — user-driven resume is deferred to a later extension.

## `context_binding`

The spec's `context_binding` (optional, on an `agent_task` step) declares which
bounded context slot a step's **validated** output replaces on success:
`latest_planner_decision` (planner/review steps) or `latest_executor_handoff`
(executor steps). The bound `output_schema` must be structurally compatible with
the destination shape (its fields ⊆ the slot's fields, with required `status` +
`summary`). An **omitted** binding persists the step output (still referenceable via
`steps.<id>.output.*`) but updates neither slot. Binding is never inferred from role
names, step ids, or schema names — unknown values fail validation.

## Prompt rendering

Deterministic substitution of the four validated namespaces — `inputs.<name>`,
`steps.<step_id>.output.<field>`, `workflow.round`,
`context.(latest_planner_decision|latest_executor_handoff).<field>`. There is no
JavaScript evaluation, no function calls, and no arbitrary paths. Strings render as
text; numbers/booleans via `String`; arrays as canonical JSON. A missing required
runtime value is a structured workflow failure; the rendered prompt is size-bounded
before task creation and is never logged. `workspace_key_template` is a safe literal
key or exactly one `{{ inputs.<name> }}` reference (an omitted optional value means
no explicit workspace key).

## Structured JSON output requirement

Planner/executor outputs control routing and are parsed **strictly**: trim, then
accept **exactly one** JSON object — either bare or in a single ```json fence with
no other prose — validated against the step's declared `OutputSchema` (required
fields, types, enums, no unknown fields, bounded sizes). There is **no** heuristic
JSON-scraping, LLM repair, or coercion. Invalid output fails the step (incrementing
`total_failures` once) and the workflow with a **sanitized** stable error that never
persists the raw malformed output. Task status is taken from the authoritative
Gateway projection — never from agent claims.

## `step_execution_id` → Gateway `idempotency_key`

For each step execution the runtime mints a stable `step_execution_id`
(`<workflow_id>.<step_id>.r<round>.a<attempt>`), persists the execution record
**before** task creation, and calls Gateway task creation with
`idempotency_key = step_execution_id`. If the runtime crashes before binding
`task_id`, recovery retries with the **same** `step_execution_id`, the Gateway
returns the **same** task, and **no second backend run starts**. The `task_id` is
then bound atomically with `step.task_created`. A second execution record is never
created for the same `(workflow_id, step_id, round, attempt)`.

## Durable crash recovery

`recoverWorkflows()` loads `running` workflows and resumes each on the single
per-workflow pump. Because every durable step is idempotent, recovery simply
re-runs the pump, which converges from any of these boundaries:

| Durable boundary | Recovery action |
| --- | --- |
| No current step execution | Create it once (`ensureStepStarted`) |
| Execution exists, `task_id` null | Re-submit with the same key → same task; bind |
| `task_id` bound, task running | Resume bounded waiting |
| Task completed, output not persisted | Reload complete history, parse, checkpoint |
| Output persisted, edge not checkpointed | Re-evaluate + checkpoint the edge once |
| Loop round advanced before destination created | Destination round derives from the source step's **immutable** round → idempotent |
| Workflow terminal | Do nothing |

Recovery never resets `current_round`, counters, or `started_at`, and never creates
another attempt merely because the process restarted (recovery reuses the same
`attempt`/`step_execution_id`; it is **not** a retry).

## First-class result consumption

The runtime routes on the durable [AgentTaskResult](./agent-task-result.md), NOT on
event history. For a completed Agent Task: `result_status=available` → parse
`final_output.text` with the strict JSON parser → validate against the step schema
→ route; `result_status=missing` → transition to **blocked** with reason
`task_result_missing` (never guess from events); `result_status=invalid` → fail with
`task_result_invalid`. Event history remains available for UI/replay/audit/evidence,
and history completeness is recorded as diagnostic evidence — never used as a hidden
fallback for control output.

## Loop & limit enforcement

- **`max_rounds`** — round starts at 1 and includes the first iteration; a loop edge
  is taken only while `current_round < max_rounds`, incrementing the round before the
  destination starts.
- **`max_tasks`** — checked before creating a genuinely new task; idempotent recovery
  of an existing task does not increment the counter.
- **`max_runtime_seconds`** — measured from persisted `started_at` (does **not** reset
  on restart), checked before each new step/task and during waits. On expiry the
  workflow is failed with `workflow_limit_exceeded`; a still-running Agent Task is
  **not** auto-cancelled (only an explicit `cancelWorkflow` cancels it).
- **`max_failures`** — a failed step attempt increments `total_failures` exactly once
  (never double-counted after restart) and fails the workflow.
- **`max_step_attempts`** — attempt is always 1 in v1.

## No automatic retries in v1

`max_step_attempts` is enforced as an upper bound, but v1 performs **no** automatic
step retries and therefore normally uses attempt 1 only. Recovery reuses the same
attempt and `step_execution_id` — it is recovery, not a retry.

## Cancellation

`cancelWorkflow` is idempotent: it records cancellation intent **durably** (before
any remote cancellation, so a restart resumes the cancellation), cancels the exact
current `task_id` through the `AgentTaskClient` (never guessing an id), and marks the
workflow `cancelled` exactly once. An **already-terminal task wins** — cancelling a
task that already completed is a no-op and the task keeps its `completed` status. If
the Gateway/node is briefly unreachable, the durable intent persists and the
cancellation retries with bounded backoff; no subsequent step starts. Cancellation
never deletes history.

## Single-runtime-process limitation

Workflow Runtime v1 supports **one active runtime process per ControlStore
database**. Duplicate start/recover calls coalesce onto one in-process pump per
workflow; optimistic workflow revisions, task idempotency, and step-execution
uniqueness protect crash recovery. This PR does **not** implement a distributed
lock service or active/active scheduling across multiple hosts.

## Durable input values

Validated workflow input values are persisted immutably (`workflows.input_values_json`,
ControlStore schema v5) so they survive restart. They are validated against
`WorkflowSpec.inputs` before creation (required/defaults/types/unknown-name checks)
and must not contain credential/token/key field names.

## Current absence of REST / MCP / UI / compiler

There is no workflow REST endpoint, MCP tool, UI/map, or natural-language compiler
in this version. The runtime is an internal service consumed in-process. Workflow
events are persisted (and sequenced contiguously) for a future API/UI, but no
external workflow event streaming is provided here.

## Example lifecycle

The built-in [`plannerExecutorLoopExample`](../src/workflow/examples.ts) is a valid
Codex-planner → Claude-Code-executor → Codex-review loop: `plan` (binds
`latest_planner_decision`) → `implement` (binds `latest_executor_handoff`) →
`review` (binds `latest_planner_decision`), looping `review → implement` while the
reviewer returns `continue`, up to `max_rounds`, and routing to `$complete` /
`$blocked` / `$failed` on the reviewer's terminal decision.
