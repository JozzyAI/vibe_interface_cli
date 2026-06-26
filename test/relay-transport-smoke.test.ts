/**
 * PR #20 — Remote relay transport smoke for the core Vibe run contract.
 *
 * Verifies that the SAME run contract validated locally (PR #16/#18/#19) holds
 * over the relay transport — start / status / stream / stop — using a fake
 * in-process relay (`startRelayServer`) and a real `vibe node daemon` running
 * the MOCK agent only. No real claude/codex/opencode is ever invoked.
 *
 * Two things make this a deliberately-secure smoke, distinct from the broader
 * relay.test.ts:
 *   1. Isolation — every process (daemon + CLI) runs against a throwaway
 *      VIBE_DIR, so nothing touches the real ~/.vibe. relay.test.ts shares the
 *      real ~/.vibe; this file proves the contract with zero real writes.
 *   2. Token hygiene — the CLI receives the token via `--token-file` and the
 *      daemon via the VIBE_RELAY_TOKEN env, never `--token <value>`. The token
 *      string is asserted to never appear in any argv, stdout, stderr, or run
 *      record produced during the whole cycle.
 *
 * The node's local RunRecord remains the source of truth; the relay only
 * carries messages and must surface run_not_found / node_offline rather than
 * invent a terminal status.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { startRelayServer } from '../src/relay/server.js'
import { freshVibeDir } from './helpers/agent-fixtures.js'
import type { RunRecord, VibeNode } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

// Throwaway VIBE_DIR shared by every spawned process in this file. freshVibeDir
// registers its own after() cleanup. Nothing here writes to the real ~/.vibe.
const VIBE_DIR = freshVibeDir('vibe-relay-smoke-')
const TEST_TOKEN = `smoke-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`

// A 0600 token file is the secure way to hand the token to the CLI: the value
// stays out of argv (unlike --token) and off the network beyond the WS upgrade.
const TOKEN_FILE = path.join(VIBE_DIR, 'relay.token')
fs.writeFileSync(TOKEN_FILE, TEST_TOKEN + '\n', { mode: 0o600 })

const baseEnv: NodeJS.ProcessEnv = { ...process.env, VIBE_DIR }

// Everything any spawned process prints is funnelled here so the no-leak test
// can assert the token never surfaced in a log line anywhere.
const allOutput: string[] = []

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Async CLI invocation — never blocks the loop, so the in-process relay stays live. */
function vibe(
  args: string[],
  opts: { extraEnv?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(NODE, [CLI, ...args], {
      env: { ...baseEnv, ...opts.extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      allOutput.push(stdout, stderr)
      resolve({ status: code ?? 1, stdout, stderr })
    })
    if (opts.timeoutMs) {
      setTimeout(() => { proc.kill('SIGTERM'); resolve({ status: 124, stdout, stderr: stderr + '\n[timeout]' }) }, opts.timeoutMs)
    }
  })
}

interface LiveNode {
  server: Awaited<ReturnType<typeof startRelayServer>>
  relayUrl: string
  daemon: ChildProcess
}

/**
 * Spin a fake relay + a real `vibe node daemon` (mock-capable) and wait until
 * the daemon has registered. The daemon gets the token via VIBE_RELAY_TOKEN env
 * (never argv); mockMs tunes how long the mock run takes to reach a terminal
 * outcome. Always tear down via teardownNode().
 */
async function spinNode(nodeId: string, mockMs?: number): Promise<LiveNode> {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const relayUrl = `ws://127.0.0.1:${server.port}`
  const daemon = spawn(NODE, [
    CLI, 'node', 'daemon', '--local',
    '--relay', relayUrl,
    '--node-id', nodeId,
  ], {
    env: {
      ...baseEnv,
      VIBE_RELAY_TOKEN: TEST_TOKEN,          // token via env, not argv
      VIBE_NODE_HEARTBEAT_MS: '250',
      ...(mockMs !== undefined ? { VIBE_MOCK_RUN_MS: String(mockMs) } : {}),
    },
    stdio: 'pipe',
  })
  daemon.stdout?.on('data', (d: Buffer) => allOutput.push(d.toString()))
  daemon.stderr?.on('data', (d: Buffer) => allOutput.push(d.toString()))

  // Wait for registration by polling the relay node list over the secure path.
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await delay(300)
    const r = await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', TOKEN_FILE])
    if (r.status === 0) {
      try {
        const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
        if (nodes.some((n) => n.node_id === nodeId)) return { server, relayUrl, daemon }
      } catch { /* not ready */ }
    }
  }
  daemon.kill('SIGKILL')
  await server.close()
  throw new Error(`daemon ${nodeId} did not register within 8s`)
}

async function teardownNode(node: LiveNode): Promise<void> {
  if (!node.daemon.killed) node.daemon.kill('SIGTERM')
  await delay(300)
  await node.server.close()
}

/** Poll the node-authoritative local RunRecord (written by the daemon) until terminal. */
async function waitForStatus(runId: string, want: RunRecord['status'], timeoutMs = 14000): Promise<RunRecord | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await vibe(['run', 'status', runId, '--json'])
    if (r.status === 0) {
      try {
        const rec = JSON.parse(r.stdout.trim()) as RunRecord
        if (rec.status === want) return rec
      } catch { /* keep polling */ }
    }
    await delay(400)
  }
  return null
}

