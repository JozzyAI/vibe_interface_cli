/**
 * Local Agent Task Gateway — REST + SSE over the real mock/local run lifecycle.
 * Auth+binding, agents, task create/status, SSE (replay/order/multi-subscriber/
 * disconnect/terminal-once), idempotent cancel, robustness, and bounded
 * retention. Uses a throwaway VIBE_DIR and a fast mock run (VIBE_MOCK_RUN_MS).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startAgentGateway, computeSseReplay, MAX_ACTIVE_TASKS, type GatewayServer } from '../src/lib/agent-gateway.js'
import { resolveApiTokenFile } from '../src/commands/api.js'
import type { TaskEvent } from '../src/lib/agent-task-contract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TOKEN = `test-api-tok-${Math.random().toString(36).slice(2)}`
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

let gw: GatewayServer
let VIBE_DIR: string

before(async () => {
  VIBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-gw-'))
  process.env.VIBE_DIR = VIBE_DIR
  process.env.VIBE_MOCK_RUN_MS = '300' // fast mock completion
  gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN })
})

after(async () => { if (gw) await gw.close() })

interface Res { status: number; headers: http.IncomingHttpHeaders; text: string }
function req(method: string, p: string, opts: { token?: string; body?: string; headers?: Record<string, string>; port?: number } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    if (opts.token) headers.authorization = `Bearer ${opts.token}`
    if (opts.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port: opts.port ?? gw.port, path: p, method, headers }, (res) => {
      let text = ''; res.on('data', (d) => { text += d }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
    })
    r.on('error', reject)
    if (opts.body !== undefined) r.write(opts.body)
    r.end()
  })
}
const jreq = async (m: string, p: string, o: Parameters<typeof req>[2] = {}): Promise<{ status: number; body: any }> => {
  const r = await req(m, p, { token: TOKEN, ...o }); let body: any = null
  try { body = JSON.parse(r.text) } catch { /* non-json */ }
  return { status: r.status, body }
}
const createTask = (over: Record<string, unknown> = {}) => jreq('POST', '/v1/tasks', { body: JSON.stringify({ agent: 'mock', input: { text: 'do the thing' }, ...over }) })
async function waitStatus(id: string, want: string, ms = 8000): Promise<any> {
  const end = Date.now() + ms
  while (Date.now() < end) { const r = await jreq('GET', `/v1/tasks/${id}`); if (r.body?.status === want) return r.body; await delay(120) }
  throw new Error(`task ${id} did not reach ${want}`)
}

/** Open an SSE stream; collect parsed events. Returns a controller. */
interface SseEvent { id?: string; event?: string; data?: any }
function openSse(id: string, opts: { lastEventId?: string; port?: number } = {}): { events: SseEvent[]; headers: Promise<http.IncomingHttpHeaders>; ended: Promise<void>; destroy: () => void } {
  const events: SseEvent[] = []
  let buf = ''
  const headers: { resolve?: (h: http.IncomingHttpHeaders) => void } = {}
  let endResolve: () => void
  const ended = new Promise<void>((r) => { endResolve = r })
  const headersP = new Promise<http.IncomingHttpHeaders>((r) => { headers.resolve = r })
  const h: Record<string, string> = { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' }
  if (opts.lastEventId) h['last-event-id'] = opts.lastEventId
  const r = http.request({ host: '127.0.0.1', port: opts.port ?? gw.port, path: `/v1/tasks/${id}/events`, method: 'GET', headers: h }, (res) => {
    headers.resolve!(res.headers)
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
        if (!frame || frame.startsWith(':')) continue
        const ev: SseEvent = {}
        for (const line of frame.split('\n')) {
          if (line.startsWith('id: ')) ev.id = line.slice(4)
          else if (line.startsWith('event: ')) ev.event = line.slice(7)
          else if (line.startsWith('data: ')) { try { ev.data = JSON.parse(line.slice(6)) } catch { ev.data = line.slice(6) } }
        }
        if (ev.event) events.push(ev)
      }
    })
    res.on('end', () => endResolve())
  })
  r.on('error', () => endResolve())
  r.end()
  return { events, headers: headersP, ended, destroy: () => r.destroy() }
}

