/**
 * `vibe terminal serve` remote-mode UX: profile defaults (relay/token-file),
 * safe --url-file handling, and token secrecy. Command-layer only — the gateway
 * binds its HTTP server immediately (the relay WS is lazy, per-browser), so these
 * spawn the real CLI WITHOUT any live relay/node.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function tmp(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }
const NO_PROFILE = path.join(tmp('vibe-tux-'), 'no-profile.json') // never created
after(() => { /* mkdtemp dirs are in os.tmpdir(); left for the OS to reap */ })

/** Write a connect profile (relay_url + token_file) and return its path. */
function writeProfile(relayUrl: string): { profile: string; tokenFile: string } {
  const dir = tmp('vibe-tuxprof-')
  const tokenFile = path.join(dir, 'relay.token')
  fs.writeFileSync(tokenFile, 'test-token-value\n', { mode: 0o600 })
  const profile = path.join(dir, 'profile.json')
  fs.writeFileSync(profile, JSON.stringify({ relay_url: relayUrl, token_file: tokenFile }))
  return { profile, tokenFile }
}

/** Spawn `vibe terminal serve …`; if it stays up, wait until urlFile appears then kill. */
function serve(args: string[], env: NodeJS.ProcessEnv, urlFile?: string, timeoutMs = 6000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(NODE, [CLI, 'terminal', 'serve', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; let done = false
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    const finish = (code: number | null): void => { if (done) return; done = true; try { proc.kill('SIGKILL') } catch { /* gone */ } ; resolve({ code, stdout, stderr }) }
    proc.on('exit', (code) => finish(code))
    // If a server is expected, poll for the url-file then stop it.
    ;(async () => {
      const deadline = Date.now() + timeoutMs
      while (!done && Date.now() < deadline) {
        if (urlFile && fs.existsSync(urlFile)) { await delay(150); proc.kill('SIGTERM'); await delay(300); finish(0); return }
        await delay(100)
      }
      if (!done) { proc.kill('SIGTERM'); await delay(300); finish(null) }
    })()
  })
}

test('remote serve uses profile relay/token-file when not passed (starts, no relay_required)', async () => {
  const { profile } = writeProfile('ws://127.0.0.1:59999')
  const urlFile = path.join(tmp('vibe-tuxurl-'), 'url')
  const r = await serve(['--node', 'n1', '--session', 's1', '--host', '127.0.0.1', '--port', '0', '--url-file', urlFile], { ...process.env, VIBE_PROFILE: profile }, urlFile)
  assert.ok(!r.stdout.includes('relay_required'), `unexpected relay_required: ${r.stdout}`)
  assert.ok(fs.existsSync(urlFile), 'server started and wrote the url-file (profile relay accepted)')
  assert.match(fs.readFileSync(urlFile, 'utf8'), /^http:\/\/127\.0\.0\.1:\d+\/\?control=/, 'url-file has the tokenized URL')
})

test('no profile and no --relay → relay_required', async () => {
  const r = await serve(['--node', 'n1', '--session', 's1', '--host', '127.0.0.1', '--port', '0', '--json'], { ...process.env, VIBE_PROFILE: NO_PROFILE })
  assert.notEqual(r.code, 0)
  const obj = JSON.parse(r.stdout.trim().split('\n').pop() as string)
  assert.equal(obj.error, true); assert.equal(obj.code, 'relay_required')
})

test('explicit --relay/--token-file work with no profile (override path)', async () => {
  const { tokenFile } = writeProfile('ws://unused')
  const urlFile = path.join(tmp('vibe-tuxurl-'), 'url')
  const r = await serve(['--node', 'n1', '--session', 's1', '--relay', 'ws://127.0.0.1:59998', '--token-file', tokenFile, '--host', '127.0.0.1', '--port', '0', '--url-file', urlFile], { ...process.env, VIBE_PROFILE: NO_PROFILE }, urlFile)
  assert.ok(!r.stdout.includes('relay_required'))
  assert.ok(fs.existsSync(urlFile), 'started with explicit flags and no profile')
})

test('--url-file writes the URL, creates the parent dir, and is 0600', async () => {
  const { profile } = writeProfile('ws://127.0.0.1:59999')
  const urlFile = path.join(tmp('vibe-tuxurl-'), 'nested', 'deeper', 'terminal-url') // parent dirs don't exist yet
  const r = await serve(['--node', 'n1', '--session', 's1', '--host', '127.0.0.1', '--port', '0', '--url-file', urlFile], { ...process.env, VIBE_PROFILE: profile }, urlFile)
  assert.ok(fs.existsSync(urlFile), `url-file created (parent dirs made): ${r.stderr}`)
  assert.match(fs.readFileSync(urlFile, 'utf8'), /\/\?control=/)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(urlFile).mode & 0o777, 0o600, 'url-file is 0600')
  }
})

test('with --url-file, the control token never appears on stdout/stderr; relay token never logged', async () => {
  const { profile, tokenFile } = writeProfile('ws://127.0.0.1:59999')
  const relayToken = fs.readFileSync(tokenFile, 'utf8').trim()
  const urlFile = path.join(tmp('vibe-tuxurl-'), 'url')
  const r = await serve(['--node', 'n1', '--session', 's1', '--host', '127.0.0.1', '--port', '0', '--url-file', urlFile], { ...process.env, VIBE_PROFILE: profile }, urlFile)
  const both = r.stdout + r.stderr
  assert.ok(!both.includes('control='), 'no control token on stdout/stderr when --url-file is used')
  assert.ok(!both.includes(relayToken), 'relay token value never logged')
  assert.match(r.stdout, /URL written to/, 'prints a safe pointer line instead')
  assert.match(fs.readFileSync(urlFile, 'utf8'), /control=/, '(the token lives only in the 0600 file)')
})

test('--print-url-only prints just the URL', async () => {
  const { profile } = writeProfile('ws://127.0.0.1:59999')
  const r = await serve(['--node', 'n1', '--session', 's1', '--host', '127.0.0.1', '--port', '0', '--print-url-only'], { ...process.env, VIBE_PROFILE: profile }, undefined, 3500)
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  const urlLine = lines.find((l) => l.startsWith('http://'))
  assert.ok(urlLine, `expected a bare URL line, got: ${JSON.stringify(lines)}`)
  assert.match(urlLine!, /^http:\/\/127\.0\.0\.1:\d+\/\?control=\S+$/)
})
