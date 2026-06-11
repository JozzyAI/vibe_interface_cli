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
  checkWorkspaceRepoMatch(workspacePath, repoUrl)

  const entries = fs.readdirSync(workspacePath)
  if (entries.length > 0) return

  const branchFlag = branch ? `--branch ${branch} ` : ''
  execSync(`git clone --depth 1 ${branchFlag}${repoUrl} .`, {
    cwd: workspacePath,
    stdio: 'inherit',
  })
}
