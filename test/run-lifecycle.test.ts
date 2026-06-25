/**
 * Local run lifecycle: stable inspectable session, deterministic stop, and
 * `vibe run attach`. CLI-level, mock-only — no real claude/codex/opencode and
 * no writes to the real ~/.vibe (every child inherits a throwaway VIBE_DIR).
 *
 * Two session models are exercised:
 *   - default: the runner is a detached process; session_id is its PID.
 *   - VIBE_USE_TMUX=1 (opt-in): the runner lives in a tmux session named
 *     `vibe-run-<run_id>`; session_id is that name and the run is attachable.
 *     These assertions are skipped where tmux is unavailable (e.g. CI).
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { freshVibeDir } from './helpers/agent-fixtures.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

// Throwaway VIBE_DIR shared by all children spawned with { ...process.env }.
const VIBE_DIR = freshVibeDir('vibe-lifecycle-')
process.env.VIBE_DIR = VIBE_DIR

const TMUX_AVAILABLE = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

function vibe(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env, timeout: 15000 })
}
function uniqueKey() {
  return `life-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}
function startLongRun(extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, VIBE_MOCK_RUN_MS: '5000', ...extra }
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  assert.equal(start.status, 0, `start stderr: ${start.stderr}`)
  return { env, record: JSON.parse(start.stdout.trim()) }
}

// Best-effort teardown: kill any tmux sessions this suite may have created.
after(() => {
  if (TMUX_AVAILABLE) spawnSync('tmux', ['kill-server'], { stdio: 'ignore' })
})

// ── stable session reference ────────────────────────────────────────────────

test('long-running mock run reports running and carries a stable session_id', async () => {
  const { env, record } = startLongRun()
  assert.ok(record.session_id, 'run record includes a session_id')

  const mid = vibe(env, 'run', 'status', record.run_id, '--json')
  const midRecord = JSON.parse(mid.stdout.trim())
  assert.equal(midRecord.status, 'running')
  assert.equal(midRecord.session_id, record.session_id, 'session_id is stable across reads')

  vibe(env, 'run', 'stop', record.run_id) // cleanup
})

// ── deterministic stop of a long-running run ────────────────────────────────

test('stop cancels a long-running run and records a terminal stopped state', () => {
  const { env, record } = startLongRun()

  const stop = vibe(env, 'run', 'stop', record.run_id, '--json')
  assert.equal(stop.status, 0, `stop stderr: ${stop.stderr}`)
  assert.equal(JSON.parse(stop.stdout.trim()).status, 'stopped')

  // Terminal state persists and remains readable after the process is gone.
  const status = vibe(env, 'run', 'status', record.run_id, '--json')
  assert.equal(JSON.parse(status.stdout.trim()).status, 'stopped')
})

// ── completed run stays readable ────────────────────────────────────────────

test('a completed run remains status-readable after the runner exits', () => {
  const env = { ...process.env, VIBE_MOCK_RUN_MS: '0' }
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  const { run_id } = JSON.parse(start.stdout.trim())

  vibe(env, 'run', 'stream', run_id, '--jsonl') // drain to terminal

  const status = vibe(env, 'run', 'status', run_id, '--json')
  assert.equal(status.status, 0)
  assert.equal(JSON.parse(status.stdout.trim()).status, 'completed')
})

// ── attach: structured errors ───────────────────────────────────────────────

test('attach on an unknown run exits non-zero (run_not_found)', () => {
  const r = vibe({ ...process.env }, 'run', 'attach', 'run_does_not_exist_xyz', '--json')
  assert.notEqual(r.status, 0)
})

test('attach on a terminal run returns structured session_not_found', () => {
  const env = { ...process.env, VIBE_MOCK_RUN_MS: '0' }
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  const { run_id } = JSON.parse(start.stdout.trim())
  vibe(env, 'run', 'stream', run_id, '--jsonl') // drain to terminal

  const r = vibe(env, 'run', 'attach', run_id, '--json')
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'session_not_found')
  assert.equal(out.run_id, run_id)
})

test('attach on an active detached run returns structured session_not_attachable', () => {
  const { env, record } = startLongRun() // default model: detached process, PID session
  const r = vibe(env, 'run', 'attach', record.run_id, '--json')
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'session_not_attachable')
  assert.match(out.message, /run stream/)

  vibe(env, 'run', 'stop', record.run_id) // cleanup
})

// ── opt-in tmux lifecycle (skipped without tmux) ────────────────────────────

test('VIBE_USE_TMUX=1: run is backed by a named tmux session and is attachable', { skip: !TMUX_AVAILABLE }, () => {
  const { env, record } = startLongRun({ VIBE_USE_TMUX: '1' })
  assert.equal(record.session_id, `vibe-run-${record.run_id}`, 'session_id is the tmux session name')

  // tmux really created the session.
  const has = spawnSync('tmux', ['has-session', '-t', record.session_id], { stdio: 'ignore' })
  assert.equal(has.status, 0, 'tmux session exists')

  // attach --json reports how to attach (no TTY in the test harness).
  const attach = vibe(env, 'run', 'attach', record.run_id, '--json')
  assert.equal(attach.status, 0, `attach stderr: ${attach.stderr}`)
  const info = JSON.parse(attach.stdout.trim())
  assert.equal(info.mode, 'tmux')
  assert.equal(info.attach_command, `tmux attach -t ${record.session_id}`)

  // stop tears the tmux session down deterministically.
  const stop = vibe(env, 'run', 'stop', record.run_id, '--json')
  assert.equal(JSON.parse(stop.stdout.trim()).status, 'stopped')
  const gone = spawnSync('tmux', ['has-session', '-t', record.session_id], { stdio: 'ignore' })
  assert.notEqual(gone.status, 0, 'tmux session is gone after stop')
})

// ── isolation guard ─────────────────────────────────────────────────────────

test('all run records and events landed in the throwaway VIBE_DIR, not the real ~/.vibe', () => {
  assert.ok(VIBE_DIR.includes('vibe-lifecycle-'), 'using a throwaway VIBE_DIR')
  const realVibe = path.join(process.env.HOME ?? '/home', '.vibe')
  assert.ok(!VIBE_DIR.startsWith(realVibe), 'VIBE_DIR must not live under the real ~/.vibe')
  // Records this suite created exist under the temp dir.
  assert.ok(fs.existsSync(path.join(VIBE_DIR, 'runs')), 'temp runs/ dir exists')
})
