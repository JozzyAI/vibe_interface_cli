/**
 * Local tmux web terminal (Terminal Mode MVP). Pure unit tests for the bind
 * guard + control-token auth, plus integration tests over a real tmux session:
 * control-token gates the page and the WS, authenticated input reaches tmux,
 * pane output is delivered, and neither the token nor typed input is logged.
 *
 * tmux-dependent tests are skipped when tmux is unavailable. No relay, no agents.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { spawn, spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import {
  validateControlBind,
  isLoopbackHost,
  checkControlAccess,
  tmuxSessionExists,
  tmuxAvailable,
  generateControlToken,
  startTerminalServer,
  type TerminalServer,
} from '../src/lib/terminal-web.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const HAVE_TMUX = tmuxAvailable()
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── unit: bind guard ─────────────────────────────────────────────────────────

test('validateControlBind: loopback allowed without the flag', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(validateControlBind(h, false).ok, true)
    assert.equal(isLoopbackHost(h), true)
  }
})

test('validateControlBind: non-loopback REFUSED without --allow-control-bind', () => {
  const d = validateControlBind('192.168.1.50', false)
  assert.equal(d.ok, false)
  if (!d.ok) assert.equal(d.code, 'control_bind_refused')
  assert.equal(isLoopbackHost('192.168.1.50'), false)
})

test('validateControlBind: non-loopback allowed WITH --allow-control-bind', () => {
  assert.equal(validateControlBind('192.168.1.50', true).ok, true)
})

// ── unit: control-token auth ─────────────────────────────────────────────────

function fakeReq(url: string, cookie?: string): http.IncomingMessage {
  return { url, headers: cookie ? { cookie } : {} } as unknown as http.IncomingMessage
}

test('checkControlAccess: token required — query grants + sets HttpOnly cookie', () => {
  const tok = 'tok-abc'
  const ok = checkControlAccess(fakeReq(`/?control=${tok}`), tok)
  assert.equal(ok.ok, true)
  if (ok.ok) { assert.match(ok.setCookie ?? '', /vibe_control=tok-abc/); assert.match(ok.setCookie ?? '', /HttpOnly/) }
})

test('checkControlAccess: cookie grants; missing/wrong token denied', () => {
  const tok = 'tok-abc'
  assert.equal(checkControlAccess(fakeReq('/ws', `vibe_control=${tok}`), tok).ok, true)
  assert.equal(checkControlAccess(fakeReq('/'), tok).ok, false)
  assert.equal(checkControlAccess(fakeReq('/?control=wrong'), tok).ok, false)
  assert.equal(checkControlAccess(fakeReq('/', 'vibe_control=wrong'), tok).ok, false)
})

test('tmuxSessionExists: unknown session is false', () => {
  assert.equal(tmuxSessionExists(`nope-${Date.now()}`), false)
})

// ── integration: real tmux session + server ──────────────────────────────────

const SESSION = `vibe-term-test-${process.pid}-${Math.random().toString(36).slice(2)}`
let server: TerminalServer | undefined
let TOKEN = ''

before(async () => {
  if (!HAVE_TMUX) return
  spawnSync('tmux', ['new', '-d', '-s', SESSION, 'bash'], { stdio: 'ignore' })
  TOKEN = generateControlToken()
  server = await startTerminalServer({ session: SESSION, host: '127.0.0.1', port: 0, controlToken: TOKEN, pollMs: 60 })
})

after(async () => {
  if (server) await server.close()
  if (HAVE_TMUX) spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' })
})

function httpGet(pathAndQuery: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server!.port, path: pathAndQuery, headers }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
  })
}

test('page: 401 without token, 200 + xterm + HttpOnly cookie with token', { skip: !HAVE_TMUX }, async () => {
  assert.ok(server)
  const noAuth = await httpGet('/')
  assert.equal(noAuth.status, 401)

  const authed = await httpGet(`/?control=${TOKEN}`)
  assert.equal(authed.status, 200)
  assert.match(authed.body, /new Terminal\(/)
  assert.match(authed.body, /\/xterm\.js/)
  assert.match(String(authed.headers['set-cookie']?.[0] ?? ''), /vibe_control=.*HttpOnly/)

  // xterm asset is served (behind the same cookie auth)
  const asset = await httpGet('/xterm.js', { cookie: `vibe_control=${TOKEN}` })
  assert.equal(asset.status, 200)
  assert.ok(asset.body.length > 1000, 'xterm.js served from the local dependency')
})

test('WS: unauthenticated upgrade is rejected', { skip: !HAVE_TMUX }, async () => {
  assert.ok(server)
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`) // no token
  const rejected = await new Promise<boolean>((resolve) => {
    let done = false
    const finish = (v: boolean): void => { if (done) return; done = true; try { ws.terminate() } catch { /* ignore */ } ; resolve(v) }
    ws.on('open', () => finish(false))
    ws.on('error', () => finish(true))
    ws.on('unexpected-response', () => finish(true))
    setTimeout(() => finish(false), 3000)
  })
  assert.equal(rejected, true, 'WS without a control token must be refused')
})

