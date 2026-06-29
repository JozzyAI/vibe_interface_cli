/**
 * Local registry of active personal web viewers (`vibe run web …`).
 *
 * Viewers bind ephemeral ports, so the URL is easy to lose. This registry lets
 * `vibe run viewers list/open/stop` rediscover and manage active viewers without
 * a daemon: each foreground viewer process writes its record on start and removes
 * it on exit; liveness is derived from the recorded pid (process.kill(pid, 0)), so
 * a crashed viewer's record is pruned on the next read.
 *
 * The file stores ONLY local, non-secret metadata: the base URL (host:port — never
 * the `?access=` token), pid, and ids. It never holds the relay auth token or the
 * public-bind access token.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { vibeDir } from '../config.js'

export interface ViewerRecord {
  viewer_id: string
  run_id: string
  node_id?: string
  mode: 'local' | 'remote'
  /** Base URL only — `http://host:port`, never with an `?access=` token. */
  url: string
  host: string
  port: number
  pid: number
  /** Whether the viewer is gated by a public-bind access token (token NOT stored). */
  auth: 'token' | 'none'
  created_at: string
  updated_at: string
  ended?: boolean
}

interface ViewersFileV1 {
  version: 1
  viewers: ViewerRecord[]
}

export function viewersPath(): string {
  return path.join(vibeDir(), 'viewers.json')
}

export function generateViewerId(): string {
  return `vw_${crypto.randomBytes(6).toString('hex')}`
}

/** True if a process with this pid currently exists (signal 0 probes without killing). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function loadViewers(): ViewerRecord[] {
  let raw: string
  try {
    raw = fs.readFileSync(viewersPath(), 'utf8')
  } catch {
    return [] // missing file → no viewers yet
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ViewersFileV1>
    return Array.isArray(parsed?.viewers) ? parsed.viewers.filter((v) => v && typeof v.pid === 'number') : []
  } catch {
    return [] // corrupt → start empty rather than throw into the CLI
  }
}

/** Persist atomically (temp write + fsync + rename), 0600 — same shape as pairing-store. */
export function saveViewers(viewers: ViewerRecord[]): void {
  const file = viewersPath()
  const json = JSON.stringify({ version: 1, viewers } satisfies ViewersFileV1, null, 2)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch { /* best-effort */ }
}

/** Add (or replace by viewer_id) a viewer record. Best-effort; callers wrap in try/catch. */
export function addViewer(rec: ViewerRecord): void {
  const viewers = loadViewers().filter((v) => v.viewer_id !== rec.viewer_id)
  viewers.push(rec)
  saveViewers(viewers)
}

/** Remove a viewer record by id. No-op if absent. */
export function removeViewer(viewer_id: string): void {
  const viewers = loadViewers()
  const next = viewers.filter((v) => v.viewer_id !== viewer_id)
  if (next.length !== viewers.length) saveViewers(next)
}

/**
 * Return only viewers whose process is still alive, pruning dead-pid records from
 * disk as a side effect. `pruned` is how many stale records were dropped.
 */
export function listActiveViewers(): { live: ViewerRecord[]; pruned: number } {
  const all = loadViewers()
  const live = all.filter((v) => isPidAlive(v.pid))
  if (live.length !== all.length) saveViewers(live)
  return { live, pruned: all.length - live.length }
}

/**
 * Resolve a viewer by exact `viewer_id`, else the most-recently-created live record
 * for a matching `run_id`. Only returns a viewer whose process is alive.
 */
export function findViewer(idOrRun: string): ViewerRecord | undefined {
  const { live } = listActiveViewers()
  const byId = live.find((v) => v.viewer_id === idOrRun)
  if (byId) return byId
  return live
    .filter((v) => v.run_id === idOrRun)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
}
