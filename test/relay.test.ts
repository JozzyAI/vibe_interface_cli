/**
 * MVP 3D-1 — Relay + remote node registration + remote node list tests.
 *
 * Protocol tests use an in-process relay server with direct WebSocket clients.
 * CLI integration tests use async subprocess invocations so the in-process
 * relay's event loop is never blocked by spawnSync.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'child_process'
import { WebSocket } from 'ws'
import path from 'path'
import { fileURLToPath } from 'url'
import type { VibeNode } from '../src/types.js'
import type { RelayMessage } from '../src/relay/types.js'
import { startRelayServer } from '../src/relay/server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

const TEST_TOKEN = `tok-${Date.now()}`

// ── helpers ────────────────────────────────────────────────────────────────

/** Async CLI invocation — does NOT block the event loop, so in-process relay stays live. */
async function vibeAsync(args: string[], env?: Record<string, string>): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(NODE, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
  })
}

/** Open a WebSocket and resolve when connected. */
async function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

/** Wait for a single message matching predicate. Rejects on timeout or close. */
async function waitForMsg(
  ws: WebSocket,
  predicate: (m: RelayMessage) => boolean,
  timeoutMs = 4000,
): Promise<RelayMessage> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }
    const t = setTimeout(() => settle(() => reject(new Error('Timeout waiting for message'))), timeoutMs)

    const handler = (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (predicate(msg)) settle(() => { clearTimeout(t); ws.off('message', handler); resolve(msg) })
      } catch {}
    }
    ws.on('message', handler)
    ws.on('close', () => settle(() => { clearTimeout(t); reject(new Error('WS closed before expected message')) }))
    ws.on('error', (e) => settle(() => { clearTimeout(t); reject(e) }))
  })
}

function send(ws: WebSocket, msg: RelayMessage): void {
  ws.send(JSON.stringify(msg))
}

function now(): string { return new Date().toISOString() }

function makeNode(nodeId: string): VibeNode {
  return {
    node_id: nodeId,
    name: 'Test Node',
    status: 'online',
    transport: 'relay',
    capabilities: ['run', 'stream'],
    agents: ['mock'],
    active_runs: 0,
    max_runs: 2,
    workspace_roots: ['/tmp'],
    created_at: now(),
    updated_at: now(),
  }
}

/** Register a fake node on an already-open WS and wait for the ack. */
async function registerNode(ws: WebSocket, nodeId: string): Promise<void> {
  const ackP = waitForMsg(ws, (m) => m.type === 'node_register_ack')
  send(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: now(), type: 'node_register', node: makeNode(nodeId) })
  await ackP
}

/** Request node list and return the nodes array. */
async function listNodes(ws: WebSocket): Promise<VibeNode[]> {
  const respP = waitForMsg(ws, (m) => m.type === 'node_list_response')
  send(ws, { version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: now(), type: 'node_list_request' })
  const resp = await respP
  return (resp as any).nodes as VibeNode[]
}

// ── auth tests — token validated at HTTP upgrade level (HTTP 401 before WS) ─

test('relay: rejects connection with wrong token (HTTP 401)', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    // connect() rejects because the WS upgrade returns 401
    await assert.rejects(
      connect(`ws://localhost:${server.port}?token=wrong`),
      /401|Unexpected server response/,
    )
  } finally {
    await server.close()
  }
})

test('relay: rejects connection with missing token (HTTP 401)', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    await assert.rejects(
      connect(`ws://localhost:${server.port}`),
      /401|Unexpected server response/,
    )
  } finally {
    await server.close()
  }
})

// ── registration tests ─────────────────────────────────────────────────────

test('relay: node_register receives node_register_ack', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const ws = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    const ackP = waitForMsg(ws, (m) => m.type === 'node_register_ack')
    send(ws, { version: 1, kind: 'plaintext', from: 'n1', to: 'relay', ts: now(), type: 'node_register', node: makeNode('n1') })
    const ack = await ackP
    assert.equal((ack as any).ok, true)
    assert.equal((ack as any).node_id, 'n1')
    ws.terminate()
  } finally {
    await server.close()
  }
})

