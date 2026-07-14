/**
 * Vibe Agent Gateway MCP server — tested against a FAKE in-process gateway HTTP
 * server (the MCP server is a pure client). Covers config/security, tool schemas,
 * every tool, canonical-error mapping, the bounded event-poll model, and the stdio
 * JSON-RPC protocol. No relay/node involved.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { GatewayClient, readGatewayToken, isLoopbackGatewayUrl, summarizeDeltaEvents, OUTPUT_PREVIEW_MAX_CHARS } from '../src/mcp/gateway-client.js'
import { createMcpServer } from '../src/mcp/server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TOKEN = 'mcp-tok-' + 'a'.repeat(40)
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── fake gateway ──────────────────────────────────────────────────────────────

interface FakeTask { task: any; events: Array<{ seq: number; type: string; data: unknown }>; terminal: boolean; failWait?: boolean }
function ev(seq: number, type: string, text?: string): { seq: number; type: string; data: unknown } {
  const data: any = { seq, task_id: 'run', type, ts: 't', contract_version: 1 }
  if (text !== undefined) data.payload = { stream: 'stdout', text }
  return { seq, type, data }
}

let server: http.Server
let PORT = 0
let cancelCount = 0
const tasks = new Map<string, FakeTask>()
const openStreams = new Set<http.ServerResponse>()
let taskN = 0

function sendJson(res: http.ServerResponse, status: number, body: unknown): void { const s = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json' }); res.end(s) }

before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return sendJson(res, 401, { error: true, code: 'unauthorized', message: 'missing or invalid bearer token', retryable: false, ts: 't' })
    const u = new URL(req.url ?? '/', 'http://x'); const parts = u.pathname.split('/').filter(Boolean); const m = req.method ?? 'GET'
    if (parts.join('/') === 'v1/agents' && m === 'GET') return sendJson(res, 200, { agents: [{ id: 'mock', available: true, streaming: true }, { id: 'claude-code', node_id: 'node_x', available: true, streaming: true }] })
    if (parts.join('/') === 'v1/tasks' && m === 'POST') {
      let raw = ''; req.on('data', (d) => { raw += d }); req.on('end', () => {
        let body: any; try { body = JSON.parse(raw) } catch { return sendJson(res, 400, { error: true, code: 'invalid_request', message: 'bad json', retryable: false, ts: 't' }) }
        if (!body.agent || !body.input?.text) return sendJson(res, 400, { error: true, code: 'invalid_request', message: 'agent+input.text required', retryable: false, ts: 't' })
        // mirror the gateway: reject deferred fields if a client somehow sent them
        if (body.workspace && ('path' in body.workspace || 'repo_url' in body.workspace || 'branch' in body.workspace)) return sendJson(res, 400, { error: true, code: 'invalid_request', message: 'deferred workspace field', retryable: false, ts: 't' })
        if (body.execution && 'timeout_seconds' in body.execution) return sendJson(res, 400, { error: true, code: 'invalid_request', message: 'deferred execution field', retryable: false, ts: 't' })
        const id = `run_${++taskN}`
        const text: string = body.input.text
        // Marker-driven fixtures. `terminal` = whether the SSE ENDS after replay
        // (i.e. the stream closes); `status` = the authoritative GET status. A task
        // can end its stream WITHOUT a terminal EVENT (GET* markers).
        let events: Array<{ seq: number; type: string; data: unknown }>; let status: string; let terminal: boolean
        if (text.includes('TRUNCATE')) { events = [ev(5, 'agent.output.delta'), ev(6, 'task.completed')]; status = 'completed'; terminal = true }
        else if (text.includes('RESUME')) { events = [ev(1, 'agent.output.delta'), ev(2, 'agent.output.delta')]; status = 'running'; terminal = false }
        else if (text.includes('RUNNING')) { events = [ev(0, 'task.created'), ev(1, 'task.started')]; status = 'running'; terminal = false }
        else if (text.includes('GETDONE')) { events = [ev(0, 'task.created'), ev(1, 'task.started')]; status = 'completed'; terminal = true } // stream ends, NO terminal event
        else if (text.includes('GETFAILED')) { events = [ev(0, 'task.created'), ev(1, 'task.started')]; status = 'failed'; terminal = true }
        else if (text.includes('GETCANCELLED')) { events = [ev(0, 'task.created'), ev(1, 'task.started')]; status = 'cancelled'; terminal = true }
        else if (text.includes('PREVIEW')) { events = [ev(0, 'task.created'), ev(1, 'agent.output.delta', 'Hello '), ev(2, 'agent.output.delta', 'world'), ev(3, 'task.completed')]; status = 'completed'; terminal = true }
        else if (text.includes('WAITFAIL')) { events = [ev(0, 'task.created')]; status = 'running'; terminal = false } // created OK, but waiting will 500
        else { events = [ev(0, 'task.created'), ev(1, 'task.started'), ev(2, 'agent.output.delta'), ev(3, 'task.completed')]; status = 'completed'; terminal = true }
        const t: FakeTask = { task: { task_id: id, agent: body.agent, node_id: body.node_id, status, contract_version: 1, created_at: 't', updated_at: 't', __forwarded: body }, events, terminal, failWait: text.includes('WAITFAIL') }
        tasks.set(id, t)
        sendJson(res, 202, { task_id: id, agent: body.agent, node_id: body.node_id, status, contract_version: 1, created_at: 't', updated_at: 't' })
      })
      return
    }
    if (parts[0] === 'v1' && parts[1] === 'tasks' && parts.length >= 3) {
      const id = decodeURIComponent(parts[2]); const t = tasks.get(id)
      if (parts.join('/') === 'v1/tasks/nonjson' ) { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('boom') }
      if (!t) return sendJson(res, 404, { error: true, code: 'task_not_found', message: `no such task: ${id}`, task_id: id, retryable: false, ts: 't' })
      // Simulate a task that is created OK but whose subsequent waiting fails.
      if (t.failWait && ((parts.length === 3 && m === 'GET') || (parts.length === 4 && parts[3] === 'events'))) return sendJson(res, 503, { error: true, code: 'service_unavailable', message: 'temporarily unavailable', retryable: true, ts: 't' })
      if (parts.length === 3 && m === 'GET') return sendJson(res, 200, t.task)
      if (parts.length === 4 && parts[3] === 'cancel' && m === 'POST') { cancelCount++; t.task.status = 'cancelled'; t.terminal = true; return sendJson(res, 200, t.task) }
      if (parts.length === 4 && parts[3] === 'events' && m === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.write(': connected\n\n')
        const lastRaw = req.headers['last-event-id']; const lastId = typeof lastRaw === 'string' && /^\d+$/.test(lastRaw) ? Number(lastRaw) : -1
        const toSend = t.events.filter((e) => e.seq > lastId)
        if (t.events.length && t.events[0].seq > lastId + 1) res.write(': warning: requested Last-Event-ID predates the retained buffer; replaying from the oldest retained event\n\n')
        for (const e of toSend) res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
        if (t.terminal) res.end()
        else { openStreams.add(res); req.on('close', () => openStreams.delete(res)) }
        return
      }
    }
    sendJson(res, 404, { error: true, code: 'task_not_found', message: 'not found', retryable: false, ts: 't' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  PORT = (server.address() as { port: number }).port
})
after(async () => { for (const s of openStreams) try { s.end() } catch { /* */ } ; await new Promise<void>((r) => server.close(() => r())) })

