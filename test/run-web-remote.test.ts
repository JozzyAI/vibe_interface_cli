/**
 * Personal remote web viewer (`vibe run web --node <id> <run_id>`).
 *
 * Two layers, all mock-only and isolated to a throwaway VIBE_DIR — never the real
 * ~/.vibe, no production relay, no real claude/codex/opencode:
 *   1. Pure units for the buffer, the read-only HTTP server, and the structured
 *      error mapping — no relay needed.
 *   2. One integration over a FAKE in-process relay + a real `vibe node daemon`
 *      (mock agent), driving the existing remoteStream through its new onRunEvent
 *      hook into a RemoteRunBuffer.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { freshVibeDir } from './helpers/agent-fixtures.js'
import { startRelayServer } from '../src/relay/server.js'
import { remoteStream, remoteRunStatus } from '../src/relay/client.js'
import { validateBind, generateAccessToken } from '../src/lib/run-web.js'
import { RemoteRunBuffer, mapRemoteStatusError, startRemoteViewerServer } from '../src/lib/run-web-remote.js'
import type { RunEvent, RunStatus, VibeNode } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

const VIBE_DIR = freshVibeDir('vibe-web-remote-')
const TEST_TOKEN = `web-remote-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`
const TOKEN_FILE = path.join(VIBE_DIR, 'relay.token')
fs.writeFileSync(TOKEN_FILE, TEST_TOKEN + '\n', { mode: 0o600 })
const baseEnv: NodeJS.ProcessEnv = { ...process.env, VIBE_DIR }

const logEv = (message: string): RunEvent =>
  ({ type: 'log', stream: 'stdout', message, run_id: 'run_x', ts: new Date().toISOString() }) as RunEvent
const statusEv = (status: RunStatus): RunEvent =>
  ({ type: 'status', status, run_id: 'run_x', ts: new Date().toISOString() }) as RunEvent

// ── 1a. buffer: content / status / ended / redaction ────────────────────────

test('RemoteRunBuffer renders events, tracks status, redacts, and flips ended on terminal', () => {
  const buf = new RemoteRunBuffer('run_x', 'node_abc', 'running')
  buf.push(logEv('hello from mock'))
  buf.push(logEv('token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))

  let snap = buf.snapshot()
  assert.equal(snap.run_id, 'run_x')
  assert.equal(snap.node_id, 'node_abc')
  assert.equal(snap.source, 'events')
  assert.equal(snap.status, 'running')
  assert.equal(snap.ended, false)
  assert.match(snap.content, /hello from mock/)
  assert.doesNotMatch(snap.content, /ghp_AAA/, 'secret must be redacted')
  assert.match(snap.content, /\[REDACTED\]/)

  buf.push(statusEv('completed'))
  snap = buf.snapshot()
  assert.equal(snap.status, 'completed')
  assert.equal(snap.ended, true, 'terminal status flips ended')
})

test('RemoteRunBuffer seeds ended=true when the run was already finished', () => {
  const buf = new RemoteRunBuffer('run_x', 'node_abc', 'completed')
  const snap = buf.snapshot()
  assert.equal(snap.ended, true)
  assert.equal(snap.stream, 'ended')
})

test('RemoteRunBuffer tracks connection state via setStreamState', () => {
  const buf = new RemoteRunBuffer('run_x', 'node_abc', 'running')
  assert.equal(buf.snapshot().stream, 'connecting')
  buf.setStreamState('subscribed')
  assert.equal(buf.snapshot().stream, 'live')
  buf.setStreamState('reconnect_scheduled')
  assert.equal(buf.snapshot().stream, 'reconnecting')
  buf.setStreamState('gave_up')
  assert.equal(buf.snapshot().stream, 'disconnected')
})

test('RemoteRunBuffer: a stream-disconnect give-up reads as disconnected + ended', () => {
  // Mirrors what remoteStream now delivers through onRunEvent on give-up.
  const buf = new RemoteRunBuffer('run_x', 'node_abc', 'running')
  buf.setStreamState('subscribed')
  buf.push(logEv('working…'))
  buf.push({ type: 'error', code: 'stream_disconnected', message: 'relay event stream closed — the run may still be active on the node', run_id: 'run_x', ts: new Date().toISOString() } as RunEvent)
  buf.push(statusEv('failed'))
  const snap = buf.snapshot()
  assert.equal(snap.ended, true, 'give-up flips ended')
  assert.equal(snap.stream, 'disconnected', 'distinct from a clean finish')
  assert.match(snap.content, /the run may still be active on the node/)
})

test('RemoteRunBuffer.markEnded(reason) finalizes with the right stream state', () => {
  const a = new RemoteRunBuffer('run_x', 'node_abc', 'running'); a.markEnded()
  assert.deepEqual([a.snapshot().ended, a.snapshot().stream], [true, 'ended'])
  const b = new RemoteRunBuffer('run_y', 'node_abc', 'running'); b.markEnded('disconnected')
  assert.deepEqual([b.snapshot().ended, b.snapshot().stream], [true, 'disconnected'])
})

// ── 1b. server: private bind, read-only, GET 200 / non-GET 405 / 404 ────────

test('startRemoteViewerServer: 127.0.0.1, GET 200 (shows output), POST 405, unknown 404', async () => {
  const buf = new RemoteRunBuffer('run_x', 'node_abc', 'running')
  buf.push(logEv('remote-mock-line-42'))
  const server = await startRemoteViewerServer({ run_id: 'run_x', node_id: 'node_abc', host: '127.0.0.1', port: 0, buffer: buf })
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'bound to loopback by default')

    const page = await fetch(`${server.url}/`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /read-only/, 'advertises read-only')
    assert.match(html, /node_abc/, 'shows the node label')
    assert.doesNotMatch(html, /xterm|websocket|sendKeys|send-keys|\/bin\/sh/i, 'no input/shell affordance')
    // Polished header fields + keep-alive reconnect poller are present.
    assert.match(html, /id="conn"/, 'has a connection-state chip')
    assert.match(html, /id="updated"/, 'has a last-updated field')
    assert.match(html, /reconnecting/, 'browser poller has a reconnect path')

    const api = await fetch(`${server.url}/api/pane`)
    assert.equal(api.status, 200)
    const snap = await api.json() as { content: string; ended: boolean; source: string; stream: string; node_id: string }
    assert.equal(snap.source, 'events')
    assert.equal(snap.node_id, 'node_abc')
    assert.equal(snap.stream, 'connecting', 'fresh buffer reports connecting')
    assert.match(snap.content, /remote-mock-line-42/, 'serves the remote mock output')

    const post = await fetch(`${server.url}/`, { method: 'POST' })
    assert.equal(post.status, 405, 'mutating method rejected (read-only)')

    const missing = await fetch(`${server.url}/nope`)
    assert.equal(missing.status, 404)
  } finally {
    await server.close()
  }
})

test('startRemoteViewerServer: reports ended after a terminal event', async () => {
  const buf = new RemoteRunBuffer('run_x', 'node_abc', 'running')
  const server = await startRemoteViewerServer({ run_id: 'run_x', node_id: 'node_abc', host: '127.0.0.1', port: 0, buffer: buf })
  try {
    let snap = await (await fetch(`${server.url}/api/pane`)).json() as { ended: boolean }
    assert.equal(snap.ended, false)
    buf.push(statusEv('completed'))
    snap = await (await fetch(`${server.url}/api/pane`)).json() as { ended: boolean }
    assert.equal(snap.ended, true)
  } finally {
    await server.close()
  }
})

// ── 1d. public-bind access gate ─────────────────────────────────────────────

test('access gate: 401 without token, 200 with token (+ HttpOnly cookie), 200 with cookie', async () => {
  const buf = new RemoteRunBuffer('run_x', 'node_abc', 'running')
  buf.push(logEv('secret-pane-line'))
  const TOKEN = generateAccessToken()
  const server = await startRemoteViewerServer({ run_id: 'run_x', node_id: 'node_abc', host: '127.0.0.1', port: 0, buffer: buf, accessToken: TOKEN })
  try {
    // No / wrong token → 401 (before any routing).
    assert.equal((await fetch(`${server.url}/`)).status, 401, 'no token → 401')
    assert.equal((await fetch(`${server.url}/api/pane`)).status, 401, 'no token on api → 401')
    assert.equal((await fetch(`${server.url}/?access=wrong`)).status, 401, 'wrong token → 401')

    // Correct token in query → 200 and an HttpOnly cookie is set.
    const ok = await fetch(`${server.url}/?access=${TOKEN}`)
    assert.equal(ok.status, 200)
    const setCookie = ok.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /vibe_access=/, 'sets the access cookie')
    assert.match(setCookie, /HttpOnly/, 'cookie is HttpOnly')

    // Cookie alone authorizes subsequent polls (no query needed).
    const viaCookie = await fetch(`${server.url}/api/pane`, { headers: { cookie: `vibe_access=${TOKEN}` } })
    assert.equal(viaCookie.status, 200, 'cookie authorizes /api/pane')
    const paneText = await viaCookie.text()
    assert.ok(!paneText.includes(TOKEN), 'access token never echoed into the pane payload')

    // Read-only is preserved even when authorized.
    assert.equal((await fetch(`${server.url}/?access=${TOKEN}`, { method: 'POST' })).status, 405, 'POST still 405')
  } finally {
    await server.close()
  }
})

test('access gate off (loopback default): no token ⇒ frictionless 200s', async () => {
  const buf = new RemoteRunBuffer('run_x', 'node_abc', 'running')
  const server = await startRemoteViewerServer({ run_id: 'run_x', node_id: 'node_abc', host: '127.0.0.1', port: 0, buffer: buf })
  try {
    assert.equal((await fetch(`${server.url}/`)).status, 200)
    assert.equal((await fetch(`${server.url}/api/pane`)).status, 200)
  } finally {
    await server.close()
  }
})

test('generateAccessToken: distinct, high-entropy, independent of the relay token', () => {
  const a = generateAccessToken(), b = generateAccessToken()
  assert.notEqual(a, b, 'tokens are unique per call')
  assert.ok(a.length >= 32, 'base64url of 32 bytes')
  assert.notEqual(a, TEST_TOKEN, 'not the relay token')
})

// ── 1c. bind policy + structured error mapping ──────────────────────────────

test('validateBind: public host refused without --allow-public-bind', () => {
  assert.equal(validateBind('127.0.0.1', false).ok, true)
  const refused = validateBind('0.0.0.0', false)
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false && refused.code, 'public_bind_refused')
})

test('mapRemoteStatusError: maps relay codes to structured viewer codes', () => {
  assert.equal(mapRemoteStatusError(new Error('run_not_found: Run not found in relay: run_x')).code, 'run_not_found')
  assert.equal(mapRemoteStatusError(new Error('node_offline: Owning node is offline: node_abc')).code, 'node_offline')
  assert.equal(mapRemoteStatusError(new Error('node_not_found: Node not found: node_abc')).code, 'node_offline')
  assert.equal(mapRemoteStatusError(new Error('missing relay auth token')).code, 'auth_token_error')
  assert.equal(mapRemoteStatusError(new Error('something else entirely')).code, 'viewer_remote_error')
})

// ── 2. integration: fake relay + mock node → onRunEvent buffering ───────────

interface LiveNode { server: Awaited<ReturnType<typeof startRelayServer>>; relayUrl: string; daemon: ChildProcess }

function vibe(args: string[], timeoutMs = 15000): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(NODE, [CLI, ...args], { env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
    setTimeout(() => { proc.kill('SIGTERM'); resolve({ status: 124, stdout, stderr: stderr + '\n[timeout]' }) }, timeoutMs)
  })
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

let live: LiveNode | undefined

before(async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const relayUrl = `ws://127.0.0.1:${server.port}`
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', 'web-remote-node'], {
    env: { ...baseEnv, VIBE_RELAY_TOKEN: TEST_TOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_MOCK_RUN_MS: '5000' },
    stdio: 'pipe',
  })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await delay(300)
    const r = await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', TOKEN_FILE])
    if (r.status === 0) {
      try {
        const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
        if (nodes.some((n) => n.node_id === 'web-remote-node')) { live = { server, relayUrl, daemon }; return }
      } catch { /* not ready */ }
    }
  }
  daemon.kill('SIGKILL'); await server.close()
})

