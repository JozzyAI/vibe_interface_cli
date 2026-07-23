/**
 * Durable-result integrity × redaction ordering invariant:
 *   content_hash === sha256(the EXACT canonical persisted final_output.text)
 *
 * Root cause fixed: buildTaskResult hashed the ORIGINAL text, then
 * `writeRun → redactDeep` rewrote token-like substrings in the persisted copy,
 * so `persistTerminalResult`'s validateTaskResult saw a content_hash_mismatch
 * and downgraded a successful result to `invalid`. buildTaskResult now redacts
 * FIRST and hashes the redacted canonical text; write-time redaction is an
 * idempotent no-op on it.
 *
 * Layers: unit invariants (redact idempotency, hash-over-stored-text, secret
 * absence, genuine-corruption detection) + e2e over an in-process relay +
 * spawned daemon for BOTH scratch and cwd-backed tasks, including a gateway
 * restart readback of the available redacted result.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { redact, redactDeep } from '../src/redact.js'
import { buildTaskResult, validateTaskResult, computeResultContentHash } from '../src/lib/agent-task-result.js'
import { startRelayServer } from '../src/relay/server.js'
import { startAgentGateway, type GatewayServer } from '../src/lib/agent-gateway.js'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Secret-like corpus covering every redaction rule class the bug hit in the wild.
const SECRET = 'sk-test1234567890abcdefghij'
const SECRETY_TEXT = [
  `The sample credential is ${SECRET}.`,
  'Authorization: Bearer abc.def-ghi_jkl',
  'pair with `--token supersecretvalue` (never do this)',
  'export VIBE_RELAY_TOKEN=hunter2hunter2',
].join('\n')

// ── unit: ordering invariant ─────────────────────────────────────────────────

test('redact() is idempotent over every rule class (guards the invariant)', () => {
  const corpus = [
    SECRETY_TEXT,
    'ghp_' + 'a'.repeat(24), 'github_pat_' + 'b'.repeat(24), 'AKIA' + 'C'.repeat(16),
    'https://user:tok@host/x', '?token=abc&token=def', 'GH_TOKEN: xyz',
    '-----BEGIN RSA PRIVATE KEY-----', 'plain text with no secrets at all',
  ]
  for (const t of corpus) {
    const once = redact(t)
    assert.equal(redact(once), once, `idempotent for: ${t.slice(0, 40)}`)
  }
})

test('clean output: available flow unchanged; hash matches stored text', () => {
  const r = buildTaskResult({ text: 'All tests passed. Nothing secret here.', processExitCode: 0 })
  assert.equal(r.final_output.text, 'All tests passed. Nothing secret here.')
  assert.equal(r.content_hash, computeResultContentHash(r.final_output.text))
  assert.equal(validateTaskResult(r).ok, true)
})

test('secret-like output: persisted redacted, hash matches the redacted canonical text, validates ok', () => {
  const r = buildTaskResult({ text: SECRETY_TEXT, processExitCode: 0 })
  assert.ok(!r.final_output.text.includes(SECRET), 'sk-… value not present')
  assert.ok(!r.final_output.text.includes('abc.def-ghi_jkl'), 'Bearer value not present')
  assert.ok(!r.final_output.text.includes('supersecretvalue'), '--token value not present')
  assert.ok(!r.final_output.text.includes('hunter2hunter2'), 'env token value not present')
  assert.ok(r.final_output.text.includes('[REDACTED]'))
  assert.equal(r.content_hash, crypto.createHash('sha256').update(r.final_output.text, 'utf8').digest('hex'), 'hash describes the EXACT stored text')
  const v = validateTaskResult(r)
  assert.equal(v.ok, true, 'redacted result validates (no mismatch)')
})

test('write-time redactDeep is a NO-OP on a built result (the two passes agree)', () => {
  const r = buildTaskResult({ text: SECRETY_TEXT, processExitCode: 0 })
  assert.deepEqual(redactDeep(r), r, 'persisted representation === hashed representation')
  assert.equal(validateTaskResult(redactDeep(r)).ok, true)
})

test('genuine corruption is still detected: mutated stored text → content_hash_mismatch', () => {
  const r = buildTaskResult({ text: SECRETY_TEXT, processExitCode: 0 })
  const tampered = { ...r, final_output: { ...r.final_output, text: r.final_output.text + ' TAMPERED' } }
  const v = validateTaskResult(tampered)
  assert.equal(v.ok, false)
  if (!v.ok) assert.equal(v.code, 'content_hash_mismatch')
})

// ── e2e: scratch + cwd tasks over relay/daemon; gateway restart readback ─────

const TOKEN = `relay-tok-${Math.random().toString(36).slice(2)}`
const API = `api-tok-${Math.random().toString(36).slice(2)}`
const NODE_ID = 'redact-hash-node'

interface Live { server: Awaited<ReturnType<typeof startRelayServer>>; daemon: ReturnType<typeof spawn>; relayUrl: string; nodeVibeDir: string; fixtureRepo: string; storePath: string }
let live: Live | undefined
let gw: GatewayServer
let store: SqliteControlStore

function vibe(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''; p.stdout!.on('data', (d: Buffer) => { out += d.toString() })
    p.on('close', () => resolve(out))
    setTimeout(() => { p.kill('SIGKILL'); resolve(out) }, timeoutMs)
  })
}

before(async () => {
  const server = await startRelayServer({ port: 0, token: TOKEN })
  const relayUrl = `ws://127.0.0.1:${server.port}`
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-rhash-'))
  process.env.VIBE_DIR = path.join(base, 'gateway'); fs.mkdirSync(process.env.VIBE_DIR, { recursive: true })
  const tokenFile = path.join(base, 'tok'); fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 })
  const cwdRoot = path.join(base, 'projects'); const fixtureRepo = path.join(cwdRoot, 'repo'); fs.mkdirSync(fixtureRepo, { recursive: true })
  // fake claude whose FINAL RESULT contains secret-like text (stream-json contract)
  const fakeBin = path.join(base, 'fakebin'); fs.mkdirSync(fakeBin)
  fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/usr/bin/env node
const sid='fake-rh'
const emit=(o)=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',()=>{})
process.stdin.on('end',()=>{
  emit({type:'system',subtype:'init',session_id:sid,cwd:process.cwd(),tools:[]})
  const text='Done. Example creds: ${SECRET} and Bearer abc.def-ghi_jkl and --token supersecretvalue.'
  emit({type:'assistant',session_id:sid,message:{type:'message',role:'assistant',content:[{type:'text',text}]}})
  emit({type:'result',subtype:'success',is_error:false,result:text,session_id:sid})
  process.exit(0)
})
`, { mode: 0o755 })
  const nodeVibeDir = path.join(base, 'node')
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', NODE_ID], {
    env: { ...process.env, VIBE_DIR: nodeVibeDir, VIBE_RELAY_TOKEN: TOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'claude-code', VIBE_ALLOWED_CWD_ROOTS: cwdRoot, PATH: `${fakeBin}:${process.env.PATH}` },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 12000
  let up = false
  while (Date.now() < deadline && !up) {
    await delay(300)
    try { if (JSON.parse((await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', tokenFile, '--json'], { ...process.env })).trim()).some((n: { node_id: string }) => n.node_id === NODE_ID)) up = true } catch { /* */ }
  }
  if (!up) { daemon.kill('SIGKILL'); await server.close(); return }
  const storePath = path.join(base, 'control.sqlite')
  store = openControlStore({ path: storePath })
  gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: API, relay: relayUrl, relayToken: TOKEN, taskStore: store, controlStore: store })
  live = { server, daemon, relayUrl, nodeVibeDir, fixtureRepo, storePath }
})

