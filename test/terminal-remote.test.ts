/**
 * Remote terminal over the relay — REAL node-side tmux attach (PR: attach).
 *   browser WS -> gateway -> relay -> node daemon -> tmux send-keys/capture-pane
 * Proves: attach to an EXISTING session, input reaches tmux, pane output streams
 * back, missing-session fails cleanly, close cleans up WITHOUT killing tmux.
 *
 * Live in-process relay + a real spawned mock node daemon (async spawn). Real
 * tmux tests are gated on tmux being installed and kill ONLY their own uniquely
 * named session (never kill-server — protects any production `vibe-node`).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import { startRelayServer } from '../src/relay/server.js'
import { startRemoteTerminalServer, generateControlToken, type TerminalServer } from '../src/lib/terminal-web.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TEST_TOKEN = `termremote-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`
const NODE_ID = 'rt-node'
const TMUX = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0 } catch { return false } })()
const SESS = `vibe-rtt-${process.pid}-${Math.random().toString(36).slice(2, 7)}`

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-termremote-')) }
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t = () => new Date().toISOString()

function vibe(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15000): Promise<{ status: number; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('close', (code) => resolve({ status: code ?? 1, stdout }))
    setTimeout(() => { proc.kill('SIGTERM'); resolve({ status: 124, stdout }) }, timeoutMs)
  })
}

interface Live { server: Awaited<ReturnType<typeof startRelayServer>>; relayUrl: string; daemon: ReturnType<typeof spawn>; tokenFile: string; vibeDir: string }
let live: Live | undefined
let gw: TerminalServer | undefined
let CONTROL = ''

// Single setup: relay + mock node daemon + a dedicated tmux session + gateway.
before(async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const relayUrl = `ws://127.0.0.1:${server.port}`
  const vibeDir = tmpDir()
  const tokenFile = path.join(vibeDir, 'tok'); fs.writeFileSync(tokenFile, TEST_TOKEN + '\n', { mode: 0o600 })
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', NODE_ID], {
    env: { ...process.env, VIBE_DIR: vibeDir, VIBE_RELAY_TOKEN: TEST_TOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock' },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && !live) {
    await delay(300)
    const r = await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', tokenFile, '--json'], { ...process.env, VIBE_DIR: vibeDir })
    try { if (JSON.parse(r.stdout.trim()).some((n: { node_id: string }) => n.node_id === NODE_ID)) live = { server, relayUrl, daemon, tokenFile, vibeDir } } catch { /* not ready */ }
  }
  if (!live) { daemon.kill('SIGKILL'); await server.close(); return }
  if (TMUX) spawnSync('tmux', ['new', '-d', '-s', SESS, 'bash']) // the ONE session under test
  CONTROL = generateControlToken()
  gw = await startRemoteTerminalServer({ session: SESS, host: '127.0.0.1', port: 0, controlToken: CONTROL, relay: relayUrl, token: TEST_TOKEN, nodeId: NODE_ID })
})

after(async () => {
  if (gw) await gw.close()
  if (live) { if (!live.daemon.killed) live.daemon.kill('SIGTERM'); await delay(300); await live.server.close() }
  if (TMUX) spawnSync('tmux', ['kill-session', '-t', SESS], { stdio: 'ignore' }) // ONLY our session
})

function relayClient(): WebSocket { return new WebSocket(`${live!.relayUrl}?token=${TEST_TOKEN}`) }
function openRelay(ws: WebSocket): Promise<void> {
  return new Promise((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); setTimeout(() => rej(new Error('open timeout')), 4000) })
}

// ── node-side tmux attach (raw relay client as the gateway) ──────────────────

test('terminal_open attaches to an EXISTING tmux session; input reaches tmux and pane output streams back', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(live); if (!live) return
  const ws = relayClient(); const sid = 'sess_attach'
  const outputs: string[] = []; let ackOk: boolean | undefined
  ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.session_id !== sid) return; if (m.type === 'terminal_open_ack') ackOk = m.ok; if (m.type === 'terminal_output') outputs.push(m.data) } catch { /* ignore */ } })
  await openRelay(ws)
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_open', req_id: 'r1', session_id: sid, session: SESS }))
  await delay(500)
  assert.equal(ackOk, true, 'attached to the existing session')
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_input', session_id: sid, data: 'echo RTOPEN_OK\r' }))
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && !outputs.some((d) => d.includes('RTOPEN_OK'))) await delay(150)
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_close', session_id: sid }))
  ws.close()
  assert.ok(outputs.some((d) => d.includes('RTOPEN_OK')), 'the tmux pane output (echo result) streamed back to the gateway')
})

test('terminal_open to a MISSING tmux session → terminal_open_ack ok:false', { timeout: 15000 }, async () => {
  assert.ok(live); if (!live) return
  const ws = relayClient(); const sid = 'sess_missing'
  let ack: { ok?: boolean; message?: string } | undefined
  ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.session_id === sid && m.type === 'terminal_open_ack') ack = m } catch { /* ignore */ } })
  await openRelay(ws)
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_open', req_id: 'r2', session_id: sid, session: `no-such-${Math.random().toString(36).slice(2)}` }))
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !ack) await delay(100)
  ws.close()
  assert.ok(ack, 'got an ack'); assert.equal(ack!.ok, false, 'missing session fails cleanly (no attach)')
})

