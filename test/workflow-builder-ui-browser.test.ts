/**
 * BROWSER-LEVEL acceptance for the Builder workspace: the page's ACTUAL client script
 * runs against a REAL in-process gateway (WorkflowBuilderService + WorkflowCompiler)
 * inside a tiny DOM shim (no new dependency). Drives create/open/refresh/send,
 * clarification, ready-for-review, compile_failed, revision-conflict, ambiguous-timeout
 * reconciliation (one stable key, no duplicate turn), pending-disabled, and archive.
 * Asserts durable state via the gateway. Never touches production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { startAgentGateway } from '../src/lib/agent-gateway.js'
import { workflowBuilderUiHtml } from '../src/lib/workflow-builder-ui.js'
import { WorkflowCompiler } from '../src/workflow/compiler/compiler.js'
import { WorkflowBuilderService } from '../src/workflow/builder/service.js'

const TOKEN = `wbbrz-${Math.random().toString(36).slice(2)}`
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wbbrz-')), 'control.sqlite')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const readySpec = (name: string) => ({
  version: '1', name, entry_step: 'go', inputs: { objective: { type: 'string', required: true } },
  agents: { only: { agent: 'mock' } },
  output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 2, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 1 },
  steps: [{ id: 'go', type: 'agent_task', agent_role: 'only', prompt_template: 'Do {{ inputs.objective }}', output_schema: 'o' }],
  edges: [{ from: 'go', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
  completion_policy: {},
})
const readyResult = (name: string) => ({ schema_version: '1', status: 'ready', workflow_spec: readySpec(name), input_values: { objective: 'x' }, rationale: {}, questions: [], warnings: [] })
const clarResult = (qs: string[]) => ({ schema_version: '1', status: 'needs_input', workflow_spec: {}, input_values: {}, rationale: {}, questions: qs, warnings: [] })
const failResult = () => ({ schema_version: '1', status: 'impossible', workflow_spec: {}, input_values: {}, rationale: {}, questions: [], warnings: ['no suitable agent'] })

// ── minimal DOM shim (only what the page uses) ──
function makeDom(base: string) {
  const ids: Record<string, any> = {}
  class N {
    tagName: string; children: any[] = []; attrs: Record<string, string> = {}; listeners: Record<string, Function[]> = {}; _text = ''; style: any = {}; _value = ''; disabled = false
    constructor(tag: string) { this.tagName = (tag || '').toLowerCase() }
    append(...k: any[]) { for (const c of k) if (c != null) this.children.push(c) }
    replaceChildren(...k: any[]) { this.children = []; this.append(...k) }
    set textContent(v: any) { this.children = []; this._text = String(v) }
    get textContent(): string { return this._text + this.children.map((c) => (c && c.textContent != null ? c.textContent : '')).join('') }
    set className(v: string) { this.attrs.class = v } get className() { return this.attrs.class || '' }
    setAttribute(k: string, v: any) { this.attrs[k] = String(v); if (k === 'id') ids[v] = this }
    getAttribute(k: string) { return this.attrs[k] }
    removeAttribute(k: string) { delete this.attrs[k] }
    addEventListener(t: string, fn: Function) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
    dispatch(t: string, ev?: any) { (this.listeners[t] || []).forEach((fn) => fn(ev || { type: t, preventDefault() {} })) }
    click() { this.dispatch('click', { type: 'click', preventDefault() {} }) }
    focus() {}
    set value(v: any) { this._value = String(v) } get value() { return this._value }
    set id(v: string) { this.attrs.id = v; ids[v] = this } get id() { return this.attrs.id }
  }
  const doc: any = {
    createElement: (t: string) => new N(t), createElementNS: (_n: string, t: string) => new N(t),
    createTextNode: (t: any) => ({ textContent: String(t), children: [] }),
    getElementById: (id: string) => ids[id] || null,
  }
  for (const id of ['app', 'status', 'tab-sessions', 'tab-draft']) { const n = new N(id === 'app' ? 'main' : 'button'); n.id = id }
  const winL: Record<string, Function[]> = {}
  const lsMap = new Map<string, string>()
  const win: any = {
    addEventListener(t: string, fn: Function) { (winL[t] = winL[t] || []).push(fn) },
    dispatch(t: string, ev?: any) { (winL[t] || []).forEach((fn) => fn(ev || { type: t })) },
    localStorage: { getItem: (k: string) => (lsMap.has(k) ? lsMap.get(k)! : null), setItem: (k: string, v: any) => { lsMap.set(k, String(v)) }, removeItem: (k: string) => { lsMap.delete(k) } },
  }
  const location: any = { href: base + '/ui/builder' }
  const history: any = { pushState: (_a: any, _b: any, url: string) => { location.href = new URL(url, location.href).href } }
  return { doc, win, location, history, ids }
}
const findText = (root: any, re: RegExp): any => {
  if (!root) return null
  if (typeof root.textContent === 'string' && re.test(root.textContent) && (!root.children || root.children.length <= 3)) return root
  for (const c of root.children || []) { const f = findText(c, re); if (f) return f }
  return null
}
const anyText = (root: any, re: RegExp): boolean => !!findText(root, re)
const findAll = (root: any, pred: (n: any) => boolean, acc: any[] = []): any[] => { if (!root) return acc; if (pred(root)) acc.push(root); for (const c of root.children || []) findAll(c, pred, acc); return acc }
const findTag = (root: any, tag: string): any => {
  if (!root) return null
  if (root.tagName === tag) return root
  for (const c of root.children || []) { const f = findTag(c, tag); if (f) return f }
  return null
}
function extractScript(html: string): string { const m = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html); if (!m) throw new Error('no script'); return m[1] }

interface Boot { store: SqliteControlStore; base: string; dom: ReturnType<typeof makeDom>; model: { result: any }; posts: { count: number; lastBody: any }; sess: { count: number; lastBody: any }; ctl: { intercept: string | null }; agentsCtl: { override: any[] | null }; gwGet: (p: string) => Promise<any>; close: () => Promise<void> }
async function boot(startPath = '/ui/builder', opts: { agents?: any[]; ls?: Record<string, string> } = {}): Promise<Boot> {
  const store = openControlStore({ path: tmpDb() })
  const model = { result: readyResult('draft') as any }
  let n = 0
  const modelClient = { compile: async () => ({ task_id: 'ct' + (++n), status: 'available' as const, output_text: JSON.stringify(model.result) }) }
  const inventory = { snapshot: async () => ({ observed_at: '2026-01-01T00:00:00Z', agents: [{ agent: 'mock', permission_modes: ['default'], workspace_supported: false, capabilities: ['run'] }] }) }
  const compiler = new WorkflowCompiler({ store, model: modelClient, inventory })
  const builder = new WorkflowBuilderService(store, compiler)
  const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, controlStore: store, getWorkflowCompiler: () => compiler, getWorkflowBuilder: () => builder })
  const base = `http://127.0.0.1:${gw.port}`
  const posts = { count: 0, lastBody: null as any }
  const sess = { count: 0, lastBody: null as any }
  const ctl = { intercept: null as string | null } // 'lose-response' | 'conflict'
  const agentsCtl = { override: (opts.agents ?? null) as any[] | null } // scripted /v1/agents inventory (null = real gateway inventory)
  const auth = { authorization: `Bearer ${TOKEN}` }
  const wfetch = async (p: string, fopts: any = {}) => {
    if (agentsCtl.override && p === '/v1/agents' && (!fopts.method || fopts.method === 'GET')) return new Response(JSON.stringify({ agents: agentsCtl.override }), { status: 200, headers: { 'content-type': 'application/json' } })
    const isMsgPost = fopts.method === 'POST' && /\/messages$/.test(p)
    if (fopts.method === 'POST' && /\/v1\/workflow-builder\/sessions$/.test(p)) { sess.count++; try { sess.lastBody = JSON.parse(fopts.body) } catch { /* */ } }
    if (isMsgPost) { posts.count++; try { posts.lastBody = JSON.parse(fopts.body) } catch { /* */ } }
    if (isMsgPost && ctl.intercept === 'conflict') { ctl.intercept = null; return new Response(JSON.stringify({ error: true, code: 'builder_revision_conflict', message: 'stale' }), { status: 409, headers: { 'content-type': 'application/json' } }) }
    if (isMsgPost && ctl.intercept === 'lose-response') { ctl.intercept = null; await fetch(base + p, { ...fopts, headers: { ...(fopts.headers || {}), ...auth } }); throw new Error('simulated lost response') }
    return fetch(base + p, { ...fopts, headers: { ...(fopts.headers || {}), ...auth } })
  }
  const gwGet = async (p: string) => JSON.parse(await (await fetch(base + p, { headers: auth })).text())
  const dom = makeDom(base); dom.location.href = base + startPath
  for (const [k, v] of Object.entries(opts.ls ?? {})) dom.win.localStorage.setItem(k, v)
  const script = extractScript(workflowBuilderUiHtml('nonce'))
  const run = new Function('document', 'window', 'location', 'history', 'crypto', 'fetch', 'EventSource', 'confirm', 'setTimeout', 'clearTimeout', 'URL', 'Response', script)
  run(dom.doc, dom.win, dom.location, dom.history, crypto, wfetch, undefined, () => true, setTimeout, clearTimeout, URL, Response)
  return { store, base, dom, model, posts, sess, ctl, agentsCtl, gwGet, close: async () => { dom.win.dispatch('pagehide'); try { await gw.close() } catch { /* */ } try { store.closeSync() } catch { /* */ } } }
}
const waitUntil = async (fn: () => any, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(30) } throw new Error('timeout') }
const app = (b: Boot) => b.dom.ids['app']
const send = async (b: Boot, text: string) => { const ta = b.dom.ids['composer-input']; ta.value = text; ta.dispatch('input'); await waitUntil(() => b.dom.ids['send-turn']); b.dom.ids['send-turn'].click() }

