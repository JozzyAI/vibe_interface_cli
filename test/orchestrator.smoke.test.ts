/**
 * Fake orchestrator smoke test.
 *
 * Simulates what Symphony (or any orchestrator) would do:
 *   1. vibe run start  → get run_id
 *   2. vibe run stream → consume JSONL until terminal event
 *   3. vibe run status → confirm final state
 *
 * Validates the full mock lifecycle end-to-end:
 *   queued/running → logs → approval_required → completed
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

function uniqueKey() {
  return `symphony-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function parseEvents(jsonl: string): RunEvent[] {
  return jsonl
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent)
}

test('fake orchestrator: full mock lifecycle — start → stream → status', () => {
  // ── Step 1: Start ──────────────────────────────────────────────────────
  const startResult = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  assert.equal(startResult.status, 0, `start failed: ${startResult.stderr}`)
  assert.equal(startResult.stdout.trim().split('\n').length, 1, 'stdout must be exactly one line')

  const record = JSON.parse(startResult.stdout.trim()) as RunRecord
  const { run_id } = record

  assert.ok(run_id, 'run_id present')
  assert.ok(record.session_id, 'session_id present')
  assert.ok(record.node_id, 'node_id present')
  assert.equal(record.status, 'running')
  assert.equal(record.agent, 'mock')
  assert.equal(startResult.stderr.trim(), '', 'no stderr on success')

  // ── Step 2: Stream ─────────────────────────────────────────────────────
  const streamResult = vibeTimeout('run', 'stream', run_id, '--jsonl')
  assert.equal(streamResult.status, 0, `stream failed: ${streamResult.stderr}`)

  const events = parseEvents(streamResult.stdout)
  assert.ok(events.length >= 4, `expected ≥4 events, got ${events.length}`)

  // all events must be valid JSONL
  for (const event of events) {
    assert.ok(event.type, 'event.type required')
    assert.equal(event.run_id, run_id, 'event.run_id matches')
    assert.ok(event.ts, 'event.ts required')
    assert.ok(event.ts.includes('T'), 'event.ts is ISO format')
  }

  // ── Lifecycle ordering checks ──────────────────────────────────────────

  const statusEvents = events.filter((e) => e.type === 'status') as StatusEvent[]
  const logEvents = events.filter((e) => e.type === 'log') as LogEvent[]
  const approvalEvents = events.filter((e) => e.type === 'approval_required') as ApprovalRequiredEvent[]

  // must have a running status event
  const runningEvent = statusEvents.find((e) => e.status === 'running')
  assert.ok(runningEvent, 'has status:running event')

  // must have log events
  assert.ok(logEvents.length >= 1, 'has at least one log event')
  for (const log of logEvents) {
    assert.ok(log.message, 'log event has message')
    assert.ok(['stdout', 'stderr'].includes(log.stream), 'log event has valid stream')
  }

  // must have approval_required event with approval_id
  assert.ok(approvalEvents.length >= 1, 'has approval_required event')
  assert.ok(approvalEvents[0].approval_id, 'approval has approval_id')
  assert.ok(approvalEvents[0].message, 'approval has message')

  // last event must be terminal
  const last = events[events.length - 1]
  assert.equal(last.type, 'status', 'last event is status')
  const lastStatus = (last as StatusEvent).status
  assert.ok(
    ['completed', 'failed', 'stopped', 'cancelled'].includes(lastStatus),
    `last status is terminal: ${lastStatus}`,
  )
  assert.equal(lastStatus, 'completed', 'mock run completes successfully')

  // running comes before completed
  const runningIdx = events.indexOf(runningEvent!)
  const completedIdx = events.findIndex(
    (e) => e.type === 'status' && (e as StatusEvent).status === 'completed',
  )
  assert.ok(runningIdx < completedIdx, 'running precedes completed')

  // approval comes before completed
  const approvalIdx = events.indexOf(approvalEvents[0])
  assert.ok(approvalIdx < completedIdx, 'approval_required precedes completed')

  // ── Step 3: Status ─────────────────────────────────────────────────────
  const statusResult = vibe('run', 'status', run_id, '--json')
  assert.equal(statusResult.status, 0, `status failed: ${statusResult.stderr}`)
  assert.equal(statusResult.stdout.trim().split('\n').length, 1, 'stdout one line')

  const finalRecord = JSON.parse(statusResult.stdout.trim()) as RunRecord
  assert.equal(finalRecord.run_id, run_id)
  assert.equal(finalRecord.status, 'completed', 'final status is completed')
  assert.equal(statusResult.stderr.trim(), '', 'no stderr on status')
})

test('fake orchestrator: stop mid-run updates status to stopped', () => {
  const startResult = vibe('run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  assert.equal(startResult.status, 0)
  const { run_id } = JSON.parse(startResult.stdout.trim()) as RunRecord

  // stop immediately before mock runner completes
  const stopResult = vibe('run', 'stop', run_id, '--json')
  assert.equal(stopResult.status, 0, `stop failed: ${stopResult.stderr}`)
  const stopped = JSON.parse(stopResult.stdout.trim()) as RunRecord
  assert.equal(stopped.status, 'stopped')

  // status confirms stopped
  const statusResult = vibe('run', 'status', run_id, '--json')
  const final = JSON.parse(statusResult.stdout.trim()) as RunRecord
  assert.equal(final.status, 'stopped')
})
