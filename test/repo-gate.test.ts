/**
 * PR C1 — repo gate: allowlist wired into clone/reuse (workspace.ts), the
 * fail-closed pre-launch gate (supervisor.runRepoGate/shouldRepoGate), and a
 * `vibe run start` end-to-end check that a non-allowlisted / token-bearing repo
 * fails fast before any backend is spawned.
 *
 * No test clones a real remote (no network): positive reuse cases use a local
 * git repo whose `origin` is *set* to a github URL string, and the negative
 * cases fail before `git clone` ever runs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  cloneIfEmpty,
  checkWorkspaceRepoMatch,
  WorkspaceRepoMismatchError,
  RepoUrlCredentialsError,
} from '../src/workspace.js'
import { RepoNotAllowedError } from '../src/repo-policy.js'
import { runRepoGate, shouldRepoGate } from '../src/runtime/supervisor.js'
import type { RunRecord, RunEvent, ErrorEvent, StatusEvent, LogEvent } from '../src/types.js'
import type { AgentBackend } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TOKEN_SHAPE = /gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'ignore' })
}

/** A local git checkout whose `origin` is set to an arbitrary URL string (no
 *  network — origin is just stored config that readOriginUrl reads back). */
function repoWithOrigin(originUrl: string): string {
  const dir = tmpDir('vibe-gate-ws-')
  git(dir, 'init -q -b main')
  git(dir, 'config user.email test@example.com')
  git(dir, 'config user.name "Test User"')
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n')
  git(dir, 'add -A')
  git(dir, 'commit -q -m init')
  git(dir, `remote add origin ${originUrl}`)
  return dir
}

// ── Allowlist wired into clone/reuse (workspace.ts) ──────────────────────────

test('checkWorkspaceRepoMatch: existing clean JozzyAI workspace reuse passes', () => {
  const ws = repoWithOrigin('https://github.com/JozzyAI/fin_bot')
  assert.doesNotThrow(() => checkWorkspaceRepoMatch(ws, 'https://github.com/JozzyAI/fin_bot'))
})

test('checkWorkspaceRepoMatch: stale workspace remote mismatch still fails', () => {
  const ws = repoWithOrigin('https://github.com/JozzyAI/other_repo')
  assert.throws(
    () => checkWorkspaceRepoMatch(ws, 'https://github.com/JozzyAI/fin_bot'),
    WorkspaceRepoMismatchError,
  )
})

test('checkWorkspaceRepoMatch: non-allowlisted repoUrl is rejected (before git runs)', () => {
  const ws = tmpDir('vibe-gate-empty-')
  assert.throws(
    () => checkWorkspaceRepoMatch(ws, 'https://github.com/OtherOrg/repo'),
    RepoNotAllowedError,
  )
})

test('cloneIfEmpty: token-bearing repoUrl is rejected BEFORE the allowlist (RepoUrlCredentialsError, not RepoNotAllowedError)', () => {
  const ws = tmpDir('vibe-gate-token-')
  const token = 'ghs_' + 'C'.repeat(36)
  // JozzyAI owner but token-bearing: must throw the credentials error, proving
  // the clean-URL check runs before allowlist matching.
  assert.throws(
    () => cloneIfEmpty(ws, `https://${token}@github.com/JozzyAI/fin_bot.git`),
    RepoUrlCredentialsError,
  )
  assert.equal(fs.readdirSync(ws).length, 0, 'nothing cloned')
})

test('local filesystem repo paths still clone/reuse (allowlist does not govern them)', () => {
  // Build a local source repo and clone it into an empty workspace by path.
  const src = repoWithOrigin('https://github.com/JozzyAI/fin_bot') // reuse helper; we clone by path
  const ws = tmpDir('vibe-gate-local-')
  assert.doesNotThrow(() => cloneIfEmpty(ws, src))
  assert.ok(fs.existsSync(path.join(ws, 'README.md')), 'local clone succeeded')
})

// ── shouldRepoGate predicate ─────────────────────────────────────────────────

const rec = (repo_url?: string): RunRecord => ({ repo_url } as unknown as RunRecord)
const CHAIN_REAL: AgentBackend[] = ['claude-code']
const CHAIN_MOCK: AgentBackend[] = ['mock']

test('shouldRepoGate: true for a github remote + real agent; false otherwise', () => {
  assert.equal(shouldRepoGate(rec('https://github.com/JozzyAI/fin_bot'), CHAIN_REAL), true)
  assert.equal(shouldRepoGate(rec('https://github.com/JozzyAI/fin_bot'), CHAIN_MOCK), false, 'mock never pushes')
  assert.equal(shouldRepoGate(rec('/tmp/local'), CHAIN_REAL), false, 'non-github remote')
  assert.equal(shouldRepoGate(rec(undefined), CHAIN_REAL), false, 'no repo_url')
})

test('shouldRepoGate: disabled when VIBE_REPO_ALLOWLIST_ENFORCE=0', () => {
  const prev = process.env.VIBE_REPO_ALLOWLIST_ENFORCE
  process.env.VIBE_REPO_ALLOWLIST_ENFORCE = '0'
  try {
    assert.equal(shouldRepoGate(rec('https://github.com/JozzyAI/fin_bot'), CHAIN_REAL), false)
  } finally {
    if (prev === undefined) delete process.env.VIBE_REPO_ALLOWLIST_ENFORCE
    else process.env.VIBE_REPO_ALLOWLIST_ENFORCE = prev
  }
})