// 1/2 ─ create + open
test('create a session and open it (durable session appears; conversation view active)', async () => {
  const b = await boot()
  try {
    await waitUntil(() => b.dom.ids['new-session'])
    b.dom.ids['new-session'].click()
    await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    const sid = new URL(b.dom.location.href).searchParams.get('session')!
    assert.ok(sid.startsWith('bs_'))
    const list = await b.gwGet('/v1/workflow-builder/sessions')
    assert.ok(list.sessions.some((s: any) => s.builder_session_id === sid))
    await waitUntil(() => b.dom.ids['composer-input']) // conversation + composer rendered
  } finally { await b.close() }
})

// 3 ─ open existing session after refresh (URL-driven route on a fresh page load)
test('open an existing session after a page refresh (URL-driven route)', async () => {
  const b = await boot('/ui/builder')
  try {
    const created = await (await fetch(b.base + '/v1/workflow-builder/sessions', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{"compiler_agent":"mock","title":"Refreshed"}' })).json() as any
    const sid = created.session.builder_session_id
    const b2 = await bootAt(b, '/ui/builder?session=' + sid) // a brand-new page load at the session URL
    await waitUntil(() => anyText(app(b2.b), /Refreshed/))
    assert.equal(new URL(b2.b.dom.location.href).searchParams.get('session'), sid)
    await b2.b.close()
  } finally { await b.close() }
})
// helper: re-run the page script against the SAME gateway at a new URL (simulates refresh)
async function bootAt(prev: Boot, startPath: string): Promise<{ b: Boot }> {
  const dom = makeDom(prev.base); dom.location.href = prev.base + startPath
  const auth = { authorization: `Bearer ${TOKEN}` }
  const wfetch = async (p: string, opts: any = {}) => fetch(prev.base + p, { ...opts, headers: { ...(opts.headers || {}), ...auth } })
  const script = extractScript(workflowBuilderUiHtml('nonce'))
  const run = new Function('document', 'window', 'location', 'history', 'crypto', 'fetch', 'EventSource', 'confirm', 'setTimeout', 'clearTimeout', 'URL', 'Response', script)
  run(dom.doc, dom.win, dom.location, dom.history, crypto, wfetch, undefined, () => true, setTimeout, clearTimeout, URL, Response)
  return { b: { ...prev, dom, close: async () => { dom.win.dispatch('pagehide') } } as Boot }
}

// 4 ─ send one keyed message with expected_revision
test('send a keyed message with expected_revision → one durable turn (user + assistant)', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    await send(b, 'build a slugify workflow')
    await waitUntil(async () => (await b.gwGet('/v1/workflow-builder/sessions/' + sid)).messages.length >= 2)
    const s = await b.gwGet('/v1/workflow-builder/sessions/' + sid)
    assert.equal(s.messages.filter((m: any) => m.role === 'user').length, 1)
    assert.equal(s.messages.filter((m: any) => m.role === 'assistant').length, 1)
    assert.equal(b.posts.lastBody.expected_revision, 1)          // expected_revision sent
    assert.ok(typeof b.posts.lastBody.idempotency_key === 'string' && b.posts.lastBody.idempotency_key.length > 0)
  } finally { await b.close() }
})

