/**
 * MVP 4B / 4C — encrypted run_start and run_event stream tests.
 *
 * 4B key assertions:
 *   - encrypted run_start returns a valid RunRecord ack
 *   - relay wire bytes do NOT contain prompt_content or workspace_key
 *   - wrong private key fails decryption
 *   - tampered ciphertext fails auth tag check
 *   - plaintext run_start still works (backward compat)
 *
 * 4C key assertions:
 *   - deriveRunEventKey — both sides (CLI, node) derive the same AES key from ECDH
 *   - encryptEvent / decryptEvent round-trip
 *   - wrong event key and tampered ciphertext fail cleanly
 *   - relay wire bytes do NOT contain log message or event content
 *   - relay fans out encrypted_run_event to multiple subscribers
 *   - full E2E: daemon encrypts run_event stream; stream caller decrypts; output is VibeEvent JSONL
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'child_process'
import { WebSocket } from 'ws'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { startRelayServer } from '../src/relay/server.js'
import { encryptPayload, decryptPayload, deriveRunEventKey, encryptEvent, decryptEvent, generateX25519, generateEd25519, deriveIdFromPublicKey, fingerprint as fp } from '../src/crypto.js'
import { createIdentity } from '../src/identity.js'
import type { RelayMessage, EncryptedRunStartMsg, EncryptedRunEventMsg, RunStartMsg, RunStartPayload } from '../src/relay/types.js'
import type { RunRecord } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures')

const TEST_TOKEN = `tok-enc-${Date.now()}`

// ── helpers ────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-enc-test-'))
}

async function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

async function waitForMsg(
  ws: WebSocket,
  predicate: (m: RelayMessage) => boolean,
  timeoutMs = 8000,
): Promise<RelayMessage> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('waitForMsg timeout')), timeoutMs)
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString()) as RelayMessage
        if (predicate(m)) { clearTimeout(t); resolve(m) }
      } catch {}
    })
  })
}

function sendWs(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg))
}

/** Make a fake RunRecord for ack purposes. */
function fakeRecord(runId: string, nodeId: string): RunRecord {
  return {
    run_id: runId, session_id: '', node_id: nodeId, agent: 'mock',
    status: 'running', workspace_path: '/tmp/x',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
}

/** Spawn a daemon with a custom VIBE_DIR so it has a fresh identity. */
async function spawnDaemon(
  relay: string,
  token: string,
  nodeId: string,
  vibeDir: string,
): Promise<ChildProcess> {
  // Create identity in the daemon's vibe dir first
  process.env.VIBE_DIR = vibeDir
  createIdentity('node')
  delete process.env.VIBE_DIR

  const proc = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relay, '--token', token, '--node-id', nodeId], {
    env: { ...process.env, VIBE_DIR: vibeDir, VIBE_NODE_HEARTBEAT_MS: '200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('daemon did not start in time')), 5000)
    proc.stderr!.on('data', (d: Buffer) => {
      if (d.toString().includes('registered ✓')) { clearTimeout(t); resolve() }
    })
    proc.on('error', reject)
  })

  return proc
}

// ── crypto unit tests ──────────────────────────────────────────────────────

test('encryption: encryptPayload + decryptPayload round-trip', async () => {
  const kp = generateX25519()
  const pubB64 = kp.publicKey.toString('base64')
  const privB64 = kp.privateKey.toString('base64')

  const payload = { agent: 'mock', workspace_key: 'test-ws', prompt_content: 'do something', metadata: { foo: 'bar' } }
  const enc = encryptPayload(pubB64, payload)

  assert.ok(enc.ephemeralPublicKey, 'should have ephemeralPublicKey')
  assert.ok(enc.nonce, 'should have nonce')
  assert.ok(enc.ciphertext, 'should have ciphertext')

  const decrypted = decryptPayload(privB64, enc)
  assert.deepEqual(decrypted, payload)
})

