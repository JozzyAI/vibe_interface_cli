import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { assertRepoAllowed, resolveRepoAllowlist, repoAllowlistEnabled } from './repo-policy.js'

/** Capability id a Node advertises when it can authorize cwd-backed runs
 *  (at least one valid `allowed_cwd_roots` entry). Gateways MUST fail closed on
 *  a `workspace.path` task when the target placement lacks this capability —
 *  an incapable Node would silently ignore the field and run in a scratch
 *  workspace, which is exactly the outcome this gate prevents. */
export const CWD_CAPABILITY = 'cwd'

export type AllowedCwdResolution =
  | { ok: true; path: string }
  | { ok: false; code: 'cwd_not_allowed'; message: string }

/**
 * Node-side authorization of a requested EXISTING working directory against the
 * Node's configured `allowed_cwd_roots`. The Node is the only trust boundary —
 * Gateway-side validation is shape-only and never trusted. Fail closed on every
 * branch; sanitized messages NEVER echo the requested path or the configured
 * roots. This function never creates anything on disk.
 */
export function resolveAllowedCwd(cwd: unknown, allowedRoots: readonly string[]): AllowedCwdResolution {
  const deny = (message: string): AllowedCwdResolution => ({ ok: false, code: 'cwd_not_allowed', message })
  if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(cwd)) return deny('cwd must be an absolute path')
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) return deny('this node does not allow cwd-backed runs (no allowed_cwd_roots configured)')
  // The requested path must ALREADY exist and be a directory — a cwd run never
  // creates its directory (that is the scratch-workspace_key model's job).
  let realCwd: string
  try { realCwd = fs.realpathSync(cwd) } catch { return deny('cwd does not exist on this node') }
  let st: fs.Stats
  try { st = fs.statSync(realCwd) } catch { return deny('cwd does not exist on this node') }
  if (!st.isDirectory()) return deny('cwd is not a directory')
  // Containment is judged on FULLY RESOLVED paths (both sides realpath'd), so a
  // symlink inside an allowed root that points outside it fails closed, and a
  // sibling prefix ("/root-evil" vs "/root") can never match.
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || root === '' || !path.isAbsolute(root)) continue // invalid config entries never authorize
    let realRoot: string
    try { realRoot = fs.realpathSync(root) } catch { continue } // nonexistent root authorizes nothing
    try { if (!fs.statSync(realRoot).isDirectory()) continue } catch { continue }
    if (realCwd === realRoot || realCwd.startsWith(realRoot + path.sep)) return { ok: true, path: realCwd }
  }
  return deny('cwd is not under an allowed root on this node')
}

/** The configured roots that could actually authorize something right now
 *  (absolute + existing directories). Drives the capability advertisement. */
export function validAllowedCwdRoots(allowedRoots: readonly string[]): string[] {
  const out: string[] = []
  for (const root of Array.isArray(allowedRoots) ? allowedRoots : []) {
    if (typeof root !== 'string' || root === '' || !path.isAbsolute(root)) continue
    try { if (fs.statSync(fs.realpathSync(root)).isDirectory()) out.push(root) } catch { /* not a valid root */ }
  }
  return out
}

/** Append {@link CWD_CAPABILITY} to a capability list only when the Node has at
 *  least one valid allowed cwd root. Evaluated at advertisement time. */
export function withCwdCapability(base: string[], allowedRoots: readonly string[]): string[] {
  return validAllowedCwdRoots(allowedRoots).length > 0 && !base.includes(CWD_CAPABILITY) ? [...base, CWD_CAPABILITY] : [...base]
}

export function resolveWorkspacePath(workspaceKey: string, workspaceRoot: string): string {
  fs.mkdirSync(workspaceRoot, { recursive: true })
  const realRoot = fs.realpathSync(workspaceRoot)
  const resolved = path.resolve(realRoot, workspaceKey)

  if (!resolved.startsWith(realRoot + path.sep) && resolved !== realRoot) {
    process.stderr.write(
      `error: workspace_path "${resolved}" is not under workspace_root "${realRoot}"\n`
    )
    process.exit(1)
  }

  return resolved
}