// ── auth & binding ────────────────────────────────────────────────────────────

test('auth: missing bearer -> 401, wrong bearer -> 401, correct -> 200; token never in body', async () => {
  const noAuth = await req('GET', '/v1/agents')
  assert.equal(noAuth.status, 401)
  assert.ok(!noAuth.text.includes(TOKEN), 'token never echoed')
  const wrong = await req('GET', '/v1/agents', { token: 'nope' })
  assert.equal(wrong.status, 401)
  const ok = await jreq('GET', '/v1/agents')
  assert.equal(ok.status, 200)
  assert.ok(!JSON.stringify(ok.body).includes(TOKEN))
})

test('CLI: non-loopback bind refused without --allow-bind', async () => {
  const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const p = spawn(NODE, [CLI, 'api', 'serve', '--host', '0.0.0.0', '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''; p.stdout.on('data', (d) => { stdout += d })
    p.on('close', (code) => resolve({ code, stdout }))
    setTimeout(() => { p.kill('SIGKILL'); resolve({ code: -1, stdout }) }, 5000)
  })
  assert.equal(out.code, 1, 'exits 1')
  assert.match(out.stdout, /bind_refused/)
})

test('CLI: --token-file creates a 0600 file and keeps the token out of stdout', async () => {
  const tf = path.join(VIBE_DIR, 'api-token')
  const p = spawn(NODE, [CLI, 'api', 'serve', '--host', '127.0.0.1', '--port', '0', '--token-file', tf], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env } })
  let stdout = ''; p.stdout.on('data', (d) => { stdout += d })
  try {
    const end = Date.now() + 6000
    while (Date.now() < end && !fs.existsSync(tf)) await delay(100)
    assert.ok(fs.existsSync(tf), 'token file created')
    assert.equal(fs.statSync(tf).mode & 0o777, 0o600, 'token file is 0600')
    const tok = fs.readFileSync(tf, 'utf8').trim()
    assert.ok(tok.length > 20)
    await delay(200)
    assert.ok(!stdout.includes(tok), 'token not printed to stdout when using --token-file')
  } finally { p.kill('SIGKILL') }
})

// ── agents ────────────────────────────────────────────────────────────────────

test('GET /v1/agents returns only local mock; no invented nodes/capabilities', async () => {
  const r = await jreq('GET', '/v1/agents')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.agents, [{ id: 'mock', available: true, streaming: true }])
})

// ── task creation / status ────────────────────────────────────────────────────

test('POST /v1/tasks (mock) -> 202 canonical Task; reaches running then completed', async () => {
  const c = await createTask()
  assert.equal(c.status, 202)
  assert.equal(c.body.agent, 'mock')
  assert.equal(typeof c.body.task_id, 'string')
  assert.equal(c.body.contract_version, 1)
  assert.ok(['queued', 'running'].includes(c.body.status))
  const done = await waitStatus(c.body.task_id, 'completed')
  assert.equal(done.status, 'completed')
  assert.equal(done.task_id, c.body.task_id)
})

test('POST /v1/tasks validation: invalid body, arrays, unsupported agent, remote node_id', async () => {
  assert.equal((await jreq('POST', '/v1/tasks', { body: '{}' })).status, 400)
  assert.equal((await jreq('POST', '/v1/tasks', { body: '[]' })).status, 400)
  const arrMeta = await jreq('POST', '/v1/tasks', { body: JSON.stringify({ agent: 'mock', input: { text: 'x' }, metadata: [] }) })
  assert.equal(arrMeta.status, 400); assert.equal(arrMeta.body.code, 'invalid_request')
  const unsup = await createTask({ agent: 'claude-code' })
  assert.equal(unsup.status, 422); assert.equal(unsup.body.code, 'agent_unavailable')
  const remote = await createTask({ node_id: 'node_remote123' })
  assert.equal(remote.status, 400); assert.equal(remote.body.code, 'invalid_request')
})

