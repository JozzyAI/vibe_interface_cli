/**
 * WorkflowCompiler — the internal natural-language → validated WorkflowSpec compiler.
 *
 * It runs a compiler model through the durable Agent Task path, treats the
 * AgentTaskResult as the ONLY authoritative output, then RE-VALIDATES, canonicalizes,
 * previews, and persists an IMMUTABLE WorkflowDraft. Approval binds to the exact
 * spec / policy-summary / inventory hashes and materializes exactly one `ready`
 * workflow (never started). The compiler never calls the relay / Node / provider
 * adapters / WorkflowRuntime directly — only the ControlStore + injected clients.
 */
import crypto from 'crypto'
import type { ControlStore, WorkflowEventDraft } from '../../control/store.js'
import type { WorkflowDraftRecord } from '../../control/records.js'
import { WORKFLOW_EVENT_CONTRACT_VERSION, type WorkflowSpec } from '../contract.js'
import { canonicalHash, canonicalJson } from './canonical.js'
import { parseCompilerResult } from './contract.js'
import { validateReady, DEFAULT_SYSTEM_POLICY, type SystemPolicy } from './validate.js'
import { buildPreview, buildPolicySummary } from './preview.js'
import { findPlacement, type InventoryProvider, type Inventory } from './inventory.js'
import type { CompilerModelClient } from './model-client.js'

export interface CompileRequest {
  nl_request: string
  constraints?: Record<string, unknown>
  /** The compiler MODEL placement (independent of the generated roles). */
  compiler_agent: string
  compiler_node_id?: string
  /** OPTIONAL bounded compile-operation idempotency key. Same key + same normalized
   *  request/constraints returns the existing draft/task (no re-snapshot); same key +
   *  a changed request/constraints → idempotency_conflict. Omitted → a NEW compile
   *  operation each call (NO retry deduplication). */
  idempotency_key?: string
}

/** The compiler task's enforceable minimum-capability profile — enforced by the
 *  Node/provider, never by prompt text. No workspace write, no git push/deploy, no
 *  secret access, no external side effects; network is disabled (v1 tasks have none). */
export const COMPILER_CAPABILITY_PROFILE = { permission_mode: 'default' as const, workspace_write: false, git_push: false, deploy: false, secret_access: false, external_side_effects: false, network: false }
const SAFE_IDEM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export class CompilerError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = 'CompilerError' } }

export interface WorkflowCompilerOptions {
  store: ControlStore
  model: CompilerModelClient
  inventory: InventoryProvider
  policy?: SystemPolicy
}

const MAX_REQUEST_BYTES = 16 * 1024

export class WorkflowCompiler {
  private readonly store: ControlStore
  private readonly model: CompilerModelClient
  private readonly inventoryProvider: InventoryProvider
  private readonly policy: SystemPolicy
  constructor(opts: WorkflowCompilerOptions) {
    this.store = opts.store; this.model = opts.model; this.inventoryProvider = opts.inventory; this.policy = opts.policy ?? DEFAULT_SYSTEM_POLICY
  }

