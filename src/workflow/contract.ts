/**
 * Declarative Vibe Workflow contract (v1) — TYPES ONLY.
 *
 * This is the stable, JSON-first specification for a multi-agent workflow (e.g. a
 * Codex planner → Claude Code executor → Codex review loop). It is PURE data: a
 * `WorkflowSpec` is JSON-serializable and contains NO functions, classes, RegExp,
 * or executable expressions. There is deliberately NO runtime here — no executor,
 * no persistence, no HTTP/MCP surface, no LLM compiler. Those consume this
 * contract later; the contract stays independent of all of them.
 *
 * The only executable code in this module is a handful of PURE, total helpers
 * over the enums (terminal-state predicates, terminal-target mapping) — no I/O,
 * no agent calls, no workflow evaluation.
 */

/** Bumped when the wire shape changes incompatibly. */
export const WORKFLOW_CONTRACT_VERSION = '1'
export const WORKFLOW_EVENT_CONTRACT_VERSION = 1

// ── identifiers ─────────────────────────────────────────────────────────────
//
// Safe identifiers are opaque DATA — never shell commands or CLI arguments.

/** Workflow/role/step/input/schema identifier: lowercase, dot-free, bounded. */
export const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** A `node_id` is opaque routing data (not a command); permissive but bounded. */
export const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

// ── inputs ──────────────────────────────────────────────────────────────────

export type WorkflowInputType = 'string' | 'number' | 'boolean' | 'string[]'

export interface WorkflowInputDef {
  type: WorkflowInputType
  required?: boolean
  description?: string
  /** Literal default, shape-matched to `type`. Never a template or expression. */
  default?: string | number | boolean | string[]
}

export type WorkflowInputs = Record<string, WorkflowInputDef>

// ── agent roles ─────────────────────────────────────────────────────────────
//
// Roles are named separately from step ids so several steps can share a role.
// `agent`/`node_id` are DATA; there is intentionally no command/args/env field.

export interface WorkflowAgentRole {
  agent: string
  /** Optional. When omitted, routing is ambiguous and the RUNTIME must reject it
   *  at execution time — the contract preserves, not resolves, the ambiguity. */
  node_id?: string
  description?: string
}

export type WorkflowAgentRoles = Record<string, WorkflowAgentRole>

// ── structured output schemas ───────────────────────────────────────────────
//
// A workflow ROUTES on agent output, so outputs must be structured. Schemas are a
// small, strongly-typed, JSON-serializable subset — NOT arbitrary executable
// validators and NOT full JSON Schema.

export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'enum'

export interface SchemaField {
  type: SchemaFieldType
  required?: boolean
  /** Allowed values when `type` is `'enum'` (a bounded set of string literals). */
  enum?: string[]
  description?: string
}

export interface OutputSchema {
  fields: Record<string, SchemaField>
}

export type OutputSchemas = Record<string, OutputSchema>

/** Bounds on enum declarations so a generated schema stays small. */
export const MAX_ENUM_VALUES = 64
export const MAX_ENUM_VALUE_LENGTH = 128

// ── steps ───────────────────────────────────────────────────────────────────
//
// v1 supports ONLY `agent_task`. No command/shell/HTTP/JavaScript/deploy/plugin
// steps — additional kinds require separate review in a later PR.

export type StepType = 'agent_task'

export interface AgentTaskStep {
  id: string
  type: 'agent_task'
  /** References a key in `agents`. */
  agent_role: string
  /** Prompt with `{{ … }}` references (see the template grammar). */
  prompt_template: string
  /** References a key in `output_schemas`. */
  output_schema: string
  permission_mode?: 'default' | 'unsafe-skip'
  /** A safe opaque workspace key, OR a single `{{ inputs.<name> }}` reference. */
  workspace_key_template?: string
  label?: string
  description?: string
}

export type WorkflowStep = AgentTaskStep

// ── conditions (restricted, declarative — NOT string expressions) ────────────

export type ConditionOp = 'eq' | 'neq' | 'exists' | 'in'
export const CONDITION_OPS: readonly ConditionOp[] = ['eq', 'neq', 'exists', 'in']

/** Scalars usable as condition operands. */
export type ConditionScalar = string | number | boolean

export interface Condition {
  /** `output.<field>` (the SOURCE step's validated output) or `workflow.round`. */
  path: string
  op: ConditionOp
  /** Required for eq/neq (scalar) and in (array); omitted/ignored for exists. */
  value?: ConditionScalar | ConditionScalar[]
}

// ── edges ───────────────────────────────────────────────────────────────────

export type EdgeKind = 'normal' | 'loop'

/** Reserved terminal targets — NOT steps. */
export type TerminalTarget = '$complete' | '$failed' | '$blocked'
export const TERMINAL_TARGETS: readonly TerminalTarget[] = ['$complete', '$failed', '$blocked']

