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
import os from 'os'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { RunRecord, VibeNode } from '../src/types.js'
import type { RelayMessage } from '../src/relay/types.js'
import { startRelayServer } from '../src/relay/server.js'
import { remoteRunStart, remoteStop, remoteStream } from '../src/relay/client.js'
import { freshVibeDir } from './helpers/agent-fixtures.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
// test/fixtures/ contains fake claude binary for claude-code tests
const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures')

const TEST_TOKEN = `tok-${Date.now()}`

// Throwaway VIBE_DIR shared by every spawned daemon and CLI in this suite, so
// node identity / run records / events go to a temp dir instead of the real
// ~/.vibe. Run/event reads below also resolve against this dir.
const VIBE_DIR = freshVibeDir('vibe-relay-test-')

// ── helpers ────────────────────────────────────────────────────────────────

/** Async CLI invocation — does NOT block the event loop, so in-process relay stays live. */
async function vibeAsync(args: string[], env?: Record<string, string>, timeoutMs?: number): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(NODE, [CLI, ...args], {
      env: { ...process.env, VIBE_DIR, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
    if (timeoutMs) {
      setTimeout(() => { proc.kill('SIGTERM'); resolve({ status: 124, stdout, stderr: stderr + '\n[timeout]' }) }, timeoutMs)
    }
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

test('relay: stale disconnect of an old socket does not deregister a reconnected node', async () => {
  // A registers node_x; the node reconnects on a new socket B and re-registers
  // (B becomes the current owner). When the OLD socket A finally closes, the
  // live entry owned by B must survive — only the current owner may deregister.
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const aWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(aWs, 'node_x')
    const bWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(bWs, 'node_x') // B overwrites the registry entry → current owner

    aWs.close() // stale socket closes after the reconnect
    await new Promise((r) => setTimeout(r, 200))

    let cliWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    let nodes = await listNodes(cliWs)
    assert.ok(nodes.find((n) => n.node_id === 'node_x'), 'reconnected node still registered after old socket closed')
    cliWs.terminate()

    // Sanity: when the CURRENT owner B closes, the node is finally removed.
    bWs.close()
    await new Promise((r) => setTimeout(r, 200))
    cliWs = await connect(`ws://localhost:${server.port}?token=${TEST_TOKEN}`)
    nodes = await listNodes(cliWs)
    assert.ok(!nodes.find((n) => n.node_id === 'node_x'), 'node removed once the current owner disconnects')
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
    env: { ...process.env, VIBE_DIR, VIBE_NODE_HEARTBEAT_MS: '250' },
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
    env: { ...process.env, VIBE_DIR, VIBE_NODE_HEARTBEAT_MS: '250' },
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

// ── MVP 3D-2A: run_start routing (request/ack only — no runner spawned) ──────

test('relay: run_start routed to node, mock node returns run_start_ack', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    // Simulate a daemon: connect, register, handle run_start manually
    const nodeWs = await connect(`ws://127.0.0.1:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(nodeWs, 'mock-daemon')

    // Set up mock daemon to respond to run_start
    nodeWs.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'run_start') {
          const fakeRecord: RunRecord = {
            run_id: `run_test_${Date.now().toString(36)}`,
            session_id: '',
            node_id: 'mock-daemon',
            node_selector: 'mock-daemon',
            agent: (msg as import('../src/relay/types.js').RunStartMsg).agent,
            status: 'queued',
            workspace_path: '/tmp/test-ws',
            created_at: now(),
            updated_at: now(),
          }
          send(nodeWs, {
            version: 1, kind: 'plaintext', from: 'mock-daemon', to: 'relay', ts: now(),
            type: 'run_start_ack', req_id: msg.req_id, ok: true, record: fakeRecord,
          })
        }
      } catch {}
    })

    // CLI side: use remoteRunStart directly
    const record = await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'mock-daemon',
      { agent: 'mock' },
    )
    assert.ok(record.run_id.startsWith('run_'), 'run_id has correct prefix')
    assert.equal(record.status, 'queued', 'status is queued (no runner yet)')
    assert.equal(record.node_id, 'mock-daemon', 'node_id matches target')

    nodeWs.terminate()
  } finally {
    await server.close()
  }
})

test('relay: run_start to unknown node returns error', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    await assert.rejects(
      remoteRunStart(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'no-such-node', { agent: 'mock' }),
      /Node not found/,
    )
  } finally {
    await server.close()
  }
})

test('vibe run start --node remote-node --relay ...: returns queued RunRecord JSON', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = spawn(NODE, [
    CLI, 'node', 'daemon', '--local',
    '--relay', `ws://127.0.0.1:${server.port}`,
    '--token', TEST_TOKEN,
    '--node-id', 'run-start-node',
  ], {
    env: { ...process.env, VIBE_DIR, VIBE_NODE_HEARTBEAT_MS: '250' },
    stdio: 'pipe',
  })

  try {
    // Wait for daemon to register
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      const r = await vibeAsync([
        'node', 'list', '--remote',
        '--relay', `ws://127.0.0.1:${server.port}`,
        '--token', TEST_TOKEN,
      ])
      if (r.status === 0) {
        try {
          const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
          if (nodes.some((n) => n.node_id === 'run-start-node')) break
        } catch {}
      }
    }

    // Now request a remote run start via CLI
    const r = await vibeAsync([
      'run', 'start',
      '--node', 'run-start-node',
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
      '--agent', 'mock',
      '--workspace-key', 'relay-test-run',
    ])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const record = JSON.parse(r.stdout.trim()) as RunRecord
    assert.ok(record.run_id.startsWith('run_'), 'run_id correct format')
    assert.equal(record.status, 'running', 'status is running — mock runner spawned')
    assert.equal(record.node_id, 'run-start-node', 'node_id matches remote node')
    assert.equal(record.agent, 'mock', 'agent echoed back')
    assert.ok(record.session_id, 'session_id set (runner PID)')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

// ── MVP 3D-2B: daemon spawns mock runner ──────────────────────────────────

/** Spawn a daemon subprocess connected to the relay and wait until it registers. */
async function spawnAndWaitForDaemon(
  serverPort: number,
  nodeId: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<ReturnType<typeof spawn>> {
  const daemonProc = spawn(NODE, [
    CLI, 'node', 'daemon', '--local',
    '--relay', `ws://127.0.0.1:${serverPort}`,
    '--token', TEST_TOKEN,
    '--node-id', nodeId,
  ], {
    env: { ...process.env, VIBE_DIR, VIBE_NODE_HEARTBEAT_MS: '250', ...extraEnv },
    stdio: 'pipe',
  })

  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300))
    const r = await vibeAsync([
      'node', 'list', '--remote',
      '--relay', `ws://127.0.0.1:${serverPort}`,
      '--token', TEST_TOKEN,
    ])
    if (r.status === 0) {
      try {
        const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
        if (nodes.some((n) => n.node_id === nodeId)) return daemonProc
      } catch {}
    }
  }
  throw new Error(`daemon ${nodeId} did not register within 6s`)
}

test('relay daemon: remote mock run spawns runner — running → completed, events written', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'mock-lifecycle-daemon')

  try {
    const record = await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'mock-lifecycle-daemon',
      { agent: 'mock', workspaceKey: 'relay-lifecycle-test' },
    )
    assert.equal(record.status, 'running', 'ack contains running status')
    assert.ok(record.session_id, 'session_id set (runner PID)')

    // Poll RunRecord until completed (mock runner takes ~6s)
    const runPath = path.join(VIBE_DIR, 'runs', `${record.run_id}.json`)
    const eventsPath = path.join(VIBE_DIR, 'events', `${record.run_id}.jsonl`)
    let completed = false
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 600))
      try {
        const cur = JSON.parse(fs.readFileSync(runPath, 'utf8')) as RunRecord
        if (cur.status === 'completed') { completed = true; break }
      } catch {}
    }
    assert.ok(completed, 'mock run reached completed within 15s')

    // Verify events log has expected event types
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(lines.some((e: any) => e.type === 'status' && e.status === 'running'), 'has running event')
    assert.ok(lines.some((e: any) => e.type === 'log'), 'has log events')
    assert.ok(lines.some((e: any) => e.type === 'approval_required'), 'has approval_required event')
    assert.ok(lines.some((e: any) => e.type === 'status' && e.status === 'completed'), 'has completed event')

    // vibe run status should reflect completed (shared ~/.vibe in local test)
    const statusR = await vibeAsync(['run', 'status', record.run_id])
    assert.equal(statusR.status, 0, 'run status exits 0')
    const statusRecord = JSON.parse(statusR.stdout.trim()) as RunRecord
    assert.equal(statusRecord.status, 'completed', 'vibe run status shows completed')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})


