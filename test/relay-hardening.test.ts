/**
 * Relay hardening tests — pairing persistence + multi-token grace window.
 *
 * Pairing persistence: under `--require-pairing` the relay used to keep paired
 * identities in memory only, so a restart dropped them and the node could not
 * register until `vibe node pair` was re-run. These tests pin that a configured
 * pairings file lets a paired node register again after the relay is recreated,
 * that an unpaired node is still rejected, and that the file holds no token.
 *
 * Token grace: the relay must accept the union of every configured token so a
 * token can be rotated without downtime (old + new both valid during the
 * window). These tests pin old/new accepted, invalid rejected, and the
 * env-based resolver.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startRelayServer } from '../src/relay/server.js'
import { generateEd25519, generateX25519, signEnvelope } from '../src/crypto.js'
import { loadPairings } from '../src/relay/pairing-store.js'
import {
  resolveRelayServerTokens,
  RELAY_TOKEN_ENV,
  RELAY_TOKEN_ENV_CURRENT,
  RELAY_TOKEN_ENV_NEXT,
  RELAY_TOKENS_ENV,
} from '../src/relay/token.js'
import type { PublicIdentity } from '../src/identity.js'
import type { RelayMessage } from '../src/relay/types.js'
import type { VibeNode } from '../src/types.js'

function now(): string { return new Date().toISOString() }

async function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function send(ws: WebSocket, msg: RelayMessage): void { ws.send(JSON.stringify(msg)) }

async function waitForMsg(
  ws: WebSocket,
  predicate: (m: RelayMessage) => boolean,
  timeoutMs = 4000,
): Promise<RelayMessage> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs)
    const handler = (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (predicate(msg)) { clearTimeout(t); ws.off('message', handler); resolve(msg) }
      } catch {}
    }
    ws.on('message', handler)
  })
}

/** A self-contained test identity (no disk writes, distinct from the real ~/.vibe identity). */
function makeIdentity(nodeId: string): { pub: PublicIdentity; privB64: string } {
  const signing = generateEd25519()
  const encryption = generateX25519()
  const pub: PublicIdentity = {
    version: 1,
    kind: 'node',
    id: nodeId,
    display_name: 'test-node',
    signing_alg: 'Ed25519',
    signing_public_key: signing.publicKey.toString('base64'),
    encryption_alg: 'X25519',
    encryption_public_key: encryption.publicKey.toString('base64'),
    fingerprint: `fp-${nodeId}`,
  }
  return { pub, privB64: signing.privateKey.toString('base64') }
}

function makeNode(nodeId: string): VibeNode {
  return {
    node_id: nodeId, name: 'Test Node', status: 'online', transport: 'relay',
    capabilities: ['run'], agents: ['mock'], active_runs: 0, max_runs: 1,
    workspace_roots: ['/tmp'], created_at: now(), updated_at: now(),
  }
}

async function pair(ws: WebSocket, pub: PublicIdentity): Promise<boolean> {
  const ackP = waitForMsg(ws, (m) => m.type === 'node_pair_ack')
  send(ws, { version: 1, kind: 'plaintext', from: pub.id, to: 'relay', ts: now(), type: 'node_pair_request', identity: pub })
  const ack = await ackP
  return (ack as any).ok === true
}

/** Send a correctly-signed node_register and return the ack's ok flag. */
async function registerSigned(ws: WebSocket, nodeId: string, privB64: string): Promise<boolean> {
  const regMsg = {
    version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: now(),
    type: 'node_register', node: makeNode(nodeId),
  } as unknown as Record<string, unknown>
  const signature = signEnvelope(privB64, nodeId, regMsg)
  const ackP = waitForMsg(ws, (m) => m.type === 'node_register_ack')
  ws.send(JSON.stringify({ ...regMsg, signature }))
  const ack = await ackP
  return (ack as any).ok === true
}

const TOKEN = `tok-secret-${Date.now()}`

