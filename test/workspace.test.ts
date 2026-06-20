/**
 * Workspace/repoUrl reconciliation tests.
 *
 * Covers checkWorkspaceRepoMatch()/cloneIfEmpty() (src/workspace.ts) directly,
 * plus a `vibe run start` end-to-end check that a repo mismatch fails fast
 * (structured error event + status: failed) before the agent backend is spawned.
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
  assertCleanRepoUrl,
  WorkspaceRepoMismatchError,
  RepoUrlCredentialsError,
} from '../src/workspace.js'
import type { RunRecord, RunEvent, ErrorEvent, StatusEvent, LogEvent } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'ignore' })
}

/** Create a small local git repo (one commit) usable as a clone source via its filesystem path. */
function makeFixtureRepo(): string {
  const dir = tmpDir('vibe-fixture-repo-')
  git(dir, 'init -q -b main')
  git(dir, 'config user.email test@example.com')
  git(dir, 'config user.name "Test User"')
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n')
  git(dir, 'add README.md')
  git(dir, 'commit -q -m init')
  return dir
}

// ── Unit tests: checkWorkspaceRepoMatch / cloneIfEmpty ─────────────────────

test('empty workspace: clones the requested repo', () => {
  const repo = makeFixtureRepo()
  const ws = tmpDir('vibe-ws-empty-')
  cloneIfEmpty(ws, repo)
  assert.ok(fs.existsSync(path.join(ws, 'README.md')), 'cloned file present')
  assert.ok(fs.existsSync(path.join(ws, '.git')), 'is a git checkout')
})

test('non-empty workspace with matching origin: proceeds without re-cloning', () => {
  const repo = makeFixtureRepo()
  const ws = tmpDir('vibe-ws-match-')
  cloneIfEmpty(ws, repo) // initial clone

  // Local, untracked work that a re-clone would destroy.
  fs.writeFileSync(path.join(ws, 'local-work.txt'), 'untracked work\n')

  assert.doesNotThrow(() => cloneIfEmpty(ws, repo))
  assert.ok(fs.existsSync(path.join(ws, 'local-work.txt')), 'existing workspace contents preserved')
})

test('non-empty workspace: .git-suffix-equivalent origin proceeds (both directions)', () => {
  const repo = makeFixtureRepo()
  const ws = tmpDir('vibe-ws-gitsuffix-')
  cloneIfEmpty(ws, repo)

  // origin has no ".git" suffix; request with ".git" appended must still match.
  assert.doesNotThrow(() => checkWorkspaceRepoMatch(ws, `${repo}.git`))

  // origin WITH ".git" suffix; request without it must still match.
  git(ws, `remote set-url origin ${repo}.git`)
  assert.doesNotThrow(() => checkWorkspaceRepoMatch(ws, repo))
})

test('non-empty workspace with mismatched origin: fails fast', () => {
  const repoA = makeFixtureRepo()
  const repoB = makeFixtureRepo()
  const ws = tmpDir('vibe-ws-mismatch-')
  cloneIfEmpty(ws, repoA)

  assert.throws(() => cloneIfEmpty(ws, repoB), WorkspaceRepoMismatchError)
})

test('mismatch error includes workspace path, requested repoUrl, existing origin, and suggested fixes', () => {
  const repoA = makeFixtureRepo()
  const repoB = makeFixtureRepo()
  const ws = tmpDir('vibe-ws-mismatch-msg-')
  cloneIfEmpty(ws, repoA)

  assert.throws(
    () => checkWorkspaceRepoMatch(ws, repoB),
    (err: unknown) => {
      assert.ok(err instanceof WorkspaceRepoMismatchError)
      assert.equal(err.code, 'workspace_repo_mismatch')
      const msg = err.message
      assert.ok(msg.includes(ws), 'includes workspace path')
      assert.ok(msg.includes(repoB), 'includes requested repoUrl')
      assert.ok(msg.includes(repoA), 'includes existing origin')
      assert.match(msg, /fresh workspace key/)
      assert.match(msg, /clean\/archive/)
      assert.match(msg, /repo label\/binding/)
      return true
    },
  )
})

test('non-empty non-git workspace with repoUrl: fails fast', () => {
  const ws = tmpDir('vibe-ws-nongit-')
  fs.writeFileSync(path.join(ws, 'somefile.txt'), 'hello\n')

  assert.throws(
    () => checkWorkspaceRepoMatch(ws, 'https://github.com/JozzyAI/fin_bot'),
    (err: unknown) => {
      assert.ok(err instanceof WorkspaceRepoMismatchError)
      const msg = err.message
      assert.match(msg, /not a git checkout/)
      assert.ok(msg.includes(ws), 'includes workspace path')
      assert.ok(msg.includes('https://github.com/JozzyAI/fin_bot'), 'includes requested repoUrl')
      return true
    },
  )
})

// ── Unit tests: assertCleanRepoUrl (reject token-bearing repo URLs) ────────

test('assertCleanRepoUrl: clean https URL is accepted (with and without .git)', () => {
  assert.doesNotThrow(() => assertCleanRepoUrl('https://github.com/JozzyAI/mirror_social'))
  assert.doesNotThrow(() => assertCleanRepoUrl('https://github.com/JozzyAI/mirror_social.git'))
})