const client = () => new GatewayClient(`http://127.0.0.1:${PORT}`, TOKEN, 3000)
const srv = () => createMcpServer(client(), '0.1.0')
const call = (name: string, args: Record<string, unknown> = {}) => srv().handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
const parseResult = (resp: any) => JSON.parse(resp.result.content[0].text)

// ── config / security ─────────────────────────────────────────────────────────

test('isLoopbackGatewayUrl', () => {
  for (const u of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) assert.ok(isLoopbackGatewayUrl(u), u)
  for (const u of ['http://192.168.1.5:8787', 'http://example.com', 'not a url']) assert.ok(!isLoopbackGatewayUrl(u), u)
})

test('readGatewayToken: accepts 0600 file; rejects missing/symlink/insecure/empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tok-'))
  const good = path.join(dir, 'tok'); fs.writeFileSync(good, TOKEN + '\n', { mode: 0o600 })
  const r = readGatewayToken(good); assert.ok(r.ok && r.token === TOKEN)
  assert.equal(readGatewayToken(path.join(dir, 'nope')).ok, false)
  const link = path.join(dir, 'link'); fs.symlinkSync(good, link); assert.equal((readGatewayToken(link) as any).code, 'token_file_symlink')
  const loose = path.join(dir, 'loose'); fs.writeFileSync(loose, TOKEN); fs.chmodSync(loose, 0o644); assert.equal((readGatewayToken(loose) as any).code, 'token_file_insecure_perms')
  const empty = path.join(dir, 'empty'); fs.writeFileSync(empty, '  \n', { mode: 0o600 }); assert.equal((readGatewayToken(empty) as any).code, 'token_file_invalid')
})

