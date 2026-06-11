/**
 * Claude Code backend tests.
 * Uses a fake claude binary from test/fixtures/ injected via PATH.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { RunRecord, RunEvent, StatusEvent, LogEvent, PrCreatedEvent } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
// fixtures live in test/fixtures/ (source), not in dist/test/fixtures/
const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures')

// PATH with fake claude first
const fakeClaudePath = { ...process.env, PATH: FIXTURES + ':' + process.env.PATH }
// PATH without any claude
const noClaudePath = { ...process.env, PATH: '/tmp' }

function vibe(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env })
}

function vibeTimeout(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env, timeout: 15000 })
}

function uniqueKey() {
  return `cc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function promptFile(content: string): string {
  const p = path.join(os.tmpdir(), `vibe-test-prompt-${Date.now()}.md`)
  fs.writeFileSync(p, content)
  return p
}

function parseEvents(jsonl: string): RunEvent[] {
  return jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunEvent)
}

// ── Missing binary ─────────────────────────────────────────────────────────

test('claude-code: missing binary emits agent_binary_not_found error and status failed', () => {
  const pf = promptFile('say hello')
  const start = vibe(noClaudePath, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  // stream — will see error + failed status
  const stream = vibeTimeout(noClaudePath, 'run', 'stream', run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  const errorEvent = events.find((e) => e.type === 'error')
  assert.ok(errorEvent, 'has error event')
  assert.match((errorEvent as { message: string }).message, /not found|spawn/)

  const terminalEvent = events.find((e) => e.type === 'status' && (e as StatusEvent).status === 'failed')
  assert.ok(terminalEvent, 'has status:failed terminal event')

  // status must be failed
  const status = vibe(noClaudePath, 'run', 'status', run_id)
  const record = JSON.parse(status.stdout.trim()) as RunRecord
  assert.equal(record.status, 'failed')
})

// ── Successful run ─────────────────────────────────────────────────────────

test('claude-code: fake claude exits 0 → completed with log events', () => {
  const pf = promptFile('write hello world in python')
  const start = vibe(fakeClaudePath, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)

  const record = JSON.parse(start.stdout.trim()) as RunRecord
  assert.equal(record.status, 'running')
  assert.equal(record.agent, 'claude-code')

  const stream = vibeTimeout(fakeClaudePath, 'run', 'stream', record.run_id, '--jsonl')
  assert.equal(stream.status, 0, `stream failed: ${stream.stderr}`)

  const events = parseEvents(stream.stdout)
  const logEvents = events.filter((e) => e.type === 'log') as LogEvent[]
  assert.ok(logEvents.length >= 1, `expected log events, got ${logEvents.length}`)
  assert.ok(logEvents[0].message, 'log has message')

  const last = events[events.length - 1]
  assert.equal(last.type, 'status')
  assert.equal((last as StatusEvent).status, 'completed')

  // Final status check
  const statusR = vibe(fakeClaudePath, 'run', 'status', record.run_id)
  const finalRecord = JSON.parse(statusR.stdout.trim()) as RunRecord
  assert.equal(finalRecord.status, 'completed')
})

// ── Failing run ────────────────────────────────────────────────────────────

test('claude-code: fake claude exits nonzero → status failed with error event', () => {
  const pf = promptFile('this will fail')
  const env = { ...fakeClaudePath, FAKE_CLAUDE_EXIT_CODE: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0)

  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord
  const stream = vibeTimeout(env, 'run', 'stream', run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  const errorEvent = events.find((e) => e.type === 'error')
  assert.ok(errorEvent, 'has error event')

  const last = events[events.length - 1]
  assert.equal((last as StatusEvent).status, 'failed')

  const status = vibe(env, 'run', 'status', run_id)
  assert.equal(JSON.parse(status.stdout.trim()).status, 'failed')
})

// ── Stop kills claude process ──────────────────────────────────────────────

test('claude-code: run stop kills long-running claude process', () => {
  const pf = promptFile('long task')
  const env = { ...fakeClaudePath, FAKE_CLAUDE_HANG: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0)

  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  // Wait briefly for runner to set child_pid
  spawnSync('sleep', ['0.5'])

  const stop = vibe(env, 'run', 'stop', run_id, '--json')
  assert.equal(stop.status, 0, `stop failed: ${stop.stderr}`)
  const stopped = JSON.parse(stop.stdout.trim()) as RunRecord
  assert.equal(stopped.status, 'stopped')
})

// ── PR detection ───────────────────────────────────────────────────────────

test('claude-code: PR URL in assistant text emits pr_created event', () => {
  const pf = promptFile('open a pr')
  const env = { ...fakeClaudePath, FAKE_CLAUDE_EXTRA_TEXT: 'Opened PR: https://github.com/JozzyAI/fin_bot/pull/4' }
  const start = vibe(env, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(env, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  const prEvent = events.find((e) => e.type === 'pr_created') as PrCreatedEvent | undefined
  assert.ok(prEvent, 'has pr_created event')
  assert.equal(prEvent!.url, 'https://github.com/JozzyAI/fin_bot/pull/4')

  const last = events[events.length - 1] as StatusEvent
  assert.equal(last.status, 'completed')
})

test('claude-code: PR URL in non-JSON stdout line emits pr_created event', () => {
  const pf = promptFile('open a pr')
  const env = { ...fakeClaudePath, FAKE_CLAUDE_RAW_LINE: 'Opened PR: https://github.com/JozzyAI/fin_bot/pull/5' }
  const start = vibe(env, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(env, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  const prEvent = events.find((e) => e.type === 'pr_created') as PrCreatedEvent | undefined
  assert.ok(prEvent, 'has pr_created event')
  assert.equal(prEvent!.url, 'https://github.com/JozzyAI/fin_bot/pull/5')
})

test('claude-code: no PR URL in output — no pr_created event', () => {
  const pf = promptFile('write hello world')
  const start = vibe(fakeClaudePath, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0)
  const record = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(fakeClaudePath, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  assert.ok(!events.some((e) => e.type === 'pr_created'), 'no pr_created event when no PR URL is present')
})

// ── stdout cleanliness ─────────────────────────────────────────────────────

test('claude-code: start stdout is exactly one valid JSON line', () => {
  const pf = promptFile('hello')
  const start = vibe(fakeClaudePath, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0)
  const lines = start.stdout.trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  JSON.parse(lines[0])
  assert.equal(start.stderr.trim(), '')
})

test('claude-code: stream stdout is valid JSONL (all lines parse)', () => {
  const pf = promptFile('hello')
  const start = vibe(fakeClaudePath, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(fakeClaudePath, 'run', 'stream', run_id, '--jsonl')
  const lines = stream.stdout.trim().split('\n').filter(Boolean)
  for (const line of lines) {
    const event = JSON.parse(line) as RunEvent
    assert.ok(event.type)
    assert.ok(event.run_id)
    assert.ok(event.ts)
  }
})