test('assertCleanRepoUrl: scp-style ssh remote is left alone', () => {
  assert.doesNotThrow(() => assertCleanRepoUrl('git@github.com:JozzyAI/fin_bot.git'))
  assert.doesNotThrow(() => assertCleanRepoUrl('ssh://git@github.com/JozzyAI/fin_bot.git'))
})

test('assertCleanRepoUrl: TOKEN@host form is rejected, message carries no token', () => {
  const token = 'gho_' + 'A'.repeat(36)
  assert.throws(
    () => assertCleanRepoUrl(`https://${token}@github.com/JozzyAI/fin_bot.git`),
    (err: unknown) => {
      assert.ok(err instanceof RepoUrlCredentialsError)
      assert.equal((err as RepoUrlCredentialsError).code, 'repo_url_has_credentials')
      assert.doesNotMatch(err.message, /gho_A/, 'rejection message must not contain the token')
      assert.match(err.message, /\[credentials REDACTED\]/)
      return true
    },
  )
})

test('assertCleanRepoUrl: user:TOKEN@host form is rejected, message carries no token', () => {
  const token = 'ghp_' + 'B'.repeat(36)
  assert.throws(
    () => assertCleanRepoUrl(`https://x-access-token:${token}@github.com/o/r.git`),
    (err: unknown) => {
      assert.ok(err instanceof RepoUrlCredentialsError)
      assert.doesNotMatch(err.message, /ghp_B/)
      return true
    },
  )
})

test('cloneIfEmpty / checkWorkspaceRepoMatch reject a token-bearing repoUrl before any git runs', () => {
  const token = 'ghs_' + 'C'.repeat(36)
  const tokenUrl = `https://${token}@github.com/o/r.git`
  const ws = tmpDir('vibe-ws-tokenurl-')

  assert.throws(() => cloneIfEmpty(ws, tokenUrl), RepoUrlCredentialsError)
  assert.throws(() => checkWorkspaceRepoMatch(ws, tokenUrl), RepoUrlCredentialsError)

  // Fail-closed: nothing was cloned into the workspace.
  assert.equal(fs.readdirSync(ws).length, 0, 'no clone happened')
})

test('token-bearing repoUrl is never written to a workspace git remote', () => {
  const repo = makeFixtureRepo()
  const ws = tmpDir('vibe-ws-noremote-')
  cloneIfEmpty(ws, repo) // clean clone

  const token = 'ghr_' + 'D'.repeat(36)
  const tokenUrl = `https://${token}@github.com/o/r.git`

  // A subsequent reconcile against a token URL must throw, not rewrite origin.
  assert.throws(() => checkWorkspaceRepoMatch(ws, tokenUrl), RepoUrlCredentialsError)

  const origin = execSync('git remote get-url origin', { cwd: ws, encoding: 'utf8' }).trim()
  assert.doesNotMatch(origin, /ghr_D/, 'origin remote must not contain the token')
  assert.equal(origin, repo, 'origin remote is unchanged')
})

// ── CLI end-to-end: `vibe run start` ───────────────────────────────────────

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

/** Pre-create <VIBE_DIR>/workspaces/<key> as a clone of `repo`, mirroring a reused per-issue workspace. */
function precreateClonedWorkspace(env: NodeJS.ProcessEnv, key: string, repo: string): string {
  const ws = path.join(env.VIBE_DIR!, 'workspaces', key)
  fs.mkdirSync(ws, { recursive: true })
  cloneIfEmpty(ws, repo)
  return ws
}

function parseEvents(jsonl: string): RunEvent[] {
  return jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunEvent)
}

test('vibe run start: repo mismatch fails fast — error event, status failed, agent never spawned', () => {
  const repoA = makeFixtureRepo()
  const repoB = makeFixtureRepo()
  const env = isolatedEnv()
  const key = uniqueKey()
  const ws = precreateClonedWorkspace(env, key, repoA)

  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', key, '--repo-url', repoB)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord
  assert.equal(record.status, 'failed', 'run marked failed')
  assert.equal(record.session_id, '', 'no session/backend was started')

  const stream = vibe(env, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  const errorEvent = events.find((e): e is ErrorEvent => e.type === 'error')
  assert.ok(errorEvent, 'has error event')
  assert.equal(errorEvent!.code, 'workspace_repo_mismatch')
  assert.ok(errorEvent!.message.includes(ws))
  assert.ok(errorEvent!.message.includes(repoA))
  assert.ok(errorEvent!.message.includes(repoB))

  const last = events[events.length - 1] as StatusEvent
  assert.equal(last.type, 'status')
  assert.equal(last.status, 'failed')

  // The mock runner (if spawned) emits a "Cloning repository..." log line — confirm it never ran.
  const logEvent = events.find((e): e is LogEvent => e.type === 'log')
  assert.equal(logEvent, undefined, 'mock backend must never have been spawned')
})

test('vibe run start: no --repo-url preserves existing behavior on a non-empty, non-git workspace', () => {
  const env = isolatedEnv()
  const key = uniqueKey()
  const ws = path.join(env.VIBE_DIR!, 'workspaces', key)
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'preexisting.txt'), 'pre-existing, non-git workspace contents\n')

  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', key)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord
  assert.equal(record.status, 'running', 'run proceeds normally without a repoUrl')
  assert.equal(record.repo_url, undefined)

  // Pre-existing workspace contents must be untouched.
  assert.ok(fs.existsSync(path.join(ws, 'preexisting.txt')))

  vibe(env, 'run', 'stop', record.run_id)
})