// A single live node serves the happy-path tests (1–6) to keep the smoke quick;
// error-path tests (7–8) spin their own short-lived nodes.
let shared: LiveNode

before(async () => { shared = await spinNode('smoke-node', 5000) })
after(async () => { if (shared) await teardownNode(shared) })

// ── 1. fake remote node can register + list ─────────────────────────────────

test('remote node registers and appears in `node list --remote` (via --token-file)', async () => {
  const r = await vibe(['node', 'list', '--remote', '--relay', shared.relayUrl, '--token-file', TOKEN_FILE])
  assert.equal(r.status, 0, 'node list --remote exits 0')
  const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
  const node = nodes.find((n) => n.node_id === 'smoke-node')
  assert.ok(node, 'smoke-node is registered on the relay')
  assert.equal(node!.transport, 'relay', 'advertised as a relay transport node')
  assert.ok(node!.agents.includes('mock'), 'advertises the mock agent')
})

// ── 2. remote mock start returns run_id + node_id ───────────────────────────

test('remote `run start --node <id> --agent mock` returns run_id and node_id', async () => {
  const r = await vibe([
    'run', 'start', '--node', 'smoke-node', '--agent', 'mock',
    '--workspace-key', 'smoke-start', '--relay', shared.relayUrl, '--token-file', TOKEN_FILE, '--json',
  ])
  assert.equal(r.status, 0, 'remote start exits 0')
  const rec = JSON.parse(r.stdout.trim()) as RunRecord
  assert.ok(rec.run_id, 'run_id present')
  assert.equal(rec.node_id, 'smoke-node', 'node_id is the target node')
  assert.ok(['queued', 'running'].includes(rec.status), 'fresh run is queued/running, not a faked terminal status')
})

// ── 3. remote status after completion = completed (from the node record) ─────

test('remote mock run reaches completed and `run status` reflects the node record', async () => {
  const start = await vibe([
    'run', 'start', '--node', 'smoke-node', '--agent', 'mock',
    '--workspace-key', 'smoke-complete', '--relay', shared.relayUrl, '--token-file', TOKEN_FILE, '--json',
  ])
  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  const completed = await waitForStatus(run_id, 'completed')
  assert.ok(completed, 'mock run reached completed within the deadline')
  assert.equal(completed!.status, 'completed')
  assert.equal(completed!.node_id, 'smoke-node', 'completed status is owned by the node, not invented by the relay')
})

// ── 4. remote stream emits mock events ──────────────────────────────────────

test('remote `run stream --relay` emits the mock event sequence as JSONL', async () => {
  const start = await vibe([
    'run', 'start', '--node', 'smoke-node', '--agent', 'mock',
    '--workspace-key', 'smoke-stream', '--relay', shared.relayUrl, '--token-file', TOKEN_FILE, '--json',
  ])
  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  // Stream resolves when the run completes; cap with a timeout as a safety net.
  // The relay fans out *live* events to subscribers (no replay of events that
  // fired before the subscribe), so we assert on the mock log stream plus the
  // terminal completed event rather than the pre-subscription running event.
  const r = await vibe(['run', 'stream', run_id, '--relay', shared.relayUrl, '--token-file', TOKEN_FILE], { timeoutMs: 14000 })
  const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.ok(events.length > 0, 'stream produced at least one event')
  assert.ok(events.some((e) => e.type === 'log'), 'saw mock log events')
  assert.ok(events.some((e) => e.type === 'status' && e.status === 'completed'), 'saw the completed status event')
})

// ── 5. remote stop cancels a long-running mock run ──────────────────────────

test('remote `run stop --relay` cancels a long-running mock run', async () => {
  // This run would otherwise take ~5s (the shared daemon's VIBE_MOCK_RUN_MS);
  // stopping promptly proves the relay carries the cancel to the node.
  const start = await vibe([
    'run', 'start', '--node', 'smoke-node', '--agent', 'mock',
    '--workspace-key', 'smoke-stop', '--relay', shared.relayUrl, '--token-file', TOKEN_FILE, '--json',
  ])
  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  const stop = await vibe(['run', 'stop', run_id, '--relay', shared.relayUrl, '--token-file', TOKEN_FILE])
  assert.equal(stop.status, 0, 'remote stop exits 0')
  const rec = JSON.parse(stop.stdout.trim()) as RunRecord
  assert.equal(rec.status, 'stopped', 'relay-driven stop returns a stopped RunRecord from the node')
})

// ── 6. node reconnect does not create stale status ──────────────────────────

