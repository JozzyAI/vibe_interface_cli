/**
 * Migration behavior — ordered, transactional, idempotent, fail-closed. Uses
 * temporary databases only; never touches a production DB.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { openControlStore } from '../src/control/sqlite-store.js'
import { runMigrations, LATEST_SCHEMA_VERSION } from '../src/control/migrations.js'
import { ControlStoreError } from '../src/control/records.js'

const tmpDbPath = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mig-')), 'control.sqlite')

test('migrate() is idempotent and reports the latest version', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  assert.equal(await s.migrate(), LATEST_SCHEMA_VERSION)
  assert.equal(await s.migrate(), LATEST_SCHEMA_VERSION) // no-op second time
  const raw = new Database(s.dbPath)
  assert.equal((raw.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c, LATEST_SCHEMA_VERSION)
  raw.close(); await s.close()
})

test('data survives close + reopen (migrate no-op)', async () => {
  const p = tmpDbPath()
  let s = openControlStore({ path: p })
  await s.createTask({ task_id: 'run_1', agent: 'mock', status: 'running' })
  await s.close()
  s = openControlStore({ path: p }) // reopen re-runs migrate() as a no-op
  assert.equal((await s.getTask('run_1'))?.agent, 'mock')
  await s.close()
})

test('unknown NEWER schema version fails closed', async () => {
  const p = tmpDbPath()
  const s = openControlStore({ path: p }); await s.close()
  const raw = new Database(p)
  raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(999, new Date().toISOString())
  raw.close()
  assert.throws(() => openControlStore({ path: p }), (e: unknown) => e instanceof ControlStoreError && e.code === 'unsupported_schema_version')
})

test('corrupt schema metadata returns a structured error', async () => {
  const p = tmpDbPath()
  const s = openControlStore({ path: p }); await s.close()
  const raw = new Database(p)
  raw.exec('DROP TABLE schema_migrations')
  raw.exec('CREATE TABLE schema_migrations (version TEXT, applied_at TEXT)') // text version = corrupt metadata
  raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('not-an-int', new Date().toISOString())
  raw.close()
  assert.throws(() => openControlStore({ path: p }), (e: unknown) => e instanceof ControlStoreError && e.code === 'corruption')
})

test('a failing migration rolls back (transactional; version not recorded)', () => {
  const p = tmpDbPath()
  const raw = new Database(p)
  raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  raw.exec('CREATE TABLE tasks (x INTEGER)') // pre-existing conflicting table makes migration 1 fail
  assert.throws(() => runMigrations(raw)) // CREATE TABLE tasks in the migration collides
  assert.equal((raw.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c, 0, 'no version recorded on rollback')
  raw.close()
})