// 5 ─ ambiguous timeout → reconcile with the SAME key, no duplicate turn
test('ambiguous send timeout → reconcile via GET, same idempotency key, exactly one turn', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    b.ctl.intercept = 'lose-response' // server processes the POST but the client loses the response
    await send(b, 'do the thing')
    // the client reconciles (GET) and must NOT submit a second turn
    await waitUntil(async () => (await b.gwGet('/v1/workflow-builder/sessions/' + sid)).messages.length >= 2)
    await sleep(80)
    const s = await b.gwGet('/v1/workflow-builder/sessions/' + sid)
    assert.equal(s.messages.filter((m: any) => m.role === 'user').length, 1, 'exactly one user message (no duplicate)')
    assert.equal(s.messages.filter((m: any) => m.role === 'assistant').length, 1)
    assert.equal(b.posts.count, 1, 'client did not resubmit a second POST after the ambiguous timeout')
  } finally { await b.close() }
})

// 6 ─ pending session → composer disabled + processing visible
test('a pending in-flight turn → composer disabled and processing is visible', async () => {
  const b = await boot()
  try {
    // create a session and leave a pending turn durably (server-side crash window)
    const cs = await (await fetch(b.base + '/v1/workflow-builder/sessions', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{"compiler_agent":"mock"}' })).json() as any
    const sid = cs.session.builder_session_id
    await b.store.appendBuilderUserMessage(sid, { content: 'in flight', turn_key: 'pk1' }) // pending marker set, no completion
    const b2 = await bootAt(b, '/ui/builder?session=' + sid)
    await waitUntil(() => b2.b.dom.ids['composer-input'])
    assert.equal(b2.b.dom.ids['composer-input'].disabled, true, 'composer disabled while processing')
    assert.ok(anyText(app(b2.b), /processing/i), 'processing state is visible')
    await b2.b.close()
  } finally { await b.close() }
})

// 7 ─ clarification_required → question + missing chips + partial draft
test('clarification_required → question shown, missing concepts as chips', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    b.model.result = clarResult(['Which repository?', 'Which node?'])
    await send(b, 'make me something')
    await waitUntil(() => anyText(app(b), /Which repository/))
    assert.ok(anyText(app(b), /Which node/), 'both missing concepts rendered (question + chips)')
    // durable outcome is clarification
    const s = await b.gwGet('/v1/workflow-builder/sessions/' + sid)
    const last = s.messages.filter((m: any) => m.role === 'assistant').slice(-1)[0]
    assert.equal(last.metadata.kind, 'clarification_required')
  } finally { await b.close() }
})

