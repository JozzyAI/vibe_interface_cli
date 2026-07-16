/**
 * Minimal deterministic durable planner/executor Workflow Runtime (v1).
 *
 * Executes a validated {@link WorkflowSpec} over the durable ControlStore and an
 * injected {@link AgentTaskClient}. It contains NO SQL (all persistence goes
 * through narrow atomic store composites), NO natural-language compilation, NO
 * REST/MCP/UI, and NO distributed scheduling. Every durable step is idempotent so
 * a Runtime or Gateway restart resumes without duplicating an Agent Task, step
 * execution, edge, terminal event, or counter.
 *
 * SINGLE-RUNTIME scope: one active runtime process per ControlStore database.
 * Duplicate start/recover calls coalesce onto one in-process pump per workflow;
 * optimistic workflow revisions + task idempotency + step-execution uniqueness
 * protect crash recovery. There is deliberately no distributed lock service.
 */
import crypto from 'crypto'
import type { ControlStore, WorkflowEventDraft } from '../control/store.js'
import type { WorkflowRecord, StepExecutionRecord, CreateStepExecutionInput } from '../control/records.js'
import {
  isTerminalWorkflowStatus as isWfTerminalEnum, isTerminalStepStatus as isStepTerminalEnum, canTakeLoopEdge, terminalTargetToStatus,
  WORKFLOW_EVENT_CONTRACT_VERSION,
  type WorkflowSpec, type ContextGroup, type WorkflowContextBundle, type OutputSchema,
  type WorkflowStatus, type StepStatus,
} from './contract.js'

const isTerminalWorkflowStatus = (s: string): boolean => isWfTerminalEnum(s as WorkflowStatus)
const isTerminalStepStatus = (s: string): boolean => isStepTerminalEnum(s as StepStatus)
import { validateWorkflowSpec } from './validator.js'
import { normalizeInputValues } from './input-values.js'
import { renderPrompt, renderWorkspaceKey, type RenderScope } from './prompt-renderer.js'
import { extractAgentOutputText, parseSingleJsonObject } from './output-parser.js'
import { validateAgainstSchema } from './output-validator.js'
import { selectEdge } from './routing.js'
import { stepExecutionId } from './recovery.js'
import { WorkflowRuntimeError, type LimitKind } from './errors.js'
import { TransientAgentTaskError, type AgentTaskClient, type AgentTaskTerminalRead } from './task-client.js'
import { resolveWorkspaceTargets, TransientWorkspaceLeaseError, type WorkspaceLeaseClient, type WorkspaceTarget } from './workspace-lease-client.js'
import { workspaceLeaseId, revisionsMatch, WorkspaceLeaseError, type WorkspaceRevision } from '../lib/workspace-lease.js'

const CV = WORKFLOW_EVENT_CONTRACT_VERSION
const MAX_CTX_LIST = 50

export interface WorkflowRuntimeOptions {
  store: ControlStore
  taskClient: AgentTaskClient
  /** OPTIONAL workspace-lease authority client. When present, a workspace-bound
   *  workflow acquires all its Node workspace leases before `ready → running`,
   *  passes the matching lease id to every Agent Task, checks revisions before/after
   *  each step, and releases only after the workflow is terminal. When ABSENT the
   *  runtime behaves exactly as before (no leases; no revision checks). */
  leaseClient?: WorkspaceLeaseClient
  /** Bounded wait window per task poll (ms). Default 5000. */
  waitWindowMs?: number
  /** Backoff base for transient task-client failures (ms). Default 500. */
  backoffBaseMs?: number
  /** Max backoff (ms). Default 5000. */
  backoffMaxMs?: number
  /** Max release attempts per lease before deferring to a later recovery. Default 8. */
  maxReleaseAttempts?: number
  /** Injectable clock (for runtime-deadline tests). Default Date.now. */
  now?: () => number
}

export interface CreateWorkflowResult { workflow_id: string; workflow: WorkflowRecord }

export class WorkflowRuntime {
  private readonly store: ControlStore
  private readonly taskClient: AgentTaskClient
  private readonly leaseClient?: WorkspaceLeaseClient
  private readonly waitWindowMs: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly maxReleaseAttempts: number
  private readonly now: () => number
  private stopped = false
  private readonly pumps = new Map<string, Promise<void>>()
  private readonly aborts = new Map<string, AbortController>()

  constructor(opts: WorkflowRuntimeOptions) {
    this.store = opts.store
    this.taskClient = opts.taskClient
    this.leaseClient = opts.leaseClient
    this.waitWindowMs = opts.waitWindowMs ?? 5000
    this.backoffBaseMs = opts.backoffBaseMs ?? 500
    this.backoffMaxMs = opts.backoffMaxMs ?? 5000
    this.maxReleaseAttempts = opts.maxReleaseAttempts ?? 8
    this.now = opts.now ?? Date.now
  }