after(async () => {
  if (gw) await gw.close()
  try { store?.closeSync() } catch { /* */ }
  if (live) { if (!live.daemon.killed) live.daemon.kill('SIGKILL'); await delay(200); await live.server.close() }
})

interface Res { status: number; body: any }
function jreq(method: string, p: string, body?: unknown, port?: number): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { authorization: `Bearer ${API}` }
    const payload = body === undefined ? undefined : JSON.stringify(body)
    if (payload !== undefined) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port: port ?? gw.port, path: p, method, headers }, (res) => {
      let text = ''; res.on('data', (d) => { text += d }); res.on('end', () => { let b: any = null; try { b = JSON.parse(text) } catch { /* */ } resolve({ status: res.statusCode ?? 0, body: b }) })
    })
    r.on('error', reject); if (payload !== undefined) r.write(payload); r.end()
  })
}
async function waitAvailable(taskId: string, port?: number, ms = 20000): Promise<any> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const r = await jreq('GET', `/v1/tasks/${taskId}`, undefined, port)
    if (r.body?.status === 'completed' && r.body?.result_status && r.body.result_status !== 'pending') return r.body
    await delay(250)
  }
  throw new Error('task did not reach completed+finalized result')
}
const gatewayResultRow = (storePath: string, taskId: string) => {
  // read through a fresh read-only connection so we see the durable row
  const db = new Database(storePath, { readonly: true })
  try { return db.prepare('select result_status, final_output_text, content_hash from task_results where task_id=?').get(taskId) as { result_status: string; final_output_text: string | null; content_hash: string | null } | undefined }
  finally { db.close() }
}

