import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

function vibe(...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8' })
}

function vibeTimeout(...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', timeout: 15000 })
}

function uniqueKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ── start ──────────────────────────────────────────────────────────────────

test('run start returns valid RunRecord JSON', () => {
  const r = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey('t'), '--json')
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  assert.equal(r.stdout.trim().split('\n').length, 1, 'stdout is exactly one line')
  const record = JSON.parse(r.stdout.trim())
  assert.ok(record.run_id, 'has run_id')
  assert.ok(record.session_id, 'has session_id')
  assert.ok(record.node_id, 'has node_id')
  assert.equal(record.status, 'running')
})

test('run start stdout is valid JSON (no extra text)', () => {
  const r = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey('t'))
  assert.equal(r.status, 0)
  // must parse without error
  JSON.parse(r.stdout.trim())
  // no output to stderr on success
  assert.equal(r.stderr.trim(), '')
})

test('run start rejects path traversal', () => {
  const r = vibe('run', 'start', '--agent', 'mock', '--workspace-key', '../../etc/passwd')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /workspace_root|workspace_path/)
  assert.equal(r.stdout.trim(), '')
})

test('run start claude-code: returns valid running RunRecord immediately', () => {
  // claude-code now spawns a real runner; start itself always exits 0 with JSON
  const r = vibe('run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey('stub'))
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const record = JSON.parse(r.stdout.trim())
  assert.equal(record.agent, 'claude-code')
  assert.ok(['queued', 'running'].includes(record.status))
  // clean up — stop the detached runner
  vibe('run', 'stop', record.run_id)
})

// ── stream ─────────────────────────────────────────────────────────────────

test('run stream exits after terminal event', () => {
  const start = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey('t'))
  const { run_id } = JSON.parse(start.stdout.trim())

  const r = vibeTimeout('run', 'stream', run_id, '--jsonl')
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const lines = r.stdout.trim().split('\n').filter(Boolean)
  assert.ok(lines.length > 0)

  const last = JSON.parse(lines[lines.length - 1])
  assert.equal(last.type, 'status')
  assert.ok(['completed', 'failed', 'stopped'].includes(last.status), `got: ${last.status}`)
})

test('run stream stdout is valid JSONL — all lines parse, all have run_id + ts', () => {
  const start = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey('t'))
  const { run_id } = JSON.parse(start.stdout.trim())

  const r = vibeTimeout('run', 'stream', run_id, '--jsonl')
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  for (const line of lines) {
    const event = JSON.parse(line)
    assert.ok(event.type, `event missing type: ${line}`)
    assert.ok(event.run_id, `event missing run_id: ${line}`)
    assert.ok(event.ts, `event missing ts: ${line}`)
  }
})

test('run stream events include approval_required with approval_id', () => {
  const start = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey('t'))
  const { run_id } = JSON.parse(start.stdout.trim())

  const r = vibeTimeout('run', 'stream', run_id, '--jsonl')
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  const events = lines.map((l) => JSON.parse(l))

  const approval = events.find((e) => e.type === 'approval_required')
  assert.ok(approval, 'has approval_required event')
  assert.ok(approval.approval_id, 'approval has approval_id')
  assert.ok(approval.message, 'approval has message')
})

// ── status ─────────────────────────────────────────────────────────────────

test('run status returns completed after runner finishes', () => {
  const start = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey('t'))
  const { run_id } = JSON.parse(start.stdout.trim())

  vibeTimeout('run', 'stream', run_id) // wait for terminal event

  const r = vibe('run', 'status', run_id, '--json')
  assert.equal(r.status, 0)
  const record = JSON.parse(r.stdout.trim())
  assert.equal(record.status, 'completed')
})

test('run status stdout is valid JSON', () => {
  const start = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey('t'))
  const { run_id } = JSON.parse(start.stdout.trim())
  const r = vibe('run', 'status', run_id)
  assert.equal(r.status, 0)
  JSON.parse(r.stdout.trim())
  assert.equal(r.stdout.trim().split('\n').length, 1)
})

test('run status exits non-zero for unknown run_id', () => {
  const r = vibe('run', 'status', 'run_does_not_exist_xyz')
  assert.notEqual(r.status, 0)
  assert.equal(r.stdout.trim(), '')
})

// ── stop ───────────────────────────────────────────────────────────────────

test('run stop emits stopped event and returns updated record', () => {
  const start = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey('t'))
  const { run_id } = JSON.parse(start.stdout.trim())

  const r = vibe('run', 'stop', run_id, '--json')
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)

  const record = JSON.parse(r.stdout.trim())
  assert.equal(record.status, 'stopped')
  assert.equal(r.stdout.trim().split('\n').length, 1)
})

test('run stop stdout is valid JSON', () => {
  const start = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey('t'))
  const { run_id } = JSON.parse(start.stdout.trim())
  const r = vibe('run', 'stop', run_id)
  assert.equal(r.status, 0)
  JSON.parse(r.stdout.trim())
})
