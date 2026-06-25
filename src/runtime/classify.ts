/**
 * Failure classifier — maps an agent's failure text (tail of stdout+stderr plus
 * the failure message) to a normalized reason. Pure and table-driven so the
 * supervisor's switch decision is testable without spawning anything.
 *
 * Ordering matters: the first matching pattern wins, so more specific strings
 * are listed before broader ones.
 */
import type { FailureClassification, FailureReason } from './types.js'

interface Rule {
  reason: FailureReason
  recoverable: boolean
  patterns: RegExp[]
}

const RULES: Rule[] = [
  // ── Recoverable: agent / runtime / quota ──────────────────────────────────
  { reason: 'session_limit', recoverable: true, patterns: [/hit your session limit/i, /session limit reached/i, /\bsession limit\b/i] },
  { reason: 'usage_limit', recoverable: true, patterns: [/usage limit/i, /you've reached your usage/i] },
  { reason: 'quota_exceeded', recoverable: true, patterns: [/quota exceeded/i, /insufficient_quota/i, /out of credits/i] },
  { reason: 'rate_limited', recoverable: true, patterns: [/rate limit/i, /\b429\b/, /too many requests/i] },
  { reason: 'context_limit', recoverable: true, patterns: [/context (?:length|window) (?:limit|exceeded)/i, /maximum context length/i, /prompt is too long/i] },
  // auth_expired is recoverable (another backend may have valid auth) but is NOT in the
  // default switch set — see DEFAULT_SWITCH_ON. Must be opted in via --switch-on auth_expired.
  { reason: 'auth_expired', recoverable: true, patterns: [/all credential paths are exhausted/i, /authentication (?:failed|expired|required)/i, /\b401\b/, /invalid api key/i, /not (?:logged in|authenticated)/i] },
  // Matches exec.ts's real spawn-ENOENT wording ("<label> CLI not found in PATH")
  // as well as generic "command not found" / raw ENOENT text from a mock or any
  // other adapter — a different agent's binary may exist, so this is recoverable.
  { reason: 'command_not_found', recoverable: true, patterns: [/cli not found in path/i, /command not found/i, /\bENOENT\b/] },

  // ── Non-recoverable: the work or repo is the problem ──────────────────────
  // Repo gate / allowlist rejection (PR C1). Listed before auth_misconfigured so
  // a repo-binding rejection is tagged precisely and never mistaken for an auth
  // problem. Covers a non-allowlisted remote and a credential-bearing repo URL.
  { reason: 'repo_not_allowed', recoverable: false, patterns: [/blocked by repo allowlist/i, /repo_url_has_credentials/i, /embedded credentials/i] },
  // Controlled-auth misconfiguration (preflight, or a wrong-account push). Listed
  // before permission_denied so a clear auth-misconfig signal is tagged precisely.
  // Never recoverable: switching agents shares the same broken credential path.
  // The allowlist pattern is anchored on the account-allowlist wording
  // ("not in the allowlist [") so it cannot collide with the repo allowlist above.
  { reason: 'auth_misconfigured', recoverable: false, patterns: [/auth preflight failed/i, /not in the allowlist \[/i, /git credential manager/i] },
  { reason: 'tests_failed', recoverable: false, patterns: [/tests? failed/i, /test suite failed/i, /\d+ failing/i] },
  { reason: 'merge_conflict', recoverable: false, patterns: [/merge conflict/i, /conflict markers/i, /automatic merge failed/i] },
  { reason: 'repo_not_found', recoverable: false, patterns: [/repository not found/i, /could not read from remote repository/i] },
  { reason: 'permission_denied', recoverable: false, patterns: [/permission denied/i, /403 forbidden/i, /access denied/i] },
  { reason: 'unknown_repo', recoverable: false, patterns: [/workspace_repo_mismatch/i, /does not match the requested repourl/i, /is not a git checkout/i] },
  { reason: 'invalid_task', recoverable: false, patterns: [/prompt file not found/i, /invalid task/i] },
]

/**
 * Classify failure text. Unknown text is treated as non-recoverable so we never
 * burn a fallback on something we don't understand.
 */
export function classifyFailure(text: string | undefined): FailureClassification {
  const haystack = text ?? ''
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) {
      return { reason: rule.reason, recoverable: rule.recoverable }
    }
  }
  return { reason: 'unknown', recoverable: false }
}
