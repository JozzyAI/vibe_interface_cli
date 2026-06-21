/**
 * Fail-closed GitHub auth preflight.
 *
 * Before a real agent that may push/PR runs against a github.com remote, confirm
 * the controlled credential path resolves to an allowlisted account (JozzyAI) —
 * NOT the Windows Git Credential Manager / personal-account (`ZhaoyiLi`) path the
 * real-agent canary reproduced. If it resolves to anything not allowlisted, we
 * fail BEFORE the agent runs, so nothing is ever pushed under the wrong identity.
 *
 * Secret hygiene: the gh credential helper output contains a `password=<token>`
 * line. We parse ONLY the `username=` line and discard the rest — the token is
 * never returned, stored, or logged. A GitHub login is not a secret, so the
 * resolved account name may appear in error messages.
 */
import { execFileSync } from 'child_process'
import { redact } from '../redact.js'
import { isWsl } from './agent-env.js'

/** GitHub accounts a real pushing agent is allowed to authenticate as. */
export const ALLOWED_GITHUB_ACCOUNTS = ['JozzyAI']

export interface PreauthResult {
  ok: boolean
  /** Resolved GitHub login (not a secret), when available. */
  account?: string
  /** Human-readable explanation on failure. Never contains a token value. */
  reason?: string
}

export interface PreauthDeps {
  /** Resolve the username the github.com git credential helper would return. */
  resolveCredentialUsername(): string | undefined
}

/**
 * Default-on under WSL (where the Windows GCM fallback exists). Overridable via
 * VIBE_AGENT_PREAUTH=1|0 so non-WSL / CI runs stay compatible and the live node
 * can be toggled if ever needed.
 */
export function preauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.VIBE_AGENT_PREAUTH
  if (flag === '1' || flag === 'true') return true
  if (flag === '0' || flag === 'false') return false
  return isWsl()
}

/**
 * Pure decision: given the resolved github.com credential username and the
 * allowlist, decide whether a pushing agent may proceed. Kept separate from the
 * IO so it is fully testable without invoking gh.
 */
export function evaluatePreauth(
  username: string | undefined,
  allowed: readonly string[] = ALLOWED_GITHUB_ACCOUNTS,
): PreauthResult {
  if (!username) {
    return {
      ok: false,
      reason:
        'controlled GitHub auth did not resolve to any account (the gh credential helper for ' +
        'https://github.com returned no username). Cannot confirm the agent would push as an ' +
        'allowlisted account, so refusing to run.',
    }
  }
  if (!allowed.includes(username)) {
    // A gh credential `username=` is always a login, never a token — but redact
    // the interpolated value defensively so a pathological value cannot leak.
    return {
      ok: false,
      account: username,
      reason:
        `controlled GitHub auth resolved to "${redact(username)}", which is not in the allowlist ` +
        `[${allowed.join(', ')}]. This is the Windows Git Credential Manager / personal-account ` +
        `fallback the agent must not use. Refusing to run a pushing agent under an unexpected account.`,
    }
  }
  return { ok: true, account: username }
}

/** Read the username the github.com git credential helper resolves to. Returns
 *  undefined on any error. The token (`password=`) line is never read out. */
function ghCredentialUsername(): string | undefined {
  try {
    const out = execFileSync('/usr/bin/gh', ['auth', 'git-credential', 'get'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 10_000,
    })
    for (const line of out.split('\n')) {
      if (line.startsWith('username=')) return line.slice('username='.length).trim()
    }
    return undefined
  } catch {
    return undefined
  }
}

const defaultDeps: PreauthDeps = { resolveCredentialUsername: ghCredentialUsername }

/**
 * Run the fail-closed preflight. Resolves the controlled github.com credential
 * account and checks it against the allowlist. Deps are injectable for testing.
 */
export function preflightGithubAuth(
  deps: PreauthDeps = defaultDeps,
  allowed: readonly string[] = ALLOWED_GITHUB_ACCOUNTS,
): PreauthResult {
  return evaluatePreauth(deps.resolveCredentialUsername(), allowed)
}