  // ── public API ───────────────────────────────────────────────────────────────

  /** Validate spec + input values, create a durable workflow (status `ready`), and
   *  persist workflow.created + workflow.validated. No Agent Task starts here. */
  async createWorkflow(spec: unknown, inputValues?: unknown): Promise<CreateWorkflowResult> {
    const v = validateWorkflowSpec(spec)
    if (!v.valid) throw new WorkflowRuntimeError('invalid_spec', 'workflow spec failed validation', { issues: v.issues.filter((i) => i.severity === 'error').slice(0, 10).map((i) => ({ code: i.code, path: i.path })) })
    const s = spec as WorkflowSpec
    const norm = normalizeInputValues(s, inputValues)
    if (!norm.ok) throw new WorkflowRuntimeError('invalid_input_values', norm.message, norm.name ? { name: norm.name } : undefined)

    const workflowId = 'wf_' + crypto.randomBytes(9).toString('hex')
    const objective = typeof norm.values.objective === 'string' ? norm.values.objective : (s.description ?? s.name)
    const context: WorkflowContextBundle = { objective: String(objective).slice(0, 4096), current_round: 1 }
    const ts = new Date().toISOString()
    const workflow = await this.store.createWorkflowWithLifecycleEvents(
      { workflow_id: workflowId, spec_version: s.version, workflow_name: s.name, spec: s, input_values: norm.values },
      context,
      { event_type: 'workflow.created', ts, payload: { name: s.name }, contract_version: CV } as WorkflowEventDraft,
      { event_type: 'workflow.validated', ts, payload: {}, contract_version: CV } as WorkflowEventDraft,
    )
    return { workflow_id: workflowId, workflow }
  }

  /** Atomically transition ready→running and begin driving the workflow. Returns
   *  the durable snapshot WITHOUT waiting for completion. Repeated calls coalesce. */
  async startWorkflow(workflowId: string): Promise<WorkflowRecord> {
    const wf = await this.store.getWorkflow(workflowId)
    if (!wf) throw new WorkflowRuntimeError('invalid_transition', `workflow not found: ${workflowId}`)
    if (isTerminalWorkflowStatus(wf.status)) return wf                 // terminal snapshot
    if (wf.status === 'blocked') return wf                             // do not silently resume
    if (wf.status === 'running') { this.ensurePump(workflowId); return wf } // coalesce
    if (wf.status !== 'ready') throw new WorkflowRuntimeError('invalid_transition', `cannot start from status ${wf.status}`)
    // Acquire ALL required workspace leases BEFORE the durable ready→running
    // transition. On conflict the workflow stays `ready`, any partially-acquired
    // leases are released, and no task starts — an explicit later start retries.
    if (this.leaseClient) {
      const spec = this.loadSpec(wf)
      if (!spec) throw new WorkflowRuntimeError('runtime_internal', 'invalid persisted spec')
      await this.acquireWorkflowLeases(workflowId, spec, (wf.input_values ?? {}) as Record<string, unknown>)
    }
    const r = await this.store.startWorkflowDurably(workflowId, { event_type: 'workflow.started', ts: new Date().toISOString(), payload: {}, contract_version: CV } as WorkflowEventDraft)
    this.ensurePump(workflowId)
    return r.workflow
  }

  /** The durable snapshot (workflow record + bounded context). */
  async getWorkflowSnapshot(workflowId: string): Promise<{ workflow: WorkflowRecord; context: unknown; context_revision: number } | null> {
    return this.store.getWorkflowSnapshot(workflowId)
  }

  /** Rebuild + resume all `running` workflows. Idempotent; coalesces onto the
   *  single per-workflow pump. */
  async recoverWorkflows(): Promise<string[]> {
    const running = await this.store.listWorkflows({ status: 'running' })
    for (const wf of running) this.ensurePump(wf.workflow_id)
    // Also finish any pending lease releases for workflows that terminalized before
    // their release completed (e.g. a crash right after terminalization). Idempotent.
    await this.recoverLeaseReleases().catch(() => { /* best effort; retried next recover */ })
    return running.map((w) => w.workflow_id)
  }

  /** Idempotent cancellation: record intent durably, cancel the exact current
   *  task (never guess), mark the workflow cancelled exactly once. */
  async cancelWorkflow(workflowId: string): Promise<WorkflowRecord> {
    const wf = await this.store.getWorkflow(workflowId)
    if (!wf) throw new WorkflowRuntimeError('invalid_transition', `workflow not found: ${workflowId}`)
    if (isTerminalWorkflowStatus(wf.status)) return wf // already terminal wins; idempotent
    await this.store.recordCancellationIntent(workflowId)
    this.aborts.get(workflowId)?.abort() // interrupt any in-flight wait
    await this.performCancellation(workflowId)
    // A directly-cancelled workflow (e.g. blocked → cancelled) is not driven by a
    // pump, so release its retained leases here. Idempotent with the pump's release.
    if (this.leaseClient) await this.settleLeaseReleases(workflowId)
    return (await this.store.getWorkflow(workflowId))!
  }