test('vibe run start --node remote --relay: CLI returns running RunRecord (3D-2B)', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'cli-2b-node')

  try {
    const r = await vibeAsync([
      'run', 'start',
      '--node', 'cli-2b-node',
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
      '--agent', 'mock',
      '--workspace-key', 'cli-2b-run',
    ])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const record = JSON.parse(r.stdout.trim()) as RunRecord
    assert.equal(record.status, 'running', 'CLI returns running record after daemon spawns runner')
    assert.equal(record.node_id, 'cli-2b-node', 'node_id matches remote node')
    assert.ok(record.session_id, 'session_id set')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

// ── MVP 3D-3A: remote stream fanout ───────────────────────────────────────

test('relay: run_stream_subscribe receives run_stream_subscribe_ack', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const ws = await connect(`ws://127.0.0.1:${server.port}?token=${TEST_TOKEN}`)
    const ackP = waitForMsg(ws, (m) => m.type === 'run_stream_subscribe_ack')
    send(ws, { version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: now(), type: 'run_stream_subscribe', run_id: 'run_abc' })
    const ack = await ackP
    assert.equal((ack as any).run_id, 'run_abc')
    assert.equal((ack as any).ok, true)
    ws.terminate()
  } finally {
    await server.close()
  }
})

test('relay: run_event fans out to subscriber', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const runId = 'run_fanout_test'

    // CLI subscriber
    const cliWs = await connect(`ws://127.0.0.1:${server.port}?token=${TEST_TOKEN}`)
    const eventAckP = waitForMsg(cliWs, (m) => m.type === 'run_stream_subscribe_ack')
    send(cliWs, { version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: now(), type: 'run_stream_subscribe', run_id: runId })
    await eventAckP

    // Node ws sends a run_event
    const nodeWs = await connect(`ws://127.0.0.1:${server.port}?token=${TEST_TOKEN}`)
    const receivedP = waitForMsg(cliWs, (m) => m.type === 'run_event')
    const fakeEvent = { type: 'log' as const, run_id: runId, session_id: '', stream: 'stdout' as const, message: 'hello', ts: now() }
    send(nodeWs, { version: 1, kind: 'plaintext', from: 'test-node', to: 'relay', ts: now(), type: 'run_event', run_id: runId, event: fakeEvent })

    const received = await receivedP
    assert.equal((received as any).run_id, runId)
    assert.equal((received as any).event.message, 'hello')

    cliWs.terminate()
    nodeWs.terminate()
  } finally {
    await server.close()
  }
})

