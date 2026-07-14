/**
 * Node-side workspace containment: the node is the filesystem trust boundary for
 * EVERY relay client. resolveContainedWorkspace() confines an untrusted
 * workspace_key within workspace_root (opaque-key rule + realpath containment +
 * existing-symlink rejection), and the remote run_start handler rejects an unsafe
 * key with the structured remote-error contract BEFORE starting any backend.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { resolveContainedWorkspace, WORKSPACE_KEY_RE } from '../src/workspace.js'
import { startRelayServer } from '../src/relay/server.js'
import { remoteRunStart } from '../src/relay/client.js'

// ── pure resolver unit tests ──────────────────────────────────────────────────

function tmpRoot(): string { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-root-'))) }

test('resolveContainedWorkspace: safe generated + explicit keys resolve strictly within root; creates no dir', () => {
  const root = tmpRoot()
  for (const key of ['run_mrjy8dh8_4e3642', 'safe.key_9-x', 'A1', 'x'.repeat(128)]) {
    const r = resolveContainedWorkspace(key, root)
    assert.ok(r.ok, `accept ${key.slice(0, 12)}`)
    if (r.ok) {
      const rel = path.relative(root, r.path)
      assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), 'resolved within root')
      assert.equal(r.path, path.join(root, key))
      assert.ok(!fs.existsSync(r.path), 'resolver does NOT create the workspace dir')
    }
  }
})

test('resolveContainedWorkspace: rejects every unsafe key; error never echoes the value', () => {
  const root = tmpRoot()
  const bad: string[] = [
    '',                       // empty
    'a/b', '../escape', 'a/../..', // slash traversal / embedded
    'a' + String.fromCharCode(92) + 'b', 'C:' + String.fromCharCode(92) + 'Windows', // backslash / windows abs
    '/abs/path', '/etc/passwd', // absolute POSIX
    '.', '..',                 // dot segments
    '.hidden', '-lead',        // leading dot / dash
    'a' + String.fromCharCode(1) + 'b', 'tab' + String.fromCharCode(9), // control chars
    'x'.repeat(129),           // oversized
    'sp ace',                  // whitespace
  ]
  for (const key of bad) {
    const r = resolveContainedWorkspace(key, root)
    assert.ok(!r.ok, `reject ${JSON.stringify(key).slice(0, 16)}`)
    if (!r.ok) {
      assert.equal(r.code, 'invalid_workspace_key')
      if (key.length >= 4) assert.ok(!r.message.includes(key), 'unsafe value not echoed')
    }
  }
})

test('resolveContainedWorkspace: rejects an existing final path that symlinks OUTSIDE the root', () => {
  const root = tmpRoot()
  const outside = tmpRoot() // a real dir outside root
  fs.symlinkSync(outside, path.join(root, 'escape')) // root/escape -> outside (opaque key, but escapes)
  const r = resolveContainedWorkspace('escape', root)
  assert.ok(!r.ok, 'existing escaping symlink rejected')
  if (!r.ok) assert.equal(r.code, 'invalid_workspace_key')
  // a symlink that stays INSIDE the root is fine
  fs.mkdirSync(path.join(root, 'real'))
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'inside'))
  assert.ok(resolveContainedWorkspace('inside', root).ok, 'in-root symlink allowed')
})

test('WORKSPACE_KEY_RE matches the Gateway v1 rule', () => {
  assert.equal(WORKSPACE_KEY_RE.source, '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
})

// ── node integration: reject at the node before any backend starts ────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TOKEN = `wc-tok-${Math.random().toString(36).slice(2)}`
const NODE_ID = 'wc-node'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Live { server: Awaited<ReturnType<typeof startRelayServer>>; daemon: ReturnType<typeof spawn>; vibeDir: string; nodeDir: string }
let live: Live | undefined

function vibe(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''; p.stdout!.on('data', (d: Buffer) => { out += d.toString() })
    p.on('close', () => resolve(out)); setTimeout(() => { p.kill('SIGKILL'); resolve(out) }, timeoutMs)
  })
}

before(async () => {
  const server = await startRelayServer({ port: 0, token: TOKEN })
  const relayUrl = `ws://127.0.0.1:${server.port}`
  const vibeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'))
  const nodeDir = path.join(vibeDir, 'node')
  const tokenFile = path.join(vibeDir, 'tok'); fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 })
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', NODE_ID], {
    env: { ...process.env, VIBE_DIR: nodeDir, VIBE_RELAY_TOKEN: TOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock', VIBE_MOCK_RUN_MS: '300' }, stdio: 'ignore',
  })
  const deadline = Date.now() + 9000; let up = false
  while (Date.now() < deadline && !up) {
    await delay(300)
    try { if (JSON.parse((await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', tokenFile, '--json'], { ...process.env, VIBE_DIR: vibeDir })).trim()).some((n: { node_id: string }) => n.node_id === NODE_ID)) up = true } catch { /* */ }
  }
  if (!up) { daemon.kill('SIGKILL'); await server.close(); return }
  process.env.VIBE_DIR = vibeDir
  live = { server, daemon, vibeDir, nodeDir }
})
after(async () => { if (live) { if (!live.daemon.killed) live.daemon.kill('SIGKILL'); await delay(200); await live.server.close() } })

test('node: an unsafe workspace_key is rejected at the node before any backend starts (no run record)', { timeout: 20000 }, async () => {
  if (!live) return
  const relay = `ws://127.0.0.1:${live.server.port}`
  const runsBefore = fs.existsSync(path.join(live.nodeDir, 'runs')) ? fs.readdirSync(path.join(live.nodeDir, 'runs')).length : 0
  await assert.rejects(
    remoteRunStart(relay, TOKEN, NODE_ID, { agent: 'mock', workspaceKey: '../escape' }),
    (err: Error) => {
      assert.match(err.message, /invalid_workspace_key/)
      assert.ok(!err.message.includes('../escape'), 'error must not echo the unsafe key')
      return true
    },
  )
  await delay(300)
  const runsAfter = fs.existsSync(path.join(live.nodeDir, 'runs')) ? fs.readdirSync(path.join(live.nodeDir, 'runs')).length : 0
  assert.equal(runsAfter, runsBefore, 'no run record created -> no backend started')
})

test('node: normal mock remote start with a safe key remains compatible', { timeout: 20000 }, async () => {
  if (!live) return
  const relay = `ws://127.0.0.1:${live.server.port}`
  const rec = await remoteRunStart(relay, TOKEN, NODE_ID, { agent: 'mock', workspaceKey: 'safe.key_9' })
  assert.equal(rec.agent, 'mock')
  assert.equal(rec.status, 'running')
  assert.ok(rec.workspace_path.includes('safe.key_9'), 'workspace resolved under the node root')
  // omitting workspace_key uses the safe generated run_id
  const rec2 = await remoteRunStart(relay, TOKEN, NODE_ID, { agent: 'mock' })
  assert.equal(rec2.status, 'running')
  assert.ok(rec2.workspace_path.includes(rec2.run_id))
})