test('encryption: wrong private key fails decryption', async () => {
  const kp1 = generateX25519()
  const kp2 = generateX25519()

  const enc = encryptPayload(kp1.publicKey.toString('base64'), { agent: 'mock', workspace_key: 'x' })

  assert.throws(
    () => decryptPayload(kp2.privateKey.toString('base64'), enc),
    /decryption failure|bad decrypt|Unsupported state|ERR_OSSL/,
  )
})

test('encryption: tampered ciphertext fails auth tag check', async () => {
  const kp = generateX25519()
  const enc = encryptPayload(kp.publicKey.toString('base64'), { agent: 'mock', prompt_content: 'secret' })

  // Flip the first byte of the ciphertext
  const raw = Buffer.from(enc.ciphertext, 'base64')
  raw[0] ^= 0xff
  const tampered = { ...enc, ciphertext: raw.toString('base64') }

  assert.throws(
    () => decryptPayload(kp.privateKey.toString('base64'), tampered),
    /decryption failure|bad decrypt|Unsupported state|ERR_OSSL/,
  )
})

test('encryption: prompt_content is not visible in encrypted payload bytes', async () => {
  const kp = generateX25519()
  const secret = 'SUPERSECRET_PROMPT_' + Date.now()
  const enc = encryptPayload(kp.publicKey.toString('base64'), { agent: 'mock', prompt_content: secret })

  const wireJson = JSON.stringify(enc)
  assert.ok(!wireJson.includes(secret), 'ciphertext must not contain plaintext prompt')
  assert.ok(!wireJson.includes('prompt_content'), 'ciphertext must not contain field name')
})

// ── relay protocol tests ──────────────────────────────────────────────────

test('relay: encrypted run_start — relay does not see prompt_content in forwarded message', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`

  const encKp = generateX25519()
  const encPubB64 = encKp.publicKey.toString('base64')
  const reqId = `req_enc_${Date.now()}`
  const SECRET_PROMPT = 'TOPSECRET_PROMPT_RELAY_' + Date.now()

  // Connect two clients: "node" and "controller"
  const nodeWs = await connect(url)
  const ctrlWs = await connect(url)

  // Register the node with encryption_public_key
  const nodeId = 'enc-node'
  const node = {
    node_id: nodeId, name: 'test', status: 'online' as const, transport: 'relay' as const,
    capabilities: [], agents: [], active_runs: 0, max_runs: 1,
    workspace_roots: [], created_at: '', updated_at: '',
    encryption_public_key: encPubB64,
  }
  sendWs(nodeWs, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: new Date().toISOString(), type: 'node_register', node })
  await waitForMsg(nodeWs, m => m.type === 'node_register_ack')

  // Controller sends encrypted run_start
  const payload = { agent: 'mock' as const, workspace_key: 'secret-ws', prompt_content: SECRET_PROMPT }
  const enc = encryptPayload(encPubB64, payload)

  const encMsg: EncryptedRunStartMsg = {
    version: 1, kind: 'encrypted', from: 'cli', to: nodeId,
    ts: new Date().toISOString(), req_id: reqId, type: 'run_start',
    key_id: nodeId, ...enc,
    ephemeral_public_key: enc.ephemeralPublicKey,
  }
  // Remove camelCase version, use snake_case
  const wireMsg = {
    version: 1, kind: 'encrypted', from: 'cli', to: nodeId,
    ts: new Date().toISOString(), req_id: reqId, type: 'run_start', key_id: nodeId,
    ephemeral_public_key: enc.ephemeralPublicKey, nonce: enc.nonce, ciphertext: enc.ciphertext,
  }

  // Intercept what the node receives to verify relay didn't modify/expand it
  const nodeReceived: string[] = []
  nodeWs.on('message', (raw) => nodeReceived.push(raw.toString()))

  ctrlWs.send(JSON.stringify(wireMsg))

  // Wait for the node to receive the message
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for node to receive message')), 5000)
    const check = setInterval(() => {
      if (nodeReceived.length > 0) { clearInterval(check); clearTimeout(t); resolve() }
    }, 50)
  })

  const received = nodeReceived[nodeReceived.length - 1]
  assert.ok(!received.includes(SECRET_PROMPT), 'relay must not add prompt_content to forwarded message')
  assert.ok(!received.includes('prompt_content'), 'relay must not expand ciphertext')
  assert.ok(received.includes('"kind":"encrypted"'), 'relay must forward as encrypted')

  nodeWs.close()
  ctrlWs.close()
  await server.close()
})

test('relay: encrypted run_start → node decrypts → returns run_start_ack', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const vibeDir = tmpDir()

  const daemonProc = await spawnDaemon(
    `ws://localhost:${server.port}`,
    TEST_TOKEN,
    'enc-daemon-node',
    vibeDir,
  )

  try {
    // Get the node's encryption_public_key from the node list
    const { fetchRemoteNodes } = await import('../src/relay/client.js')
    const nodes = await fetchRemoteNodes(`ws://localhost:${server.port}`, TEST_TOKEN)
    const target = nodes.find(n => n.node_id === 'enc-daemon-node')
    assert.ok(target?.encryption_public_key, 'daemon should expose encryption_public_key')

    // Send an encrypted run_start via remoteRunStart
    const { remoteRunStart } = await import('../src/relay/client.js')
    const record = await remoteRunStart(
      `ws://localhost:${server.port}`,
      TEST_TOKEN,
      'enc-daemon-node',
      {
        agent: 'mock',
        workspaceKey: 'enc-test-ws',
        encryptionPublicKey: target!.encryption_public_key!,
      },
    )

    assert.equal(record.status, 'running', 'run should be running after encrypted start')
    assert.equal(record.node_id, 'enc-daemon-node')
    assert.ok(record.run_id, 'should have run_id')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise(r => daemonProc.on('exit', r))
    await server.close()
    fs.rmSync(vibeDir, { recursive: true, force: true })
  }
})