after(async () => {
  if (live) { if (!live.daemon.killed) live.daemon.kill('SIGTERM'); await delay(300); await live.server.close() }
})

test('remoteStream onRunEvent buffers remote mock events and flips ended on terminal', { timeout: 20000 }, async () => {
  assert.ok(live, 'fake relay + mock node must be up')
  if (!live) return

  const start = await vibe(['run', 'start', '--node', 'web-remote-node', '--agent', 'mock', '--workspace-key', `wr-${Date.now()}`, '--relay', live.relayUrl, '--token-file', TOKEN_FILE, '--json'])
  assert.equal(start.status, 0, `run start ok: ${start.stderr}`)
  const { run_id } = JSON.parse(start.stdout.trim()) as { run_id: string }
  assert.ok(run_id)

  const buffer = new RemoteRunBuffer(run_id, 'web-remote-node', 'running')
  const ac = new AbortController()
  const safety = setTimeout(() => ac.abort(), 12000)
  // suppressStdout keeps the test's stdout clean; onRunEvent feeds the buffer.
  await remoteStream(live.relayUrl, TEST_TOKEN, run_id, {
    onRunEvent: (e) => buffer.push(e),
    suppressStdout: true,
    signal: ac.signal,
  })
  clearTimeout(safety)

  const snap = buffer.snapshot()
  assert.ok(snap.content.length > 0, 'buffered at least one remote mock event')
  assert.equal(snap.ended, true, 'terminal event flips ended over the real stream path')
})

test('remoteRunStatus for an unknown run maps to run_not_found', async () => {
  assert.ok(live)
  if (!live) return
  await assert.rejects(
    () => remoteRunStatus(live!.relayUrl, TEST_TOKEN, 'run_does_not_exist_xyz'),
    (err: Error) => mapRemoteStatusError(err).code === 'run_not_found',
  )
})

// ── isolation guard ─────────────────────────────────────────────────────────

test('all state landed in the throwaway VIBE_DIR, not the real ~/.vibe', () => {
  assert.ok(VIBE_DIR.includes('vibe-web-remote-'))
  assert.ok(!VIBE_DIR.startsWith(path.join(process.env.HOME ?? '/home', '.vibe')))
})