/**
 * Remote terminal PERFORMANCE: node-side adaptive polling. Verifies the pump
 * dedupes (no repeated frames for a static pane), backs off when idle, responds
 * quickly after input, stops cleanly on close, and never logs input/token.
 * Live in-process relay + a real spawned mock node daemon + real tmux. Timing
 * assertions are behavior BANDS (not exact ms) to avoid flake. tmux-gated;
 * kills ONLY its own `vibe-perf-*` sessions (never kill-server).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import { startRelayServer } from '../src/relay/server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TOKEN = `perf-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`
const NODE_ID = 'perf-node'
const TMUX = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0 } catch { return false } })()
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t = () => new Date().toISOString()
const rand = () => Math.random().toString(36).slice(2, 8)
const created: string[] = []

interface Live { server: Awaited<ReturnType<typeof startRelayServer>>; relayUrl: string; daemon: ReturnType<typeof spawn>; log: () => string }
let live: Live | undefined

before(async () => {
  const server = await startRelayServer({ port: 0, token: TOKEN })
  const relayUrl = `ws://127.0.0.1:${server.port}`
  const vibeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-perf-'))
  const tokenFile = path.join(vibeDir, 'tok'); fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 })
  let logBuf = ''
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', NODE_ID], {
    env: { ...process.env, VIBE_DIR: path.join(vibeDir, 'd'), VIBE_RELAY_TOKEN: TOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stdout!.on('data', (d: Buffer) => { logBuf += d.toString() })
  daemon.stderr!.on('data', (d: Buffer) => { logBuf += d.toString() })
  // wait for registration
  const deadline = Date.now() + 9000
  while (Date.now() < deadline && !/registered ✓/.test(logBuf)) await delay(200)
  if (!/registered ✓/.test(logBuf)) { daemon.kill('SIGKILL'); await server.close(); return }
  live = { server, relayUrl, daemon, log: () => logBuf }
})

after(async () => {
  if (TMUX) for (const s of created) spawnSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' })
  if (live) { if (!live.daemon.killed) live.daemon.kill('SIGTERM'); await delay(300); await live.server.close() }
})

function mkSession(): string { const s = `vibe-perf-${rand()}`; created.push(s); spawnSync('tmux', ['new-session', '-d', '-s', s, 'bash']); return s }

interface Frame { at: number; data: string }
/** Attach a raw relay client to a session; collect terminal_output frames. */
function attach(session: string): { ws: WebSocket; frames: Frame[]; input: (d: string) => void; close: () => void; ready: Promise<void> } {
  const ws = new WebSocket(`${live!.relayUrl}?token=${TOKEN}`)
  const frames: Frame[] = []
  const sid = `s_${rand()}`
  let openOk = false
  const ready = new Promise<void>((resolve) => {
    ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.session_id !== sid) return; if (m.type === 'terminal_open_ack') { openOk = m.ok; resolve() } if (m.type === 'terminal_output') frames.push({ at: Date.now(), data: m.data }) } catch { /* ignore */ } })
    ws.on('open', () => ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_open', req_id: sid, session_id: sid, session })))
    setTimeout(resolve, 4000)
  })
  return {
    ws, frames,
    input: (d: string) => ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_input', session_id: sid, data: d })),
    close: () => ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_close', session_id: sid })),
    ready,
  }
  void openOk
}

test('static pane: no repeated frames while idle (dedupe + idle backoff)', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(live); if (!live) return
  const s = mkSession()
  const c = attach(s); await c.ready
  await delay(1000)            // let the initial frame(s) settle
  const n0 = c.frames.length
  await delay(2500)            // quiet window — a static prompt must not stream frames
  const n1 = c.frames.length
  c.close(); c.ws.close()
  assert.ok(n0 >= 1, 'got an initial frame')
  assert.ok(n1 - n0 <= 1, `idle should emit ~no frames, got ${n1 - n0} in 2.5s`)
})

test('post-input output is delivered quickly (fast band)', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(live); if (!live) return
  const s = mkSession()
  const c = attach(s); await c.ready
  await delay(1200)            // go idle first (slow poll), then type
  const sent = Date.now()
  c.input('echo PERF_FAST_OK\r')
  const dl = Date.now() + 4000
  while (Date.now() < dl && !c.frames.some((f) => f.data.includes('PERF_FAST_OK'))) await delay(50)
  const hit = c.frames.find((f) => f.data.includes('PERF_FAST_OK'))
  c.close(); c.ws.close()
  assert.ok(hit, 'input produced output')
  assert.ok(hit!.at - sent < 1500, `post-input latency ${hit!.at - sent}ms should be well under a full slow poll`)
})

test('input still reaches tmux and output still streams', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(live); if (!live) return
  const s = mkSession()
  const c = attach(s); await c.ready
  c.input('echo PERF_STREAM_OK\r')
  const dl = Date.now() + 4000
  while (Date.now() < dl && !c.frames.some((f) => f.data.includes('PERF_STREAM_OK'))) await delay(80)
  c.close(); c.ws.close()
  assert.ok(c.frames.some((f) => f.data.includes('PERF_STREAM_OK')), 'output streamed to the client')
})

test('terminal_close stops the pump (no frames after close, even if the pane changes)', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(live); if (!live) return
  const s = mkSession()
  const c = attach(s); await c.ready
  await delay(600)
  c.close()
  await delay(600)
  const n0 = c.frames.length
  spawnSync('tmux', ['send-keys', '-t', s, '-l', '--', 'echo AFTER_CLOSE\r']) // change the pane directly
  await delay(1500)
  const n1 = c.frames.length
  c.ws.close()
  assert.equal(n1, n0, 'pump was stopped — no frames after terminal_close')
  assert.ok(!c.frames.some((f) => f.data.includes('AFTER_CLOSE')), 'no post-close output leaked')
})

test('node daemon logs neither typed input nor the relay token', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(live); if (!live) return
  const s = mkSession()
  const c = attach(s); await c.ready
  const secret = `PERF_SEKRIT_${rand()}`
  c.input(`echo ${secret}\r`)
  await delay(900)
  c.close(); c.ws.close()
  const log = live.log()
  assert.ok(!log.includes(secret), 'typed input never logged by the node')
  assert.ok(!log.includes(TOKEN), 'relay token never logged by the node')
})