  /** Stop the runtime: abort waits/backoff and let pumps unwind. In-flight Agent
   *  Tasks are NOT cancelled — they remain durable and resume on next recover. */
  async shutdown(): Promise<void> {
    this.stopped = true
    for (const ac of this.aborts.values()) { try { ac.abort() } catch { /* */ } }
    await Promise.allSettled([...this.pumps.values()])
  }

  /** Test/consumer helper: ensure the pump ran and await it to quiescence. */
  async awaitWorkflow(workflowId: string): Promise<WorkflowRecord> {
    await this.ensurePump(workflowId)
    return (await this.store.getWorkflow(workflowId))!
  }

  // ── pump orchestration ───────────────────────────────────────────────────────

  private ensurePump(workflowId: string): Promise<void> {
    const existing = this.pumps.get(workflowId)
    if (existing) return existing
    const p = this.runWorkflow(workflowId).catch(() => { /* pump errors are terminalized inside */ }).finally(() => { this.pumps.delete(workflowId); this.aborts.delete(workflowId) })
    this.pumps.set(workflowId, p)
    return p
  }

  private async runWorkflow(workflowId: string): Promise<void> {
    await this.driveWorkflow(workflowId)
    // After the drive loop settles (terminal/blocked/shutdown), release any leases the
    // workflow no longer needs. Blocked workflows RETAIN their leases; terminal
    // (completed/failed/cancelled) workflows release them (idempotent, retryable).
    if (this.leaseClient && !this.stopped) await this.settleLeaseReleases(workflowId)
  }

  private async driveWorkflow(workflowId: string): Promise<void> {
    const ac = new AbortController()
    this.aborts.set(workflowId, ac)
    while (!this.stopped) {
      const wf = await this.store.getWorkflow(workflowId)
      if (!wf || isTerminalWorkflowStatus(wf.status) || wf.status === 'blocked' || wf.status !== 'running') return
      const spec = this.loadSpec(wf)
      if (!spec) { await this.failWorkflow(workflowId, 'runtime_internal', { reason: 'invalid_persisted_spec' }); return }

      if (wf.cancel_requested) { await this.performCancellation(workflowId); return }
      if (this.deadlineExceeded(wf)) { await this.failLimit(workflowId, 'max_runtime_seconds'); return }

      const stepId = wf.current_step_id ?? spec.entry_step
      const round = wf.current_round
      let step = await this.store.getStepExecutionByKey(workflowId, stepId, round, 1)
      if (!step) step = await this.startStep(workflowId, stepId, round)

      if (step.status === 'completed') { if (await this.routeAndAdvance(workflowId, spec, step)) return; else continue }
      if (isTerminalStepStatus(step.status)) return // failed/cancelled step → workflow already terminal

      if (step.task_id == null) {
        if (wf.total_tasks >= spec.limits.max_tasks) { await this.failLimit(workflowId, 'max_tasks'); return }
        const r = await this.createAndBindTask(workflowId, spec, wf, step, ac.signal)
        if (r !== 'ok') return
        step = (await this.store.getStepExecutionByKey(workflowId, stepId, round, 1))!
      }

      const outcome = await this.awaitTask(wf, step.task_id!, ac.signal)
      if (outcome === 'shutdown') return
      if (outcome === 'deadline') { await this.failLimit(workflowId, 'max_runtime_seconds'); return }
      if (outcome === 'cancel') { await this.performCancellation(workflowId); return }
      if (await this.handleTaskTerminal(workflowId, spec, step, outcome)) return
    }
  }

  private async startStep(workflowId: string, stepId: string, round: number): Promise<StepExecutionRecord> {
    const secId = stepExecutionId(workflowId, stepId, round, 1)
    const r = await this.store.ensureStepStarted(
      { step_execution_id: secId, workflow_id: workflowId, step_id: stepId, round, attempt: 1, status: 'pending' } satisfies CreateStepExecutionInput,
      stepId,
      { event_type: 'step.started', ts: new Date().toISOString(), step_execution_id: secId, payload: { step_id: stepId, round, attempt: 1 }, contract_version: CV } as WorkflowEventDraft,
    )
    return r.step
  }

  // ── task creation + binding ────────────────────────────────────────────────────

