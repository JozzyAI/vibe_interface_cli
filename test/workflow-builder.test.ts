/**
 * Conversational Workflow Builder — persistent sessions over the existing compiler.
 * Tests the WorkflowBuilderService + durable store (atomicity, idempotency, optimistic
 * concurrency, restart recovery, isolation) with a FAKE compiler that persists drafts
 * to the SAME control store exactly like the real WorkflowCompiler (so recovery is real).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { WorkflowBuilderService, BuilderError, type BuilderCompiler } from '../src/workflow/builder/service.js'
import { createBuilderSessionController, getBuilderSessionController, listBuilderSessionsController, sendBuilderMessageController, archiveBuilderSessionController } from '../src/workflow/builder/api.js'
import type { WorkflowDraftRecord } from '../src/control/records.js'

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-builder-')), 'control.sqlite')

type Outcome = Parameters<SqliteControlStore['finalizeDraft']>[1]
const ready = (name: string): Outcome => ({ compiler_status: 'ready', validation_status: 'valid', spec: { version: '1', name }, spec_hash: 'sh_' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 16), preview: { name }, input_values: {} })
const clar = (questions: string[]): Outcome => ({ compiler_status: 'needs_input', validation_status: 'invalid', questions })
const impossible = (warnings: string[]): Outcome => ({ compiler_status: 'impossible', validation_status: 'invalid', warnings })

/** A faithful mini-compiler: derives the SAME keyed draft id as the real compiler,
 *  persists drafts to the control store (so they survive restart + dedup by key), and
 *  yields scripted outcomes. Records every compile call for context assertions. */
class FakeCompiler implements BuilderCompiler {
  script: Outcome[] = []
  throwNext = false
  calls: Array<{ nl_request: string; constraints?: Record<string, unknown>; idempotency_key?: string }> = []
  constructor(private store: SqliteControlStore) {}
  private draftId(key: string): string { return 'wd_' + crypto.createHash('sha256').update('key:' + key).digest('hex').slice(0, 24) }
  async compile(req: { nl_request: string; constraints?: Record<string, unknown>; compiler_agent: string; compiler_node_id?: string; idempotency_key?: string }): Promise<WorkflowDraftRecord> {
    this.calls.push({ nl_request: req.nl_request, constraints: req.constraints, idempotency_key: req.idempotency_key })
    if (this.throwNext) { this.throwNext = false; throw new Error('compiler task unavailable') }
    const key = req.idempotency_key ?? crypto.randomBytes(8).toString('hex')
    const id = this.draftId(key)
    const { created } = await this.store.createDraft({ draft_id: id, idempotency_key: key, request_fingerprint: crypto.createHash('sha256').update(req.nl_request + JSON.stringify(req.constraints ?? {})).digest('hex'), constraints: req.constraints ?? {}, inventory_snapshot: { agents: [], observed_at: '' }, inventory_hash: 'ih' })
    if (!created) return (await this.store.getDraft(id))! // idempotent (same key → same draft)
    const outcome = this.script.shift() ?? ready('default')
    return this.store.finalizeDraft(id, outcome)
  }
  async getDraft(id: string): Promise<WorkflowDraftRecord | null> { return this.store.getDraft(id) }
}

function mk(dbPath = tmpDb()): { store: SqliteControlStore; fake: FakeCompiler; svc: WorkflowBuilderService; dbPath: string } {
  const store = openControlStore({ path: dbPath })
  const fake = new FakeCompiler(store)
  return { store, fake, svc: new WorkflowBuilderService(store, fake), dbPath }
}

// 1 ─────────────────────────────────────────────────────────────────────────
test('create empty session → one active session, revision 1, no messages, no draft', async () => {
  const { store, svc } = mk()
  const { session, messages, initial_turn } = await svc.createSession({ compiler_agent: 'mock' })
  assert.equal(session.status, 'active'); assert.equal(session.revision, 1)
  assert.equal(session.current_draft_id, null); assert.equal(initial_turn, null)
  assert.equal(messages.length, 0)
  store.closeSync()
})

