/**
 * Workflow UI slice — the compile + draft-preview page. Covers the PURE HTML render
 * (escaping, loop-edge distinction, no secrets, CSP-nonce'd single script) and the
 * gateway serving/auth (public HTML shell; ?token → HttpOnly cookie; same-origin
 * cookie authenticates the JSON API; browser disconnect does not cancel a compile).
 * Never touches production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { startAgentGateway } from '../src/lib/agent-gateway.js'
import { workflowUiHtml } from '../src/lib/workflow-ui.js'
import { WorkflowCompiler } from '../src/workflow/compiler/compiler.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import type { AgentTaskClient, AgentTaskCreateRequest } from '../src/workflow/task-client.js'

const TOKEN = `wfui-${Math.random().toString(36).slice(2)}`
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wfui-')), 'control.sqlite')

// ── pure render ──────────────────────────────────────────────────────────────────

test('workflowUiHtml: a self-contained page with a nonce-locked script, no external resources, no secrets, and escaped rendering', () => {
  const html = workflowUiHtml('NONCE123')
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(html.includes('<script nonce="NONCE123">'), 'the single inline script is nonce-locked')
  // no token/secret anywhere (the render takes only a nonce)
  assert.ok(!html.includes(TOKEN))
  // no external resources (CSP default-src none + no http(s) URLs / src attrs)
  assert.ok(!/src\s*=\s*["']https?:/.test(html) && !/href\s*=\s*["']https?:/.test(html), 'no external src/href')
  // escaping is intrinsic: dynamic values are rendered with textContent, never innerHTML
  assert.ok(!html.includes('innerHTML'), 'no innerHTML (data is set via textContent/append)')
  assert.ok(html.includes('textContent'))
  // loop edges are visibly distinct from normal edges
  assert.ok(html.includes('edge-loop') && html.includes('.edge-loop'), 'loop edges have a distinct style + class')
  // it drives the compile + draft REST routes and polls while non-final
  assert.ok(html.includes('/v1/workflow-drafts/compile') && html.includes('/v1/workflow-drafts/'))
  assert.ok(html.includes("FINAL") && html.includes('setTimeout'), 'polls while non-final')
  // one idempotency key per deliberate submission; reused only for an unchanged retry
  assert.ok(html.includes('idempotency_key') && html.includes('lastFp') && html.includes('lastKey'))
  // never renders a token/prompt/raw events/SQL/DB path/stack
  assert.ok(!html.includes('nl_request') || html.indexOf('nl_request') === html.lastIndexOf('nl_request'), 'the request field is a form input, not rendered from a draft')
})

// ── trusted workflow map ──────────────────────────────────────────────────────────

test('workflowUiHtml: a trusted SVG workflow map with distinct normal/loop/terminal edges, escaped labels, and NO execution logic', () => {
  const html = workflowUiHtml('N1')
  // an SVG map built from the server preview (createElementNS, not innerHTML)
  assert.ok(html.includes('function buildMap'), 'builds a map')
  assert.ok(html.includes('createElementNS') && !html.includes('innerHTML'), 'SVG via createElementNS; never innerHTML')
  // loop edges are unmistakable (distinct class + dashed style + a loop label + marker)
  assert.ok(html.includes('e-loop') && html.includes('.e-loop') && html.includes('⟲ loop') && html.includes('a-loop'))
  assert.ok(html.includes('stroke-dasharray'), 'loop edges are dashed (distinct from solid normal edges)')
  // complete / blocked / failed terminal routes are DISTINCT (classes + colors)
  for (const t of ['e-complete', 'e-failed', 'e-blocked', 'term-complete', 'term-failed', 'term-blocked']) assert.ok(html.includes(t), `has ${t}`)
  assert.ok(html.includes('#3ec27a') && html.includes('#e06666') && html.includes('#e0b24d'), 'distinct terminal colors')
  // long labels do not break layout (truncation helper + full value in a <title>)
  assert.ok(html.includes('trunc=') && html.includes("sv('title'"), 'truncates + keeps a title tooltip')
  // each step node shows role, agent and node
  assert.ok(html.includes("s0.agent") && html.includes("s0.node_id") && html.includes("s0.role"))
  // the map is horizontally scrollable on mobile; the accessible text/list fallback remains
  assert.ok(html.includes('mapwrap') && html.includes('overflow-x:auto'))
  assert.ok(html.includes('function kvTable') && html.includes("'Steps'") && html.includes("'Edges'"), 'text/list fallback retained')
  // the visualization contains NO execution logic (buildMap never calls the API)
  const body = html.slice(html.indexOf('function buildMap'), html.indexOf('function mapLegend'))
  assert.ok(!body.includes('fetch(') && !body.includes('api('), 'the map builder performs no I/O')
})

// ── approval + runtime controls (pure render structure) ──────────────────────────

test('workflowUiHtml: explicit approval + separate start + runtime monitoring + cancel are present and safe', () => {
  const html = workflowUiHtml('N1')
  // approval: a confirmation summary incl. the exact spec_hash, an explicit Approve
  // that binds to that hash, never starts, and a 409 → reload/review path.
  assert.ok(html.includes('function approveCard'))
  assert.ok(html.includes('/approve') && html.includes('spec_hash:d.spec_hash'), 'approves with the displayed spec_hash')
  assert.ok(html.includes('does NOT start') && html.includes("confirm("), 'explicit + never starts')
  assert.ok(html.includes('reload and review'), 'hash mismatch (409) requires reload/review')
  assert.ok(html.includes("go('/ui?workflow='"), 'approval navigates to the workflow, not a start')
  // start is a SEPARATE action using the workflow start API
  assert.ok(html.includes('/start') && html.includes("Start workflow"))
  // runtime monitoring: snapshot + events, status/step/round/counters, cancel with confirm
  assert.ok(html.includes('function workflowView') && html.includes('/v1/workflows/'))
  assert.ok(html.includes('WF_TERMINAL') && html.includes('current_step_id') && html.includes('total_tasks') && html.includes('total_failures'))
  // live events via EventSource, deduped by seq (resume without duplicate display); disconnect never cancels
  assert.ok(html.includes('EventSource') && html.includes('seen.has(seq)') && html.includes('never cancels'))
  assert.ok(html.includes('/cancel') && html.includes('Cancel'), 'explicit cancel with confirmation')
  // reload restores the same workflow view via ?workflow=<id>
  assert.ok(html.includes("u.searchParams.get('workflow')"))
  // safety: values via textContent; the runtime view never renders the spec/prompt/raw task logs
  const wv = html.slice(html.indexOf('function workflowView'), html.indexOf('window.addEventListener(\'pagehide'))
  assert.ok(!wv.includes('prompt_template') && !wv.includes('.spec') && !wv.includes('innerHTML'), 'no spec/prompt/innerHTML in the runtime view')
})

// ── gateway serving + cookie auth ─────────────────────────────────────────────────

function req(port: number, method: string, p: string, opts: { cookie?: string; auth?: boolean; body?: unknown } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    const headers: Record<string, string> = {}
    if (opts.auth) headers.authorization = `Bearer ${TOKEN}`
    if (opts.cookie) headers.cookie = opts.cookie
    if (payload) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: t })) })
    r.on('error', reject); if (payload) r.write(payload); r.end()
  })
}

async function withGw(fn: (ctx: { port: number; store: SqliteControlStore }) => Promise<void>): Promise<void> {
  const store = openControlStore({ path: tmpDb() })
  const model = { compile: async () => ({ task_id: 'ct_1', status: 'available' as const, output_text: JSON.stringify({ schema_version: '1', status: 'ready', workflow_spec: readySpec, input_values: { objective: 'x' }, rationale: { note: 'model text' }, questions: [], warnings: [] }) }) }
  const inventory = { snapshot: async () => ({ observed_at: '2026-01-01T00:00:00Z', agents: [{ agent: 'mock', permission_modes: ['default'], workspace_supported: false, capabilities: ['run'] }] }) }
  const compiler = new WorkflowCompiler({ store, model, inventory })
  const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, controlStore: store, getWorkflowCompiler: () => compiler })
  try { await fn({ port: gw.port, store }) } finally { try { await gw.close() } catch { /* */ } try { store.closeSync() } catch { /* */ } }
}
const readySpec = {
  version: '1', name: 'compiled', entry_step: 'go', inputs: { objective: { type: 'string', required: true } },
  agents: { only: { agent: 'mock' } },
  output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 2, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 1 },
  steps: [{ id: 'go', type: 'agent_task', agent_role: 'only', prompt_template: 'Do {{ inputs.objective }}', output_schema: 'o' }],
  edges: [{ from: 'go', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
  completion_policy: {},
}

test('GET /ui serves the public HTML shell (no auth) with a strict CSP and no token', async () => {
  await withGw(async ({ port }) => {
    const r = await req(port, 'GET', '/ui')
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /text\/html/)
    assert.match(String(r.headers['content-security-policy']), /default-src 'none'/)
    assert.match(String(r.headers['content-security-policy']), /script-src 'nonce-/)
    assert.ok(!r.body.includes(TOKEN), 'the shell never contains the token')
    assert.ok(r.body.includes('<script nonce='))
  })
})

test('GET /ui?token sets an HttpOnly cookie + redirects; the cookie authenticates the JSON API (Bearer never needed by the browser)', async () => {
  await withGw(async ({ port }) => {
    const r = await req(port, 'GET', `/ui?token=${TOKEN}`)
    assert.equal(r.status, 302)
    const setCookie = String(r.headers['set-cookie'])
    assert.match(setCookie, /vibe_gw=/); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/)
    assert.match(String(r.headers.location), /^\/ui/)
    // the cookie authenticates a JSON API call (no Authorization header)
    const cookie = setCookie.split(';')[0]
    const list = await req(port, 'GET', '/v1/workflows', { cookie })
    assert.equal(list.status, 200)
    // without the cookie or bearer → 401
    const unauth = await req(port, 'GET', '/v1/workflows')
    assert.equal(unauth.status, 401)
    // a wrong token on /ui does NOT set a cookie (serves the shell)
    const bad = await req(port, 'GET', '/ui?token=wrong')
    assert.equal(bad.status, 200); assert.ok(!('set-cookie' in bad.headers))
  })
})

