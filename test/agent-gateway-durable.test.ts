/**
 * Agent Gateway ⇄ durable ControlStore: task identity + canonical event history
 * survive a Gateway restart, non-terminal tasks recover, and public contracts are
 * preserved. Uses the real local mock run lifecycle + an isolated temporary DB
 * (never the production control DB).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startAgentGateway, type GatewayServer } from '../src/lib/agent-gateway.js'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import type { GatewayTaskStore } from '../src/control/store.js'
import type { CreateTaskInput, TaskEventInput, TaskPatch } from '../src/control/records.js'

const TOKEN = `dur-tok-${Math.random().toString(36).slice(2)}`
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mkdir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p))

interface Env { vibeDir: string; dbPath: string }
function mkEnv(mockMs = 300): Env {
  const vibeDir = mkdir('vibe-dur-')
  process.env.VIBE_DIR = vibeDir
  process.env.VIBE_MOCK_RUN_MS = String(mockMs)
  return { vibeDir, dbPath: path.join(mkdir('vibe-durdb-'), 'control.sqlite') }
}

function req(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
    if (payload) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => { let b: any = null; try { b = JSON.parse(t) } catch { /* */ } resolve({ status: res.statusCode ?? 0, body: b }) })
    })
    r.on('error', reject); if (payload) r.write(payload); r.end()
  })
}
const create = (port: number, over: Record<string, unknown> = {}) => req(port, 'POST', '/v1/tasks', { agent: 'mock', input: { text: 'work' }, ...over })
async function waitStatus(port: number, id: string, want: string, ms = 12000): Promise<any> {
  const end = Date.now() + ms
  while (Date.now() < end) { const r = await req(port, 'GET', `/v1/tasks/${id}`); if (r.body?.status === want) return r.body; await delay(100) }
  throw new Error(`task ${id} did not reach ${want}`)
}
function sseSeqs(port: number, id: string, ms = 800): Promise<number[]> {
  return new Promise((resolve) => {
    const seqs: number[] = []; let buf = ''
    const r = http.request({ host: '127.0.0.1', port, path: `/v1/tasks/${id}/events`, method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) !== -1) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^id: (\d+)$/m.exec(f); if (m) seqs.push(Number(m[1])) } })
    })
    r.end()
    setTimeout(() => { try { r.destroy() } catch { /* */ } resolve(seqs) }, ms)
  })
}
const contiguousNoDup = (seqs: number[]): boolean => seqs.every((s, i) => s === i)

/** Run `fn`, always closing every gateway/store it registered (even on failure). */
async function withCleanup(fn: (reg: (r: { close(): any } | SqliteControlStore) => void) => Promise<void>): Promise<void> {
  const res: Array<{ close(): any } | SqliteControlStore> = []
  try { await fn((r) => res.push(r)) }
  finally { for (const r of res.reverse()) { try { 'closeSync' in r ? r.closeSync() : await r.close() } catch { /* */ } } }
}

test('create persists the task record + task.created event durably', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(300); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startGw(store); reg(gw)
    const id = (await create(gw.port)).body.task_id
    const rec = store.getTaskRecord(id)
    assert.equal(rec?.task_id, id); assert.ok((rec?.last_event_sequence ?? -1) >= 0)
    const evs = store.loadTaskEvents(id)
    assert.equal(evs[0].sequence, 0); assert.equal(evs[0].event_type, 'task.created')
  })
})

test('terminal task + events survive restart; same task_id; replay matches durable, no gap/dup', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(300)
    const store1 = openControlStore({ path: env.dbPath }); const gw1 = await startGw(store1)
    const id = (await create(gw1.port)).body.task_id
    await waitStatus(gw1.port, id, 'completed')
    // ensure the terminal event is durably recorded before we simulate a restart
    for (let i = 0; i < 50 && !store1.getTaskRecord(id)?.terminal_event_recorded; i++) await delay(50)
    await gw1.close(); store1.closeSync()
    // restart on the SAME durable DB
    process.env.VIBE_DIR = env.vibeDir
    const store2 = openControlStore({ path: env.dbPath }); reg(store2)
    const gw2 = await startGw(store2); reg(gw2)
    const got = await req(gw2.port, 'GET', `/v1/tasks/${id}`)
    assert.equal(got.status, 200); assert.equal(got.body.task_id, id); assert.equal(got.body.status, 'completed')
    const expected = store2.loadTaskEvents(id).map((e) => e.sequence)
    const seqs = await sseSeqs(gw2.port, id)
    assert.deepEqual(seqs, expected, 'SSE replay equals durably-persisted events')
    assert.ok(contiguousNoDup(seqs), 'contiguous from 0, no duplicate')
    assert.ok(store2.loadTaskEvents(id).some((e) => e.event_type === 'task.completed'), 'terminal event persisted exactly once')
  })
})