// 2 ─────────────────────────────────────────────────────────────────────────
test('create with initial prompt → user + assistant message + draft persisted', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('slugify')]
  const { session, messages, initial_turn } = await svc.createSession({ compiler_agent: 'mock', initial_request: 'build a slugify workflow', idempotency_key: 'c2' })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user'); assert.equal(messages[1].role, 'assistant')
  assert.equal(initial_turn!.kind, 'ready_for_review')
  assert.equal(session.revision, 2)
  assert.ok(session.current_draft_id); assert.ok(session.current_spec_hash)
  assert.equal((await store.getDraft(session.current_draft_id!))!.validation_status, 'valid')
  store.closeSync()
})

// 3 ─────────────────────────────────────────────────────────────────────────
test('clarification required → question + missing concepts persisted, current draft not corrupted', async () => {
  const { store, fake, svc } = mk(); fake.script = [clar(['Which repository?', 'Which node should run it?'])]
  const { session } = await svc.createSession({ compiler_agent: 'mock' })
  const t = await svc.sendMessage(session.builder_session_id, { content: 'make me something', expected_revision: 1, idempotency_key: 'm3' })
  assert.equal(t.kind, 'clarification_required')
  assert.match(t.assistant_message.content, /Which repository/)
  const meta = t.assistant_message.metadata as { missing?: string[] }
  assert.deepEqual(meta.missing, ['Which repository?', 'Which node should run it?'])
  assert.equal(t.session.current_spec_hash, null) // no valid draft to promote
  store.closeSync()
})

// 4 ─────────────────────────────────────────────────────────────────────────
test('follow-up answer → compiles WITH the current draft as context and updates it (not an unrelated draft)', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('v1'), ready('v2')]
  const { session } = await svc.createSession({ compiler_agent: 'mock', initial_request: 'first', idempotency_key: 'c4' })
  const d1 = session.current_draft_id!
  const t2 = await svc.sendMessage(session.builder_session_id, { content: 'now add tests', expected_revision: session.revision, idempotency_key: 'm4' })
  // the follow-up compile received the CURRENT draft spec as context
  const ctx = (fake.calls[1].constraints!.builder_context as { current_spec: unknown; current_spec_hash: unknown })
  assert.equal((ctx.current_spec as { name?: string }).name, 'v1')
  assert.notEqual(ctx.current_spec_hash, null)
  assert.notEqual(t2.session.current_draft_id, d1) // advanced to the updated draft
  assert.equal(t2.kind, 'ready_for_review')
  store.closeSync()
})

// 5 ─────────────────────────────────────────────────────────────────────────
test('restart recovery → messages, revision and current draft preserved', async () => {
  const a = mk(); a.fake.script = [ready('persist')]
  const { session } = await a.svc.createSession({ compiler_agent: 'mock', initial_request: 'keep me', idempotency_key: 'c5' })
  const sid = session.builder_session_id; const rev = session.revision; const draftId = session.current_draft_id
  a.store.closeSync()
  // reopen the SAME database with a fresh store/service (Gateway restart)
  const b = mk(a.dbPath)
  const got = await b.svc.getSession(sid)
  assert.equal(got.session.revision, rev)
  assert.equal(got.session.current_draft_id, draftId)
  assert.equal(got.messages.length, 2)
  assert.ok(got.draft && got.draft.validation_status === 'valid')
  b.store.closeSync()
})

// 6 ─────────────────────────────────────────────────────────────────────────
test('duplicate idempotency key → exactly one turn and one revision increment', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('once')]
  const { session } = await svc.createSession({ compiler_agent: 'mock' })
  const first = await svc.sendMessage(session.builder_session_id, { content: 'do it', expected_revision: 1, idempotency_key: 'turn-1' })
  const second = await svc.sendMessage(session.builder_session_id, { content: 'do it', expected_revision: 1, idempotency_key: 'turn-1' })
  assert.equal(second.replayed, true)
  assert.equal(second.assistant_message.message_id, first.assistant_message.message_id) // same turn
  const msgs = await store.listBuilderMessages(session.builder_session_id)
  assert.equal(msgs.length, 2) // exactly one user + one assistant
  assert.equal((await store.getBuilderSession(session.builder_session_id))!.revision, 2) // incremented once
  assert.equal(fake.calls.length, 1) // compiler invoked once
  store.closeSync()
})

