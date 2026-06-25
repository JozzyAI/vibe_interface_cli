/**
 * Runner router tests — pure unit tests (no spawning, no real agents), plus a
 * thin CLI integration layer that proves `--agent auto` is actually wired up,
 * using fake `claude`/`codex` fixtures on PATH (never real binaries) to
 * control availability deterministically.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AgentBackend } from '../src/types.js'

test('selectRunner: explicit backend is returned as-is, never probed', async () => {
  const { selectRunner } = await import('../src/runtime/router.js')
  const probed: AgentBackend[] = []
  const isAvailable = (a: AgentBackend) => { probed.push(a); return false }

  const result = selectRunner('claude-code', isAvailable)
  assert.deepEqual(result, { ok: true, agent: 'claude-code', tried: [] })
  assert.deepEqual(probed, [], 'explicit request never calls the availability check')
})

test('selectRunner: auto uses the priority order, picks the first available', async () => {
  const { selectRunner } = await import('../src/runtime/router.js')
  const priority: AgentBackend[] = ['claude-code', 'codex', 'opencode', 'mock']
  const available = new Set<AgentBackend>(['codex', 'opencode', 'mock'])

  const result = selectRunner('auto', (a) => available.has(a), priority)
  assert.equal(result.ok, true)
  assert.ok(result.ok && result.agent === 'codex', 'skips claude-code (unavailable), picks codex (first available)')
  assert.ok(result.ok && JSON.stringify(result.tried) === JSON.stringify(['claude-code', 'codex']), 'stops probing once it finds one')
})

test('selectRunner: claude-code unavailable falls back to codex', async () => {
  const { selectRunner } = await import('../src/runtime/router.js')
  const available = new Set<AgentBackend>(['codex'])

  const result = selectRunner('auto', (a) => available.has(a))
  assert.equal(result.ok, true)
  assert.ok(result.ok && result.agent === 'codex')
})

test('selectRunner: codex unavailable too falls back to opencode', async () => {
  const { selectRunner } = await import('../src/runtime/router.js')
  const available = new Set<AgentBackend>(['opencode', 'mock'])

  const result = selectRunner('auto', (a) => available.has(a))
  assert.equal(result.ok, true)
  assert.ok(result.ok && result.agent === 'opencode')
})

test('selectRunner: claude-code, codex, and opencode all unavailable falls back to mock', async () => {
  const { selectRunner } = await import('../src/runtime/router.js')
  const available = new Set<AgentBackend>(['mock'])

  const result = selectRunner('auto', (a) => available.has(a))
  assert.equal(result.ok, true)
  assert.ok(result.ok && result.agent === 'mock')
})

test('selectRunner: all unavailable (including mock) returns structured no_runner_available', async () => {
  const { selectRunner, DEFAULT_RUNNER_PRIORITY } = await import('../src/runtime/router.js')

  const result = selectRunner('auto', () => false)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'no_runner_available')
    assert.ok(result.message.length > 0)
    assert.deepEqual(result.tried, DEFAULT_RUNNER_PRIORITY, 'tried every backend in priority order before giving up')
  }
})

test('selectRunner: honors a custom priority order', async () => {
  const { selectRunner } = await import('../src/runtime/router.js')
  const available = new Set<AgentBackend>(['mock', 'codex'])

  // mock first in this custom priority — should win even though codex is also available
  const result = selectRunner('auto', (a) => available.has(a), ['mock', 'codex'])
  assert.equal(result.ok, true)
  assert.ok(result.ok && result.agent === 'mock')
})

// ── defaultAvailability: real binary-presence check, no real agent invoked ──

test('defaultAvailability: mock is always available', async () => {
  const { defaultAvailability } = await import('../src/runtime/router.js')
  assert.equal(defaultAvailability('mock'), true)
})

test('defaultAvailability: claude-code/codex/opencode reflect real PATH presence', async () => {
  const { defaultAvailability } = await import('../src/runtime/router.js')
  // Whatever the truth is on this machine, it must be a boolean and must not throw.
  assert.equal(typeof defaultAvailability('claude-code'), 'boolean')
  assert.equal(typeof defaultAvailability('codex'), 'boolean')
  assert.equal(typeof defaultAvailability('opencode'), 'boolean')
})

// ── CLI integration: `--agent auto` is actually wired up ────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures')

const VIBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-router-'))

function uniqueKey() {
  return `router-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// PATH with the fake claude/codex fixtures — makes claude-code "available".
function envWithFixtures(): NodeJS.ProcessEnv {
  return { ...process.env, VIBE_DIR, PATH: FIXTURES + path.delimiter + process.env.PATH }
}

// PATH with neither fixture nor any real agent CLI — only mock is "available".
function envWithoutAgents(): NodeJS.ProcessEnv {
  const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-router-empty-bin-'))
  return { ...process.env, VIBE_DIR, PATH: emptyBinDir }
}

test('CLI: run start --agent auto picks claude-code when its CLI is on PATH', () => {
  const r = spawnSync(NODE, [CLI, 'run', 'start', '--agent', 'auto', '--workspace-key', uniqueKey(), '--json'], {
    encoding: 'utf8', env: envWithFixtures(),
  })
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const record = JSON.parse(r.stdout.trim())
  assert.equal(record.agent, 'claude-code')
  spawnSync(NODE, [CLI, 'run', 'stop', record.run_id], { encoding: 'utf8', env: envWithFixtures() })
})

test('CLI: run start --agent auto falls back to mock when no real agent CLI is on PATH', () => {
  const r = spawnSync(NODE, [CLI, 'run', 'start', '--agent', 'auto', '--workspace-key', uniqueKey(), '--json'], {
    encoding: 'utf8', env: envWithoutAgents(),
  })
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const record = JSON.parse(r.stdout.trim())
  assert.equal(record.agent, 'mock')
})

test('CLI: run start --agent claude-code (explicit) is unaffected by auto-routing', () => {
  const env = envWithoutAgents()
  const r = spawnSync(NODE, [CLI, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--json'], {
    encoding: 'utf8', env,
  })
  // Explicit request bypasses the router entirely — same behavior as before
  // this PR, even though claude-code's CLI isn't on PATH here.
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const record = JSON.parse(r.stdout.trim())
  assert.equal(record.agent, 'claude-code')
  spawnSync(NODE, [CLI, 'run', 'stop', record.run_id], { encoding: 'utf8', env })
})