test('non-terminal task recovers with same id and reconciles to completed after restart', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(2000)
    const store1 = openControlStore({ path: env.dbPath }); const gw1 = await startGw(store1)
    const id = (await create(gw1.port)).body.task_id
    await waitStatus(gw1.port, id, 'running')
    await gw1.close(); store1.closeSync() // gateway down while the detached mock keeps running
    process.env.VIBE_DIR = env.vibeDir
    const store2 = openControlStore({ path: env.dbPath }); reg(store2)
    const gw2 = await startGw(store2); reg(gw2)
    const recovered = await req(gw2.port, 'GET', `/v1/tasks/${id}`)
    assert.equal(recovered.status, 200); assert.equal(recovered.body.task_id, id) // same id, addressable
    assert.equal((await waitStatus(gw2.port, id, 'completed')).status, 'completed') // resumed + reconciled
  })
})

test('recovered active task counts against the active limit; terminal does not', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(6000) // long mock: reliably still running just after restart, even under load
    const store1 = openControlStore({ path: env.dbPath }); const gw1 = await startGw(store1, { maxActiveTasks: 1 })
    const id = (await create(gw1.port)).body.task_id
    await waitStatus(gw1.port, id, 'running')
    await gw1.close(); store1.closeSync()
    process.env.VIBE_DIR = env.vibeDir
    const store2 = openControlStore({ path: env.dbPath }); reg(store2)
    const gw2 = await startGw(store2, { maxActiveTasks: 1 }); reg(gw2)
    assert.equal(store2.getTaskRecord(id)?.status !== undefined && !['completed', 'failed', 'cancelled'].includes(store2.getTaskRecord(id)!.status), true, 'recovered task is still non-terminal')
    assert.equal((await create(gw2.port)).status, 503) // recovered running task holds the only slot
    await waitStatus(gw2.port, id, 'completed')
    // The gateway frees the slot when its own poller processes the terminal event,
    // which lags authoritative GET status slightly — retry until the slot frees.
    let status = 503
    for (let i = 0; i < 40 && status !== 202; i++) { status = (await create(gw2.port)).status; if (status !== 202) await delay(100) }
    assert.equal(status, 202) // slot freed on completion
  })
})

test('recovered non-terminal task remains cancellable (idempotent)', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(4000)
    const store1 = openControlStore({ path: env.dbPath }); const gw1 = await startGw(store1)
    const id = (await create(gw1.port)).body.task_id
    await waitStatus(gw1.port, id, 'running')
    await gw1.close(); store1.closeSync()
    process.env.VIBE_DIR = env.vibeDir
    const store2 = openControlStore({ path: env.dbPath }); reg(store2)
    const gw2 = await startGw(store2); reg(gw2)
    assert.equal((await req(gw2.port, 'POST', `/v1/tasks/${id}/cancel`)).body.status, 'cancelled')
    assert.equal((await req(gw2.port, 'POST', `/v1/tasks/${id}/cancel`)).body.status, 'cancelled') // idempotent
  })
})

test('subscriber disconnect after restart never cancels; DB holds no token', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(1500)
    const store1 = openControlStore({ path: env.dbPath }); const gw1 = await startGw(store1)
    const id = (await create(gw1.port)).body.task_id
    await waitStatus(gw1.port, id, 'running')
    await gw1.close(); store1.closeSync()
    process.env.VIBE_DIR = env.vibeDir
    const store2 = openControlStore({ path: env.dbPath }); reg(store2)
    const gw2 = await startGw(store2); reg(gw2)
    const sse = http.request({ host: '127.0.0.1', port: gw2.port, path: `/v1/tasks/${id}/events`, method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } }, () => { /* */ })
    sse.end(); await delay(120); sse.destroy() // disconnect mid-stream
    assert.equal((await waitStatus(gw2.port, id, 'completed')).status, 'completed') // unaffected by the disconnect
    assert.ok(!fs.readFileSync(env.dbPath).includes(Buffer.from(TOKEN)), 'the API token never lands in the durable DB')
  })
})