  private async createAndBindTask(workflowId: string, spec: WorkflowSpec, wf: WorkflowRecord, step: StepExecutionRecord, signal: AbortSignal): Promise<'ok' | 'stop'> {
    const specStep = spec.steps.find((s) => s.id === step.step_id)
    const role = specStep ? spec.agents[specStep.agent_role] : undefined
    if (!specStep || !role) { await this.failWorkflow(workflowId, 'runtime_internal', { reason: 'unknown_step_or_role', step_id: step.step_id }); return 'stop' }

    const scope = await this.buildRenderScope(workflowId, wf, step)
    const rendered = renderPrompt(specStep.prompt_template, scope)
    if (!rendered.ok) { await this.failWorkflow(workflowId, 'render_error', { code: rendered.code, step_id: step.step_id }); return 'stop' }
    const ws = renderWorkspaceKey(specStep.workspace_key_template, scope)
    if (!ws.ok) { await this.failWorkflow(workflowId, 'render_error', { code: ws.code, step_id: step.step_id }); return 'stop' }

    // Workspace-lease gate: for a lease-managed step, observe the CURRENT revision,
    // compare it with the lease's expected revision, and persist revision_before —
    // all BEFORE creating the task. An out-of-band change BLOCKS the workflow (the
    // lease is retained) rather than letting an agent write over a diverged tree.
    const target = this.stepLeaseTarget(spec, wf, step)
    let leaseId: string | undefined
    if (target) {
      const gate = await this.revisionGateBefore(workflowId, step, target, signal)
      if (gate !== 'ok') return 'stop' // blocked (retains lease) or shutdown
      leaseId = target.workspace_lease_id
    }

    const req = {
      agent: role.agent,
      ...(role.node_id ? { node_id: role.node_id } : {}),
      input: { text: rendered.text },
      ...(ws.workspaceKey ? { workspace_key: ws.workspaceKey } : {}),
      ...(specStep.permission_mode ? { permission_mode: specStep.permission_mode } : {}),
      // Deterministic, bounded observability metadata (same on every idempotent retry).
      metadata: { workflow_id: workflowId, step_execution_id: step.step_execution_id, step_id: step.step_id, round: step.round, attempt: step.attempt },
      idempotency_key: step.step_execution_id,
      ...(leaseId ? { workspace_lease_id: leaseId } : {}),
    }

    // Create with bounded backoff on transient failures; a fatal failure fails the
    // workflow. Shutdown/deadline leave the durable step for recovery.
    let attempt = 0
    while (!this.stopped && !signal.aborted) {
      if (this.deadlineExceeded(wf)) return 'stop' // caller re-checks & fails via deadline
      try {
        const ref = await this.taskClient.createTask(req)
        await this.store.bindStepTaskOnce(step.step_execution_id, ref.task_id, workflowId, { event_type: 'step.task_created', ts: new Date().toISOString(), step_execution_id: step.step_execution_id, payload: { task_id: ref.task_id, step_id: step.step_id, round: step.round }, contract_version: CV } as WorkflowEventDraft)
        return 'ok'
      } catch (err) {
        if (err instanceof TransientAgentTaskError) { await this.backoff(attempt++, signal); continue }
        await this.failWorkflow(workflowId, 'runtime_internal', { reason: 'task_create_failed', step_id: step.step_id })
        return 'stop'
      }
    }
    return 'stop'
  }

  // ── awaiting a task ────────────────────────────────────────────────────────────

  private async awaitTask(wf: WorkflowRecord, taskId: string, signal: AbortSignal): Promise<AgentTaskTerminalRead | 'shutdown' | 'deadline' | 'cancel'> {
    let cursor = -1
    let attempt = 0
    while (!this.stopped) {
      if (signal.aborted) return 'cancel' // cancellation interrupted the wait
      if (this.deadlineExceeded(wf)) return 'deadline'
      try {
        const read = await this.taskClient.waitForTerminal(taskId, { afterId: cursor, budgetMs: this.waitWindowMs, signal })
        cursor = read.next_event_id
        attempt = 0
        if (read.terminal) return read
      } catch (err) {
        if (err instanceof TransientAgentTaskError) { if (signal.aborted) return 'cancel'; await this.backoff(attempt++, signal); continue }
        throw err
      }
    }
    return 'shutdown'
  }

