/**
 * BROWSER-LEVEL acceptance for the Workflow UI: the page's ACTUAL client script runs
 * against a REAL in-process gateway (compiler + runtime) inside a tiny self-contained
 * DOM shim (no new dependency; Node has global fetch/crypto/URL and the page guards a
 * missing EventSource). Drives the whole flow — compile → preview → approve → start →
 * monitor → cancel — by setting fields and dispatching real events, asserting the
 * durable state via the gateway. Never touches production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { startAgentGateway } from '../src/lib/agent-gateway.js'
import { workflowUiHtml } from '../src/lib/workflow-ui.js'
import { WorkflowCompiler } from '../src/workflow/compiler/compiler.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import type { AgentTaskClient, AgentTaskCreateRequest } from '../src/workflow/task-client.js'

const TOKEN = `wfbrz-${Math.random().toString(36).slice(2)}`
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wfbrz-')), 'control.sqlite')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── a running task backend (stays running until cancelled) ──
class RunFake implements AgentTaskClient {
  byKey = new Map<string, any>(); byId = new Map<string, any>(); n = 0
  constructor(public store: SqliteControlStore) {}
  async createTask(r: AgentTaskCreateRequest) {
    const ex = this.byKey.get(r.idempotency_key); if (ex) return { task_id: ex.task_id }
    const id = 'task_' + (++this.n)
    this.store.createTaskDurable({ task_id: id, agent: r.agent, node_id: r.node_id ?? null, status: 'queued', idempotency_key: r.idempotency_key, request_fingerprint: 'fp' }, { sequence: 0, event_type: 'task.created', ts: new Date().toISOString(), payload: {} })
    const t = { task_id: id, released: false }; this.byKey.set(r.idempotency_key, t); this.byId.set(id, t); return { task_id: id }
  }
  private v(t: any) { const run = !t.released; return { status: run ? 'running' : 'completed', terminal: !run, history_complete: true, result_status: run ? undefined : 'available', result_text: run ? undefined : JSON.stringify({ status: 'done', summary: 'ok' }), events: [], next_event_id: -1 } }
  async getTask(id: string) { return { task_id: id, ...this.v(this.byId.get(id)) } }
  async waitForTerminal(id: string) { await sleep(5); return { task_id: id, ...this.v(this.byId.get(id)) } }
  async cancelTask(id: string) { const t = this.byId.get(id); if (t) t.released = true }
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

// ── minimal DOM shim (only what the page uses) ──
function makeDom(base: string) {
  const ids: Record<string, any> = {}
  class N {
    tagName: string; children: any[] = []; attrs: Record<string, string> = {}; listeners: Record<string, Function[]> = {}; _text = ''; style: any = {}; _value = ''; checked = false; disabled = false
    constructor(tag: string) { this.tagName = (tag || '').toLowerCase() }
    append(...k: any[]) { for (const c of k) if (c != null) this.children.push(c) }
    replaceChildren(...k: any[]) { this.children = []; this.append(...k) }
    set textContent(v: any) { this.children = []; this._text = String(v) }
    get textContent(): string { return this._text + this.children.map((c) => (c && c.textContent != null ? c.textContent : '')).join('') }
    set className(v: string) { this.attrs.class = v }
    get className() { return this.attrs.class || '' }
    setAttribute(k: string, v: any) { this.attrs[k] = String(v); if (k === 'id') ids[v] = this }
    getAttribute(k: string) { return this.attrs[k] }
    removeAttribute(k: string) { delete this.attrs[k] }
    addEventListener(t: string, fn: Function) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
    dispatch(t: string, ev?: any) { (this.listeners[t] || []).forEach((fn) => fn(ev || { type: t, preventDefault() {} })) }
    click() { this.dispatch('click', { type: 'click', preventDefault() {} }) }
    focus() {}
    set value(v: any) { this._value = v } get value() { return this._value }
    set id(v: string) { this.attrs.id = v; ids[v] = this } get id() { return this.attrs.id }
  }
  const doc: any = {
    createElement: (t: string) => new N(t), createElementNS: (_n: string, t: string) => new N(t),
    createTextNode: (t: any) => ({ textContent: String(t), children: [] }),
    getElementById: (id: string) => ids[id] || null,
  }
  for (const id of ['app', 'nav-new', 'status']) { const n = new N(id === 'nav-new' ? 'button' : id === 'status' ? 'p' : 'main'); n.id = id }
  const winL: Record<string, Function[]> = {}
  const win: any = { addEventListener(t: string, fn: Function) { (winL[t] = winL[t] || []).push(fn) }, dispatch(t: string, ev?: any) { (winL[t] || []).forEach((fn) => fn(ev || { type: t })) } }
  const location: any = { href: base + '/ui' }
  const history: any = { pushState: (_a: any, _b: any, url: string) => { location.href = new URL(url, location.href).href } }
  return { doc, win, location, history, N, ids }
}
function findByText(root: any, text: string): any {
  if (!root) return null
  if (root.tagName === 'button' && root.textContent === text) return root
  for (const c of root.children || []) { const f = findByText(c, text); if (f) return f }
  return null
}
function findTag(root: any, tag: string): any {
  if (!root) return null
  if (root.tagName === tag) return root
  for (const c of root.children || []) { const f = findTag(c, tag); if (f) return f }
  return null
}

function extractScript(html: string): string {
  const m = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)
  if (!m) throw new Error('no script'); return m[1]
}

test('browser acceptance: compile → preview → approve → start → monitor → cancel (real page JS over a real gateway)', async () => {
  const store = openControlStore({ path: tmpDb() })
  const model = { compile: async () => ({ task_id: 'ct', status: 'available' as const, output_text: JSON.stringify({ schema_version: '1', status: 'ready', workflow_spec: readySpec, input_values: { objective: 'x' }, rationale: {}, questions: [], warnings: [] }) }) }
  const inventory = { snapshot: async () => ({ observed_at: '2026-01-01T00:00:00Z', agents: [{ agent: 'mock', permission_modes: ['default'], workspace_supported: false, capabilities: ['run'] }] }) }
  const compiler = new WorkflowCompiler({ store, model, inventory })
  let runtime: WorkflowRuntime | undefined
  const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, controlStore: store, getWorkflowRuntime: () => runtime, getWorkflowCompiler: () => compiler })
  runtime = new WorkflowRuntime({ store, taskClient: new RunFake(store), waitWindowMs: 20 })
  const base = `http://127.0.0.1:${gw.port}`
  // fetch wired to the gateway with the Bearer token (stands in for the same-origin cookie)
  const wfetch = (p: string, opts: any = {}) => fetch(base + p, { ...opts, headers: { ...(opts.headers || {}), authorization: `Bearer ${TOKEN}` } })
  const gwGet = async (p: string) => JSON.parse(await (await fetch(base + p, { headers: { authorization: `Bearer ${TOKEN}` } })).text())
  const dom = makeDom(base)
  const waitUntil = async (fn: () => any, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50) } throw new Error('timeout') }
  try {
    // run the page's ACTUAL client script with the shim globals
    const script = extractScript(workflowUiHtml('nonce'))
    // eslint-disable-next-line no-new-func
    const run = new Function('document', 'window', 'location', 'history', 'crypto', 'fetch', 'EventSource', 'confirm', 'setTimeout', 'clearTimeout', 'URL', script)
    run(dom.doc, dom.win, dom.location, dom.history, crypto, wfetch as any, undefined, () => true, setTimeout, clearTimeout, URL)

    // compile: fill the form + submit
    await waitUntil(() => dom.doc.getElementById('f-nl'))
    dom.doc.getElementById('f-nl').value = 'build a thing'
    dom.doc.getElementById('f-ca').value = 'mock'
    findTag(dom.ids.app, 'form').dispatch('submit', { preventDefault() {} })

    // preview: the draft renders with an Approve button
    const approve = await waitUntil(() => findByText(dom.ids.app, 'Approve this exact plan'))
    // approve does NOT start: the draft page shows Approve, and the API shows no workflow yet
    approve.click()

    // after approval → the workflow view with a Start button; the workflow is READY (not started)
    const start = await waitUntil(() => findByText(dom.ids.app, 'Start workflow'))
    const wfId = new URL(dom.location.href).searchParams.get('workflow')!
    assert.ok(wfId, 'navigated to the workflow view')
    assert.equal((await gwGet(`/v1/workflows/${wfId}`)).status, 'ready', 'approval never started the workflow')

    // start (separate action) → the workflow runs; monitor shows running + a Cancel button
    start.click()
    await waitUntil(async () => (await gwGet(`/v1/workflows/${wfId}`)).status === 'running')
    const cancel = await waitUntil(() => findByText(dom.ids.app, 'Cancel'))
    assert.equal((await gwGet(`/v1/workflows/${wfId}`)).total_tasks, 1, 'started exactly once')

    // cancel (explicit, confirmed) → the workflow becomes cancelled
    cancel.click()
    await waitUntil(async () => (await gwGet(`/v1/workflows/${wfId}`)).status === 'cancelled')
    assert.equal((await gwGet(`/v1/workflows/${wfId}`)).status, 'cancelled')
    // tear the page down exactly as a real browser unload would: pagehide → disposed → timers/stream stop
    dom.win.dispatch('pagehide'); await sleep(50)
  } finally { dom.win.dispatch('pagehide'); try { await runtime.shutdown() } catch { /* */ } try { await gw.close() } catch { /* */ } try { store.closeSync() } catch { /* */ } }
})