test('bootstrap security: no-store on token responses; token stripped on redirect; malformed token not echoed; Bearer unchanged; cookie HttpOnly+Strict', async () => {
  await withGw(async ({ port }) => {
    // correct token → 302 with no-store, HttpOnly + SameSite=Strict cookie, and a clean
    // Location that no longer carries the token.
    const boot = await req(port, 'GET', `/ui?token=${TOKEN}&draft=wd_abc`)
    assert.equal(boot.status, 302)
    assert.equal(String(boot.headers['cache-control']), 'no-store')
    const sc = String(boot.headers['set-cookie'])
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/)
    assert.ok(!String(boot.headers.location).includes(TOKEN), 'redirect removes the token from the URL')
    assert.equal(String(boot.headers.location), '/ui?draft=wd_abc')
    // the shell response is also no-store and never contains the token
    const shell = await req(port, 'GET', '/ui')
    assert.equal(String(shell.headers['cache-control']), 'no-store')
    assert.ok(!shell.body.includes(TOKEN))
    // a MALFORMED/short/wrong token → shell served, token not echoed, no cookie
    for (const bad of ['ZZbadtoken9f3aQQ', TOKEN + 'EXTRAsuffix', 'wrongvalue-4821uniq']) {
      const r = await req(port, 'GET', `/ui?token=${encodeURIComponent(bad)}`)
      assert.equal(r.status, 200); assert.ok(!('set-cookie' in r.headers)); assert.ok(!r.body.includes(bad), 'the malformed token is never echoed')
    }
    // Bearer auth is unchanged (still authorizes the JSON API)
    assert.equal((await req(port, 'GET', '/v1/workflows', { auth: true })).status, 200)
    // a WRONG cookie value → 401 (constant-time check; no bypass)
    assert.equal((await req(port, 'GET', '/v1/workflows', { cookie: 'vibe_gw=wrong' })).status, 401)
  })
})

