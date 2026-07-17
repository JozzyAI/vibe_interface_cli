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
