/**
 * Live workflow MAP unit behavior: the real WORKFLOW_MAP_SCRIPT (buildWorkflowMap)
 * run in a DOM shim over AUTHORITATIVE draft-preview models (the same shape the
 * compiler emits). Covers no-draft/partial/valid-linear/conditional/validation-error
 * rendering, deterministic layout+identity, selection, keyboard/a11y, summary and
 * user-label safety — behavioral over pixel snapshots. Never touches production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKFLOW_MAP_SCRIPT } from '../src/lib/workflow-map.js'

// ── DOM shim (element + SVG namespaced element) ──
function makeDoc() {
  class N {
    tagName: string; children: any[] = []; attrs: Record<string, string> = {}; listeners: Record<string, Function[]> = {}; _text = ''
    constructor(tag: string) { this.tagName = (tag || '').toLowerCase() }
    append(...k: any[]) { for (const c of k) if (c != null) this.children.push(c) }
    replaceChildren(...k: any[]) { this.children = []; this.append(...k) }
    set textContent(v: any) { this.children = []; this._text = String(v) }
    get textContent(): string { return this._text + this.children.map((c) => (c && c.textContent != null ? c.textContent : '')).join('') }
    set className(v: string) { this.attrs.class = v } get className() { return this.attrs.class || '' }
    setAttribute(k: string, v: any) { this.attrs[k] = String(v) } getAttribute(k: string) { return this.attrs[k] ?? null }
    addEventListener(t: string, fn: Function) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
    dispatch(t: string, ev?: any) { (this.listeners[t] || []).forEach((fn) => fn(ev || { type: t, preventDefault() {} })) }
    focus() { (this as any)._focused = true }
    set value(v: any) { (this as any)._value = v } get value() { return (this as any)._value }
    set id(v: string) { this.attrs.id = v } get id() { return this.attrs.id }
  }
  return { createElement: (t: string) => new N(t), createElementNS: (_ns: string, t: string) => new N(t), createTextNode: (t: any) => ({ textContent: String(t), children: [] }) }
}
const buildMap = new Function('document', WORKFLOW_MAP_SCRIPT + '\n;return buildWorkflowMap;')(makeDoc())

// traversal helpers
const all = (root: any, pred: (n: any) => boolean, acc: any[] = []): any[] => { if (!root) return acc; if (pred(root)) acc.push(root); for (const c of root.children || []) all(c, pred, acc); return acc }
const nodes = (root: any) => all(root, (n) => n.tagName === 'g' && String(n.getAttribute?.('class') || '').includes('node'))
const hasClass = (n: any, c: string) => String(n.getAttribute?.('class') || '').split(' ').includes(c)
const text = (root: any) => root.textContent as string
const findId = (root: any, id: string) => all(root, (n) => n.getAttribute?.('id') === id)[0]
const findSvg = (root: any) => all(root, (n) => n.tagName === 'svg')[0]

const linear = { preview: { name: 'slug', entry_step: 'implement', policy_summary: { requires_verified_tests: true, terminal_routes: ['$complete'] }, terminal_routes: ['$complete'], steps: [{ id: 'implement', role: 'coder', agent: 'codex', node_id: 'node_f7', workspace: true, workspace_write: true, verify: 'node-test', permission_mode: 'default' }], edges: [{ from: 'implement', to: '$complete', kind: 'normal', loop: false, terminal: true, cond: 'output.status = "done"' }] }, validation_status: 'valid', warnings: [], kind: 'ready_for_review', missing: [] as string[] }

test('1: no draft / clarification → useful empty state with missing concepts, no fake graph', () => {
  const m = buildMap({ preview: null, validation_status: 'pending', warnings: [], kind: 'clarification_required', missing: ['implementation agent not selected', 'verifier required'] })
  assert.equal(m.order.length, 0)                 // no invented nodes
  assert.equal(nodes(m.root).length, 0)
  assert.match(text(m.root), /implementation agent not selected/)
  assert.match(text(m.root), /verifier required/)
})

test('2: partial draft → known step rendered with explicit unresolved placeholders', () => {
  const m = buildMap({ preview: { name: 'p', entry_step: 'impl', policy_summary: {}, terminal_routes: [], steps: [{ id: 'impl', role: 'coder', agent: null, node_id: null, workspace: true, workspace_write: false, verify: null, permission_mode: 'default' }], edges: [] }, validation_status: 'valid', warnings: [], kind: 'draft_updated', missing: [] })
  const ns = nodes(m.root)
  const impl = ns.find((n) => n.getAttribute('id') === 'wfn-impl')
  assert.ok(impl && hasClass(impl, 'incomplete'), 'unresolved step is marked incomplete (not valid)')
  assert.match(text(impl), /agent not selected/)  // explicit placeholder, not invented
})

test('3: valid linear → deterministic start → step → verifier → completion', () => {
  const m = buildMap(linear)
  assert.ok(findId(m.root, 'wfn-__start'), 'start node')
  const impl = findId(m.root, 'wfn-implement'); assert.ok(impl && hasClass(impl, 'valid'))
  assert.match(text(impl), /codex/); assert.match(text(impl), /write/); assert.match(text(impl), /node-test/)
  assert.ok(findId(m.root, 'wfn-__verifier'), 'verifier stage')
  assert.ok(findId(m.root, 'wfn-_complete') || findId(m.root, 'wfn-__complete') || all(m.root, (n) => String(n.getAttribute?.('id') || '').indexOf('complete') >= 0)[0], 'completion gate')
  assert.deepEqual(m.order.slice(0, 2), ['__start', 'implement'])
  // deterministic: same input → identical structure/order
  const m2 = buildMap(linear); assert.deepEqual(m2.order, m.order)
})

test('4: conditional workflow → branch edges are conditional and labelled', () => {
  const cond = { preview: { name: 'c', entry_step: 'a', policy_summary: {}, terminal_routes: ['$complete', '$failed'], steps: [{ id: 'a', role: 'r', agent: 'mock', node_id: null, workspace: false, workspace_write: false, verify: null, permission_mode: 'default' }, { id: 'b', role: 'r', agent: 'mock', node_id: null, workspace: false, workspace_write: false, verify: null, permission_mode: 'default' }], edges: [{ from: 'a', to: 'b', kind: 'normal', loop: false, terminal: false, cond: 'output.status = "x"' }, { from: 'a', to: '$complete', kind: 'normal', loop: false, terminal: true, cond: 'output.status = "y"' }] }, validation_status: 'valid', warnings: [], kind: 'ready_for_review', missing: [] }
  const m = buildMap(cond)
  const condEdges = all(m.root, (n) => n.tagName === 'path' && hasClass(n, 'cond'))
  assert.ok(condEdges.length >= 1, 'conditional edges rendered distinctly')
  assert.match(text(m.root), /output\.status/), 'branch condition labelled'
})

test('5: validation errors → invalid node carries its issue (revealed on select)', () => {
  let selected: any = null
  const m = buildMap({ preview: { name: 'e', entry_step: 'impl', policy_summary: {}, terminal_routes: [], steps: [{ id: 'impl', role: 'coder', agent: 'codex', node_id: 'node_x', workspace: true, workspace_write: true, verify: 'node-test', permission_mode: 'default' }], edges: [] }, validation_status: 'invalid', warnings: ['unavailable placement for role coder @ /steps/impl'], kind: 'compile_failed', missing: [], onSelect: (id: string, info: any) => { selected = { id, info } } })
  const impl = findId(m.root, 'wfn-impl')
  assert.ok(impl && hasClass(impl, 'error'), 'invalid node marked error')
  assert.match(text(impl), /unavailable in inventory/)
  impl.dispatch('click')
  assert.equal(selected.id, 'impl'); assert.match(selected.info.issue, /unavailable placement/)  // issue linked
})

test('10: keyboard navigation moves aria-activedescendant; Enter selects', () => {
  let sel: string | null = null
  const m = buildMap({ ...linear, onSelect: (id: string) => { sel = id } })
  const svg = findSvg(m.root)
  assert.equal(svg.getAttribute('aria-activedescendant'), 'wfn-__start')
  findId(m.root, 'wfn-__start').dispatch('keydown', { key: 'ArrowRight', preventDefault() {} })
  assert.equal(svg.getAttribute('aria-activedescendant'), 'wfn-implement', 'ArrowRight advances focus')
  findId(m.root, 'wfn-implement').dispatch('keydown', { key: 'Enter', preventDefault() {} })
  assert.equal(sel, 'implement', 'Enter selects the focused node')
})

test('11: accessible text summary describes the graph', () => {
  const m = buildMap(linear)
  assert.match(m.summary, /starts at implement/)
  assert.match(m.summary, /1 step/)
  assert.match(m.summary, /verifier gate/i)
  assert.match(m.summary, /valid/)
})

test('13: user/compiler-derived labels are rendered as text (no HTML execution)', () => {
  const m = buildMap({ preview: { name: '<img src=x onerror=1>', entry_step: 'a<script>', policy_summary: {}, terminal_routes: [], steps: [{ id: 'a<script>alert(1)</script>', role: 'r', agent: 'mock', node_id: null, workspace: false, workspace_write: false, verify: null, permission_mode: 'default' }], edges: [] }, validation_status: 'valid', warnings: [], kind: 'draft_updated', missing: [] })
  // the payload appears only as literal text; no <script>/<img> ELEMENTS were created
  assert.ok(all(m.root, (n) => n.tagName === 'script' || n.tagName === 'img').length === 0)
  assert.match(text(m.root), /alert\(1\)/) // literal text present
})

test('7/added: nodes new since the previous draft are flagged; identity deterministic', () => {
  const m = buildMap({ ...linear, prevIds: [] as string[] })
  const impl = findId(m.root, 'wfn-implement')
  assert.ok(hasClass(impl, 'added'), 'a step absent from the previous draft is flagged added')
  const m2 = buildMap({ ...linear, prevIds: ['implement'] })
  assert.ok(!hasClass(findId(m2.root, 'wfn-implement'), 'added'), 'an unchanged node is not re-flagged')
})
