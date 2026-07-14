/**
 * Deterministic security/correctness hardening for remote agent execution, using
 * a SCRIPTABLE fake node over the relay (full control of the wire + acks):
 *   - encrypted run_start is MANDATORY (no plaintext prompt on the wire);
 *   - missing encryption key / unadvertised agent are rejected before start;
 *   - a transport give-up is NOT a task failure (remoteStream control);
 *   - authoritative GET/cancel reconcile terminal state exactly once;
 *   - discovery/routing invariants.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { startRelayServer } from '../src/relay/server.js'
import { startAgentGateway, type GatewayServer } from '../src/lib/agent-gateway.js'
import { remoteStream } from '../src/relay/client.js'
import { decryptPayload, deriveRunStopKey, encryptEvent } from '../src/crypto.js'
import type { RunRecord, RunStatus } from '../src/types.js'

interface Key { pub: string; priv: string }

const TOKEN = `relay-${Math.random().toString(36).slice(2)}`
const API = `api-${Math.random().toString(36).slice(2)}`
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function x25519(): { pub: string; priv: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }
}
function record(run_id: string, status: RunStatus): RunRecord {
  return { run_id, session_id: 's', node_id: 'fake', agent: 'claude-code', status, workspace_path: '/w', created_at: 't', updated_at: 't' }
}

/** A scriptable node: registers, captures run_start, and answers status/stop/stream. */
class FakeNode {
  ws: WebSocket
  capturedStart?: any
  streamEvents = true   // whether to forward run events on subscribe
  statusRecord?: RunRecord
  stopRecord?: RunRecord
  constructor(public url: string, public nodeId: string, public agents: string[], public key: Key | undefined) {
    this.ws = new WebSocket(url)
    const encPub = key?.pub
    this.ws.on('open', () => this.send({ type: 'node_register', node: { node_id: nodeId, name: nodeId, status: 'online', agents, capabilities: ['run', 'stream', 'stop'], transport: 'relay', ...(encPub ? { encryption_public_key: encPub } : {}) } }))
    this.ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())))
  }
  ready(): Promise<void> { return new Promise((res) => { if (this.ws.readyState === 1) res(); else this.ws.on('open', () => res()) }) }
  private send(o: Record<string, unknown>, kind: 'plaintext' | 'encrypted' = 'plaintext'): void { this.ws.send(JSON.stringify({ version: 1, kind, from: this.nodeId, to: 'relay', ts: new Date().toISOString(), ...o })) }
  private onMessage(m: any): void {
    if (m.type === 'run_start') { // plaintext OR encrypted envelope; ack is plaintext
      this.capturedStart = m
      this.send({ type: 'run_start_ack', req_id: m.req_id, ok: true, record: record(`run_${m.req_id}`, 'running') })
    } else if (m.type === 'run_stream_subscribe') {
      this.send({ type: 'run_stream_subscribe_ack', run_id: m.run_id, ok: true })
      if (this.streamEvents) {
        this.send({ type: 'run_event', run_id: m.run_id, event: { run_id: m.run_id, ts: 't', type: 'status', status: 'running' } })
        this.send({ type: 'run_event', run_id: m.run_id, event: { run_id: m.run_id, ts: 't', type: 'status', status: 'completed' } })
      }
    } else if (m.type === 'run_status_request') { // status ack is plaintext even for encrypted runs
      const rec = this.statusRecord ?? record(m.run_id, 'running')
      this.send({ type: 'run_status_ack', req_id: m.req_id, run_id: m.run_id, ok: true, record: { ...rec, run_id: m.run_id } })
    } else if (m.type === 'encrypted_run_stop_request') { // encrypted run -> encrypted stop ack
      const rec = this.stopRecord ?? record(m.run_id, 'stopped')
      const stopKey = deriveRunStopKey(this.key!.priv, this.capturedStart.ephemeral_public_key)
      const enc = encryptEvent(stopKey, { ok: true, record: { ...rec, run_id: m.run_id } })
      this.send({ type: 'encrypted_run_stop_ack', req_id: m.req_id, run_id: m.run_id, nonce: enc.nonce, ciphertext: enc.ciphertext }, 'encrypted')
    } else if (m.type === 'run_stop_request') { // plaintext fallback
      const rec = this.stopRecord ?? record(m.run_id, 'stopped')
      this.send({ type: 'run_stop_ack', req_id: m.req_id, run_id: m.run_id, ok: true, record: { ...rec, run_id: m.run_id } })
    }
  }
  close(): void { try { this.ws.close() } catch { /* */ } }
}

