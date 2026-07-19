/**
 * REST controllers for the Conversational Workflow Builder. Pure request→response
 * mappers over WorkflowBuilderService; auth, routing and header emission live in the
 * gateway. Bodies never expose secrets — sessions/messages carry only user text +
 * bounded, safe draft projections. The builder NEVER approves or starts a workflow.
 */
import type { WorkflowBuilderService, BuilderTurnResult, CreateSessionInput } from './service.js'
import { BuilderError } from './service.js'

export interface ControllerResult { status: number; body: unknown; headers?: Record<string, string> }

function err(code: string, message: string, status: number): ControllerResult {
  return { status, body: { error: true, code, message, ts: new Date().toISOString() } }
}
function mapError(e: unknown): ControllerResult {
  if (e instanceof BuilderError) return err(e.code, e.message, e.httpStatus)
  return err('internal_error', 'builder request failed', 500)
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const REPLAY_HEADERS = { 'idempotency-replayed': 'true' } as const

function turnBody(t: BuilderTurnResult): Record<string, unknown> {
  return { kind: t.kind, assistant_message: t.assistant_message, draft: t.draft, session: t.session, replayed: t.replayed }
}

/** POST /v1/workflow-builder/sessions */
export async function createBuilderSessionController(svc: WorkflowBuilderService, body: unknown): Promise<ControllerResult> {
  if (!isObj(body)) return err('invalid_request', 'body must be a JSON object', 400)
  if (typeof body.compiler_agent !== 'string') return err('invalid_request', '`compiler_agent` (string) is required', 400)
  // Creating a session WITH an initial prompt runs a compiler turn ⇒ require the
  // canonical idempotency key at the controller boundary too (rejected before any write).
  if (typeof body.initial_request === 'string' && body.initial_request.trim() !== '' && (typeof body.idempotency_key !== 'string' || body.idempotency_key.trim() === '')) {
    return err('builder_idempotency_key_required', 'an `idempotency_key` is required when creating a session with an initial prompt', 400)
  }
  const input: CreateSessionInput = {
    compiler_agent: body.compiler_agent,
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.initial_request === 'string' ? { initial_request: body.initial_request } : {}),
    ...(typeof body.compiler_node_id === 'string' ? { compiler_node_id: body.compiler_node_id } : {}),
    ...(typeof body.source_workflow_id === 'string' ? { source_workflow_id: body.source_workflow_id } : {}),
    ...(typeof body.idempotency_key === 'string' ? { idempotency_key: body.idempotency_key } : {}),
  }
  try {
    const r = await svc.createSession(input)
    return { status: 201, body: { session: r.session, messages: r.messages, ...(r.initial_turn ? { initial_turn: turnBody(r.initial_turn) } : {}) } }
  } catch (e) { return mapError(e) }
}

/** GET /v1/workflow-builder/sessions/:id */
export async function getBuilderSessionController(svc: WorkflowBuilderService, id: string): Promise<ControllerResult> {
  try { const r = await svc.getSession(id); return { status: 200, body: r } } catch (e) { return mapError(e) }
}

/** GET /v1/workflow-builder/sessions */
export async function listBuilderSessionsController(svc: WorkflowBuilderService, query: { limit?: number; offset?: number }): Promise<ControllerResult> {
  try { const sessions = await svc.listSessions(query); return { status: 200, body: { sessions, count: sessions.length } } } catch (e) { return mapError(e) }
}

/** POST /v1/workflow-builder/sessions/:id/messages */
export async function sendBuilderMessageController(svc: WorkflowBuilderService, id: string, body: unknown): Promise<ControllerResult> {
  if (!isObj(body)) return err('invalid_request', 'body must be a JSON object', 400)
  if (typeof body.content !== 'string') return err('invalid_request', '`content` (string) is required', 400)
  if (body.expected_revision !== undefined && (typeof body.expected_revision !== 'number' || !Number.isInteger(body.expected_revision))) return err('invalid_request', '`expected_revision` must be an integer', 400)
  // Every builder message runs the compiler ⇒ the canonical idempotency key is REQUIRED
  // (it is the durable turn key). Reject a missing/empty key before any persistent write.
  if (typeof body.idempotency_key !== 'string' || body.idempotency_key.trim() === '') return err('builder_idempotency_key_required', 'the canonical `idempotency_key` is required for every builder message (it is the durable turn key used for crash recovery)', 400)
  try {
    const t = await svc.sendMessage(id, {
      content: body.content,
      ...(typeof body.expected_revision === 'number' ? { expected_revision: body.expected_revision } : {}),
      ...(typeof body.idempotency_key === 'string' ? { idempotency_key: body.idempotency_key } : {}),
    })
    return { status: 200, body: turnBody(t), ...(t.replayed ? { headers: REPLAY_HEADERS } : {}) }
  } catch (e) { return mapError(e) }
}

/** POST /v1/workflow-builder/sessions/:id/archive */
export async function archiveBuilderSessionController(svc: WorkflowBuilderService, id: string): Promise<ControllerResult> {
  try { const session = await svc.archiveSession(id); return { status: 200, body: { session } } } catch (e) { return mapError(e) }
}
