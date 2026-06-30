/**
 * `vibe symphony` remote contract parity with `vibe run` (PR #40):
 *   - profile defaults (relay/token-file/vibe-dir) for start/status/stream/stop
 *   - structured #36 error envelope on remote failure (run_not_found → exit 3)
 *   - stream missing-run preflight (matches `vibe run stream`)
 *
 * Fake relay + mock node only, async spawn (an in-process relay shares the event
 * loop, so a blocking call would deadlock the handshake). Temp VIBE_DIR + temp
 * VIBE_PROFILE. No production relay, no real agents, no token value stored/printed.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { startRelayServer } from '../src/relay/server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TEST_TOKEN = `symremote-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-symremote-')) }
function writeProfile(p: object): string {
  const file = path.join(tmpDir(), 'profile.json')
  fs.writeFileSync(file, JSON.stringify(p))
  return file
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

test('symphony start/status/stream/stop use the profile relay+token (no --relay on the CLI)', { timeout: 25000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
  const profile = writeProfile({ version: 1, relay_url: live.relayUrl, token_file: live.tokenFile })
  const env = { ...process.env, VIBE_PROFILE: profile, VIBE_DIR: live.vibeDir }

  // 1. start via profile relay (no --relay)
  const start = await vibe(['symphony', 'start', '--node', 'rp-node', '--agent', 'mock', '--issue-id', `JOZ-${Date.now()}`, '--json'], env)
  assert.equal(start.status, 0, `symphony start failed: ${start.stdout}${start.stderr}`)
  const rec = JSON.parse(start.stdout.trim())
  assert.match(rec.run_id, /^run_/, 'remote run started via profile relay')
  assert.equal(rec.metadata?.source, 'symphony', 'symphony metadata preserved on remote start')

  // 2. status via profile relay → node-authoritative record
  const status = await vibe(['symphony', 'status', rec.run_id, '--json'], env)
  assert.equal(status.status, 0, `symphony status failed: ${status.stdout}${status.stderr}`)
  assert.equal(JSON.parse(status.stdout.trim()).run_id, rec.run_id)

  // 3. stream via profile relay → RunEvent JSONL, exit 0
  const stream = await vibe(['symphony', 'stream', rec.run_id, '--jsonl'], env, 20000)
  assert.equal(stream.status, 0, 'symphony stream exits 0 on a live run')
  assert.ok(/"type":"(log|status)"/.test(stream.stdout), 'symphony stream delivered RunEvent JSONL via profile relay')

  // 4. stop a fresh still-running run via profile relay
  const startB = await vibe(['symphony', 'start', '--node', 'rp-node', '--agent', 'mock', '--issue-id', `JOZ-stop-${Date.now()}`, '--json'], env)
  const runB = JSON.parse(startB.stdout.trim()).run_id as string
  const stop = await vibe(['symphony', 'stop', runB, '--json'], env)
  assert.equal(stop.status, 0, `symphony stop failed: ${stop.stdout}${stop.stderr}`)
  assert.equal(JSON.parse(stop.stdout.trim()).run_id, runB)

  // token secrecy: value never in output, profile holds only the path
  const all = start.stdout + start.stderr + status.stdout + stream.stdout + stream.stderr + startB.stdout + stop.stdout + stop.stderr
  assert.ok(!all.includes(TEST_TOKEN), 'relay token value never appears in symphony output')
  assert.ok(!fs.readFileSync(profile, 'utf8').includes(TEST_TOKEN), 'profile holds the token-file path, never the value')
})

for (const sub of ['status', 'stream', 'stop'] as const) {
  test(`symphony ${sub} of an unknown remote run ⇒ run_not_found envelope, exit 3, no token leak`, { timeout: 20000 }, async () => {
    assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
    const env = { ...process.env, VIBE_DIR: tmpDir() }
    const args = ['symphony', sub, 'run_does_not_exist', '--relay', live.relayUrl, '--token-file', live.tokenFile]
    if (sub !== 'stream') args.push('--json')
    const r = await vibe(args, env)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.error, true)
    assert.equal(out.code, 'run_not_found', `symphony ${sub} should classify unknown run as run_not_found`)
    assert.equal(out.run_id, 'run_does_not_exist')
    assert.equal(r.status, 3, `symphony ${sub} remote run_not_found exits 3`)
    assert.ok(!(r.stdout + r.stderr).includes(TEST_TOKEN), 'token value absent from output')
  })
}

test('symphony start to an unknown node ⇒ node_offline envelope, exit 1, no token leak', { timeout: 20000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
  const env = { ...process.env, VIBE_DIR: tmpDir() }
  const r = await vibe(['symphony', 'start', '--node', 'ghost-node', '--agent', 'mock', '--relay', live.relayUrl, '--token-file', live.tokenFile, '--json'], env)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'node_offline')
  assert.equal(r.status, 1)
  assert.ok(!(r.stdout + r.stderr).includes(TEST_TOKEN), 'token value absent from output')
})
