import fs from 'fs'
import os from 'os'
import path from 'path'

function resolveVibeDir(): string {
  return process.env.VIBE_DIR ?? path.join(os.homedir(), '.vibe')
}

const CONFIG_PATH = path.join(resolveVibeDir(), 'config.json')

interface VibeConfig {
  workspace_root: string
  node_id: string
  /** Node-local roots under which an EXISTING directory may be used as a task cwd
   *  (`workspace.path`). Default EMPTY: cwd-backed execution is disabled unless the
   *  node operator explicitly configures roots (config.json or VIBE_ALLOWED_CWD_ROOTS,
   *  comma-separated). Authorization is enforced per-run by resolveAllowedCwd(). */
  allowed_cwd_roots: string[]
}

function ensureVibeDir(): string {
  const dir = resolveVibeDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true })
  return dir
}

export function resolveConfig(): VibeConfig {
  const dir = ensureVibeDir()
  const configPath = path.join(dir, 'config.json')

  let stored: Partial<VibeConfig> = {}
  if (fs.existsSync(configPath)) {
    try {
      stored = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch {
      // ignore malformed config
    }
  }

  // allowed_cwd_roots: env (comma-separated) overrides config.json; anything
  // malformed degrades to [] (feature OFF), never to a permissive default.
  const envRoots = process.env.VIBE_ALLOWED_CWD_ROOTS
  const allowedCwdRoots = envRoots !== undefined
    ? envRoots.split(',').map((s) => s.trim()).filter((s) => s !== '')
    : (Array.isArray(stored.allowed_cwd_roots) ? stored.allowed_cwd_roots.filter((r) => typeof r === 'string') : [])

  return {
    workspace_root: process.env.VIBE_WORKSPACE_ROOT
      ?? stored.workspace_root
      ?? path.join(dir, 'workspaces'),
    node_id: process.env.VIBE_NODE_ID ?? stored.node_id ?? 'local',
    allowed_cwd_roots: allowedCwdRoots,
  }
}

export function vibeDir(): string {
  return ensureVibeDir()
}