test('relay: registered node appears in node_list_response with transport=relay', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const nodeWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(nodeWs, 'n-list')

    const cliWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    const nodes = await listNodes(cliWs)

    const found = nodes.find((n) => n.node_id === 'n-list')
    assert.ok(found, 'registered node in list')
    assert.equal(found!.transport, 'relay')
    assert.equal(found!.status, 'online')

    nodeWs.terminate()
    cliWs.terminate()
  } finally {
    await server.close()
  }
})

// ── heartbeat tests ────────────────────────────────────────────────────────

test('relay: node_heartbeat receives node_heartbeat_ack', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const ws = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(ws, 'n-hb')

    const ackP = waitForMsg(ws, (m) => m.type === 'node_heartbeat_ack')
    send(ws, {
      version: 1, kind: 'plaintext', from: 'n-hb', to: 'relay', ts: now(),
      type: 'node_heartbeat', node_id: 'n-hb', active_runs: 3, last_heartbeat_at: now(),
    })
    const ack = await ackP
    assert.equal((ack as any).node_id, 'n-hb')
    ws.terminate()
  } finally {
    await server.close()
  }
})

test('relay: heartbeat active_runs reflected in node list', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const nodeWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(nodeWs, 'n-runs')

    const hbAckP = waitForMsg(nodeWs, (m) => m.type === 'node_heartbeat_ack')
    send(nodeWs, {
      version: 1, kind: 'plaintext', from: 'n-runs', to: 'relay', ts: now(),
      type: 'node_heartbeat', node_id: 'n-runs', active_runs: 7, last_heartbeat_at: now(),
    })
    await hbAckP

    const cliWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    const nodes = await listNodes(cliWs)
    const found = nodes.find((n) => n.node_id === 'n-runs')
    assert.equal(found!.active_runs, 7)

    nodeWs.terminate()
    cliWs.terminate()
  } finally {
    await server.close()
  }
})

// ── stale / disconnect tests ───────────────────────────────────────────────

test('relay: disconnected node removed from registry', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const nodeWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(nodeWs, 'n-disco')
    nodeWs.close()
    await new Promise((r) => setTimeout(r, 200))

    const cliWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    const nodes = await listNodes(cliWs)
    assert.ok(!nodes.find((n) => n.node_id === 'n-disco'), 'disconnected node removed')
    cliWs.terminate()
  } finally {
    await server.close()
  }
})

test('relay: stale node (connected, no heartbeat) shows offline in list', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN, staleMs: 300 })
  try {
    const nodeWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(nodeWs, 'n-stale')

    // Wait past the stale threshold without sending heartbeats
    await new Promise((r) => setTimeout(r, 500))

    const cliWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    const nodes = await listNodes(cliWs)
    const found = nodes.find((n) => n.node_id === 'n-stale')
    assert.ok(found, 'stale node still in registry (connected)')
    assert.equal(found!.status, 'offline', 'stale heartbeat → offline')

    nodeWs.terminate()
    cliWs.terminate()
  } finally {
    await server.close()
  }
})

// ── CLI integration tests ──────────────────────────────────────────────────

test('vibe node list --remote: returns relay-registered nodes', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    // Register a node directly
    const nodeWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(nodeWs, 'cli-remote-node')

    // Query via CLI subprocess (async so relay event loop stays live)
    const r = await vibeAsync([
      'node', 'list', '--remote',
      '--relay', `ws://localhost:${server.port}`,
      '--token', TEST_TOKEN,
    ])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
    const found = nodes.find((n) => n.node_id === 'cli-remote-node')
    assert.ok(found, 'cli-remote-node in remote list')
    assert.equal(found!.transport, 'relay')

    nodeWs.terminate()
  } finally {
    await server.close()
  }
})

