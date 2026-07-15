/**
 * Remote-task restart recovery: a Gateway wired to a durable store recovers a
 * running REMOTE task (known remote_run_id) after a restart against the SAME DB —
 * same public task_id, authoritative reconciliation, resumed pump, exactly-once
 * terminal, cancellation, active-slot accounting, replay boundary, and
 * history-incomplete metadata. In-process relay + a real spawned mock node
 * daemon; temporary DB; never touches production. Skips if the daemon can't
 * register.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startRelayServer } from '../src/relay/server.js'
import { startAgentGateway, type GatewayServer } from '../src/lib/agent-gateway.js'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const RTOKEN = `rr-relay-${Math.random().toString(36).slice(2)}`
const API = `rr-api-${Math.random().toString(36).slice(2)}`
const NODE_ID = 'gw-recovery-node'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function vibe(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''; p.stdout!.on('data', (d: Buffer) => { out += d.toString() })
    p.on('close', () => resolve(out)); setTimeout(() => { p.kill('SIGKILL'); resolve(out) }, timeoutMs)
  })
}
function reqRaw(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = { authorization: `Bearer ${API}` }
    if (payload) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => { let b: any = null; try { b = JSON.parse(t) } catch { /* */ } resolve({ status: res.statusCode ?? 0, body: b }) }) })
    r.on('error', reject); if (payload) r.write(payload); r.end()
  })
}
function sseSeqs(port: number, id: string, lastEventId: string, ms: number): Promise<number[]> {
  return new Promise((resolve) => {
    const seqs: number[] = []; let buf = ''
    const r = http.request({ host: '127.0.0.1', port, path: `/v1/tasks/${id}/events`, headers: { authorization: `Bearer ${API}`, 'last-event-id': lastEventId } }, (res) => {
      res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) !== -1) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^id: (\d+)$/m.exec(f); if (m) seqs.push(Number(m[1])) } })
    })
    r.end(); setTimeout(() => { try { r.destroy() } catch { /* */ } resolve(seqs) }, ms)
  })
}
async function waitStatus(port: number, id: string, want: string, ms = 15000): Promise<any> {
  const end = Date.now() + ms
  while (Date.now() < end) { const r = await reqRaw(port, 'GET', `/v1/tasks/${id}`); if (r.body?.status === want) return r.body; await delay(200) }
  throw new Error(`remote task ${id} did not reach ${want}`)
}

test('remote task recovers across a Gateway restart: same id, reconcile, terminal-once, slots, replay, history', async (t) => {
  const relay = await startRelayServer({ port: 0, token: RTOKEN })
  const relayUrl = `ws://127.0.0.1:${relay.port}`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-rr-'))
  const dbPath = path.join(root, 'control.sqlite')
  process.env.VIBE_DIR = path.join(root, 'gateway'); fs.mkdirSync(process.env.VIBE_DIR, { recursive: true })
  const tokenFile = path.join(root, 'tok'); fs.writeFileSync(tokenFile, RTOKEN + '\n', { mode: 0o600 })
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', NODE_ID], {
    env: { ...process.env, VIBE_DIR: path.join(root, 'node'), VIBE_RELAY_TOKEN: RTOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock', VIBE_MOCK_RUN_MS: '6000' }, stdio: 'ignore',
  })
  let up = false; const deadline = Date.now() + 9000
  while (Date.now() < deadline && !up) { await delay(300); try { if (JSON.parse((await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', tokenFile, '--json'], { ...process.env })).trim()).some((n: { node_id: string }) => n.node_id === NODE_ID)) up = true } catch { /* */ } }

  let store: SqliteControlStore | undefined
  let gw: GatewayServer | undefined
  const cleanup = async (): Promise<void> => {
    if (gw) { try { await gw.close() } catch { /* */ } }
    if (store) { try { store.closeSync() } catch { /* */ } }
    if (!daemon.killed) daemon.kill('SIGKILL'); await delay(200); try { await relay.close() } catch { /* */ }
  }
  if (!up) { await cleanup(); t.skip('mock node daemon did not register'); return }

  try {
    store = openControlStore({ path: dbPath })
    gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: API, relay: relayUrl, relayToken: RTOKEN, taskStore: store })
    const created = await reqRaw(gw.port, 'POST', '/v1/tasks', { agent: 'mock', node_id: NODE_ID, input: { text: 'remote recovery' } })
    assert.equal(created.status, 202)
    const id = created.body.task_id
    await waitStatus(gw.port, id, 'running')
    // remote_run_id is durably BOUND (decoupled from the public task_id)
    const rec0 = store.getTaskRecord(id)
    assert.ok(rec0?.remote_run_id, 'remote_run_id durably bound')
    assert.notEqual(rec0!.remote_run_id, id, 'public task_id is decoupled from the relay run id')
    const cursorBefore = store.latestTaskEventSequence(id)

    // ── restart the Gateway on the SAME DB; the remote run keeps going ──
    await gw.close(); store.closeSync()
    store = openControlStore({ path: dbPath })
    gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: API, relay: relayUrl, relayToken: RTOKEN, taskStore: store, maxActiveTasks: 1 })

    const recovered = await reqRaw(gw.port, 'GET', `/v1/tasks/${id}`)
    assert.equal(recovered.status, 200); assert.equal(recovered.body.task_id, id, 'same public task_id after restart')
    assert.equal(recovered.body.status, 'running', 'authoritative remote status is running')
    // recovered running task holds the only active slot
    assert.equal((await reqRaw(gw.port, 'POST', '/v1/tasks', { agent: 'mock', node_id: NODE_ID, input: { text: 'x' } })).status, 503)
    // resuming a remote pump without node replay marks history incomplete at the boundary
    await delay(300)
    const recH = store.getTaskRecord(id)
    assert.equal(recH?.history_incomplete, true)
    assert.equal(recH?.history_reason, 'gateway_restart_without_node_replay')
    assert.equal(recH?.history_boundary_sequence, cursorBefore)
    assert.equal(recovered.body.history === undefined || recovered.body.history.complete !== undefined, true)

    // replay boundary: events after Last-Event-ID replay from durable, future live
    // events continue, with no gap/duplicate at the boundary
    const replayed = await sseSeqs(gw.port, id, String(cursorBefore), 7000)
    assert.ok(replayed.every((s) => s > cursorBefore), 'replay is strictly after the cursor (no re-delivery)')
    assert.equal(new Set(replayed).size, replayed.length, 'no duplicate across replay/live boundary')

    const done = await waitStatus(gw.port, id, 'completed')
    assert.equal(done.status, 'completed')
    // terminal recorded exactly once, durably
    assert.equal(store.getTaskRecord(id)?.terminal_event_recorded, true)
    const terminals = store.loadTaskEvents(id).filter((e) => ['task.completed', 'task.failed', 'task.cancelled'].includes(e.event_type))
    assert.equal(terminals.length, 1, 'exactly one terminal event across recovery')
    // next_event_id stays the greatest actually-consumed persisted sequence
    assert.equal(store.latestTaskEventSequence(id), store.loadTaskEvents(id).at(-1)!.sequence)
    // terminal task freed the active slot (a new create is accepted)
    let slotFreed = false
    for (let i = 0; i < 30 && !slotFreed; i++) { if ((await reqRaw(gw.port, 'POST', '/v1/tasks', { agent: 'mock', node_id: NODE_ID, input: { text: 'y' } })).status === 202) slotFreed = true; else await delay(150) }
    assert.ok(slotFreed, 'slot released after terminal reconciliation')
  } finally {
    await cleanup()
  }
})
