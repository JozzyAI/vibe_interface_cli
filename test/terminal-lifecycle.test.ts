/**
 * Remote terminal session lifecycle: create-if-missing (node-opt-in gated),
 * list Vibe-owned sessions, stop only Vibe-owned sessions. Live in-process relay
 * + TWO real spawned mock node daemons — one started WITH `--allow-terminal-create`
 * (opt-in ON), one WITHOUT (opt-in OFF). Real tmux; tmux-requiring tests skip when
 * tmux is absent and kill ONLY their own `vibe-rtl-*` sessions (never kill-server).
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
const TOKEN = `rtl-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`
const N_CREATE = 'rtl-create'      // daemon started WITH --allow-terminal-create
const N_NOCREATE = 'rtl-nocreate'  // daemon started WITHOUT it
const TMUX = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0 } catch { return false } })()
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t = () => new Date().toISOString()
const rand = () => Math.random().toString(36).slice(2, 8)
const created: string[] = [] // vibe-rtl-* sessions to clean up

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-rtl-')) }

function vibe(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15000): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
    setTimeout(() => { proc.kill('SIGTERM'); resolve({ status: 124, stdout, stderr }) }, timeoutMs)
  })
}

interface Live { server: Awaited<ReturnType<typeof startRelayServer>>; relayUrl: string; daemons: ReturnType<typeof spawn>[]; tokenFile: string; vibeDir: string }
let live: Live | undefined

async function waitRegistered(relayUrl: string, tokenFile: string, vibeDir: string, ids: string[]): Promise<boolean> {
  const deadline = Date.now() + 9000
  while (Date.now() < deadline) {
    await delay(300)
    const r = await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', tokenFile, '--json'], { ...process.env, VIBE_DIR: vibeDir })
    try { const got = new Set(JSON.parse(r.stdout.trim()).map((n: { node_id: string }) => n.node_id)); if (ids.every((i) => got.has(i))) return true } catch { /* not ready */ }
  }
  return false
}

before(async () => {
  const server = await startRelayServer({ port: 0, token: TOKEN })
  const relayUrl = `ws://127.0.0.1:${server.port}`
  const vibeDir = tmpDir()
  const tokenFile = path.join(vibeDir, 'tok'); fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 })
  const base = { ...process.env, VIBE_RELAY_TOKEN: TOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock' }
  const dCreate = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', N_CREATE, '--allow-terminal-create'], { env: { ...base, VIBE_DIR: path.join(vibeDir, 'c') }, stdio: 'ignore' })
  const dNo = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', N_NOCREATE], { env: { ...base, VIBE_DIR: path.join(vibeDir, 'n') }, stdio: 'ignore' })
  if (await waitRegistered(relayUrl, tokenFile, vibeDir, [N_CREATE, N_NOCREATE])) {
    live = { server, relayUrl, daemons: [dCreate, dNo], tokenFile, vibeDir }
  } else { dCreate.kill('SIGKILL'); dNo.kill('SIGKILL'); await server.close() }
})

after(async () => {
  if (TMUX) for (const s of created) spawnSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' })
  if (live) { for (const d of live.daemons) if (!d.killed) d.kill('SIGTERM'); await delay(300); await live.server.close() }
})

/** Open a terminal_open to a node; collect the open_ack + any outputs for ~ms. */
function openTerminal(nodeId: string, session: string, opts: { create?: boolean } = {}, ms = 1200): Promise<{ ackOk?: boolean; ackCode?: string; ackMsg?: string; outputs: string[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${live!.relayUrl}?token=${TOKEN}`)
    const sid = `s_${rand()}`; const outputs: string[] = []
    let ackOk: boolean | undefined; let ackCode: string | undefined; let ackMsg: string | undefined
    ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.session_id !== sid) return; if (m.type === 'terminal_open_ack') { ackOk = m.ok; ackCode = m.code; ackMsg = m.message } if (m.type === 'terminal_output') outputs.push(m.data) } catch { /* ignore */ } })
    ws.on('open', () => { ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: nodeId, ts: t(), type: 'terminal_open', req_id: sid, session_id: sid, session, create: opts.create })) ; setTimeout(() => { try { ws.close() } catch { /* ignore */ } ; resolve({ ackOk, ackCode, ackMsg, outputs }) }, ms) })
    ws.on('error', () => resolve({ ackOk, ackCode, ackMsg, outputs }))
  })
}

/** One-shot request/reply (list or kill). */
function reqReply(nodeId: string, send: (reqId: string) => object, ackType: string, ms = 3000): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${live!.relayUrl}?token=${TOKEN}`)
    const reqId = `r_${rand()}`; let ack: Record<string, unknown> | undefined
    ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === ackType && m.req_id === reqId) { ack = m; try { ws.close() } catch { /* ignore */ } ; resolve(ack) } } catch { /* ignore */ } })
    ws.on('open', () => ws.send(JSON.stringify({ version: 1, kind: 'plaintext', from: 'cli', to: nodeId, ts: t(), req_id: reqId, ...send(reqId) })))
    ws.on('error', () => resolve(ack))
    setTimeout(() => { try { ws.close() } catch { /* ignore */ } ; resolve(ack) }, ms)
  })
}
const listOwned = (nodeId: string) => reqReply(nodeId, () => ({ type: 'terminal_session_list' }), 'terminal_session_list_ack')
const killSession = (nodeId: string, session: string) => reqReply(nodeId, () => ({ type: 'terminal_session_kill', session }), 'terminal_session_kill_ack')