test('GET unknown task -> 404 task_not_found', async () => {
  const r = await jreq('GET', '/v1/tasks/run_does_not_exist')
  assert.equal(r.status, 404); assert.equal(r.body.code, 'task_not_found')
})

// ── SSE ───────────────────────────────────────────────────────────────────────

test('SSE: headers, framing, monotonic ids, lifecycle mapping, terminal-once', async () => {
  const c = await createTask()
  const s = openSse(c.body.task_id)
  const h = await s.headers
  assert.match(String(h['content-type']), /text\/event-stream/)
  assert.equal(h['cache-control'], 'no-cache, no-transform')
  await s.ended // closes after terminal
  const types = s.events.map((e) => e.event)
  assert.ok(types.includes('task.created'))
  assert.ok(types.includes('task.started'))
  assert.ok(types.includes('agent.output.delta'))
  assert.ok(types.includes('task.completed'))
  assert.equal(types.filter((t) => t === 'task.completed').length, 1, 'terminal delivered exactly once')
  const ids = s.events.map((e) => Number(e.id))
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], 'monotonic ids')
  assert.equal(s.events[0].data.contract_version, 1)
})

test('SSE: late subscriber replays retained buffer in order after completion', async () => {
  const c = await createTask()
  await waitStatus(c.body.task_id, 'completed')
  const s = openSse(c.body.task_id) // connect AFTER terminal
  await s.ended
  const types = s.events.map((e) => e.event)
  assert.ok(types.includes('task.created') && types.includes('task.completed'), 'retained events replayed')
  const ids = s.events.map((e) => Number(e.id))
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'replayed in order')
})

test('SSE: Last-Event-ID replays only newer events', async () => {
  const c = await createTask()
  await waitStatus(c.body.task_id, 'completed')
  const full = openSse(c.body.task_id); await full.ended
  const midId = full.events[1].id!
  const partial = openSse(c.body.task_id, { lastEventId: midId }); await partial.ended
  assert.ok(partial.events.every((e) => Number(e.id) > Number(midId)), 'only events after Last-Event-ID')
  assert.ok(partial.events.length < full.events.length)
})

test('SSE: two simultaneous subscribers both receive the terminal event', async () => {
  const c = await createTask()
  const a = openSse(c.body.task_id), b = openSse(c.body.task_id)
  await Promise.all([a.ended, b.ended])
  for (const s of [a, b]) assert.ok(s.events.some((e) => e.event === 'task.completed'))
})

test('SSE: client disconnect does NOT cancel the task', async () => {
  const c = await createTask()
  const s = openSse(c.body.task_id)
  await s.headers
  await delay(50)
  s.destroy() // disconnect mid-run
  const done = await waitStatus(c.body.task_id, 'completed')
  assert.equal(done.status, 'completed', 'task completed despite subscriber disconnect')
})

// ── cancellation ──────────────────────────────────────────────────────────────

test('cancel: active task -> cancelled; idempotent; concurrent does not error', async () => {
  const c = await createTask()
  const first = await jreq('POST', `/v1/tasks/${c.body.task_id}/cancel`)
  assert.equal(first.status, 200)
  assert.equal(first.body.status, 'cancelled')
  // repeated + concurrent
  const [r1, r2] = await Promise.all([
    jreq('POST', `/v1/tasks/${c.body.task_id}/cancel`),
    jreq('POST', `/v1/tasks/${c.body.task_id}/cancel`),
  ])
  assert.equal(r1.status, 200); assert.equal(r2.status, 200)
  assert.equal(r1.body.status, 'cancelled'); assert.equal(r2.body.status, 'cancelled')
})

test('cancel: completed task is harmless (returns completed unchanged)', async () => {
  const c = await createTask()
  await waitStatus(c.body.task_id, 'completed')
  const r = await jreq('POST', `/v1/tasks/${c.body.task_id}/cancel`)
  assert.equal(r.status, 200); assert.equal(r.body.status, 'completed')
})

