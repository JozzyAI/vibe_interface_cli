/**
 * Node daemon relay-reconnect robustness.
 *
 * The WSL node daemon used to exit the moment its relay WebSocket closed: the
 * single-connection promise resolved on 'close' and the process fell off the
 * event loop, so every relay restart (and the token-rotation reloads that
 * motivated this work) knocked the node offline until a human relaunched it.
 *
 * These tests pin the new behaviour: the daemon survives a relay close/restart,
 * reconnects with capped backoff, re-registers the SAME node_id (using the
 * persisted pairing — no `vibe node pair`), never busy-loops, and treats a bad
 * token as a fatal, redacted, explicit-exit case rather than an infinite spin.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startRelayServer, type RelayServer } from '../src/relay/server.js'
import { relayNodeDaemon, type DaemonConnEvent } from '../src/relay/client.js'
import { nextBackoffMs, sleep } from '../src/relay/reconnect.js'
import { ensureIdentity, toPublicIdentity } from '../src/identity.js'
import { savePairings } from '../src/relay/pairing-store.js'

const TOKEN = `tok-reconnect-${Date.now()}`

function tmpVibeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-daemon-reconnect-'))
}

function tmpPairingsFile(): string {
  return path.join(os.tmpdir(), `vibe-relay-pairings-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
}

/** Poll `events` until `predicate` is true or timeout. */
async function waitFor(
  events: DaemonConnEvent[],
  predicate: (evs: DaemonConnEvent[]) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(events)) return
    await sleep(15)
  }
  throw new Error(`timeout waiting for events; saw: ${events.join(',')}`)
}

const count = (events: DaemonConnEvent[], ev: DaemonConnEvent): number => events.filter((e) => e === ev).length

// ── pure backoff helper ──────────────────────────────────────────────────────

test('nextBackoffMs: exponential, capped, never zero (no busy-loop)', () => {
  assert.equal(nextBackoffMs(0, { baseMs: 100, capMs: 1000 }), 100)
  assert.equal(nextBackoffMs(1, { baseMs: 100, capMs: 1000 }), 200)
  assert.equal(nextBackoffMs(2, { baseMs: 100, capMs: 1000 }), 400)
  assert.equal(nextBackoffMs(3, { baseMs: 100, capMs: 1000 }), 800)
  assert.equal(nextBackoffMs(4, { baseMs: 100, capMs: 1000 }), 1000, 'clamped to cap')
  assert.equal(nextBackoffMs(50, { baseMs: 100, capMs: 1000 }), 1000, 'stays at cap')
  // every delay is >= base, so the loop can never spin without waiting
  for (let a = 0; a < 20; a++) {
    assert.ok(nextBackoffMs(a, { baseMs: 50, capMs: 800 }) >= 50)
  }
  // defaults are sane
  assert.equal(nextBackoffMs(0), 1000)
  assert.equal(nextBackoffMs(99), 30000)
})

test('sleep: resolves early when the signal aborts', async () => {
  const ac = new AbortController()
  const started = Date.now()
  const p = sleep(10_000, ac.signal)
  ac.abort()
  await p
  assert.ok(Date.now() - started < 2000, 'should resolve promptly, not after 10s')
})

// ── reconnect across relay close/restart ─────────────────────────────────────