test('relay: multiple subscribers all receive run_event', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const runId = 'run_multi_sub'

    // Subscribe two CLI clients
    const ws1 = await connect(`ws://127.0.0.1:${server.port}?token=${TEST_TOKEN}`)
    const ws2 = await connect(`ws://127.0.0.1:${server.port}?token=${TEST_TOKEN}`)
    await Promise.all([
      (async () => {
        const p = waitForMsg(ws1, (m) => m.type === 'run_stream_subscribe_ack')
        send(ws1, { version: 1, kind: 'plaintext', from: 'cli1', to: 'relay', ts: now(), type: 'run_stream_subscribe', run_id: runId })
        await p
      })(),
      (async () => {
        const p = waitForMsg(ws2, (m) => m.type === 'run_stream_subscribe_ack')
        send(ws2, { version: 1, kind: 'plaintext', from: 'cli2', to: 'relay', ts: now(), type: 'run_stream_subscribe', run_id: runId })
        await p
      })(),
    ])

    // Node sends one event
    const nodeWs = await connect(`ws://127.0.0.1:${server.port}?token=${TEST_TOKEN}`)
    const recv1P = waitForMsg(ws1, (m) => m.type === 'run_event')
    const recv2P = waitForMsg(ws2, (m) => m.type === 'run_event')
    const fakeEvent = { type: 'log' as const, run_id: runId, session_id: '', stream: 'stdout' as const, message: 'broadcast', ts: now() }
    send(nodeWs, { version: 1, kind: 'plaintext', from: 'test-node', to: 'relay', ts: now(), type: 'run_event', run_id: runId, event: fakeEvent })

    const [r1, r2] = await Promise.all([recv1P, recv2P])
    assert.equal((r1 as any).event.message, 'broadcast', 'subscriber 1 received event')
    assert.equal((r2 as any).event.message, 'broadcast', 'subscriber 2 received event')

    ws1.terminate(); ws2.terminate(); nodeWs.terminate()
  } finally {
    await server.close()
  }
})

