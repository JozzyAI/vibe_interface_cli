/**
 * Tiny remote terminal dashboard: control-token gate + X-Vibe-Control CSRF guard
 * on /api, list/create/open/stop reusing the lifecycle protocol. Live in-process
 * relay + a real spawned mock node daemon (opt-in ON) + real tmux. tmux-requiring
 * tests skip when tmux is absent and kill ONLY their own `vibe-dash-*` sessions.
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
import { startTerminalDashboardServer, generateControlToken, type TerminalServer } from '../src/lib/terminal-web.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TOKEN = `dash-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`
const NODE_ID = 'dash-node'
const TMUX = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0 } catch { return false } })()
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand = () => Math.random().toString(36).slice(2, 8)
const created: string[] = []

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dash-')) }
function vibe(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 12000): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''; proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('close', () => resolve(stdout))
    setTimeout(() => { proc.kill('SIGTERM'); resolve(stdout) }, timeoutMs)
  })
}

interface Live { server: Awaited<ReturnType<typeof startRelayServer>>; relayUrl: string; daemon: ReturnType<typeof spawn>; vibeDir: string; tokenFile: string }
let live: Live | undefined
let dash: TerminalServer | undefined
let CONTROL = ''

before(async () => {
  const server = await startRelayServer({ port: 0, token: TOKEN })
  const relayUrl = `ws://127.0.0.1:${server.port}`
  const vibeDir = tmpDir()
  const tokenFile = path.join(vibeDir, 'tok'); fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 })
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', NODE_ID, '--allow-terminal-create'], {
    env: { ...process.env, VIBE_DIR: path.join(vibeDir, 'd'), VIBE_RELAY_TOKEN: TOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock' }, stdio: 'ignore',
  })
  const deadline = Date.now() + 9000
  let up = false
  while (Date.now() < deadline && !up) {
    await delay(300)
    try { if (JSON.parse((await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', tokenFile, '--json'], { ...process.env, VIBE_DIR: vibeDir })).trim()).some((n: { node_id: string }) => n.node_id === NODE_ID)) up = true } catch { /* not ready */ }
  }
  if (!up) { daemon.kill('SIGKILL'); await server.close(); return }
  live = { server, relayUrl, daemon, vibeDir, tokenFile }
  CONTROL = generateControlToken()
  dash = await startTerminalDashboardServer({ nodeId: NODE_ID, host: '127.0.0.1', port: 0, controlToken: CONTROL, relay: relayUrl, token: TOKEN })
})

after(async () => {
  if (TMUX) for (const s of created) spawnSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' })
  if (dash) await dash.close()
  if (live) { if (!live.daemon.killed) live.daemon.kill('SIGTERM'); await delay(300); await live.server.close() }
})

interface Res { status: number; body: string }
function req(method: string, pathQuery: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: dash!.port, path: pathQuery, method, headers }, (res) => {
      let body = ''; res.on('data', (d) => { body += d }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    r.on('error', reject); r.end()
  })
}
const CSRF = { 'X-Vibe-Control': '1' }

