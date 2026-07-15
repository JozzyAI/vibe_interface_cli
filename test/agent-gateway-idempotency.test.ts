/**
 * Idempotent task creation (Agent Gateway ⇄ durable ControlStore). A client-
 * supplied idempotency_key makes create-or-return safe across a client/process
 * crash: retrying the identical request returns the SAME durable task instead of
 * starting a second run. Uses the real LOCAL mock run lifecycle + an isolated
 * temporary DB (never the production control DB). No relay/node required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { startAgentGateway, type GatewayServer } from '../src/lib/agent-gateway.js'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { GatewayClient } from '../src/mcp/gateway-client.js'
import { computeRequestFingerprint } from '../src/lib/request-fingerprint.js'

const TOKEN = `idem-tok-${Math.random().toString(36).slice(2)}`
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mkdir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p))

function mkEnv(mockMs = 300): { vibeDir: string; dbPath: string } {
  const vibeDir = mkdir('vibe-idem-')
  process.env.VIBE_DIR = vibeDir
  process.env.VIBE_MOCK_RUN_MS = String(mockMs)
  return { vibeDir, dbPath: path.join(mkdir('vibe-idemdb-'), 'control.sqlite') }
}

interface Res { status: number; body: any; headers: http.IncomingHttpHeaders }
function req(port: number, method: string, p: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
    if (payload) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => { let b: any = null; try { b = JSON.parse(t) } catch { /* */ } resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }) })
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

/** Run `fn`, always closing every gateway/store it registered (even on failure). */
async function withCleanup(fn: (reg: (r: GatewayServer | SqliteControlStore) => void) => Promise<void>): Promise<void> {
  const opened: Array<GatewayServer | SqliteControlStore> = []
  try { await fn((r) => opened.push(r)) }
  finally { for (const r of opened.reverse()) { try { 'close' in r ? await r.close() : (r as SqliteControlStore).closeSync() } catch { /* */ } } }
}

// ── basic behavior ────────────────────────────────────────────────────────────

test('no key preserves existing behavior; a new key creates exactly one task', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store }); reg(gw)
    const noKey = await create(gw.port)
    assert.equal(noKey.status, 202); assert.ok(noKey.body.task_id)
    assert.equal(noKey.headers['idempotency-replayed'], undefined)

    const first = await create(gw.port, { idempotency_key: 'step:one' })
    assert.equal(first.status, 202); assert.ok(first.body.task_id)
    assert.equal(first.headers['idempotency-replayed'], undefined) // not a replay
    assert.equal(store.getTaskByIdempotencyKey('step:one')?.task_id, first.body.task_id)
  })
})

test('same key + identical request returns the same task_id, replay header, and no second task/created event or run', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(1500); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store }); reg(gw)
    const first = await create(gw.port, { idempotency_key: 'step:dup' })
    assert.equal(first.status, 202)
    const id = first.body.task_id
    // retry the identical request several times while still running
    for (let i = 0; i < 3; i++) {
      const again = await create(gw.port, { idempotency_key: 'step:dup' })
      assert.equal(again.status, 200)
      assert.equal(again.headers['idempotency-replayed'], 'true')
      assert.equal(again.body.task_id, id, 'same public task_id')
    }
    // exactly one durable task carries the key; exactly one task.created event
    assert.equal(store.getTaskByIdempotencyKey('step:dup')?.task_id, id)
    assert.equal(store.loadTaskEvents(id).filter((e) => e.event_type === 'task.created').length, 1)
    // terminal replay: after completion, the same key still returns the terminal task.
    // The replay reads the CURRENT durable state, which converges to terminal via the
    // poller shortly after the run reports completion — wait for that convergence.
    await waitStatus(gw.port, id, 'completed')
    for (let i = 0; i < 50 && store.getTaskRecord(id)?.status !== 'completed'; i++) await delay(100)
    const terminal = await create(gw.port, { idempotency_key: 'step:dup' })
    assert.equal(terminal.status, 200); assert.equal(terminal.body.task_id, id); assert.equal(terminal.body.status, 'completed')
    assert.equal(terminal.headers['idempotency-replayed'], 'true')
  })
})

// ── conflict behavior ─────────────────────────────────────────────────────────

