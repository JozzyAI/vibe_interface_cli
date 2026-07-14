/**
 * Built-in example WorkflowSpec(s) and output schemas — pure DATA. These both
 * document the contract and back the tests. The example is a valid
 * Codex-planner → Claude-Code-executor → Codex-review loop.
 *
 * `node_id`s here are PLACEHOLDERS (`node_planner` / `node_executor`), never real
 * production node ids. No credentials, tokens, or native-session data appear.
 */
import type { OutputSchema, WorkflowSpec } from './contract.js'

/** planner_decision — the planner/reviewer's structured routing output. */
export const PLANNER_DECISION_SCHEMA: OutputSchema = {
  fields: {
    status: { type: 'enum', required: true, enum: ['continue', 'complete', 'blocked', 'failed'] },
    summary: { type: 'string', required: true },
    next_step: { type: 'string', required: false },
    acceptance_criteria: { type: 'string[]', required: false },
    open_questions: { type: 'string[]', required: false },
  },
}

/** executor_handoff — the implementer's structured handoff. */
export const EXECUTOR_HANDOFF_SCHEMA: OutputSchema = {
  fields: {
    status: { type: 'enum', required: true, enum: ['implemented', 'blocked', 'failed'] },
    summary: { type: 'string', required: true },
    changed_files: { type: 'string[]', required: true },
    tests_run: { type: 'string[]', required: true },
    remaining_work: { type: 'string[]', required: true },
    risks: { type: 'string[]', required: true },
  },
}

/**
 * Codex planner → Claude Code implementation → Codex review, looping back to the
 * executor while the reviewer returns status `continue`, up to `max_rounds`.
 * Each terminal reviewer decision routes to a reserved terminal target. Planner
 * and executor are distinct roles/nodes — there is NO native-session sharing
 * between Codex and Claude Code; handoffs flow only through structured output.
 */
export function plannerExecutorLoopExample(): WorkflowSpec {
  return {
    version: '1',
    name: 'planner-executor-loop',
    description: 'Codex plans, Claude Code implements, Codex reviews the handoff and loops back or terminates.',
    entry_step: 'plan',
    inputs: {
      objective: { type: 'string', required: true, description: 'What the workflow should accomplish.' },
      workspace_key: { type: 'string', required: false, description: 'Opaque workspace key for the executor.' },
    },
    agents: {
      planner: { agent: 'codex', node_id: 'node_planner', description: 'Plans and reviews.' },
      executor: { agent: 'claude-code', node_id: 'node_executor', description: 'Implements.' },
    },
    output_schemas: {
      planner_decision: PLANNER_DECISION_SCHEMA,
      executor_handoff: EXECUTOR_HANDOFF_SCHEMA,
    },
    limits: {
      max_rounds: 6,
      max_tasks: 20,
      max_runtime_seconds: 3600,
      max_step_attempts: 3,
      max_failures: 3,
    },
    steps: [
      {
        id: 'plan',
        type: 'agent_task',
        agent_role: 'planner',
        label: 'Plan',
        prompt_template: 'You are the planner. Objective: {{ inputs.objective }}. Produce an implementation plan and acceptance criteria. Set status="continue" to proceed to implementation, or "complete"/"blocked"/"failed".',
        output_schema: 'planner_decision',
      },
      {
        id: 'implement',
        type: 'agent_task',
        agent_role: 'executor',
        label: 'Implement',
        // Reads the NEWEST planner instruction via context.* (refreshed after the
        // initial plan and after every review), plus the guaranteed-predecessor
        // plan summary via steps.plan.output (plan dominates implement).
        prompt_template: 'You are the executor. Objective: {{ inputs.objective }}. Original plan: {{ steps.plan.output.summary }}. Latest instruction: {{ context.latest_planner_decision.next_step }}. Acceptance criteria: {{ context.latest_planner_decision.acceptance_criteria }}. Round: {{ workflow.round }}. Implement the next increment and report a structured handoff.',
        output_schema: 'executor_handoff',
        workspace_key_template: '{{ inputs.workspace_key }}',
        permission_mode: 'default',
      },
      {
        id: 'review',
        type: 'agent_task',
        agent_role: 'planner',
        label: 'Review',
        // Reads the latest executor handoff via context.*; its output REPLACES
        // latest_planner_decision, so the looped implement gets the newest guidance.
        prompt_template: 'You are the planner reviewing the executor handoff. Objective: {{ inputs.objective }}. Executor summary: {{ context.latest_executor_handoff.summary }}. Changed files: {{ context.latest_executor_handoff.changed_files }}. Remaining work: {{ context.latest_executor_handoff.remaining_work }}. Round: {{ workflow.round }}. Decide status="continue" (loop back with a next_step), "complete", "blocked", or "failed".',
        output_schema: 'planner_decision',
      },
    ],
    edges: [
      // plan → implement (proceed) or terminate.
      { from: 'plan', to: 'implement', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'continue' } },
      { from: 'plan', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'complete' } },
      { from: 'plan', to: '$blocked', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'blocked' } },
      { from: 'plan', to: '$failed', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'failed' } },
      // implement → review, or terminate on a bad handoff.
      { from: 'implement', to: 'review', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'implemented' } },
      { from: 'implement', to: '$blocked', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'blocked' } },
      { from: 'implement', to: '$failed', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'failed' } },
      // review → loop back to implement (increments round) or terminate.
      { from: 'review', to: 'implement', kind: 'loop', condition: { path: 'output.status', op: 'eq', value: 'continue' } },
      { from: 'review', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'complete' } },
      { from: 'review', to: '$blocked', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'blocked' } },
      { from: 'review', to: '$failed', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'failed' } },
    ],
  }
}