// 7 ─────────────────────────────────────────────────────────────────────────
test('stale expected_revision → builder_revision_conflict and NO partial writes', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('a'), ready('b')]
  const { session } = await svc.createSession({ compiler_agent: 'mock', initial_request: 'go', idempotency_key: 'c7' }) // revision → 2
  const before = await store.listBuilderMessages(session.builder_session_id)
  await assert.rejects(
    () => svc.sendMessage(session.builder_session_id, { content: 'stale', expected_revision: 1, idempotency_key: 'm7' }),
    (e: unknown) => e instanceof BuilderError && e.code === 'builder_revision_conflict' && e.httpStatus === 409,
  )
  const after = await store.listBuilderMessages(session.builder_session_id)
  assert.equal(after.length, before.length) // no user/assistant message written
  assert.equal((await store.getBuilderSession(session.builder_session_id))!.revision, 2) // unchanged
  store.closeSync()
})

// 8 ─────────────────────────────────────────────────────────────────────────
test('compiler failure → durable visible failure response without corrupting the current draft', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('good')]
  const { session } = await svc.createSession({ compiler_agent: 'mock', initial_request: 'first', idempotency_key: 'c8' })
  const goodDraft = session.current_draft_id
  fake.throwNext = true // next compile throws (infrastructure failure)
  const t = await svc.sendMessage(session.builder_session_id, { content: 'break it', expected_revision: session.revision, idempotency_key: 'm8a' })
  assert.equal(t.kind, 'compile_failed')
  assert.match(t.assistant_message.content, /failed/i) // visible durable failure
  assert.equal(t.session.current_draft_id, goodDraft) // last good draft preserved
  assert.equal(t.session.revision, 3) // the turn is still recorded
  // a SEMANTIC failure (impossible draft) also preserves the current draft
  fake.script = [impossible(['no suitable agent'])]
  const t2 = await svc.sendMessage(session.builder_session_id, { content: 'impossible ask', expected_revision: t.session.revision, idempotency_key: 'm8b' })
  assert.equal(t2.kind, 'compile_failed')
  assert.equal(t2.session.current_draft_id, goodDraft)
  store.closeSync()
})

// 9 ─────────────────────────────────────────────────────────────────────────
test('archive twice → idempotent', async () => {
  const { store, svc } = mk()
  const { session } = await svc.createSession({ compiler_agent: 'mock' })
  const a1 = await svc.archiveSession(session.builder_session_id)
  const a2 = await svc.archiveSession(session.builder_session_id)
  assert.equal(a1.status, 'archived'); assert.equal(a2.status, 'archived')
  assert.equal(a1.updated_at, a2.updated_at) // second archive is a no-op
  store.closeSync()
})

// 10 ────────────────────────────────────────────────────────────────────────
test('send message to an archived session → rejected', async () => {
  const { store, svc } = mk()
  const { session } = await svc.createSession({ compiler_agent: 'mock' })
  await svc.archiveSession(session.builder_session_id)
  await assert.rejects(
    () => svc.sendMessage(session.builder_session_id, { content: 'still there?', expected_revision: 1, idempotency_key: 'm10' }),
    (e: unknown) => e instanceof BuilderError && e.code === 'builder_session_not_active' && e.httpStatus === 409,
  )
  assert.equal((await store.listBuilderMessages(session.builder_session_id)).length, 0) // nothing written
  store.closeSync()
})

// 11 ────────────────────────────────────────────────────────────────────────
test('two sessions → drafts and histories remain isolated', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('alpha'), ready('beta')]
  const s1 = (await svc.createSession({ compiler_agent: 'mock', initial_request: 'alpha please', idempotency_key: 'c11a' })).session
  const s2 = (await svc.createSession({ compiler_agent: 'mock', initial_request: 'beta please', idempotency_key: 'c11b' })).session
  assert.notEqual(s1.builder_session_id, s2.builder_session_id)
  assert.notEqual(s1.current_draft_id, s2.current_draft_id)
  const m1 = await store.listBuilderMessages(s1.builder_session_id)
  const m2 = await store.listBuilderMessages(s2.builder_session_id)
  assert.ok(m1.every((m) => m.builder_session_id === s1.builder_session_id))
  assert.ok(m2.every((m) => m.builder_session_id === s2.builder_session_id))
  assert.match(m1[0].content, /alpha/); assert.match(m2[0].content, /beta/)
  const list = await svc.listSessions()
  assert.ok(list.length >= 2 && list.every((s) => typeof s.last_message_preview === 'string' || s.last_message_preview === null))
  store.closeSync()
})