function tmpPairingsFile(): string {
  return path.join(os.tmpdir(), `vibe-relay-pairings-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
}

// ── pairing persistence ──────────────────────────────────────────────────────

test('pairing persistence: paired node registers after relay restart (no re-pair)', async () => {
  const file = tmpPairingsFile()
  const { pub, privB64 } = makeIdentity('node_persist_a')
  try {
    // First relay instance: pair the node.
    const s1 = await startRelayServer({ port: 0, token: TOKEN, requirePairing: true, pairingsFile: file })
    const ws1 = await connect(`ws://127.0.0.1:${s1.port}?token=${TOKEN}`)
    assert.equal(await pair(ws1, pub), true, 'pair acked ok')
    ws1.terminate()
    await s1.close()

    assert.ok(fs.existsSync(file), 'pairings file written to disk')

    // Second relay instance loading the SAME file: the node registers with no re-pair.
    const s2 = await startRelayServer({ port: 0, token: TOKEN, requirePairing: true, pairingsFile: file })
    const ws2 = await connect(`ws://127.0.0.1:${s2.port}?token=${TOKEN}`)
    assert.equal(await registerSigned(ws2, pub.id, privB64), true, 'register ok after restart without re-pairing')
    ws2.terminate()
    await s2.close()
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('pairing persistence: unpaired node still rejected after restart', async () => {
  const file = tmpPairingsFile()
  const { pub } = makeIdentity('node_persist_b')
  const stranger = makeIdentity('node_stranger')
  try {
    const s1 = await startRelayServer({ port: 0, token: TOKEN, requirePairing: true, pairingsFile: file })
    const ws1 = await connect(`ws://127.0.0.1:${s1.port}?token=${TOKEN}`)
    await pair(ws1, pub) // pair only node_persist_b
    ws1.terminate()
    await s1.close()

    const s2 = await startRelayServer({ port: 0, token: TOKEN, requirePairing: true, pairingsFile: file })
    const ws2 = await connect(`ws://127.0.0.1:${s2.port}?token=${TOKEN}`)
    // A different, never-paired node must be rejected even though the file loaded.
    assert.equal(await registerSigned(ws2, stranger.pub.id, stranger.privB64), false, 'unpaired stranger rejected')
    ws2.terminate()
    await s2.close()
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('pairing persistence: file contains identity but NOT the relay token', async () => {
  const file = tmpPairingsFile()
  const { pub } = makeIdentity('node_no_token')
  try {
    const s1 = await startRelayServer({ port: 0, token: TOKEN, requirePairing: true, pairingsFile: file })
    const ws1 = await connect(`ws://127.0.0.1:${s1.port}?token=${TOKEN}`)
    await pair(ws1, pub)
    ws1.terminate()
    await s1.close()

    const raw = fs.readFileSync(file, 'utf8')
    assert.ok(raw.includes('node_no_token'), 'file records the paired node_id')
    assert.ok(raw.includes(pub.signing_public_key), 'file records the public signing key')
    assert.doesNotMatch(raw, new RegExp(TOKEN), 'relay auth token must NOT appear in the pairings file')
    assert.doesNotMatch(raw, /private/i, 'no private-key material in the pairings file')

    // loadPairings round-trips the identity.
    const loaded = loadPairings(file)
    assert.equal(loaded.get('node_no_token')?.signing_public_key, pub.signing_public_key)
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('pairing persistence: in-memory only when no file configured (legacy behaviour)', async () => {
  // No pairingsFile → a recreated relay has zero pairings (old behaviour preserved).
  const { pub, privB64 } = makeIdentity('node_inmem')
  const s1 = await startRelayServer({ port: 0, token: TOKEN, requirePairing: true })
  const ws1 = await connect(`ws://127.0.0.1:${s1.port}?token=${TOKEN}`)
  await pair(ws1, pub)
  ws1.terminate()
  await s1.close()

  const s2 = await startRelayServer({ port: 0, token: TOKEN, requirePairing: true })
  const ws2 = await connect(`ws://127.0.0.1:${s2.port}?token=${TOKEN}`)
  assert.equal(await registerSigned(ws2, pub.id, privB64), false, 'without persistence, restart drops pairing')
  ws2.terminate()
  await s2.close()
})

// ── multi-token grace window ─────────────────────────────────────────────────

test('token grace: relay accepts both current and next tokens; rejects others', async () => {
  const OLD = 'tok-old-aaaa'
  const NEW = 'tok-new-bbbb'
  const server = await startRelayServer({ port: 0, token: OLD, tokens: [OLD, NEW] })
  try {
    // Old token connects.
    const wsOld = await connect(`ws://127.0.0.1:${server.port}?token=${OLD}`)
    assert.equal(wsOld.readyState, WebSocket.OPEN, 'old token accepted')
    wsOld.terminate()

    // New token connects.
    const wsNew = await connect(`ws://127.0.0.1:${server.port}?token=${NEW}`)
    assert.equal(wsNew.readyState, WebSocket.OPEN, 'new token accepted')
    wsNew.terminate()

    // Wrong token rejected at the HTTP upgrade (401).
    await assert.rejects(
      connect(`ws://127.0.0.1:${server.port}?token=tok-bogus`),
      /401|Unexpected server response/,
      'invalid token rejected',
    )
    // Missing token rejected.
    await assert.rejects(
      connect(`ws://127.0.0.1:${server.port}`),
      /401|Unexpected server response/,
      'missing token rejected',
    )
  } finally {
    await server.close()
  }
})

test('token grace: single token (no tokens[]) stays backward compatible', async () => {
  const server = await startRelayServer({ port: 0, token: TOKEN })
  try {
    const ws = await connect(`ws://127.0.0.1:${server.port}?token=${TOKEN}`)
    assert.equal(ws.readyState, WebSocket.OPEN, 'sole token still accepted')
    ws.terminate()
    await assert.rejects(connect(`ws://127.0.0.1:${server.port}?token=nope`), /401|Unexpected server response/)
  } finally {
    await server.close()
  }
})

// ── server-side token resolver ───────────────────────────────────────────────

test('resolveRelayServerTokens: unions CURRENT + NEXT, trims, de-dupes', () => {
  const saved = {
    [RELAY_TOKEN_ENV]: process.env[RELAY_TOKEN_ENV],
    [RELAY_TOKEN_ENV_CURRENT]: process.env[RELAY_TOKEN_ENV_CURRENT],
    [RELAY_TOKEN_ENV_NEXT]: process.env[RELAY_TOKEN_ENV_NEXT],
    [RELAY_TOKENS_ENV]: process.env[RELAY_TOKENS_ENV],
  }
  try {
    delete process.env[RELAY_TOKENS_ENV]
    delete process.env[RELAY_TOKEN_ENV]
    process.env[RELAY_TOKEN_ENV_CURRENT] = '  cur  '
    process.env[RELAY_TOKEN_ENV_NEXT] = 'nxt'
    const toks = resolveRelayServerTokens()
    assert.deepEqual(toks.sort(), ['cur', 'nxt'].sort(), 'current+next trimmed and present')

    // VIBE_RELAY_TOKENS comma list + dedupe against CURRENT.
    process.env[RELAY_TOKENS_ENV] = 'cur, third ,'
    const toks2 = resolveRelayServerTokens()
    assert.deepEqual(toks2.sort(), ['cur', 'nxt', 'third'].sort(), 'comma list merged, empties dropped, deduped')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('resolveRelayServerTokens: empty when nothing configured', () => {
  const saved = {
    [RELAY_TOKEN_ENV]: process.env[RELAY_TOKEN_ENV],
    [RELAY_TOKEN_ENV_CURRENT]: process.env[RELAY_TOKEN_ENV_CURRENT],
    [RELAY_TOKEN_ENV_NEXT]: process.env[RELAY_TOKEN_ENV_NEXT],
    [RELAY_TOKENS_ENV]: process.env[RELAY_TOKENS_ENV],
  }
  try {
    for (const k of Object.keys(saved)) delete process.env[k]
    assert.deepEqual(resolveRelayServerTokens(), [], 'no sources → empty list')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})
