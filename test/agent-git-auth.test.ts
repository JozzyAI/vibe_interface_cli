/**
 * PR B — controlled agent git auth tests.
 *
 * Covers the two mechanisms that close the JOZ-32 root cause the real-agent
 * canary reproduced (agent git resolving to the Windows GCM / personal
 * `ZhaoyiLi` account instead of the controlled WSL `gh`/`JozzyAI` path):
 *   1. the sanitized agent environment (PATH + git config + fail-closed prompt)
 *   2. the fail-closed github.com auth preflight + its classification
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizePath, buildAgentEnv, AGENT_GIT_CONFIG } from '../src/runtime/agent-env.js'
import { evaluatePreauth, preflightGithubAuth, ALLOWED_GITHUB_ACCOUNTS } from '../src/runtime/preauth.js'
import { classifyFailure } from '../src/runtime/classify.js'
import { DEFAULT_SWITCH_ON } from '../src/runtime/types.js'

const TOKEN_SHAPE = /gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/

// ── PATH sanitizer ───────────────────────────────────────────────────────────

test('sanitizePath: removes Windows Git directories on WSL', () => {
  const raw = [
    '/home/lijoe/.nvm/versions/node/v20.19.5/bin',
    '/usr/bin',
    '/bin',
    '/mnt/c/Windows/system32',
    '/mnt/c/Program Files/Git/cmd',
    '/mnt/c/Program Files/Git/bin',
  ].join(':')
  const out = sanitizePath(raw, true).split(':')

  assert.ok(!out.includes('/mnt/c/Program Files/Git/cmd'), 'Git/cmd must be stripped')
  assert.ok(!out.includes('/mnt/c/Program Files/Git/bin'), 'Git/bin must be stripped')
  assert.ok(!out.some((e) => /\/git\//i.test(e)), 'no Windows Git dir may survive')
})

test('sanitizePath: keeps /usr/bin and /bin and places them before any Windows path', () => {
  const raw = '/mnt/c/Windows/system32:/usr/bin:/bin:/mnt/c/Program Files/Git/cmd'
  const out = sanitizePath(raw, true).split(':')

  assert.ok(out.includes('/usr/bin'), '/usr/bin retained')
  assert.ok(out.includes('/bin'), '/bin retained')
  const firstMnt = out.findIndex((e) => e.startsWith('/mnt/'))
  if (firstMnt !== -1) {
    assert.ok(out.indexOf('/usr/bin') < firstMnt, '/usr/bin precedes any Windows path')
    assert.ok(out.indexOf('/bin') < firstMnt, '/bin precedes any Windows path')
  }
})

test('sanitizePath: keeps non-Git Windows interop entries (only Git dirs are removed)', () => {
  const raw = '/usr/bin:/bin:/mnt/c/Windows/system32:/mnt/c/Program Files/nodejs'
  const out = sanitizePath(raw, true).split(':')
  assert.ok(out.includes('/mnt/c/Windows/system32'), 'non-Git Windows path retained')
  assert.ok(out.includes('/mnt/c/Program Files/nodejs'), 'non-Git Windows path retained')
})

test('sanitizePath: non-WSL host returns PATH unchanged', () => {
  const raw = '/usr/local/bin:/usr/bin:/bin'
  assert.equal(sanitizePath(raw, false), raw)
})

// ── Agent environment ────────────────────────────────────────────────────────

test('buildAgentEnv (hardening on): sets GIT_TERMINAL_PROMPT=0 (fail closed)', () => {
  const env = buildAgentEnv({ PATH: '/usr/bin:/bin' }, true)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
})

test('buildAgentEnv (hardening on): injects empty credential-helper reset + gh helper for github.com', () => {
  const env = buildAgentEnv({ PATH: '/usr/bin:/bin' }, true)
  const count = Number(env.GIT_CONFIG_COUNT)
  assert.equal(count, AGENT_GIT_CONFIG.length)

  // Collect injected key→value pairs.
  const pairs: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    pairs[env[`GIT_CONFIG_KEY_${i}`] as string] = env[`GIT_CONFIG_VALUE_${i}`] as string
  }

  // Empty reset MUST be present and correctly represented as an empty string.
  assert.ok('credential.helper' in pairs, 'credential.helper reset key present')
  assert.equal(pairs['credential.helper'], '', 'credential.helper reset value is empty string')

  assert.equal(pairs['credential.https://github.com.helper'], '!/usr/bin/gh auth git-credential')
})

test('buildAgentEnv (hardening on): the empty reset is the first git config entry', () => {
  const env = buildAgentEnv({ PATH: '/usr/bin:/bin' }, true)
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper')
  assert.equal(env.GIT_CONFIG_VALUE_0, '')
})

test('buildAgentEnv (hardening on): injects controlled commit identity', () => {
  const env = buildAgentEnv({ PATH: '/usr/bin:/bin' }, true)
  const pairs: Record<string, string> = {}
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) {
    pairs[env[`GIT_CONFIG_KEY_${i}`] as string] = env[`GIT_CONFIG_VALUE_${i}`] as string
  }
  assert.equal(pairs['user.name'], 'JozzyAI Vibe Agent')
  assert.equal(pairs['user.email'], 'actions@users.noreply.github.com')
})

test('buildAgentEnv (hardening on): strips Windows git from PATH', () => {
  const env = buildAgentEnv({ PATH: '/usr/bin:/bin:/mnt/c/Program Files/Git/cmd' }, true)
  assert.ok(!(env.PATH as string).split(':').some((e) => /\/git\//i.test(e)))
})

test('buildAgentEnv (hardening off): returns base env unchanged — no git config injected', () => {
  const base = { PATH: '/usr/bin:/bin:/mnt/c/Program Files/Git/cmd', FOO: 'bar' }
  const env = buildAgentEnv(base, false)
  assert.equal(env.PATH, base.PATH, 'PATH untouched when hardening off')
  assert.equal(env.FOO, 'bar', 'unrelated env preserved')
  assert.equal(env.GIT_CONFIG_COUNT, undefined, 'no git config injected when hardening off')
  assert.equal(env.GIT_TERMINAL_PROMPT, undefined)
})

test('buildAgentEnv: carries no GitHub token value into the environment', () => {
  const env = buildAgentEnv({ PATH: '/usr/bin:/bin' }, true)
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') {
      assert.doesNotMatch(v, TOKEN_SHAPE, `env ${k} must not contain a token value`)
    }
  }
})

// ── Fail-closed preflight ────────────────────────────────────────────────────

test('evaluatePreauth: passes for the allowlisted JozzyAI account', () => {
  const r = evaluatePreauth('JozzyAI')
  assert.equal(r.ok, true)
  assert.equal(r.account, 'JozzyAI')
})

test('evaluatePreauth: fail-closes for the personal ZhaoyiLi account', () => {
  const r = evaluatePreauth('ZhaoyiLi')
  assert.equal(r.ok, false)
  assert.equal(r.account, 'ZhaoyiLi')
  assert.match(r.reason ?? '', /not in the allowlist/i)
})

test('evaluatePreauth: fail-closes when no account resolves', () => {
  const r = evaluatePreauth(undefined)
  assert.equal(r.ok, false)
  assert.match(r.reason ?? '', /did not resolve/i)
})

test('evaluatePreauth: failure reason never contains a token value', () => {
  // Even if a hostile "username" carried a token-shaped string, the reason must not leak a real secret;
  // and the normal ZhaoyiLi/none paths obviously must not.
  for (const u of [undefined, 'ZhaoyiLi', 'ghp_' + 'A'.repeat(36)]) {
    const r = evaluatePreauth(u)
    assert.equal(r.ok, false)
    assert.doesNotMatch(r.reason ?? '', TOKEN_SHAPE)
  }
})

test('preflightGithubAuth: uses injected resolver (JozzyAI ok, ZhaoyiLi fails)', () => {
  const ok = preflightGithubAuth({ resolveCredentialUsername: () => 'JozzyAI' })
  assert.equal(ok.ok, true)

  const bad = preflightGithubAuth({ resolveCredentialUsername: () => 'ZhaoyiLi' })
  assert.equal(bad.ok, false)
  assert.equal(bad.account, 'ZhaoyiLi')
})

test('ALLOWED_GITHUB_ACCOUNTS contains JozzyAI and not ZhaoyiLi', () => {
  assert.ok(ALLOWED_GITHUB_ACCOUNTS.includes('JozzyAI'))
  assert.ok(!ALLOWED_GITHUB_ACCOUNTS.includes('ZhaoyiLi'))
})

// ── Classification / fallback policy ─────────────────────────────────────────

test('classifyFailure: auth preflight failure → auth_misconfigured, non-recoverable', () => {
  const c = classifyFailure('auth preflight failed: controlled GitHub auth resolved to "ZhaoyiLi", which is not in the allowlist [JozzyAI].')
  assert.equal(c.reason, 'auth_misconfigured')
  assert.equal(c.recoverable, false)
})

test('auth_misconfigured is NOT in the default switch-on set (no fallback for wrong auth)', () => {
  assert.ok(!(DEFAULT_SWITCH_ON as string[]).includes('auth_misconfigured'))
})