// 8 ─ ready_for_review → review action uses the existing draft id/spec hash
test('ready_for_review → Review action routes to the existing draft (no second draft)', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    b.model.result = readyResult('slugify')
    await send(b, 'build slugify')
    const review = await waitUntil(() => b.dom.ids['review-workflow'])
    const s = await b.gwGet('/v1/workflow-builder/sessions/' + sid)
    const draftId = s.session.current_draft_id
    review.click()
    // routes to the EXISTING draft/approval page with the SAME draft id — never approves/starts
    assert.ok(b.dom.location.href.includes('/ui?draft=' + draftId))
    const draft = await b.gwGet('/v1/workflow-drafts/' + draftId)
    assert.equal(draft.approval_status, 'unapproved')       // review did not approve
    assert.equal(draft.materialized_workflow_id, null)      // nor start
  } finally { await b.close() }
})

// 9 ─ builder_revision_conflict → refresh + preserve composer text
test('builder_revision_conflict → composer text preserved, state refreshed, no lost input', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    b.ctl.intercept = 'conflict'
    await send(b, 'my careful prompt')
    await waitUntil(() => anyText(app(b), /newer turn/i))
    assert.equal(b.dom.ids['composer-input'].value, 'my careful prompt', 'unsent composer text is preserved')
  } finally { await b.close() }
})

// 10 ─ compile_failed → durable failure shown, no crash
test('compile_failed → shown as a durable assistant outcome (not a UI crash)', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    b.model.result = failResult()
    await send(b, 'do the impossible')
    await waitUntil(async () => { const s = await b.gwGet('/v1/workflow-builder/sessions/' + sid); return s.messages.some((m: any) => m.role === 'assistant' && m.metadata.kind === 'compile_failed') })
    assert.ok(anyText(app(b), /could not compile|compile failed/i), 'failure rendered in the conversation/panel')
  } finally { await b.close() }
})

