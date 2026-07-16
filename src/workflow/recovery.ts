/**
 * Pure recovery helpers for the Workflow Runtime.
 *
 * The runtime pump is written so that EVERY durable step is idempotent, which is
 * what makes crash recovery a simple matter of re-running the pump. These helpers
 * mint the stable `step_execution_id` (reused verbatim on recovery — it is NOT a
 * retry) and classify the durable phase a recovered workflow is in.
 */
import { createHash } from 'crypto'
import type { WorkflowRecord, StepExecutionRecord } from '../control/records.js'

/**
 * Deterministic, stable `step_execution_id` for a (workflow, step, round, attempt).
 * Reused byte-for-byte on recovery so the Gateway idempotency_key resolves to the
 * same durable task — never a second execution. Shaped to the store's safe-id
 * grammar (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`).
 */
export function stepExecutionId(workflowId: string, stepId: string, round: number, attempt: number): string {
  return `${workflowId}.${stepId}.r${round}.a${attempt}`
}

/** Deterministic, stable human-pause request id for a step execution — reused
 *  verbatim on recovery so the pause request is idempotent (never a duplicate). */
export function humanRequestId(stepExecutionId: string): string {
  return `hr_${createHash('sha256').update(stepExecutionId).digest('hex').slice(0, 32)}`
}

export type RecoveryPhase =
  | 'terminal'                // workflow already terminal — do nothing
  | 'blocked'                 // blocked — non-terminal, not auto-resumed
  | 'needs_step_execution'    // current step has no execution record yet
  | 'needs_task'              // execution exists, no task bound
  | 'awaiting_task'           // task bound, step not yet completed
  | 'needs_routing'           // step completed, outgoing edge not yet taken

const WF_TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/**
 * Classify where a recovered workflow stands, given its record and the current
 * step's execution (or null). Pure — the pump uses this to resume at the exact
 * durable boundary without duplicating work.
 */
export function classifyPhase(wf: WorkflowRecord, currentStep: StepExecutionRecord | null): RecoveryPhase {
  if (WF_TERMINAL.has(wf.status)) return 'terminal'
  if (wf.status === 'blocked') return 'blocked'
  if (!currentStep) return 'needs_step_execution'
  if (currentStep.status === 'completed') return 'needs_routing'
  if (currentStep.task_id == null) return 'needs_task'
  return 'awaiting_task'
}
