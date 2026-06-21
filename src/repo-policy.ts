/**
 * Repo allowlist policy (PR C1) — defense-in-depth so Vibe fails closed before
 * cloning, reusing a workspace, or launching a real agent against a repo that is
 * not an allowlisted GitHub remote.
 *
 * This complements PR B (controlled JozzyAI git auth): PR B makes the agent push
 * AS the right account; this makes sure it can only ever be pointed AT the right
 * repos. Together they block wrong-repo binding, stale workspaces aimed at the
 * wrong remote, token-bearing URLs, and accidental non-JozzyAI pushes.
 *
 * Scope: the allowlist governs *remote* URLs (https/ssh/scp `git@host:`). A local
 * filesystem path (e.g. a test fixture clone source) is NOT a push target and is
 * left untouched — enforcement only ever rejects remotes. Token-bearing URLs are
 * the caller's responsibility to reject FIRST via `assertCleanRepoUrl`
 * (workspace.ts), so a token surfaces as `RepoUrlCredentialsError`, not a
 * `RepoNotAllowedError`; this module additionally fail-closes on any remote it
 * cannot confirm. No error here ever contains a token value.
 */
import { redact } from './redact.js'

/** Default allowlist: only the JozzyAI GitHub org, in both URL forms. */
export const DEFAULT_REPO_ALLOWLIST: readonly string[] = [
  'https://github.com/JozzyAI/*',
  'git@github.com:JozzyAI/*',
]

/** Optional config surface (config.json). Wiring config.json through is deferred
 *  to future work; env + defaults are the supported path in C1. */
export interface RepoPolicyConfig {
  repo_allowlist?: string[]
  repo_allowlist_enforce?: boolean
}

/** Thrown when a remote repo URL is not covered by the allowlist. The message
 *  names only the owner/repo (never a token) and is redacted defensively. */
export class RepoNotAllowedError extends Error {
  readonly code = 'repo_not_allowed'

  constructor(label: string) {
    super(
      `Repository is blocked by repo allowlist: ${redact(label)} ` +
      `(only allowlisted GitHub owners may be cloned, reused, or pushed). ` +
      `Set VIBE_REPO_ALLOWLIST to authorize additional repos.`,
    )
    this.name = 'RepoNotAllowedError'
  }
}

export interface CanonicalRepo {
  /** Lowercased host, e.g. "github.com". */
  host: string
  /** Owner/org as written (compared case-insensitively). */
  owner: string
  /** Repo segment(s) after the owner, ".git"/trailing-slash stripped. */
  repo: string
}

/** True if `url` looks like a remote (scheme://… or scp-style user@host:path).
 *  A bare local path (/tmp/x, ./x, C:\x) is not a remote. */
function isRemoteUrl(url: string): boolean {
  const s = url.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true // scheme://host/…
  if (/^[^/@]+@[^/:]+:/.test(s)) return true          // git@github.com:owner/repo
  return false
}

/** Parse a remote repo URL (https/ssh/scp) into {host, owner, repo}, normalizing
 *  away userinfo, port, a trailing ".git", and trailing slashes. Returns null for
 *  anything that is not a parseable owner/repo remote (incl. local paths). Also
 *  used to canonicalize allowlist entries (whose repo segment may be a "*" glob). */
export function canonicalizeRepo(url: string): CanonicalRepo | null {
  if (typeof url !== 'string') return null
  const s = url.trim()
  if (!s) return null

  let host: string | undefined
  let pathPart: string | undefined

  const scheme = s.match(/^[a-z][a-z0-9+.-]*:\/\/(.+)$/i)
  if (scheme) {
    let rest = scheme[1]
    // Strip userinfo ("user@" / "token@") that precedes the host.
    const at = rest.indexOf('@')
    const firstSlash = rest.indexOf('/')
    if (at !== -1 && (firstSlash === -1 || at < firstSlash)) rest = rest.slice(at + 1)
    const slash = rest.indexOf('/')
    if (slash === -1) return null
    host = rest.slice(0, slash).replace(/:\d+$/, '') // drop :port
    pathPart = rest.slice(slash + 1)
  } else {
    const scp = s.match(/^(?:[^/@]+@)?([^/:]+):(.+)$/) // [user@]host:owner/repo
    if (!scp) return null
    host = scp[1]
    pathPart = scp[2]
  }

  if (!host || pathPart === undefined) return null
  pathPart = pathPart.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  const segs = pathPart.split('/').filter(Boolean)
  if (segs.length < 2) return null // need at least owner/repo
  const owner = segs[0]
  const repo = segs.slice(1).join('/')
  if (!owner || !repo) return null
  return { host: host.toLowerCase(), owner, repo }
}

/** Build a case-insensitive regex from an allowlist segment, treating "*" as a
 *  single path segment ([^/]+) and escaping everything else. */
function segmentRegex(seg: string): RegExp {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = seg.split('*').map(esc).join('[^/]+')
  return new RegExp(`^${pattern}$`, 'i')
}

/**
 * Decide whether `url` is allowed. Local (non-remote) paths are not governed and
 * return true. A remote that cannot be parsed fails closed (false). A parseable
 * remote must match an allowlist entry on host (exact, case-insensitive),
 * owner (glob, case-insensitive), and repo (glob — "*" = one segment).
 */
export function isRepoAllowed(url: string, allowlist: readonly string[]): boolean {
  if (!isRemoteUrl(url)) return true
  const canon = canonicalizeRepo(url)
  if (!canon) return false
  return allowlist.some((raw) => {
    const entry = canonicalizeRepo(raw)
    if (!entry) return false
    if (entry.host !== canon.host) return false
    if (!segmentRegex(entry.owner).test(canon.owner)) return false
    return segmentRegex(entry.repo).test(canon.repo)
  })
}

/** Throw RepoNotAllowedError unless `url` is allowed. No token ever in the error. */
export function assertRepoAllowed(url: string, allowlist: readonly string[]): void {
  if (isRepoAllowed(url, allowlist)) return
  const canon = canonicalizeRepo(url)
  const label = canon ? `${canon.owner}/${canon.repo}` : '(unrecognized remote URL)'
  throw new RepoNotAllowedError(label)
}

/** Resolve the active allowlist: env VIBE_REPO_ALLOWLIST (comma-separated) wins,
 *  then config.repo_allowlist, else the JozzyAI defaults. */
export function resolveRepoAllowlist(
  env: NodeJS.ProcessEnv = process.env,
  config?: RepoPolicyConfig,
): readonly string[] {
  const fromEnv = (env.VIBE_REPO_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (fromEnv.length) return fromEnv
  if (config?.repo_allowlist && config.repo_allowlist.length) return config.repo_allowlist
  return DEFAULT_REPO_ALLOWLIST
}

/** Whether allowlist enforcement is active. Default-ON (production-safe). The
 *  only escape hatch is VIBE_REPO_ALLOWLIST_ENFORCE=0|false (test/dev). */
export function repoAllowlistEnabled(
  env: NodeJS.ProcessEnv = process.env,
  config?: RepoPolicyConfig,
): boolean {
  const flag = env.VIBE_REPO_ALLOWLIST_ENFORCE
  if (flag === '0' || flag === 'false') return false
  if (flag === '1' || flag === 'true') return true
  if (config && typeof config.repo_allowlist_enforce === 'boolean') return config.repo_allowlist_enforce
  return true
}