// 11 ─ archive → readable + read-only composer
test('archive → session stays readable and the composer becomes read-only', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    await waitUntil(() => b.dom.ids['archive-session'])
    b.dom.ids['archive-session'].click()
    await waitUntil(async () => (await b.gwGet('/v1/workflow-builder/sessions/' + sid)).session.status === 'archived')
    await waitUntil(() => anyText(app(b), /read-only/i))
    assert.equal(findTag(app(b), 'textarea'), null, 'no composer input in an archived (read-only) session')
    assert.ok(anyText(app(b), /read-only/i), 'archived read-only state shown')
  } finally { await b.close() }
})

// 12 ─ narrow layout drawer toggles present + composer reachable (behavioral)
test('narrow layout: sidebar/draft drawer toggles exist and the composer remains present', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    await waitUntil(() => b.dom.ids['composer-input'])
    assert.ok(b.dom.ids['tab-sessions'] && b.dom.ids['tab-draft'], 'drawer toggles available for narrow viewport')
    // toggling the sessions drawer marks it open (no horizontal navigation away)
    b.dom.ids['tab-sessions'].click()
    assert.ok(String(b.dom.ids['sidebar'].className).includes('open'))
  } finally { await b.close() }
})

// ── live workflow map (browser-level, real compiler → durable draft) ──────────
const readyResultStep = (name: string, stepId: string) => ({ schema_version: '1', status: 'ready', workflow_spec: { ...readySpec(name), entry_step: stepId, steps: [{ id: stepId, type: 'agent_task', agent_role: 'only', prompt_template: 'Do {{ inputs.objective }}', output_schema: 'o' }], edges: [{ from: stepId, to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }] }, input_values: { objective: 'x' }, rationale: {}, questions: [], warnings: [] })
const draftPanel = (b: Boot) => b.dom.doc.getElementById('draftpanel')
const svgIn = (b: Boot) => findTag(draftPanel(b), 'svg')

test('map: ready draft shows the map by default and Review uses the same current_draft_id', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    await send(b, 'build slugify')
    await waitUntil(() => svgIn(b))                          // map is the default view
    assert.ok(b.dom.doc.getElementById('wfn-go'), 'the step node is rendered from the durable draft')
    const review = await waitUntil(() => b.dom.ids['review-workflow'])
    const draftId = (await b.gwGet('/v1/workflow-builder/sessions/' + sid)).session.current_draft_id
    review.click()
    assert.ok(b.dom.location.href.includes('/ui?draft=' + draftId), 'map + Review use the same draft id')
  } finally { await b.close() }
})

test('map: a durable draft update refreshes the map without duplicate SVG or speculative nodes', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    b.model.result = readyResultStep('v1', 'go'); await send(b, 'first'); await waitUntil(() => svgIn(b))
    const d1 = (await b.gwGet('/v1/workflow-builder/sessions/' + sid)).session.current_draft_id
    b.model.result = readyResultStep('v2', 'go'); await send(b, 'again')
    await waitUntil(async () => (await b.gwGet('/v1/workflow-builder/sessions/' + sid)).session.current_draft_id !== d1)
    await sleep(60)
    assert.equal(findAll(draftPanel(b), (n: any) => n.tagName === 'svg').length, 1, 'exactly one map (no duplicate DOM)')
    assert.ok(b.dom.doc.getElementById('wfn-go'), 'map updated from the newly fetched draft')
  } finally { await b.close() }
})

test('map: selection is preserved when the node identity is unchanged; resets when the node is removed', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    b.model.result = readyResultStep('s1', 'go'); await send(b, 'first'); await waitUntil(() => b.dom.doc.getElementById('wfn-go'))
    b.dom.doc.getElementById('wfn-go').dispatch('click', { type: 'click' })          // select 'go'
    await waitUntil(() => b.dom.doc.getElementById('selnode'))
    assert.match(b.dom.doc.getElementById('selnode').textContent, /go/)
    b.model.result = readyResultStep('s2', 'go'); await send(b, 'same step id'); await sleep(60)
    assert.ok(b.dom.doc.getElementById('selnode') && /go/.test(b.dom.doc.getElementById('selnode').textContent), 'selection preserved across a revision with the same node id')
    b.model.result = readyResultStep('s3', 'renamed'); await send(b, 'new step id'); await sleep(60)
    const sn = b.dom.doc.getElementById('selnode')
    assert.ok(!sn || !/(^|[^a-z])go([^a-z]|$)/.test(sn.textContent), 'selection reset safely when the selected node was removed')
  } finally { await b.close() }
})

