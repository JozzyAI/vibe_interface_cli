/**
 * REST controllers for the Workflow Compiler — thin handlers over {@link WorkflowCompiler}.
 * Compile does not approve; approve does not start (starting still uses the existing
 * workflow start action). Projections are bounded and never expose the raw request,
 * prompt, tokens, or credentials.
 */
import { WorkflowCompiler, CompilerError, type CompileRequest } from './compiler.js'
import type { WorkflowDraftRecord } from '../../control/records.js'

export interface ControllerResult { status: number; body: unknown }

function err(code: string, message: string, status: number): ControllerResult {
  return { status, body: { error: true, code, message, ts: new Date().toISOString() } }
}
function mapCompilerError(e: unknown): ControllerResult {
  if (e instanceof CompilerError) {
    const status = e.code === 'draft_not_found' ? 404 : e.code === 'approval_hash_conflict' ? 409 : e.code === 'idempotency_conflict' ? 409 : e.code === 'draft_not_approvable' ? 409 : e.code === 'invalid_request' ? 400 : 500
    return err(e.code, e.message, status)
  }
  return err('internal_error', 'internal error', 500)
}

/** A bounded, safe projection of a draft (no raw request/prompt/secrets). */
export function toDraftView(d: WorkflowDraftRecord): Record<string, unknown> {
  return {
    draft_id: d.draft_id,
    compiler_task_id: d.compiler_task_id,
    compiler_capability: d.compiler_capability,
    compiler_status: d.compiler_status,
    validation_status: d.validation_status,
    approval_status: d.approval_status,
    inventory_hash: d.inventory_hash,
    spec_hash: d.spec_hash,
    policy_summary_hash: d.policy_summary_hash,
    workflow_spec: d.spec,
    input_values: d.input_values,
    policy_summary: d.policy_summary,
    preview: d.preview,
    rationale: d.rationale,
    warnings: d.warnings ?? [],
    questions: d.questions ?? [],
    materialized_workflow_id: d.materialized_workflow_id,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }
}

export async function compileWorkflowController(compiler: WorkflowCompiler, body: unknown): Promise<ControllerResult> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return err('invalid_request', 'body must be a JSON object', 400)
  const b = body as Record<string, unknown>
  if (typeof b.nl_request !== 'string') return err('invalid_request', '`nl_request` (string) is required', 400)
  if (b.constraints !== undefined && (typeof b.constraints !== 'object' || b.constraints === null || Array.isArray(b.constraints))) return err('invalid_request', '`constraints` must be an object', 400)
  if (typeof b.compiler_agent !== 'string' || b.compiler_agent.trim() === '') return err('invalid_request', '`compiler_agent` (string) is required', 400)
  if (b.idempotency_key !== undefined && typeof b.idempotency_key !== 'string') return err('invalid_request', '`idempotency_key` must be a string', 400)
  const req: CompileRequest = { nl_request: b.nl_request, constraints: b.constraints as Record<string, unknown> | undefined, compiler_agent: b.compiler_agent, ...(typeof b.compiler_node_id === 'string' ? { compiler_node_id: b.compiler_node_id } : {}), ...(typeof b.idempotency_key === 'string' ? { idempotency_key: b.idempotency_key } : {}) }
  try { const draft = await compiler.compile(req); return { status: 201, body: toDraftView(draft) } }
  catch (e) { return mapCompilerError(e) }
}

export async function getWorkflowDraftController(compiler: WorkflowCompiler, draftId: string): Promise<ControllerResult> {
  try { const d = await compiler.getDraft(draftId); if (!d) return err('draft_not_found', `no such draft: ${draftId}`, 404); return { status: 200, body: toDraftView(d) } }
  catch (e) { return mapCompilerError(e) }
}

export async function approveWorkflowDraftController(compiler: WorkflowCompiler, draftId: string, body: unknown): Promise<ControllerResult> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return err('invalid_request', 'body must be a JSON object', 400)
  const b = body as Record<string, unknown>
  if (typeof b.spec_hash !== 'string' || b.spec_hash.trim() === '') return err('invalid_request', '`spec_hash` (the inspected hash) is required', 400)
  try {
    const { draft, workflow_id } = await compiler.approve(draftId, b.spec_hash)
    return { status: 200, body: { ...toDraftView(draft), workflow_id, note: 'a ready workflow was created — it is NOT started; call vibe_start_workflow to begin' } }
  } catch (e) { return mapCompilerError(e) }
}
