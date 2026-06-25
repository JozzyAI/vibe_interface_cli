/**
 * Mock adapter tests — success, failure, long-running, and quota/auth/
 * command_not_found simulation. CLI-level (spawns the real CLI with
 * --agent mock; no real claude/codex/opencode ever invoked).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

function vibe(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env })
}
function vibeTimeout(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env, timeout: 15000 })
}
function uniqueKey() {
  return `mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// ── success ──────────────────────────────────────────────────────────────────

test('mock success: completes with the full event sequence', () => {
  const env = { ...process.env }
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  const { run_id } = JSON.parse(start.stdout.trim())

  const r = vibeTimeout(env, 'run', 'stream', run_id, '--jsonl')
  const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

  assert.ok(events.some((e) => e.type === 'log'))
  assert.ok(events.some((e) => e.type === 'approval_required'))
  const last = events[events.length - 1]
  assert.equal(last.type, 'status')
  assert.equal(last.status, 'completed')
})

// ── failure ──────────────────────────────────────────────────────────────────

test('mock failure: VIBE_MOCK_FAIL_REASON drives a classified, terminal failure', () => {
  const env = { ...process.env, VIBE_MOCK_FAIL_REASON: 'usage_limit' }
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  const { run_id } = JSON.parse(start.stdout.trim())

  const r = vibeTimeout(env, 'run', 'stream', run_id, '--jsonl')
  const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

  const error = events.find((e) => e.type === 'error')
  assert.ok(error, 'has an error event')
  assert.match(error.message, /usage limit/)

  const last = events[events.length - 1]
  assert.equal(last.type, 'status')
  assert.equal(last.status, 'failed')
})

// ── long-running mode ────────────────────────────────────────────────────────

test('mock long-running mode: VIBE_MOCK_RUN_MS stretches time-to-terminal, status is "running" mid-flight', async () => {
  const env = { ...process.env, VIBE_MOCK_RUN_MS: '3000' }
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  const { run_id } = JSON.parse(start.stdout.trim())

  // Well before the 3s run completes, status must still be non-terminal.
  await new Promise((resolve) => setTimeout(resolve, 300))
  const mid = vibe(env, 'run', 'status', run_id, '--json')
  const midRecord = JSON.parse(mid.stdout.trim())
  assert.equal(midRecord.status, 'running')

  const r = vibeTimeout(env, 'run', 'stream', run_id, '--jsonl')
  const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const last = events[events.length - 1]
  assert.equal(last.status, 'completed')
})

test('mock long-running mode: VIBE_MOCK_RUN_MS=0 completes immediately', () => {
  const env = { ...process.env, VIBE_MOCK_RUN_MS: '0' }
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  const { run_id } = JSON.parse(start.stdout.trim())

  const r = vibeTimeout(env, 'run', 'stream', run_id, '--jsonl')
  const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const last = events[events.length - 1]
  assert.equal(last.status, 'completed')
})

// ── quota / auth / command_not_found simulation ─────────────────────────────

for (const [reason, expectedPattern] of [
  ['quota_exceeded', /quota exceeded/],
  ['auth_expired', /credential paths are exhausted/],
  ['command_not_found', /CLI not found in PATH/],
] as const) {
  test(`mock ${reason} simulation matches the real classifier pattern`, async () => {
    const { classifyFailure } = await import('../src/runtime/classify.js')
    const env = { ...process.env, VIBE_MOCK_FAIL_REASON: reason }
    const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
    const { run_id } = JSON.parse(start.stdout.trim())

    const r = vibeTimeout(env, 'run', 'stream', run_id, '--jsonl')
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const error = events.find((e) => e.type === 'error')

    assert.match(error.message, expectedPattern)
    assert.equal(classifyFailure(error.message).reason, reason)
  })
}