test('node reconnect keeps one registry entry and preserves the completed record', async () => {
  const node = await spinNode('reconnect-node', 1500)
  try {
    // Run to completion, then drop and restart the daemon with the same id + VIBE_DIR.
    const start = await vibe([
      'run', 'start', '--node', 'reconnect-node', '--agent', 'mock',
      '--workspace-key', 'smoke-reconnect', '--relay', node.relayUrl, '--token-file', TOKEN_FILE, '--json',
    ])
    const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord
    const completed = await waitForStatus(run_id, 'completed')
    assert.ok(completed, 'run completed before reconnect')

    node.daemon.kill('SIGTERM')
    await delay(500)

    const daemon2 = spawn(NODE, [
      CLI, 'node', 'daemon', '--local', '--relay', node.relayUrl, '--node-id', 'reconnect-node',
    ], { env: { ...baseEnv, VIBE_RELAY_TOKEN: TEST_TOKEN, VIBE_NODE_HEARTBEAT_MS: '250' }, stdio: 'pipe' })
    daemon2.stdout?.on('data', (d: Buffer) => allOutput.push(d.toString()))
    daemon2.stderr?.on('data', (d: Buffer) => allOutput.push(d.toString()))
    node.daemon = daemon2

    // Wait for the single re-registration.
    let listed: VibeNode[] = []
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      await delay(300)
      const r = await vibe(['node', 'list', '--remote', '--relay', node.relayUrl, '--token-file', TOKEN_FILE])
      if (r.status === 0) {
        try { listed = JSON.parse(r.stdout.trim()) as VibeNode[] } catch { listed = [] }
        if (listed.some((n) => n.node_id === 'reconnect-node')) break
      }
    }
    const matches = listed.filter((n) => n.node_id === 'reconnect-node')
    assert.equal(matches.length, 1, 'reconnect yields exactly one registry entry (no stale duplicate)')

    // The node-authoritative record is still completed — not reset/invented.
    const after = await vibe(['run', 'status', run_id, '--json'])
    const rec = JSON.parse(after.stdout.trim()) as RunRecord
    assert.equal(rec.status, 'completed', 'completed record survives reconnect (no stale status)')
  } finally {
    await teardownNode(node)
  }
})

// ── 7. unknown run returns run_not_found ────────────────────────────────────

test('remote action on an unknown run surfaces run_not_found', async () => {
  const r = await vibe(['run', 'stop', 'run_does_not_exist_xyz', '--relay', shared.relayUrl, '--token-file', TOKEN_FILE])
  assert.notEqual(r.status, 0, 'unknown run exits non-zero')
  assert.match(r.stderr, /run_not_found/, 'relay reports run_not_found rather than a silent stale record')
})

// ── 8. offline node returns node_offline ────────────────────────────────────

test('remote action on a run whose owner went offline surfaces node_offline', async () => {
  const node = await spinNode('offline-node', 30000)
  let runId = ''
  try {
    const start = await vibe([
      'run', 'start', '--node', 'offline-node', '--agent', 'mock',
      '--workspace-key', 'smoke-offline', '--relay', node.relayUrl, '--token-file', TOKEN_FILE, '--json',
    ])
    runId = (JSON.parse(start.stdout.trim()) as RunRecord).run_id

    // Owner drops; relay still knows the ownership → status/stop must say node_offline.
    node.daemon.kill('SIGKILL')
    await delay(500)

    const r = await vibe(['run', 'stop', runId, '--relay', node.relayUrl, '--token-file', TOKEN_FILE])
    assert.notEqual(r.status, 0, 'offline-owner action exits non-zero')
    assert.match(r.stderr, /node_offline/, 'relay reports node_offline rather than inventing a terminal status')
  } finally {
    await teardownNode(node)
  }
})

// ── 9. no token in argv / logs / run records ────────────────────────────────

test('the relay token never appears in argv, logs, or run records', () => {
  // argv: the daemon was launched with VIBE_RELAY_TOKEN in env, never as an arg.
  assert.ok(!shared.daemon.spawnargs.join(' ').includes(TEST_TOKEN), 'token absent from daemon argv')

  // logs: nothing any process printed during the whole cycle contains the token.
  const combined = allOutput.join('\n')
  assert.ok(!combined.includes(TEST_TOKEN), 'token absent from all captured stdout/stderr')

  // run records: persisted RunRecords in the throwaway VIBE_DIR carry no token.
  const runsDir = path.join(VIBE_DIR, 'runs')
  if (fs.existsSync(runsDir)) {
    for (const f of fs.readdirSync(runsDir)) {
      const body = fs.readFileSync(path.join(runsDir, f), 'utf8')
      assert.ok(!body.includes(TEST_TOKEN), `token absent from run record ${f}`)
    }
  }
})

// ── 10. temp VIBE_DIR only; no real ~/.vibe writes ──────────────────────────

test('all transport state landed in the throwaway VIBE_DIR, not the real ~/.vibe', () => {
  assert.ok(VIBE_DIR.includes('vibe-relay-smoke-'), 'using a throwaway VIBE_DIR')
  const realVibe = path.join(os.homedir(), '.vibe')
  assert.ok(!VIBE_DIR.startsWith(realVibe), 'VIBE_DIR must not live under the real ~/.vibe')
  // The run records produced by this smoke live under the temp dir.
  const runsDir = path.join(VIBE_DIR, 'runs')
  assert.ok(fs.existsSync(runsDir), 'runs were written under the temp VIBE_DIR')
})