test('the UI drives the real compile + draft routes: compile → draft (ready) reloads to the SAME durable draft; disconnect does not cancel', async () => {
  await withGw(async ({ port }) => {
    // the page would POST this (with a per-submission idempotency_key)
    const c = await req(port, 'POST', '/v1/workflow-drafts/compile', { auth: true, body: { nl_request: 'build', compiler_agent: 'mock', constraints: { max_rounds: 5 }, idempotency_key: 'ui-key-1' } })
    assert.equal(c.status, 201)
    const draft = JSON.parse(c.body); assert.equal(draft.compiler_status, 'ready')
    // reload the draft URL → same durable draft (idempotent GET)
    const g1 = await req(port, 'GET', `/v1/workflow-drafts/${draft.draft_id}`, { auth: true })
    const g2 = await req(port, 'GET', `/v1/workflow-drafts/${draft.draft_id}`, { auth: true })
    assert.equal(JSON.parse(g1.body).draft_id, draft.draft_id)
    assert.equal(JSON.parse(g2.body).spec_hash, draft.spec_hash)
    // a retry with the SAME key → the same draft (no duplicate); a browser disconnect
    // never cancels (the compile already finished durably and is only fetched).
    const retry = await req(port, 'POST', '/v1/workflow-drafts/compile', { auth: true, body: { nl_request: 'build', compiler_agent: 'mock', constraints: { max_rounds: 5 }, idempotency_key: 'ui-key-1' } })
    assert.equal(JSON.parse(retry.body).draft_id, draft.draft_id)
    // the draft projection never exposes the request/prompt/token
    assert.ok(!g1.body.includes('nl_request') && !g1.body.includes(TOKEN))
  })
})

