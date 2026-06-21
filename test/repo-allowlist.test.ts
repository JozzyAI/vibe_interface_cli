/**
 * PR C1 — repo allowlist core (src/repo-policy.ts) + classification/types.
 *
 * The allowlist governs *remote* URLs (https/ssh/scp) and fails closed on any
 * non-allowlisted remote; local filesystem paths are not push targets and are
 * never rejected. Token-bearing URLs are rejected upstream by assertCleanRepoUrl
 * (see workspace.ts), so they surface as RepoUrlCredentialsError — covered in
 * repo-gate.test.ts. No error here may ever contain a token value.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_REPO_ALLOWLIST,
  canonicalizeRepo,
  isRepoAllowed,
  assertRepoAllowed,
  resolveRepoAllowlist,
  repoAllowlistEnabled,
  RepoNotAllowedError,
} from '../src/repo-policy.js'
import { classifyFailure } from '../src/runtime/classify.js'
import { DEFAULT_SWITCH_ON } from '../src/runtime/types.js'

const TOKEN_SHAPE = /gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/
const LIST = DEFAULT_REPO_ALLOWLIST

// ── Accepted forms ───────────────────────────────────────────────────────────

test('allowlist: clean JozzyAI HTTPS URL is accepted', () => {
  assert.equal(isRepoAllowed('https://github.com/JozzyAI/fin_bot', LIST), true)
})

test('allowlist: ".git" suffix is normalized and accepted', () => {
  assert.equal(isRepoAllowed('https://github.com/JozzyAI/fin_bot.git', LIST), true)
})

test('allowlist: trailing slash is normalized and accepted', () => {
  assert.equal(isRepoAllowed('https://github.com/JozzyAI/fin_bot/', LIST), true)
  assert.equal(isRepoAllowed('https://github.com/JozzyAI/fin_bot.git/', LIST), true)
})

test('allowlist: scp-style ssh JozzyAI URL is accepted', () => {
  assert.equal(isRepoAllowed('git@github.com:JozzyAI/fin_bot.git', LIST), true)
})

test('allowlist: ssh:// JozzyAI URL is accepted', () => {
  assert.equal(isRepoAllowed('ssh://git@github.com/JozzyAI/fin_bot.git', LIST), true)
})

// ── Rejected (fail closed) ───────────────────────────────────────────────────

test('allowlist: non-JozzyAI org is rejected (fail closed)', () => {
  assert.equal(isRepoAllowed('https://github.com/OtherOrg/repo', LIST), false)
  assert.throws(() => assertRepoAllowed('https://github.com/OtherOrg/repo', LIST), RepoNotAllowedError)
})

test('allowlist: a github.com look-alike host is rejected', () => {
  assert.equal(isRepoAllowed('https://github.com.evil.example/JozzyAI/fin_bot', LIST), false)
})

test('allowlist: a non-github remote (gitlab) is rejected', () => {
  assert.equal(isRepoAllowed('https://gitlab.com/JozzyAI/fin_bot', LIST), false)
})

test('allowlist: "*" matches only a single repo segment (no extra path)', () => {
  assert.equal(isRepoAllowed('https://github.com/JozzyAI/fin_bot/extra', LIST), false)
})

// ── Case-insensitivity ───────────────────────────────────────────────────────

test('allowlist: host and owner match case-insensitively', () => {
  assert.equal(isRepoAllowed('https://GitHub.com/jozzyai/fin_bot', LIST), true)
  assert.equal(isRepoAllowed('https://GITHUB.COM/JOZZYAI/Fin_Bot', LIST), true)
})

// ── Local paths are not governed ─────────────────────────────────────────────

test('allowlist: local filesystem paths are not remotes and are allowed', () => {
  assert.equal(isRepoAllowed('/tmp/vibe-fixture-repo-abc', LIST), true)
  assert.equal(isRepoAllowed('./relative/path', LIST), true)
  assert.doesNotThrow(() => assertRepoAllowed('/tmp/vibe-fixture-repo-abc', LIST))
})

// ── canonicalizeRepo ─────────────────────────────────────────────────────────

test('canonicalizeRepo: parses https/scp into lowercased host + owner/repo', () => {
  assert.deepEqual(canonicalizeRepo('https://github.com/JozzyAI/fin_bot.git'), {
    host: 'github.com', owner: 'JozzyAI', repo: 'fin_bot',
  })
  assert.deepEqual(canonicalizeRepo('git@github.com:JozzyAI/fin_bot.git'), {
    host: 'github.com', owner: 'JozzyAI', repo: 'fin_bot',
  })
  assert.equal(canonicalizeRepo('/tmp/local'), null)
})

test('canonicalizeRepo: strips userinfo from the host (token never becomes the owner)', () => {
  const c = canonicalizeRepo('https://gho_' + 'A'.repeat(36) + '@github.com/JozzyAI/fin_bot.git')
  assert.deepEqual(c, { host: 'github.com', owner: 'JozzyAI', repo: 'fin_bot' })
})

// ── Config / toggle ──────────────────────────────────────────────────────────

test('resolveRepoAllowlist: VIBE_REPO_ALLOWLIST overrides defaults', () => {
  const list = resolveRepoAllowlist({ VIBE_REPO_ALLOWLIST: 'https://github.com/Acme/*, git@github.com:Acme/*' } as NodeJS.ProcessEnv)
  assert.deepEqual(list, ['https://github.com/Acme/*', 'git@github.com:Acme/*'])
  assert.equal(isRepoAllowed('https://github.com/Acme/widget', list), true)
  assert.equal(isRepoAllowed('https://github.com/JozzyAI/fin_bot', list), false)
})

test('resolveRepoAllowlist: empty/unset env falls back to JozzyAI defaults', () => {
  assert.deepEqual(resolveRepoAllowlist({} as NodeJS.ProcessEnv), DEFAULT_REPO_ALLOWLIST)
  assert.deepEqual(resolveRepoAllowlist({ VIBE_REPO_ALLOWLIST: '   ' } as NodeJS.ProcessEnv), DEFAULT_REPO_ALLOWLIST)
})

test('repoAllowlistEnabled: default-on; only explicit 0/false disables', () => {
  assert.equal(repoAllowlistEnabled({} as NodeJS.ProcessEnv), true)
  assert.equal(repoAllowlistEnabled({ VIBE_REPO_ALLOWLIST_ENFORCE: '0' } as NodeJS.ProcessEnv), false)
  assert.equal(repoAllowlistEnabled({ VIBE_REPO_ALLOWLIST_ENFORCE: 'false' } as NodeJS.ProcessEnv), false)
  assert.equal(repoAllowlistEnabled({ VIBE_REPO_ALLOWLIST_ENFORCE: '1' } as NodeJS.ProcessEnv), true)
})

// ── No-secret error messages ─────────────────────────────────────────────────

test('RepoNotAllowedError message never contains a token value', () => {
  // Even a token-bearing, non-allowlisted URL must not leak the token in the error.
  const token = 'ghp_' + 'Z'.repeat(36)
  try {
    assertRepoAllowed(`https://${token}@github.com/OtherOrg/repo.git`, LIST)
    assert.fail('expected RepoNotAllowedError')
  } catch (err) {
    assert.ok(err instanceof RepoNotAllowedError)
    assert.equal(err.code, 'repo_not_allowed')
    assert.doesNotMatch(err.message, TOKEN_SHAPE, 'error must not contain a token')
    assert.match(err.message, /blocked by repo allowlist/i)
  }
})

// ── Classification / fallback policy ─────────────────────────────────────────

test('classifyFailure: "blocked by repo allowlist" → repo_not_allowed, non-recoverable', () => {
  const c = classifyFailure('Repository is blocked by repo allowlist: OtherOrg/repo (only allowlisted ...)')
  assert.equal(c.reason, 'repo_not_allowed')
  assert.equal(c.recoverable, false)
})

test('classifyFailure: token-in-URL message → repo_not_allowed, non-recoverable', () => {
  const c = classifyFailure('repoUrl contains embedded credentials (userinfo before "@") and was rejected.')
  assert.equal(c.reason, 'repo_not_allowed')
  assert.equal(c.recoverable, false)
})

test('classifyFailure: PR B account-allowlist message still classifies as auth_misconfigured (no collision)', () => {
  const c = classifyFailure('auth preflight failed: controlled GitHub auth resolved to "ZhaoyiLi", which is not in the allowlist [JozzyAI].')
  assert.equal(c.reason, 'auth_misconfigured')
  assert.equal(c.recoverable, false)
})

test('repo_not_allowed is NOT in the default switch-on set (no fallback for a bad repo binding)', () => {
  assert.ok(!(DEFAULT_SWITCH_ON as string[]).includes('repo_not_allowed'))
})