test('same key + a semantically different request returns 409 idempotency_conflict without exposing either request', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(1500); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store }); reg(gw)
    const first = await create(gw.port, { idempotency_key: 'step:x', input: { text: 'ORIGINAL-PROMPT' } })
    assert.equal(first.status, 202)
    // each variation changes execution semantics → conflict
    for (const variant of [
      { input: { text: 'DIFFERENT-PROMPT' } },
      { input: { text: 'ORIGINAL-PROMPT' }, execution: { permission_mode: 'unsafe-skip' } },
      { input: { text: 'ORIGINAL-PROMPT' }, workspace: { workspace_key: 'other-ws' } },
      { input: { text: 'ORIGINAL-PROMPT' }, metadata: { changed: true } },
    ]) {
      const c = await create(gw.port, { idempotency_key: 'step:x', ...variant })
      assert.equal(c.status, 409, JSON.stringify(variant))
      assert.equal(c.body.code, 'idempotency_conflict')
      const blob = JSON.stringify(c.body)
      assert.ok(!blob.includes('ORIGINAL-PROMPT') && !blob.includes('DIFFERENT-PROMPT'), 'conflict never echoes a prompt')
      assert.ok(!blob.includes('step:x'), 'conflict does not echo the key')
    }
  })
})

test('malformed / oversized idempotency keys are rejected as invalid_request (not internal errors)', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store }); reg(gw)
    for (const key of ['has space', 'a/b/c', 'x'.repeat(129), '', 'ünïcode', "bad null"]) {
      const r = await create(gw.port, { idempotency_key: key })
      assert.equal(r.status, 400, JSON.stringify(key)); assert.equal(r.body.code, 'invalid_request')
    }
  })
})

test('idempotency_key without a durable store is rejected (durability is required)', async () => {
  await withCleanup(async (reg) => {
    mkEnv()
    const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN }); reg(gw) // no taskStore
    const r = await create(gw.port, { idempotency_key: 'step:nodb' })
    assert.equal(r.status, 400); assert.equal(r.body.code, 'invalid_request')
  })
})

// ── concurrency ───────────────────────────────────────────────────────────────

test('concurrent identical same-key requests create exactly one task; all callers get the same id; one backend start', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(1500); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store }); reg(gw)
    const results = await Promise.all(Array.from({ length: 8 }, () => create(gw.port, { idempotency_key: 'step:race' })))
    const ids = new Set(results.map((r) => r.body.task_id))
    assert.equal(ids.size, 1, 'exactly one public task_id across all concurrent callers')
    const id = [...ids][0]
    // exactly one 202 (creator); the rest are 200 replays
    assert.equal(results.filter((r) => r.status === 202).length, 1)
    assert.equal(results.filter((r) => r.status === 200 && r.headers['idempotency-replayed'] === 'true').length, 7)
    // exactly one durable task + one task.created (one backend start)
    assert.equal(store.getTaskByIdempotencyKey('step:race')?.task_id, id)
    assert.equal(store.loadTaskEvents(id).filter((e) => e.event_type === 'task.created').length, 1)
  })
})

test('concurrent DIFFERING requests with the same key yield one success and one conflict', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(1500); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store }); reg(gw)
    const [a, b] = await Promise.all([
      create(gw.port, { idempotency_key: 'step:diff', input: { text: 'A' } }),
      create(gw.port, { idempotency_key: 'step:diff', input: { text: 'B' } }),
    ])
    const statuses = [a.status, b.status].sort()
    // one create (202) + one conflict (409); OR one 202 + one 200 replay if the loser
    // happened to match — but here the requests differ, so exactly one must conflict.
    assert.ok(statuses.includes(409), `expected a conflict, got ${statuses}`)
    assert.ok(a.status === 202 || b.status === 202, 'exactly one creator')
    assert.equal(store.getTaskByIdempotencyKey('step:diff') ? 1 : 0, 1) // exactly one durable task exists
  })
})

// ── capacity ──────────────────────────────────────────────────────────────────

test('idempotent replay succeeds while the active limit is full and consumes no slot; a new key is still capacity-checked', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(2000); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, maxActiveTasks: 1 }); reg(gw)
    const first = await create(gw.port, { idempotency_key: 'step:cap' })
    assert.equal(first.status, 202)
    const id = first.body.task_id
    await waitStatus(gw.port, id, 'running')
    // active limit is now FULL (1/1). A genuinely new key is rejected...
    assert.equal((await create(gw.port, { idempotency_key: 'step:new' })).status, 503)
    // ...but replaying the existing running task still succeeds (no slot needed).
    const replay = await create(gw.port, { idempotency_key: 'step:cap' })
    assert.equal(replay.status, 200); assert.equal(replay.body.task_id, id)
    assert.equal(replay.headers['idempotency-replayed'], 'true')
    // once terminal, a terminal replay also consumes no slot and a new task now fits.
    await waitStatus(gw.port, id, 'completed')
    // the durable projection converges to terminal via the poller shortly after the
    // run reports completion (replay returns the CURRENT durable state).
    for (let i = 0; i < 40 && store.getTaskRecord(id)?.status !== 'completed'; i++) await delay(100)
    const termReplay = await create(gw.port, { idempotency_key: 'step:cap' })
    assert.equal(termReplay.status, 200); assert.equal(termReplay.body.status, 'completed')
    let accepted = false
    for (let i = 0; i < 30 && !accepted; i++) { if ((await create(gw.port, { idempotency_key: 'step:after' })).status === 202) accepted = true; else await delay(100) }
    assert.ok(accepted, 'a new task fits once the prior one is terminal')
  })
})

