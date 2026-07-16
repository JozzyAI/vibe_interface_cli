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
  toWorkflowSummary, toWorkflowSnapshotView, reasonFromEvents, completionVerificationFromEvents,
  toHumanRequestView, parseAnswerBody, parseDecisionBody,
} from './api-contract.js'

export interface ControllerResult { status: number; body: unknown }

const END_STATES = new Set(['completed', 'failed', 'cancelled', 'blocked'])

/** Build the full durable snapshot view for a workflow, or null if unknown. */
async function buildSnapshotView(store: ControlStore, workflowId: string): Promise<Record<string, unknown> | null> {
  const snap = await store.getWorkflowSnapshot(workflowId)
  if (!snap) return null
  const steps = await store.listStepExecutions(workflowId)
  const rec = snap.workflow
  const events = END_STATES.has(rec.status) ? await store.listWorkflowEvents(workflowId) : null
  const reason = events ? reasonFromEvents(events) : null
  const completion = rec.status === 'completed' && events ? completionVerificationFromEvents(events) : null
  const leases = await store.listWorkspaceLeaseProjections(workflowId)
  return toWorkflowSnapshotView(rec, snap.context, snap.context_revision, steps, reason, leases, completion)
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

// ── human pause / approval operations ────────────────────────────────────────────

/** GET the request currently AWAITING a human (or `{ request: null }` when none). */
export async function getPendingRequestController(runtime: WorkflowRuntime, store: ControlStore, workflowId: string): Promise<ControllerResult> {
  const rec = await store.getWorkflow(workflowId)
  if (!rec) return { status: 404, body: workflowApiError('workflow_not_found', `no such workflow: ${workflowId}`) }
  try { const req = await runtime.getPendingRequest(workflowId); return { status: 200, body: { workflow_id: workflowId, status: rec.status, request: req ? toHumanRequestView(req) : null } } }
  catch (err) { const m = mapThrownError(err); return { status: m.status, body: m.error } }
}

/** Fetch a request and confirm it belongs to this workflow (else a sanitized 404). */
async function requireRequest(store: ControlStore, workflowId: string, requestId: string): Promise<{ ok: true } | { ok: false; result: ControllerResult }> {
  const rec = await store.getWorkflow(workflowId)
  if (!rec) return { ok: false, result: { status: 404, body: workflowApiError('workflow_not_found', `no such workflow: ${workflowId}`) } }
  const existing = await store.getHumanRequest(requestId)
  if (!existing || existing.workflow_id !== workflowId) return { ok: false, result: { status: 404, body: workflowApiError('human_request_not_found', 'no such pending request for this workflow') } }
  return { ok: true }
}

/** POST an input answer `{ request_id, value }` (idempotent; conflict → 409). */
export async function answerInputController(runtime: WorkflowRuntime, store: ControlStore, workflowId: string, body: unknown): Promise<ControllerResult> {
  const p = parseAnswerBody(body); if (!p.ok) return { status: 400, body: p.error }
  const guard = await requireRequest(store, workflowId, p.value.request_id); if (!guard.ok) return guard.result
  try { const r = await runtime.answerInput(p.value.request_id, p.value.value); return { status: 200, body: toHumanRequestView(r) } }
  catch (err) { const m = mapThrownError(err); return { status: m.status, body: m.error } }
}

/** POST an approval decision `{ request_id, approved }` (idempotent; conflict → 409). */
export async function decideApprovalController(runtime: WorkflowRuntime, store: ControlStore, workflowId: string, body: unknown): Promise<ControllerResult> {
  const p = parseDecisionBody(body); if (!p.ok) return { status: 400, body: p.error }
  const guard = await requireRequest(store, workflowId, p.value.request_id); if (!guard.ok) return guard.result
  try { const r = await runtime.decideApproval(p.value.request_id, p.value.approved); return { status: 200, body: toHumanRequestView(r) } }
  catch (err) { const m = mapThrownError(err); return { status: m.status, body: m.error } }
}

/** POST resume: continue a paused workflow from its checkpoint (idempotent). */
export async function resumeWorkflowController(runtime: WorkflowRuntime, store: ControlStore, workflowId: string): Promise<ControllerResult> {
  const rec = await store.getWorkflow(workflowId)
  if (!rec) return { status: 404, body: workflowApiError('workflow_not_found', `no such workflow: ${workflowId}`) }
  try { await runtime.resumeWorkflow(workflowId); return { status: 200, body: await buildSnapshotView(store, workflowId) } }
  catch (err) { const m = mapThrownError(err); return { status: m.status, body: m.error } }
}

/** The runtime exposes its snapshot via getWorkflowSnapshot; project it fully. */
async function buildSnapshotViewFromRuntime(runtime: WorkflowRuntime, workflowId: string): Promise<Record<string, unknown> | null> {
  const snap = await runtime.getWorkflowSnapshot(workflowId)
  if (!snap) return null
  return toWorkflowSnapshotView(snap.workflow, snap.context, snap.context_revision, [], null)
}