  private async handleTaskTerminal(workflowId: string, spec: WorkflowSpec, step: StepExecutionRecord, read: AgentTaskTerminalRead): Promise<boolean> {
    const wf = (await this.store.getWorkflow(workflowId))!
    // After EVERY terminal task on a lease-managed step: observe revision_after,
    // persist it, and advance the lease's expected current revision — BEFORE we parse
    // the AgentTaskResult or route (so the next step compares against a fresh baseline).
    await this.observeRevisionAfter(spec, wf, step)
    if (wf.cancel_requested) { await this.performCancellation(workflowId); return true }

    if (read.status === 'failed') {
      await this.failStep(workflowId, step, { reason: 'task_failed', task_id: read.task_id }); return true
    }
    if (read.status === 'cancelled') {
      await this.failStep(workflowId, step, { reason: 'task_cancelled_external', task_id: read.task_id }); return true
    }
    // completed — route on the FIRST-CLASS AgentTaskResult, never on event history.
    //   available → parse final_output into the step schema and route
    //   missing   → block (task_result_missing); never guess from events
    //   invalid   → fail (task_result_invalid); the result envelope was corrupt
    const rs = read.result_status
    if (rs === 'invalid') { await this.failStep(workflowId, step, { reason: 'task_result_invalid', task_id: read.task_id }); return true }
    if (rs !== 'available' || read.result_text === undefined) {
      await this.blockWorkflow(workflowId, 'task_result_missing', { task_id: read.task_id, step_id: step.step_id, round: step.round }); return true
    }
    const parsed = this.parseResultOutput(read.result_text, spec, step)
    if (!parsed.ok) { await this.failStep(workflowId, step, { reason: 'invalid_output', code: parsed.code, ...(parsed.field ? { field: parsed.field } : {}) }); return true }

    // Persist the validated output + update the bound context slot atomically.
    const specStep = spec.steps.find((s) => s.id === step.step_id)!
    const { context, revision } = await this.buildUpdatedContext(workflowId, specStep.context_binding, parsed.value, read.task_id, read.history_complete)
    await this.store.completeStepAndCheckpoint(step.step_execution_id, parsed.value, workflowId, revision, context, { event_type: 'step.completed', ts: new Date().toISOString(), step_execution_id: step.step_execution_id, payload: { step_id: step.step_id, round: step.round }, contract_version: CV } as WorkflowEventDraft)
    return false // loop re-reads and routes from the now-completed step
  }

  /** Parse the AgentTaskResult's authoritative final output into the step's output
   *  schema. PURE over the result text — NO event-history scanning/aggregation. */
  private parseResultOutput(resultText: string, spec: WorkflowSpec, step: StepExecutionRecord): { ok: true; value: Record<string, unknown> } | { ok: false; code: string; field?: string } {
    const specStep = spec.steps.find((s) => s.id === step.step_id)!
    const schema: OutputSchema = spec.output_schemas[specStep.output_schema]
    const parsed = parseSingleJsonObject(resultText)
    if (!parsed.ok) return { ok: false, code: parsed.code }
    const validated = validateAgainstSchema(parsed.value, schema)
    if (!validated.ok) return { ok: false, code: validated.code, field: validated.field }
    return { ok: true, value: validated.value }
  }

  // ── routing ────────────────────────────────────────────────────────────────────

  private async routeAndAdvance(workflowId: string, spec: WorkflowSpec, step: StepExecutionRecord): Promise<boolean> {
    const output = (step.output && typeof step.output === 'object' && !Array.isArray(step.output)) ? step.output as Record<string, unknown> : null
    if (!output) { await this.failWorkflow(workflowId, 'runtime_internal', { reason: 'missing_step_output', step_id: step.step_id }); return true }
    const decision = selectEdge(spec, step.step_id, output, step.round)
    if (!decision.ok) { await this.failWorkflow(workflowId, decision.code === 'routing_no_edge' ? 'routing_no_edge' : 'routing_ambiguous', { step_id: step.step_id }); return true }

    if (decision.decision.kind === 'terminal') {
      const status = terminalTargetToStatus(decision.decision.target as '$complete' | '$failed' | '$blocked')
      const eventType = status === 'completed' ? 'workflow.completed' : status === 'failed' ? 'workflow.failed' : 'workflow.blocked'
      await this.store.terminalizeWorkflow(workflowId, status,
        { event_type: 'edge.selected', ts: new Date().toISOString(), payload: { to: decision.decision.target }, contract_version: CV } as WorkflowEventDraft,
        { event_type: eventType, ts: new Date().toISOString(), payload: status === 'blocked' ? { reason: 'routed_blocked' } : {}, contract_version: CV } as WorkflowEventDraft)
      return true
    }
    // step target (normal or loop)
    const target = decision.decision.target
    const loop = decision.decision.edgeKind === 'loop'
    if (loop && !canTakeLoopEdge(step.round, spec.limits.max_rounds ?? 0)) { await this.failLimit(workflowId, 'max_rounds'); return true }
    const nextRound = loop ? step.round + 1 : step.round
    const nextSecId = stepExecutionId(workflowId, target, nextRound, 1)
    await this.store.advanceWorkflow(
      workflowId,
      { event_type: 'edge.selected', ts: new Date().toISOString(), payload: { to: target, kind: decision.decision.edgeKind }, contract_version: CV } as WorkflowEventDraft,
      loop ? { event_type: 'workflow.round_advanced', ts: new Date().toISOString(), payload: { round: nextRound }, contract_version: CV } as WorkflowEventDraft : null,
      { step_execution_id: nextSecId, workflow_id: workflowId, step_id: target, round: nextRound, attempt: 1, status: 'pending' } satisfies CreateStepExecutionInput,
      target,
      { event_type: 'step.started', ts: new Date().toISOString(), step_execution_id: nextSecId, payload: { step_id: target, round: nextRound, attempt: 1 }, contract_version: CV } as WorkflowEventDraft,
    )
    return false // continue the pump loop at the new current step
  }