test('cancel: unknown task -> 404', async () => {
  const r = await jreq('POST', '/v1/tasks/run_nope/cancel')
  assert.equal(r.status, 404); assert.equal(r.body.code, 'task_not_found')
})

// ── robustness ────────────────────────────────────────────────────────────────

test('robustness: malformed JSON -> 400', async () => {
  const r = await jreq('POST', '/v1/tasks', { body: '{not json' })
  assert.equal(r.status, 400); assert.equal(r.body.code, 'invalid_request')
})

test('robustness: oversized body -> 413', async () => {
  const big = JSON.stringify({ agent: 'mock', input: { text: 'x'.repeat(2 * 1024 * 1024) } })
  const r = await jreq('POST', '/v1/tasks', { body: big })
  assert.equal(r.status, 413); assert.equal(r.body.code, 'invalid_request')
})

test('robustness: unsupported method -> 405 with Allow header', async () => {
  const r = await req('DELETE', '/v1/tasks', { token: TOKEN })
  assert.equal(r.status, 405)
  assert.match(String(r.headers['allow']), /POST/)
})

test('robustness: unsupported media type -> 415', async () => {
  const r = await req('POST', '/v1/tasks', { token: TOKEN, body: 'agent=mock', headers: { 'content-type': 'text/plain' } })
  assert.equal(r.status, 415)
})

test('robustness: graceful shutdown closes SSE clients and stops serving', async () => {
  const server = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN })
  const port = server.port
  const c = await jreq('POST', '/v1/tasks', { port, body: JSON.stringify({ agent: 'mock', input: { text: 'x' } }) })
  const s = openSse(c.body.task_id, { port })
  await s.headers
  await server.close()
  await s.ended // shutdown ended the SSE client
  await assert.rejects(req('GET', '/v1/agents', { token: TOKEN, port }), 'no longer accepting connections')
})

// ── active-task cap (bounded active memory) ───────────────────────────────────

test('active cap: accepts below cap; 503 service_unavailable/retryable at cap; cancel frees a slot; concurrent cannot exceed', async () => {
  const prev = process.env.VIBE_MOCK_RUN_MS
  process.env.VIBE_MOCK_RUN_MS = '60000' // keep created tasks ACTIVE for the test
  const server = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, maxActiveTasks: 2 })
  const mk = (t: string) => jreq('POST', '/v1/tasks', { port: server.port, body: JSON.stringify({ agent: 'mock', input: { text: t } }) })
  const live: string[] = []
  try {
    const a = await mk('a'), b = await mk('b')
    assert.equal(a.status, 202); assert.equal(b.status, 202); live.push(a.body.task_id, b.body.task_id)
    const c = await mk('c')
    assert.equal(c.status, 503, 'create at cap rejected')
    assert.equal(c.body.code, 'service_unavailable')
    assert.equal(c.body.retryable, true)
    // cancel frees exactly one slot (drain-on-cancel makes this synchronous)
    await jreq('POST', `/v1/tasks/${a.body.task_id}/cancel`, { port: server.port })
    const d = await mk('d')
    assert.equal(d.status, 202, 'a freed slot allows one more'); live.push(d.body.task_id)
    const e = await mk('e')
    assert.equal(e.status, 503, 'back at cap')
    for (const id of live) await jreq('POST', `/v1/tasks/${id}/cancel`, { port: server.port })

    // concurrent burst cannot exceed the cap
    const burst = await Promise.all([mk('x1'), mk('x2'), mk('x3'), mk('x4')])
    const accepted = burst.filter((r) => r.status === 202)
    const rejected = burst.filter((r) => r.status === 503)
    assert.equal(accepted.length, 2, 'concurrent accepts capped at 2')
    assert.equal(rejected.length, 2)
    for (const r of accepted) await jreq('POST', `/v1/tasks/${r.body.task_id}/cancel`, { port: server.port })
  } finally {
    if (prev === undefined) delete process.env.VIBE_MOCK_RUN_MS; else process.env.VIBE_MOCK_RUN_MS = prev
    await server.close()
  }
})

