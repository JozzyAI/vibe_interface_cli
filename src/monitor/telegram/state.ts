/**
 * Local snapshot persistence — ~/.vibe/telegram-monitor-state.json
 * (or VIBE_TELEGRAM_MONITOR_STATE_FILE override, mirroring the pattern used by
 * node-state.ts's VIBE_NODE_STATE_FILE so tests never touch the live file).
 *
 * Only non-secret snapshots are stored: node/run/relay status and timestamps.
 * No tokens, keys, or chat IDs ever pass through this module.
 */
import fs from 'fs'
import path from 'path'
import { vibeDir } from '../../config.js'
import type { MonitorState } from './types.js'

const STATE_VERSION = 1 as const

export function statePath(): string {
  return process.env.VIBE_TELEGRAM_MONITOR_STATE_FILE ?? path.join(vibeDir(), 'telegram-monitor-state.json')
}

export function emptyState(): MonitorState {
  return {
    version: STATE_VERSION,
    relay: null,
    nodes: {},
    runs: {},
    updated_at: new Date().toISOString(),
  }
}

export function loadState(): MonitorState {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw) as MonitorState
    if (parsed && parsed.version === STATE_VERSION) return parsed
  } catch {
    // missing or malformed — start fresh
  }
  return emptyState()
}

export function saveState(state: MonitorState): void {
  const p = statePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, p)
}