export interface WorkflowEdge {
  from: string
  to: string | TerminalTarget
  condition?: Condition
  /** `loop` marks an intentional back-edge: taking it increments the round
   *  counter, and a spec containing any loop edge must define `max_rounds`. */
  kind: EdgeKind
}

// ── limits ──────────────────────────────────────────────────────────────────

/** Reserved extension point for future token/cost budgets. Unused (must be
 *  empty) in v1 — present so budgets can be added under `limits` without a
 *  breaking unknown-field change. */
export interface WorkflowBudget { /* reserved for future budget fields */ }

export interface WorkflowLimits {
  /** Required iff the spec contains any `loop` edge; a positive bounded integer. */
  max_rounds?: number
  max_tasks: number
  max_runtime_seconds: number
  max_step_attempts: number
  max_failures: number
  budget?: WorkflowBudget
}

/** Conservative maxima so an LLM-generated spec cannot request absurd/unbounded
 *  values. All limits must be positive integers at or below these. */
export const LIMIT_MAXIMA = {
  max_rounds: 100,
  max_tasks: 1000,
  max_runtime_seconds: 86_400,
  max_step_attempts: 20,
  max_failures: 100,
} as const

// ── the spec ────────────────────────────────────────────────────────────────

export interface WorkflowSpec {
  version: '1'
  name: string
  description?: string
  entry_step: string
  inputs?: WorkflowInputs
  agents: WorkflowAgentRoles
  output_schemas: OutputSchemas
  limits: WorkflowLimits
  steps: WorkflowStep[]
  edges: WorkflowEdge[]
}

/** Fail-closed allow-list of top-level fields (no forward-compat extras in v1). */
export const KNOWN_SPEC_FIELDS: readonly string[] = [
  'version', 'name', 'description', 'entry_step', 'inputs',
  'agents', 'output_schemas', 'limits', 'steps', 'edges',
]

// ── future runtime state (types only — no runtime implemented here) ──────────

export type WorkflowStatus = 'draft' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'

// `blocked` is RESUMABLE (awaiting external input/decision) and therefore NOT
// terminal; only `completed` / `failed` / `cancelled` are terminal. Resume
// semantics belong to the future runtime PR.
const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>(['completed', 'failed', 'cancelled'])
const TERMINAL_STEP_STATUSES = new Set<StepStatus>(['completed', 'failed', 'skipped', 'cancelled'])

export function isTerminalWorkflowStatus(s: WorkflowStatus): boolean { return TERMINAL_WORKFLOW_STATUSES.has(s) }
export function isTerminalStepStatus(s: StepStatus): boolean { return TERMINAL_STEP_STATUSES.has(s) }

// ── round accounting (contract semantics; no runtime enforcement here) ───────
//
// `workflow.round` starts at 1 and `max_rounds` INCLUDES the first iteration, so
// `max_rounds: 6` permits at most six rounds (not seven). A loop edge may be
// taken only while `round < max_rounds`; taking it increments the round BEFORE
// the destination step starts. `max_step_attempts` is counted per (step_id,
// round); `max_tasks` counts every created Agent Task (including any future
// retry/repair tasks); `max_failures` counts failed step attempts across the
// whole workflow; `max_runtime_seconds` is elapsed wall-clock runtime and does
// NOT reset on resume.

export const WORKFLOW_ROUND_START = 1

/** Pure predicate: may a loop edge be taken at `currentRound` under `maxRounds`? */
export function canTakeLoopEdge(currentRound: number, maxRounds: number): boolean {
  return Number.isInteger(currentRound) && Number.isInteger(maxRounds) && currentRound < maxRounds
}

// ── stable step-execution identity (types only — no id generation here) ──────
//
// A looping/retrying workflow cannot identify an execution by `step_id` alone.
// A `WorkflowStepExecutionRef` pins the exact (step, round, attempt). The future
// runtime mints `step_execution_id` (a stable opaque id preserved across process
// restart); a RETRY gets a NEW `step_execution_id` and a higher `attempt`.
// `task_id` is safe and remains absent until Agent Task creation succeeds.

export interface WorkflowStepExecutionRef {
  step_execution_id: string
  step_id: string
  /** Positive integer; the workflow round in which this execution ran. */
  round: number
  /** Positive integer; 1 for the first try, incremented per retry. */
  attempt: number
  task_id?: string
}

/** Map a reserved terminal edge target to the workflow status it produces. */
export function terminalTargetToStatus(t: TerminalTarget): WorkflowStatus {
  switch (t) {
    case '$complete': return 'completed'
    case '$failed': return 'failed'
    case '$blocked': return 'blocked'
  }
}

export function isTerminalTarget(to: string): to is TerminalTarget {
  return (TERMINAL_TARGETS as readonly string[]).includes(to)
}

// ── workflow event envelope (types only — no store/emitter here) ─────────────

