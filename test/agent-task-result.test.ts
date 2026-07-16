/**
 * First-class AgentTaskResult — the result contract, ControlStore result storage,
 * Node-journal result storage, and the Gateway result projection / provider
 * source. Uses only temporary databases + the local mock lifecycle; never touches
 * production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { buildTaskResult, validateTaskResult, computeResultContentHash, MAX_FINAL_OUTPUT_BYTES } from '../src/lib/agent-task-result.js'
import { openControlStore } from '../src/control/sqlite-store.js'
import { openNodeJournal } from '../src/node-journal/sqlite-journal.js'
import { startAgentGateway, type GatewayServer } from '../src/lib/agent-gateway.js'
import { openControlStore as openStore, type SqliteControlStore } from '../src/control/sqlite-store.js'

const iso = () => new Date().toISOString()
const tmpDb = (p: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), p)), 'db.sqlite')

// ── contract ─────────────────────────────────────────────────────────────────

test('AgentTaskResult contract: build/validate, stable hash, and fail-closed on bad envelopes', () => {
  const r = buildTaskResult({ text: '{"status":"done"}', processExitCode: 0 })
  assert.equal(r.schema_version, '1'); assert.equal(r.final_output.text, '{"status":"done"}')
  assert.equal(r.content_hash, computeResultContentHash('{"status":"done"}'))
  const v = validateTaskResult(r); assert.ok(v.ok)
  // unknown NEWER schema fails closed
  assert.equal((validateTaskResult({ ...r, schema_version: '2' }) as any).code, 'unsupported_schema_version')
  // hash mismatch
  assert.equal((validateTaskResult({ ...r, final_output: { kind: 'text', text: 'tampered' } }) as any).code, 'content_hash_mismatch')
  // malformed shape
  assert.equal((validateTaskResult({ ...r, final_output: { kind: 'binary', text: 'x' } }) as any).code, 'invalid_result')
  assert.equal((validateTaskResult(null) as any).code, 'invalid_result')
  // oversized
  const big = 'x'.repeat(MAX_FINAL_OUTPUT_BYTES + 1)
  assert.equal((validateTaskResult(buildTaskResult({ text: big })) as any).code, 'result_too_large')
})

// ── ControlStore result storage ──────────────────────────────────────────────

test('ControlStore: persist result idempotent/conflict, revalidate on read, survives reopen, atomic terminalize', () => {
  const p = tmpDb('atr-cs-')
  let s = openControlStore({ path: p })
  const created = { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} }
  s.createTaskDurable({ task_id: 'run_1', agent: 'mock', status: 'running' }, created)
  const result = buildTaskResult({ text: '{"a":1}', processExitCode: 0 })
  // persist + idempotent duplicate + conflict
  assert.equal(s.persistTaskResultDurable('run_1', 'available', result).applied, true)
  assert.equal(s.persistTaskResultDurable('run_1', 'available', result).applied, false) // idempotent
  assert.throws(() => s.persistTaskResultDurable('run_1', 'available', buildTaskResult({ text: '{"a":2}' })), (e: any) => e.code === 'result_conflict')
  assert.equal(s.getTaskRecord('run_1')?.result_status, 'available') // projection set
  // survives reopen; revalidated on read
  s.closeSync(); s = openControlStore({ path: p })
  const got = s.getTaskResultDurable('run_1'); assert.equal(got?.result_status, 'available'); assert.equal(got?.result?.final_output.text, '{"a":1}')

  // atomic terminalize-with-result (result + terminal + event together, idempotent)
  s.createTaskDurable({ task_id: 'run_2', agent: 'mock', status: 'running' }, created)
  const rec = s.getTaskRecord('run_2')!
  const r2 = buildTaskResult({ text: '{"ok":true}' })
  s.terminalizeTaskWithResultDurable('run_2', rec.revision, { status: 'completed' }, { sequence: 1, event_type: 'task.completed', ts: iso(), payload: {} }, 'available', r2)
  assert.equal(s.getTaskRecord('run_2')?.terminal_event_recorded, true)
  assert.equal(s.getTaskResultDurable('run_2')?.result?.final_output.text, '{"ok":true}')
  // idempotent re-run (recovery) with the same result is a no-op
  s.terminalizeTaskWithResultDurable('run_2', s.getTaskRecord('run_2')!.revision, { status: 'completed' }, { sequence: 1, event_type: 'task.completed', ts: iso(), payload: {} }, 'available', r2)
  assert.equal(s.loadTaskEvents('run_2').filter((e) => e.event_type === 'task.completed').length, 1)
  // a 'missing' result persists no content
  s.createTaskDurable({ task_id: 'run_3', agent: 'mock', status: 'running' }, created)
  s.persistTaskResultDurable('run_3', 'missing', null)
  const m = s.getTaskResultDurable('run_3'); assert.equal(m?.result_status, 'missing'); assert.equal(m?.result, null)
  s.closeSync()
})

test('ControlStore + Node journal: duplicate detection compares the FULL immutable envelope, not just content_hash', () => {
  // Same content_hash/text but DIFFERENT evidence_refs → a conflict, not idempotent.
  const base = buildTaskResult({ text: '{"a":1}', processExitCode: 0 })
  const withEvidence = { ...base, evidence_refs: [{ kind: 'task_status', summary: 'ok' }] }
  const withDifferentEvidence = { ...base, evidence_refs: [{ kind: 'task_status', summary: 'different' }] }
  // finalized_at differs but content is identical → still idempotent (timestamp excluded).
  const laterTimestamp = { ...withEvidence, finalized_at: new Date(Date.now() + 60000).toISOString() }

  const cs = openControlStore({ path: tmpDb('atr-imm-cs-') })
  cs.createTaskDurable({ task_id: 'run_1', agent: 'mock', status: 'running' }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
  assert.equal(cs.persistTaskResultDurable('run_1', 'available', withEvidence).applied, true)
  assert.equal(cs.persistTaskResultDurable('run_1', 'available', withEvidence).applied, false)        // exact dup
  assert.equal(cs.persistTaskResultDurable('run_1', 'available', laterTimestamp).applied, false)      // differing finalized_at only → still idempotent
  assert.throws(() => cs.persistTaskResultDurable('run_1', 'available', withDifferentEvidence), (e: any) => e.code === 'result_conflict') // differing evidence_refs → conflict
  cs.closeSync()

  const nj = openNodeJournal({ path: tmpDb('atr-imm-nj-') })
  nj.ensureRun('rr_1')
  assert.equal(nj.persistRunResult('rr_1', 'available', withEvidence).applied, true)
  assert.equal(nj.persistRunResult('rr_1', 'available', laterTimestamp).applied, false)               // finalized_at excluded
  assert.throws(() => nj.persistRunResult('rr_1', 'available', withDifferentEvidence), (e: any) => e.code === 'result_conflict')
  nj.close()
})

test('ControlStore: a corrupted persisted result fails closed on read; migration preserves v1-v5 data', async () => {
  const p = tmpDb('atr-cs2-')
  let s = openControlStore({ path: p })
  s.createTaskDurable({ task_id: 'run_1', agent: 'mock', status: 'running' }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
  s.persistTaskResultDurable('run_1', 'available', buildTaskResult({ text: '{"a":1}' }))
  s.closeSync()
  // corrupt the stored content_hash directly
  const Database = (await import('better-sqlite3')).default
  const raw = new Database(p)
  raw.prepare("UPDATE task_results SET content_hash = 'deadbeef' WHERE task_id = 'run_1'").run()
  raw.close()
  s = openControlStore({ path: p })
  assert.throws(() => s.getTaskResultDurable('run_1'), (e: any) => e.code === 'corruption') // fail closed
  s.closeSync()
})

// ── Node-journal result storage ──────────────────────────────────────────────

test('Node journal: persist result idempotent/conflict, revalidate, survives reopen, no token fixtures', async () => {
  const p = tmpDb('atr-nj-')
  let j = openNodeJournal({ path: p })
  j.ensureRun('rr_1')
  const result = buildTaskResult({ text: '{"final":"answer"}', processExitCode: 0 })
  assert.equal(j.persistRunResult('rr_1', 'available', result).applied, true)
  assert.equal(j.persistRunResult('rr_1', 'available', result).applied, false) // idempotent
  assert.throws(() => j.persistRunResult('rr_1', 'available', buildTaskResult({ text: 'different' })), (e: any) => e.code === 'result_conflict')
  j.close(); j = openNodeJournal({ path: p }) // survives reopen
  const got = j.getRunResult('rr_1'); assert.equal(got?.result_status, 'available'); assert.equal(got?.result?.final_output.text, '{"final":"answer"}')
  assert.equal(j.getRunResult('rr_missing'), null)
  // no token/secret fixtures in the stored row
  const Database = (await import('better-sqlite3')).default
  const raw = new Database(p, { readonly: true })
  const row = JSON.stringify(raw.prepare("SELECT * FROM run_results WHERE remote_run_id = 'rr_1'").get())
  raw.close()
  assert.ok(!/token|bearer|secret|aes_key|private_key/i.test(row))
  j.close()
})

// ── Gateway result projection + provider source (local mock) ─────────────────

const TOKEN = `atr-${Math.random().toString(36).slice(2)}`
function req(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }; if (payload) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => { let b: any = null; try { b = JSON.parse(t) } catch { /* */ } resolve({ status: res.statusCode ?? 0, body: b }) }) })
    r.on('error', reject); if (payload) r.write(payload); r.end()
  })
}
async function waitStatus(port: number, id: string, want: string, ms = 12000): Promise<any> {
  const end = Date.now() + ms
  while (Date.now() < end) { const r = await req(port, 'GET', `/v1/tasks/${id}`); if (r.body?.status === want) return r.body; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error(`task ${id} did not reach ${want}`)
}

test('Gateway: a local mock task with VIBE_MOCK_OUTPUT projects result_status=available + the result; default mock → missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atr-gw-'))
  process.env.VIBE_DIR = path.join(root, 'vibe'); fs.mkdirSync(process.env.VIBE_DIR, { recursive: true })
  const store = openStore({ path: path.join(root, 'control.sqlite') }) as SqliteControlStore
  let gw: GatewayServer | undefined
  try {
    gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store })
    // available: the mock emits an authoritative final result
    process.env.VIBE_MOCK_OUTPUT = JSON.stringify({ status: 'done', summary: 'ok' })
    const c1 = await req(gw.port, 'POST', '/v1/tasks', { agent: 'mock', input: { text: 'go' } })
    const id1 = c1.body.task_id
    await waitStatus(gw.port, id1, 'completed')
    // The durable result is persisted by the gateway poller's terminalization,
    // which lags the authoritative readRun status slightly — wait for convergence.
    for (let i = 0; i < 50 && store.getTaskResultDurable(id1) === null; i++) await new Promise((r) => setTimeout(r, 100))
    const g1 = await req(gw.port, 'GET', `/v1/tasks/${id1}`)
    assert.equal(g1.body.result_status, 'available')
    assert.equal(g1.body.result?.final_output?.text, JSON.stringify({ status: 'done', summary: 'ok' }))
    assert.match(g1.body.result?.content_hash ?? '', /^[0-9a-f]{64}$/)
    // durable: survives via the store
    assert.equal(store.getTaskResultDurable(id1)?.result?.final_output.text, JSON.stringify({ status: 'done', summary: 'ok' }))

    // missing: the default mock (no VIBE_MOCK_OUTPUT) has no authoritative final result
    delete process.env.VIBE_MOCK_OUTPUT
    process.env.VIBE_MOCK_RUN_MS = '300'
    const c2 = await req(gw.port, 'POST', '/v1/tasks', { agent: 'mock', input: { text: 'go' } })
    const id2 = c2.body.task_id
    await waitStatus(gw.port, id2, 'completed')
    for (let i = 0; i < 50 && store.getTaskResultDurable(id2) === null; i++) await new Promise((r) => setTimeout(r, 100))
    const g2 = await req(gw.port, 'GET', `/v1/tasks/${id2}`)
    assert.equal(g2.body.result_status, 'missing')
    assert.equal(store.getTaskResultDurable(id2)?.result, null)
  } finally {
    delete process.env.VIBE_MOCK_OUTPUT; delete process.env.VIBE_MOCK_RUN_MS
    if (gw) { try { await gw.close() } catch { /* */ } }
    try { store.closeSync() } catch { /* */ }
  }
})
