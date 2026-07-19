/**
 * WorkflowBuilderService — the persistent conversational layer OVER the existing
 * WorkflowCompiler. It owns builder sessions + an append-only message log and turns
 * each natural-language message into a compile of the SAME compiler pipeline (it never
 * reimplements compilation, defines a second spec format, bypasses inventory/validation,
 * approves, or starts anything). Every turn:
 *   1. appends the user message durably (BEFORE compiling),
 *   2. compiles with { new message + prior conversation + current draft + inventory },
 *   3. atomically appends the assistant reply AND advances the current-draft pointer +
 *      revision (one transaction ⇒ no orphan assistant without its draft update).
 * Optimistic concurrency (expected_revision) and turn idempotency (turn_key) are
 * enforced by the store. The builder is provider-agnostic: WHICH compiler agent/node to
 * use is caller-supplied routing data captured on the session, never hardcoded here.
 */
import crypto from 'crypto'
import type { ControlStore } from '../../control/store.js'
import { ControlStoreError, type WorkflowBuilderSessionRecord, type WorkflowBuilderMessageRecord, type WorkflowBuilderSessionSummary, type WorkflowDraftRecord } from '../../control/records.js'

/** The compiler surface the builder depends on — satisfied by the existing
 *  WorkflowCompiler. Kept narrow so the builder never reaches into compiler internals. */
export interface BuilderCompiler {
  compile(req: { nl_request: string; constraints?: Record<string, unknown>; compiler_agent: string; compiler_node_id?: string; idempotency_key?: string }): Promise<WorkflowDraftRecord>
  getDraft(draftId: string): Promise<WorkflowDraftRecord | null>
}

/** How a compiled draft resolves for the conversation. Explicit — never a fake spec. */
export type BuilderTurnKind = 'ready_for_review' | 'draft_updated' | 'clarification_required' | 'compile_failed'

export class BuilderError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus: number) { super(message); this.name = 'BuilderError' }
}

const SAFE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_CONTENT_BYTES = 32 * 1024
const MAX_HISTORY = 20

/** A bounded, safe projection of a draft for the conversational response. */
export interface BuilderDraftView {
  draft_id: string
  compiler_status: string
  validation_status: string
  approval_status: string
  spec_hash: string | null
  questions: unknown[]
  warnings: unknown[]
  preview: unknown
  materialized_workflow_id: string | null
}

export interface BuilderTurnResult {
  session: WorkflowBuilderSessionRecord
  assistant_message: WorkflowBuilderMessageRecord
  kind: BuilderTurnKind
  draft: BuilderDraftView | null
  replayed: boolean
}

/** Classify a compiled draft. Precedence: a validated ready spec wins; then an
 *  explicit needs-input; then any hard failure/invalid; else a general update. */
