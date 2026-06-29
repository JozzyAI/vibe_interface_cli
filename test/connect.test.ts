/**
 * `vibe connect` onboarding. Fake relay + mock only, throwaway VIBE_DIR and a
 * temp VIBE_PROFILE. No production relay, no real agents, no token ever stored.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { startRelayServer } from '../src/relay/server.js'
import { shellQuote } from '../src/commands/connect.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

const TEST_TOKEN = `connect-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-connect-')) }

// Async spawn (not spawnSync): an in-process relay shares this event loop, so a
// blocking call would deadlock the pairing handshake.
function connect(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(NODE, [CLI, 'connect', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
    setTimeout(() => { proc.kill('SIGTERM'); resolve({ status: 124, stdout, stderr: stderr + '\n[timeout]' }) }, 15000)
  })
}

// ── shell-safe quoting of the printed daemon command ─────────────────────────

const BASH_OK = spawnSync('bash', ['-c', 'true']).status === 0

test('shellQuote round-trips through a real shell for nasty values', { skip: !BASH_OK }, () => {
  for (const value of ['/tmp/dir with space', "a'b", 'a$b', 'a&b', 'a(b)c', 'a"b', 'a;b|c', 'wss://h/p?x=1&y=2']) {
    // Assign the quoted token in bash and echo it back — must equal the original.
    const r = spawnSync('bash', ['-c', `v=${shellQuote(value)}; printf %s "$v"`], { encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, value, `shellQuote did not round-trip for: ${value}`)
  }
})

test('connect daemon command is copy-paste safe with spaces/specials in paths', { skip: !BASH_OK }, async () => {
  const vibeDir = path.join(tmp(), 'dir with space (paren)')
  const tokenFile = '/tmp/tok dir/relay token'
  const profile = path.join(tmp(), 'profile.json')
  const env = { ...process.env, VIBE_DIR: vibeDir, VIBE_PROFILE: profile }
  const out = JSON.parse((await connect(['--name', 'x', '--relay', 'wss://h/p?a=1&b=2', '--token-file', tokenFile, '--vibe-dir', vibeDir, '--dry-run', '--json'], env)).stdout.trim())
  const cmd: string = out.would.daemon_command

  // Spaced/special values appear single-quoted (not bare, which would word-split).
  assert.ok(cmd.includes(shellQuote(vibeDir)), 'vibe_dir is quoted')
  assert.ok(cmd.includes(shellQuote(tokenFile)), 'token-file is quoted')
  assert.ok(cmd.includes(shellQuote('wss://h/p?a=1&b=2')), 'relay url is quoted')

  // A real shell parses the whole command without a syntax error (no executing it).
  assert.equal(spawnSync('bash', ['-n', '-c', cmd]).status, 0, 'daemon command is valid shell syntax')
})

// ── dry-run: zero side effects, no token ──────────────────────────────────────

test('connect --dry-run writes nothing, creates no identity, contacts no relay', async () => {
  const vibeDir = tmp(); const profile = path.join(tmp(), 'profile.json')
  const env = { ...process.env, VIBE_DIR: vibeDir, VIBE_PROFILE: profile }
  const r = await connect(['--name', 'work-laptop', '--relay', 'wss://example.invalid', '--token-file', '/nope', '--dry-run', '--json'], env)
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.dry_run, true)
  assert.equal(out.would.identity, 'create new')
  assert.deepEqual(out.would.advertise_agents, ['mock'])
  assert.match(out.would.pair, /pair with wss:\/\/example\.invalid/)
  assert.equal(fs.existsSync(profile), false, 'no profile written')
  assert.equal(fs.existsSync(path.join(vibeDir, 'identity.json')), false, 'no identity created')
})

test('connect --json without --yes or --dry-run errors (cannot prompt)', async () => {
  const env = { ...process.env, VIBE_DIR: tmp(), VIBE_PROFILE: path.join(tmp(), 'profile.json') }
  const r = await connect(['--relay', 'wss://example.invalid', '--json'], env)
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout.trim()).code, 'confirmation_required')
})

test('connect rejects an invalid advertised agent', async () => {
  const env = { ...process.env, VIBE_DIR: tmp(), VIBE_PROFILE: path.join(tmp(), 'profile.json') }
  const r = await connect(['--advertise-agent', 'not-a-real-agent', '--dry-run', '--json'], env)
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout.trim()).code, 'advertise_agent_invalid')
})

// ── full connect against a FAKE relay ─────────────────────────────────────────

test('connect --yes creates identity, writes a token-free profile, and pairs (fake relay)', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  after(() => server.close())
  const relayUrl = `ws://127.0.0.1:${server.port}`

  const vibeDir = tmp()
  const profile = path.join(tmp(), 'profile.json')
  const tokenFile = path.join(vibeDir, 'tok'); fs.writeFileSync(tokenFile, TEST_TOKEN + '\n', { mode: 0o600 })
  const env = { ...process.env, VIBE_DIR: vibeDir, VIBE_PROFILE: profile }

  const r = await connect(['--name', 'work-laptop', '--relay', relayUrl, '--token-file', tokenFile, '--vibe-dir', vibeDir, '--yes', '--json'], env)
  assert.equal(r.status, 0, `connect failed: ${r.stdout}${r.stderr}`)
  const out = JSON.parse(r.stdout.trim())

  assert.equal(out.connected, true)
  assert.match(out.node_id, /^node_[0-9a-f]{16}$/)
  assert.equal(out.display_name, 'work-laptop', 'display name applied at creation')
  assert.equal(out.identity_reused, false)
  assert.deepEqual(out.advertise_agents, ['mock'])
  assert.equal(out.paired?.status, 'paired', 'node paired on the fake relay')
  assert.equal(server.pairedCount(), 1)
  assert.match(out.daemon_command, /VIBE_NODE_ADVERTISE_AGENTS='mock'/)
  assert.doesNotMatch(out.daemon_command, /--token [^-]/, 'daemon cmd uses --token-file, never --token <value>')

  // Identity + profile exist; profile is 0600 and TOKEN-FREE.
  assert.ok(fs.existsSync(path.join(vibeDir, 'identity.json')))
  assert.ok(fs.existsSync(profile))
  if (process.platform !== 'win32') assert.equal(fs.statSync(profile).mode & 0o777, 0o600)
  const profileRaw = fs.readFileSync(profile, 'utf8')
  assert.doesNotMatch(profileRaw, new RegExp(TEST_TOKEN), 'the relay token value is never written to the profile')
  const p = JSON.parse(profileRaw)
  assert.equal(p.relay_url, relayUrl)
  assert.equal(p.token_file, tokenFile, 'stores the token-file PATH, not the value')
  assert.equal(p.node_id, out.node_id)

  // The whole stdout/stderr stream never leaks the token value.
  assert.ok(!(r.stdout + r.stderr).includes(TEST_TOKEN), 'token absent from all output')
})

test('connect is idempotent: re-run reuses the identity + profile defaults', async () => {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  after(() => server.close())
  const relayUrl = `ws://127.0.0.1:${server.port}`
  const vibeDir = tmp(); const profile = path.join(tmp(), 'profile.json')
  const tokenFile = path.join(vibeDir, 'tok'); fs.writeFileSync(tokenFile, TEST_TOKEN + '\n', { mode: 0o600 })
  const env = { ...process.env, VIBE_DIR: vibeDir, VIBE_PROFILE: profile }

  const first = JSON.parse((await connect(['--name', 'work-laptop', '--relay', relayUrl, '--token-file', tokenFile, '--vibe-dir', vibeDir, '--yes', '--json'], env)).stdout.trim())
  // Re-run with NO flags: relay/token/name come from the saved profile.
  const second = JSON.parse((await connect(['--yes', '--json'], env)).stdout.trim())

  assert.equal(second.identity_reused, true, 'identity reused on re-run')
  assert.equal(second.node_id, first.node_id, 'same node_id')
  assert.equal(second.relay_url, relayUrl, 'relay came from the saved profile')
  assert.equal(second.display_name, 'work-laptop')
})

test('connect --name on an existing identity is ignored with a clear note', async () => {
  const vibeDir = tmp(); const profile = path.join(tmp(), 'profile.json')
  const env = { ...process.env, VIBE_DIR: vibeDir, VIBE_PROFILE: profile }
  // First connect (no relay → no pairing) creates the identity as "first-name".
  await connect(['--name', 'first-name', '--yes', '--json'], env)
  const r = JSON.parse((await connect(['--name', 'second-name', '--yes', '--json'], env)).stdout.trim())
  assert.equal(r.display_name, 'first-name', 'display name fixed at creation')
  assert.match(r.name_note, /already exists/)
})
