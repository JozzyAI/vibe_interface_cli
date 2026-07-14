/**
 * Official-client compatibility: drives the REAL spawned `vibe mcp serve` stdio
 * server with the official MCP TypeScript SDK (a DEV dependency only — never a
 * production runtime dependency). Verifies initialize / notifications/initialized
 * / ping / tools/list / tools/call (result + error shapes) / clean shutdown, and
 * that the SDK — which treats stdout strictly as protocol — parses the whole
 * session without error (i.e. stdout is protocol-only). A minimal fake gateway
 * backs the tool calls.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { SUPPORTED_PROTOCOL } from '../src/mcp/server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const TOKEN = 'compat-tok-' + 'b'.repeat(40)

let server: http.Server
let PORT = 0
function sendJson(res: http.ServerResponse, s: number, b: unknown): void { const j = JSON.stringify(b); res.writeHead(s, { 'content-type': 'application/json' }); res.end(j) }

before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return sendJson(res, 401, { error: true, code: 'unauthorized', message: 'nope', retryable: false, ts: 't' })
    const parts = new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean)
    if (parts.join('/') === 'v1/agents') return sendJson(res, 200, { agents: [{ id: 'mock', available: true, streaming: true }] })
    if (parts.join('/') === 'v1/tasks' && req.method === 'POST') { let raw = ''; req.on('data', (d) => { raw += d }); req.on('end', () => { const b = JSON.parse(raw); sendJson(res, 202, { task_id: 'run_1', agent: b.agent, status: 'completed', contract_version: 1, created_at: 't', updated_at: 't' }) }); return }
    if (parts[0] === 'v1' && parts[1] === 'tasks' && parts.length === 3) { return parts[2] === 'run_1' ? sendJson(res, 200, { task_id: 'run_1', agent: 'mock', status: 'completed', contract_version: 1, created_at: 't', updated_at: 't' }) : sendJson(res, 404, { error: true, code: 'task_not_found', message: 'no such task', task_id: parts[2], retryable: false, ts: 't' }) }
    sendJson(res, 404, { error: true, code: 'task_not_found', message: 'nf', retryable: false, ts: 't' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  PORT = (server.address() as { port: number }).port
})
after(async () => { await new Promise<void>((r) => server.close(() => r())) })

test('server preferred protocol matches the official SDK latest (2025-11-25)', () => {
  assert.equal(SUPPORTED_PROTOCOL, '2025-11-25')
  assert.equal(SUPPORTED_PROTOCOL, LATEST_PROTOCOL_VERSION, 'server prefers exactly the SDK LATEST_PROTOCOL_VERSION')
})

test('built CLI `vibe --version` reports the package.json version (not the 0.0.0 sentinel)', () => {
  const pkgVersion = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version
  const out = execFileSync(NODE, [CLI, '--version'], { encoding: 'utf8' }).trim()
  assert.equal(out, pkgVersion, '`vibe --version` equals package.json version')
  assert.equal(out, '0.2.0', '`vibe --version` is the v0.2.0 release version')
  assert.notEqual(out, '0.0.0')
})

test('official MCP SDK client drives the real stdio server end to end', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-compat-'))
  const tf = path.join(dir, 'api-token'); fs.writeFileSync(tf, TOKEN + '\n', { mode: 0o600 })

  const transport = new StdioClientTransport({
    command: NODE,
    args: [CLI, 'mcp', 'serve', '--gateway-url', `http://127.0.0.1:${PORT}`, '--token-file', tf],
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

  const client = new Client({ name: 'compat-test', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport) // performs initialize + notifications/initialized

  // negotiated protocol version is one our server supports
  const proto = transport as unknown as { _protocolVersion?: string }
  if (proto._protocolVersion) assert.ok(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(proto._protocolVersion), `negotiated ${proto._protocolVersion}`)

  // serverInfo (from the REAL spawned CLI) reports the correct name AND the actual
  // package.json version — not the '0.0.0' sentinel. This exercises the built
  // dist layout, where a fixed relative require previously mis-resolved to 0.0.0.
  const info = (client as unknown as { getServerVersion?: () => { name?: string; version?: string } }).getServerVersion?.()
  const pkgVersion = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version
  assert.equal(info?.name, 'vibe-agent-gateway', 'serverInfo.name')
  assert.equal(info?.version, pkgVersion, 'serverInfo.version equals package.json version')
  assert.equal(info?.version, '0.2.0', 'serverInfo.version is the v0.2.0 release version')
  assert.notEqual(info?.version, '0.0.0', 'serverInfo.version must not be the unknown sentinel')

  await client.ping() // must succeed

  const list = await client.listTools()
  assert.deepEqual(list.tools.map((t) => t.name).sort(), ['vibe_cancel_task', 'vibe_get_task', 'vibe_get_task_events', 'vibe_list_agents', 'vibe_run_task', 'vibe_start_task', 'vibe_wait_task'])
  const cancel = list.tools.find((t) => t.name === 'vibe_cancel_task')!
  assert.equal((cancel as { annotations?: { destructiveHint?: boolean } }).annotations?.destructiveHint, true)

  // tools/call: a successful result
  const agents = await client.callTool({ name: 'vibe_list_agents', arguments: {} })
  assert.ok(Array.isArray((agents as { content: unknown[] }).content))
  assert.ok(JSON.parse(((agents as { content: Array<{ text: string }> }).content[0]).text).agents.length >= 1)

  // tools/call: an error result (unknown task -> gateway task_not_found -> isError)
  const err = await client.callTool({ name: 'vibe_get_task', arguments: { task_id: 'run_missing' } })
  assert.equal((err as { isError?: boolean }).isError, true)
  assert.equal(JSON.parse(((err as { content: Array<{ text: string }> }).content[0]).text).code, 'task_not_found')

  await client.close() // clean shutdown
  // diagnostics went to stderr (not stdout), and the token never leaked
  assert.ok(stderr.includes('vibe mcp:'), 'startup diagnostic on stderr')
  assert.ok(!stderr.includes(TOKEN), 'token never on stderr')
  fs.rmSync(dir, { recursive: true, force: true })
})