// 12 ────────────────────────────────────────────────────────────────────────
test('builder never approves or starts: ready draft stays unapproved/unmaterialized; compiler draft store untouched', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('review-me')]
  const { session } = await svc.createSession({ compiler_agent: 'mock', initial_request: 'compile', idempotency_key: 'c12' })
  const draft = await store.getDraft(session.current_draft_id!)
  assert.equal(draft!.approval_status, 'unapproved')      // builder never approves
  assert.equal(draft!.materialized_workflow_id, null)     // builder never materializes/starts
  // existing draft store surface still behaves (create-or-return by id is unchanged)
  const again = await store.getDraft(session.current_draft_id!)
  assert.equal(again!.draft_id, draft!.draft_id)
  store.closeSync()
})

// ── REST controllers (request validation, error envelope, replay header) ─────
const errBody = (b: unknown) => b as { error?: boolean; code?: string; message?: string }

test('API: create requires compiler_agent; valid create returns 201 with session + messages', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('api')]
  const bad = await createBuilderSessionController(svc, { title: 'x' })
  assert.equal(bad.status, 400); assert.equal(errBody(bad.body).code, 'invalid_request')
  const ok = await createBuilderSessionController(svc, { compiler_agent: 'mock', initial_request: 'go', idempotency_key: 'a13' })
  assert.equal(ok.status, 201)
  const body = ok.body as { session: { revision: number }; messages: unknown[]; initial_turn?: { kind: string } }
  assert.equal(body.messages.length, 2); assert.equal(body.initial_turn!.kind, 'ready_for_review')
  store.closeSync()
})

test('API: send message validates content, returns turn body, and sets the replay header on a keyed replay', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('api2')]
  const s = (await svc.createSession({ compiler_agent: 'mock' })).session
  const bad = await sendBuilderMessageController(svc, s.builder_session_id, {})
  assert.equal(bad.status, 400)
  const first = await sendBuilderMessageController(svc, s.builder_session_id, { content: 'hi', expected_revision: 1, idempotency_key: 'k1' })
  assert.equal(first.status, 200)
  const fb = first.body as { kind: string; assistant_message: unknown; draft: unknown; session: unknown }
  assert.equal(fb.kind, 'ready_for_review'); assert.ok(fb.assistant_message && fb.session)
  assert.equal(first.headers, undefined)
  const replay = await sendBuilderMessageController(svc, s.builder_session_id, { content: 'hi', expected_revision: 1, idempotency_key: 'k1' })
  assert.equal(replay.headers?.['idempotency-replayed'], 'true')
  store.closeSync()
})

test('API: get unknown session → 404 envelope; list → { sessions, count }; archive → { session }', async () => {
  const { store, svc } = mk()
  const nf = await getBuilderSessionController(svc, 'bs_missing')
  assert.equal(nf.status, 404); assert.equal(errBody(nf.body).code, 'builder_session_not_found')
  const s = (await svc.createSession({ compiler_agent: 'mock', title: 'T' })).session
  const list = await listBuilderSessionsController(svc, {})
  const lb = list.body as { sessions: unknown[]; count: number }
  assert.equal(list.status, 200); assert.ok(lb.count >= 1)
  const arch = await archiveBuilderSessionController(svc, s.builder_session_id)
  assert.equal(arch.status, 200); assert.equal((arch.body as { session: { status: string } }).session.status, 'archived')
  store.closeSync()
})

// ── In-flight-turn crash recovery (user committed, completion not yet) ────────
// Simulate the authoritative crash window by committing ONLY the user side (as the
// service does before invoking the compiler), then driving recovery via the service.
async function crashMidTurn(store: SqliteControlStore, sid: string, turnKey: string, content = 'implement it'): Promise<void> {
  await store.appendBuilderUserMessage(sid, { content, turn_key: turnKey }) // user + pending marker committed; no assistant/draft/revision
}