// ── compiler-agent selection (authoritative inventory → selector → session) ───
// Choices are PLACEMENTS (agent id + node_id|null): the backend compiler routes by
// exactly that pair, so option values are the JSON-encoded pair.
const selectorOpts = (b: Boot) => findAll(b.dom.ids['compiler-select'], (n: any) => n.tagName === 'option')
const optPairs = (b: Boot) => selectorOpts(b).map((o: any) => { try { return JSON.parse(o.getAttribute('value')) } catch { return o.getAttribute('value') } })
const optIds = (b: Boot) => optPairs(b).map((p: any) => (Array.isArray(p) ? p[0] : p))
const enc = (id: string, node: string | null) => JSON.stringify([id, node])
const selValue = (b: Boot) => b.dom.ids['compiler-select'].value

test('selector: real advertised agents appear; mock only when advertised; default prefers the first real agent', async () => {
  const b = await boot('/ui/builder', { agents: [{ id: 'claude-code', available: true, node_id: 'n1' }, { id: 'codex', available: true, node_id: 'n1' }] })
  try {
    await waitUntil(() => selectorOpts(b).length === 2)
    assert.deepEqual(optPairs(b), [['claude-code', 'n1'], ['codex', 'n1']], 'exactly the advertised placements, in advertised order')
    assert.ok(!optIds(b).includes('mock'), 'mock is NOT offered when it is not advertised')
    assert.equal(selValue(b), enc('claude-code', 'n1'), 'default = first real advertised placement')
    assert.ok(findTag(b.dom.ids['sidebar'], 'select'), 'selector lives in the sidebar (narrow-viewport drawer) — composer area untouched')
    b.dom.ids['new-session'].click()
    await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    assert.equal(b.sess.lastBody.compiler_agent, 'claude-code', 'POST carries the exact selected compiler_agent')
    assert.equal(b.sess.lastBody.compiler_node_id, 'n1', 'POST carries the placement node — the compiler routes by the (agent, node) pair')
    const badge = await waitUntil(() => b.dom.ids['session-compiler'])
    assert.match(badge.textContent, /compiler: claude-code @ n1/, 'the created session displays its owning compiler placement')
  } finally { await b.close() }
})

test('selector: default prefers a real available agent over an advertised mock (no silent mock fallback)', async () => {
  const b = await boot('/ui/builder', { agents: [{ id: 'mock', available: true }, { id: 'claude-code', available: true, node_id: 'n1' }] })
  try {
    await waitUntil(() => selectorOpts(b).length === 2)
    assert.deepEqual(optIds(b), ['claude-code', 'mock'], 'mock is offered (advertised) but sorted last')
    assert.equal(selValue(b), enc('claude-code', 'n1'), 'real agent wins the default over mock')
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    assert.equal(b.sess.lastBody.compiler_agent, 'claude-code')
    const s = await b.gwGet('/v1/workflow-builder/sessions/' + sid)
    assert.equal(s.session.compiler_agent, 'claude-code', 'durable session owned by the real agent — never silently mock')
    assert.equal(s.session.compiler_node_id, 'n1', 'durable session routes to the advertised node')
    assert.equal(b.dom.win.localStorage.getItem('vibe_builder_compiler_agent'), enc('claude-code', 'n1'), 'used placement preserved for this browser')
  } finally { await b.close() }
})

test('selector: a previously selected available placement is restored and used', async () => {
  const b = await boot('/ui/builder', {
    agents: [{ id: 'mock', available: true }, { id: 'claude-code', available: true, node_id: 'n1' }, { id: 'codex', available: true, node_id: 'n1' }],
    ls: { vibe_builder_compiler_agent: enc('codex', 'n1') },
  })
  try {
    await waitUntil(() => selectorOpts(b).length === 3)
    assert.equal(selValue(b), enc('codex', 'n1'), 'previous per-browser selection restored (still available)')
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    const s = await b.gwGet('/v1/workflow-builder/sessions/' + sid)
    assert.equal(s.session.compiler_agent, 'codex')
    assert.equal(s.session.compiler_node_id, 'n1')
  } finally { await b.close() }
})