test('client: bounded HTTP timeout maps to a structured gateway_timeout (no hang)', async () => {
  // a black-hole server that accepts but never responds
  const hole = http.createServer(() => { /* never responds */ })
  await new Promise<void>((r) => hole.listen(0, '127.0.0.1', () => r()))
  const p = (hole.address() as { port: number }).port
  const c = new GatewayClient(`http://127.0.0.1:${p}`, TOKEN, 300)
  const res = await createMcpServer(c, '0.1.0').handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vibe_list_agents' } })
  const body = parseResult(res)
  assert.equal(body.error, true); assert.equal(body.code, 'gateway_timeout')
  await new Promise<void>((r) => hole.close(() => r()))
})

test('client: malformed (non-JSON 500) gateway response handled safely', async () => {
  const res = await srv().handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vibe_get_task', arguments: { task_id: 'nonjson' } } })
  const body = parseResult(res); assert.equal(body.error, true); assert.equal(body.code, 'gateway_error'); assert.equal(body.http_status, 500)
})

// ── protocol ────────────────────────────────────────────────────────────────

test('protocol: initialize negotiates version (prefers 2025-11-25) + declares tools capability', async () => {
  // every explicitly-requested SUPPORTED version is echoed back
  for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
    const r: any = await srv().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {} } })
    assert.equal(r.result.protocolVersion, v, `echo ${v}`)
  }
  const r0: any = await srv().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })
  assert.ok(r0.result.capabilities.tools); assert.equal(r0.result.serverInfo.name, 'vibe-agent-gateway')
  // unknown/future version -> negotiate DOWN to the preferred supported version
  const unknown: any = await srv().handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } })
  assert.equal(unknown.result.protocolVersion, '2025-11-25')
  const missing: any = await srv().handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
  assert.equal(missing.result.protocolVersion, '2025-11-25')
  assert.equal(await srv().handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null) // notification → no response
  const nf: any = await srv().handle({ jsonrpc: '2.0', id: 3, method: 'nope/nope' })
  assert.equal(nf.error.code, -32601)
})

test('protocol: tools/list has exact names, no deferred fields, cancel marked destructive', async () => {
  const r: any = await srv().handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const names = r.result.tools.map((t: any) => t.name).sort()
  assert.deepEqual(names, ['vibe_cancel_task', 'vibe_get_task', 'vibe_get_task_events', 'vibe_list_agents', 'vibe_run_task', 'vibe_start_task', 'vibe_wait_task'])
  for (const toolName of ['vibe_start_task', 'vibe_run_task']) {
    const tl = r.result.tools.find((t: any) => t.name === toolName)
    for (const deferred of ['path', 'repo_url', 'branch', 'timeout_seconds']) assert.ok(!(deferred in tl.inputSchema.properties), `no ${deferred} in ${toolName} schema`)
  }
  const cancel = r.result.tools.find((t: any) => t.name === 'vibe_cancel_task')
  assert.ok(cancel.annotations?.destructiveHint === true)
  assert.match(cancel.description, /DESTRUCTIVE/)
})

