import fs from 'fs'
import path from 'path'
import { vibeDir } from './config.js'
import type { RunRecord } from './types.js'

function runsDir(): string {
  return path.join(vibeDir(), 'runs')
}

function runPath(run_id: string): string {
  return path.join(runsDir(), `${run_id}.json`)
}

export function writeRun(record: RunRecord): void {
  fs.writeFileSync(runPath(record.run_id), JSON.stringify(record, null, 2))
}

export function readRun(run_id: string): RunRecord {
  const p = runPath(run_id)
  if (!fs.existsSync(p)) {
    process.stderr.write(`run not found: ${run_id}\n`)
    process.exit(3)
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as RunRecord
}

/** Returns the RunRecord or null — never calls process.exit. Safe for use in long-running processes. */
export function tryReadRun(run_id: string): RunRecord | null {
  const p = runPath(run_id)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as RunRecord } catch { return null }
}

export function updateRun(run_id: string, patch: Partial<RunRecord>): RunRecord {
  const record = readRun(run_id)
  const updated = { ...record, ...patch, updated_at: new Date().toISOString() }
  writeRun(updated)
  return updated
}

export function generateRunId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
  return `run_${ts}_${rand}`
}
