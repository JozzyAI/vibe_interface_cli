/**
 * Workflow REST controllers — thin, PURE-ish handlers over the durable
 * ControlStore + the WorkflowRuntime. They contain NO SQL and NO runtime
 * orchestration; they validate, delegate, and project durable state. Each returns
 * `{ status, body }` for the Gateway to serialize (the SSE events route is handled
 * separately in `event-stream.ts`).
 *
 * `create` NEVER starts execution — that is a separate explicit `start`, so a
 * future natural-language compiler can support generate → validate → preview →
 * approve → start.
 */
import type { ControlStore } from '../control/store.js'
import type { WorkflowRuntime } from './runtime.js'
import {
  workflowApiError, mapThrownError, parseCreateWorkflowBody, preflightSpec, parseListQuery,
  toWorkflowSummary, toWorkflowSnapshotView, reasonFromEvents,
} from './api-contract.js'

export interface ControllerResult { status: number; body: unknown }

const END_STATES = new Set(['completed', 'failed', 'cancelled', 'blocked'])

/** Build the full durable snapshot view for a workflow, or null if unknown. */
async function buildSnapshotView(store: ControlStore, workflowId: string): Promise<Record<string, unknown> | null> {
  const snap = await store.getWorkflowSnapshot(workflowId)
  if (!snap) return null
  const steps = await store.listStepExecutions(workflowId)
  const rec = snap.workflow
  const reason = END_STATES.has(rec.status) ? reasonFromEvents(await store.listWorkflowEvents(workflowId)) : null
  const leases = await store.listWorkspaceLeaseProjections(workflowId)
  return toWorkflowSnapshotView(rec, snap.context, snap.context_revision, steps, reason, leases)
}

export async function listWorkflowsController(store: ControlStore, search: URLSearchParams): Promise<ControllerResult> {
  const q = parseListQuery(search)
  if (!q.ok) return { status: 400, body: q.error }
  try {
    const rows = await store.listWorkflows(q.value.status ? { status: q.value.status } : {}, { limit: q.value.limit, offset: q.value.offset })
    return { status: 200, body: { workflows: rows.map(toWorkflowSummary), limit: q.value.limit, offset: q.value.offset, count: rows.length } }
  } catch (err) { const m = mapThrownError(err); return { status: m.status, body: m.error } }
}

export async function createWorkflowController(runtime: WorkflowRuntime, body: unknown): Promise<ControllerResult> {
  const parsed = parseCreateWorkflowBody(body)
  if (!parsed.ok) return { status: 400, body: parsed.error }
  // Rich, sanitized spec issues up front (the runtime re-validates identically).
  const specErr = preflightSpec(parsed.value.spec)
  if (specErr) return { status: 400, body: specErr }
  try {
    const { workflow_id } = await runtime.createWorkflow(parsed.value.spec, parsed.value.input_values)
    // Reuse the runtime's ControlStore via a fresh snapshot read (durable projection).
    const view = await buildSnapshotViewFromRuntime(runtime, workflow_id)
    return { status: 201, body: view }
  } catch (err) { const m = mapThrownError(err); return { status: m.status, body: m.error } }
}

export async function startWorkflowController(runtime: WorkflowRuntime, store: ControlStore, workflowId: string): Promise<ControllerResult> {
  const rec = await store.getWorkflow(workflowId)
  if (!rec) return { status: 404, body: workflowApiError('workflow_not_found', `no such workflow: ${workflowId}`) }
  // Blocked is non-terminal but must NOT be silently resumed → structured conflict.
  if (rec.status === 'blocked') return { status: 409, body: workflowApiError('workflow_state_conflict', 'workflow is blocked; explicit resume is not supported in v1') }
  try {
    await runtime.startWorkflow(workflowId) // idempotent: ready→running, running→coalesce, terminal→return
    const view = await buildSnapshotView(store, workflowId)
    return { status: 200, body: view }
  } catch (err) { const m = mapThrownError(err); return { status: m.status, body: m.error } }
}

export async function getWorkflowController(store: ControlStore, workflowId: string): Promise<ControllerResult> {
  try {
    const view = await buildSnapshotView(store, workflowId)
    if (!view) return { status: 404, body: workflowApiError('workflow_not_found', `no such workflow: ${workflowId}`) }
    return { status: 200, body: view }
  } catch (err) { const m = mapThrownError(err); return { status: m.status, body: m.error } }
}

export async function cancelWorkflowController(runtime: WorkflowRuntime, store: ControlStore, workflowId: string): Promise<ControllerResult> {
  const rec = await store.getWorkflow(workflowId)
  if (!rec) return { status: 404, body: workflowApiError('workflow_not_found', `no such workflow: ${workflowId}`) }
  try {
    await runtime.cancelWorkflow(workflowId) // idempotent; already-terminal stays terminal
    const view = await buildSnapshotView(store, workflowId)
    return { status: 200, body: view }
  } catch (err) { const m = mapThrownError(err); return { status: m.status, body: m.error } }
}

/** The runtime exposes its snapshot via getWorkflowSnapshot; project it fully. */
async function buildSnapshotViewFromRuntime(runtime: WorkflowRuntime, workflowId: string): Promise<Record<string, unknown> | null> {
  const snap = await runtime.getWorkflowSnapshot(workflowId)
  if (!snap) return null
  return toWorkflowSnapshotView(snap.workflow, snap.context, snap.context_revision, [], null)
}