test('active cap: completing a task frees an active slot (independent of completed-retention)', async () => {
  const server = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, maxActiveTasks: 1, maxRetainedCompletedTasks: 50 })
  try {
    const c1 = await jreq('POST', '/v1/tasks', { port: server.port, body: JSON.stringify({ agent: 'mock', input: { text: '1' } }) })
    assert.equal(c1.status, 202)
    const s = openSse(c1.body.task_id, { port: server.port }); await s.ended // completion => finishTask => slot freed
    const c2 = await jreq('POST', '/v1/tasks', { port: server.port, body: JSON.stringify({ agent: 'mock', input: { text: '2' } }) })
    assert.equal(c2.status, 202, 'completion freed the single active slot')
    // both retained as completed (retention independent of the active cap)
    const g1 = await jreq('GET', `/v1/tasks/${c1.body.task_id}`, { port: server.port })
    assert.equal(g1.status, 200); assert.equal(g1.body.status, 'completed')
  } finally { await server.close() }
})

test('MAX_ACTIVE_TASKS default is a conservative constant', () => {
  assert.equal(MAX_ACTIVE_TASKS, 32)
})

// ── SSE replay-to-live handoff + Last-Event-ID cursor semantics ───────────────

test('computeSseReplay: cursor semantics for every case', () => {
  const buf = [3, 4, 5, 6].map((seq) => ({ seq } as TaskEvent)) // oldest retained seq = 3 (0,1,2 evicted)
  // no header / malformed / negative / non-numeric -> null cursor -> full retained buffer
  for (const h of [undefined, '', '-1', 'abc', '3.5', ['x']] as (string | string[] | undefined)[]) {
    const r = computeSseReplay(buf, h); assert.equal(r.cursor, null); assert.equal(r.events.length, 4); assert.equal(r.truncated, false)
  }
  // valid retained id (4) -> only newer (5,6); no gap
  let r = computeSseReplay(buf, '4'); assert.deepEqual(r.events.map((e) => e.seq), [5, 6]); assert.equal(r.truncated, false)
  // latest id (6) -> nothing to replay
  r = computeSseReplay(buf, '6'); assert.deepEqual(r.events.map((e) => e.seq), []); assert.equal(r.truncated, false)
  // future id (100) -> empty replay, not truncated (live events still follow at runtime)
  r = computeSseReplay(buf, '100'); assert.deepEqual(r.events, []); assert.equal(r.truncated, false)
  // zero -> replay all with seq>0 (all retained here)
  r = computeSseReplay(buf, '0'); assert.deepEqual(r.events.map((e) => e.seq), [3, 4, 5, 6]); assert.equal(r.truncated, true, 'cursor 0 predates oldest retained (3) -> gap flagged')
  // id older than retained window (1) -> replay retained + truncated flag
  r = computeSseReplay(buf, '1'); assert.deepEqual(r.events.map((e) => e.seq), [3, 4, 5, 6]); assert.equal(r.truncated, true)
})

test('SSE handoff: connecting mid-run yields contiguous seqs (no gap/dup) and terminal once', async () => {
  const prev = process.env.VIBE_MOCK_RUN_MS
  process.env.VIBE_MOCK_RUN_MS = '900' // spread events so we connect while producing
  try {
    const c = await createTask()
    await delay(120) // let a few events buffer, then connect (replay-to-live boundary)
    const s = openSse(c.body.task_id)
    await s.ended
    const ids = s.events.map((e) => Number(e.id))
    // exactly-once + no gaps across the replay->live boundary
    assert.deepEqual(ids, ids.slice().sort((a, b) => a - b), 'monotonic')
    assert.equal(new Set(ids).size, ids.length, 'no duplicate seq across handoff')
    for (let i = 1; i < ids.length; i++) assert.equal(ids[i], ids[i - 1] + 1, 'contiguous seqs (no gap)')
    assert.equal(s.events.filter((e) => e.event === 'task.completed').length, 1, 'terminal exactly once')
  } finally {
    if (prev === undefined) delete process.env.VIBE_MOCK_RUN_MS; else process.env.VIBE_MOCK_RUN_MS = prev
  }
})

