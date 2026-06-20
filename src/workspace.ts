import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

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

function readOriginUrl(workspacePath: string): string | undefined {
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
  checkWorkspaceRepoMatch(workspacePath, repoUrl)

  const entries = fs.readdirSync(workspacePath)
  if (entries.length > 0) return

  const branchFlag = branch ? `--branch ${branch} ` : ''
  execSync(`git clone --depth 1 ${branchFlag}${repoUrl} .`, {
    cwd: workspacePath,
    stdio: 'inherit',
  })
}
