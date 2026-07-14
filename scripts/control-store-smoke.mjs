// Native-dependency portability smoke: proves better-sqlite3 loads and a
// temporary control database can be opened, migrated, queried, and closed.
// Cross-platform (Linux/macOS/Windows), Node 20+. Exits non-zero on failure.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openControlStore } from '../dist/src/control/sqlite-store.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-smoke-'))
const dbPath = path.join(dir, 'control.sqlite')
try {
  const store = openControlStore({ path: dbPath }) // loads better-sqlite3, opens + migrates
  const health = await store.healthCheck()
  assert.equal(health.schema_version, 1, 'migrated to schema v1')
  assert.equal(health.journal_mode, 'wal', 'WAL enabled')
  assert.equal(health.foreign_keys, true, 'foreign_keys enabled')
  assert.ok(health.busy_timeout > 0, 'busy_timeout set')

  await store.createTask({ task_id: 'smoke_1', agent: 'mock', status: 'running' })
  const got = await store.getTask('smoke_1')
  assert.equal(got?.task_id, 'smoke_1', 'query round-trips')
  await store.close()

  console.log(`OK: better-sqlite3 loaded; opened/migrated/queried/closed ${dbPath} on ${process.platform} node ${process.version}`)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