// ── tools ─────────────────────────────────────────────────────────────────────

test('vibe_list_agents returns the gateway agent list', async () => {
  const body = parseResult(await call('vibe_list_agents'))
  assert.deepEqual(body.agents.map((a: any) => a.id).sort(), ['claude-code', 'mock'])
})

test('vibe_start_task: local mock + remote-shaped payload; forwards ONLY supported fields', async () => {
  const local = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'hi' }))
  assert.ok(typeof local.task.task_id === 'string' && ['queued', 'running', 'completed'].includes(local.task.status))
  const remote = parseResult(await call('vibe_start_task', { agent: 'claude-code', node_id: 'node_x', input_text: 'RUNNING task', workspace_key: 'safe.key-1', permission_mode: 'default', metadata: { a: 1 } }))
  assert.equal(remote.task.node_id, 'node_x')
  // the gateway saw only supported fields (no path/repo_url/branch/timeout_seconds)
  const fwd = tasks.get(remote.task.task_id)!.task.__forwarded
  assert.deepEqual(Object.keys(fwd.workspace ?? {}), ['workspace_key'])
  assert.ok(!('path' in (fwd.workspace ?? {})) && !fwd.repo_url && !fwd.branch)
  assert.deepEqual(Object.keys(fwd.execution ?? {}), ['permission_mode'])
})

test('vibe_start_task: invalid args rejected without calling the gateway', async () => {
  assert.equal(parseResult(await call('vibe_start_task', { input_text: 'x' })).code, 'invalid_request') // missing agent
  assert.equal(parseResult(await call('vibe_start_task', { agent: 'mock' })).code, 'invalid_request') // missing input_text
  assert.equal(parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'x', permission_mode: 'wild' })).code, 'invalid_request')
})

test('vibe_get_task returns the canonical task; unknown -> task_not_found', async () => {
  const t = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'ok' }))
  const got = parseResult(await call('vibe_get_task', { task_id: t.task.task_id }))
  assert.equal(got.status, 'completed')
  const nf = parseResult(await call('vibe_get_task', { task_id: 'run_missing' }))
  assert.equal(nf.error, true); assert.equal(nf.code, 'task_not_found')
})

test('vibe_get_task_events: ordered events after cursor, terminal-once, next_event_id; no dup at boundary', async () => {
  const t = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'ok' }))
  const all = parseResult(await call('vibe_get_task_events', { task_id: t.task.task_id, wait_seconds: 2 }))
  assert.deepEqual(all.events.map((e: any) => e.seq), [0, 1, 2, 3])
  assert.equal(all.terminal, true); assert.equal(all.ended_by, 'terminal'); assert.equal(all.next_event_id, 3) // resume cursor = greatest consumed id (NOT next id)
  const after = parseResult(await call('vibe_get_task_events', { task_id: t.task.task_id, after_event_id: 1, wait_seconds: 2 }))
  assert.deepEqual(after.events.map((e: any) => e.seq), [2, 3]) // seq 1 not duplicated at the boundary
  assert.equal(after.next_event_id, 3)
})

test('vibe_get_task_events: bounded wait TIMES OUT on a running task and NEVER cancels', async () => {
  const before = cancelCount
  const t = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'RUNNING please' }))
  const r = parseResult(await call('vibe_get_task_events', { task_id: t.task.task_id, wait_seconds: 0.5 })) // min window
  assert.deepEqual(r.events.map((e: any) => e.seq), [0, 1])
  assert.equal(r.terminal, false); assert.equal(r.ended_by, 'timeout')
  assert.equal(cancelCount, before, 'a bounded-wait timeout must NOT cancel the task')
})

test('vibe_get_task_events: gateway replay truncation is surfaced with a safe cursor', async () => {
  const t = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'TRUNCATE me' }))
  const r = parseResult(await call('vibe_get_task_events', { task_id: t.task.task_id, after_event_id: 0, wait_seconds: 2 }))
  assert.equal(r.truncated, true)
  assert.deepEqual(r.events.map((e: any) => e.seq), [5, 6])
  assert.equal(r.next_event_id, 6) // greatest consumed -> a safe, usable resume cursor
})