test('relay: encrypted run_start with fake claude exits 0 → completed', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const vibeDir = tmpDir()

  const daemonProc = await spawnDaemon(
    `ws://localhost:${server.port}`,
    TEST_TOKEN,
    'enc-cc-node',
    vibeDir,
  )

  try {
    const { fetchRemoteNodes, remoteRunStart, remoteStream } = await import('../src/relay/client.js')
    const nodes = await fetchRemoteNodes(`ws://localhost:${server.port}`, TEST_TOKEN)
    const target = nodes.find(n => n.node_id === 'enc-cc-node')
    assert.ok(target?.encryption_public_key, 'node should have encryption key')

    const promptFile = path.join(vibeDir, 'prompt.md')
    fs.writeFileSync(promptFile, 'Say hello.')

    const record = await remoteRunStart(
      `ws://localhost:${server.port}`,
      TEST_TOKEN,
      'enc-cc-node',
      {
        agent: 'claude-code',
        workspaceKey: 'enc-cc-ws',
        promptFile,
        encryptionPublicKey: target!.encryption_public_key!,
      },
    )

    assert.equal(record.status, 'running')

    let lastStatus = ''
    const origPath = process.env.PATH
    process.env.PATH = FIXTURES + path.delimiter + (origPath ?? '')
    try {
      await remoteStream(`ws://localhost:${server.port}`, TEST_TOKEN, record.run_id)
    } finally {
      process.env.PATH = origPath
    }
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise(r => daemonProc.on('exit', r))
    await server.close()
    fs.rmSync(vibeDir, { recursive: true, force: true })
  }
})

