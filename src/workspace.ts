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

export function cloneIfEmpty(workspacePath: string, repoUrl: string, branch?: string): void {
  const entries = fs.readdirSync(workspacePath)
  if (entries.length > 0) return

  const branchFlag = branch ? `--branch ${branch} ` : ''
  execSync(`git clone --depth 1 ${branchFlag}${repoUrl} .`, {
    cwd: workspacePath,
    stdio: 'inherit',
  })
}