test('cursor: resume across polls — no gap, no duplicate; timeout preserves the cursor (item 1)', async () => {
  const id = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'RESUME me' })).task.task_id
  const p1 = parseResult(await call('vibe_get_task_events', { task_id: id, wait_seconds: 0.5 }))
  assert.deepEqual(p1.events.map((e: any) => e.seq), [1, 2])
  assert.equal(p1.next_event_id, 2)            // cursor = greatest CONSUMED id
  assert.equal(p1.terminal, false); assert.equal(p1.ended_by, 'timeout')
  tasks.get(id)!.events.push(ev(3, 'agent.output.delta')) // ID 3 emitted between calls
  const p2 = parseResult(await call('vibe_get_task_events', { task_id: id, after_event_id: p1.next_event_id, wait_seconds: 0.5 }))
  assert.deepEqual(p2.events.map((e: any) => e.seq), [3]) // strictly > cursor 2; ID 2 not duplicated
  assert.equal(p2.next_event_id, 3)
  const p3 = parseResult(await call('vibe_get_task_events', { task_id: id, after_event_id: p2.next_event_id, wait_seconds: 0.5 }))
  assert.deepEqual(p3.events, [])              // no new events
  assert.equal(p3.next_event_id, 3)           // timeout preserves the caller's cursor
  assert.deepEqual([...p1.events, ...p2.events, ...p3.events].map((e: any) => e.seq), [1, 2, 3]) // no gap/dup overall
})

test('wait_seconds validation: rejects out-of-range; accepts 0.5 and 30 (item 4)', async () => {
  const done = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'ok' })).task.task_id
  for (const w of [0, 0.49, 30.01, 31, -1, Number.NaN, Number.POSITIVE_INFINITY, 'x', null]) {
    const r = parseResult(await call('vibe_get_task_events', { task_id: done, wait_seconds: w as unknown as number }))
    assert.equal(r.error, true, `reject wait_seconds=${String(w)}`); assert.equal(r.code, 'invalid_request')
  }
  // boundaries accepted; a done task returns immediately so no real 30s wait
  assert.equal(parseResult(await call('vibe_get_task_events', { task_id: done, wait_seconds: 0.5 })).terminal, true)
  assert.equal(parseResult(await call('vibe_get_task_events', { task_id: done, wait_seconds: 30 })).terminal, true)
})

test('terminal reconciliation: authoritative Task status decides terminal, no fabricated event (item 5)', async () => {
  for (const [marker, expected] of [['GETDONE', 'completed'], ['GETFAILED', 'failed'], ['GETCANCELLED', 'cancelled']] as const) {
    const id = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: marker })).task.task_id
    const r = parseResult(await call('vibe_get_task_events', { task_id: id, wait_seconds: 2 }))
    assert.equal(r.terminal, true, `${marker} -> terminal`); assert.equal(r.ended_by, 'terminal'); assert.equal(r.task.status, expected)
    assert.ok(!r.events.some((e: any) => ['task.completed', 'task.failed', 'task.cancelled'].includes(e.type)), 'no terminal event fabricated into events')
  }
  const runId = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'RUNNING' })).task.task_id
  const rr = parseResult(await call('vibe_get_task_events', { task_id: runId, wait_seconds: 0.5 }))
  assert.equal(rr.terminal, false); assert.equal(rr.ended_by, 'timeout') // GET running after timeout
  const doneId = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'ok' })).task.task_id
  const dr = parseResult(await call('vibe_get_task_events', { task_id: doneId, wait_seconds: 2 }))
  assert.equal(dr.terminal, true); assert.equal(dr.ended_by, 'terminal') // SSE terminal + GET terminal consistent
})

// ── vibe_run_task / vibe_wait_task workflows (PR #57) ──────────────────────────

test('vibe_run_task: completes within budget -> authoritative terminal Task + ordered events', async () => {
  const r = parseResult(await call('vibe_run_task', { agent: 'mock', input_text: 'ok', wait_seconds: 3 }))
  assert.equal(r.terminal, true); assert.equal(r.ended_by, 'terminal'); assert.equal(r.task.status, 'completed')
  assert.deepEqual(r.events.map((e: any) => e.seq), [0, 1, 2, 3]) // ordered canonical events
})