/**
 * Opaque workspace-key rule. MUST stay in sync with WORKSPACE_KEY_RE in
 * src/lib/agent-task-contract.ts (the API-layer copy). Starts alphanumeric, then
 * alphanumeric/`.`/`_`/`-`, max 128 chars — this alone rejects '', '/', '\',
 * absolute paths, leading '.' (so '.'/'..'/traversal), control chars, oversized.
 */
export const WORKSPACE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type WorkspaceResolution =
  | { ok: true; path: string }
  | { ok: false; code: 'invalid_workspace_key'; message: string }

/**
 * Resolve an UNTRUSTED workspace_key to a path CONTAINED within workspaceRoot.
 * This is the node's filesystem trust boundary for every relay client (not only
 * Agent Gateway callers). Result-returning — NO process.exit, and the submitted
 * key is NEVER echoed in the (relay-visible) error. Creates NO directory: the
 * caller creates the workspace dir only after this succeeds.
 *
 * Layers of containment:
 *   1. `workspace_key` must be an opaque identifier (WORKSPACE_KEY_RE) — a single
 *      safe path segment. This rejects empty, '/', '\', absolute paths, '.'/'..'
 *      and any traversal, control characters, and oversized keys up front.
 *   2. The resolved path is verified inside the realpath'd root via `path.relative`
 *      (NOT a bare string-prefix comparison).
 *   3. If the final path already EXISTS, its realpath must still be inside the root
 *      — this rejects an existing symlink (or symlinked component) that escapes.
 *
 * Residual limitation (documented, not silently claimed solved): this is not fully
 * TOCTOU-race-proof. A directory/component could be swapped for an escaping symlink
 * between the realpath check here and later filesystem use by the backend. Fully
 * race-resistant containment needs per-component O_NOFOLLOW/openat traversal, which
 * is a substantially larger design left as a follow-up.
 */
export function resolveContainedWorkspace(workspaceKey: string, workspaceRoot: string): WorkspaceResolution {
  const OPAQUE_KEY = 'workspace_key must be an opaque key matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ (not a path)'
  if (typeof workspaceKey !== 'string' || !WORKSPACE_KEY_RE.test(workspaceKey)) {
    return { ok: false, code: 'invalid_workspace_key', message: OPAQUE_KEY }
  }
  fs.mkdirSync(workspaceRoot, { recursive: true }) // ensure the ROOT exists (not the key dir)
  const realRoot = fs.realpathSync(workspaceRoot)
  const resolved = path.resolve(realRoot, workspaceKey)
  const rel = path.relative(realRoot, resolved)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'invalid_workspace_key', message: 'workspace_key does not resolve within the workspace root' }
  }
  if (fs.existsSync(resolved)) {
    const realResolved = fs.realpathSync(resolved)
    const relReal = path.relative(realRoot, realResolved)
    if (relReal === '' || relReal.startsWith('..') || path.isAbsolute(relReal)) {
      return { ok: false, code: 'invalid_workspace_key', message: 'existing workspace path escapes the workspace root' }
    }
  }
  return { ok: true, path: resolved }
}

export function ensureWorkspace(workspacePath: string): void {
  fs.mkdirSync(workspacePath, { recursive: true })
}

/** Thrown by checkWorkspaceRepoMatch() / cloneIfEmpty() when a non-empty workspace
 * cannot be confirmed to belong to the requested repoUrl. */
export class WorkspaceRepoMismatchError extends Error {
  readonly code = 'workspace_repo_mismatch'

  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceRepoMismatchError'
  }
}

/** Thrown by assertCleanRepoUrl() when a repoUrl carries embedded credentials
 * (e.g. https://TOKEN@github.com/... or https://user:TOKEN@github.com/...).
 * We fail closed so a token can never reach `git clone`, a stored remote, or
 * any log. The message never contains the raw credential. */
export class RepoUrlCredentialsError extends Error {
  readonly code = 'repo_url_has_credentials'

  constructor() {
    super(
      'repoUrl contains embedded credentials (userinfo before "@") and was rejected. ' +
      'Provide a clean URL with no token, e.g. https://github.com/<owner>/<repo>.git — ' +
      'authentication must come from the configured git credential helper. [credentials REDACTED]'
    )
    this.name = 'RepoUrlCredentialsError'
  }
}