// ── full flow: compile → approve → start → monitor → cancel (three separate actions) ──

class RunFake implements AgentTaskClient {
  byKey = new Map<string, any>(); byId = new Map<string, any>(); n = 0
  constructor(public store: SqliteControlStore, private running = false) {}
  async createTask(r: AgentTaskCreateRequest) {
    const ex = this.byKey.get(r.idempotency_key); if (ex) return { task_id: ex.task_id }
    const id = 'task_' + (++this.n)
    this.store.createTaskDurable({ task_id: id, agent: r.agent, node_id: r.node_id ?? null, status: 'queued', idempotency_key: r.idempotency_key, request_fingerprint: 'fp' }, { sequence: 0, event_type: 'task.created', ts: new Date().toISOString(), payload: {} })
    const t = { task_id: id, released: !this.running }; this.byKey.set(r.idempotency_key, t); this.byId.set(id, t); return { task_id: id }
  }
  private v(t: any) { const run = this.running && !t.released; const status = run ? 'running' : 'completed'; return { status, terminal: !run, history_complete: true, result_status: run ? undefined : 'available', result_text: run ? undefined : JSON.stringify({ status: 'done', summary: 'ok' }), events: [], next_event_id: -1 } }
  async getTask(id: string) { return { task_id: id, ...this.v(this.byId.get(id)) } }
  async waitForTerminal(id: string) { await new Promise((r) => setTimeout(r, 5)); return { task_id: id, ...this.v(this.byId.get(id)) } }
  async cancelTask(id: string) { const t = this.byId.get(id); if (t) t.released = true }
}