test('vibe_run_task: budget expires -> still running, task_id + usable resume cursor, NO auto-cancel', async () => {
  const before = cancelCount
  const r = parseResult(await call('vibe_run_task', { agent: 'mock', input_text: 'RUNNING long', wait_seconds: 0.5 }))
  assert.equal(r.terminal, false); assert.equal(r.ended_by, 'timeout')
  assert.equal(typeof r.task_id, 'string')
  assert.deepEqual(r.events.map((e: any) => e.seq), [0, 1])
  assert.equal(r.next_event_id, 1) // usable resume cursor
  assert.equal(r.resume.tool, 'vibe_wait_task'); assert.equal(r.resume.arguments.after_event_id, 1)
  assert.equal(cancelCount, before, 'a wait-budget timeout must NOT cancel the task')
})

test('vibe_run_task: creation ok but waiting fails -> task_id preserved, may still run, NO auto-cancel', async () => {
  const before = cancelCount
  const res: any = await call('vibe_run_task', { agent: 'mock', input_text: 'WAITFAIL', wait_seconds: 2 })
  assert.equal(res.result.isError, true)
  const r = JSON.parse(res.result.content[0].text)
  assert.equal(typeof r.task_id, 'string')        // created id preserved
  assert.equal(r.terminal, false)
  assert.equal(r.code, 'service_unavailable')      // canonical (retryable) error preserved, distinguishable
  assert.match(r.note, /still|running/i)
  assert.equal(r.resume.tool, 'vibe_wait_task')
  assert.equal(cancelCount, before, 'a post-creation wait failure must NOT cancel the created task')
})

test('vibe_run_task: bounded output_preview aggregated ONLY from delta events (+ truncation)', async () => {
  const r = parseResult(await call('vibe_run_task', { agent: 'mock', input_text: 'PREVIEW please', wait_seconds: 3 }))
  assert.equal(r.terminal, true)
  assert.equal(r.output_preview, 'Hello world')   // only delta text, in order, nothing invented
  assert.equal(r.output_preview_truncated, false)
  assert.deepEqual(r.events.map((e: any) => e.seq), [0, 1, 2, 3]) // canonical events NOT discarded
  // aggregation is bounded and marks truncation
  const big = [ev(1, 'agent.output.delta', 'x'.repeat(10)).data, ev(2, 'agent.output.delta', 'y'.repeat(10)).data]
  const s = summarizeDeltaEvents(big, 15)
  assert.equal(s.preview!.length, 15); assert.equal(s.truncated, true)
  assert.equal(summarizeDeltaEvents([ev(1, 'task.started').data], OUTPUT_PREVIEW_MAX_CHARS).preview, undefined) // no delta -> no preview
})

test('vibe_wait_task: resumes from cursor with no gap/dup; no-new-event timeout preserves cursor', async () => {
  const id = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'RESUME me' })).task.task_id
  const p1 = parseResult(await call('vibe_wait_task', { task_id: id, wait_seconds: 0.5 }))
  assert.deepEqual(p1.events.map((e: any) => e.seq), [1, 2]); assert.equal(p1.next_event_id, 2); assert.equal(p1.terminal, false)
  tasks.get(id)!.events.push(ev(3, 'agent.output.delta')) // new event between calls
  const p2 = parseResult(await call('vibe_wait_task', { task_id: id, after_event_id: p1.next_event_id, wait_seconds: 0.5 }))
  assert.deepEqual(p2.events.map((e: any) => e.seq), [3]); assert.equal(p2.next_event_id, 3) // strictly after cursor 2, no dup
  const p3 = parseResult(await call('vibe_wait_task', { task_id: id, after_event_id: p2.next_event_id, wait_seconds: 0.5 }))
  assert.deepEqual(p3.events, []); assert.equal(p3.next_event_id, 3) // no new event -> cursor preserved
})