test('vibe node list --remote --token wrong: exits non-zero with error', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const r = await vibeAsync([
      'node', 'list', '--remote',
      '--relay', `ws://localhost:${server.port}`,
      '--token', 'totally-wrong',
    ])
    assert.notEqual(r.status, 0, 'wrong token should exit non-zero')
    assert.ok(r.stderr.length > 0, 'should write error to stderr')
  } finally {
    await server.close()
  }
})

test('vibe node list --remote without --relay: exits 1 with error', async () => {
  const r = spawnSync(NODE, [CLI, 'node', 'list', '--remote', '--token', 'x'], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.ok(r.stderr.includes('--relay'), 'error mentions --relay')
})

test('vibe node daemon --relay: registers with relay and sends heartbeats', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = spawn(NODE, [
    CLI, 'node', 'daemon', '--local',
    '--relay', `ws://localhost:${server.port}`,
    '--token', TEST_TOKEN,
    '--node-id', 'daemon-test-node',
  ], {
    env: { ...process.env, VIBE_NODE_HEARTBEAT_MS: '250' },
    stdio: 'pipe',
  })

  try {
    // Poll until daemon registers (up to 5s)
    let registered = false
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      const r = await vibeAsync([
        'node', 'list', '--remote',
        '--relay', `ws://localhost:${server.port}`,
        '--token', TEST_TOKEN,
      ])
      if (r.status === 0) {
        try {
          const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
          if (nodes.some((n) => n.node_id === 'daemon-test-node' && n.status === 'online')) {
            registered = true
            break
          }
        } catch {}
      }
    }
    assert.ok(registered, 'daemon registered with relay as online node')

    // Wait one more heartbeat cycle, verify still online
    await new Promise((r) => setTimeout(r, 400))
    const r = await vibeAsync([
      'node', 'list', '--remote',
      '--relay', `ws://localhost:${server.port}`,
      '--token', TEST_TOKEN,
    ])
    assert.equal(r.status, 0)
    const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
    const daemonNode = nodes.find((n) => n.node_id === 'daemon-test-node')
    assert.ok(daemonNode, 'daemon node still present')
    assert.equal(daemonNode!.status, 'online', 'heartbeat kept node online')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    await server.close()
  }
})

test('vibe node daemon --relay: node removed from relay after daemon exits', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = spawn(NODE, [
    CLI, 'node', 'daemon', '--local',
    '--relay', `ws://localhost:${server.port}`,
    '--token', TEST_TOKEN,
    '--node-id', 'daemon-exit-node',
  ], {
    env: { ...process.env, VIBE_NODE_HEARTBEAT_MS: '250' },
    stdio: 'pipe',
  })

  try {
    // Wait for registration
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      const r = await vibeAsync([
        'node', 'list', '--remote',
        '--relay', `ws://localhost:${server.port}`,
        '--token', TEST_TOKEN,
      ])
      if (r.status === 0) {
        try {
          const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
          if (nodes.some((n) => n.node_id === 'daemon-exit-node')) break
        } catch {}
      }
    }

    // Kill daemon and wait for cleanup
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 600))

    // Node should be removed (WS close triggers registry cleanup)
    const r = await vibeAsync([
      'node', 'list', '--remote',
      '--relay', `ws://localhost:${server.port}`,
      '--token', TEST_TOKEN,
    ])
    assert.equal(r.status, 0)
    const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
    assert.ok(!nodes.find((n) => n.node_id === 'daemon-exit-node'), 'daemon node removed after exit')
  } finally {
    if (!daemonProc.killed) daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 200))
    await server.close()
  }
})

// ── existing local node behavior unchanged ─────────────────────────────────

test('vibe node list (local, no --remote): unaffected by relay feature', () => {
  const r = spawnSync(NODE, [CLI, 'node', 'list', '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
  assert.ok(nodes.some((n) => n.node_id === 'local'), 'local node still present')
})
