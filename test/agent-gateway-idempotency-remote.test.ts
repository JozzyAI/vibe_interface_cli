/**
 * Integration acceptance for idempotent task creation over a REMOTE node. A real
 * spawned mock daemon + in-process relay + durable Gateway (temporary DB): a task
 * created with idempotency key K, retried identically (simulating a lost HTTP
 * response) and across a Gateway restart, returns the SAME public task and does
 * NOT start a second remote run; a changed request with K is a 409 conflict.
 * Encrypted remote execution throughout. Never touches production. Skips if the
 * daemon can't register.
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
const RTOKEN = `idr-relay-${Math.random().toString(36).slice(2)}`
const API = `idr-api-${Math.random().toString(36).slice(2)}`
const NODE_ID = 'gw-idem-node'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function vibe(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''; p.stdout!.on('data', (d: Buffer) => { out += d.toString() })
    p.on('close', () => resolve(out)); setTimeout(() => { p.kill('SIGKILL'); resolve(out) }, timeoutMs)
  })
}
interface Res { status: number; body: any; headers: http.IncomingHttpHeaders }
function reqRaw(port: number, method: string, p: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = { authorization: `Bearer ${API}` }
    if (payload) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => { let b: any = null; try { b = JSON.parse(t) } catch { /* */ } resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }) }) })
    r.on('error', reject); if (payload) r.write(payload); r.end()
  })
}
async function waitStatus(port: number, id: string, want: string, ms = 15000): Promise<any> {
  const end = Date.now() + ms
  while (Date.now() < end) { const r = await reqRaw(port, 'GET', `/v1/tasks/${id}`); if (r.body?.status === want) return r.body; await delay(200) }
  throw new Error(`remote task ${id} did not reach ${want}`)
}

test('remote idempotent create: lost-response retry + restart retry return the same task and one remote run; changed request → 409', async (t) => {
  const relay = await startRelayServer({ port: 0, token: RTOKEN })
  const relayUrl = `ws://127.0.0.1:${relay.port}`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-idr-'))
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
    const body = { agent: 'mock', node_id: NODE_ID, input: { text: 'remote idempotent' }, idempotency_key: 'step:remote-K' }

    // 1) create with key K → one public task, one remote run
    const created = await reqRaw(gw.port, 'POST', '/v1/tasks', body)
    assert.equal(created.status, 202)
    const id = created.body.task_id
    await waitStatus(gw.port, id, 'running')
    const rec0 = store.getTaskRecord(id)!
    assert.ok(rec0.remote_run_id, 'a remote run was bound')
    const remoteRunId = rec0.remote_run_id

    // 3-6) simulate a lost HTTP response: resubmit the identical request with K.
    const retry = await reqRaw(gw.port, 'POST', '/v1/tasks', body)
    assert.equal(retry.status, 200); assert.equal(retry.body.task_id, id, 'same public task_id')
    assert.equal(retry.headers['idempotency-replayed'], 'true')
    assert.equal(store.getTaskRecord(id)!.remote_run_id, remoteRunId, 'no second remote_run_id was created')
    // exactly one durable task carries the key; exactly one task.created event
    assert.equal(store.getTaskByIdempotencyKey('step:remote-K')!.task_id, id)
    assert.equal(store.loadTaskEvents(id).filter((e) => e.event_type === 'task.created').length, 1)

    // 7-9) restart the Gateway on the SAME DB; resubmit with K → same task, no new run
    await gw.close(); store.closeSync()
    store = openControlStore({ path: dbPath })
    gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: API, relay: relayUrl, relayToken: RTOKEN, taskStore: store })
    const afterRestart = await reqRaw(gw.port, 'POST', '/v1/tasks', body)
    assert.equal(afterRestart.status, 200); assert.equal(afterRestart.body.task_id, id)
    assert.equal(afterRestart.headers['idempotency-replayed'], 'true')
    assert.equal(store.getTaskRecord(id)!.remote_run_id, remoteRunId, 'no new remote run after restart')

    // 10-11) a CHANGED request with the same key → 409 conflict (never echoes the request)
    const conflict = await reqRaw(gw.port, 'POST', '/v1/tasks', { ...body, input: { text: 'a different prompt' } })
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'idempotency_conflict')
    assert.ok(!JSON.stringify(conflict.body).includes('different prompt'))

    // 12) terminal history remains exactly once
    const done = await waitStatus(gw.port, id, 'completed')
    assert.equal(done.status, 'completed')
    const terminals = store.loadTaskEvents(id).filter((e) => ['task.completed', 'task.failed', 'task.cancelled'].includes(e.event_type))
    assert.equal(terminals.length, 1, 'exactly one terminal event')
    // a post-terminal retry still returns the same task, no new run
    const postTerm = await reqRaw(gw.port, 'POST', '/v1/tasks', body)
    assert.equal(postTerm.status, 200); assert.equal(postTerm.body.task_id, id)
    assert.equal(store.getTaskRecord(id)!.remote_run_id, remoteRunId)
  } finally {
    await cleanup()
  }
})