test('vibe_wait_task: terminal via SSE AND terminal only via authoritative GET (no fabricated event)', async () => {
  const sseId = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'ok' })).task.task_id
  const a = parseResult(await call('vibe_wait_task', { task_id: sseId, wait_seconds: 2 }))
  assert.equal(a.terminal, true); assert.equal(a.ended_by, 'terminal'); assert.equal(a.task.status, 'completed')
  const getId = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'GETDONE' })).task.task_id
  const b = parseResult(await call('vibe_wait_task', { task_id: getId, wait_seconds: 2 }))
  assert.equal(b.terminal, true); assert.equal(b.ended_by, 'terminal'); assert.equal(b.task.status, 'completed')
  assert.ok(!b.events.some((e: any) => ['task.completed', 'task.failed', 'task.cancelled'].includes(e.type)), 'no terminal event fabricated')
})

test('vibe_wait_task: truncated replay surfaced; unknown task -> task_not_found', async () => {
  const tid = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'TRUNCATE me' })).task.task_id
  const r = parseResult(await call('vibe_wait_task', { task_id: tid, after_event_id: 0, wait_seconds: 2 }))
  assert.equal(r.truncated, true); assert.equal(r.next_event_id, 6)
  const nf = parseResult(await call('vibe_wait_task', { task_id: 'run_missing', wait_seconds: 2 }))
  assert.equal(nf.error, true); assert.equal(nf.code, 'task_not_found')
})

test('vibe_wait_task: repeated calls eventually complete (running -> terminal between calls)', async () => {
  const id = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'RUNNING then done' })).task.task_id
  const first = parseResult(await call('vibe_wait_task', { task_id: id, wait_seconds: 0.5 }))
  assert.equal(first.terminal, false)
  const t = tasks.get(id)!; t.events.push(ev(2, 'task.completed')); t.task.status = 'completed'; t.terminal = true
  const second = parseResult(await call('vibe_wait_task', { task_id: id, after_event_id: first.next_event_id, wait_seconds: 2 }))
  assert.equal(second.terminal, true); assert.equal(second.ended_by, 'terminal')
  assert.deepEqual(second.events.map((e: any) => e.seq), [2]) // resumed strictly after the cursor
})

test('overall deadline: workflow wait is bounded by the budget (not 30s) + rejects out-of-range wait_seconds', async () => {
  const id = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'RUNNING forever' })).task.task_id
  const t0 = Date.now()
  const r = parseResult(await call('vibe_wait_task', { task_id: id, wait_seconds: 1 }))
  const elapsed = Date.now() - t0
  assert.equal(r.terminal, false)
  assert.ok(elapsed >= 900 && elapsed < 8000, `bounded by overall deadline (~1s, not 30s): ${elapsed}ms`)
  // min/max validation on BOTH workflow tools — reject (do NOT clamp); max is 120
  for (const w of [0, 0.49, 120.01, 121, -1, Number.NaN, Number.POSITIVE_INFINITY, 'x', null]) {
    assert.equal(parseResult(await call('vibe_wait_task', { task_id: id, wait_seconds: w as unknown as number })).code, 'invalid_request', `wait reject ${String(w)}`)
    assert.equal(parseResult(await call('vibe_run_task', { agent: 'mock', input_text: 'ok', wait_seconds: w as unknown as number })).code, 'invalid_request', `run reject ${String(w)}`)
  }
  // boundaries 0.5 and 120 accepted (a done task returns immediately, so no real long wait)
  assert.equal(parseResult(await call('vibe_run_task', { agent: 'mock', input_text: 'ok', wait_seconds: 0.5 })).terminal, true)
  assert.equal(parseResult(await call('vibe_run_task', { agent: 'mock', input_text: 'ok', wait_seconds: 120 })).terminal, true)
})

test('overall deadline: no SSE-subscriber leak after a bounded workflow timeout (abort cleanup)', async () => {
  const id = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'RUNNING leak-check' })).task.task_id
  await call('vibe_wait_task', { task_id: id, wait_seconds: 0.5 })
  await delay(250) // allow the aborted request's 'close' to reach the fake
  assert.equal(openStreams.size, 0, 'aborted SSE subscribers are cleaned up — no listener/stream leak')
})

