/**
 * `vibe run` reads the `vibe connect` profile for client-side defaults:
 *   - relay / token-file defaults for `run start` / `run stream` / `run stop`
 *   - vibe_dir uniformly across the run namespace (record read/write consistency)
 * `run web` is intentionally NOT given relay/token defaults here.
 *
 * Fake relay + mock node only. Temp VIBE_DIR + temp VIBE_PROFILE. No production
 * relay, no real agents, no token value ever stored or printed.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { startRelayServer } from '../src/relay/server.js'
import { resolveClientDefaults, type NodeProfile } from '../src/lib/node-config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TEST_TOKEN = `runprofile-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-runprofile-')) }
function writeProfile(p: NodeProfile): string {
  const file = path.join(tmpDir(), 'profile.json')
  fs.writeFileSync(file, JSON.stringify(p))
  return file
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Async spawn — an in-process relay shares this event loop, so a blocking call
// would deadlock the dispatch handshake.
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

// ── unit: resolveClientDefaults precedence (CLI flag > env > profile > default) ─

const PROFILE: NodeProfile = {
  version: 1, relay_url: 'wss://profile-relay', token_file: '/profile/token', vibe_dir: '/profile/vibe',
}

test('resolveClientDefaults: profile fills relay/token-file/vibe-dir', () => {
  const d = resolveClientDefaults({}, PROFILE, {})
  assert.equal(d.relay, 'wss://profile-relay')
  assert.equal(d.tokenFile, '/profile/token')
  assert.equal(d.vibeDir, '/profile/vibe')
})

test('resolveClientDefaults: CLI flags override the profile', () => {
  const d = resolveClientDefaults({ relay: 'wss://flag', tokenFile: '/flag/token' }, PROFILE, {})
  assert.equal(d.relay, 'wss://flag')
  assert.equal(d.tokenFile, '/flag/token')
})

test('resolveClientDefaults: env overrides the profile (where env behavior exists)', () => {
  const d = resolveClientDefaults({}, PROFILE, { VIBE_DIR: '/env/vibe', VIBE_RELAY_TOKEN: 'env-secret' })
  assert.equal(d.tokenFile, undefined, 'env token beats profile token-file')
  assert.equal(d.vibeDir, undefined, 'env VIBE_DIR beats profile vibe_dir')
  assert.equal(d.relay, 'wss://profile-relay', 'no env for relay, profile applies')
})

test('resolveClientDefaults: no profile ⇒ all undefined (existing behavior)', () => {
  assert.deepEqual(resolveClientDefaults({}, null, {}), { relay: undefined, tokenFile: undefined, vibeDir: undefined })
})

test('resolveClientDefaults: never surfaces a token value — only a path', () => {
  const d = resolveClientDefaults({}, PROFILE, { VIBE_RELAY_TOKEN: 'super-secret' })
  assert.ok(!JSON.stringify(d).includes('super-secret'))
})

// ── vibe_dir consistency across the run namespace (local, no relay) ───────────

test('profile vibe_dir: run start writes and run status reads the SAME dir', async () => {
  const D = tmpDir()
  const profile = writeProfile({ version: 1, vibe_dir: D })
  const env = { ...process.env, VIBE_PROFILE: profile }
  delete (env as Record<string, string>).VIBE_DIR // so the profile vibe_dir applies

  const start = await vibe(['run', 'start', '--node', 'local', '--agent', 'mock', '--workspace-key', `c-${Date.now()}`, '--json'], env)
  assert.equal(start.status, 0, `start failed: ${start.stdout}${start.stderr}`)
  const run_id = JSON.parse(start.stdout.trim()).run_id as string
  assert.ok(fs.existsSync(path.join(D, 'runs', `${run_id}.json`)), 'record written into the profile vibe_dir')

  const status = await vibe(['run', 'status', run_id, '--json'], env)
  assert.equal(status.status, 0, 'run status found the record (same dir)')
  assert.equal(JSON.parse(status.stdout.trim()).run_id, run_id)

  await vibe(['run', 'stop', run_id], env) // cleanup the local run
})

// ── run web exclusion: it does NOT gain profile relay/token defaults ─────────

test('run web does NOT use the profile relay (still requires --relay)', async () => {
  const profile = writeProfile({ version: 1, relay_url: 'wss://should-not-be-used', token_file: '/x' })
  const env = { ...process.env, VIBE_PROFILE: profile, VIBE_DIR: tmpDir() }
  const r = await vibe(['run', 'web', 'run_x', '--node', 'node_y', '--json'], env)
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout.trim()).code, 'relay_required', 'run web ignored the profile relay (unchanged behavior)')
})

// ── missing profile preserves existing behavior ──────────────────────────────

test('no profile: run stream of an unknown run is the local not-found path', async () => {
  const env = { ...process.env, VIBE_PROFILE: path.join(tmpDir(), 'none.json'), VIBE_DIR: tmpDir() }
  const r = await vibe(['run', 'stream', 'run_unknown_xyz'], env)
  assert.equal(r.status, 3, 'no profile + no --relay ⇒ local readRun exits 3')
})

// ── integration: start/stream/stop dispatch remotely via the PROFILE ─────────

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

test('run start/stream/stop use the profile relay+token (no --relay on the CLI)', { timeout: 25000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up')
  if (!live) return
  // Profile supplies relay_url + token_file; client env sets VIBE_DIR (env > profile).
  const profile = writeProfile({ version: 1, relay_url: live.relayUrl, token_file: live.tokenFile })
  const env = { ...process.env, VIBE_PROFILE: profile, VIBE_DIR: live.vibeDir }

  const start = await vibe(['run', 'start', '--node', 'rp-node', '--agent', 'mock', '--workspace-key', `rp-${Date.now()}`, '--json'], env)
  assert.equal(start.status, 0, `start failed: ${start.stdout}${start.stderr}`)
  const run_id = JSON.parse(start.stdout.trim()).run_id as string
  assert.match(run_id, /^run_/, 'remote run started via profile relay (no --relay given)')

  const stream = await vibe(['run', 'stream', run_id, '--jsonl'], env, 20000)
  assert.ok(/"type":"(log|status)"/.test(stream.stdout), 'run stream delivered remote events via the profile relay')

  // `run stop` on a fresh, still-running remote run (mock lasts ~4s) — succeeds over
  // the profile relay. (A local stop could not reach the node; success proves remote.)
  const startB = await vibe(['run', 'start', '--node', 'rp-node', '--agent', 'mock', '--workspace-key', `rp-stop-${Date.now()}`, '--json'], env)
  const run_id_b = JSON.parse(startB.stdout.trim()).run_id as string
  const stop = await vibe(['run', 'stop', run_id_b, '--json'], env)
  assert.equal(stop.status, 0, `run stop via profile relay failed: ${stop.stdout}${stop.stderr}`)

  // No token value anywhere in the client output, and the profile holds only the path.
  const all = start.stdout + start.stderr + stream.stdout + stream.stderr + startB.stdout + stop.stdout + stop.stderr
  assert.ok(!all.includes(TEST_TOKEN), 'relay token value never appears in run output')
  assert.ok(!fs.readFileSync(profile, 'utf8').includes(TEST_TOKEN), 'profile holds the token-file path, never the value')
})
