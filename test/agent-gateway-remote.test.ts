/**
 * Remote agent execution through the Agent Task API: POST -> remoteRunStart,
 * SSE <- remoteStream, GET <- remoteRunStatus, cancel -> remoteStop, over an
 * in-process relay + a real spawned mock node daemon. No second remote protocol —
 * reuses the existing vibe run remote contract. Skips if the daemon can't register.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startRelayServer } from '../src/relay/server.js'
import { startAgentGateway, type GatewayServer } from '../src/lib/agent-gateway.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TOKEN = `relay-tok-${Math.random().toString(36).slice(2)}`
const API = `api-tok-${Math.random().toString(36).slice(2)}`
const NODE_ID = 'gw-remote-node'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Live { server: Awaited<ReturnType<typeof startRelayServer>>; daemon: ReturnType<typeof spawn>; vibeDir: string; tokenFile: string }
let live: Live | undefined
let gw: GatewayServer

function vibe(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''; p.stdout!.on('data', (d: Buffer) => { out += d.toString() })
    p.on('close', () => resolve(out))
    setTimeout(() => { p.kill('SIGKILL'); resolve(out) }, timeoutMs)
  })
}

before(async () => {
  const server = await startRelayServer({ port: 0, token: TOKEN })
  const relayUrl = `ws://127.0.0.1:${server.port}`
  const vibeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-gwr-'))
  process.env.VIBE_DIR = path.join(vibeDir, 'gateway') // gateway's own dir
  fs.mkdirSync(process.env.VIBE_DIR, { recursive: true })
  const tokenFile = path.join(vibeDir, 'tok'); fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 })
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', NODE_ID], {
    env: { ...process.env, VIBE_DIR: path.join(vibeDir, 'node'), VIBE_RELAY_TOKEN: TOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock', VIBE_MOCK_RUN_MS: '700' },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 9000
  let up = false
  while (Date.now() < deadline && !up) {
    await delay(300)
    try { if (JSON.parse((await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', tokenFile, '--json'], { ...process.env })).trim()).some((n: { node_id: string }) => n.node_id === NODE_ID)) up = true } catch { /* not ready */ }
  }
  if (!up) { daemon.kill('SIGKILL'); await server.close(); return }
  live = { server, daemon, vibeDir, tokenFile }
  gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: API, relay: relayUrl, relayToken: TOKEN })
})

after(async () => {
  if (gw) await gw.close()
  if (live) { if (!live.daemon.killed) live.daemon.kill('SIGKILL'); await delay(200); await live.server.close() }
})