test('json-rpc validation: jsonrpc/id/method/notifications/unknown/exceptions (item 6)', async () => {
  const s = srv()
  assert.equal((await s.handle({ jsonrpc: '1.0', id: 1, method: 'ping' } as any) as any).error.code, -32600, 'jsonrpc must be 2.0')
  assert.equal((await s.handle({ id: 1, method: 'ping' } as any) as any).error.code, -32600, 'missing jsonrpc')
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'ping' } as any), null, 'no id -> notification, ignored')
  assert.equal(await s.handle({ jsonrpc: '2.0', id: null, method: 'ping' } as any), null, 'null id -> notification, ignored')
  assert.equal((await s.handle({ jsonrpc: '2.0', id: true as any, method: 'ping' }) as any).error.code, -32600, 'non string/number id')
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 1 } as any) as any).error.code, -32600, 'request missing method')
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' }) as any).error.code, -32601, 'unknown method')
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/whatever' } as any), null, 'unknown notification ignored')
  assert.deepEqual((await s.handle({ jsonrpc: '2.0', id: 9, method: 'ping' }) as any).result, {})
  // an unexpected handler exception still resolves the request with -32603
  const s2 = srv(); s2.tools.find((t) => t.name === 'vibe_list_agents')!.handler = async () => { throw new Error('boom') }
  const ex: any = await s2.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'vibe_list_agents' } })
  assert.equal(ex.error.code, -32603); assert.equal(ex.id, 5)
})

test('vibe_cancel_task: cancels and is idempotent; canonical errors mapped', async () => {
  const t = parseResult(await call('vibe_start_task', { agent: 'mock', input_text: 'RUNNING' }))
  const c1 = parseResult(await call('vibe_cancel_task', { task_id: t.task.task_id }))
  assert.equal(c1.status, 'cancelled')
  const c2 = parseResult(await call('vibe_cancel_task', { task_id: t.task.task_id })) // idempotent (gateway owns it)
  assert.equal(c2.status, 'cancelled')
  const nf = parseResult(await call('vibe_cancel_task', { task_id: 'run_missing' }))
  assert.equal(nf.code, 'task_not_found')
})

test('canonical gateway errors: 401 -> unauthorized isError tool result', async () => {
  const bad = new GatewayClient(`http://127.0.0.1:${PORT}`, 'wrong-token-aaaaaaaaaaaaaaaa', 3000)
  const res: any = await createMcpServer(bad, '0.1.0').handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vibe_list_agents' } })
  assert.equal(res.result.isError, true)
  const body = JSON.parse(res.result.content[0].text)
  assert.equal(body.code, 'unauthorized'); assert.equal(body.http_status, 401)
})

// ── stdio integration: only protocol on stdout; token never leaked ─────────────

test('stdio: CLI serves MCP; initialize/tools/list/tools/call over stdin; no non-protocol stdout; token absent', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cli-'))
  const tf = path.join(dir, 'api-token'); fs.writeFileSync(tf, TOKEN + '\n', { mode: 0o600 })
  const p = spawn(NODE, [CLI, 'mcp', 'serve', '--gateway-url', `http://127.0.0.1:${PORT}`, '--token-file', tf], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''; let err = ''
  p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d })
  const send = (o: unknown) => p.stdin.write(JSON.stringify(o) + '\n')
  await delay(400)
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vibe_list_agents' } })
  await delay(800)
  p.kill('SIGTERM')
  const lines = out.split('\n').filter(Boolean)
  for (const l of lines) { const j = JSON.parse(l); assert.equal(j.jsonrpc, '2.0') } // ONLY protocol JSON on stdout
  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).filter((j: any) => j.id != null).map((j: any) => [j.id, j]))
  assert.equal(byId[1].result.serverInfo.name, 'vibe-agent-gateway')
  assert.equal(byId[2].result.tools.length, 7)
  assert.ok(JSON.parse(byId[3].result.content[0].text).agents.length >= 1)
  assert.ok(!out.includes(TOKEN) && !err.includes(TOKEN), 'token never on stdout/stderr')
})
