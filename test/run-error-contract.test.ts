/**
 * Structured remote error contract for `vibe run start/stream/stop` (PR #36).
 *
 * A remote run failure must be machine-readable for an orchestrator (Symphony):
 * a stable JSON `{ error:true, code }` envelope on stdout + a small exit-code map
 * (3 = run_not_found, 1 = everything else), never a token value.
 *
 * Pure classifier/envelope unit tests + integration tests over a fake relay and
 * a mock node only. Temp VIBE_DIR. No production relay, no real agents.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { startRelayServer } from '../src/relay/server.js'
import { classifyRunError, buildRunErrorEnvelope, runErrorExitCode } from '../src/lib/run-error.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TEST_TOKEN = `runerr-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-runerr-')) }
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Async spawn — an in-process relay shares this event loop; a blocking call would
// deadlock the dispatch handshake.
function vibe(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15000): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
    setTimeout(() => { proc.kill('SIGTERM'); resolve({ status: 124, stdout, stderr: stderr + '\n[timeout]' }) }, timeoutMs)
  })
}

// ── unit: classifier ─────────────────────────────────────────────────────────

test('classifyRunError: recognised relay/node ack codes map to stable codes', () => {
  assert.equal(classifyRunError(new Error('run_not_found: Run not found in relay: run_x')), 'run_not_found')
  assert.equal(classifyRunError(new Error('already_terminal: run is already completed')), 'already_terminal')
  assert.equal(classifyRunError(new Error('node_offline: Owning node is offline: rp-node')), 'node_offline')
  assert.equal(classifyRunError(new Error('node_not_found: Node not found: ghost')), 'node_offline')
  assert.equal(classifyRunError(new Error('agent_not_supported: node does not offer claude-code')), 'agent_not_supported')
})

test('classifyRunError: auth signals map to unauthorized', () => {
  assert.equal(classifyRunError(new Error('Unexpected server response: 401')), 'unauthorized')
  assert.equal(classifyRunError(new Error('relay returned 401 unauthorized (check token)')), 'unauthorized')
  assert.equal(classifyRunError(new Error('Unexpected server response: 403')), 'unauthorized')
})

test('classifyRunError: transport-reachability signals map to relay_unavailable', () => {
  assert.equal(classifyRunError(new Error('connect ECONNREFUSED 127.0.0.1:7100')), 'relay_unavailable')
  assert.equal(classifyRunError(new Error('getaddrinfo ENOTFOUND badhost')), 'relay_unavailable')
  assert.equal(classifyRunError(new Error('Timeout waiting for run_start_ack from relay')), 'relay_unavailable')
  assert.equal(classifyRunError(new Error('Relay connection closed before run_start_ack')), 'relay_unavailable')
})

test('classifyRunError: other coded message ⇒ remote_error, uncoded ⇒ unknown_error', () => {
  assert.equal(classifyRunError(new Error('internal_error: something blew up on the node')), 'remote_error')
  assert.equal(classifyRunError(new Error('a human sentence with no code')), 'unknown_error')
  assert.equal(classifyRunError('not even an Error'), 'unknown_error')
  assert.equal(classifyRunError(undefined), 'unknown_error')
})

// ── unit: envelope + exit code ───────────────────────────────────────────────

test('buildRunErrorEnvelope: stable shape, run_id optional, message preserved', () => {
  const e = buildRunErrorEnvelope(new Error('node_offline: down'), { run_id: 'run_1', ts: '2026-01-01T00:00:00.000Z' })
  assert.deepEqual(e, { error: true, code: 'node_offline', message: 'node_offline: down', run_id: 'run_1', ts: '2026-01-01T00:00:00.000Z' })

  const noRun = buildRunErrorEnvelope(new Error('Unexpected server response: 401'))
  assert.equal(noRun.error, true)
  assert.equal(noRun.code, 'unauthorized')
  assert.equal('run_id' in noRun, false, 'run_id omitted when not supplied')
  assert.ok(typeof noRun.ts === 'string' && noRun.ts.length > 0, 'ts defaulted')
})

test('runErrorExitCode: 3 for run_not_found, 1 otherwise', () => {
  assert.equal(runErrorExitCode('run_not_found'), 3)
  for (const c of ['relay_unavailable', 'node_offline', 'unauthorized', 'agent_not_supported', 'already_terminal', 'remote_error', 'unknown_error'] as const) {
    assert.equal(runErrorExitCode(c), 1, `${c} ⇒ exit 1`)
  }
})

// ── integration: relay + mock node ───────────────────────────────────────────

interface Live { server: Awaited<ReturnType<typeof startRelayServer>>; relayUrl: string; daemon: ReturnType<typeof spawn>; tokenFile: string; vibeDir: string }
let live: Live | undefined

before(async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const relayUrl = `ws://127.0.0.1:${server.port}`
  const vibeDir = tmpDir()
  const tokenFile = path.join(vibeDir, 'tok'); fs.writeFileSync(tokenFile, TEST_TOKEN + '\n', { mode: 0o600 })
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', 'rp-node'], {
    env: { ...process.env, VIBE_DIR: vibeDir, VIBE_RELAY_TOKEN: TEST_TOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock', VIBE_MOCK_RUN_MS: '4000' },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await delay(300)
    const r = await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', tokenFile, '--json'], { ...process.env, VIBE_DIR: vibeDir })
    try { if (JSON.parse(r.stdout.trim()).some((n: { node_id: string }) => n.node_id === 'rp-node')) { live = { server, relayUrl, daemon, tokenFile, vibeDir }; return } } catch { /* not ready */ }
  }
  daemon.kill('SIGKILL'); await server.close()
})