test('recovery: crash after user append → same turn_key resumes to exactly one completed turn', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('resumed')]
  const s = (await svc.createSession({ compiler_agent: 'mock' })).session
  await crashMidTurn(store, s.builder_session_id, 'k1')
  // the pending turn is visible (not silently complete)
  const mid = await svc.getSession(s.builder_session_id)
  assert.ok(mid.pending_turn && mid.pending_turn.awaiting_user_message_id)
  assert.equal(mid.session.revision, 1) // not yet incremented
  // resubmit the same turn_key → resume
  const t = await svc.sendMessage(s.builder_session_id, { content: 'implement it', expected_revision: 1, idempotency_key: 'k1' })
  assert.equal(t.kind, 'ready_for_review')
  const msgs = await store.listBuilderMessages(s.builder_session_id)
  assert.equal(msgs.filter((m) => m.role === 'user').length, 1)      // no second user message
  assert.equal(msgs.filter((m) => m.role === 'assistant').length, 1) // exactly one assistant
  const fresh = (await store.getBuilderSession(s.builder_session_id))!
  assert.equal(fresh.revision, 2)                 // incremented exactly once
  assert.equal(fresh.pending_turn_key, null)      // pending cleared
  assert.ok(fresh.current_draft_id)               // exactly one draft adopted
  store.closeSync()
})

test('recovery: two concurrent retries of the pending turn → one assistant, one draft, one revision', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('concurrent')]
  const s = (await svc.createSession({ compiler_agent: 'mock' })).session
  await crashMidTurn(store, s.builder_session_id, 'kc')
  const [a, b] = await Promise.all([
    svc.sendMessage(s.builder_session_id, { content: 'implement it', expected_revision: 1, idempotency_key: 'kc' }),
    svc.sendMessage(s.builder_session_id, { content: 'implement it', expected_revision: 1, idempotency_key: 'kc' }),
  ])
  assert.equal(a.assistant_message.message_id, b.assistant_message.message_id) // same single turn
  const msgs = await store.listBuilderMessages(s.builder_session_id)
  assert.equal(msgs.filter((m) => m.role === 'user').length, 1)
  assert.equal(msgs.filter((m) => m.role === 'assistant').length, 1)
  assert.equal((await store.getBuilderSession(s.builder_session_id))!.revision, 2) // exactly one increment
  store.closeSync()
})

test('recovery: a DIFFERENT new turn while one is pending → builder_turn_in_progress (no overtake)', async () => {
  const { store, svc } = mk()
  const s = (await svc.createSession({ compiler_agent: 'mock' })).session
  await crashMidTurn(store, s.builder_session_id, 'k1')
  await assert.rejects(
    () => svc.sendMessage(s.builder_session_id, { content: 'something else', expected_revision: 1, idempotency_key: 'k2' }),
    (e: unknown) => e instanceof BuilderError && e.code === 'builder_turn_in_progress' && e.httpStatus === 409,
  )
  const msgs = await store.listBuilderMessages(s.builder_session_id)
  assert.equal(msgs.length, 1)                    // still only the pending user message
  assert.equal((await store.getBuilderSession(s.builder_session_id))!.pending_turn_key, 'k1') // untouched
  store.closeSync()
})

test('recovery: recovered compiler FAILURE → one compile_failed response, previous good draft preserved', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('good')]
  const s0 = (await svc.createSession({ compiler_agent: 'mock', initial_request: 'first', idempotency_key: 'c19' })).session
  const goodDraft = s0.current_draft_id                       // a prior good draft (revision 2)
  await crashMidTurn(store, s0.builder_session_id, 'kf')      // pending turn kf
  fake.throwNext = true                                       // recovery compile fails
  const t = await svc.sendMessage(s0.builder_session_id, { content: 'change it', expected_revision: 2, idempotency_key: 'kf' })
  assert.equal(t.kind, 'compile_failed')
  assert.match(t.assistant_message.content, /failed/i)
  const fresh = (await store.getBuilderSession(s0.builder_session_id))!
  assert.equal(fresh.current_draft_id, goodDraft)  // previous good draft preserved
  assert.equal(fresh.pending_turn_key, null)       // pending cleared (turn completed as failed)
  assert.equal(fresh.revision, 3)                  // the turn is recorded once
  assert.equal((await store.listBuilderMessages(s0.builder_session_id)).filter((m) => m.role === 'assistant' && m.turn_key === 'kf').length, 1)
  store.closeSync()
})