  // ── terminal helpers ────────────────────────────────────────────────────────────

  private async failStep(workflowId: string, step: StepExecutionRecord, meta: Record<string, unknown>): Promise<void> {
    await this.store.failStepAndWorkflow(
      step.step_execution_id, workflowId,
      { event_type: 'step.failed', ts: new Date().toISOString(), step_execution_id: step.step_execution_id, payload: meta, contract_version: CV } as WorkflowEventDraft,
      { event_type: 'workflow.failed', ts: new Date().toISOString(), payload: meta, contract_version: CV } as WorkflowEventDraft,
      meta,
    )
  }

  private async failWorkflow(workflowId: string, code: string, meta: Record<string, unknown>): Promise<void> {
    await this.store.terminalizeWorkflow(workflowId, 'failed', null, { event_type: 'workflow.failed', ts: new Date().toISOString(), payload: { reason: code, ...meta }, contract_version: CV } as WorkflowEventDraft)
  }

  private async failLimit(workflowId: string, limit: LimitKind): Promise<void> {
    // v1: mark the workflow failed with workflow_limit_exceeded; do NOT auto-cancel
    // a still-running Agent Task (only an explicit cancel does that).
    await this.store.terminalizeWorkflow(workflowId, 'failed', null, { event_type: 'workflow.failed', ts: new Date().toISOString(), payload: { reason: 'workflow_limit_exceeded', limit }, contract_version: CV } as WorkflowEventDraft)
  }

  private async blockWorkflow(workflowId: string, reason: string, meta: Record<string, unknown>): Promise<void> {
    await this.store.terminalizeWorkflow(workflowId, 'blocked', null, { event_type: 'workflow.blocked', ts: new Date().toISOString(), payload: { reason, ...meta }, contract_version: CV } as WorkflowEventDraft)
  }

  private async performCancellation(workflowId: string): Promise<void> {
    const wf = await this.store.getWorkflow(workflowId)
    if (!wf || isTerminalWorkflowStatus(wf.status)) return
    await this.store.recordCancellationIntent(workflowId)
    const stepId = wf.current_step_id
    let stepExecId: string | null = null
    if (stepId) {
      const step = await this.store.getStepExecutionByKey(workflowId, stepId, wf.current_round, 1)
      stepExecId = step?.step_execution_id ?? null
      if (step?.task_id) {
        // Cancel the EXACT task (idempotent). An already-completed task stays
        // completed — the authoritative terminal state wins; we never force it.
        try { await this.taskClient.cancelTask(step.task_id) } catch { /* transient — intent persists; recovery retries */ }
      }
    }
    await this.store.cancelStepAndWorkflow(stepExecId, workflowId, { event_type: 'workflow.cancelled', ts: new Date().toISOString(), payload: {}, contract_version: CV } as WorkflowEventDraft)
  }

  // ── workspace-lease lifecycle (workspace_lease_v1) ───────────────────────────────

  /** The lease target for a workspace-bound step (null if not lease-managed or no
   *  leaseClient). Deterministic from the spec + immutable inputs — same across
   *  rounds and restarts, so acquisition/binding is idempotent. */
  private stepLeaseTarget(spec: WorkflowSpec, wf: WorkflowRecord, step: StepExecutionRecord): WorkspaceTarget | null {
    if (!this.leaseClient) return null
    const specStep = spec.steps.find((s) => s.id === step.step_id) as { agent_role?: string; workspace_key_template?: string } | undefined
    if (!specStep) return null
    const role = specStep.agent_role ? spec.agents[specStep.agent_role] : undefined
    if (!role || !role.node_id) return null
    const inputs = (wf.input_values ?? {}) as Record<string, unknown>
    const ws = renderWorkspaceKey(specStep.workspace_key_template, { inputs, stepOutputs: {}, round: step.round, context: {} })
    if (!ws.ok || ws.workspaceKey === undefined) return null
    return { node_id: role.node_id, workspace_key: ws.workspaceKey, workspace_lease_id: workspaceLeaseId(wf.workflow_id, role.node_id, ws.workspaceKey) }
  }