after(async () => {
  if (live) { if (!live.daemon.killed) live.daemon.kill('SIGTERM'); await delay(300); await live.server.close() }
})

test('remote start failure (unknown node) ⇒ JSON envelope, exit 1, no token leak', { timeout: 20000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
  const env = { ...process.env, VIBE_DIR: tmpDir() }
  const r = await vibe(['run', 'start', '--node', 'ghost-node', '--agent', 'mock', '--relay', live.relayUrl, '--token-file', live.tokenFile, '--json'], env)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'node_offline', 'unknown node classified as node_offline')
  assert.equal(r.status, 1, 'non-run_not_found remote failure exits 1')
  assert.ok(!(r.stdout + r.stderr).includes(TEST_TOKEN), 'token value absent from output')
})

test('remote start failure (relay unreachable) ⇒ relay_unavailable, exit 1', { timeout: 20000 }, async () => {
  const dir = tmpDir()
  const tokenFile = path.join(dir, 'tok'); fs.writeFileSync(tokenFile, 'whatever\n', { mode: 0o600 })
  const r = await vibe(['run', 'start', '--node', 'rp-node', '--agent', 'mock', '--relay', 'ws://127.0.0.1:1', '--token-file', tokenFile, '--json'], { ...process.env, VIBE_DIR: dir })
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'relay_unavailable')
  assert.equal(r.status, 1)
})

test('remote stream of an unknown run ⇒ run_not_found envelope, exit 3, no token leak', { timeout: 20000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
  const env = { ...process.env, VIBE_DIR: tmpDir() }
  const r = await vibe(['run', 'stream', 'run_does_not_exist', '--relay', live.relayUrl, '--token-file', live.tokenFile], env)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'run_not_found')
  assert.equal(out.run_id, 'run_does_not_exist', 'envelope carries the run_id')
  assert.equal(r.status, 3, 'remote run_not_found exits 3 (matches local missing-run)')
  assert.ok(!(r.stdout + r.stderr).includes(TEST_TOKEN), 'token value absent from output')
})

test('remote stop of an unknown run ⇒ run_not_found envelope, exit 3', { timeout: 20000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
  const env = { ...process.env, VIBE_DIR: tmpDir() }
  const r = await vibe(['run', 'stop', 'run_does_not_exist', '--relay', live.relayUrl, '--token-file', live.tokenFile, '--json'], env)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'run_not_found')
  assert.equal(r.status, 3)
})

test('success paths unchanged: start ⇒ RunRecord+exit0, stream ⇒ JSONL, stop ⇒ RunRecord+exit0', { timeout: 25000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
  const env = { ...process.env, VIBE_DIR: live.vibeDir }
  const flags = ['--relay', live.relayUrl, '--token-file', live.tokenFile]

  const start = await vibe(['run', 'start', '--node', 'rp-node', '--agent', 'mock', '--workspace-key', `re-${Date.now()}`, ...flags, '--json'], env)
  assert.equal(start.status, 0, `start should still succeed: ${start.stdout}${start.stderr}`)
  const rec = JSON.parse(start.stdout.trim())
  assert.match(rec.run_id, /^run_/, 'start still prints a RunRecord with run_id')
  assert.equal(rec.error, undefined, 'success record carries no error field')

  const stream = await vibe(['run', 'stream', rec.run_id, ...flags, '--jsonl'], env, 20000)
  assert.equal(stream.status, 0, 'stream of a live run still exits 0')
  assert.ok(/"type":"(log|status)"/.test(stream.stdout), 'stream still emits RunEvent JSONL')

  const startB = await vibe(['run', 'start', '--node', 'rp-node', '--agent', 'mock', '--workspace-key', `re-stop-${Date.now()}`, ...flags, '--json'], env)
  const runB = JSON.parse(startB.stdout.trim()).run_id as string
  const stop = await vibe(['run', 'stop', runB, ...flags, '--json'], env)
  assert.equal(stop.status, 0, `stop should still succeed: ${stop.stdout}${stop.stderr}`)
  assert.equal(JSON.parse(stop.stdout.trim()).run_id, runB, 'stop still prints the updated RunRecord')

  const all = start.stdout + stream.stdout + stream.stderr + stop.stdout
  assert.ok(!all.includes(TEST_TOKEN), 'token value never appears in success output')
})