test('relay: remote stream receives all events and resolves after completed', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'stream-daemon')

  try {
    // Start a remote mock run
    const record = await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'stream-daemon',
      { agent: 'mock', workspaceKey: 'relay-stream-test' },
    )
    assert.equal(record.status, 'running')

    // Stream events — capture stdout to inspect JSONL lines
    const lines: string[] = []
    const origW = process.stdout.write.bind(process.stdout)
    ;(process.stdout as any).write = (chunk: string | Buffer, ...args: any[]) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString()
      lines.push(...s.split('\n').filter(Boolean))
      return origW(chunk, ...args)
    }

    await remoteStream(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, record.run_id)

    ;(process.stdout as any).write = origW

    // remoteStream resolved → terminal event received
    assert.ok(lines.length > 0, 'received at least one event')
    const events = lines.map((l) => JSON.parse(l))
    assert.ok(events.some((e: any) => e.type === 'status' && e.status === 'completed'), 'received completed event')
    assert.ok(events.some((e: any) => e.type === 'log'), 'received log events')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

test('vibe run stream --relay: CLI outputs JSONL events and exits 0', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'cli-stream-daemon')

  try {
    // Start remote run, get run_id
    const startR = await vibeAsync([
      'run', 'start',
      '--node', 'cli-stream-daemon',
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
      '--agent', 'mock',
      '--workspace-key', 'cli-stream-run',
    ])
    assert.equal(startR.status, 0, `run start stderr: ${startR.stderr}`)
    const record = JSON.parse(startR.stdout.trim()) as RunRecord

    // Stream via CLI (waits until completed event received or 30s timeout)
    const streamR = await vibeAsync([
      'run', 'stream', record.run_id,
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
    ], undefined, 30_000)
    assert.equal(streamR.status, 0, `run stream stderr: ${streamR.stderr}`)

    const lines = streamR.stdout.trim().split('\n').filter(Boolean)
    assert.ok(lines.length > 0, 'CLI stream output has lines')
    const events = lines.map((l) => JSON.parse(l))
    assert.ok(events.some((e: any) => e.type === 'status' && e.status === 'completed'), 'CLI stream output has completed event')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

// ── MVP 3D-3B: remote stop ────────────────────────────────────────────────

test('relay: run_stop_request for unknown run_id returns run_not_found', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    await assert.rejects(
      remoteStop(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'run_does_not_exist'),
      /run_not_found/,
    )
  } finally {
    await server.close()
  }
})

test('relay: run_stop_request when owning node is offline returns node_offline', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'offline-node-test')

  try {
    // Start a run to populate relay's ownership map
    const record = await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'offline-node-test',
      { agent: 'mock', workspaceKey: 'offline-node-ws' },
    )
    const runId = record.run_id

    // Kill daemon — node goes offline, ownership entry remains in relay
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 600))

    // Stop should fail with node_offline
    await assert.rejects(
      remoteStop(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, runId),
      /node_offline/,
    )
  } finally {
    if (!daemonProc.killed) daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 200))
    await server.close()
  }
})

