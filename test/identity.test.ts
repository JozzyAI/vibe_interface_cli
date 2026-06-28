/**
 * MVP 4A — identity, pairing, and signed envelope tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { startRelayServer } from '../src/relay/server.js'
import { WebSocket } from 'ws'
import type { RelayMessage } from '../src/relay/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

const TEST_TOKEN = `tok-id-${Date.now()}`

// ── helpers ────────────────────────────────────────────────────────────────

/** Run CLI command in an isolated VIBE_DIR (temp dir), return stdout/stderr. */
async function vibeWithHome(
  args: string[],
  vibeHome: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, VIBE_DIR: vibeHome }
  // Apply overrides; an explicit `undefined` removes an inherited var so a test
  // can exercise the unset case even if the parent env happens to define it.
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return new Promise((resolve) => {
    const proc = spawn(NODE, [CLI, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
  })
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
  timeoutMs = 5000,
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

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-id-test-'))
}

// ── identity tests ─────────────────────────────────────────────────────────

test('identity: auto-creates identity file on first run', async () => {
  const home = tmpDir()
  const { status, stdout } = await vibeWithHome(['node', 'identity', '--json'], home)
  assert.equal(status, 0)
  const pub = JSON.parse(stdout)
  assert.equal(pub.version, 1)
  assert.equal(pub.kind, 'node')
  assert.ok(pub.id.startsWith('node_'), `id should start with node_: ${pub.id}`)
  assert.ok(pub.signing_public_key, 'should have signing_public_key')
  assert.ok(pub.encryption_public_key, 'should have encryption_public_key')
  assert.ok(pub.fingerprint.startsWith('SHA256:'), `fingerprint should start with SHA256:: ${pub.fingerprint}`)
  assert.equal(pub.signing_alg, 'Ed25519')
  assert.equal(pub.encryption_alg, 'X25519')
  fs.rmSync(home, { recursive: true })
})

test('identity: public output never contains private keys', async () => {
  const home = tmpDir()
  const { stdout } = await vibeWithHome(['node', 'identity', '--json'], home)
  assert.ok(!stdout.includes('private_key'), 'stdout must not contain private_key')
  fs.rmSync(home, { recursive: true })
})

test('identity: fingerprint is stable across calls', async () => {
  const home = tmpDir()
  const { stdout: out1 } = await vibeWithHome(['node', 'identity', '--json'], home)
  const { stdout: out2 } = await vibeWithHome(['node', 'identity', '--json'], home)
  const p1 = JSON.parse(out1)
  const p2 = JSON.parse(out2)
  assert.equal(p1.fingerprint, p2.fingerprint, 'fingerprint must be stable')
  assert.equal(p1.id, p2.id, 'node_id must be stable')
  fs.rmSync(home, { recursive: true })
})

test('identity: identity file has restrictive permissions (unix)', async () => {
  if (process.platform === 'win32') return  // skip on Windows
  const home = tmpDir()
  await vibeWithHome(['node', 'identity', '--json'], home)
  const identityFile = path.join(home, 'identity.json')
  assert.ok(fs.existsSync(identityFile), 'identity.json should exist')
  const stat = fs.statSync(identityFile)
  const mode = stat.mode & 0o777
  assert.equal(mode, 0o600, `identity.json should be 0o600, got 0o${mode.toString(8)}`)
  fs.rmSync(home, { recursive: true })
})

test('identity: node_id derived from public key (not hostname)', async () => {
  const home = tmpDir()
  const { stdout } = await vibeWithHome(['node', 'identity', '--json'], home)
  const pub = JSON.parse(stdout)
  // The id must be node_ + first 16 hex chars of SHA256(signing_public_key)
  assert.match(pub.id, /^node_[0-9a-f]{16}$/, `id format: ${pub.id}`)
  fs.rmSync(home, { recursive: true })
})

test('identity: VIBE_NODE_DISPLAY_NAME sets the display name at creation', async () => {
  const home = tmpDir()
  const { status, stdout } = await vibeWithHome(['node', 'identity', '--json'], home, { VIBE_NODE_DISPLAY_NAME: 'smoke-wsl-lijoe' })
  assert.equal(status, 0)
  const pub = JSON.parse(stdout)
  assert.equal(pub.display_name, 'smoke-wsl-lijoe', 'display_name should honour VIBE_NODE_DISPLAY_NAME')
  // The friendly label must not perturb the key-derived id (pairing key).
  assert.match(pub.id, /^node_[0-9a-f]{16}$/, `id format: ${pub.id}`)
  fs.rmSync(home, { recursive: true })
})

test('identity: display name falls back to hostname when VIBE_NODE_DISPLAY_NAME is unset/blank', async () => {
  const home = tmpDir()
  // Blank/whitespace is treated as unset → host name.
  const { stdout } = await vibeWithHome(['node', 'identity', '--json'], home, { VIBE_NODE_DISPLAY_NAME: '   ' })
  const pub = JSON.parse(stdout)
  assert.equal(pub.display_name, os.hostname(), 'blank display name should fall back to hostname')
  fs.rmSync(home, { recursive: true })
})

test('identity: display name is fixed at creation, ignoring later env changes', async () => {
  const home = tmpDir()
  // Create with one label…
  await vibeWithHome(['node', 'identity', '--json'], home, { VIBE_NODE_DISPLAY_NAME: 'first-label' })
  // …a later call with a different label must not rewrite the persisted identity.
  const { stdout } = await vibeWithHome(['node', 'identity', '--json'], home, { VIBE_NODE_DISPLAY_NAME: 'second-label' })
  const pub = JSON.parse(stdout)
  assert.equal(pub.display_name, 'first-label', 'display_name is set once at creation and persists')
  fs.rmSync(home, { recursive: true })
})

// ── canonical JSON + signing tests ─────────────────────────────────────────

test('crypto: canonicalize produces stable output regardless of key insertion order', async () => {
  const { canonicalize } = await import('../src/crypto.js')
  const a = canonicalize({ z: 1, a: 2, m: 3 })
  const b = canonicalize({ m: 3, z: 1, a: 2 })
  assert.equal(a, b, 'canonical form should be identical regardless of key order')
  assert.equal(a, '{"a":2,"m":3,"z":1}')
})

test('crypto: sign and verify round-trip', async () => {
  const { generateEd25519, signEnvelope, verifyEnvelope } = await import('../src/crypto.js')
  const kp = generateEd25519()
  const privB64 = kp.privateKey.toString('base64')
  const pubB64 = kp.publicKey.toString('base64')

  const envelope = { version: 1, kind: 'plaintext', from: 'node_abc', to: 'relay', ts: '2026-01-01T00:00:00.000Z', type: 'node_register' }
  const sig = signEnvelope(privB64, 'node_abc', envelope)
  assert.equal(sig.alg, 'Ed25519')
  assert.equal(sig.key_id, 'node_abc')

  const ok = verifyEnvelope(pubB64, { ...envelope, signature: sig })
  assert.equal(ok, true, 'signature should verify')
})

test('crypto: tampered envelope fails verification', async () => {
  const { generateEd25519, signEnvelope, verifyEnvelope } = await import('../src/crypto.js')
  const kp = generateEd25519()
  const privB64 = kp.privateKey.toString('base64')
  const pubB64 = kp.publicKey.toString('base64')

  const envelope = { version: 1, kind: 'plaintext', from: 'node_abc', to: 'relay', ts: '2026-01-01T00:00:00.000Z', type: 'node_register' }
  const sig = signEnvelope(privB64, 'node_abc', envelope)

  const tampered = { ...envelope, from: 'node_evil', signature: sig }
  const ok = verifyEnvelope(pubB64, tampered)
  assert.equal(ok, false, 'tampered envelope should fail verification')
})

test('crypto: wrong public key fails verification', async () => {
  const { generateEd25519, signEnvelope, verifyEnvelope } = await import('../src/crypto.js')
  const kp1 = generateEd25519()
  const kp2 = generateEd25519()

  const envelope = { version: 1, kind: 'plaintext', from: 'node_abc', to: 'relay', ts: '2026-01-01T00:00:00.000Z' }
  const sig = signEnvelope(kp1.privateKey.toString('base64'), 'node_abc', envelope)

  const ok = verifyEnvelope(kp2.publicKey.toString('base64'), { ...envelope, signature: sig })
  assert.equal(ok, false, 'wrong public key should fail verification')
})

// ── pairing tests (relay protocol) ─────────────────────────────────────────

test('relay: node_pair_request stores identity on relay', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`

  const { ensureIdentity, toPublicIdentity } = await import('../src/identity.js')
  const home = tmpDir()
  // Directly invoke the module-level helpers with a temp dir
  const { createIdentity } = await import('../src/identity.js')
  // We'll create identity inline to avoid writing to real ~/.vibe
  const { generateEd25519, generateX25519, deriveIdFromPublicKey, fingerprint: fp } = await import('../src/crypto.js')
  const sigKp = generateEd25519()
  const encKp = generateX25519()
  const sigPub = sigKp.publicKey.toString('base64')
  const testIdentity = {
    id: deriveIdFromPublicKey(sigPub),
    signing_alg: 'Ed25519' as const,
    signing_public_key: sigPub,
    encryption_alg: 'X25519' as const,
    encryption_public_key: encKp.publicKey.toString('base64'),
    fingerprint: fp(sigPub),
    version: 1 as const,
    kind: 'node' as const,
    display_name: 'test-node',
  }

  const ws = await connect(url)
  sendWs(ws, {
    version: 1, kind: 'plaintext', from: testIdentity.id, to: 'relay', ts: new Date().toISOString(),
    type: 'node_pair_request', identity: testIdentity,
  })

  const ack = await waitForMsg(ws, m => m.type === 'node_pair_ack') as { type: 'node_pair_ack'; node_id: string; ok: boolean }
  assert.equal(ack.ok, true)
  assert.equal(ack.node_id, testIdentity.id)
  assert.equal(server.pairedCount(), 1)

  ws.close()
  await server.close()
  fs.rmSync(home, { recursive: true })
})

function sendWs(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg))
}

test('relay: require-pairing rejects node_register from unpaired node', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN, requirePairing: true })
  const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`

  const ws = await connect(url)
  const node = { node_id: 'unpaired-node', name: 'test', status: 'online' as const, transport: 'relay' as const, capabilities: [], agents: [], active_runs: 0, max_runs: 1, workspace_roots: [], created_at: '', updated_at: '' }
  sendWs(ws, { version: 1, kind: 'plaintext', from: 'unpaired-node', to: 'relay', ts: new Date().toISOString(), type: 'node_register', node })

  const ack = await waitForMsg(ws, m => m.type === 'node_register_ack') as { type: 'node_register_ack'; ok: boolean }
  assert.equal(ack.ok, false, 'unpaired node should be rejected')

  ws.close()
  await server.close()
})

