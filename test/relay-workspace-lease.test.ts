/**
 * Relay-level regression for workspace-lease RPC routing — the ACTUAL production
 * boundary (the deployed relay silently dropped `workspace_lease_*` because its
 * switch lacked the cases + a `default`). These tests run a real in-process relay
 * with a real upstream client WS and a Node stub WS, and assert the relay forwards
 * each lease request to the selected Node (preserving node_id/req_id/payload), routes
 * the Node ack back to the ORIGINATING client by req_id (and to no one else), and
 * fails an unsupported request FAST with a structured relay_error.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import type { RelayMessage } from '../src/relay/types.js'
import type { VibeNode } from '../src/types.js'
import { startRelayServer } from '../src/relay/server.js'

const TOKEN = `tok-${Date.now()}`
const now = () => new Date().toISOString()
const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg))

async function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.on('open', () => resolve(ws)); ws.on('error', reject) })
}
async function waitForMsg(ws: WebSocket, pred: (m: RelayMessage) => boolean, timeoutMs = 3000): Promise<RelayMessage> {
  return new Promise((resolve, reject) => {
    let settled = false
    const t = setTimeout(() => { if (!settled) { settled = true; ws.off('message', h); reject(new Error('timeout')) } }, timeoutMs)
    const h = (raw: Buffer) => { try { const m = JSON.parse(raw.toString()) as RelayMessage; if (pred(m)) { if (!settled) { settled = true; clearTimeout(t); ws.off('message', h); resolve(m) } } } catch { /* */ } }
    ws.on('message', h)
  })
}
/** Assert NO message matching `pred` arrives within `ms` (isolation / silent-drop check). */
async function assertNoMsg(ws: WebSocket, pred: (m: RelayMessage) => boolean, ms = 400): Promise<void> {
  await assert.rejects(waitForMsg(ws, pred, ms), /timeout/, 'expected no matching message')
}
const node = (id: string): VibeNode => ({ node_id: id, name: 'stub', status: 'online', transport: 'relay', capabilities: ['run', 'stream', 'stop', 'workspace', 'workspace_lease_v1'], agents: ['mock'], active_runs: 0, max_runs: 2, workspace_roots: ['/tmp'], created_at: now(), updated_at: now() })
async function registerNode(ws: WebSocket, id: string): Promise<void> {
  const ackP = waitForMsg(ws, (m) => m.type === 'node_register_ack')
  send(ws, { version: 1, kind: 'plaintext', from: id, to: 'relay', ts: now(), type: 'node_register', node: node(id) })
  await ackP
}

async function withRelay(fn: (ctx: { url: string; cli: WebSocket; cli2: WebSocket; nodeWs: WebSocket; nodeId: string }) => Promise<void>): Promise<void> {
  const server = await startRelayServer({ port: 0, token: TOKEN })
  const url = `ws://localhost:${server.port}?token=${TOKEN}`
  const nodeId = 'node_stub_1'
  const cli = await connect(url), cli2 = await connect(url), nodeWs = await connect(url)
  await registerNode(nodeWs, nodeId)
  try { await fn({ url, cli, cli2, nodeWs, nodeId }) }
  finally { for (const w of [cli, cli2, nodeWs]) { try { w.close() } catch { /* */ } } await server.close() }
}

// ── 1. table-driven lease routing + correlation + isolation ───────────────────
interface Case { name: string; reqType: string; ackType: string; extra: Record<string, unknown>; ackFields: Record<string, unknown> }
const CASES: Case[] = [
  { name: 'workspace_lease_acquire', reqType: 'workspace_lease_acquire', ackType: 'workspace_lease_ack', extra: { workflow_id: 'wf_a', workspace_key: 'ws-key', mode: 'exclusive' }, ackFields: { ok: true, created: true, lease: { workspace_lease_id: 'wl_1', workflow_id: 'wf_a' } } },
  { name: 'workspace_lease_get', reqType: 'workspace_lease_get', ackType: 'workspace_lease_ack', extra: { workspace_lease_id: 'wl_1' }, ackFields: { ok: true, lease: { workspace_lease_id: 'wl_1', workflow_id: 'wf_a' } } },
  { name: 'workspace_lease_release', reqType: 'workspace_lease_release', ackType: 'workspace_lease_ack', extra: { workspace_lease_id: 'wl_1' }, ackFields: { ok: true, lease: { workspace_lease_id: 'wl_1', status: 'released' } } },
  { name: 'workspace_lease_observe (workspace_revision_observe)', reqType: 'workspace_revision_observe', ackType: 'workspace_revision_ack', extra: { workspace_key: 'ws-key' }, ackFields: { ok: true, revision: { revision_kind: 'git', state_hash: 'h' } } },
]

for (const c of CASES) {
  test(`relay routes ${c.name}: forwarded to the node (node_id/req_id/payload preserved) + ack back to the originating client only`, async () => {
    await withRelay(async ({ cli, cli2, nodeWs, nodeId }) => {
      const reqId = `req_${c.reqType}_${Math.random().toString(16).slice(2)}`
      // the node stub echoes an ack for the exact req_id it received
      const forwardedP = waitForMsg(nodeWs, (m) => (m as { type?: string }).type === c.reqType)
      const ackP = waitForMsg(cli, (m) => (m as { type?: string }).type === c.ackType && (m as { req_id?: string }).req_id === reqId)
      const cli2Silent = assertNoMsg(cli2, (m) => (m as { req_id?: string }).req_id === reqId) // no unrelated client sees it

      send(cli, { version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: now(), type: c.reqType, req_id: reqId, node_id: nodeId, ...c.extra })

      const forwarded = await forwardedP as unknown as Record<string, unknown>
      // forwarded verbatim: node_id, req_id, and the request payload are preserved
      assert.equal(forwarded.type, c.reqType)
      assert.equal(forwarded.node_id, nodeId)
      assert.equal(forwarded.req_id, reqId)
      for (const [k, v] of Object.entries(c.extra)) assert.deepEqual(forwarded[k], v)

      // node replies; relay routes the ack back to the ORIGINATING client by req_id
      send(nodeWs, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: now(), type: c.ackType, req_id: reqId, ...c.ackFields })
      const ack = await ackP as unknown as Record<string, unknown>
      assert.equal(ack.req_id, reqId)            // same-req_id correlation
      assert.equal(ack.ok, true)
      await cli2Silent                            // the other client got nothing
    })
  })
}

// ── 2. unknown request → one structured relay_error, node never receives it ───
test('relay fails an unsupported request FAST with a structured relay_error (matching req_id); the node never receives it', async () => {
  await withRelay(async ({ cli, nodeWs, nodeId }) => {
    const reqId = `req_unknown_${Math.random().toString(16).slice(2)}`
    const errP = waitForMsg(cli, (m) => (m as { type?: string }).type === 'relay_error' && (m as { req_id?: string }).req_id === reqId)
    const nodeSilent = assertNoMsg(nodeWs, (m) => (m as { req_id?: string }).req_id === reqId) // node must NOT receive the unsupported request

    send(cli, { version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: now(), type: 'workspace_lease_totally_unsupported', req_id: reqId, node_id: nodeId })

    const err = await errP as unknown as Record<string, unknown>
    assert.equal(err.type, 'relay_error')
    assert.equal(err.req_id, reqId)             // fail-fast, correlated — not a silent timeout
    assert.equal(err.ok, false)
    assert.equal(err.code, 'unsupported_request')
    await nodeSilent
  })
})