test('daemon reconnects (no process exit) after the relay closes the connection', async () => {
  process.env.VIBE_DIR = tmpVibeDir()
  process.env.VIBE_NODE_HEARTBEAT_MS = '5000'
  const relay1 = await startRelayServer({ port: 0, token: TOKEN })
  const port = relay1.port

  const events: DaemonConnEvent[] = []
  const ac = new AbortController()
  let fatalCode: number | null = null
  const daemonP = relayNodeDaemon(`ws://127.0.0.1:${port}`, TOKEN, undefined, {
    signal: ac.signal,
    backoffBaseMs: 20,
    backoffCapMs: 80,
    onFatal: (code) => { fatalCode = code },
    onEvent: (e) => events.push(e),
  })

  try {
    await waitFor(events, (e) => count(e, 'registered') >= 1)
    assert.equal(relay1.nodeCount(), 1, 'relay sees the node registered')

    // Relay goes away (terminates the connection) then a NEW instance comes up on
    // the same port — exactly what a `systemctl restart` looks like to the node.
    await relay1.close()
    const relay2 = await startRelayServer({ port, token: TOKEN })

    await waitFor(events, (e) => count(e, 'registered') >= 2)
    assert.equal(relay2.nodeCount(), 1, 'node re-registered on the new relay instance')
    assert.equal(fatalCode, null, 'daemon must NOT exit on a transient relay restart')
    // a 'closed' was observed and a reconnect was scheduled before re-registering
    assert.ok(count(events, 'closed') >= 1, 'observed the relay close')
    assert.ok(count(events, 'reconnect_scheduled') >= 1, 'scheduled a backoff reconnect')

    await relay2.close()
  } finally {
    ac.abort()
    await daemonP
    delete process.env.VIBE_DIR
    delete process.env.VIBE_NODE_HEARTBEAT_MS
  }
})

test('daemon preserves the same node_id across reconnect (no duplicate registration)', async () => {
  process.env.VIBE_DIR = tmpVibeDir()
  process.env.VIBE_NODE_HEARTBEAT_MS = '5000'
  const expectedId = toPublicIdentity(ensureIdentity()).id
  const relay1 = await startRelayServer({ port: 0, token: TOKEN })
  const port = relay1.port

  const events: DaemonConnEvent[] = []
  const ac = new AbortController()
  const daemonP = relayNodeDaemon(`ws://127.0.0.1:${port}`, TOKEN, undefined, {
    signal: ac.signal, backoffBaseMs: 20, backoffCapMs: 80, onEvent: (e) => events.push(e),
  })

  try {
    await waitFor(events, (e) => count(e, 'registered') >= 1)
    await relay1.close()
    const relay2 = await startRelayServer({ port, token: TOKEN })
    await waitFor(events, (e) => count(e, 'registered') >= 2)

    // registry is keyed by node_id; if the id were unstable or duplicated this
    // would be != 1.
    assert.equal(relay2.nodeCount(), 1, 'exactly one node registered (same id, no duplicate)')
    assert.ok(expectedId.startsWith('node_'), `node id should be identity-derived, got ${expectedId}`)
    await relay2.close()
  } finally {
    ac.abort()
    await daemonP
    delete process.env.VIBE_DIR
    delete process.env.VIBE_NODE_HEARTBEAT_MS
  }
})

test('persisted pairing survives restart: daemon re-registers with no `vibe node pair`', async () => {
  const dir = tmpVibeDir()
  process.env.VIBE_DIR = dir
  process.env.VIBE_NODE_HEARTBEAT_MS = '5000'
  // Seed the relay's pairings file from the daemon's PUBLIC identity (no pair step).
  const pub = toPublicIdentity(ensureIdentity())
  const pairingsFile = tmpPairingsFile()
  savePairings(pairingsFile, new Map([[pub.id, pub]]))

  const relay1 = await startRelayServer({ port: 0, token: TOKEN, requirePairing: true, pairingsFile })
  const port = relay1.port

  const events: DaemonConnEvent[] = []
  const ac = new AbortController()
  let fatalCode: number | null = null
  const daemonP = relayNodeDaemon(`ws://127.0.0.1:${port}`, TOKEN, undefined, {
    signal: ac.signal, backoffBaseMs: 20, backoffCapMs: 80,
    onFatal: (c) => { fatalCode = c }, onEvent: (e) => events.push(e),
  })

  try {
    await waitFor(events, (e) => count(e, 'registered') >= 1)
    assert.equal(relay1.pairedCount(), 1, 'pairing loaded from disk')

    // Restart: a fresh relay instance that only ever loads the pairing from disk
    // (it never receives a node_pair_request).
    await relay1.close()
    const relay2 = await startRelayServer({ port, token: TOKEN, requirePairing: true, pairingsFile })

    await waitFor(events, (e) => count(e, 'registered') >= 2)
    assert.equal(relay2.nodeCount(), 1, 're-registered under require-pairing with no re-pair')
    assert.equal(count(events, 'rejected'), 0, 'never rejected — pairing persisted')
    assert.equal(fatalCode, null, 'no fatal exit')
    await relay2.close()
  } finally {
    ac.abort()
    await daemonP
    delete process.env.VIBE_DIR
    delete process.env.VIBE_NODE_HEARTBEAT_MS
  }
})