test('relay: require-pairing rejects node_register without signature', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN, requirePairing: true })
  const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`

  const { generateEd25519, deriveIdFromPublicKey, fingerprint: fp } = await import('../src/crypto.js')
  const sigKp = generateEd25519()
  const sigPub = sigKp.publicKey.toString('base64')
  const nodeId = deriveIdFromPublicKey(sigPub)
  const identity = {
    id: nodeId, version: 1 as const, kind: 'node' as const, display_name: 'test',
    signing_alg: 'Ed25519' as const, signing_public_key: sigPub,
    encryption_alg: 'X25519' as const, encryption_public_key: '',
    fingerprint: fp(sigPub),
  }

  const ws = await connect(url)

  // First pair
  sendWs(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: new Date().toISOString(), type: 'node_pair_request', identity })
  await waitForMsg(ws, m => m.type === 'node_pair_ack')

  // Then register WITHOUT signature
  const node = { node_id: nodeId, name: 'test', status: 'online' as const, transport: 'relay' as const, capabilities: [], agents: [], active_runs: 0, max_runs: 1, workspace_roots: [], created_at: '', updated_at: '' }
  sendWs(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: new Date().toISOString(), type: 'node_register', node })
  const ack = await waitForMsg(ws, m => m.type === 'node_register_ack') as { type: 'node_register_ack'; ok: boolean }
  assert.equal(ack.ok, false, 'paired node without signature should be rejected')

  ws.close()
  await server.close()
})

test('relay: require-pairing rejects node_register with bad signature', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN, requirePairing: true })
  const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`

  const { generateEd25519, deriveIdFromPublicKey, fingerprint: fp } = await import('../src/crypto.js')
  const sigKp = generateEd25519()
  const sigPub = sigKp.publicKey.toString('base64')
  const nodeId = deriveIdFromPublicKey(sigPub)
  const identity = {
    id: nodeId, version: 1 as const, kind: 'node' as const, display_name: 'test',
    signing_alg: 'Ed25519' as const, signing_public_key: sigPub,
    encryption_alg: 'X25519' as const, encryption_public_key: '',
    fingerprint: fp(sigPub),
  }

  const ws = await connect(url)
  sendWs(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: new Date().toISOString(), type: 'node_pair_request', identity })
  await waitForMsg(ws, m => m.type === 'node_pair_ack')

  // Register with a garbage signature
  const node = { node_id: nodeId, name: 'test', status: 'online' as const, transport: 'relay' as const, capabilities: [], agents: [], active_runs: 0, max_runs: 1, workspace_roots: [], created_at: '', updated_at: '' }
  sendWs(ws, {
    version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: new Date().toISOString(),
    type: 'node_register', node,
    signature: { alg: 'Ed25519', key_id: nodeId, value: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
  })
  const ack = await waitForMsg(ws, m => m.type === 'node_register_ack') as { type: 'node_register_ack'; ok: boolean }
  assert.equal(ack.ok, false, 'bad signature should be rejected')

  ws.close()
  await server.close()
})

