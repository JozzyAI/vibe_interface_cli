/**
 * Personal local web viewer (`vibe run web`). CLI-level + in-process server
 * tests. Mock-only, throwaway VIBE_DIR — no real claude/codex/opencode and no
 * writes to the real ~/.vibe.
 *
 * The viewer is private (127.0.0.1) and read-only by default; the tmux-backed
 * assertions are skipped where tmux is unavailable (e.g. CI).
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { freshVibeDir } from './helpers/agent-fixtures.js'
import { validateBind, resolveWebTarget, startViewerServer } from '../src/lib/run-web.js'
import { appendEvent } from '../src/events.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

const VIBE_DIR = freshVibeDir('vibe-web-')
process.env.VIBE_DIR = VIBE_DIR

const TMUX_AVAILABLE = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

function vibe(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env, timeout: 15000 })
}
function uniqueKey() {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}
function startDetachedRun() {
  const env = { ...process.env, VIBE_MOCK_RUN_MS: '8000' }
  const r = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  const record = JSON.parse(r.stdout.trim())
  return { env, record }
}

after(() => {
  if (TMUX_AVAILABLE) spawnSync('tmux', ['kill-server'], { stdio: 'ignore' })
})

// ── unit: bind policy ───────────────────────────────────────────────────────

test('validateBind: loopback allowed, public refused without override', () => {
  assert.equal(validateBind('127.0.0.1', false).ok, true)
  assert.equal(validateBind('localhost', false).ok, true)
  assert.equal(validateBind('::1', false).ok, true)

  const refused = validateBind('0.0.0.0', false)
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false && refused.code, 'public_bind_refused')

  assert.equal(validateBind('0.0.0.0', true).ok, true, 'explicit override allows a public bind')
})

// ── CLI: structured error paths (no server started) ─────────────────────────

test('run web on an unknown run exits non-zero (run_not_found)', () => {
  const r = vibe({ ...process.env }, 'run', 'web', 'run_does_not_exist_xyz', '--json')
  assert.notEqual(r.status, 0)
})

test('run web on a detached PID run returns structured session_not_web_attachable', () => {
  const { env, record } = startDetachedRun()
  const r = vibe(env, 'run', 'web', record.run_id, '--json')
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'session_not_web_attachable')
  assert.match(out.message, /run stream|VIBE_USE_TMUX/)
  vibe(env, 'run', 'stop', record.run_id) // cleanup
})

test('run web refuses a public bind unless --allow-public-bind is given', () => {
  const { env, record } = startDetachedRun() // bind check runs before session resolution
  const r = vibe(env, 'run', 'web', record.run_id, '--host', '0.0.0.0', '--json')
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.code, 'public_bind_refused')
  vibe(env, 'run', 'stop', record.run_id) // cleanup
})

// ── in-process server: read-only, private, redacted (tmux-gated) ────────────

test('tmux run: viewer is private (127.0.0.1), read-only, and redacts secrets', { skip: !TMUX_AVAILABLE }, async () => {
  // Start a tmux-backed mock run so a live session exists.
  const env = { ...process.env, VIBE_USE_TMUX: '1', VIBE_MOCK_RUN_MS: '15000' }
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  const record = JSON.parse(start.stdout.trim())

  const target = resolveWebTarget(record.run_id)
  assert.equal(target.ok, true, 'tmux run resolves to a web target')
  if (!target.ok) return

  // A secret echoed into the run's output must never reach the browser. The
  // mock pane is empty, so the viewer falls back to the (redacted) event log.
  appendEvent({ type: 'log', run_id: record.run_id, session_id: record.session_id, stream: 'stdout', message: 'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ts: new Date().toISOString() })

  const server = await startViewerServer({ run_id: record.run_id, tmux_session: target.tmux_session, host: '127.0.0.1', port: 0 })
  try {
    // Private bind.
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'bound to loopback')

    // Read-only: GET allowed, mutating methods rejected; no shell exposed.
    const page = await fetch(`${server.url}/`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /read-only/, 'page advertises read-only')
    assert.doesNotMatch(html, /\/bin\/sh|xterm|websocket|sendKeys|send-keys/i, 'no interactive/shell affordance')

    const post = await fetch(`${server.url}/`, { method: 'POST' })
    assert.equal(post.status, 405, 'mutating method rejected')

    // Snapshot is JSON, read-only mode, with secrets scrubbed.
    const api = await fetch(`${server.url}/api/pane`)
    assert.equal(api.status, 200)
    const snap = await api.json() as { status: string; content: string; ended: boolean }
    assert.ok(['running', 'completed', 'stopped', 'failed', 'unknown'].includes(snap.status))
    assert.doesNotMatch(snap.content, /ghp_AAA/, 'raw secret must not appear')
    assert.match(snap.content, /\[REDACTED\]/, 'secret is redacted')
  } finally {
    await server.close()
    vibe(env, 'run', 'stop', record.run_id)
  }
})

test('tmux run: viewer keeps serving and reports ended after the session stops', { skip: !TMUX_AVAILABLE }, async () => {
  const env = { ...process.env, VIBE_USE_TMUX: '1', VIBE_MOCK_RUN_MS: '15000' }
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey(), '--json')
  const record = JSON.parse(start.stdout.trim())
  const target = resolveWebTarget(record.run_id)
  if (!target.ok) return assert.fail('expected web target')

  const server = await startViewerServer({ run_id: record.run_id, tmux_session: target.tmux_session, host: '127.0.0.1', port: 0 })
  try {
    vibe(env, 'run', 'stop', record.run_id) // tmux session goes away
    await new Promise((r) => setTimeout(r, 500))
    const api = await fetch(`${server.url}/api/pane`)
    assert.equal(api.status, 200, 'server still serving after session ended')
    const snap = await api.json() as { ended: boolean; status: string }
    assert.equal(snap.ended, true, 'viewer reports ended')
  } finally {
    await server.close()
  }
})

// ── isolation guard ─────────────────────────────────────────────────────────

test('all run records landed in the throwaway VIBE_DIR, not the real ~/.vibe', () => {
  assert.ok(VIBE_DIR.includes('vibe-web-'), 'using a throwaway VIBE_DIR')
  const realVibe = path.join(process.env.HOME ?? '/home', '.vibe')
  assert.ok(!VIBE_DIR.startsWith(realVibe), 'VIBE_DIR must not live under the real ~/.vibe')
})