test('terminal_open to an unknown node → terminal_error(node_offline)', { timeout: 15000 }, async () => {
  assert.ok(live); if (!live) return
  const ws = relayClient(); const sid = 'sess_ghost'; let errCode: string | undefined
  ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.session_id === sid && m.type === 'terminal_error') errCode = m.code } catch { /* ignore */ } })
  await openRelay(ws)
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: 'ghost-node', ts: t(), type: 'terminal_open', req_id: 'r3', session_id: sid, session: 'x' }))
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !errCode) await delay(100)
  ws.close()
  assert.equal(errCode, 'node_offline')
})

test('terminal_close stops the bridge but does NOT kill the tmux session', { skip: !TMUX, timeout: 15000 }, async () => {
  assert.ok(live); if (!live) return
  const ws = relayClient(); const sid = 'sess_close'
  await openRelay(ws)
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_open', req_id: 'r4', session_id: sid, session: SESS }))
  await delay(500)
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_close', session_id: sid }))
  await delay(400)
  ws.close()
  assert.equal(spawnSync('tmux', ['has-session', '-t', SESS], { stdio: 'ignore' }).status, 0, 'tmux session survived terminal_close')
})

test('terminal_resize is accepted best-effort and does not break the bridge', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(live); if (!live) return
  const ws = relayClient(); const sid = 'sess_resize'; const outputs: string[] = []
  ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.session_id === sid && m.type === 'terminal_output') outputs.push(m.data) } catch { /* ignore */ } })
  await openRelay(ws)
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_open', req_id: 'r5', session_id: sid, session: SESS }))
  await delay(400)
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_resize', session_id: sid, cols: 100, rows: 30 }))
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_input', session_id: sid, data: 'echo AFTER_RESIZE_OK\r' }))
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && !outputs.some((d) => d.includes('AFTER_RESIZE_OK'))) await delay(150)
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_close', session_id: sid })); ws.close()
  assert.ok(outputs.some((d) => d.includes('AFTER_RESIZE_OK')), 'bridge still streams after a resize')
})

// ── gateway server (startRemoteTerminalServer) ───────────────────────────────

function httpGet(pathAndQuery: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: gw!.port, path: pathAndQuery }, (res) => {
      let body = ''; res.on('data', (d) => { body += d }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject)
  })
}

test('gateway page: control-token gate (401 without, 200 + xterm with)', { timeout: 15000 }, async () => {
  assert.ok(gw)
  assert.equal((await httpGet('/')).status, 401)
  const authed = await httpGet(`/?control=${CONTROL}`)
  assert.equal(authed.status, 200)
  assert.match(authed.body, /new Terminal\(/)
})

test('gateway WS: unauthenticated upgrade rejected', { timeout: 15000 }, async () => {
  assert.ok(gw)
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`)
  const rejected = await new Promise<boolean>((resolve) => {
    let done = false; const fin = (v: boolean) => { if (!done) { done = true; try { ws.terminate() } catch { /* ignore */ } ; resolve(v) } }
    ws.on('open', () => fin(false)); ws.on('error', () => fin(true)); ws.on('unexpected-response', () => fin(true)); setTimeout(() => fin(false), 3000)
  })
  assert.equal(rejected, true)
})

test('gateway bridge e2e: browser input → node tmux → browser output (over the relay)', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(gw)
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws?control=${CONTROL}`)
  let sawMarker = false
  ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'output' && typeof m.data === 'string' && m.data.includes('BROWSER_TMUX_OK')) sawMarker = true } catch { /* ignore */ } })
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); setTimeout(() => rej(new Error('open timeout')), 5000) })
  await delay(600) // terminal_open round-trip
  ws.send(JSON.stringify({ type: 'input', data: 'echo BROWSER_TMUX_OK\r' }))
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && !sawMarker) await delay(150)
  ws.close()
  assert.equal(sawMarker, true, 'the full browser↔gateway↔relay↔node↔tmux path delivered the pane output')
})

test('gateway performs no logging (control token + typed input never written to stdout/stderr)', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(gw)
  const captured: string[] = []
  const oOut = process.stdout.write.bind(process.stdout); const oErr = process.stderr.write.bind(process.stderr)
  ;(process.stdout.write as unknown) = (c: string | Uint8Array, ...a: unknown[]) => { captured.push(String(c)); return (oOut as (...x: unknown[]) => boolean)(c, ...a) }
  ;(process.stderr.write as unknown) = (c: string | Uint8Array, ...a: unknown[]) => { captured.push(String(c)); return (oErr as (...x: unknown[]) => boolean)(c, ...a) }
  try {
    const secret = `SECRET_${Math.random().toString(36).slice(2, 8)}`
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws?control=${CONTROL}`)
    await new Promise<void>((res) => { ws.on('open', () => res()); setTimeout(res, 3000) })
    ws.send(JSON.stringify({ type: 'input', data: `echo ${secret}\r` }))
    await delay(900); ws.close()
    const all = captured.join('')
    assert.ok(!all.includes(CONTROL), 'control token never logged')
    assert.ok(!all.includes(secret), 'typed input never logged')
  } finally {
    ;(process.stdout.write as unknown) = oOut; (process.stderr.write as unknown) = oErr
  }
})