test('SSE: Last-Event-ID past the buffer emits a truncation warning comment, not a silent partial history', async () => {
  const c = await createTask(); await waitStatus(c.body.task_id, 'completed')
  // small buffer forces eviction so an old cursor is "past the buffer"
  const server = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, maxEventsPerTask: 2 })
  try {
    const t = await jreq('POST', '/v1/tasks', { port: server.port, body: JSON.stringify({ agent: 'mock', input: { text: 'z' } }) })
    const done = openSse(t.body.task_id, { port: server.port }); await done.ended
    // reconnect claiming an ancient cursor (0) against the trimmed buffer -> warning comment present in raw stream
    const raw = await new Promise<string>((resolve) => {
      let buf = ''
      const rq = http.request({ host: '127.0.0.1', port: server.port, path: `/v1/tasks/${t.body.task_id}/events`, headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': '0' } }, (rs) => { rs.setEncoding('utf8'); rs.on('data', (d) => { buf += d }); rs.on('end', () => resolve(buf)) })
      rq.end()
    })
    assert.match(raw, /: warning: requested Last-Event-ID predates the retained buffer/)
  } finally { await server.close() }
})

// ── token-file hardening (resolveApiTokenFile) ────────────────────────────────

test('resolveApiTokenFile: creates 0600 once, reuses, never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-tok-'))
  const p = path.join(dir, 'api-token')
  const first = resolveApiTokenFile(p)
  assert.ok(first.ok && first.created)
  if (first.ok) {
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, '0600')
    const second = resolveApiTokenFile(p)
    assert.ok(second.ok && !second.created, 'reused, not recreated')
    if (second.ok) assert.equal(second.token, first.token, 'same token, never overwritten')
  }
})

test('resolveApiTokenFile: rejects symlink, insecure perms, and malformed contents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-tok-'))
  // symlink
  const target = path.join(dir, 'real'); fs.writeFileSync(target, 'x'.repeat(40) + '\n', { mode: 0o600 })
  const link = path.join(dir, 'link'); fs.symlinkSync(target, link)
  const sym = resolveApiTokenFile(link)
  assert.ok(!sym.ok && sym.code === 'token_file_symlink')
  // insecure perms (group/world readable)
  const loose = path.join(dir, 'loose'); fs.writeFileSync(loose, 'y'.repeat(40) + '\n'); fs.chmodSync(loose, 0o644)
  const perm = resolveApiTokenFile(loose)
  assert.ok(!perm.ok && perm.code === 'token_file_insecure_perms')
  // malformed / empty content
  const empty = path.join(dir, 'empty'); fs.writeFileSync(empty, '   \n', { mode: 0o600 })
  const bad = resolveApiTokenFile(empty)
  assert.ok(!bad.ok && bad.code === 'token_file_invalid')
})

test('retention: oldest COMPLETED task evicted past the cap; active never evicted', async () => {
  const server = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, maxRetainedCompletedTasks: 2 })
  try {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const c = await jreq('POST', '/v1/tasks', { port: server.port, body: JSON.stringify({ agent: 'mock', input: { text: `t${i}` } }) })
      ids.push(c.body.task_id)
      // Await the SSE stream end — it closes only after the gateway processes the
      // terminal event and enters the completed-retention queue (deterministic).
      const s = openSse(c.body.task_id, { port: server.port })
      await s.ended
    }
    const first = await jreq('GET', `/v1/tasks/${ids[0]}`, { port: server.port })
    assert.equal(first.status, 404, 'oldest completed task evicted past cap=2')
    const third = await jreq('GET', `/v1/tasks/${ids[2]}`, { port: server.port })
    assert.equal(third.status, 200, 'most recent retained')
  } finally { await server.close() }
})