test('relay daemon: remote stop returns stopped RunRecord', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'stop-ack-daemon')

  try {
    const record = await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'stop-ack-daemon',
      { agent: 'mock', workspaceKey: 'stop-ack-test' },
    )
    assert.equal(record.status, 'running')

    // Stop before mock runner completes (~6s)
    await new Promise((r) => setTimeout(r, 500))
    const stopped = await remoteStop(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, record.run_id)
    assert.equal(stopped.status, 'stopped', 'stop returns stopped record')
    assert.equal(stopped.run_id, record.run_id, 'run_id matches')
    assert.equal(stopped.node_id, 'stop-ack-daemon', 'node_id preserved')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

test('relay daemon: remote stop → stream subscriber receives stopped event and exits', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'stop-stream-node')

  try {
    // Start run
    const startR = await vibeAsync([
      'run', 'start',
      '--node', 'stop-stream-node',
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
      '--agent', 'mock',
      '--workspace-key', 'stop-stream-ws',
    ])
    assert.equal(startR.status, 0, `run start stderr: ${startR.stderr}`)
    const record = JSON.parse(startR.stdout.trim()) as RunRecord

    // Start streaming (exits on terminal event)
    const streamP = vibeAsync([
      'run', 'stream', record.run_id,
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
    ], undefined, 20_000)

    // Wait for stream to subscribe, then stop
    await new Promise((r) => setTimeout(r, 800))
    const stopR = await vibeAsync([
      'run', 'stop', record.run_id,
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
    ])
    assert.equal(stopR.status, 0, `stop stderr: ${stopR.stderr}`)
    const stoppedRecord = JSON.parse(stopR.stdout.trim()) as RunRecord
    assert.equal(stoppedRecord.status, 'stopped', 'stop returns stopped record')

    // Stream must exit after receiving stopped event
    const streamR = await streamP
    assert.equal(streamR.status, 0, `stream stderr: ${streamR.stderr}`)
    const lines = streamR.stdout.trim().split('\n').filter(Boolean)
    const events = lines.map((l) => JSON.parse(l))
    assert.ok(events.some((e: any) => e.type === 'status' && e.status === 'stopped'), 'stream received stopped event')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

test('vibe run stop --relay: CLI returns stopped RunRecord JSON', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'cli-stop-node')

  try {
    const startR = await vibeAsync([
      'run', 'start',
      '--node', 'cli-stop-node',
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
      '--agent', 'mock',
      '--workspace-key', 'cli-stop-run',
    ])
    assert.equal(startR.status, 0)
    const record = JSON.parse(startR.stdout.trim()) as RunRecord

    await new Promise((r) => setTimeout(r, 400))

    const stopR = await vibeAsync([
      'run', 'stop', record.run_id,
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
    ])
    assert.equal(stopR.status, 0, `stderr: ${stopR.stderr}`)
    const stopped = JSON.parse(stopR.stdout.trim()) as RunRecord
    assert.equal(stopped.status, 'stopped', 'CLI stop output has status=stopped')
    assert.equal(stopped.run_id, record.run_id, 'run_id matches')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

// ── MVP 3E: Claude Code over relay ────────────────────────────────────────

test('relay: prompt_content transmitted over relay (not controller file path)', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    // Fake daemon — captures the run_start message, acks without running anything.
    const nodeWs = await connect(`ws://127.0.0.1:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(nodeWs, 'prompt-inspect-node')

    let capturedMsg: RelayMessage | null = null
    nodeWs.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'run_start') {
          capturedMsg = msg
          send(nodeWs, {
            version: 1, kind: 'plaintext', from: 'prompt-inspect-node', to: 'relay', ts: now(),
            type: 'run_start_ack', req_id: msg.req_id, ok: true,
            record: {
              run_id: 'run_prompt_test', session_id: '0', node_id: 'prompt-inspect-node',
              node_selector: 'prompt-inspect-node', agent: (msg as import('../src/relay/types.js').RunStartMsg).agent, status: 'running',
              workspace_path: '/tmp', created_at: now(), updated_at: now(),
            },
          })
        }
      } catch {}
    })

    const pf = path.join(os.tmpdir(), `relay-prompt-test-${Date.now()}.md`)
    const content = 'write a hello world script'
    fs.writeFileSync(pf, content)

    await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'prompt-inspect-node',
      { agent: 'mock', workspaceKey: 'prompt-inspect-ws', promptFile: pf },
    )

    assert.ok(capturedMsg, 'run_start received by node')
    assert.equal((capturedMsg as any).prompt_content, content, 'prompt_content contains file text')
    assert.ok(!(capturedMsg as any).prompt_file, 'controller path not sent in relay message')

    nodeWs.terminate()
  } finally {
    await server.close()
  }
})

test('relay: permission_mode unsafe-skip preserved in relay message', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const nodeWs = await connect(`ws://127.0.0.1:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(nodeWs, 'perm-inspect-node')

    let capturedPermMode: string | undefined
    nodeWs.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'run_start') {
          capturedPermMode = (msg as any).permission_mode
          send(nodeWs, {
            version: 1, kind: 'plaintext', from: 'perm-inspect-node', to: 'relay', ts: now(),
            type: 'run_start_ack', req_id: msg.req_id, ok: true,
            record: {
              run_id: 'run_perm_test', session_id: '0', node_id: 'perm-inspect-node',
              agent: (msg as import('../src/relay/types.js').RunStartMsg).agent, status: 'running',
              workspace_path: '/tmp', created_at: now(), updated_at: now(),
            },
          })
        }
      } catch {}
    })

    await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'perm-inspect-node',
      { agent: 'mock', workspaceKey: 'perm-inspect-ws', permissionMode: 'unsafe-skip' },
    )

    assert.equal(capturedPermMode, 'unsafe-skip', 'permission_mode preserved in relay message')
    nodeWs.terminate()
  } finally {
    await server.close()
  }
})

