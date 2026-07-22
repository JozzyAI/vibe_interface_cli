/**
 * Conversational Builder workspace — PURE render + gateway serving/auth. Covers the
 * self-contained page (nonce-locked single script, no external resources/secrets,
 * textContent-only), the responsive layout, the manual-UI backward-compat link, and
 * that the gateway serves /ui/builder as a public shell with the token→cookie
 * bootstrap while /ui still serves the original page. Never touches production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { startAgentGateway } from '../src/lib/agent-gateway.js'
import { workflowBuilderUiHtml } from '../src/lib/workflow-builder-ui.js'
import { workflowUiHtml } from '../src/lib/workflow-ui.js'

const TOKEN = `wbui-${Math.random().toString(36).slice(2)}`
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wbui-')), 'control.sqlite')

test('workflowBuilderUiHtml: self-contained, nonce-locked, no external resources/secrets, textContent-only', () => {
  const html = workflowBuilderUiHtml('NONCE9')
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(html.includes('<script nonce="NONCE9">'), 'single inline script is nonce-locked')
  assert.ok(!html.includes(TOKEN))
  assert.ok(!/src\s*=\s*["']https?:/.test(html) && !/href\s*=\s*["']https?:/.test(html), 'no external src/href')
  assert.ok(!html.includes('innerHTML'), 'no innerHTML (textContent/append only)')
  assert.ok(html.includes('textContent'))
})

test('workflowBuilderUiHtml: drives the builder REST routes and the three panels', () => {
  const html = workflowBuilderUiHtml('n')
  // uses ONLY the existing builder REST contract (no second client spec model)
  assert.ok(html.includes('/v1/workflow-builder/sessions'))
  assert.ok(html.includes("/messages'") || html.includes('/messages'))
  assert.ok(html.includes('/archive'))
  // three panels: sidebar + conversation + draft
  assert.ok(html.includes('class="col sidebar"') || html.includes("class:'col sidebar'"))
  assert.ok(html.includes("class:'col conversation'"))
  assert.ok(html.includes("class:'col draftpanel'"))
  // idempotency key generated client-side + expected_revision sent
  assert.ok(html.includes('idempotency_key') && html.includes('expected_revision'))
  assert.ok(html.includes('randomUUID'), 'generates a stable client idempotency key')
  // review action routes to the EXISTING draft/approval page, not a second draft
  assert.ok(html.includes("/ui?draft="))
  // raw JSON is an advanced <details>, not the default view
  assert.ok(html.includes('<details') === false ? html.includes("'details'") : true)
})

test('workflowBuilderUiHtml: responsive layout (narrow media query, no horizontal overflow, reachable composer)', () => {
  const html = workflowBuilderUiHtml('n')
  assert.ok(/@media\s*\(max-width/.test(html), 'a narrow-viewport media query exists')
  assert.ok(html.includes('overflow-x:hidden'), 'body prevents horizontal overflow')
  assert.ok(html.includes('.composer') && html.includes('position:sticky'), 'composer stays reachable')
  // narrow view keeps conversation primary; sidebar/draft become drawers (toggles)
  assert.ok(html.includes('id="tab-sessions"') && html.includes('id="tab-draft"'), 'drawer toggles for narrow viewport')
})

test('workflowBuilderUiHtml: compiler selector consumes the authoritative inventory and stays compact/safe', () => {
  const html = workflowBuilderUiHtml('n')
  assert.ok(html.includes("'/v1/agents'"), 'options come from the advertised inventory endpoint (no hard-coded real agents)')
  assert.ok(html.includes("id:'compiler-select'"), 'compact selector rendered near New session')
  assert.ok(html.includes("' (deterministic)'"), 'mock is clearly distinguished from real agents')
  assert.ok(!/compiler_agent:\s*'mock'/.test(html), 'session creation no longer hard-codes mock')
  assert.ok(html.includes('compiler_node_id'), 'node-advertised placements route by the (agent, node) pair')
  assert.ok(html.includes('flex-wrap:wrap'), 'selector row wraps on narrow screens instead of overflowing')
  assert.ok(/lsGet|localStorage/.test(html) && html.includes('catch'), 'last selection preserved via guarded localStorage')
})

test('workflowBuilderUiHtml: retains a link back to the manual workflow builder (/ui)', () => {
  const html = workflowBuilderUiHtml('n')
  assert.ok(html.includes('href="/ui"'), 'manual builder remains reachable')
})

// ── gateway serving + auth ──
function gwHtml(store: SqliteControlStore) {
  return startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, controlStore: store })
}
const get = (base: string, p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
  const u = new URL(base + p)
  http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode || 0, body: b, headers: res.headers })) }).on('error', reject)
})

test('gateway serves /ui/builder as a public HTML shell; /ui still serves the original page (backward-compatible)', async () => {
  const store = openControlStore({ path: tmpDb() })
  const gw = await gwHtml(store)
  const base = `http://127.0.0.1:${gw.port}`
  try {
    const b = await get(base, '/ui/builder')
    assert.equal(b.status, 200)
    assert.ok(/text\/html/.test(String(b.headers['content-type'])))
    assert.ok(b.body.includes('Workflow Builder') && b.body.includes('/v1/workflow-builder/sessions'))
    assert.ok(!b.body.includes(TOKEN), 'no token in the shell')
    // /ui unchanged
    const u = await get(base, '/ui')
    assert.equal(u.status, 200)
    assert.ok(u.body.includes('/v1/workflow-drafts/compile'), '/ui still serves the manual compile page')
  } finally { await gw.close(); store.closeSync() }
})

test('gateway /ui/builder?token bootstrap sets the HttpOnly cookie and redirects to a clean path (preserving session)', async () => {
  const store = openControlStore({ path: tmpDb() })
  const gw = await gwHtml(store)
  const base = `http://127.0.0.1:${gw.port}`
  try {
    const r = await get(base, '/ui/builder?token=' + encodeURIComponent(TOKEN) + '&session=bs_abc')
    assert.equal(r.status, 302)
    assert.equal(r.headers.location, '/ui/builder?session=bs_abc')
    assert.ok(String(r.headers['set-cookie']).includes('HttpOnly'))
    assert.ok(!String(r.headers.location).includes(TOKEN), 'token stripped from the redirect URL')
  } finally { await gw.close(); store.closeSync() }
})
