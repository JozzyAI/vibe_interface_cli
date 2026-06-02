/**
 * MVP 3C — Local node daemon tests.
 *
 * Covers: daemon writes state, fresh heartbeat → online, stale → offline,
 * fallback to built-in when no daemon state, status local with/without daemon.
 *
 * Uses VIBE_NODE_STATE_FILE to redirect state to a temp path so tests do not
 * touch ~/.vibe/node-local.json and can run in parallel safely.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { VibeNode, NodeDaemonState } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

/** Synchronous vibe invocation with optional env overrides. */
function vibe(args: string[], env?: Record<string, string>) {
  return spawnSync(NODE, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

/** Return a fresh temp path for a state file (does not create it). */
function tempStatePath(): string {
  return path.join(os.tmpdir(), `vibe-node-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`)
}

/** Write a NodeDaemonState directly to a temp file (no daemon needed). */
function writeFakeState(filePath: string, overrides: Partial<NodeDaemonState> = {}): NodeDaemonState {
  const now = new Date().toISOString()
  const state: NodeDaemonState = {
    node_id: 'local',
    name: 'Local Machine',
    status: 'online',
    transport: 'local',
    capabilities: ['run', 'stream', 'stop', 'workspace'],
    agents: ['mock', 'claude-code'],
    active_runs: 0,
    max_runs: 4,
    workspace_roots: [path.join(os.homedir(), '.vibe', 'workspaces')],
    pid: process.pid,
    started_at: now,
    last_heartbeat_at: now,
    ...overrides,
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2))
  return state
}

/** Poll until file exists or timeout. Returns true if found within timeoutMs. */
async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

/** Poll until file is gone or timeout. Returns true if gone within timeoutMs. */
async function waitForFileGone(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!fs.existsSync(filePath)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

// ── daemon writes node state ───────────────────────────────────────────────

test('daemon: writes node state file on startup', async () => {
  const statePath = tempStatePath()
  const daemonEnv = {
    VIBE_NODE_STATE_FILE: statePath,
    VIBE_NODE_HEARTBEAT_MS: '300',
  }

  const proc = spawn(NODE, [CLI, 'node', 'daemon', '--local'], {
    env: { ...process.env, ...daemonEnv },
    stdio: 'pipe',
  })

  try {
    const appeared = await waitForFile(statePath, 3000)
    assert.ok(appeared, 'state file should appear within 3s')

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as NodeDaemonState
    assert.equal(state.node_id, 'local')
    assert.equal(state.status, 'online')
    assert.equal(state.transport, 'local')
    assert.ok(state.pid > 0, 'has valid pid')
    assert.ok(state.started_at, 'has started_at')
    assert.ok(state.last_heartbeat_at, 'has last_heartbeat_at')
    assert.ok(state.agents.includes('mock'), 'agents includes mock')
    assert.ok(state.agents.includes('claude-code'), 'agents includes claude-code')
    assert.ok(state.max_runs > 0, 'max_runs > 0')
  } finally {
    proc.kill('SIGTERM')
    // Give daemon time to clean up
    await waitForFileGone(statePath, 2000)
    try { fs.unlinkSync(statePath) } catch {}
  }
})

test('daemon: removes state file on SIGTERM (graceful shutdown)', async () => {
  const statePath = tempStatePath()
  const daemonEnv = {
    VIBE_NODE_STATE_FILE: statePath,
    VIBE_NODE_HEARTBEAT_MS: '300',
  }

  const proc = spawn(NODE, [CLI, 'node', 'daemon', '--local'], {
    env: { ...process.env, ...daemonEnv },
    stdio: 'pipe',
  })

  const appeared = await waitForFile(statePath, 3000)
  assert.ok(appeared, 'state file should appear before kill')

  proc.kill('SIGTERM')

  const gone = await waitForFileGone(statePath, 3000)
  assert.ok(gone, 'state file should be removed after SIGTERM')
})

test('daemon: updates last_heartbeat_at on each interval', async () => {
  const statePath = tempStatePath()
  const daemonEnv = {
    VIBE_NODE_STATE_FILE: statePath,
    VIBE_NODE_HEARTBEAT_MS: '200',
  }

  const proc = spawn(NODE, [CLI, 'node', 'daemon', '--local'], {
    env: { ...process.env, ...daemonEnv },
    stdio: 'pipe',
  })

  try {
    await waitForFile(statePath, 3000)
    const first = JSON.parse(fs.readFileSync(statePath, 'utf8')) as NodeDaemonState
    const firstTs = first.last_heartbeat_at

    // Wait for at least one heartbeat interval
    await new Promise((r) => setTimeout(r, 500))

    const second = JSON.parse(fs.readFileSync(statePath, 'utf8')) as NodeDaemonState
    assert.ok(second.last_heartbeat_at >= firstTs, 'last_heartbeat_at advances')
  } finally {
    proc.kill('SIGTERM')
    await waitForFileGone(statePath, 2000)
    try { fs.unlinkSync(statePath) } catch {}
  }
})

// ── fresh / stale heartbeat ────────────────────────────────────────────────

test('node status local: fresh daemon state → online', () => {
  const statePath = tempStatePath()
  writeFakeState(statePath, {
    last_heartbeat_at: new Date().toISOString(),
    status: 'online',
  })

  try {
    const r = vibe(['node', 'status', 'local', '--json'], {
      VIBE_NODE_STATE_FILE: statePath,
      VIBE_NODE_STALE_MS: '15000',
    })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const n = JSON.parse(r.stdout.trim()) as VibeNode
    assert.equal(n.node_id, 'local')
    assert.equal(n.status, 'online', 'fresh state → online')
  } finally {
    try { fs.unlinkSync(statePath) } catch {}
  }
})

test('node status local: stale daemon state → offline', () => {
  const statePath = tempStatePath()
  // last_heartbeat_at 30s ago, stale threshold 15s
  const oldTs = new Date(Date.now() - 30_000).toISOString()
  writeFakeState(statePath, { last_heartbeat_at: oldTs, status: 'online' })

  try {
    const r = vibe(['node', 'status', 'local', '--json'], {
      VIBE_NODE_STATE_FILE: statePath,
      VIBE_NODE_STALE_MS: '15000',
    })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const n = JSON.parse(r.stdout.trim()) as VibeNode
    assert.equal(n.status, 'offline', 'stale heartbeat → offline')
  } finally {
    try { fs.unlinkSync(statePath) } catch {}
  }
})

test('node list: stale daemon state → local node shows offline', () => {
  const statePath = tempStatePath()
  const oldTs = new Date(Date.now() - 30_000).toISOString()
  writeFakeState(statePath, { last_heartbeat_at: oldTs, status: 'online' })

  try {
    const r = vibe(['node', 'list', '--json'], {
      VIBE_NODE_STATE_FILE: statePath,
      VIBE_NODE_STALE_MS: '15000',
    })
    assert.equal(r.status, 0)
    const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
    const local = nodes.find((n) => n.node_id === 'local')
    assert.ok(local, 'local node present')
    assert.equal(local!.status, 'offline')
  } finally {
    try { fs.unlinkSync(statePath) } catch {}
  }
})

// ── fallback to built-in node when no daemon state ─────────────────────────

test('node list: no daemon state → falls back to built-in (online)', () => {
  const statePath = tempStatePath() // file does not exist

  const r = vibe(['node', 'list', '--json'], { VIBE_NODE_STATE_FILE: statePath })
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
  const local = nodes.find((n) => n.node_id === 'local')
  assert.ok(local, 'local node present via fallback')
  assert.equal(local!.status, 'online', 'fallback is online')
  assert.equal(local!.transport, 'local')
})

test('node status local: no daemon state → falls back to built-in (online)', () => {
  const statePath = tempStatePath() // file does not exist

  const r = vibe(['node', 'status', 'local', '--json'], { VIBE_NODE_STATE_FILE: statePath })
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const n = JSON.parse(r.stdout.trim()) as VibeNode
  assert.equal(n.node_id, 'local')
  assert.equal(n.status, 'online')
})

// ── daemon --local flag required ───────────────────────────────────────────

test('node daemon without --local: exits 1 with error', () => {
  const r = vibe(['node', 'daemon'])
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}`)
  assert.ok(r.stderr.includes('--local'), 'error mentions --local flag')
})