  /** Acquire ALL required leases (sorted node_id then workspace_key) before the
   *  workflow starts. On conflict: release any already acquired, throw (workflow
   *  stays `ready`). Idempotent across restarts (deterministic lease ids). */
  private async acquireWorkflowLeases(workflowId: string, spec: WorkflowSpec, inputValues: Record<string, unknown>): Promise<void> {
    if (!this.leaseClient) return
    const resolved = resolveWorkspaceTargets(workflowId, spec, inputValues)
    if (!resolved.ok) throw new WorkflowRuntimeError(resolved.code === 'workspace_node_ambiguous' ? 'workspace_node_ambiguous' : 'runtime_internal', `workspace lease target unresolved for step ${resolved.step_id}`, { step_id: resolved.step_id })
    if (resolved.targets.length === 0) return
    const acquired: WorkspaceTarget[] = []
    for (const tgt of resolved.targets) {
      await this.store.recordWorkspaceLeaseIntent({ workspace_lease_id: tgt.workspace_lease_id, workflow_id: workflowId, node_id: tgt.node_id, workspace_key: tgt.workspace_key })
      try {
        const { lease } = await this.leaseClient.acquire(tgt.node_id, workflowId, tgt.workspace_key)
        await this.store.markWorkspaceLeaseActive(lease.workspace_lease_id, lease.base_revision ?? null, lease.current_revision ?? lease.base_revision ?? null, lease.acquired_at ?? new Date().toISOString())
        acquired.push(tgt)
      } catch (err) {
        await this.rollbackAcquired(acquired) // free partially-acquired workspaces
        if (err instanceof WorkspaceLeaseError && err.code === 'workspace_lease_conflict') throw new WorkflowRuntimeError('workspace_lease_conflict', 'a required workspace is already leased by another workflow', { workspace_key: tgt.workspace_key })
        if (err instanceof TransientWorkspaceLeaseError) throw new WorkflowRuntimeError('workspace_lease_unavailable', 'workspace lease service unavailable', {})
        throw err
      }
    }
  }

  private async rollbackAcquired(targets: WorkspaceTarget[]): Promise<void> {
    for (const t of targets) {
      try { await this.leaseClient!.release(t.node_id, t.workspace_lease_id) } catch { /* best effort — no run is bound yet */ }
      try { await this.store.markWorkspaceLeaseReleased(t.workspace_lease_id, new Date().toISOString()) } catch { /* */ }
    }
  }

  /** Observe the CURRENT revision and compare with the lease's expected revision
   *  BEFORE creating a step's task; persist revision_before. An out-of-band change
   *  blocks the workflow (lease retained). Transient observe failures back off. */
  private async revisionGateBefore(workflowId: string, step: StepExecutionRecord, target: WorkspaceTarget, signal: AbortSignal): Promise<'ok' | 'stop'> {
    if (!this.leaseClient) return 'ok'
    const proj = await this.store.getWorkspaceLeaseProjection(target.workspace_lease_id)
    const expected = (proj?.current_revision ?? proj?.base_revision) as WorkspaceRevision | undefined
    let observed: WorkspaceRevision | null = null
    let attempt = 0
    while (observed === null) {
      if (this.stopped || signal.aborted) return 'stop'
      try { observed = await this.leaseClient.observeRevision(target.node_id, target.workspace_key) }
      catch (err) { if (err instanceof TransientWorkspaceLeaseError) { await this.backoff(attempt++, signal); continue } throw err }
    }
    await this.store.setStepRevisionBefore(step.step_execution_id, observed)
    if (expected && !revisionsMatch(expected, observed)) {
      await this.blockWorkflow(workflowId, 'workspace_revision_conflict', { step_id: step.step_id, round: step.round, workspace_key: target.workspace_key })
      return 'stop'
    }
    return 'ok'
  }

  /** After a step's task terminalizes, observe revision_after, persist it, and update
   *  the lease's expected current revision — BEFORE the caller parses/route the
   *  result. Best-effort + bounded: a persistent observe failure does not wedge the
   *  workflow (recovery re-observes on the next step). */
  private async observeRevisionAfter(spec: WorkflowSpec, wf: WorkflowRecord, step: StepExecutionRecord): Promise<void> {
    if (!this.leaseClient) return
    const target = this.stepLeaseTarget(spec, wf, step)
    if (!target) return
    for (let attempt = 0; attempt < this.maxReleaseAttempts; attempt++) {
      if (this.stopped) return
      try {
        const observed = await this.leaseClient.observeRevision(target.node_id, target.workspace_key)
        await this.store.setStepRevisionAfter(step.step_execution_id, observed)
        await this.store.setWorkspaceLeaseRevision(target.workspace_lease_id, observed)
        return
      } catch (err) { if (err instanceof TransientWorkspaceLeaseError) { await this.backoff(attempt, this.aborts.get(wf.workflow_id)?.signal ?? new AbortController().signal); continue } return }
    }
  }

  /** Release all of a TERMINAL workflow's leases (idempotent, retryable). A release
   *  refused because a bound run is still winding down (`workspace_lease_in_use`) is
   *  transient — retried with bounded backoff; anything unresolved stays
   *  `release_requested` for a later recovery. Blocked workflows are NOT released. */
  private async settleLeaseReleases(workflowId: string): Promise<void> {
    if (!this.leaseClient) return
    const wf = await this.store.getWorkflow(workflowId)
    if (!wf || !['completed', 'failed', 'cancelled'].includes(wf.status)) return // retain on blocked/non-terminal
    const leases = await this.store.listWorkspaceLeaseProjections(workflowId)
    for (const lease of leases) {
      if (lease.status === 'released') continue
      await this.releaseLeaseWithRetry(lease.node_id, lease.workspace_lease_id)
    }
  }

