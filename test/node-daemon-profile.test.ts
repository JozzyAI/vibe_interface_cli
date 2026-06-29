/**
 * `vibe node daemon` reads the `vibe connect` profile for defaults.
 * Pure precedence resolver + CLI-level checks. Temp VIBE_PROFILE, no relay, no
 * real agents, no token value ever surfaced.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  resolveDaemonDefaults, loadProfile, profilePath, type NodeProfile,
} from '../src/lib/node-config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

const PROFILE: NodeProfile = {
  version: 1, display_name: 'work-laptop', relay_url: 'wss://profile-relay',
  token_file: '/profile/token', vibe_dir: '/profile/vibe', advertise_agents: ['mock'],
  node_id: 'node_abc',
}

function tmpFile(): string { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ndp-')), 'profile.json') }

// ── pure resolver: precedence CLI flag > env > profile > default ─────────────

test('profile fills daemon defaults and implies local mode', () => {
  const d = resolveDaemonDefaults({}, PROFILE, {})
  assert.equal(d.local, true, 'a profile implies local mode')
  assert.equal(d.relay, 'wss://profile-relay')
  assert.equal(d.tokenFile, '/profile/token')
  assert.deepEqual(d.advertiseAgents, ['mock'])
  assert.equal(d.vibeDir, '/profile/vibe')
})

test('CLI flags override the profile', () => {
  const d = resolveDaemonDefaults(
    { relay: 'wss://flag-relay', tokenFile: '/flag/token', advertiseAgent: ['claude-code'] },
    PROFILE, {},
  )
  assert.equal(d.relay, 'wss://flag-relay')
  assert.equal(d.tokenFile, '/flag/token')
  assert.deepEqual(d.advertiseAgents, ['claude-code'])
})

test('env vars override the profile (where env behavior exists)', () => {
  const d = resolveDaemonDefaults({}, PROFILE, {
    VIBE_DIR: '/env/vibe', VIBE_RELAY_TOKEN: 'env-secret', VIBE_NODE_ADVERTISE_AGENTS: 'mock',
  })
  // env present ⇒ don't inject the profile; downstream resolvers use the env value.
  assert.equal(d.advertiseAgents, undefined, 'env advertise beats profile')
  assert.equal(d.tokenFile, undefined, 'env token beats the profile token-file')
  assert.equal(d.vibeDir, undefined, 'env VIBE_DIR beats profile vibe_dir')
  assert.equal(d.relay, 'wss://profile-relay', 'no env for relay, so profile applies')
})

test('no profile preserves old behavior (nothing injected; --local still required)', () => {
  const withLocal = resolveDaemonDefaults({ local: true }, null, {})
  assert.deepEqual(withLocal, { local: true, relay: undefined, tokenFile: undefined, advertiseAgents: undefined, vibeDir: undefined })
  const withoutLocal = resolveDaemonDefaults({}, null, {})
  assert.equal(withoutLocal.local, false, 'no profile + no --local ⇒ not local')
})

test('resolver never surfaces a token value — only a token-file path', () => {
  const d = resolveDaemonDefaults({}, PROFILE, { VIBE_RELAY_TOKEN: 'super-secret-token' })
  assert.ok(!JSON.stringify(d).includes('super-secret-token'), 'token value never appears in the resolved defaults')
  assert.equal(d.tokenFile, undefined)
})

// ── profile location: VIBE_PROFILE override ──────────────────────────────────

test('loadProfile honors VIBE_PROFILE', () => {
  const p = tmpFile()
  fs.writeFileSync(p, JSON.stringify(PROFILE))
  const prev = process.env.VIBE_PROFILE
  process.env.VIBE_PROFILE = p
  try {
    assert.equal(profilePath(), p)
    assert.equal(loadProfile()?.relay_url, 'wss://profile-relay')
  } finally {
    if (prev === undefined) delete process.env.VIBE_PROFILE; else process.env.VIBE_PROFILE = prev
  }
})

// ── CLI-level: back-compat + proof the daemon reads the profile ──────────────

function vibe(args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env, timeout: 15000 })
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

test('no profile + no --local still errors (back-compat)', () => {
  const env = { ...process.env, VIBE_PROFILE: tmpFile() /* does not exist yet */ }
  delete (env as Record<string, string>).VIBE_DIR
  const r = vibe(['node', 'daemon'], env)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /--local flag is required/)
})

test('with a profile, `vibe node daemon` reads it (no --local needed) — proven via fail-fast', () => {
  // A profile with an invalid advertised agent: the daemon must (a) accept the bare
  // command as local because a profile exists, and (b) validate the profile's
  // advertised agents → fail fast BEFORE connecting (so the test never hangs).
  const p = tmpFile()
  fs.writeFileSync(p, JSON.stringify({ ...PROFILE, advertise_agents: ['totally-bogus-agent'] }))
  const env = { ...process.env, VIBE_PROFILE: p }
  delete (env as Record<string, string>).VIBE_NODE_ADVERTISE_AGENTS
  const r = vibe(['node', 'daemon'], env)
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stderr.trim()).code, 'advertise_agent_invalid', 'the daemon validated the profile advertised agents')
})