  /** Compile a natural-language request into an immutable WorkflowDraft. Idempotent:
   *  the SAME (request, constraints, inventory) returns the same draft and never
   *  creates a second compiler task, draft, or workflow. */
  async compile(req: CompileRequest): Promise<WorkflowDraftRecord> {
    if (typeof req.nl_request !== 'string' || req.nl_request.trim() === '' || Buffer.byteLength(req.nl_request, 'utf8') > MAX_REQUEST_BYTES) throw new CompilerError('invalid_request', 'nl_request must be a non-empty bounded string')
    const constraints = req.constraints ?? {}
    // Request identity = NORMALIZED request + constraints ONLY (NO volatile inventory
    // fields like observed_at). This is what a retry must match.
    const requestFingerprint = canonicalHash({ request: req.nl_request.trim(), constraints })

    const callerKey = req.idempotency_key
    if (callerKey !== undefined && !SAFE_IDEM_KEY_RE.test(callerKey)) throw new CompilerError('invalid_request', 'idempotency_key must be a bounded safe identifier')
    // Keyed → deterministic draft id (a retry resolves the SAME operation); unkeyed →
    // a fresh operation each call (no dedup).
    const draftId = callerKey !== undefined ? 'wd_' + crypto.createHash('sha256').update('key:' + callerKey).digest('hex').slice(0, 24) : 'wd_' + crypto.randomBytes(12).toString('hex')

    // If a keyed operation already exists: a matching request returns it (NO re-snapshot);
    // a changed request/constraints fails closed with idempotency_conflict.
    if (callerKey !== undefined) {
      const existing = await this.store.getDraft(draftId)
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) throw new CompilerError('idempotency_conflict', 'idempotency_key was used with a different request/constraints')
        if (existing.compiler_status !== 'pending') return existing // finalized (idempotent)
        return this.runCompile(existing, req) // resume using the ORIGINAL persisted inventory
      }
    }

    // First creation: capture EXACTLY ONE inventory snapshot, persisted on the draft.
    const inventory = await this.inventoryProvider.snapshot()
    const { draft } = await this.store.createDraft({ draft_id: draftId, idempotency_key: callerKey ?? null, request_fingerprint: requestFingerprint, constraints, inventory_snapshot: inventory, inventory_hash: canonicalHash(inventory) })
    if (draft.compiler_status !== 'pending') return draft // a concurrent create won → idempotent
    return this.runCompile(draft, req)
  }

  /** Run/resume the compile for a PENDING draft using its ORIGINAL persisted inventory
   *  (a retry never re-snapshots). Enforces the compiler capability profile, runs the
   *  model over the durable task path, then re-validates + finalizes. */
  private async runCompile(draft: WorkflowDraftRecord, req: CompileRequest): Promise<WorkflowDraftRecord> {
    const draftId = draft.draft_id
    const inventory = (draft.inventory_snapshot ?? { agents: [], observed_at: '' }) as Inventory
    const constraints = (draft.constraints ?? {}) as Record<string, unknown>

    // Compiler PERMISSION enforcement (Gate 2): the compiler task must run with an
    // enforceable minimum-capability profile. Verify the placement can enforce
    // permission_mode 'default' from Node/provider capabilities — else FAIL CLOSED
    // BEFORE any task is created (no silent downgrade).
    const placement = findPlacement(inventory, req.compiler_agent, req.compiler_node_id)
    if (!placement || !placement.permission_modes.includes('default')) {
      return this.finalizeInvalid(draftId, 'impossible', ['compiler backend cannot enforce the minimum-capability profile (permission_mode "default" unsupported)'])
    }
    const capability = { ...COMPILER_CAPABILITY_PROFILE, agent: req.compiler_agent, node_id: req.compiler_node_id ?? null, enforced_by: 'node' as const }

    // Run the compiler model through the durable Agent Task path (idempotent task keyed
    // to the STABLE draft id — not the request/inventory).
    const prompt = buildCompilerPrompt(req.nl_request, constraints, inventory)
    const outcome = await this.model.compile({ prompt, agent: req.compiler_agent, node_id: req.compiler_node_id, permission_mode: 'default', idempotency_key: 'compile:' + draftId })
    await this.store.bindDraftCompilerTask(draftId, outcome.task_id, capability) // (crash boundary: task before bind)

    if (outcome.status !== 'available') return this.finalizeInvalid(draftId, 'impossible', ['compiler produced no authoritative result'])
    const parsed = parseCompilerResult(outcome.output_text)
    if (!parsed.ok) return this.finalizeInvalid(draftId, 'impossible', [`compiler output rejected: ${parsed.code}`])
    const result = parsed.value
    if (result.status !== 'ready') return this.finalizeNonReady(draftId, result.status, result.rationale, result.warnings, result.questions)

    // status:ready → the compiler LLM is NOT authoritative; re-validate everything.
    const val = validateReady(result.workflow_spec, result.input_values, inventory, this.policy)
    if (!val.ok) return this.store.finalizeDraft(draftId, { compiler_status: 'ready', validation_status: 'invalid', rationale: result.rationale, warnings: [...result.warnings, ...val.issues.map((i) => `${i.code}${i.path ? ' @ ' + i.path : ''}`)].slice(0, 100), questions: result.questions })

    const spec = val.spec
    const policySummary = buildPolicySummary(spec)
    const preview = buildPreview(spec)
    return this.store.finalizeDraft(draftId, {
      compiler_status: 'ready', validation_status: 'valid',
      spec, input_values: val.input_values,
      spec_hash: canonicalHash(spec), policy_summary: policySummary, policy_summary_hash: canonicalHash(policySummary),
      preview, rationale: result.rationale, warnings: result.warnings, questions: result.questions,
    })
  }

  private async finalizeInvalid(draftId: string, status: string, warnings: string[]): Promise<WorkflowDraftRecord> {
    return this.store.finalizeDraft(draftId, { compiler_status: status, validation_status: 'invalid', warnings })
  }
  private async finalizeNonReady(draftId: string, status: string, rationale: unknown, warnings: string[], questions: string[]): Promise<WorkflowDraftRecord> {
    return this.store.finalizeDraft(draftId, { compiler_status: status, validation_status: 'invalid', rationale, warnings, questions })
  }

  /** Get a draft (or null). */
  async getDraft(draftId: string): Promise<WorkflowDraftRecord | null> { return this.store.getDraft(draftId) }

  /**
   * Approve a `ready` + `valid` draft by its EXACT inspected spec_hash and materialize
   * exactly one `ready` workflow (never started). Idempotent for the same hashes; a
   * hash mismatch fails closed. Any Agent/Node/permission/limit/route/policy change
   * would have produced a different draft (and hash), which cannot approve this one.
   */
  async approve(draftId: string, inspectedSpecHash: string): Promise<{ draft: WorkflowDraftRecord; workflow_id: string }> {
    const draft = await this.store.getDraft(draftId)
    if (!draft) throw new CompilerError('draft_not_found', `no such draft: ${draftId}`)
    if (draft.materialized_workflow_id) {
      // idempotent: already materialized — the same hash returns it, a different one conflicts.
      if (draft.spec_hash !== inspectedSpecHash) throw new CompilerError('approval_hash_conflict', 'spec_hash does not match the approved draft')
      return { draft, workflow_id: draft.materialized_workflow_id }
    }
    if (draft.compiler_status !== 'ready' || draft.validation_status !== 'valid' || !draft.spec_hash) throw new CompilerError('draft_not_approvable', 'draft is not a validated ready draft')
    if (inspectedSpecHash !== draft.spec_hash) throw new CompilerError('approval_hash_conflict', 'inspected spec_hash does not match the draft')

    // Materialize with a DETERMINISTIC workflow id (idempotent create — a crash/retry
    // never creates a second workflow). Never started.
    const workflowId = 'wf_' + crypto.createHash('sha256').update('materialize:' + draftId).digest('hex').slice(0, 18)
    await this.materializeWorkflow(workflowId, draft.spec as WorkflowSpec, (draft.input_values ?? {}) as Record<string, unknown>)
    const updated = await this.store.approveDraftWithWorkflow(draftId, workflowId)
    return { draft: updated, workflow_id: workflowId }
  }

  /** Persist a `ready` workflow directly (bypassing the runtime) with a fixed id —
   *  idempotent: an existing id (a crash/retry) is treated as already materialized. */
  private async materializeWorkflow(workflowId: string, spec: WorkflowSpec, inputValues: Record<string, unknown>): Promise<void> {
    if (await this.store.getWorkflow(workflowId)) return // already materialized
    const ts = new Date().toISOString(); const CV = WORKFLOW_EVENT_CONTRACT_VERSION
    const objective = typeof inputValues.objective === 'string' ? inputValues.objective : (spec.description ?? spec.name)
    try {
      await this.store.createWorkflowWithLifecycleEvents(
        { workflow_id: workflowId, spec_version: spec.version, workflow_name: spec.name, spec, input_values: inputValues },
        { objective: String(objective).slice(0, 4096), current_round: 1 },
        { event_type: 'workflow.created', ts, payload: { name: spec.name, source: 'compiler' }, contract_version: CV } as WorkflowEventDraft,
        { event_type: 'workflow.validated', ts, payload: {}, contract_version: CV } as WorkflowEventDraft,
      )
    } catch (err) {
      // A concurrent/retried materialize already created it → idempotent success.
      if (await this.store.getWorkflow(workflowId)) return
      throw err
    }
  }
}

/** A deterministic, bounded compiler prompt. The nl request/constraints are DATA; the
 *  inventory is a safe snapshot. Never logged. */
function buildCompilerPrompt(nlRequest: string, constraints: Record<string, unknown>, inventory: Inventory): string {
  return [
    'You are a Workflow Compiler. Output EXACTLY ONE JSON object and nothing else (no prose, no markdown).',
    'The object must match: { "schema_version":"1", "status":"ready|needs_input|impossible|policy_denied", "workflow_spec":{}, "input_values":{}, "rationale":{}, "questions":[], "warnings":[] }.',
    'Assign roles to agents/nodes ONLY from the inventory. Do not invent agents. A completable workflow ($complete route) MUST include a completion_policy. Never include secrets or credentials.',
    'INVENTORY:', canonicalJson(inventory),
    'CONSTRAINTS:', canonicalJson(constraints),
    'REQUEST:', nlRequest,
  ].join('\n')
}
