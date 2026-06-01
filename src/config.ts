import fs from 'fs'
import os from 'os'
import path from 'path'

const VIBE_DIR = path.join(os.homedir(), '.vibe')
const CONFIG_PATH = path.join(VIBE_DIR, 'config.json')

interface VibeConfig {
  workspace_root: string
  node_id: string
}

function ensureVibeDir(): void {
  fs.mkdirSync(VIBE_DIR, { recursive: true })
  fs.mkdirSync(path.join(VIBE_DIR, 'runs'), { recursive: true })
  fs.mkdirSync(path.join(VIBE_DIR, 'events'), { recursive: true })
}

export function resolveConfig(): VibeConfig {
  ensureVibeDir()

  let stored: Partial<VibeConfig> = {}
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    } catch {
      // ignore malformed config
    }
  }

  return {
    workspace_root: process.env.VIBE_WORKSPACE_ROOT
      ?? stored.workspace_root
      ?? path.join(VIBE_DIR, 'workspaces'),
    node_id: process.env.VIBE_NODE_ID ?? stored.node_id ?? 'local',
  }
}

export function vibeDir(): string {
  ensureVibeDir()
  return VIBE_DIR
}