export type WorkflowEventType =
  | 'workflow.created'
  | 'workflow.validated'
  | 'workflow.started'
  | 'step.started'
  | 'step.task_created'
  | 'step.completed'
  | 'step.failed'
  | 'edge.selected'
  | 'workflow.round_advanced'
  | 'workflow.blocked'
  | 'workflow.completed'
  | 'workflow.failed'
  | 'workflow.cancelled'

/** Step-scoped event types MUST carry a `step_execution`; workflow-scoped ones
 *  MUST NOT. */
export const STEP_SCOPED_EVENT_TYPES: readonly WorkflowEventType[] = [
  'step.started', 'step.task_created', 'step.completed', 'step.failed',
]

export interface WorkflowEvent<P = Record<string, unknown>> {
  workflow_id: string
  /** Monotonic per workflow. */
  seq: number
  ts: string
  type: WorkflowEventType
  /**
   * The exact (step, round, attempt) this event belongs to. Present on
   * step-scoped events ({@link STEP_SCOPED_EVENT_TYPES}) — carry this rather than
   * a bare, ambiguous `step_id`; absent on workflow-scoped events.
   */
  step_execution?: WorkflowStepExecutionRef
  payload: P
  contract_version: number
}

/** True iff this event type is step-scoped (and so must carry `step_execution`). */
export function isStepScopedEvent(t: WorkflowEventType): boolean {
  return (STEP_SCOPED_EVENT_TYPES as readonly string[]).includes(t)
}

// ── structured handoff shapes (mirrored by the built-in example schemas) ─────

export interface PlannerDecision {
  status: 'continue' | 'complete' | 'blocked' | 'failed'
  summary: string
  next_step?: string
  acceptance_criteria?: string[]
  open_questions?: string[]
}

export interface ExecutorHandoff {
  status: 'implemented' | 'blocked' | 'failed'
  summary: string
  changed_files: string[]
  tests_run: string[]
  remaining_work: string[]
  risks: string[]
}

// Fixed allow-lists backing the `context.*` template namespace. Only these exact
// paths are permitted — `context.latest_planner_decision.<field>` and
// `context.latest_executor_handoff.<field>` — never arbitrary context paths.
// The RUNTIME refreshes `latest_planner_decision` after every successful
// planner/review step and `latest_executor_handoff` after every successful
// executor step, so a loop's next step reads the newest structured handoff.
export const CONTEXT_GROUPS = ['latest_planner_decision', 'latest_executor_handoff'] as const
export type ContextGroup = typeof CONTEXT_GROUPS[number]
export const CONTEXT_PLANNER_FIELDS: readonly string[] = ['status', 'summary', 'next_step', 'acceptance_criteria', 'open_questions']
export const CONTEXT_EXECUTOR_FIELDS: readonly string[] = ['status', 'summary', 'changed_files', 'tests_run', 'remaining_work', 'risks']
export const CONTEXT_FIELDS: Readonly<Record<ContextGroup, readonly string[]>> = {
  latest_planner_decision: CONTEXT_PLANNER_FIELDS,
  latest_executor_handoff: CONTEXT_EXECUTOR_FIELDS,
}

// ── bounded, serializable context bundle for planner↔executor handoffs ───────
//
// The RUNTIME (not the agent) is responsible for `verified_evidence` such as
// authoritative task status and captured test events. This bundle must NEVER
// carry credentials, relay/API/bearer tokens, encryption keys, raw native-agent
// session histories, or backend process ids.

export interface VerifiedEvidence {
  /** e.g. `'task_status'` or `'test_events'`. */
  kind: string
  summary: string
  /** Safe opaque task id where applicable. */
  task_id?: string
}

export interface WorkflowContextBundle {
  objective: string
  current_round: number
  latest_planner_decision?: PlannerDecision
  latest_executor_handoff?: ExecutorHandoff
  decisions?: string[]
  open_questions?: string[]
  verified_evidence?: VerifiedEvidence[]
  prior_task_ids?: string[]
  history_summaries?: string[]
}

// ── natural-language compiler contract (types only — no compiler here) ───────

export interface AvailableAgent {
  agent: string
  node_id?: string
  role_hint?: string
}

export interface WorkflowCompileConstraints {
  max_rounds?: number
  allowed_agents?: string[]
  max_tasks?: number
}

export interface WorkflowCompileRequest {
  natural_language_description: string
  available_agents: AvailableAgent[]
  constraints?: WorkflowCompileConstraints
}

/**
 * A compiler's output. `requires_user_approval` is the literal `true` — generated
 * workflows must ALWAYS be validated and explicitly approved before execution;
 * natural-language generation must never directly execute a workflow. The
 * `workflow_spec` must pass the same {@link WorkflowSpec} validator.
 */
export interface WorkflowCompileResult {
  workflow_spec: WorkflowSpec
  assumptions: string[]
  warnings: string[]
  requires_user_approval: true
}

/** Pure guard: a compile result must require approval before it may be executed. */
export function compileResultRequiresApproval(r: WorkflowCompileResult): boolean {
  return r.requires_user_approval === true
}