test('WS: authenticated input reaches tmux and pane output is delivered', { skip: !HAVE_TMUX }, async () => {
  assert.ok(server)
  const marker = `MARKER_${Math.random().toString(36).slice(2, 8)}`
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?control=${TOKEN}`)
  let sawMarker = false
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString())
      if (m.type === 'output' && typeof m.data === 'string' && m.data.includes(marker)) sawMarker = true
    } catch { /* ignore */ }
  })
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('ws open timeout')), 4000)
    ws.once('open', () => { clearTimeout(to); resolve() })
    ws.once('error', (e) => { clearTimeout(to); reject(e) })
  })
  // Type a command into the session; expect its echoed output back via the pane.
  ws.send(JSON.stringify({ type: 'input', data: `echo ${marker}\r` }))

  const deadline = Date.now() + 6000
  while (Date.now() < deadline && !sawMarker) await delay(150)
  ws.close()
  assert.equal(sawMarker, true, 'input reached tmux and the echoed pane output came back over the WS')

  // Independent proof the input actually hit tmux (not just echoed locally):
  const pane = spawnSync('tmux', ['capture-pane', '-p', '-t', SESSION], { encoding: 'utf8' }).stdout
  assert.ok(pane.includes(marker), 'tmux pane contains the typed marker')
})

test('startTerminalServer performs no logging (token + input never written to stdout/stderr)', { skip: !HAVE_TMUX }, async () => {
  assert.ok(server)
  const captured: string[] = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // TEE (not swallow): capture a copy AND forward to the real stream, so the
  // node:test reporter's own output is never lost/corrupted.
  ;(process.stdout.write as unknown) = (c: string | Uint8Array, ...a: unknown[]) => { captured.push(String(c)); return (origOut as (...x: unknown[]) => boolean)(c, ...a) }
  ;(process.stderr.write as unknown) = (c: string | Uint8Array, ...a: unknown[]) => { captured.push(String(c)); return (origErr as (...x: unknown[]) => boolean)(c, ...a) }
  try {
    const secret = `SECRET_${Math.random().toString(36).slice(2, 8)}`
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?control=${TOKEN}`)
    await new Promise<void>((resolve) => { ws.on('open', () => resolve()); setTimeout(resolve, 3000) })
    ws.send(JSON.stringify({ type: 'input', data: `echo ${secret}\r` }))
    await delay(800)
    ws.close()
    const all = captured.join('')
    assert.ok(!all.includes(TOKEN), 'control token never logged')
    assert.ok(!all.includes(secret), 'typed input never logged')
  } finally {
    ;(process.stdout.write as unknown) = origOut
    ;(process.stderr.write as unknown) = origErr
  }
})

// ── CLI: missing tmux session → clean structured error, exit 1 ───────────────

test('CLI: `terminal serve` on a missing session → clean error, exit 1', { skip: !HAVE_TMUX }, async () => {
  const r = await new Promise<{ status: number; stdout: string }>((resolve) => {
    const p = spawn(NODE, [CLI, 'terminal', 'serve', '--session', `absent-${Date.now()}`, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.on('close', (code) => resolve({ status: code ?? 0, stdout }))
    setTimeout(() => { p.kill('SIGTERM'); resolve({ status: 124, stdout }) }, 8000)
  })
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'tmux_session_not_found')
})
