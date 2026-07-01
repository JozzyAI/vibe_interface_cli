/**
 * Remote terminal protocol skeleton (echo). Proves the transport end-to-end:
 *   browser WS -> gateway -> relay -> node daemon (ECHO) -> relay -> gateway -> browser
 * plus the raw relay routing/fan-out and the node echo handler. No tmux yet.
 *
 * Live in-process relay + a real spawned mock node daemon (async spawn — an
 * in-process relay shares the event loop). Temp VIBE_DIR. No token/input logged.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { spawn } from 'child_process'
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

// Single setup: bring up relay + mock node daemon, then the gateway server.
// (One hook avoids any multi-`before` ordering ambiguity around `live`.)
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
  CONTROL = generateControlToken()
  gw = await startRemoteTerminalServer({ session: 'phone-echo', host: '127.0.0.1', port: 0, controlToken: CONTROL, relay: relayUrl, token: TEST_TOKEN, nodeId: NODE_ID })
})

after(async () => {
  if (gw) await gw.close()
  if (live) { if (!live.daemon.killed) live.daemon.kill('SIGTERM'); await delay(300); await live.server.close() }
})

/** Open a raw relay client ws (as a gateway would), authed with the token. */
function relayClient(): WebSocket {
  return new WebSocket(`${live!.relayUrl}?token=${TEST_TOKEN}`)
}

test('relay routes terminal_open/input to the node; node ECHOes output back to the gateway', { timeout: 20000 }, async () => {
  assert.ok(live, 'relay + node up'); if (!live) return
  const ws = relayClient()
  const sid = 'sess_a'
  const outputs: string[] = []
  let ackOk: boolean | undefined
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString())
      if (m.session_id !== sid) return
      if (m.type === 'terminal_open_ack') ackOk = m.ok
      if (m.type === 'terminal_output') outputs.push(m.data)
    } catch { /* ignore */ }
  })
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); setTimeout(() => rej(new Error('open timeout')), 4000) })

  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_open', req_id: 'r1', session_id: sid, session: 'whatever' }))
  await delay(400)
  assert.equal(ackOk, true, 'node acked terminal_open ok')

  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: NODE_ID, ts: t(), type: 'terminal_input', session_id: sid, data: 'ECHO_ME_123' }))
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && !outputs.some((d) => d.includes('ECHO_ME_123'))) await delay(100)
  ws.close()
  assert.ok(outputs.some((d) => d.includes('ECHO_ME_123')), 'input was echoed back as terminal_output through the relay')
})

test('relay returns terminal_error(node_offline) for terminal_open to an unknown node', { timeout: 15000 }, async () => {
  assert.ok(live, 'relay up'); if (!live) return
  const ws = relayClient()
  const sid = 'sess_ghost'
  let errCode: string | undefined
  ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.session_id === sid && m.type === 'terminal_error') errCode = m.code } catch { /* ignore */ } })
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); setTimeout(() => rej(new Error('open timeout')), 4000) })
  ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: 'ghost-node', ts: t(), type: 'terminal_open', req_id: 'r2', session_id: sid, session: 'x' }))
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !errCode) await delay(100)
  ws.close()
  assert.equal(errCode, 'node_offline', 'unknown node → terminal_error node_offline routed back to the gateway')
})

// ── gateway server (startRemoteTerminalServer) end-to-end ────────────────────

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

test('gateway bridge e2e: browser input → node echo → browser output (over the relay)', { timeout: 20000 }, async () => {
  assert.ok(gw)
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws?control=${CONTROL}`)
  let sawMarker = false
  ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'output' && typeof m.data === 'string' && m.data.includes('BROWSER_ECHO_OK')) sawMarker = true } catch { /* ignore */ } })
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); setTimeout(() => rej(new Error('open timeout')), 5000) })
  await delay(500) // let terminal_open round-trip
  ws.send(JSON.stringify({ type: 'input', data: 'BROWSER_ECHO_OK' }))
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && !sawMarker) await delay(150)
  ws.close()
  assert.equal(sawMarker, true, 'the full browser↔gateway↔relay↔node echo path delivered the marker')
})

test('gateway performs no logging (control token + typed input never written to stdout/stderr)', { timeout: 20000 }, async () => {
  assert.ok(gw)
  const captured: string[] = []
  const oOut = process.stdout.write.bind(process.stdout); const oErr = process.stderr.write.bind(process.stderr)
  ;(process.stdout.write as unknown) = (c: string | Uint8Array, ...a: unknown[]) => { captured.push(String(c)); return (oOut as (...x: unknown[]) => boolean)(c, ...a) }
  ;(process.stderr.write as unknown) = (c: string | Uint8Array, ...a: unknown[]) => { captured.push(String(c)); return (oErr as (...x: unknown[]) => boolean)(c, ...a) }
  try {
    const secret = `SECRET_${Math.random().toString(36).slice(2, 8)}`
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws?control=${CONTROL}`)
    await new Promise<void>((res) => { ws.on('open', () => res()); setTimeout(res, 3000) })
    ws.send(JSON.stringify({ type: 'input', data: `echo ${secret}` }))
    await delay(800); ws.close()
    const all = captured.join('')
    assert.ok(!all.includes(CONTROL), 'control token never logged')
    assert.ok(!all.includes(secret), 'typed input never logged')
  } finally {
    ;(process.stdout.write as unknown) = oOut; (process.stderr.write as unknown) = oErr
  }
})
