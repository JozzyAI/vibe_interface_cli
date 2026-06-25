/**
 * Guard suite: the test environment must never be able to spawn a real (paid)
 * agent CLI. These tests assert the invariants that the shared
 * helpers/agent-fixtures.ts machinery relies on, so that a regression (e.g. a
 * new test that runs `--agent claude-code` on the inherited PATH) is caught.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import {
  FIXTURES,
  FAKED_AGENT_BINARIES,
  fixturesFirstPath,
  fakeAgentEnv,
} from './helpers/agent-fixtures.js'

/**
 * Resolve `name` against a PATH string the way exec/spawn would: the first
 * directory holding an executable regular file wins. Returns null if unresolved.
 */
function resolveOnPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* not in this dir — keep looking */
    }
  }
  return null
}

test('every faked agent binary exists in FIXTURES and is executable', () => {
  for (const bin of FAKED_AGENT_BINARIES) {
    const p = path.join(FIXTURES, bin)
    assert.ok(fs.existsSync(p), `missing fixture: ${p}`)
    assert.doesNotThrow(
      () => fs.accessSync(p, fs.constants.X_OK),
      `${bin} fixture is not executable`,
    )
  }
})

test('on a fixtures-first PATH, claude/codex resolve INTO FIXTURES (real installs are shadowed)', () => {
  const pathEnv = fixturesFirstPath()
  for (const bin of FAKED_AGENT_BINARIES) {
    const resolved = resolveOnPath(bin, pathEnv)
    assert.ok(resolved, `${bin} did not resolve on the fixtures-first PATH`)
    assert.equal(
      path.dirname(resolved!),
      FIXTURES,
      `${bin} resolved to ${resolved} — a REAL install would be spawned, not the fake fixture`,
    )
  }
})

test('fakeAgentEnv isolates VIBE_DIR away from the real ~/.vibe and keeps PATH fixtures-first', () => {
  const env = fakeAgentEnv()
  const realVibe = path.join(process.env.HOME ?? '/home', '.vibe')

  assert.ok(env.VIBE_DIR, 'VIBE_DIR is set')
  assert.notEqual(env.VIBE_DIR, realVibe, 'VIBE_DIR must not be the real ~/.vibe')
  assert.ok(
    !String(env.VIBE_DIR).startsWith(realVibe),
    `VIBE_DIR (${env.VIBE_DIR}) must not live under the real ~/.vibe`,
  )
  assert.ok(
    String(env.PATH).startsWith(FIXTURES + path.delimiter),
    'PATH must be fixtures-first so fake agents shadow real ones',
  )
})
