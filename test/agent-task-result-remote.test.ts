/**
 * Encrypted REMOTE result acceptance: a real spawned mock daemon runs an ENCRYPTED
 * remote task that emits an authoritative final output (VIBE_MOCK_OUTPUT); the node
 * persists the AgentTaskResult in its journal and serves it over the encrypted
 * run_result_v1 protocol; the durable Gateway fetches + decrypts it and projects
 * result_status=available + the result on the public task API. In-process relay +
 * temporary DB; never touches production. Skips if the daemon can't register.
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
const RTOKEN = `rres-relay-${Math.random().toString(36).slice(2)}`
const API = `rres-api-${Math.random().toString(36).slice(2)}`
const NODE_ID = 'rres-node'
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
    const headers: Record<string, string> = { authorization: `Bearer ${API}` }; if (payload) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => { let b: any = null; try { b = JSON.parse(t) } catch { /* */ } resolve({ status: res.statusCode ?? 0, body: b }) }) })
    r.on('error', reject); if (payload) r.write(payload); r.end()
  })
}
async function waitField(port: number, id: string, pred: (b: any) => boolean, ms = 20000): Promise<any> {
  const end = Date.now() + ms
  while (Date.now() < end) { const r = await reqRaw(port, 'GET', `/v1/tasks/${id}`); if (r.body && pred(r.body)) return r.body; await delay(250) }
  throw new Error(`remote task ${id} did not satisfy predicate`)
}

test('encrypted remote result: node serves run_result_v1; gateway fetches + decrypts → result_status=available', async (t) => {
  const relay = await startRelayServer({ port: 0, token: RTOKEN })
  const relayUrl = `ws://127.0.0.1:${relay.port}`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rres-'))
  const dbPath = path.join(root, 'control.sqlite')
  process.env.VIBE_DIR = path.join(root, 'gateway'); fs.mkdirSync(process.env.VIBE_DIR, { recursive: true })
  const tokenFile = path.join(root, 'tok'); fs.writeFileSync(tokenFile, RTOKEN + '\n', { mode: 0o600 })
  const mockOut = JSON.stringify({ status: 'done', summary: 'remote authoritative result' })
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', NODE_ID], {
    env: { ...process.env, VIBE_DIR: path.join(root, 'node'), VIBE_RELAY_TOKEN: RTOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock', VIBE_MOCK_OUTPUT: mockOut }, stdio: 'ignore',
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
    const created = await reqRaw(gw.port, 'POST', '/v1/tasks', { agent: 'mock', node_id: NODE_ID, input: { text: 'do it' } })
    assert.equal(created.status, 202)
    const id = created.body.task_id
    // Wait until the task is completed AND the durable result has been fetched via
    // the encrypted run_result_v1 protocol and projected (available + result).
    const done = await waitField(gw.port, id, (b) => b.status === 'completed' && b.result_status === 'available' && !!b.result)
    assert.equal(done.result_status, 'available')
    assert.equal(done.result.final_output.text, mockOut, 'final output decrypted end-to-end matches the node result')
    assert.match(done.result.content_hash, /^[0-9a-f]{64}$/)
    // The result is durably persisted at the Gateway keyed by the PUBLIC task_id.
    assert.equal(store.getTaskResultDurable(id)?.result?.final_output.text, mockOut)
    // The Gateway public task_id is decoupled from the node's remote_run_id.
    assert.notEqual(store.getTaskRecord(id)?.remote_run_id, id)
  } finally {
    await cleanup()
  }
})