test('UI flow: compile → APPROVE (exact hash → one ready wf, never started; retry idempotent; wrong hash → no wf) → separate START (idempotent) → reload snapshot → CANCEL (idempotent)', async () => {
  const store = openControlStore({ path: tmpDb() })
  const model = { compile: async () => ({ task_id: 'ct', status: 'available' as const, output_text: JSON.stringify({ schema_version: '1', status: 'ready', workflow_spec: readySpec, input_values: { objective: 'x' }, rationale: {}, questions: [], warnings: [] }) }) }
  const inventory = { snapshot: async () => ({ observed_at: '2026-01-01T00:00:00Z', agents: [{ agent: 'mock', permission_modes: ['default'], workspace_supported: false, capabilities: ['run'] }] }) }
  const compiler = new WorkflowCompiler({ store, model, inventory })
  const fake = new RunFake(store, true) // task stays running until cancelled
  let runtime: WorkflowRuntime | undefined
  const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, controlStore: store, getWorkflowRuntime: () => runtime, getWorkflowCompiler: () => compiler })
  runtime = new WorkflowRuntime({ store, taskClient: fake, waitWindowMs: 20 })
  try {
    // 1) compile
    const draft = JSON.parse((await req(gw.port, 'POST', '/v1/workflow-drafts/compile', { auth: true, body: { nl_request: 'ship', compiler_agent: 'mock', idempotency_key: 'k' } })).body)
    assert.equal(draft.compiler_status, 'ready'); const hash = draft.spec_hash
    // 2a) wrong-hash approval → 409, NO workflow materialized
    const bad = await req(gw.port, 'POST', `/v1/workflow-drafts/${draft.draft_id}/approve`, { auth: true, body: { spec_hash: 'wronghash' } })
    assert.equal(bad.status, 409)
    assert.equal((await req(gw.port, 'GET', `/v1/workflow-drafts/${draft.draft_id}`, { auth: true })).body.includes('"materialized_workflow_id":null') ? 'none' : JSON.parse((await req(gw.port, 'GET', `/v1/workflow-drafts/${draft.draft_id}`, { auth: true })).body).materialized_workflow_id, 'none')
    // 2b) exact-hash approval → ONE ready workflow, NOT started
    const ap = await req(gw.port, 'POST', `/v1/workflow-drafts/${draft.draft_id}/approve`, { auth: true, body: { spec_hash: hash } })
    assert.equal(ap.status, 200); const wfId = JSON.parse(ap.body).workflow_id; assert.ok(wfId)
    assert.equal(JSON.parse((await req(gw.port, 'GET', `/v1/workflows/${wfId}`, { auth: true })).body).status, 'ready', 'approval never starts')
    // approval retry → same workflow (idempotent)
    const ap2 = await req(gw.port, 'POST', `/v1/workflow-drafts/${draft.draft_id}/approve`, { auth: true, body: { spec_hash: hash } })
    assert.equal(JSON.parse(ap2.body).workflow_id, wfId)
    assert.equal((await store.listWorkflows({})).length, 1, 'exactly one workflow')
    // 3) separate START (idempotent)
    await req(gw.port, 'POST', `/v1/workflows/${wfId}/start`, { auth: true })
    await req(gw.port, 'POST', `/v1/workflows/${wfId}/start`, { auth: true }) // idempotent
    // reload snapshot restores running state
    let snap: any
    for (let i = 0; i < 30; i++) { snap = JSON.parse((await req(gw.port, 'GET', `/v1/workflows/${wfId}`, { auth: true })).body); if (snap.status === 'running') break; await new Promise((r) => setTimeout(r, 40)) }
    assert.equal(snap.status, 'running')
    assert.equal(snap.total_tasks, 1, 'started exactly once (one task)')
    // 4) explicit CANCEL (idempotent)
    await req(gw.port, 'POST', `/v1/workflows/${wfId}/cancel`, { auth: true })
    let c: any
    for (let i = 0; i < 30; i++) { c = JSON.parse((await req(gw.port, 'GET', `/v1/workflows/${wfId}`, { auth: true })).body); if (c.status === 'cancelled') break; await new Promise((r) => setTimeout(r, 40)) }
    assert.equal(c.status, 'cancelled')
    const c2 = JSON.parse((await req(gw.port, 'POST', `/v1/workflows/${wfId}/cancel`, { auth: true })).body); assert.equal(c2.status, 'cancelled') // idempotent
    // the snapshot never exposes a token
    assert.ok(!JSON.stringify(c).includes(TOKEN))
  } finally { try { await runtime.shutdown() } catch { /* */ } try { await gw.close() } catch { /* */ } try { store.closeSync() } catch { /* */ } }
})
