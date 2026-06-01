/**
 * MVP 3B — Vibe Node abstraction tests.
 *
 * Covers: node list, node status, --node flag on run/symphony start,
 * node_id/node_selector in RunRecord, error cases.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import type { RunRecord, VibeNode } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

function vibe(...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8' })
}

function uniqueKey(prefix = 'n') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// ── node list ──────────────────────────────────────────────────────────────

test('node list: returns array with local node', () => {
  const r = vibe('node', 'list', '--json')
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
  assert.ok(Array.isArray(nodes), 'result is array')
  assert.ok(nodes.length >= 1, 'at least one node')
  const local = nodes.find((n) => n.node_id === 'local')
  assert.ok(local, 'local node present')
  assert.equal(local!.status, 'online')
  assert.equal(local!.transport, 'local')
  assert.ok(local!.agents.includes('mock'), 'local supports mock')
  assert.ok(local!.agents.includes('claude-code'), 'local supports claude-code')
  assert.ok(local!.capabilities.includes('run'), 'local has run capability')
  assert.ok(local!.max_runs > 0, 'max_runs > 0')
})

// ── node status ────────────────────────────────────────────────────────────

test('node status local: returns local node details', () => {
  const r = vibe('node', 'status', 'local', '--json')
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const n = JSON.parse(r.stdout.trim()) as VibeNode
  assert.equal(n.node_id, 'local')
  assert.equal(n.name, 'Local Machine')
  assert.equal(n.status, 'online')
  assert.ok(n.workspace_roots.length >= 1, 'has workspace roots')
  assert.ok(n.created_at, 'has created_at')
})

test('node status unknown: exits 3 with node_not_found error', () => {
  const r = vibe('node', 'status', 'nonexistent-node', '--json')
  assert.equal(r.status, 3, `expected exit 3, got ${r.status}`)
  const err = JSON.parse(r.stdout.trim())
  assert.equal(err.error, true)
  assert.equal(err.code, 'node_not_found')
  assert.ok(err.message.includes('nonexistent-node'))
})

// ── --node flag on run start ───────────────────────────────────────────────

test('run start: omitting --node defaults to local node (auto)', () => {
  const r = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey())
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const record = JSON.parse(r.stdout.trim()) as RunRecord
  assert.equal(record.node_id, 'local')
  assert.equal(record.node_selector, 'auto')
  vibe('run', 'stop', record.run_id)
})

test('run start --node auto: resolves to local', () => {
  const r = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--node', 'auto')
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const record = JSON.parse(r.stdout.trim()) as RunRecord
  assert.equal(record.node_id, 'local')
  assert.equal(record.node_selector, 'auto')
  vibe('run', 'stop', record.run_id)
})

test('run start --node local: sets node_id=local and node_selector=local', () => {
  const r = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--node', 'local')
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const record = JSON.parse(r.stdout.trim()) as RunRecord
  assert.equal(record.node_id, 'local')
  assert.equal(record.node_selector, 'local')
  vibe('run', 'stop', record.run_id)
})

test('run start --node unknown: exits 1 with node_not_found error', () => {
  const r = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--node', 'remote-xyz')
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}`)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'node_not_found')
  assert.ok(out.message.includes('remote-xyz'))
})

test('run start --agent unsupported: exits 1 with agent_not_supported error', () => {
  const r = vibe('run', 'start', '--agent', 'opencode', '--workspace-key', uniqueKey(), '--node', 'local')
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}`)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'agent_not_supported')
  assert.ok(out.message.includes('local'))
  assert.ok(out.message.includes('opencode'))
})

// ── --node flag on symphony start ─────────────────────────────────────────

test('symphony start --node auto: resolves to local', () => {
  const issueId = `sym-node-${Date.now()}`
  const r = vibe(
    'symphony', 'start',
    '--agent', 'mock',
    '--issue-id', issueId,
    '--workspace-key', issueId,
    '--node', 'auto',
    '--json',
  )
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const record = JSON.parse(r.stdout.trim()) as RunRecord
  assert.equal(record.node_id, 'local')
  assert.equal(record.node_selector, 'auto')
  assert.equal(record.metadata?.source, 'symphony')
  vibe('symphony', 'stop', record.run_id)
})