test('unknown task is still 404 (durable fallback does not invent tasks)', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(300); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startGw(store); reg(gw)
    const r = await req(gw.port, 'GET', '/v1/tasks/run_does_not_exist')
    assert.equal(r.status, 404); assert.equal(r.body.code, 'task_not_found')
  })
})

async function startGw(store: GatewayTaskStore, over: Record<string, unknown> = {}): Promise<GatewayServer> {
  return startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, ...over })
}
const iso = (): string => new Date().toISOString()
/** Collect SSE event TYPES for a window. */
function sseTypes(port: number, id: string, ms = 2000): Promise<string[]> {
  return new Promise((resolve) => {
    const types: string[] = []; let buf = ''
    const r = http.request({ host: '127.0.0.1', port, path: `/v1/tasks/${id}/events`, method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) !== -1) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^event: (.+)$/m.exec(f); if (m) types.push(m[1]) } })
    })
    r.end(); setTimeout(() => { try { r.destroy() } catch { /* */ } resolve(types) }, ms)
  })
}
/** Delegating GatewayTaskStore that throws when durably appending a chosen event. */
class ThrowingStore implements GatewayTaskStore {
  constructor(private readonly inner: SqliteControlStore, private readonly throwOn: string) {}
  createTaskDurable(i: CreateTaskInput, e: TaskEventInput) { return this.inner.createTaskDurable(i, e) }
  appendTaskEventDurable(id: string, e: TaskEventInput) { if (e.event_type === this.throwOn) throw new Error('injected persistence failure'); return this.inner.appendTaskEventDurable(id, e) }
  updateTaskDurable(id: string, r: number, p: TaskPatch) { return this.inner.updateTaskDurable(id, r, p) }
  terminalizeTaskDurable(id: string, r: number, p: TaskPatch, e: TaskEventInput) { return this.inner.terminalizeTaskDurable(id, r, p, e) }
  getTaskRecord(id: string) { return this.inner.getTaskRecord(id) }
  listNonTerminalTasks() { return this.inner.listNonTerminalTasks() }
  loadTaskEvents(id: string) { return this.inner.loadTaskEvents(id) }
  latestTaskEventSequence(id: string) { return this.inner.latestTaskEventSequence(id) }
  markTaskHistoryIncomplete(id: string, reason: string, b: number) { return this.inner.markTaskHistoryIncomplete(id, reason, b) }
  clearTaskHistoryIncomplete(id: string) { return this.inner.clearTaskHistoryIncomplete(id) }
  initReplayCursor(id: string) { return this.inner.initReplayCursor(id) }
  ingestSourceEventDurable(id: string, s: number, e: Parameters<GatewayTaskStore['ingestSourceEventDurable']>[2]) { return this.inner.ingestSourceEventDurable(id, s, e) }
  advanceSourceCursor(id: string, s: number) { return this.inner.advanceSourceCursor(id, s) }
  closeSync() { this.inner.closeSync() }
}

// ── hardening: ambiguous crash-window, history metadata, persist-before-publish ──