interface Res { status: number; body: any; text: string }
function jreq(method: string, p: string, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { authorization: `Bearer ${API}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port: gw.port, path: p, method, headers }, (res) => {
      let text = ''; res.on('data', (d) => { text += d }); res.on('end', () => { let b: any = null; try { b = JSON.parse(text) } catch { /* */ } resolve({ status: res.statusCode ?? 0, body: b, text }) })
    })
    r.on('error', reject); if (body !== undefined) r.write(body); r.end()
  })
}
const createRemote = (over: Record<string, unknown> = {}) => jreq('POST', '/v1/tasks', JSON.stringify({ agent: 'mock', node_id: NODE_ID, input: { text: 'remote work' }, ...over }))
async function waitStatus(id: string, want: string, ms = 12000): Promise<any> {
  const end = Date.now() + ms
  while (Date.now() < end) { const r = await jreq('GET', `/v1/tasks/${id}`); if (r.body?.status === want) return r.body; await delay(200) }
  throw new Error(`remote task ${id} did not reach ${want}`)
}
function openSse(id: string): { events: { id?: string; event?: string; data?: any }[]; ended: Promise<void>; destroy: () => void } {
  const events: { id?: string; event?: string; data?: any }[] = []
  let buf = ''; let endResolve!: () => void
  const ended = new Promise<void>((r) => { endResolve = r })
  const r = http.request({ host: '127.0.0.1', port: gw.port, path: `/v1/tasks/${id}/events`, headers: { authorization: `Bearer ${API}` } }, (res) => {
    res.setEncoding('utf8')
    res.on('data', (c: string) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) !== -1) { const f = buf.slice(0, i); buf = buf.slice(i + 2); if (!f || f.startsWith(':')) continue; const ev: any = {}; for (const l of f.split('\n')) { if (l.startsWith('id: ')) ev.id = l.slice(4); else if (l.startsWith('event: ')) ev.event = l.slice(7); else if (l.startsWith('data: ')) { try { ev.data = JSON.parse(l.slice(6)) } catch { /* */ } } } if (ev.event) events.push(ev) } })
    res.on('end', () => endResolve())
  })
  r.on('error', () => endResolve()); r.end()
  return { events, ended, destroy: () => r.destroy() }
}

test('remote: POST routes to remoteRunStart -> 202 canonical Task on the node', () => {
  if (!live) return
  return (async () => {
    const c = await createRemote()
    assert.equal(c.status, 202)
    assert.equal(c.body.agent, 'mock')
    assert.equal(c.body.node_id, NODE_ID)
    assert.equal(typeof c.body.task_id, 'string')
  })()
})

test('remote: SSE streams canonical task events incl. terminal exactly once; GET reaches completed', { timeout: 20000 }, async () => {
  if (!live) return
  const c = await createRemote()
  const s = openSse(c.body.task_id)
  await s.ended
  const types = s.events.map((e) => e.event)
  assert.ok(types.includes('task.created'), 'task.created present')
  assert.ok(types.includes('task.completed'), 'terminal present')
  assert.equal(types.filter((t) => t === 'task.completed').length, 1, 'terminal exactly once')
  const ids = s.events.map((e) => Number(e.id))
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], 'monotonic seq')
  const done = await waitStatus(c.body.task_id, 'completed')
  assert.equal(done.status, 'completed')
})

test('remote: cancel -> remoteStop; task ends cancelled; idempotent', { timeout: 20000 }, async () => {
  if (!live) return
  const c = await createRemote()
  await delay(150)
  const cancel = await jreq('POST', `/v1/tasks/${c.body.task_id}/cancel`)
  assert.equal(cancel.status, 200)
  assert.ok(['cancelled', 'completed'].includes(cancel.body.status), 'terminal after cancel')
  const again = await jreq('POST', `/v1/tasks/${c.body.task_id}/cancel`)
  assert.equal(again.status, 200, 'idempotent')
})

test('remote: offline/unknown node -> 503 node_offline (structured remote error)', async () => {
  if (!live) return
  const r = await createRemote({ node_id: 'node_not_registered_xyz' })
  assert.equal(r.status, 503)
  assert.equal(r.body.code, 'node_offline')
  assert.equal(r.body.retryable, true)
})

test('remote: unsupported agent on the node -> agent_unavailable (422)', { timeout: 15000 }, async () => {
  if (!live) return
  const r = await createRemote({ agent: 'codex' }) // node advertises mock only
  assert.equal(r.status, 422)
  assert.equal(r.body.code, 'agent_unavailable')
})

test('remote: GET /v1/agents lists the online node\'s advertised agents + local mock', async () => {
  if (!live) return
  const r = await jreq('GET', '/v1/agents')
  assert.equal(r.status, 200)
  const ids = r.body.agents.map((a: { id: string }) => a.id)
  assert.ok(ids.includes('mock'))
  const remoteMock = r.body.agents.find((a: { id: string; node_id?: string }) => a.node_id === NODE_ID)
  assert.ok(remoteMock, 'remote node agent present with node_id')
})

test('remote: node_id rejected when the gateway is NOT relay-configured (invalid_request)', async () => {
  // A separate local-only gateway (no relay) must reject remote routing.
  const localOnly = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: API })
  try {
    const r = await new Promise<Res>((resolve, reject) => {
      const body = JSON.stringify({ agent: 'mock', node_id: 'node_x', input: { text: 'x' } })
      const rq = http.request({ host: '127.0.0.1', port: localOnly.port, path: '/v1/tasks', method: 'POST', headers: { authorization: `Bearer ${API}`, 'content-type': 'application/json' } }, (res) => { let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(t), text: t })) })
      rq.on('error', reject); rq.write(body); rq.end()
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'invalid_request')
  } finally { await localOnly.close() }
})