// ── crash / retry (restart under the same key) ─────────────────────────────────

test('a task persisted before a Gateway restart is returned (not restarted) when retried with the same key', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(4000)
    let store = openControlStore({ path: env.dbPath }); reg(store)
    let gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store }); reg(gw)
    const first = await create(gw.port, { idempotency_key: 'step:restart' })
    assert.equal(first.status, 202)
    const id = first.body.task_id
    await waitStatus(gw.port, id, 'running')

    // restart the Gateway on the SAME DB
    await gw.close(); store.closeSync()
    store = openControlStore({ path: env.dbPath }); reg(store)
    gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store }); reg(gw)

    // retry with the same key → the SAME task, no second run
    const retry = await create(gw.port, { idempotency_key: 'step:restart' })
    assert.equal(retry.status, 200); assert.equal(retry.body.task_id, id)
    assert.equal(retry.headers['idempotency-replayed'], 'true')
    assert.equal(store.loadTaskEvents(id).filter((e) => e.event_type === 'task.created').length, 1)
    // repeated retries remain idempotent
    assert.equal((await create(gw.port, { idempotency_key: 'step:restart' })).body.task_id, id)
  })
})

// ── persistence / security ─────────────────────────────────────────────────────

test('the fingerprint is a bounded digest (not the prompt); key + fingerprint survive close/reopen', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv()
    let store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store }); reg(gw)
    await create(gw.port, { idempotency_key: 'step:fp', input: { text: 'SECRET-PROMPT-TEXT' } })
    await gw.close()
    store.closeSync()
    // reopen and inspect the raw row: fingerprint is a 64-hex digest, not the prompt
    store = openControlStore({ path: env.dbPath }); reg(store)
    const rec = store.getTaskByIdempotencyKey('step:fp')!
    assert.equal(rec.idempotency_key, 'step:fp')
    assert.match(rec.request_fingerprint ?? '', /^[0-9a-f]{64}$/)
    assert.ok(!(rec.request_fingerprint ?? '').includes('SECRET-PROMPT-TEXT'))
    // the digest matches the pure fingerprint of the same normalized request
    const expected = computeRequestFingerprint({ agent: 'mock', input: { text: 'SECRET-PROMPT-TEXT' } })
    assert.equal(rec.request_fingerprint, expected)
  })
})

test('the idempotency key is never forwarded into the durable event payloads or task metadata', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store }); reg(gw)
    const r = await create(gw.port, { idempotency_key: 'step:leak', metadata: { a: 1 } })
    const id = r.body.task_id
    // the key lives ONLY in its dedicated column — not smuggled into events/metadata.
    const raw = new Database(env.dbPath, { readonly: true })
    const evJson = (raw.prepare('SELECT group_concat(payload_json) AS j FROM task_events WHERE task_id = ?').get(id) as { j: string | null }).j ?? ''
    const meta = (raw.prepare('SELECT metadata_json AS m FROM tasks WHERE task_id = ?').get(id) as { m: string | null }).m ?? ''
    raw.close()
    assert.ok(!evJson.includes('step:leak'))
    assert.ok(!meta.includes('step:leak'))
  })
})

// ── internal Gateway client support ────────────────────────────────────────────

test('the internal Gateway HTTP client can send an idempotency_key and gets create-or-return semantics', async () => {
  await withCleanup(async (reg) => {
    const env = mkEnv(1500); const store = openControlStore({ path: env.dbPath }); reg(store)
    const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store }); reg(gw)
    const client = new GatewayClient(`http://127.0.0.1:${gw.port}`, TOKEN)
    const created = await client.startTask({ agent: 'mock', input: { text: 'via client' }, idempotency_key: 'step:client' }) as { task_id: string }
    assert.ok(created.task_id)
    const replay = await client.startTask({ agent: 'mock', input: { text: 'via client' }, idempotency_key: 'step:client' }) as { task_id: string }
    assert.equal(replay.task_id, created.task_id)
    assert.equal(store.loadTaskEvents(created.task_id).filter((e) => e.event_type === 'task.created').length, 1)
  })
})