// ── runRepoGate (fail-closed pre-launch gate) ────────────────────────────────

test('runRepoGate: passes for allowlisted JozzyAI repo + empty workspace (fresh/relay case)', () => {
  const ws = tmpDir('vibe-gate-fresh-')
  const r = runRepoGate('https://github.com/JozzyAI/fin_bot', ws)
  assert.equal(r.ok, true)
})

test('runRepoGate: passes for allowlisted repo + matching clean origin', () => {
  const ws = repoWithOrigin('https://github.com/JozzyAI/fin_bot')
  const r = runRepoGate('https://github.com/JozzyAI/fin_bot', ws)
  assert.equal(r.ok, true)
})

test('runRepoGate: blocks a non-allowlisted repo_url before launch', () => {
  const ws = tmpDir('vibe-gate-bad-')
  const r = runRepoGate('https://github.com/OtherOrg/repo', ws)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'repo_not_allowed')
  assert.equal(r.code, 'repo_not_allowed')
  assert.doesNotMatch(r.message ?? '', TOKEN_SHAPE)
})

test('runRepoGate: blocks a token-bearing repo_url (credentials error, no token in message)', () => {
  const ws = tmpDir('vibe-gate-tok-')
  const token = 'ghp_' + 'D'.repeat(36)
  const r = runRepoGate(`https://${token}@github.com/JozzyAI/fin_bot.git`, ws)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'repo_not_allowed')
  assert.equal(r.code, 'repo_url_has_credentials')
  assert.doesNotMatch(r.message ?? '', TOKEN_SHAPE)
})

test('runRepoGate: blocks a stale workspace whose origin does not match the requested repo', () => {
  const ws = repoWithOrigin('https://github.com/JozzyAI/other_repo')
  const r = runRepoGate('https://github.com/JozzyAI/fin_bot', ws)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unknown_repo')
  assert.equal(r.code, 'workspace_repo_mismatch')
})

test('runRepoGate: blocks a token-bearing workspace origin remote (no token in message)', () => {
  const token = 'ghr_' + 'E'.repeat(36)
  const ws = repoWithOrigin(`https://${token}@github.com/JozzyAI/fin_bot.git`)
  const r = runRepoGate('https://github.com/JozzyAI/fin_bot', ws)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'repo_not_allowed')
  assert.equal(r.code, 'repo_url_has_credentials')
  assert.doesNotMatch(r.message ?? '', TOKEN_SHAPE)
})

test('runRepoGate: blocks a non-allowlisted workspace origin remote', () => {
  const ws = repoWithOrigin('https://github.com/OtherOrg/repo')
  const r = runRepoGate('https://github.com/JozzyAI/fin_bot', ws)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'repo_not_allowed')
})

// ── CLI end-to-end: `vibe run start` fails fast, no backend spawned ──────────

function isolatedEnv(): NodeJS.ProcessEnv {
  const vibeDir = tmpDir('vibe-home-')
  return {
    ...process.env,
    VIBE_DIR: vibeDir,
    VIBE_NODE_STATE_FILE: path.join(os.tmpdir(), `vibe-test-node-state-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`),
  }
}
function vibe(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env })
}
function uniqueKey(): string {
  return `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}
function parseEvents(jsonl: string): RunEvent[] {
  return jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunEvent)
}

test('vibe run start: non-allowlisted repo fails fast — repo_not_allowed, agent never spawned', () => {
  const env = isolatedEnv()
  const key = uniqueKey()
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', key, '--repo-url', 'https://github.com/OtherOrg/repo')
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord
  assert.equal(record.status, 'failed', 'run marked failed')
  assert.equal(record.session_id, '', 'no backend was started')

  const stream = vibe(env, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)
  const errorEvent = events.find((e): e is ErrorEvent => e.type === 'error')
  assert.ok(errorEvent, 'has error event')
  assert.equal(errorEvent!.code, 'repo_not_allowed')
  assert.doesNotMatch(errorEvent!.message, TOKEN_SHAPE)

  const last = events[events.length - 1] as StatusEvent
  assert.equal(last.status, 'failed')
  const logEvent = events.find((e): e is LogEvent => e.type === 'log')
  assert.equal(logEvent, undefined, 'mock backend must never have been spawned')
})

test('vibe run start: token-bearing repo URL fails fast — repo_url_has_credentials, no token leaked', () => {
  const env = isolatedEnv()
  const key = uniqueKey()
  const token = 'ghp_' + 'F'.repeat(36)
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', key, '--repo-url', `https://${token}@github.com/JozzyAI/fin_bot.git`)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord
  assert.equal(record.status, 'failed')

  const stream = vibe(env, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)
  const errorEvent = events.find((e): e is ErrorEvent => e.type === 'error')
  assert.ok(errorEvent, 'has error event')
  assert.equal(errorEvent!.code, 'repo_url_has_credentials')
  // Neither the error nor the whole event stream may contain the token.
  assert.doesNotMatch(stream.stdout, TOKEN_SHAPE, 'no token anywhere in the event stream')
})