test('relay daemon: remote claude-code with fake claude exits 0 → completed', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'cc-success-node', {
    PATH: FIXTURES + path.delimiter + process.env.PATH,
  })

  try {
    const pf = path.join(os.tmpdir(), `cc-relay-test-${Date.now()}.md`)
    fs.writeFileSync(pf, 'write hello world')

    const record = await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'cc-success-node',
      { agent: 'claude-code', workspaceKey: 'cc-remote-success', promptFile: pf },
    )
    assert.equal(record.status, 'running', 'status is running')
    assert.equal(record.agent, 'claude-code', 'agent is claude-code')

    // Capture stream output
    const lines: string[] = []
    const origW = process.stdout.write.bind(process.stdout)
    ;(process.stdout as any).write = (chunk: string | Buffer, ...args: any[]) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString()
      lines.push(...s.split('\n').filter(Boolean))
      return origW(chunk, ...args)
    }

    await remoteStream(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, record.run_id)

    ;(process.stdout as any).write = origW

    const events = lines.map((l) => JSON.parse(l))
    assert.ok(events.some((e: any) => e.type === 'log'), 'received log events from claude')
    assert.ok(
      events.some((e: any) => e.type === 'status' && e.status === 'completed'),
      'received completed event',
    )
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

test('relay daemon: remote claude-code with fake claude exits nonzero → failed', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'cc-fail-node', {
    PATH: FIXTURES + path.delimiter + process.env.PATH,
    FAKE_CLAUDE_EXIT_CODE: '1',
  })

  try {
    const pf = path.join(os.tmpdir(), `cc-relay-fail-${Date.now()}.md`)
    fs.writeFileSync(pf, 'this will fail')

    const record = await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'cc-fail-node',
      { agent: 'claude-code', workspaceKey: 'cc-remote-fail', promptFile: pf },
    )
    assert.equal(record.status, 'running')

    const lines: string[] = []
    const origW = process.stdout.write.bind(process.stdout)
    ;(process.stdout as any).write = (chunk: string | Buffer, ...args: any[]) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString()
      lines.push(...s.split('\n').filter(Boolean))
      return origW(chunk, ...args)
    }

    await remoteStream(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, record.run_id)

    ;(process.stdout as any).write = origW

    const events = lines.map((l) => JSON.parse(l))
    assert.ok(
      events.some((e: any) => e.type === 'status' && e.status === 'failed'),
      'received failed event',
    )
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

