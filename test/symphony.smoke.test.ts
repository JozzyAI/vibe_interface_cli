/**
 * Symphony wrapper smoke tests.
 *
 * Validates that `vibe symphony start/stream/status/stop` correctly wraps
 * the underlying run contract with Symphony-specific metadata.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import type { RunRecord, RunEvent, StatusEvent, LogEvent, ApprovalRequiredEvent } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

function vibe(...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8' })
}

function vibeTimeout(...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', timeout: 15000 })
}

function uniqueIssue() {
  return `SYM-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function parseEvents(jsonl: string): RunEvent[] {
  return jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunEvent)
}

// ── symphony start ──────────────────────────────────────────────────────────

test('symphony start: returns valid RunRecord with symphony metadata', () => {
  const issueId = uniqueIssue()
  const r = vibe(
    'symphony', 'start',
    '--agent', 'mock',
    '--issue-id', issueId,
    '--issue-title', 'Test issue title',
    '--workspace-key', issueId,
    '--json',
  )
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  assert.equal(r.stdout.trim().split('\n').length, 1, 'stdout is exactly one line')
  assert.equal(r.stderr.trim(), '', 'no stderr on success')

  const record = JSON.parse(r.stdout.trim()) as RunRecord
  assert.ok(record.run_id, 'has run_id')
  assert.ok(record.session_id, 'has session_id')
  assert.ok(record.node_id, 'has node_id')
  assert.equal(record.status, 'running')
  assert.equal(record.agent, 'mock')
  assert.equal(record.metadata?.source, 'symphony', 'metadata.source is symphony')
  assert.equal(record.metadata?.issue_id, issueId, 'metadata.issue_id matches')
  assert.equal(record.metadata?.issue_title, 'Test issue title', 'metadata.issue_title matches')
})

test('symphony start: workspace-key defaults to issue-id', () => {
  const issueId = uniqueIssue()
  const r = vibe('symphony', 'start', '--agent', 'mock', '--issue-id', issueId, '--json')
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const record = JSON.parse(r.stdout.trim()) as RunRecord
  assert.ok(record.workspace_path.endsWith(issueId), `workspace_path ends with issue_id: ${record.workspace_path}`)
  // stop to clean up
  vibe('symphony', 'stop', record.run_id)
})

// ── symphony stream ─────────────────────────────────────────────────────────

test('symphony: full lifecycle — start → stream → status', () => {
  const issueId = uniqueIssue()

  // start
  const startR = vibe(
    'symphony', 'start',
    '--agent', 'mock',
    '--issue-id', issueId,
    '--issue-title', 'Refactor auth module',
    '--workspace-key', issueId,
    '--json',
  )
  assert.equal(startR.status, 0)
  const record = JSON.parse(startR.stdout.trim()) as RunRecord
  const { run_id } = record

  // stream
  const streamR = vibeTimeout('symphony', 'stream', run_id, '--jsonl')
  assert.equal(streamR.status, 0, `stream stderr: ${streamR.stderr}`)

  const events = parseEvents(streamR.stdout)
  assert.ok(events.length >= 4, `expected ≥4 events, got ${events.length}`)

  for (const e of events) {
    assert.ok(e.type, 'event.type required')
    assert.equal(e.run_id, run_id, 'event.run_id matches')
    assert.ok(e.ts, 'event.ts required')
  }

  const statusEvents = events.filter((e) => e.type === 'status') as StatusEvent[]
  const logEvents = events.filter((e) => e.type === 'log') as LogEvent[]
  const approvalEvents = events.filter((e) => e.type === 'approval_required') as ApprovalRequiredEvent[]

  assert.ok(statusEvents.find((e) => e.status === 'running'), 'has status:running')
  assert.ok(logEvents.length >= 1, 'has log events')
  assert.ok(approvalEvents.length >= 1, 'has approval_required event')
  assert.ok(approvalEvents[0].approval_id, 'approval has approval_id')

  const last = events[events.length - 1]
  assert.equal(last.type, 'status')
  assert.equal((last as StatusEvent).status, 'completed')

  // status
  const statusR = vibe('symphony', 'status', run_id, '--json')
  assert.equal(statusR.status, 0)
  const final = JSON.parse(statusR.stdout.trim()) as RunRecord
  assert.equal(final.run_id, run_id)
  assert.equal(final.status, 'completed')
  assert.equal(final.metadata?.source, 'symphony')
  assert.equal(statusR.stderr.trim(), '')
})

// ── symphony stop ───────────────────────────────────────────────────────────

test('symphony stop: mid-run → status stopped', () => {
  const issueId = uniqueIssue()
  const startR = vibe(
    'symphony', 'start',
    '--agent', 'mock',
    '--issue-id', issueId,
    '--workspace-key', issueId,
  )
  assert.equal(startR.status, 0)
  const { run_id } = JSON.parse(startR.stdout.trim()) as RunRecord

  const stopR = vibe('symphony', 'stop', run_id, '--reason', 'user cancelled', '--json')
  assert.equal(stopR.status, 0, `stop stderr: ${stopR.stderr}`)
  const stopped = JSON.parse(stopR.stdout.trim()) as RunRecord
  assert.equal(stopped.status, 'stopped')

  const statusR = vibe('symphony', 'status', run_id, '--json')
  const final = JSON.parse(statusR.stdout.trim()) as RunRecord
  assert.equal(final.status, 'stopped')
})

// ── permission_mode ─────────────────────────────────────────────────────────

test('symphony start: permission_mode stored in record when passed', () => {
  const issueId = uniqueIssue()
  const r = vibe(
    'symphony', 'start',
    '--agent', 'mock',
    '--issue-id', issueId,
    '--workspace-key', issueId,
    '--permission-mode', 'unsafe-skip',
    '--json',
  )
  assert.equal(r.status, 0)
  const record = JSON.parse(r.stdout.trim()) as RunRecord
  assert.equal(record.permission_mode, 'unsafe-skip')
  vibe('symphony', 'stop', record.run_id)
})

test('run start: permission_mode stored in record when passed', () => {
  const r = vibe(
    'run', 'start',
    '--agent', 'mock',
    '--workspace-key', `pm-test-${Date.now()}`,
    '--permission-mode', 'unsafe-skip',
    '--json',
  )
  assert.equal(r.status, 0)
  const record = JSON.parse(r.stdout.trim()) as RunRecord
  assert.equal(record.permission_mode, 'unsafe-skip')
  vibe('run', 'stop', record.run_id)
})