  private async releaseLeaseWithRetry(nodeId: string, leaseId: string): Promise<void> {
    await this.store.requestWorkspaceLeaseRelease(leaseId, new Date().toISOString()) // durable intent first
    for (let attempt = 0; attempt < this.maxReleaseAttempts; attempt++) {
      if (this.stopped) return // leave release_requested for recovery
      try {
        await this.leaseClient!.release(nodeId, leaseId)
        await this.store.markWorkspaceLeaseReleased(leaseId, new Date().toISOString())
        return
      } catch (err) {
        if (err instanceof TransientWorkspaceLeaseError) { await this.backoff(attempt, new AbortController().signal); continue } // in_use/unavailable → retry
        return // fatal — leave release_requested; recovery may retry
      }
    }
  }

  /** Recovery: complete any pending lease releases for terminal workflows (e.g. a
   *  crash between terminalization and release). Idempotent. */
  async recoverLeaseReleases(): Promise<number> {
    if (!this.leaseClient) return 0
    const pending = await this.store.listReleasableWorkspaceLeases()
    for (const lease of pending) await this.releaseLeaseWithRetry(lease.node_id, lease.workspace_lease_id)
    return pending.length
  }

  // ── scope + context ────────────────────────────────────────────────────────────

  private async buildRenderScope(workflowId: string, wf: WorkflowRecord, step: StepExecutionRecord): Promise<RenderScope> {
    const snap = await this.store.getWorkflowSnapshot(workflowId)
    const ctx = (snap?.context ?? {}) as WorkflowContextBundle
    const stepOutputs: Record<string, Record<string, unknown>> = {}
    for (const se of await this.store.listStepExecutions(workflowId)) {
      if (se.status === 'completed' && se.output && typeof se.output === 'object' && !Array.isArray(se.output)) stepOutputs[se.step_id] = se.output as Record<string, unknown>
    }
    const context: Partial<Record<ContextGroup, Record<string, unknown>>> = {}
    if (ctx.latest_planner_decision) context.latest_planner_decision = ctx.latest_planner_decision as unknown as Record<string, unknown>
    if (ctx.latest_executor_handoff) context.latest_executor_handoff = ctx.latest_executor_handoff as unknown as Record<string, unknown>
    return { inputs: (wf.input_values ?? {}) as Record<string, unknown>, stepOutputs, round: step.round, context }
  }

  private async buildUpdatedContext(workflowId: string, binding: ContextGroup | undefined, output: Record<string, unknown>, taskId: string, historyComplete: boolean): Promise<{ context: WorkflowContextBundle; revision: number }> {
    const snap = await this.store.getWorkflowSnapshot(workflowId)
    const cur = (snap?.context ?? {}) as WorkflowContextBundle
    const wf = snap!.workflow
    const next: WorkflowContextBundle = { ...cur, current_round: wf.current_round }
    if (binding === 'latest_planner_decision') next.latest_planner_decision = output as unknown as WorkflowContextBundle['latest_planner_decision']
    else if (binding === 'latest_executor_handoff') next.latest_executor_handoff = output as unknown as WorkflowContextBundle['latest_executor_handoff']
    // Runtime-VERIFIED evidence (separate from agent claims) — bounded.
    next.verified_evidence = [...(cur.verified_evidence ?? []), { kind: 'task_status', summary: `task completed; history_complete=${historyComplete}`, task_id: taskId }].slice(-MAX_CTX_LIST)
    next.prior_task_ids = [...(cur.prior_task_ids ?? []), taskId].slice(-MAX_CTX_LIST)
    return { context: next, revision: snap?.context_revision ?? 0 }
  }

  // ── misc ───────────────────────────────────────────────────────────────────────

  private loadSpec(wf: WorkflowRecord): WorkflowSpec | null {
    const v = validateWorkflowSpec(wf.spec)
    return v.valid ? (wf.spec as WorkflowSpec) : null
  }

  private deadlineExceeded(wf: WorkflowRecord): boolean {
    if (!wf.started_at) return false // never resets across restart — measured from persisted started_at
    const started = Date.parse(wf.started_at)
    if (!Number.isFinite(started)) return false
    const maxMs = ((wf.spec as WorkflowSpec).limits.max_runtime_seconds ?? 0) * 1000
    return (this.now() - started) >= maxMs
  }

  private async backoff(attempt: number, signal: AbortSignal): Promise<void> {
    const ms = Math.min(this.backoffBaseMs * Math.pow(2, attempt), this.backoffMaxMs)
    await new Promise<void>((resolve) => {
      if (signal.aborted || this.stopped) return resolve()
      const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
      const onAbort = (): void => { clearTimeout(t); resolve() }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