test('relay daemon: remote claude-code hangs → remote stop → stream sees stopped', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'cc-hang-node', {
    PATH: FIXTURES + path.delimiter + process.env.PATH,
    FAKE_CLAUDE_HANG: '1',
  })

  try {
    const pf = path.join(os.tmpdir(), `cc-relay-hang-${Date.now()}.md`)
    fs.writeFileSync(pf, 'long running task')

    const record = await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'cc-hang-node',
      { agent: 'claude-code', workspaceKey: 'cc-remote-hang', promptFile: pf },
    )
    assert.equal(record.status, 'running')

    // Start stream (resolves on terminal event)
    const lines: string[] = []
    const origW = process.stdout.write.bind(process.stdout)
    ;(process.stdout as any).write = (chunk: string | Buffer, ...args: any[]) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString()
      lines.push(...s.split('\n').filter(Boolean))
      return origW(chunk, ...args)
    }
    const streamP = remoteStream(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, record.run_id)

    // Wait for _claude-runner to write child_pid to RunRecord
    await new Promise((r) => setTimeout(r, 1500))

    const stopped = await remoteStop(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, record.run_id)
    assert.equal(stopped.status, 'stopped', 'stop ack returns stopped record')

    await streamP
    ;(process.stdout as any).write = origW

    const events = lines.map((l) => JSON.parse(l))
    assert.ok(
      events.some((e: any) => e.type === 'status' && (e.status === 'stopped' || e.status === 'failed')),
      'stream received terminal event after stop',
    )
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

test('relay daemon: unsupported agent (codex) returns agent_not_supported', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'unsupported-agent-node')

  try {
    await assert.rejects(
      remoteRunStart(
        `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'unsupported-agent-node',
        { agent: 'codex' as any },
      ),
      /agent_not_supported/i,
    )
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

// ── MVP 3F: Symphony relay integration ───────────────────────────────────────

test('vibe symphony start --node --relay: returns running RunRecord with symphony metadata', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'sym-start-node')

  try {
    const r = await vibeAsync([
      'symphony', 'start',
      '--node', 'sym-start-node',
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
      '--agent', 'mock',
      '--issue-id', 'SYM-RELAY-1',
      '--issue-title', 'relay integration test',
      '--workspace-key', 'sym-relay-ws',
    ])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const record = JSON.parse(r.stdout.trim()) as RunRecord
    assert.equal(record.status, 'running', 'status is running')
    assert.equal(record.agent, 'mock', 'agent is mock')
    assert.equal(record.node_id, 'sym-start-node', 'dispatched to correct node')
    assert.equal(record.metadata?.source, 'symphony', 'metadata.source is symphony')
    assert.equal(record.metadata?.issue_id, 'SYM-RELAY-1', 'issue_id in metadata')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

test('vibe symphony stream --relay: outputs JSONL events and exits on completed', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'sym-stream-node')

  try {
    const startR = await vibeAsync([
      'symphony', 'start',
      '--node', 'sym-stream-node',
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
      '--agent', 'mock',
      '--issue-id', 'SYM-RELAY-2',
      '--workspace-key', 'sym-stream-ws',
    ])
    assert.equal(startR.status, 0, `start stderr: ${startR.stderr}`)
    const record = JSON.parse(startR.stdout.trim()) as RunRecord

    const streamR = await vibeAsync([
      'symphony', 'stream', record.run_id,
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
    ], undefined, 30_000)
    assert.equal(streamR.status, 0, `stream stderr: ${streamR.stderr}`)

    const lines = streamR.stdout.trim().split('\n').filter(Boolean)
    assert.ok(lines.length > 0, 'received events')
    const events = lines.map((l) => JSON.parse(l))
    assert.ok(events.some((e: any) => e.type === 'status' && e.status === 'completed'), 'completed event received')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

test('vibe symphony stop --relay: returns stopped RunRecord', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'sym-stop-node')

  try {
    const startR = await vibeAsync([
      'symphony', 'start',
      '--node', 'sym-stop-node',
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
      '--agent', 'mock',
      '--issue-id', 'SYM-RELAY-3',
      '--workspace-key', 'sym-stop-ws',
    ])
    assert.equal(startR.status, 0)
    const record = JSON.parse(startR.stdout.trim()) as RunRecord

    await new Promise((r) => setTimeout(r, 400))

    const stopR = await vibeAsync([
      'symphony', 'stop', record.run_id,
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
    ])
    assert.equal(stopR.status, 0, `stop stderr: ${stopR.stderr}`)
    const stopped = JSON.parse(stopR.stdout.trim()) as RunRecord
    assert.equal(stopped.status, 'stopped', 'stop returns stopped record')
    assert.equal(stopped.run_id, record.run_id, 'run_id matches')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

// ── node-authoritative run status over relay (stall reconciliation) ────────

test('vibe symphony status --relay: returns authoritative completed RunRecord from node', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const daemonProc = await spawnAndWaitForDaemon(server.port, 'sym-status-node')

  try {
    const record = await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'sym-status-node',
      { agent: 'mock', workspaceKey: 'sym-status-ws' },
    )
    assert.equal(record.status, 'running', 'run starts running')

    // Wait until the node's authoritative local record reaches completed.
    const runPath = path.join(VIBE_DIR, 'runs', `${record.run_id}.json`)
    let completed = false
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 600))
      try {
        const cur = JSON.parse(fs.readFileSync(runPath, 'utf8')) as RunRecord
        if (cur.status === 'completed') { completed = true; break }
      } catch {}
    }
    assert.ok(completed, 'node-local record reached completed')

    // The remote status query must reflect the node's authoritative completed
    // status (this is the JOZ-37 false-stall fix: --relay must NOT read the
    // local controller record, which for a remote run would be stale).
    const statusR = await vibeAsync([
      'symphony', 'status', record.run_id,
      '--relay', `ws://127.0.0.1:${server.port}`,
      '--token', TEST_TOKEN,
    ])
    assert.equal(statusR.status, 0, `status stderr: ${statusR.stderr}`)
    const remote = JSON.parse(statusR.stdout.trim()) as RunRecord
    assert.equal(remote.run_id, record.run_id, 'run_id matches')
    assert.equal(remote.status, 'completed', 'remote status is authoritative completed')
    // No secret material in the returned record / output.
    assert.ok(!statusR.stdout.includes(TEST_TOKEN), 'token not echoed in status output')
  } finally {
    daemonProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
    await server.close()
  }
})

