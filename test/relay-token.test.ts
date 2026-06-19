/**
 * Relay auth-token resolver + daemon argv-hygiene tests.
 *
 * The relay token must be resolvable from VIBE_RELAY_TOKEN or a --token-file so
 * the long-running `vibe node daemon` never carries it in process argv (where
 * `ps` / /proc/<pid>/cmdline would expose it). These tests pin the resolver
 * precedence, the token-free error path, and the daemon CLI behaviour.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolveRelayToken, warnIfTokenArg, RELAY_TOKEN_ENV } from '../src/relay/token.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

/** Run fn with VIBE_RELAY_TOKEN forced to a value (or deleted), then restore. */
function withEnvToken<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[RELAY_TOKEN_ENV]
  if (value === undefined) delete process.env[RELAY_TOKEN_ENV]
  else process.env[RELAY_TOKEN_ENV] = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[RELAY_TOKEN_ENV]
    else process.env[RELAY_TOKEN_ENV] = prev
  }
}

/** Write a token to a fresh temp file; returns the path. */
function tempTokenFile(contents: string): string {
  const p = path.join(os.tmpdir(), `vibe-token-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.writeFileSync(p, contents)
  return p
}

const SECRET_ENV = 'ZW52U2VjcmV0VG9rZW5WYWx1ZTEyMzQ1Njc4OTBhYmNkZQ=='
const SECRET_FILE = 'ZmlsZVNlY3JldFRva2VuVmFsdWUxMjM0NTY3ODkwYWJjZGU='
const SECRET_ARG = 'YXJnU2VjcmV0VG9rZW5WYWx1ZTEyMzQ1Njc4OTBhYmNkZWY='

test('resolveRelayToken: reads VIBE_RELAY_TOKEN env', () => {
  withEnvToken(SECRET_ENV, () => {
    assert.equal(resolveRelayToken({}), SECRET_ENV)
  })
})

test('resolveRelayToken: trims surrounding whitespace from env', () => {
  withEnvToken(`  ${SECRET_ENV}\n`, () => {
    assert.equal(resolveRelayToken({}), SECRET_ENV)
  })
})

test('resolveRelayToken: reads and trims --token-file', () => {
  const file = tempTokenFile(`${SECRET_FILE}\n`)
  try {
    withEnvToken(undefined, () => {
      assert.equal(resolveRelayToken({ tokenFile: file }), SECRET_FILE)
    })
  } finally {
    fs.unlinkSync(file)
  }
})

test('resolveRelayToken: precedence is --token-file > --token > env', () => {
  const file = tempTokenFile(SECRET_FILE)
  try {
    withEnvToken(SECRET_ENV, () => {
      // all three present → file wins
      assert.equal(resolveRelayToken({ tokenFile: file, token: SECRET_ARG }), SECRET_FILE)
      // no file → arg wins over env
      assert.equal(resolveRelayToken({ token: SECRET_ARG }), SECRET_ARG)
      // neither file nor arg → env
      assert.equal(resolveRelayToken({}), SECRET_ENV)
    })
  } finally {
    fs.unlinkSync(file)
  }
})

test('resolveRelayToken: clear, token-free error when no source exists', () => {
  withEnvToken(undefined, () => {
    assert.throws(
      () => resolveRelayToken({}),
      (err: Error) => {
        assert.match(err.message, /VIBE_RELAY_TOKEN/)
        assert.match(err.message, /--token-file/)
        // the message must never embed an actual token value
        assert.doesNotMatch(err.message, new RegExp(SECRET_ENV))
        assert.doesNotMatch(err.message, new RegExp(SECRET_FILE))
        return true
      },
    )
  })
})

test('resolveRelayToken: empty --token-file is rejected, error omits token', () => {
  const file = tempTokenFile('   \n')
  try {
    withEnvToken(SECRET_ENV, () => {
      assert.throws(
        () => resolveRelayToken({ tokenFile: file }),
        (err: Error) => {
          assert.match(err.message, /empty/)
          assert.match(err.message, new RegExp(file.replace(/[.\\/]/g, '\\$&')))
          return true
        },
      )
    })
  } finally {
    fs.unlinkSync(file)
  }
})

test('resolveRelayToken: missing --token-file error reports path, not a token', () => {
  const missing = path.join(os.tmpdir(), 'vibe-token-does-not-exist-xyz')
  assert.throws(
    () => resolveRelayToken({ tokenFile: missing }),
    (err: Error) => {
      assert.match(err.message, /--token-file could not be read/)
      assert.doesNotMatch(err.message, new RegExp(SECRET_ENV))
      return true
    },
  )
})

test('warnIfTokenArg: warns only when --token arg is the source, never prints value', () => {
  const orig = process.stderr.write.bind(process.stderr)
  let captured = ''
  ;(process.stderr as NodeJS.WriteStream).write = ((chunk: string | Uint8Array) => {
    captured += chunk.toString()
    return true
  }) as typeof process.stderr.write
  try {
    warnIfTokenArg({ token: SECRET_ARG })
    warnIfTokenArg({ tokenFile: '/some/path' }) // file source → no warning
    warnIfTokenArg({}) // env source → no warning
  } finally {
    process.stderr.write = orig
  }
  assert.match(captured, /--token is visible in process args/)
  assert.doesNotMatch(captured, new RegExp(SECRET_ARG))
  // exactly one warning line (only the --token-arg case warns)
  assert.equal(captured.split('\n').filter(l => l.includes('warning')).length, 1)
})

test('node daemon (CLI): no token source with --relay exits 1 with clear error', () => {
  const r = spawnSync(NODE, [CLI, 'node', 'daemon', '--local', '--relay', 'ws://127.0.0.1:1'], {
    encoding: 'utf8',
    env: (() => {
      const e = { ...process.env }
      delete e[RELAY_TOKEN_ENV]
      return e
    })(),
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /VIBE_RELAY_TOKEN/)
  assert.match(r.stderr, /--token-file/)
})

test('node daemon (CLI): accepts env token, token value absent from output', async () => {
  const proc = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', 'ws://127.0.0.1:1'], {
    stdio: 'pipe',
    env: { ...process.env, [RELAY_TOKEN_ENV]: SECRET_ENV },
  })
  let out = ''
  proc.stdout.on('data', d => (out += d.toString()))
  proc.stderr.on('data', d => (out += d.toString()))

  // Let it start up and attempt to connect, then stop it.
  await new Promise(resolve => setTimeout(resolve, 800))
  const closed = new Promise<void>(resolve => proc.on('close', () => resolve()))
  proc.kill('SIGKILL')
  // Don't hang the suite if the OS is slow to reap the process.
  await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 1500))])

  // It must NOT have rejected for a missing token...
  assert.doesNotMatch(out, /relay auth token required/)
  // ...and the secret must never appear in stdout/stderr.
  assert.doesNotMatch(out, new RegExp(SECRET_ENV))
})