/** Reject any http(s) URL that carries userinfo (`token@host` or
 * `user:token@host`) before the host. Clean https URLs and scp-style ssh
 * (`git@github.com:owner/repo.git`) are left alone. Fail-closed: throws
 * RepoUrlCredentialsError rather than silently stripping, so a token never
 * reaches `git clone`, a persisted remote, or a log line. */
export function assertCleanRepoUrl(repoUrl: string): void {
  if (/^https?:\/\/[^/@]+@/i.test(repoUrl.trim())) {
    throw new RepoUrlCredentialsError()
  }
}

/**
 * Reject a repoUrl that is not on the active allowlist (PR C1). Called AFTER
 * assertCleanRepoUrl so a token-bearing URL surfaces as RepoUrlCredentialsError,
 * not RepoNotAllowedError. No-op when enforcement is disabled. Local filesystem
 * paths are not remotes and are never rejected (see repo-policy).
 */
export function enforceRepoAllowlist(repoUrl: string): void {
  if (!repoAllowlistEnabled()) return
  assertRepoAllowed(repoUrl, resolveRepoAllowlist())
}

/** Strip a trailing slash and an optional trailing ".git" so equivalent repo
 * URLs (with/without ".git", with/without a trailing slash) compare equal. */
export function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
}

function suggestedFixes(repoUrl: string, workspacePath: string, existingOrigin?: string): string {
  return [
    `  - use a fresh workspace key for "${repoUrl}"`,
    `  - manually clean/archive the workspace at "${workspacePath}"`,
    existingOrigin
      ? `  - choose the repo label/binding that matches the existing workspace's origin (${existingOrigin})`
      : `  - choose the repo label/binding that matches the existing workspace's contents`,
  ].join('\n')
}

export function readOriginUrl(workspacePath: string): string | undefined {
  try {
    return execSync('git remote get-url origin', {
      cwd: workspacePath,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
  } catch {
    return undefined
  }
}

/**
 * Verify that a non-empty workspace can be safely (re)used for `repoUrl`.
 *
 * - Empty workspace: no-op (caller will clone).
 * - Non-empty, not a git checkout: throws WorkspaceRepoMismatchError.
 * - Non-empty git checkout whose `origin` remote matches `repoUrl` (after
 *   normalization): no-op (proceed without re-cloning).
 * - Non-empty git checkout whose `origin` remote does not match (or is
 *   unreadable): throws WorkspaceRepoMismatchError.
 */
export function checkWorkspaceRepoMatch(workspacePath: string, repoUrl: string): void {
  assertCleanRepoUrl(repoUrl)
  enforceRepoAllowlist(repoUrl)

  const entries = fs.readdirSync(workspacePath)
  if (entries.length === 0) return

  const isGitRepo = fs.existsSync(path.join(workspacePath, '.git'))
  if (!isGitRepo) {
    throw new WorkspaceRepoMismatchError(
      `workspace "${workspacePath}" is non-empty but is not a git checkout, ` +
      `and repoUrl "${repoUrl}" was requested.\n` +
      `Suggested fixes:\n${suggestedFixes(repoUrl, workspacePath)}`
    )
  }

  const existingOrigin = readOriginUrl(workspacePath)
  if (existingOrigin && normalizeRepoUrl(existingOrigin) === normalizeRepoUrl(repoUrl)) {
    return
  }

  throw new WorkspaceRepoMismatchError(
    `workspace "${workspacePath}" already contains a git checkout whose origin ` +
    `(${existingOrigin ?? '(none)'}) does not match the requested repoUrl "${repoUrl}".\n` +
    `Suggested fixes:\n${suggestedFixes(repoUrl, workspacePath, existingOrigin)}`
  )
}

export function cloneIfEmpty(workspacePath: string, repoUrl: string, branch?: string): void {
  assertCleanRepoUrl(repoUrl)
  enforceRepoAllowlist(repoUrl)
  checkWorkspaceRepoMatch(workspacePath, repoUrl)

  const entries = fs.readdirSync(workspacePath)
  if (entries.length > 0) return

  const branchFlag = branch ? `--branch ${branch} ` : ''
  execSync(`git clone --depth 1 ${branchFlag}${repoUrl} .`, {
    cwd: workspacePath,
    stdio: 'inherit',
  })
}