test('remoteRunStatus: unknown run rejects with run_not_found', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    const { remoteRunStatus } = await import('../src/relay/client.js')
    await assert.rejects(
      remoteRunStatus(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'run_does_not_exist'),
      /run_not_found/,
      'unknown run surfaces run_not_found, not a silent stale record',
    )
  } finally {
    await server.close()
  }
})

test('remoteRunStatus: owning node offline rejects with node_offline', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  try {
    // Fake node: register, ack a run_start (so relay records ownership), then drop.
    const nodeWs = await connect(`ws://127.0.0.1:${server.port}?token=${TEST_TOKEN}`)
    await registerNode(nodeWs, 'offline-status-node')
    let knownRunId = ''
    nodeWs.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'run_start') {
          knownRunId = `run_off_${Date.now().toString(36)}`
          send(nodeWs, {
            version: 1, kind: 'plaintext', from: 'offline-status-node', to: 'relay', ts: now(),
            type: 'run_start_ack', req_id: msg.req_id, ok: true,
            record: {
              run_id: knownRunId, session_id: '', node_id: 'offline-status-node',
              node_selector: 'offline-status-node', agent: 'mock', status: 'queued',
              workspace_path: '/tmp/off-ws', created_at: now(), updated_at: now(),
            } as RunRecord,
          })
        }
      } catch {}
    })
    const started = await remoteRunStart(
      `ws://127.0.0.1:${server.port}`, TEST_TOKEN, 'offline-status-node', { agent: 'mock' },
    )

    // Node goes away; ownership persists on the relay → status must report node_offline.
    nodeWs.terminate()
    await new Promise((r) => setTimeout(r, 200))

    const { remoteRunStatus } = await import('../src/relay/client.js')
    await assert.rejects(
      remoteRunStatus(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, started.run_id),
      /node_offline/,
      'offline owner surfaces node_offline diagnostic',
    )
  } finally {
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