test('selector: same agent id on two nodes → distinct disambiguated choices, exact node routed (regression)', async () => {
  const b = await boot('/ui/builder', { agents: [{ id: 'codex', available: true, node_id: 'n1' }, { id: 'codex', available: true, node_id: 'n2' }, { id: 'mock', available: true }] })
  try {
    await waitUntil(() => selectorOpts(b).length === 3)
    assert.deepEqual(optPairs(b), [['codex', 'n1'], ['codex', 'n2'], ['mock', null]], 'distinct executable targets are never collapsed')
    const labels = selectorOpts(b).map((o: any) => o.textContent)
    assert.ok(labels.includes('codex @ n1') && labels.includes('codex @ n2'), 'duplicate ids are disambiguated by node in the label')
    const sel = b.dom.ids['compiler-select']; sel.value = enc('codex', 'n2'); sel.dispatch('change')
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    assert.equal(b.sess.lastBody.compiler_agent, 'codex')
    assert.equal(b.sess.lastBody.compiler_node_id, 'n2', 'the chosen node — not the first advertised one — is routed')
    assert.equal((await b.gwGet('/v1/workflow-builder/sessions/' + sid)).session.compiler_node_id, 'n2')
  } finally { await b.close() }
})

test('selector: a stale selection blocks creation with a clear message (no silent substitution)', async () => {
  const b = await boot('/ui/builder', { agents: [{ id: 'claude-code', available: true, node_id: 'n1' }, { id: 'codex', available: true, node_id: 'n1' }] })
  try {
    await waitUntil(() => selectorOpts(b).length === 2)
    const sel = b.dom.ids['compiler-select']; sel.value = enc('codex', 'n1'); sel.dispatch('change') // explicit choice
    b.agentsCtl.override = [{ id: 'claude-code', available: true, node_id: 'n1' }]                  // codex disappears before create
    b.dom.ids['new-session'].click()
    const notice = await waitUntil(() => b.dom.ids['compiler-notice'])
    assert.match(notice.textContent, /codex.*no longer available/i, 'clear message names the vanished agent')
    assert.equal(new URL(b.dom.location.href).searchParams.get('session'), null, 'no session was created')
    assert.equal(b.sess.count, 0, 'no create POST was sent — and nothing was substituted')
    await waitUntil(() => selectorOpts(b).length === 1)                                             // inventory reloaded
    assert.deepEqual(optPairs(b), [['claude-code', 'n1']], 'selector reflects the reloaded authoritative inventory')
  } finally { await b.close() }
})

test('selector: mock-only inventory (real gateway) → mock clearly labeled, unavailability explained, explicit mock session works', async () => {
  const b = await boot() // NO override: the real gateway /v1/agents (local mock only)
  try {
    await waitUntil(() => optIds(b)[0] === 'mock') // loaded (placeholder option has value '')
    assert.deepEqual(optPairs(b), [['mock', null]], 'local mock is a node-less placement')
    assert.equal(selectorOpts(b)[0].textContent, 'mock (deterministic)', 'mock is clearly distinguished from real agents')
    assert.ok(b.dom.ids['mock-only-note'] && /real .*unavailable/i.test(b.dom.ids['mock-only-note'].textContent), 'explains that real compilation is unavailable')
    b.dom.ids['new-session'].click()
    const sid = await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    assert.equal(b.sess.lastBody.compiler_agent, 'mock', 'mock used only as the visible, advertised fallback')
    assert.equal(b.sess.lastBody.compiler_node_id, undefined, 'a node-less local placement sends NO compiler_node_id')
    const badge = await waitUntil(() => b.dom.ids['session-compiler'])
    assert.match(badge.textContent, /compiler: mock/)
    assert.equal((await b.gwGet('/v1/workflow-builder/sessions/' + sid)).session.compiler_agent, 'mock')
  } finally { await b.close() }
})

test('selector: no agents advertised → creation blocked with a clear message', async () => {
  const b = await boot('/ui/builder', { agents: [] })
  try {
    await waitUntil(() => b.dom.ids['no-agents-note'])
    assert.equal(b.dom.ids['new-session'].disabled, true, 'New session disabled when nothing is advertised')
    b.dom.ids['new-session'].click() // even a forced click must not create anything
    await sleep(120)
    assert.equal(b.sess.count, 0, 'no session POST')
    assert.equal(new URL(b.dom.location.href).searchParams.get('session'), null)
  } finally { await b.close() }
})