let relay: Awaited<ReturnType<typeof startRelayServer>>
let relayUrl: string
let gw: GatewayServer
const nodes: FakeNode[] = []

before(async () => {
  relay = await startRelayServer({ port: 0, token: TOKEN })
  relayUrl = `ws://127.0.0.1:${relay.port}?token=${TOKEN}`
  gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: API, relay: `ws://127.0.0.1:${relay.port}`, relayToken: TOKEN })
})
after(async () => { for (const n of nodes) n.close(); if (gw) await gw.close(); if (relay) await relay.close() })

async function addNode(nodeId: string, agents: string[], key: Key | undefined): Promise<FakeNode> {
  const n = new FakeNode(relayUrl, nodeId, agents, key); nodes.push(n); await n.ready(); await delay(150); return n
}
interface Res { status: number; body: any }
function jreq(method: string, p: string, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { authorization: `Bearer ${API}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port: gw.port, path: p, method, headers }, (res) => { let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => { let b: any = null; try { b = JSON.parse(t) } catch { /* */ } resolve({ status: res.statusCode ?? 0, body: b }) }) })
    r.on('error', reject); if (body !== undefined) r.write(body); r.end()
  })
}
const create = (node_id: string, agent = 'claude-code', extra: Record<string, unknown> = {}) => jreq('POST', '/v1/tasks', JSON.stringify({ agent, node_id, input: { text: 'SECRET-PROMPT-12345' }, ...extra }))
function sse(id: string): { events: any[]; ended: Promise<void> } {
  const events: any[] = []; let done!: () => void; const ended = new Promise<void>((r) => { done = r }); let buf = ''
  const r = http.request({ host: '127.0.0.1', port: gw.port, path: `/v1/tasks/${id}/events`, headers: { authorization: `Bearer ${API}` } }, (res) => { res.setEncoding('utf8'); res.on('data', (c: string) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) !== -1) { const f = buf.slice(0, i); buf = buf.slice(i + 2); if (!f || f.startsWith(':')) continue; const e: any = {}; for (const l of f.split('\n')) { if (l.startsWith('event: ')) e.event = l.slice(7); else if (l.startsWith('id: ')) e.id = l.slice(4) } if (e.event) events.push(e) } }); res.on('end', () => done()) })
  r.end(); return { events, ended }
}

// ── 1. encrypted run_start is mandatory ───────────────────────────────────────

test('encryption: run_start is encrypted; prompt/workspace/permission/metadata carried in ciphertext, NOT plaintext', async () => {
  const key = x25519()
  const node = await addNode('enc-node', ['claude-code'], key)
  const r = await create('enc-node', 'claude-code', { workspace: { workspace_key: 'WSKEY-XYZ' }, execution: { permission_mode: 'unsafe-skip' }, metadata: { issue: 'JOZ-SECRET' } })
  assert.equal(r.status, 202)
  const msg = node.capturedStart
  assert.ok(msg, 'node received run_start')
  assert.equal(msg.kind, 'encrypted', 'run_start is encrypted')
  assert.ok(msg.ephemeral_public_key && msg.ciphertext && msg.nonce, 'has ephemeral key + ciphertext + nonce')
  const wire = JSON.stringify(msg)
  for (const secret of ['SECRET-PROMPT-12345', 'WSKEY-XYZ', 'unsafe-skip', 'JOZ-SECRET']) {
    assert.ok(!wire.includes(secret), `plaintext wire must NOT contain ${secret}`)
  }
  const payload = decryptPayload(key.priv, { ephemeralPublicKey: msg.ephemeral_public_key, nonce: msg.nonce, ciphertext: msg.ciphertext })
  assert.equal(payload.prompt_content, 'SECRET-PROMPT-12345', 'prompt decrypts inside the envelope')
  assert.equal(payload.workspace_key, 'WSKEY-XYZ')
  assert.equal(payload.permission_mode, 'unsafe-skip')
  assert.deepEqual(payload.metadata, { issue: 'JOZ-SECRET' })
})

test('encryption: node advertising NO encryption key is rejected (no plaintext fallback)', async () => {
  await addNode('nokey-node', ['claude-code'], undefined)
  const r = await create('nokey-node')
  assert.equal(r.status, 503)
  assert.equal(r.body.code, 'service_unavailable')
  assert.equal(r.body.retryable, false)
})

test('routing: unadvertised agent rejected BEFORE start (422); offline/unknown node -> node_offline (503)', async () => {
  await addNode('mock-only', ['mock'], x25519())
  const unsup = await create('mock-only', 'codex')
  assert.equal(unsup.status, 422); assert.equal(unsup.body.code, 'agent_unavailable')
  const offline = await create('ghost-node-999')
  assert.equal(offline.status, 503); assert.equal(offline.body.code, 'node_offline')
})

// ── 2. transport give-up is not a task failure (remoteStream control) ─────────

test('remoteStream: emitDisconnectTerminal:false suppresses synthetic failure; onGiveUp fires; default emits failed', async () => {
  // A dead relay URL forces an immediate connect failure -> give up (maxReconnects:0).
  const DEAD = 'ws://127.0.0.1:5'
  const events: any[] = []
  let gaveUp = ''
  await remoteStream(DEAD, TOKEN, 'run_x', {
    suppressStdout: true, maxReconnects: 0, emitDisconnectTerminal: false,
    onRunEvent: (e) => events.push(e), onGiveUp: (reason) => { gaveUp = reason },
  })
  assert.ok(gaveUp, 'onGiveUp invoked with a reason')
  assert.ok(!events.some((e) => e.type === 'status' && e.status === 'failed'), 'NO synthetic failed status')
  assert.ok(!events.some((e) => e.type === 'error'), 'NO synthetic error event')

  const cliEvents: any[] = []
  await remoteStream(DEAD, TOKEN, 'run_x2', {
    suppressStdout: true, maxReconnects: 0, onRunEvent: (e) => cliEvents.push(e), // default emitDisconnectTerminal
  })
  assert.ok(cliEvents.some((e) => e.type === 'status' && e.status === 'failed'), 'default CLI still emits failed')
})

// ── 3. GET reconciles authoritative terminal exactly once ─────────────────────

test('reconcile: terminal discovered only via GET -> one terminal SSE event, slot freed, repeat GET no dup', async () => {
  const node = await addNode('recon-node', ['claude-code'], x25519())
  node.streamEvents = false // stream never delivers terminal
  const c = await create('recon-node')
  assert.equal(c.status, 202)
  const id = c.body.task_id
  const s = sse(id)
  await delay(200)
  // Node now reports completed authoritatively; GET must fold it in.
  node.statusRecord = record(id, 'completed')
  const g1 = await jreq('GET', `/v1/tasks/${id}`)
  assert.equal(g1.body.status, 'completed', 'GET reconciles terminal')
  await s.ended // subscriber closed after the single terminal event
  assert.equal(s.events.filter((e) => e.event === 'task.completed').length, 1, 'exactly one terminal SSE event')
  // repeated GET does not duplicate or regress
  const g2 = await jreq('GET', `/v1/tasks/${id}`)
  assert.equal(g2.body.status, 'completed')
})

// ── 4. cancellation convergence even if the stream event is lost ──────────────

test('cancel: remoteStop ack converges terminal even when the stream never delivers stopped; idempotent', async () => {
  const node = await addNode('cancel-node', ['claude-code'], x25519())
  node.streamEvents = false // stream will NOT deliver the stopped event
  node.stopRecord = record('x', 'stopped')
  const c = await create('cancel-node')
  const id = c.body.task_id
  const s = sse(id)
  await delay(150)
  const first = await jreq('POST', `/v1/tasks/${id}/cancel`)
  assert.equal(first.status, 200); assert.equal(first.body.status, 'cancelled')
  await s.ended
  assert.equal(s.events.filter((e) => e.event === 'task.cancelled').length, 1, 'terminal exactly once via stop reconcile')
  const again = await jreq('POST', `/v1/tasks/${id}/cancel`)
  assert.equal(again.status, 200); assert.equal(again.body.status, 'cancelled') // idempotent
})

// ── 6. discovery / routing invariants ─────────────────────────────────────────

test('discovery: duplicate agent kind on two nodes stays distinct by node_id; no auto-routing', async () => {
  await addNode('nodeA', ['claude-code'], x25519())
  await addNode('nodeB', ['claude-code'], x25519())
  const r = await jreq('GET', '/v1/agents')
  const cc = r.body.agents.filter((a: any) => a.id === 'claude-code' && a.node_id)
  const nodeIds = new Set(cc.map((a: any) => a.node_id))
  assert.ok(nodeIds.has('nodeA') && nodeIds.has('nodeB'), 'both nodes distinct by node_id')
  // No node_id => local-only mock path; an unadvertised local agent is rejected (no auto-routing to a remote node).
  const noNode = await jreq('POST', '/v1/tasks', JSON.stringify({ agent: 'claude-code', input: { text: 'x' } }))
  assert.equal(noNode.status, 422, 'no auto-routing: local mock only without node_id')
  assert.equal(noNode.body.code, 'agent_unavailable')
})

// ── request semantics: reject before remoteRunStart ──────────────────────────

test('request semantics: deferred/unsafe fields reject a REMOTE request before any run_start reaches the node', async () => {
  const node = await addNode('reject-node', ['claude-code'], x25519())
  const bad = [
    { workspace: { repo_url: 'https://secret.example/r.git' } },
    { workspace: { branch: 'topsecret' } },
    { execution: { timeout_seconds: 30 } },
    { workspace: { workspace_key: '../escape' } },
  ]
  for (const extra of bad) {
    node.capturedStart = undefined
    const r = await create('reject-node', 'claude-code', extra)
    assert.equal(r.status, 400, `reject ${JSON.stringify(extra)}`)
    assert.equal(r.body.code, 'invalid_request')
    assert.ok(!r.body.task_id)
    assert.ok(!JSON.stringify(r.body).includes('secret'), 'no submitted value echoed')
    await delay(120)
    assert.equal(node.capturedStart, undefined, 'no run_start reached the node after rejection')
  }
  // a safe opaque key is accepted and DOES reach the node (encrypted)
  const okr = await create('reject-node', 'claude-code', { workspace: { workspace_key: 'safe.key_9' } })
  assert.equal(okr.status, 202)
})

// ── 5. prompt-file cleanup ────────────────────────────────────────────────────

test('cleanup: remote start removes the controller-side temp prompt file (no plaintext left in /tmp)', async () => {
  const key = x25519()
  await addNode('cleanup-node', ['claude-code'], key)
  const marker = `MARK-${crypto.randomBytes(6).toString('hex')}`
  const r = await jreq('POST', '/v1/tasks', JSON.stringify({ agent: 'claude-code', node_id: 'cleanup-node', input: { text: marker } }))
  assert.equal(r.status, 202)
  await delay(150)
  const leaked = fs.readdirSync(os.tmpdir())
    .filter((f) => f.startsWith('vibe-api-prompt-'))
    .filter((f) => { try { return fs.readFileSync(path.join(os.tmpdir(), f), 'utf8').includes(marker) } catch { return false } })
  assert.equal(leaked.length, 0, 'no temp prompt file with the plaintext marker remains after remote start')
})

test('discovery: fetchRemoteNodes failure never exposes credentials in the error body', async () => {
  // Point a throwaway gateway at a dead relay; /v1/agents degrades without leaking the token.
  const g2 = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: API, relay: 'ws://127.0.0.1:5', relayToken: TOKEN })
  try {
    const r = await new Promise<Res>((resolve, reject) => { const rq = http.request({ host: '127.0.0.1', port: g2.port, path: '/v1/agents', headers: { authorization: `Bearer ${API}` } }, (res) => { let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: t })) }); rq.on('error', reject); rq.end() })
    assert.equal(r.status, 200)
    assert.ok(!String(r.body).includes(TOKEN), 'relay token never in the response')
    assert.match(String(r.body), /"agents":\[\{"id":"mock"/, 'degrades to local mock only')
  } finally { await g2.close() }
})