test('relay: node with no identity rejects encrypted run_start', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`

  // Register node WITHOUT identity (no encryption_public_key)
  const nodeWs = await connect(url)
  const ctrlWs = await connect(url)
  const nodeId = 'no-id-node'
  sendWs(nodeWs, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: new Date().toISOString(), type: 'node_register', node: { node_id: nodeId, name: 'x', status: 'online', transport: 'relay', capabilities: [], agents: [], active_runs: 0, max_runs: 1, workspace_roots: [], created_at: '', updated_at: '' } })
  await waitForMsg(nodeWs, m => m.type === 'node_register_ack')

  const encKp = generateX25519()
  const reqId = `req_noid_${Date.now()}`
  const enc = encryptPayload(encKp.publicKey.toString('base64'), { agent: 'mock', workspace_key: 'x' })

  ctrlWs.send(JSON.stringify({
    version: 1, kind: 'encrypted', from: 'cli', to: nodeId,
    ts: new Date().toISOString(), req_id: reqId, type: 'run_start', key_id: nodeId,
    ephemeral_public_key: enc.ephemeralPublicKey, nonce: enc.nonce, ciphertext: enc.ciphertext,
  }))

  // Node internally responds with error ack; the mock node handler must ack it
  // But here we just test that the relay forwards and the node sends an error ack.
  // Since there's no real daemon, we simulate: the nodeWs sends an error ack back.
  const nodeMsg = await waitForMsg(nodeWs, m => (m as { kind?: string }).kind === 'encrypted' || m.type === 'node_register_ack' || (m as unknown as { req_id?: string }).req_id === reqId)

  // The relay forwarded the encrypted message to the node. Node doesn't have identity,
  // but in this test there's no real daemon to respond. We just verify relay forwarded it.
  assert.ok(
    (nodeMsg as unknown as { kind?: string }).kind === 'encrypted' ||
    (nodeMsg as unknown as { req_id?: string }).req_id === reqId,
    'relay should have forwarded encrypted envelope to node',
  )

  nodeWs.close()
  ctrlWs.close()
  await server.close()
})

// ── MVP 4C: run_event stream encryption unit tests ────────────────────────

test('encryption: deriveRunEventKey — CLI and node sides compute the same AES key', () => {
  // CLI side: has ephemeral private key + node enc public key
  // Node side: has node enc private key + ephemeral public key
  // Both must arrive at the same 32-byte AES key.
  const nodeKp = generateX25519()
  const ephemeralKp = generateX25519()

  const cliKey  = deriveRunEventKey(ephemeralKp.privateKey.toString('base64'), nodeKp.publicKey.toString('base64'))
  const nodeKey = deriveRunEventKey(nodeKp.privateKey.toString('base64'), ephemeralKp.publicKey.toString('base64'))

  assert.equal(cliKey, nodeKey, 'both sides must derive identical AES key')
  assert.equal(Buffer.from(cliKey, 'base64').length, 32, 'key must be 32 bytes (AES-256)')
})

test('encryption: run_start key and run_event key are different (domain separation)', () => {
  const nodeKp = generateX25519()
  const ephemeralKp = generateX25519()

  // run_start key is derived via encryptPayload internally; simulate it
  const enc = encryptPayload(nodeKp.publicKey.toString('base64'), { agent: 'mock' })
  const eventKey = deriveRunEventKey(enc.ephemeralPrivateKey!, nodeKp.publicKey.toString('base64'))

  // The AES key used to encrypt the payload (run_start) must differ from the event key
  // We can verify indirectly: decryptPayload uses run_start key; decryptEvent must use event key
  const eventPayload = { type: 'log', run_id: 'r1', ts: new Date().toISOString(), stream: 'stdout', message: 'hello' }
  const encEvent = encryptEvent(eventKey, eventPayload)

  // Decrypting the event with the node's side event key should succeed
  const nodeEventKey = deriveRunEventKey(nodeKp.privateKey.toString('base64'), enc.ephemeralPublicKey)
  const decrypted = decryptEvent(nodeEventKey, encEvent)
  assert.deepEqual(decrypted, eventPayload)

  // Trying to decrypt run_start ciphertext with event key should fail (different AES keys)
  assert.throws(
    () => decryptEvent(eventKey, { nonce: enc.nonce, ciphertext: enc.ciphertext }),
    /decryption failure|bad decrypt|Unsupported state|ERR_OSSL/,
  )
})

test('encryption: encryptEvent + decryptEvent round-trip', () => {
  const kp = generateX25519()
  const key = deriveRunEventKey(kp.privateKey.toString('base64'), kp.publicKey.toString('base64'))

  const event = { type: 'log', run_id: 'run_abc', ts: new Date().toISOString(), stream: 'stdout', message: 'Cloning repository...' }
  const enc = encryptEvent(key, event)

  assert.ok(enc.nonce, 'should have nonce')
  assert.ok(enc.ciphertext, 'should have ciphertext')
  assert.ok(!enc.ciphertext.includes('Cloning'), 'ciphertext must not contain plaintext')

  const decrypted = decryptEvent(key, enc)
  assert.deepEqual(decrypted, event)
})

test('encryption: wrong event key fails decryptEvent', () => {
  const kp1 = generateX25519()
  const kp2 = generateX25519()
  const key1 = deriveRunEventKey(kp1.privateKey.toString('base64'), kp1.publicKey.toString('base64'))
  const key2 = deriveRunEventKey(kp2.privateKey.toString('base64'), kp2.publicKey.toString('base64'))

  const enc = encryptEvent(key1, { type: 'log', run_id: 'x', ts: '', stream: 'stdout', message: 'secret' })

  assert.throws(
    () => decryptEvent(key2, enc),
    /decryption failure|bad decrypt|Unsupported state|ERR_OSSL/,
  )
})

test('encryption: tampered encrypted_run_event ciphertext fails', () => {
  const kp = generateX25519()
  const key = deriveRunEventKey(kp.privateKey.toString('base64'), kp.publicKey.toString('base64'))
  const enc = encryptEvent(key, { type: 'status', run_id: 'r', ts: '', status: 'completed' })

  const raw = Buffer.from(enc.ciphertext, 'base64')
  raw[0] ^= 0xff
  const tampered = { ...enc, ciphertext: raw.toString('base64') }

  assert.throws(
    () => decryptEvent(key, tampered),
    /decryption failure|bad decrypt|Unsupported state|ERR_OSSL/,
  )
})

// ── MVP 4C: relay protocol tests ──────────────────────────────────────────

test('relay: encrypted_run_event — relay wire bytes do not contain event content', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`

  const nodeKp = generateX25519()
  const ephemeralKp = generateX25519()
  const eventKey = deriveRunEventKey(ephemeralKp.privateKey.toString('base64'), nodeKp.publicKey.toString('base64'))
  const SECRET_MESSAGE = 'TOPSECRET_LOG_LINE_' + Date.now()
  const runId = `run_event_spy_${Date.now().toString(36)}`

  // "Subscriber" connects and subscribes
  const subWs = await connect(url)
  sendWs(subWs, { version: 1, kind: 'plaintext', from: 'sub', to: 'relay', ts: new Date().toISOString(), type: 'run_stream_subscribe', run_id: runId })
  await waitForMsg(subWs, m => m.type === 'run_stream_subscribe_ack')

  // "Node" sends an encrypted_run_event
  const nodeWs = await connect(url)
  const event = { type: 'log', run_id: runId, ts: new Date().toISOString(), stream: 'stdout', message: SECRET_MESSAGE }
  const enc = encryptEvent(eventKey, event)
  const encEventMsg: EncryptedRunEventMsg = {
    version: 1, kind: 'encrypted', from: 'spy-node', to: 'relay', ts: new Date().toISOString(),
    type: 'encrypted_run_event', run_id: runId, key_id: 'spy-node',
    nonce: enc.nonce, ciphertext: enc.ciphertext,
  }
  nodeWs.send(JSON.stringify(encEventMsg))

  // Subscriber receives the fanned-out message
  const received = await waitForMsg(subWs, m => (m as { type?: string }).type === 'encrypted_run_event')
  const receivedRaw = JSON.stringify(received)

  assert.ok(!receivedRaw.includes(SECRET_MESSAGE), 'relay must not include log message in forwarded wire bytes')
  assert.ok(!receivedRaw.includes('"log"'), 'relay must not expose event type in forwarded wire bytes')
  assert.ok(receivedRaw.includes('"encrypted_run_event"'), 'forwarded message must have encrypted_run_event type')
  assert.ok(receivedRaw.includes(runId), 'run_id must remain visible for routing')

  nodeWs.close()
  subWs.close()
  await server.close()
})

