/**
 * `vibe run doctor` — read-only readiness preflight for the remote run path
 * (PR #39). Pure unit tests for evaluateNodeReadiness + integration tests over
 * the existing in-process relay + mock-node harness. No production relay, no
 * real agents, no token value ever printed or stored.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { startRelayServer } from '../src/relay/server.js'
import { evaluateNodeReadiness } from '../src/lib/run-doctor.js'
import type { VibeNode } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TEST_TOKEN = `rundoctor-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-rundoctor-')) }
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

function mockNode(over: Partial<VibeNode> = {}): VibeNode {
  return {
    node_id: 'rp-node', name: 'rp-node', status: 'online', transport: 'relay',
    capabilities: [], agents: ['mock'], active_runs: 0, max_runs: 4,
    workspace_roots: [], created_at: 't', updated_at: 't', ...over,
  }
}

// ── unit: evaluateNodeReadiness ──────────────────────────────────────────────

test('evaluateNodeReadiness: ready with agent ⇒ ok, relay/auth/node/agent all ok', () => {
  const r = evaluateNodeReadiness([mockNode()], 'rp-node', 'mock', 'TS')
  assert.equal(r.ok, true)
  assert.equal(r.code, undefined)
  assert.equal(r.ts, 'TS')
  assert.deepEqual(r.checks.map((c) => [c.name, c.ok]), [['relay', true], ['auth', true], ['node', true], ['agent', true]])
})

test('evaluateNodeReadiness: ready without agent omits the agent check', () => {
  const r = evaluateNodeReadiness([mockNode()], 'rp-node', undefined, 'TS')
  assert.equal(r.ok, true)
  assert.deepEqual(r.checks.map((c) => c.name), ['relay', 'auth', 'node'])
  assert.equal(r.checks.some((c) => c.name === 'agent'), false)
})

test('evaluateNodeReadiness: missing node ⇒ node_offline, exit-worthy', () => {
  const r = evaluateNodeReadiness([mockNode()], 'ghost', 'mock', 'TS')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'node_offline')
  assert.equal(r.checks.find((c) => c.name === 'node')!.ok, false)
})

test('evaluateNodeReadiness: offline node ⇒ node_offline', () => {
  const r = evaluateNodeReadiness([mockNode({ status: 'offline' })], 'rp-node', 'mock', 'TS')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'node_offline')
})

test('evaluateNodeReadiness: online node missing requested agent ⇒ agent_not_supported', () => {
  const r = evaluateNodeReadiness([mockNode({ agents: ['mock'] })], 'rp-node', 'claude-code', 'TS')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'agent_not_supported')
  assert.equal(r.checks.find((c) => c.name === 'node')!.ok, true, 'node check still passes')
  assert.equal(r.checks.find((c) => c.name === 'agent')!.ok, false)
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
    env: { ...process.env, VIBE_DIR: vibeDir, VIBE_RELAY_TOKEN: TEST_TOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock' },
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

test('ready: node online + advertises mock ⇒ ok:true, exit 0, no token leak', { timeout: 20000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
  const env = { ...process.env, VIBE_DIR: tmpDir() }
  const r = await vibe(['run', 'doctor', '--node', 'rp-node', '--agent', 'mock', '--relay', live.relayUrl, '--token-file', live.tokenFile, '--json'], env)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.ok, true, `expected ready: ${r.stdout}${r.stderr}`)
  assert.equal(out.code, undefined)
  assert.deepEqual(out.checks.map((c: { name: string }) => c.name), ['relay', 'auth', 'node', 'agent'])
  assert.equal(r.status, 0)
  assert.ok(!(r.stdout + r.stderr).includes(TEST_TOKEN), 'token value absent from output')
})

test('profile defaults: relay/token-file from profile (no --relay) ⇒ ok:true, exit 0, token absent', { timeout: 20000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
  const profile = writeProfile({ version: 1, relay_url: live.relayUrl, token_file: live.tokenFile })
  const env = { ...process.env, VIBE_PROFILE: profile, VIBE_DIR: tmpDir() }
  const r = await vibe(['run', 'doctor', '--node', 'rp-node', '--agent', 'mock', '--json'], env)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.ok, true, `expected ready via profile: ${r.stdout}${r.stderr}`)
  assert.equal(r.status, 0)
  assert.ok(!(r.stdout + r.stderr).includes(TEST_TOKEN), 'token value absent from output')
  assert.ok(!fs.readFileSync(profile, 'utf8').includes(TEST_TOKEN), 'profile holds the token-file path, never the value')
})

test('unknown/offline node ⇒ ok:false, node_offline, exit 1', { timeout: 20000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
  const env = { ...process.env, VIBE_DIR: tmpDir() }
  const r = await vibe(['run', 'doctor', '--node', 'ghost-node', '--agent', 'mock', '--relay', live.relayUrl, '--token-file', live.tokenFile, '--json'], env)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.ok, false)
  assert.equal(out.code, 'node_offline')
  assert.equal(r.status, 1)
})

test('agent not advertised ⇒ ok:false, agent_not_supported, exit 1', { timeout: 20000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
  const env = { ...process.env, VIBE_DIR: tmpDir() }
  const r = await vibe(['run', 'doctor', '--node', 'rp-node', '--agent', 'claude-code', '--relay', live.relayUrl, '--token-file', live.tokenFile, '--json'], env)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.ok, false)
  assert.equal(out.code, 'agent_not_supported')
  assert.equal(r.status, 1)
})

test('relay unreachable ⇒ ok:false, relay_unavailable, exit 1', { timeout: 20000 }, async () => {
  const dir = tmpDir()
  const tokenFile = path.join(dir, 'tok'); fs.writeFileSync(tokenFile, 'whatever\n', { mode: 0o600 })
  const r = await vibe(['run', 'doctor', '--node', 'rp-node', '--agent', 'mock', '--relay', 'ws://127.0.0.1:1', '--token-file', tokenFile, '--json'], { ...process.env, VIBE_DIR: dir })
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.ok, false)
  assert.equal(out.code, 'relay_unavailable')
  assert.equal(out.checks.find((c: { name: string }) => c.name === 'relay').ok, false)
  assert.equal(r.status, 1)
})

test('wrong token ⇒ ok:false, unauthorized, exit 1, no token leak', { timeout: 20000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up'); if (!live) return
  const dir = tmpDir()
  const badToken = `wrong-${Date.now()}`
  const tokenFile = path.join(dir, 'tok'); fs.writeFileSync(tokenFile, badToken + '\n', { mode: 0o600 })
  const r = await vibe(['run', 'doctor', '--node', 'rp-node', '--agent', 'mock', '--relay', live.relayUrl, '--token-file', tokenFile, '--json'], { ...process.env, VIBE_DIR: dir })
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.ok, false)
  assert.equal(out.code, 'unauthorized')
  assert.equal(r.status, 1)
  assert.ok(!(r.stdout + r.stderr).includes(badToken), 'token value absent from output')
})