async function runTask(idem: string, workspace: Record<string, unknown>): Promise<{ taskId: string }> {
  const r = await jreq('POST', '/v1/tasks', { agent: 'claude-code', node_id: NODE_ID, input: { text: 'produce the secrety report' }, workspace, execution: { permission_mode: 'default' }, idempotency_key: idem })
  assert.equal(r.status, 202, JSON.stringify(r.body))
  return { taskId: r.body.task_id }
}

function assertRedactedAvailable(row: { result_status: string; final_output_text: string | null; content_hash: string | null } | undefined, label: string): void {
  assert.ok(row, `${label}: durable result row exists`)
  assert.equal(row!.result_status, 'available', `${label}: available (not invalid)`)
  const text = row!.final_output_text!
  assert.ok(!text.includes(SECRET), `${label}: sk-… secret absent from durable payload`)
  assert.ok(!text.includes('supersecretvalue'), `${label}: --token value absent`)
  assert.ok(!text.includes('abc.def-ghi_jkl'), `${label}: Bearer value absent`)
  assert.ok(text.includes('[REDACTED]'), `${label}: redaction visible`)
  assert.equal(row!.content_hash, crypto.createHash('sha256').update(text, 'utf8').digest('hex'), `${label}: stored hash === sha256(stored text)`)
}

test('e2e scratch task: secrety output → available, redacted, hash matches stored text (node journal + gateway store)', { timeout: 30000 }, async (t) => {
  if (!live) return t.skip('daemon did not register')
  const { taskId } = await runTask('rh-scratch-1', { workspace_key: 'rh-scratch-1' })
  const done = await waitAvailable(taskId)
  assert.equal(done.result_status, 'available')
  assertRedactedAvailable(gatewayResultRow(live.storePath, taskId), 'gateway store')
  // node journal row (authoritative node-side persistence)
  const jdb = new Database(path.join(live.nodeVibeDir, 'node-run-journal.sqlite'), { readonly: true })
  try {
    const rows = jdb.prepare('select result_status, final_output_text, content_hash from run_results').all() as Array<{ result_status: string; final_output_text: string | null; content_hash: string | null }>
    assert.ok(rows.length >= 1)
    for (const row of rows) assertRedactedAvailable(row, 'node journal')
  } finally { jdb.close() }
})

test('e2e cwd-backed task: same invariant holds', { timeout: 30000 }, async (t) => {
  if (!live) return t.skip('daemon did not register')
  const { taskId } = await runTask('rh-cwd-1', { path: live.fixtureRepo })
  const done = await waitAvailable(taskId)
  assert.equal(done.result_status, 'available')
  assertRedactedAvailable(gatewayResultRow(live.storePath, taskId), 'gateway store (cwd)')
})

test('gateway restart: the available redacted result is preserved and still validates', { timeout: 30000 }, async (t) => {
  if (!live) return t.skip('daemon did not register')
  const { taskId } = await runTask('rh-restart-1', { workspace_key: 'rh-restart-1' })
  await waitAvailable(taskId)
  await gw.close()
  gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: API, relay: live.relayUrl, relayToken: TOKEN, taskStore: store, controlStore: store })
  const g = await jreq('GET', `/v1/tasks/${taskId}`)
  assert.equal(g.body.status, 'completed')
  assert.equal(g.body.result_status, 'available', 'result survives a gateway restart as available')
  const row = gatewayResultRow(live.storePath, taskId)
  assertRedactedAvailable(row, 'post-restart store')
  // and the stored envelope still passes full validation (no silent hash skip)
  const rebuilt = { schema_version: '1', final_output: { kind: 'text', text: row!.final_output_text }, process_exit_code: 0, finalized_at: new Date().toISOString(), content_hash: row!.content_hash, evidence_refs: [], artifact_refs: [] }
  assert.equal(validateTaskResult(rebuilt).ok, true)
})