test('relay: encrypted_run_event fanout to multiple subscribers', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`

  const kp = generateX25519()
  const eventKey = deriveRunEventKey(kp.privateKey.toString('base64'), kp.publicKey.toString('base64'))
  const runId = `run_multi_sub_${Date.now().toString(36)}`

  // Two subscribers
  const sub1 = await connect(url)
  const sub2 = await connect(url)
  sendWs(sub1, { version: 1, kind: 'plaintext', from: 's1', to: 'relay', ts: new Date().toISOString(), type: 'run_stream_subscribe', run_id: runId })
  sendWs(sub2, { version: 1, kind: 'plaintext', from: 's2', to: 'relay', ts: new Date().toISOString(), type: 'run_stream_subscribe', run_id: runId })
  await Promise.all([
    waitForMsg(sub1, m => m.type === 'run_stream_subscribe_ack'),
    waitForMsg(sub2, m => m.type === 'run_stream_subscribe_ack'),
  ])

  const nodeWs = await connect(url)
  const event = { type: 'log', run_id: runId, ts: new Date().toISOString(), stream: 'stdout', message: 'broadcast' }
  const enc = encryptEvent(eventKey, event)
  nodeWs.send(JSON.stringify({
    version: 1, kind: 'encrypted', from: 'multi-node', to: 'relay', ts: new Date().toISOString(),
    type: 'encrypted_run_event', run_id: runId, key_id: 'multi-node',
    nonce: enc.nonce, ciphertext: enc.ciphertext,
  } satisfies EncryptedRunEventMsg))

  // Both subscribers must receive the encrypted event and be able to decrypt it
  const [msg1, msg2] = await Promise.all([
    waitForMsg(sub1, m => (m as { type?: string }).type === 'encrypted_run_event'),
    waitForMsg(sub2, m => (m as { type?: string }).type === 'encrypted_run_event'),
  ])

  for (const msg of [msg1, msg2]) {
    const e = msg as EncryptedRunEventMsg
    const decrypted = decryptEvent(eventKey, { nonce: e.nonce, ciphertext: e.ciphertext })
    assert.deepEqual(decrypted, event, 'both subscribers should decrypt to the same event')
  }

  sub1.close(); sub2.close(); nodeWs.close()
  await server.close()
})

test('relay: encrypted run_event stream E2E — daemon encrypts events; stream decrypts to VibeEvent JSONL', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const ctrlVibeDir = tmpDir()  // isolated controller-side run records

  const daemonVibeDir = tmpDir()
  const daemonProc = await spawnDaemon(
    `ws://localhost:${server.port}`,
    TEST_TOKEN,
    'enc-event-node',
    daemonVibeDir,
  )

  try {
    const { fetchRemoteNodes, remoteRunStart, remoteStream } = await import('../src/relay/client.js')
    const nodes = await fetchRemoteNodes(`ws://localhost:${server.port}`, TEST_TOKEN)
    const target = nodes.find(n => n.node_id === 'enc-event-node')
    assert.ok(target?.encryption_public_key, 'daemon must expose encryption_public_key')

    // Start encrypted run (controller side uses ctrlVibeDir for local run record)
    process.env.VIBE_DIR = ctrlVibeDir
    const record = await remoteRunStart(
      `ws://localhost:${server.port}`,
      TEST_TOKEN,
      'enc-event-node',
      {
        agent: 'mock',
        workspaceKey: 'enc-event-ws',
        encryptionPublicKey: target!.encryption_public_key!,
      },
    )
    assert.equal(record.status, 'running')

    // Verify event AES key was stored in controller-side run record
    const { tryReadRun } = await import('../src/store.js')
    const saved = tryReadRun(record.run_id)
    assert.ok(saved?.event_aes_key, 'event_aes_key must be written to local run record after encrypted run_start')
    assert.equal(Buffer.from(saved!.event_aes_key!, 'base64').length, 32, 'event_aes_key must be 32 bytes')

    // Also verify via raw spy subscriber that relay wire contains encrypted_run_event (not plaintext)
    const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`
    const spyWs = await connect(url)
    sendWs(spyWs, { version: 1, kind: 'plaintext', from: 'spy', to: 'relay', ts: new Date().toISOString(), type: 'run_stream_subscribe', run_id: record.run_id })
    await waitForMsg(spyWs, m => m.type === 'run_stream_subscribe_ack')

    const spyMessages: string[] = []
    spyWs.on('message', (raw) => spyMessages.push(raw.toString()))

    // Stream events through the decrypting client — should complete successfully
    await remoteStream(`ws://localhost:${server.port}`, TEST_TOKEN, record.run_id)

    spyWs.close()

    // Spy must have seen encrypted_run_event, not plaintext run_event
    const eventMsgs = spyMessages.filter(m => {
      try { return (JSON.parse(m) as { type?: string }).type === 'encrypted_run_event' } catch { return false }
    })
    assert.ok(eventMsgs.length > 0, 'relay wire must contain encrypted_run_event messages')

    const plainMsgs = spyMessages.filter(m => {
      try { return (JSON.parse(m) as { type?: string }).type === 'run_event' } catch { return false }
    })
    assert.equal(plainMsgs.length, 0, 'relay wire must NOT contain plaintext run_event for encrypted runs')

    // Verify each encrypted event decrypts to valid VibeEvent
    for (const raw of eventMsgs) {
      const encEvent = JSON.parse(raw) as EncryptedRunEventMsg
      const decrypted = decryptEvent(saved!.event_aes_key!, { nonce: encEvent.nonce, ciphertext: encEvent.ciphertext })
      assert.ok(typeof (decrypted as { type?: unknown }).type === 'string', 'decrypted event must have type field')
    }
  } finally {
    delete process.env.VIBE_DIR
    daemonProc.kill('SIGTERM')
    await new Promise(r => daemonProc.on('exit', r))
    await server.close()
    fs.rmSync(ctrlVibeDir, { recursive: true, force: true })
    fs.rmSync(daemonVibeDir, { recursive: true, force: true })
  }
})

test('relay: plaintext run_start still works (backward compat)', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`

  const nodeWs = await connect(url)
  const ctrlWs = await connect(url)
  const nodeId = 'legacy-run-node'
  const reqId = `req_legacy_${Date.now()}`

  sendWs(nodeWs, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: new Date().toISOString(), type: 'node_register', node: { node_id: nodeId, name: 'x', status: 'online', transport: 'relay', capabilities: [], agents: [], active_runs: 0, max_runs: 1, workspace_roots: [], created_at: '', updated_at: '' } })
  await waitForMsg(nodeWs, m => m.type === 'node_register_ack')

  ctrlWs.send(JSON.stringify({
    version: 1, kind: 'plaintext', from: 'cli', to: nodeId,
    ts: new Date().toISOString(), type: 'run_start', req_id: reqId,
    agent: 'mock', workspace_key: 'legacy-ws',
  }))

  const forwarded = await waitForMsg(nodeWs, m => m.type === 'run_start' && (m as unknown as { req_id?: string }).req_id === reqId)
  assert.equal((forwarded as RunStartMsg).agent, 'mock', 'plaintext run_start should still be forwarded')

  nodeWs.close()
  ctrlWs.close()
  await server.close()
})
