/**
 * Active viewer registry (`vibe run viewers`). Unit + CLI-level, isolated to a
 * throwaway VIBE_DIR. No relay, no real agents, no tokens stored.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { freshVibeDir } from './helpers/agent-fixtures.js'
import {
  addViewer, removeViewer, loadViewers, listActiveViewers, findViewer,
  generateViewerId, isPidAlive, viewersPath, type ViewerRecord,
} from '../src/lib/viewer-registry.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

const VIBE_DIR = freshVibeDir('vibe-viewers-')
process.env.VIBE_DIR = VIBE_DIR

function rec(over: Partial<ViewerRecord> = {}): ViewerRecord {
  const now = new Date().toISOString()
  return {
    viewer_id: generateViewerId(), run_id: 'run_abc', mode: 'local',
    url: 'http://127.0.0.1:7681', host: '127.0.0.1', port: 7681,
    pid: process.pid, auth: 'none', created_at: now, updated_at: now, ...over,
  }
}

/** A pid that is guaranteed dead: spawn a process to completion, reuse its pid. */
function deadPid(): number {
  const r = spawnSync(NODE, ['-e', ''])
  return r.pid ?? 999999999
}

function vibe(args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, VIBE_DIR }, timeout: 15000 })
}

// ── unit ─────────────────────────────────────────────────────────────────────

test('registry CRUD round-trips and finds by viewer_id and run_id', () => {
  const a = rec({ run_id: 'run_one' })
  const b = rec({ run_id: 'run_two', mode: 'remote', node_id: 'node_x' })
  addViewer(a); addViewer(b)
  assert.equal(loadViewers().length, 2)
  assert.equal(findViewer(a.viewer_id)?.run_id, 'run_one')
  assert.equal(findViewer('run_two')?.viewer_id, b.viewer_id)
  removeViewer(a.viewer_id)
  assert.equal(findViewer('run_one'), undefined)
  removeViewer(b.viewer_id)
  assert.equal(loadViewers().length, 0)
})

test('registry file is created 0600', () => {
  addViewer(rec())
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(viewersPath()).mode & 0o777, 0o600)
  }
  for (const v of loadViewers()) removeViewer(v.viewer_id)
})

test('listActiveViewers prunes dead-pid records, keeps live ones', () => {
  const alive = rec({ run_id: 'run_live', pid: process.pid })
  const dead = rec({ run_id: 'run_dead', pid: deadPid() })
  addViewer(alive); addViewer(dead)
  assert.equal(isPidAlive(process.pid), true)
  const { live, pruned } = listActiveViewers()
  assert.equal(pruned, 1, 'one dead record pruned')
  assert.deepEqual(live.map((v) => v.run_id), ['run_live'])
  // The prune is persisted to disk.
  assert.equal(loadViewers().length, 1)
  removeViewer(alive.viewer_id)
})

test('registry never stores a relay token or an ?access= URL', () => {
  addViewer(rec({ run_id: 'run_secretcheck', auth: 'token', url: 'http://0.0.0.0:7681' }))
  const raw = fs.readFileSync(viewersPath(), 'utf8')
  assert.doesNotMatch(raw, /\?access=/, 'no access token URL persisted')
  assert.doesNotMatch(raw, /access_token|relay.?token|VIBE_RELAY_TOKEN/i, 'no token field persisted')
  // url is the base only even for a token-gated viewer.
  assert.equal(findViewer('run_secretcheck')?.url, 'http://0.0.0.0:7681')
  for (const v of loadViewers()) removeViewer(v.viewer_id)
})

// ── CLI ──────────────────────────────────────────────────────────────────────

test('run viewers list --json shows live records (alive pid)', () => {
  const v = rec({ run_id: 'run_cli_list', pid: process.pid })
  addViewer(v)
  const r = vibe(['run', 'viewers', 'list', '--json'])
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout.trim()) as { viewers: ViewerRecord[] }
  assert.ok(out.viewers.some((x) => x.viewer_id === v.viewer_id), 'lists the live viewer')
  removeViewer(v.viewer_id)
})

test('run viewers open <run_id> prints the base URL (+ note when token-gated)', () => {
  const loop = rec({ run_id: 'run_open_loop', pid: process.pid, auth: 'none', url: 'http://127.0.0.1:7700' })
  const pub = rec({ run_id: 'run_open_pub', pid: process.pid, auth: 'token', url: 'http://0.0.0.0:7701' })
  addViewer(loop); addViewer(pub)
  const a = JSON.parse(vibe(['run', 'viewers', 'open', 'run_open_loop', '--json']).stdout.trim())
  assert.equal(a.url, 'http://127.0.0.1:7700')
  assert.ok(!a.note, 'loopback needs no note')
  const b = JSON.parse(vibe(['run', 'viewers', 'open', 'run_open_pub', '--json']).stdout.trim())
  assert.equal(b.url, 'http://0.0.0.0:7701')
  assert.match(b.note, /access token/, 'public-bind viewer notes the token')
  assert.doesNotMatch(b.url, /\?access=/, 'open never reconstructs a token URL')
  removeViewer(loop.viewer_id); removeViewer(pub.viewer_id)
})

test('run viewers open on an unknown target is structured viewer_not_found', () => {
  const r = vibe(['run', 'viewers', 'open', 'run_does_not_exist', '--json'])
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout.trim()).code, 'viewer_not_found')
})

test('run viewers stop kills the local viewer process and removes the record', async () => {
  // A throwaway sleeper stands in for a viewer process.
  const sleeper = spawn(NODE, ['-e', 'setTimeout(() => {}, 30000)'])
  await new Promise((r) => setTimeout(r, 200))
  const v = rec({ run_id: 'run_stop', pid: sleeper.pid! })
  addViewer(v)
  const r = vibe(['run', 'viewers', 'stop', v.viewer_id, '--json'])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout.trim()).stopped, true)
  await new Promise((res) => setTimeout(res, 300))
  assert.equal(isPidAlive(sleeper.pid!), false, 'viewer process was signalled')
  assert.equal(findViewer('run_stop'), undefined, 'record removed')
  try { sleeper.kill('SIGKILL') } catch { /* already dead */ }
})

test('all registry state stayed in the throwaway VIBE_DIR', () => {
  assert.ok(VIBE_DIR.includes('vibe-viewers-'))
  assert.ok(viewersPath().startsWith(VIBE_DIR))
})