export function classifyDraft(d: WorkflowDraftRecord): BuilderTurnKind {
  if (d.compiler_status === 'ready' && d.validation_status === 'valid' && d.spec_hash) return 'ready_for_review'
  if (d.compiler_status === 'needs_input') return 'clarification_required'
  if (d.compiler_status === 'impossible' || d.compiler_status === 'policy_denied' || d.validation_status === 'invalid') return 'compile_failed'
  return 'draft_updated'
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function draftView(d: WorkflowDraftRecord): BuilderDraftView {
  return { draft_id: d.draft_id, compiler_status: d.compiler_status, validation_status: d.validation_status, approval_status: d.approval_status, spec_hash: d.spec_hash, questions: asArray(d.questions), warnings: asArray(d.warnings), preview: d.preview ?? null, materialized_workflow_id: d.materialized_workflow_id }
}

function assistantText(kind: BuilderTurnKind, d: WorkflowDraftRecord): string {
  const q = asArray(d.questions).filter((x): x is string => typeof x === 'string')
  const w = asArray(d.warnings).filter((x): x is string => typeof x === 'string')
  const name = d.spec && typeof d.spec === 'object' && typeof (d.spec as { name?: unknown }).name === 'string' ? (d.spec as { name: string }).name : null
  switch (kind) {
    case 'ready_for_review': return `The workflow${name ? ` "${name}"` : ''} is ready for review. Inspect the preview, then approve spec_hash ${d.spec_hash} to materialize it (nothing is started automatically).`
    case 'clarification_required': return q.length ? `I need a little more information before I can finish:\n- ${q.join('\n- ')}` : 'I need more information before I can compile this workflow.'
    case 'compile_failed': return w.length ? `I could not compile a valid workflow: ${w.slice(0, 5).join('; ')}` : 'I could not compile a valid workflow from that request.'
    case 'draft_updated': return `The draft was updated${name ? ` (${name})` : ''}.`
  }
}

function assistantMetadata(kind: BuilderTurnKind, d: WorkflowDraftRecord): Record<string, unknown> {
  const q = asArray(d.questions)
  return {
    kind,
    compiler_status: d.compiler_status,
    validation_status: d.validation_status,
    spec_hash: d.spec_hash ?? null,
    questions: q.slice(0, 50),
    // The missing concepts to resolve — persisted for clarification turns.
    missing: kind === 'clarification_required' ? q.slice(0, 50) : [],
    warnings: asArray(d.warnings).slice(0, 50),
  }
}

export interface CreateSessionInput {
  title?: string
  initial_request?: string
  compiler_agent: string
  compiler_node_id?: string
  source_workflow_id?: string
  idempotency_key?: string
}

export class WorkflowBuilderService {
  constructor(private readonly store: ControlStore, private readonly compiler: BuilderCompiler) {}

  async createSession(input: CreateSessionInput): Promise<{ session: WorkflowBuilderSessionRecord; messages: WorkflowBuilderMessageRecord[]; initial_turn: BuilderTurnResult | null }> {
    if (typeof input.compiler_agent !== 'string' || input.compiler_agent.trim() === '') throw new BuilderError('invalid_request', '`compiler_agent` (string) is required', 400)
    if (input.idempotency_key !== undefined && !SAFE_KEY_RE.test(input.idempotency_key)) throw new BuilderError('invalid_request', '`idempotency_key` must be a bounded safe identifier', 400)
    if (input.initial_request !== undefined && (typeof input.initial_request !== 'string' || Buffer.byteLength(input.initial_request, 'utf8') > MAX_CONTENT_BYTES)) throw new BuilderError('invalid_request', '`initial_request` must be a bounded string', 400)
    const hasPrompt = typeof input.initial_request === 'string' && input.initial_request.trim() !== ''
    // An initial-prompt create runs a compiler turn ⇒ it needs a stable operation key.
    // Reject BEFORE any session/turn state is written. Empty creation needs no key.
    if (hasPrompt && (input.idempotency_key === undefined || input.idempotency_key.trim() === '')) throw new BuilderError('builder_idempotency_key_required', 'an `idempotency_key` is required when creating a session with an initial prompt (it scopes the durable turn key of the initial compiler turn)', 400)
    const sessionId = input.idempotency_key ? 'bs_' + crypto.createHash('sha256').update('builder-session:' + input.idempotency_key).digest('hex').slice(0, 24) : 'bs_' + crypto.randomBytes(12).toString('hex')
    const title = (input.title && input.title.trim()) || deriveTitle(input.initial_request) || 'New workflow'
    const session = await this.store.createBuilderSession({ builder_session_id: sessionId, title, source_workflow_id: input.source_workflow_id ?? null, compiler_agent: input.compiler_agent, compiler_node_id: input.compiler_node_id ?? null })

    let initial_turn: BuilderTurnResult | null = null
    if (hasPrompt) {
      // Derive a STABLE, bounded, collision-resistant turn key for the initial turn from
      // the (required) session-create key — so the initial compiler turn is recoverable.
      const initKey = 'init_' + crypto.createHash('sha256').update('builder-init:' + input.idempotency_key).digest('hex').slice(0, 32)
      initial_turn = await this.sendMessage(sessionId, { content: input.initial_request!, expected_revision: session.revision, idempotency_key: initKey })
    }
    const fresh = (await this.store.getBuilderSession(sessionId))!
    return { session: fresh, messages: await this.store.listBuilderMessages(sessionId), initial_turn }
  }

  async getSession(id: string): Promise<{ session: WorkflowBuilderSessionRecord; messages: WorkflowBuilderMessageRecord[]; draft: BuilderDraftView | null; pending_turn: { since: string | null; awaiting_user_message_id: string | null } | null }> {
    const session = await this.store.getBuilderSession(id)
    if (!session) throw new BuilderError('builder_session_not_found', `no such builder session: ${id}`, 404)
    const messages = await this.store.listBuilderMessages(id)
    const draft = session.current_draft_id ? await this.compiler.getDraft(session.current_draft_id) : null
    // Sanitized processing state: expose THAT a turn is in flight (never internal keys),
    // so a reader after a crash sees pending rather than a silently-complete turn.
    const pending_turn = session.pending_turn_key != null
      ? { since: session.pending_turn_started_at, awaiting_user_message_id: messages.filter((m) => m.role === 'user' && m.turn_key === session.pending_turn_key).slice(-1)[0]?.message_id ?? null }
      : null
    return { session, messages, draft: draft ? draftView(draft) : null, pending_turn }
  }

  async listSessions(page?: { limit?: number; offset?: number }): Promise<WorkflowBuilderSessionSummary[]> {
    return this.store.listBuilderSessions(page)
  }

  async archiveSession(id: string): Promise<WorkflowBuilderSessionRecord> {
    const session = await this.store.getBuilderSession(id)
    if (!session) throw new BuilderError('builder_session_not_found', `no such builder session: ${id}`, 404)
    return this.store.archiveBuilderSession(id)
  }

  async sendMessage(id: string, input: { content: string; expected_revision?: number; idempotency_key?: string }): Promise<BuilderTurnResult> {
    if (typeof input.content !== 'string' || input.content.trim() === '' || Buffer.byteLength(input.content, 'utf8') > MAX_CONTENT_BYTES) throw new BuilderError('invalid_request', '`content` must be a non-empty bounded string', 400)
    // Every compiler-producing turn MUST have a stable durable turn key (used as the
    // pending/recovery marker). Reject a missing/empty key BEFORE any persistent write —
    // an unkeyed turn could crash mid-flight and leave an unresumable pending user message.
    if (input.idempotency_key === undefined || input.idempotency_key.trim() === '') throw new BuilderError('builder_idempotency_key_required', 'a stable `idempotency_key` is required for every builder message (it is the durable turn key used for crash recovery)', 400)
    if (!SAFE_KEY_RE.test(input.idempotency_key)) throw new BuilderError('invalid_request', '`idempotency_key` must be a bounded safe identifier', 400)
    const turnKey: string = input.idempotency_key

    const session = await this.store.getBuilderSession(id)
    if (!session) throw new BuilderError('builder_session_not_found', `no such builder session: ${id}`, 404)

    // Idempotent replay of a completed keyed turn — no writes, no second revision bump.
    if (turnKey != null) {
      const turn = await this.store.findBuilderTurn(id, turnKey)
      if (turn.assistant) {
        const meta = (turn.assistant.metadata ?? {}) as { kind?: BuilderTurnKind }
        const draft = turn.assistant.draft_id ? await this.compiler.getDraft(turn.assistant.draft_id) : null
        return { session, assistant_message: turn.assistant, kind: meta.kind ?? (draft ? classifyDraft(draft) : 'compile_failed'), draft: draft ? draftView(draft) : null, replayed: true }
      }
    }

    // A DIFFERENT turn cannot overtake an in-flight (pending) turn — only the same
    // turn_key may resume it. (A completed turn already replayed above.)
    if (session.pending_turn_key != null && session.pending_turn_key !== turnKey) {
      throw new BuilderError('builder_turn_in_progress', 'a turn is already in progress on this session; resume it with its turn_key or wait for it to complete', 409)
    }
    if (session.status !== 'active') throw new BuilderError('builder_session_not_active', `builder session is ${session.status}; it cannot accept new messages`, 409)
    if (!session.compiler_agent) throw new BuilderError('invalid_request', 'this builder session has no compiler agent configured', 400)
    if (input.expected_revision !== undefined && input.expected_revision !== session.revision) {
      throw new BuilderError('builder_revision_conflict', `session revision is ${session.revision}, not the expected ${input.expected_revision}`, 409)
    }
    const expectedRevision = input.expected_revision ?? session.revision

    // 1) Append the user message durably BEFORE compiling (idempotent on turn_key). This
    //    also arms the durable pending-turn marker atomically. A racing DIFFERENT turn is
    //    rejected here (atomic backstop for the check above).
    let appended: Awaited<ReturnType<ControlStore['appendBuilderUserMessage']>>
    try {
      appended = await this.store.appendBuilderUserMessage(id, { content: input.content, turn_key: turnKey })
    } catch (err) {
      if (err instanceof ControlStoreError && err.code === 'builder_turn_in_progress') throw new BuilderError('builder_turn_in_progress', err.message, 409)
      if (err instanceof ControlStoreError && err.code === 'invalid_transition') throw new BuilderError('builder_session_not_active', err.message, 409)
      throw err
    }
    const effectiveContent = appended.message.content // anchor the turn to the first-seen content

    // 2) Build the compile CONTEXT: prior conversation + current draft spec + inventory
    //    (the compiler snapshots trusted inventory itself). Never a second spec format.
    const priorMessages = (await this.store.listBuilderMessages(id)).filter((m) => m.message_id !== appended.message.message_id)
    const currentDraft = session.current_draft_id ? await this.compiler.getDraft(session.current_draft_id) : null
    const constraints: Record<string, unknown> = {
      builder_context: {
        history: priorMessages.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
        current_spec: currentDraft && currentDraft.validation_status === 'valid' ? currentDraft.spec : null,
        current_spec_hash: currentDraft?.spec_hash ?? null,
      },
    }
    // The turn key is always present (enforced above) ⇒ a STABLE compiler idempotency
    // key, so a resume/retry resolves the SAME draft rather than compiling anew.
    const compileKey = 'builder:' + id + ':' + turnKey

    // 3) Compile through the existing pipeline.
    let draft: WorkflowDraftRecord
    try {
      draft = await this.compiler.compile({ nl_request: effectiveContent, constraints, compiler_agent: session.compiler_agent, compiler_node_id: session.compiler_node_id ?? undefined, idempotency_key: compileKey })
    } catch (err) {
      // An INFRASTRUCTURE compile error (not a semantic 'impossible' draft, which the
      // compiler returns as a finalized draft) — surface it durably without corrupting
      // the current draft, and never leave an orphan assistant.
      const msg = err instanceof Error ? err.message : 'compile failed'
      const assistant = await this.store.completeBuilderTurn(id, expectedRevision, { assistant: { content: `Compilation failed: ${msg}`, draft_id: null, spec_hash: null, metadata: { kind: 'compile_failed', error: msg }, turn_key: turnKey }, current_draft_id: session.current_draft_id, current_spec_hash: session.current_spec_hash })
      return { session: assistant.session, assistant_message: assistant.message, kind: 'compile_failed', draft: null, replayed: assistant.replay }
    }

    const kind = classifyDraft(draft)
    // Advance the current pointer ONLY to a validated draft; a clarification / failed
    // compile PRESERVES the last good current draft (never corrupts it).
    const advance = draft.validation_status === 'valid' && !!draft.spec_hash
    const newCurrentDraftId = advance ? draft.draft_id : session.current_draft_id
    const newCurrentSpecHash = advance ? (draft.spec_hash ?? null) : session.current_spec_hash

    try {
      const done = await this.store.completeBuilderTurn(id, expectedRevision, {
        assistant: { content: assistantText(kind, draft), draft_id: draft.draft_id, spec_hash: draft.spec_hash ?? null, metadata: assistantMetadata(kind, draft), turn_key: turnKey },
        current_draft_id: newCurrentDraftId, current_spec_hash: newCurrentSpecHash,
      })
      return { session: done.session, assistant_message: done.message, kind, draft: draftView(draft), replayed: done.replay }
    } catch (err) {
      if (err instanceof ControlStoreError && err.code === 'builder_revision_conflict') throw new BuilderError('builder_revision_conflict', err.message, 409)
      if (err instanceof ControlStoreError && err.code === 'invalid_transition') throw new BuilderError('builder_session_not_active', err.message, 409)
      throw err
    }
  }
}

function deriveTitle(req: string | undefined): string | null {
  if (!req) return null
  const firstLine = req.split('\n').map((l) => l.trim()).find((l) => l !== '')
  return firstLine ? firstLine.slice(0, 80) : null
}
