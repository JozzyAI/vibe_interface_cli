/**
 * Run registry tests — direct unit tests against store.ts using an isolated
 * temp VIBE_DIR (the env var this codebase actually uses; there is no
 * VIBE_HOME). No CLI spawning, no relay, no real agents.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RunRecord } from '../src/types.js'

const VIBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-store-'))
process.env.VIBE_DIR = VIBE_DIR

function baseRecord(run_id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString()
  return {
    run_id,
    session_id: 'sess-1',
    node_id: 'local',
    agent: 'mock',
    status: 'queued',
    workspace_path: '/tmp/does-not-matter',
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

test('writeRun + readRun: round-trips a record', async () => {
  const { writeRun, readRun, generateRunId } = await import('../src/store.js')
  const run_id = generateRunId()
  writeRun(baseRecord(run_id))

  const read = readRun(run_id)
  assert.equal(read.run_id, run_id)
  assert.equal(read.status, 'queued')
  assert.equal(read.agent, 'mock')
})

test('updateRun: patches fields and bumps updated_at, status reads back the patch', async () => {
  const { writeRun, readRun, updateRun, generateRunId } = await import('../src/store.js')
  const run_id = generateRunId()
  const original = baseRecord(run_id)
  writeRun(original)

  await new Promise((resolve) => setTimeout(resolve, 5)) // ensure updated_at can differ
  const updated = updateRun(run_id, { status: 'running' })

  assert.equal(updated.status, 'running')
  assert.notEqual(updated.updated_at, original.updated_at)

  const reread = readRun(run_id)
  assert.equal(reread.status, 'running')
})

test('completed run remains readable with its terminal fields intact', async () => {
  const { writeRun, readRun, updateRun, generateRunId } = await import('../src/store.js')
  const run_id = generateRunId()
  writeRun(baseRecord(run_id, { status: 'running' }))

  updateRun(run_id, { status: 'completed', final_agent: 'mock', switched: false, exit_code: 0 })

  const record = readRun(run_id)
  assert.equal(record.status, 'completed')
  assert.equal(record.exit_code, 0)
  assert.equal(record.final_agent, 'mock')
})

test('failed run records exit_code and error', async () => {
  const { writeRun, readRun, updateRun, generateRunId } = await import('../src/store.js')
  const run_id = generateRunId()
  writeRun(baseRecord(run_id, { status: 'running' }))

  updateRun(run_id, {
    status: 'failed',
    final_agent: 'mock',
    failure_reason: 'quota_exceeded',
    recoverable: true,
    exit_code: 1,
    error: 'quota exceeded',
  })

  const record = readRun(run_id)
  assert.equal(record.status, 'failed')
  assert.equal(record.exit_code, 1)
  assert.equal(record.error, 'quota exceeded')
  assert.equal(record.failure_reason, 'quota_exceeded')
  assert.equal(record.recoverable, true)
})

test('cancelled run records correctly', async () => {
  const { writeRun, readRun, updateRun, generateRunId } = await import('../src/store.js')
  const run_id = generateRunId()
  writeRun(baseRecord(run_id, { status: 'running' }))

  updateRun(run_id, { status: 'cancelled' })

  const record = readRun(run_id)
  assert.equal(record.status, 'cancelled')
})

test('tryReadRun: returns the record when present, null when missing (never exits)', async () => {
  const { writeRun, tryReadRun, generateRunId } = await import('../src/store.js')
  const run_id = generateRunId()
  writeRun(baseRecord(run_id))

  assert.equal(tryReadRun(run_id)?.run_id, run_id)
  assert.equal(tryReadRun('run_does_not_exist_xyz'), null)
})

test('generateRunId: produces unique run_-prefixed ids', async () => {
  const { generateRunId } = await import('../src/store.js')
  const a = generateRunId()
  const b = generateRunId()
  assert.match(a, /^run_/)
  assert.match(b, /^run_/)
  assert.notEqual(a, b)
})

test('isolation: records live under this test\'s temp VIBE_DIR, not the real ~/.vibe', async () => {
  const { writeRun, generateRunId } = await import('../src/store.js')
  const run_id = generateRunId()
  writeRun(baseRecord(run_id))

  const expected = path.join(VIBE_DIR, 'runs', `${run_id}.json`)
  assert.ok(fs.existsSync(expected), `expected run file at ${expected}`)
})

test('writeRun redacts secret-shaped values before persisting to disk', async () => {
  const { writeRun, readRun, generateRunId } = await import('../src/store.js')
  const run_id = generateRunId()
  const sentinel = 'sk-supersecrettoken1234567890'
  writeRun(baseRecord(run_id, { metadata: { token: sentinel } }))

  const onDisk = fs.readFileSync(path.join(VIBE_DIR, 'runs', `${run_id}.json`), 'utf8')
  assert.ok(!onDisk.includes(sentinel), 'secret-shaped value must not appear verbatim on disk')

  const record = readRun(run_id)
  assert.notEqual((record.metadata as { token?: string } | undefined)?.token, sentinel)
})