test('recovery: fully completed turn replays without invoking the compiler again', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('done')]
  const s = (await svc.createSession({ compiler_agent: 'mock' })).session
  await svc.sendMessage(s.builder_session_id, { content: 'do it', expected_revision: 1, idempotency_key: 'kd' }) // completes fully
  const callsAfterComplete = fake.calls.length
  const replay = await svc.sendMessage(s.builder_session_id, { content: 'do it', expected_revision: 1, idempotency_key: 'kd' })
  assert.equal(replay.replayed, true)
  assert.equal(fake.calls.length, callsAfterComplete)  // compiler NOT invoked again
  assert.equal((await store.listBuilderMessages(s.builder_session_id)).length, 2)
  assert.equal((await store.getBuilderSession(s.builder_session_id))!.revision, 2) // unchanged by replay
  store.closeSync()
})

// ── Keyed-turn contract: every compiler-producing turn requires a durable key ─
test('contract: a message WITHOUT an idempotency_key is rejected (service) before any write', async () => {
  const { store, svc } = mk()
  const s = (await svc.createSession({ compiler_agent: 'mock' })).session
  await assert.rejects(
    () => svc.sendMessage(s.builder_session_id, { content: 'no key here', expected_revision: 1 }),
    (e: unknown) => e instanceof BuilderError && e.code === 'builder_idempotency_key_required' && e.httpStatus === 400,
  )
  assert.equal((await store.listBuilderMessages(s.builder_session_id)).length, 0)  // no user message
  assert.equal((await store.getBuilderSession(s.builder_session_id))!.pending_turn_key, null) // no pending marker
  store.closeSync()
})

test('contract: a message WITHOUT an idempotency_key is rejected at the controller boundary', async () => {
  const { store, svc } = mk()
  const s = (await svc.createSession({ compiler_agent: 'mock' })).session
  const r = await sendBuilderMessageController(svc, s.builder_session_id, { content: 'x', expected_revision: 1 })
  assert.equal(r.status, 400)
  assert.equal((r.body as { code?: string }).code, 'builder_idempotency_key_required')
  assert.equal((await store.listBuilderMessages(s.builder_session_id)).length, 0)
  store.closeSync()
})

test('contract: initial-prompt session creation WITHOUT a key is rejected before any session/turn state', async () => {
  const { store, svc } = mk()
  await assert.rejects(
    () => svc.createSession({ compiler_agent: 'mock', initial_request: 'build me a thing' }),
    (e: unknown) => e instanceof BuilderError && e.code === 'builder_idempotency_key_required' && e.httpStatus === 400,
  )
  assert.equal((await svc.listSessions()).length, 0) // no session persisted
  // controller boundary too
  const r = await createBuilderSessionController(svc, { compiler_agent: 'mock', initial_request: 'build me a thing' })
  assert.equal(r.status, 400); assert.equal((r.body as { code?: string }).code, 'builder_idempotency_key_required')
  assert.equal((await svc.listSessions()).length, 0)
  store.closeSync()
})

test('contract: empty session creation needs no key and runs no compiler turn', async () => {
  const { store, fake, svc } = mk()
  const r = await createBuilderSessionController(svc, { compiler_agent: 'mock' }) // no key, no prompt
  assert.equal(r.status, 201)
  const body = r.body as { session: { status: string; revision: number }; messages: unknown[] }
  assert.equal(body.session.status, 'active'); assert.equal(body.session.revision, 1)
  assert.equal(body.messages.length, 0)
  assert.equal(fake.calls.length, 0) // compiler never invoked
  store.closeSync()
})

test('contract: an initial-prompt create WITH a key runs a recoverable, keyed initial turn', async () => {
  const { store, fake, svc } = mk(); fake.script = [ready('kickoff')]
  const { session, messages } = await svc.createSession({ compiler_agent: 'mock', initial_request: 'kick it off', idempotency_key: 'sess-1' })
  assert.equal(messages.length, 2)
  // the initial user turn carries a durable (derived) turn_key ⇒ recoverable
  assert.match(messages[0].turn_key ?? '', /^init_/)
  assert.equal(session.pending_turn_key, null) // completed → cleared
  store.closeSync()
})