/** Open a dashboard WS (?session=&create=), collect outputs, then close. */
function openWs(query: string, ms = 1500): Promise<string[]> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${dash!.port}/ws?${query}&control=${CONTROL}`)
    const out: string[] = []
    ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'output') out.push(m.data) } catch { /* ignore */ } })
    ws.on('open', () => setTimeout(() => { try { ws.close() } catch { /* ignore */ } ; resolve(out) }, ms))
    ws.on('error', () => resolve(out))
  })
}

test('dashboard page: 401 without token, 200 + UI with token', async () => {
  assert.ok(dash)
  assert.equal((await req('GET', '/')).status, 401)
  const ok = await req('GET', `/?control=${CONTROL}`)
  assert.equal(ok.status, 200)
  assert.match(ok.body, /New session/); assert.match(ok.body, /Owned sessions/)
})

test('/api/sessions: 401 without token', async () => {
  assert.ok(dash)
  assert.equal((await req('GET', '/api/sessions')).status, 401)
})

test('/api/sessions: rejects without X-Vibe-Control header (CSRF 403)', async () => {
  assert.ok(dash)
  const r = await req('GET', `/api/sessions?control=${CONTROL}`) // authed, but no CSRF header
  assert.equal(r.status, 403)
})

test('/api/sessions: works with auth + CSRF header (JSON)', { skip: !TMUX, timeout: 15000 }, async () => {
  assert.ok(dash)
  const r = await req('GET', `/api/sessions?control=${CONTROL}`, CSRF)
  assert.equal(r.status, 200)
  const j = JSON.parse(r.body)
  assert.equal(j.node, NODE_ID); assert.equal(j.online, true); assert.ok(Array.isArray(j.sessions))
})

test('create via GET /ws?session=X&create=1 makes a Vibe-owned session; list then shows it', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(dash); if (!live) return
  const s = `vibe-dash-c-${rand()}`; created.push(s)
  await openWs(`session=${s}&create=1`)
  assert.equal(spawnSync('tmux', ['has-session', '-t', s], { stdio: 'ignore' }).status, 0, 'session created')
  assert.equal(spawnSync('tmux', ['show-options', '-v', '-t', s, '@vibe_owned'], { encoding: 'utf8' }).stdout.trim(), '1', 'owned')
  const list = JSON.parse((await req('GET', `/api/sessions?control=${CONTROL}`, CSRF)).body)
  assert.ok(list.sessions.includes(s), 'list shows the created session')
})

test('open via GET /ws?session=X streams pane output', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(dash)
  const s = `vibe-dash-o-${rand()}`; created.push(s)
  await openWs(`session=${s}&create=1`)          // create it
  const out = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${dash!.port}/ws?session=${s}&control=${CONTROL}`)
    let saw = false
    ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'output' && m.data.includes('DASH_OPEN_OK')) saw = true } catch { /* ignore */ } })
    ws.on('open', () => { setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: 'echo DASH_OPEN_OK\r' })), 500); setTimeout(() => { try { ws.close() } catch { /* ignore */ } ; resolve(saw) }, 4000) })
    ws.on('error', () => resolve(saw))
  })
  assert.equal(out, true, 'pane output streamed to the dashboard terminal WS')
})

test('DELETE /api/sessions/X kills an owned session; refuses a non-owned one', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(dash)
  const owned = `vibe-dash-k-${rand()}`; created.push(owned)
  const unowned = `vibe-dash-u-${rand()}`; created.push(unowned)
  await openWs(`session=${owned}&create=1`)
  spawnSync('tmux', ['new-session', '-d', '-s', unowned, 'bash'])
  const refuse = JSON.parse((await req('DELETE', `/api/sessions/${unowned}?control=${CONTROL}`, CSRF)).body)
  assert.equal(refuse.ok, false); assert.equal(refuse.code, 'terminal_not_owned')
  assert.equal(spawnSync('tmux', ['has-session', '-t', unowned], { stdio: 'ignore' }).status, 0, 'non-owned survives')
  const kill = JSON.parse((await req('DELETE', `/api/sessions/${owned}?control=${CONTROL}`, CSRF)).body)
  assert.equal(kill.ok, true); assert.equal(kill.result, 'killed')
  assert.equal(spawnSync('tmux', ['has-session', '-t', owned], { stdio: 'ignore' }).status !== 0, true, 'owned killed')
})

test('dashboard server logs neither the control token nor typed input', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(dash)
  const captured: string[] = []
  const oOut = process.stdout.write.bind(process.stdout); const oErr = process.stderr.write.bind(process.stderr)
  ;(process.stdout.write as unknown) = (c: string | Uint8Array, ...a: unknown[]) => { captured.push(String(c)); return (oOut as (...x: unknown[]) => boolean)(c, ...a) }
  ;(process.stderr.write as unknown) = (c: string | Uint8Array, ...a: unknown[]) => { captured.push(String(c)); return (oErr as (...x: unknown[]) => boolean)(c, ...a) }
  try {
    const s = `vibe-dash-l-${rand()}`; created.push(s)
    const secret = `SEKRIT_${rand()}`
    const ws = new WebSocket(`ws://127.0.0.1:${dash!.port}/ws?session=${s}&create=1&control=${CONTROL}`)
    await new Promise<void>((res) => { ws.on('open', () => res()); setTimeout(res, 3000) })
    ws.send(JSON.stringify({ type: 'input', data: `echo ${secret}\r` }))
    await delay(800); ws.close()
    await req('GET', `/api/sessions?control=${CONTROL}`, CSRF)
    const all = captured.join('')
    assert.ok(!all.includes(CONTROL), 'control token never logged')
    assert.ok(!all.includes(secret), 'typed input never logged')
  } finally {
    ;(process.stdout.write as unknown) = oOut; (process.stderr.write as unknown) = oErr
  }
})