test('ambiguous remote start (no bound remote_run_id) is never restarted; terminalized once; idempotent', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(300)
    // Simulate: task record + task.created persisted, remote start attempted, crash
    // BEFORE remote_run_id was durably bound (remote_run_id stays null).
    const store0 = openControlStore({ path: env.dbPath })
    store0.createTaskDurable({ task_id: 'run_ambig', node_id: 'node_1', agent: 'claude-code', status: 'queued', remote_run_id: null }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
    store0.closeSync()
    process.env.VIBE_DIR = env.vibeDir
    // Reopen + recover. Relay is set but unreachable — if recovery ever called remote
    // start/status for this task the test would hang/error; it must not.
    const store1 = openControlStore({ path: env.dbPath }); reg(store1)
    const gw1 = await startGw(store1, { relay: 'ws://127.0.0.1:1', relayToken: 'x' }); reg(gw1)
    await delay(250)
    const got = await req(gw1.port, 'GET', '/v1/tasks/run_ambig')
    assert.equal(got.status, 200) // durable task identity survives — still queryable
    assert.equal(got.body.status, 'failed')
    assert.equal(got.body.error?.reason, 'recovery_unknown_start')
    const rec = store1.getTaskRecord('run_ambig')
    assert.equal(rec?.status, 'failed'); assert.equal(rec?.terminal_event_recorded, true); assert.equal(rec?.error_code, 'recovery_unknown_start')
    assert.equal(store1.loadTaskEvents('run_ambig').filter((e) => e.event_type === 'task.failed').length, 1) // exactly one terminal event
    await gw1.close(); store1.closeSync()
    // Idempotent: a second restart does not re-recover or re-terminalize it.
    const store2 = openControlStore({ path: env.dbPath }); reg(store2)
    const gw2 = await startGw(store2, { relay: 'ws://127.0.0.1:1', relayToken: 'x' }); reg(gw2)
    await delay(150)
    assert.equal((await req(gw2.port, 'GET', '/v1/tasks/run_ambig')).body.status, 'failed')
    assert.equal(store2.loadTaskEvents('run_ambig').filter((e) => e.event_type === 'task.failed').length, 1) // still exactly one
  })
})

test('history-incomplete metadata is persisted, survives reopen, and is exposed via GET', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(300)
    const store0 = openControlStore({ path: env.dbPath })
    store0.createTaskDurable({ task_id: 'run_h', node_id: 'node_1', agent: 'claude-code', status: 'queued', remote_run_id: 'rr_1' }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
    store0.appendTaskEventDurable('run_h', { sequence: 1, event_type: 'agent.output.delta', ts: iso(), payload: {} })
    store0.markTaskHistoryIncomplete('run_h', 'gateway_restart_without_node_replay', 1)
    store0.markTaskHistoryIncomplete('run_h', 'gateway_restart_without_node_replay', 5) // idempotent: earliest boundary wins
    const rev = store0.getTaskRecord('run_h')!.revision
    store0.terminalizeTaskDurable('run_h', rev, { status: 'completed' }, { sequence: 2, event_type: 'task.completed', ts: iso(), payload: {} })
    store0.closeSync()
    process.env.VIBE_DIR = env.vibeDir
    const store1 = openControlStore({ path: env.dbPath }); reg(store1)
    const rec = store1.getTaskRecord('run_h') // survives reopen
    assert.equal(rec?.history_incomplete, true); assert.equal(rec?.history_reason, 'gateway_restart_without_node_replay'); assert.equal(rec?.history_boundary_sequence, 1)
    const gw = await startGw(store1); reg(gw)
    const got = await req(gw.port, 'GET', '/v1/tasks/run_h') // historical terminal → durable fallback exposes history
    assert.equal(got.body.history.complete, false)
    assert.equal(got.body.history.incomplete_reason, 'gateway_restart_without_node_replay')
    assert.equal(got.body.history.boundary_sequence, 1)
  })
})

test('a normally completed local task reports history.complete=true (not marked)', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(300); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startGw(store); reg(gw)
    const id = (await create(gw.port)).body.task_id
    await waitStatus(gw.port, id, 'completed')
    assert.equal((await req(gw.port, 'GET', `/v1/tasks/${id}`)).body.history.complete, true)
    assert.equal(store.getTaskRecord(id)?.history_incomplete, false)
  })
})

test('a persistence failure for an event does not publish it (nor store it)', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(1200); const inner = openControlStore({ path: env.dbPath }); reg(inner)
    const store = new ThrowingStore(inner, 'task.started') // fail to persist the task.started event
    const gw = await startGw(store); reg(gw)
    const id = (await create(gw.port)).body.task_id
    const types = await sseTypes(gw.port, id, 2500)
    await waitStatus(gw.port, id, 'completed')
    assert.ok(!types.includes('task.started'), 'the un-persisted event was never published')
    assert.equal(inner.loadTaskEvents(id).some((e) => e.event_type === 'task.started'), false, 'and it is not in the durable store')
  })
})