test('serve --create creates a missing session when the node opted in (attaches + streams)', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(live); if (!live) return
  const s = `vibe-rtl-c-${rand()}`; created.push(s)
  const r = await openTerminal(N_CREATE, s, { create: true })
  assert.equal(r.ackOk, true, `open_ack not ok: ${r.ackMsg}`)
  assert.equal(spawnSync('tmux', ['has-session', '-t', s], { stdio: 'ignore' }).status, 0, 'session was created')
  assert.equal(spawnSync('tmux', ['show-options', '-v', '-t', s, '@vibe_owned'], { encoding: 'utf8' }).stdout.trim(), '1', 'created session is stamped @vibe_owned')
})

test('create is REFUSED when the node did not opt in (terminal_create_disabled)', { skip: !TMUX, timeout: 15000 }, async () => {
  assert.ok(live); if (!live) return
  const s = `vibe-rtl-x-${rand()}`
  const r = await openTerminal(N_NOCREATE, s, { create: true })
  assert.equal(r.ackOk, false)
  assert.equal(r.ackCode, 'terminal_create_disabled')
  assert.equal(spawnSync('tmux', ['has-session', '-t', s], { stdio: 'ignore' }).status !== 0, true, 'no session created when opt-in is off')
})

test('missing session WITHOUT --create still fails as before (session_not_found)', { skip: !TMUX, timeout: 15000 }, async () => {
  assert.ok(live); if (!live) return
  const r = await openTerminal(N_CREATE, `vibe-rtl-missing-${rand()}`, { create: false })
  assert.equal(r.ackOk, false); assert.equal(r.ackCode, 'session_not_found')
})

test('existing session attach still works (no create)', { skip: !TMUX, timeout: 15000 }, async () => {
  assert.ok(live); if (!live) return
  const s = `vibe-rtl-e-${rand()}`; created.push(s)
  spawnSync('tmux', ['new-session', '-d', '-s', s, 'bash'])
  const r = await openTerminal(N_CREATE, s, { create: false })
  assert.equal(r.ackOk, true, 'attached to a pre-existing session')
})

test('list returns only Vibe-owned sessions (not vibe-node / user sessions)', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(live); if (!live) return
  const owned = `vibe-rtl-o-${rand()}`; created.push(owned)
  const unowned = `vibe-rtl-u-${rand()}`; created.push(unowned)
  await openTerminal(N_CREATE, owned, { create: true })       // owned (created by vibe)
  spawnSync('tmux', ['new-session', '-d', '-s', unowned, 'bash']) // NOT owned (user-made)
  const ack = await listOwned(N_CREATE)
  assert.ok(ack && ack.ok === true)
  const sessions = ack!.sessions as string[]
  assert.ok(sessions.includes(owned), 'owned session listed')
  assert.ok(!sessions.includes(unowned), 'unowned session NOT listed')
})

test('stop kills a Vibe-owned session but REFUSES a non-owned one (terminal_not_owned)', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(live); if (!live) return
  const owned = `vibe-rtl-k-${rand()}`; created.push(owned)
  const unowned = `vibe-rtl-p-${rand()}`; created.push(unowned)
  await openTerminal(N_CREATE, owned, { create: true })
  spawnSync('tmux', ['new-session', '-d', '-s', unowned, 'bash'])
  const refuse = await killSession(N_CREATE, unowned)
  assert.equal(refuse!.ok, false); assert.equal(refuse!.code, 'terminal_not_owned')
  assert.equal(spawnSync('tmux', ['has-session', '-t', unowned], { stdio: 'ignore' }).status, 0, 'non-owned session survives')
  const kill = await killSession(N_CREATE, owned)
  assert.equal(kill!.ok, true); assert.equal(kill!.result, 'killed')
  assert.equal(spawnSync('tmux', ['has-session', '-t', owned], { stdio: 'ignore' }).status !== 0, true, 'owned session killed')
})

test('invalid session names are rejected (no shell injection, no session created)', { skip: !TMUX, timeout: 15000 }, async () => {
  assert.ok(live); if (!live) return
  const pwn = path.join(os.tmpdir(), `vibe-pwned-${rand()}`)
  const evil = `x; touch ${pwn}` // spaces + ; ⇒ must be rejected by the name guard
  const open = await openTerminal(N_CREATE, evil, { create: true })
  assert.equal(open.ackOk, false); assert.equal(open.ackCode, 'invalid_session_name')
  const kill = await killSession(N_CREATE, '-badflag')
  assert.equal(kill!.ok, false); assert.equal(kill!.code, 'invalid_session_name')
  await delay(200)
  assert.equal(fs.existsSync(pwn), false, 'no injected command ran')
})

test('bridge/gateway close does NOT kill the created session', { skip: !TMUX, timeout: 20000 }, async () => {
  assert.ok(live); if (!live) return
  const s = `vibe-rtl-live-${rand()}`; created.push(s)
  await openTerminal(N_CREATE, s, { create: true }) // openTerminal closes its ws at the end
  await delay(400)
  assert.equal(spawnSync('tmux', ['has-session', '-t', s], { stdio: 'ignore' }).status, 0, 'session survives the bridge close')
})
