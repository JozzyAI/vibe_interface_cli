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

  return {
    workspace_root: process.env.VIBE_WORKSPACE_ROOT
      ?? stored.workspace_root
      ?? path.join(dir, 'workspaces'),
    node_id: process.env.VIBE_NODE_ID ?? stored.node_id ?? 'local',
  }
}

export function vibeDir(): string {
  return ensureVibeDir()
}