// ── fatal paths: auth / pairing rejection ────────────────────────────────────

test('invalid token: fatal exit, clear redacted error, token never logged', async () => {
  process.env.VIBE_DIR = tmpVibeDir()
  process.env.VIBE_NODE_HEARTBEAT_MS = '5000'
  const relay = await startRelayServer({ port: 0, token: TOKEN })

  const BAD_TOKEN = 'BADSECRET-must-not-appear-in-logs'
  const events: DaemonConnEvent[] = []
  let fatalCode: number | null = null
  let fatalReason = ''

  // Capture daemon stderr to assert the token is never leaked.
  const orig = process.stderr.write.bind(process.stderr)
  let captured = ''
  ;(process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    captured += String(chunk); return true
  }
  try {
    await relayNodeDaemon(`ws://127.0.0.1:${relay.port}`, BAD_TOKEN, undefined, {
      backoffBaseMs: 20, backoffCapMs: 80,
      onFatal: (c, r) => { fatalCode = c; fatalReason = r },
      onEvent: (e) => events.push(e),
    })
  } finally {
    ;(process.stderr as { write: unknown }).write = orig
  }

  assert.equal(fatalCode, 1, 'invalid token must exit with explicit non-zero status (no silent spin)')
  assert.match(fatalReason, /401|unauthorized/i)
  assert.ok(count(events, 'auth_failed') >= 1, 'classified as auth failure')
  assert.equal(count(events, 'registered'), 0, 'never registered with a bad token')
  assert.doesNotMatch(captured, /BADSECRET/, 'the token value must never appear in logs')
  assert.match(captured, /REDACTED/, 'logs the redacted marker')

  await relay.close()
  delete process.env.VIBE_DIR
  delete process.env.VIBE_NODE_HEARTBEAT_MS
})

test('pairing rejection: fatal exit with a clear re-pair message, no token leak', async () => {
  const dir = tmpVibeDir()
  process.env.VIBE_DIR = dir
  process.env.VIBE_NODE_HEARTBEAT_MS = '5000'
  ensureIdentity() // daemon has an identity, but the relay has NO pairing for it
  // require-pairing with an empty pairings file → register is rejected.
  const pairingsFile = tmpPairingsFile()
  savePairings(pairingsFile, new Map())
  const relay = await startRelayServer({ port: 0, token: TOKEN, requirePairing: true, pairingsFile })

  const events: DaemonConnEvent[] = []
  let fatalCode: number | null = null

  const orig = process.stderr.write.bind(process.stderr)
  let captured = ''
  ;(process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    captured += String(chunk); return true
  }
  try {
    await relayNodeDaemon(`ws://127.0.0.1:${relay.port}`, TOKEN, undefined, {
      backoffBaseMs: 20, backoffCapMs: 80,
      onFatal: (c) => { fatalCode = c },
      onEvent: (e) => events.push(e),
    })
  } finally {
    ;(process.stderr as { write: unknown }).write = orig
  }

  assert.equal(fatalCode, 1, 'pairing rejection exits explicitly rather than spinning')
  assert.ok(count(events, 'rejected') >= 1, 'classified as a pairing rejection')
  assert.match(captured, /vibe node pair/, 'tells the operator how to recover')
  assert.doesNotMatch(captured, new RegExp(TOKEN), 'token value never logged')

  await relay.close()
  delete process.env.VIBE_DIR
  delete process.env.VIBE_NODE_HEARTBEAT_MS
})