test('selector: unavailable agents are excluded; agent labels render safely (textContent only)', async () => {
  const evil = '<img src=x onerror=alert(1)>'
  const b = await boot('/ui/builder', { agents: [{ id: 'claude-code', available: false, node_id: 'n1' }, { id: evil, available: true }, { id: 'mock', available: true }] })
  try {
    await waitUntil(() => selectorOpts(b).length === 2)
    assert.ok(!optIds(b).includes('claude-code'), 'unavailable agents are not offered')
    const evilOpt = selectorOpts(b).find((o: any) => o.getAttribute('value') === enc(evil, null))
    assert.ok(evilOpt, 'hostile id is listed as data (JSON-encoded value, no ambiguity)')
    assert.equal(evilOpt.textContent, evil, 'label is the literal string (textContent)')
    assert.equal(findTag(b.dom.ids['sidebar'], 'img'), null, 'no element was created from the hostile label')
  } finally { await b.close() }
})

test('selector: malformed inventory → clear error, creation blocked, existing sessions still fully usable', async () => {
  const b = await boot('/ui/builder', { agents: 'not-an-array' as any })
  try {
    await waitUntil(() => b.dom.ids['agents-error'])                       // no throw, no stuck state
    assert.match(b.dom.ids['agents-error'].textContent, /could not load/i)
    b.dom.ids['new-session'].click()                                       // creation is blocked with a message…
    await waitUntil(() => b.dom.ids['compiler-notice'])
    assert.equal(b.sess.count, 0, 'no session POST on malformed inventory')
    assert.ok(!anyText(b.dom.ids['new-session'], /creating/i), 'create button is not stuck in Creating…')
    // …but the Builder itself stays usable: an existing session opens normally
    const cs = await (await fetch(b.base + '/v1/workflow-builder/sessions', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{"compiler_agent":"mock","title":"Still opens"}' })).json() as any
    b.dom.location.href = b.base + '/ui/builder?session=' + cs.session.builder_session_id
    b.dom.win.dispatch('popstate')
    await waitUntil(() => anyText(app(b), /Still opens/))
    await waitUntil(() => b.dom.ids['composer-input'])
    assert.ok(b.dom.ids['session-compiler'], 'session badge comes from persisted session data, not the (failed) inventory')
  } finally { await b.close() }
})

test('selector: a legacy/corrupt stored selection is ignored silently (untrusted storage)', async () => {
  const b = await boot('/ui/builder', { agents: [{ id: 'claude-code', available: true, node_id: 'n1' }], ls: { vibe_builder_compiler_agent: 'codex' } }) // pre-placement plain string
  try {
    await waitUntil(() => optIds(b)[0] === 'claude-code') // loaded (the loading placeholder also has one option)
    assert.equal(selValue(b), enc('claude-code', 'n1'), 'default applies; corrupt value never blocks')
    assert.equal(b.dom.doc.getElementById('compiler-notice'), null, 'no scary notice for malformed stored data')
    assert.equal(b.dom.win.localStorage.getItem('vibe_builder_compiler_agent'), null, 'corrupt value cleaned up')
  } finally { await b.close() }
})

test('selector: existing mock-backed sessions remain readable and show their compiler agent', async () => {
  const b = await boot('/ui/builder', { agents: [{ id: 'claude-code', available: true, node_id: 'n1' }] })
  try {
    // an EXISTING session created explicitly with mock (deterministic path) — unaffected by the selector
    const cs = await (await fetch(b.base + '/v1/workflow-builder/sessions', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{"compiler_agent":"mock","title":"Old mock session"}' })).json() as any
    const b2 = await bootAt(b, '/ui/builder?session=' + cs.session.builder_session_id)
    await waitUntil(() => anyText(app(b2.b), /Old mock session/))
    const badge = await waitUntil(() => b2.b.dom.ids['session-compiler'])
    assert.match(badge.textContent, /compiler: mock/, 'legacy mock session readable, ownership visible')
    await b2.b.close()
  } finally { await b.close() }
})

test('map: lives inside the draft panel (drawer on narrow) and the draft toggle opens it', async () => {
  const b = await boot()
  try {
    b.dom.ids['new-session'].click()
    await waitUntil(() => new URL(b.dom.location.href).searchParams.get('session'))
    await send(b, 'build it'); await waitUntil(() => svgIn(b))
    assert.ok(svgIn(b), 'the map is contained within #draftpanel (the narrow-viewport drawer)')
    b.dom.ids['tab-draft'].click()
    assert.ok(String(b.dom.doc.getElementById('draftpanel').className).includes('open'), 'draft drawer opens')
  } finally { await b.close() }
})