test('relay: require-pairing accepts paired node with valid signature', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN, requirePairing: true })
  const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`

  const { generateEd25519, generateX25519, deriveIdFromPublicKey, fingerprint: fp, signEnvelope } = await import('../src/crypto.js')
  const sigKp = generateEd25519()
  const encKp = generateX25519()
  const sigPub = sigKp.publicKey.toString('base64')
  const sigPriv = sigKp.privateKey.toString('base64')
  const nodeId = deriveIdFromPublicKey(sigPub)
  const identity = {
    id: nodeId, version: 1 as const, kind: 'node' as const, display_name: 'test',
    signing_alg: 'Ed25519' as const, signing_public_key: sigPub,
    encryption_alg: 'X25519' as const, encryption_public_key: encKp.publicKey.toString('base64'),
    fingerprint: fp(sigPub),
  }

  const ws = await connect(url)

  // Pair first
  sendWs(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: new Date().toISOString(), type: 'node_pair_request', identity })
  await waitForMsg(ws, m => m.type === 'node_pair_ack')

  // Register with valid signature
  const node = { node_id: nodeId, name: 'test', status: 'online' as const, transport: 'relay' as const, capabilities: [], agents: [], active_runs: 0, max_runs: 1, workspace_roots: [], created_at: '', updated_at: '' }
  const baseMsg = { version: 1 as const, kind: 'plaintext' as const, from: nodeId, to: 'relay', ts: new Date().toISOString(), type: 'node_register' as const, node }
  const sig = signEnvelope(sigPriv, nodeId, baseMsg as unknown as Record<string, unknown>)
  sendWs(ws, { ...baseMsg, signature: sig })

  const ack = await waitForMsg(ws, m => m.type === 'node_register_ack') as { type: 'node_register_ack'; ok: boolean }
  assert.equal(ack.ok, true, 'paired node with valid signature should be accepted')
  assert.equal(server.nodeCount(), 1)

  ws.close()
  await server.close()
})

test('relay: without require-pairing, old token-only mode still works', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const url = `ws://localhost:${server.port}?token=${TEST_TOKEN}`

  const ws = await connect(url)
  const node = { node_id: 'legacy-node', name: 'test', status: 'online' as const, transport: 'relay' as const, capabilities: [], agents: [], active_runs: 0, max_runs: 1, workspace_roots: [], created_at: '', updated_at: '' }
  sendWs(ws, { version: 1, kind: 'plaintext', from: 'legacy-node', to: 'relay', ts: new Date().toISOString(), type: 'node_register', node })

  const ack = await waitForMsg(ws, m => m.type === 'node_register_ack') as { type: 'node_register_ack'; ok: boolean }
  assert.equal(ack.ok, true, 'token-only mode should still accept node_register without pairing')
  assert.equal(server.nodeCount(), 1)

  ws.close()
  await server.close()
})
