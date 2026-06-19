/**
 * redact() unit tests — the handoff/event-log secret backstop.
 * Confirms every token shape the meta-agent runtime might encounter is scrubbed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact } from '../src/redact.js'

test('redact: GitHub token prefixes (gho_, ghp_, ghu_, ghs_, ghr_)', () => {
  for (const prefix of ['gho_', 'ghp_', 'ghu_', 'ghs_', 'ghr_']) {
    const token = prefix + 'A'.repeat(36)
    const out = redact(`token=${token}`)
    assert.doesNotMatch(out, new RegExp(prefix.replace('_', '_') + 'A'), `${prefix} must be redacted`)
    assert.match(out, /\[REDACTED\]/)
  }
})

test('redact: fine-grained github_pat_', () => {
  const token = 'github_pat_' + 'B'.repeat(40)
  const out = redact(`GH=${token}`)
  assert.doesNotMatch(out, /github_pat_B/)
  assert.match(out, /\[REDACTED\]/)
})

test('redact: GH_TOKEN / GITHUB_TOKEN env assignments keep name, drop value', () => {
  const out1 = redact('GH_TOKEN=supersecretvalue123')
  assert.doesNotMatch(out1, /supersecretvalue123/)
  assert.match(out1, /GH_TOKEN=\[REDACTED\]/)

  const out2 = redact('GITHUB_TOKEN: anothersecret456')
  assert.doesNotMatch(out2, /anothersecret456/)
  assert.match(out2, /GITHUB_TOKEN: \[REDACTED\]/)
})

test('redact: token embedded in a git remote URL', () => {
  const out = redact('remote: https://ghp_' + 'C'.repeat(36) + '@github.com/JozzyAI/fin_bot.git')
  assert.doesNotMatch(out, /ghp_C/)
  assert.doesNotMatch(out, /[A-Za-z0-9]+@github\.com/)
  assert.match(out, /https:\/\/\[REDACTED\]@github\.com/)
})

test('redact: x-access-token:TOKEN@github.com userinfo form', () => {
  const out = redact('https://x-access-token:ghs_' + 'D'.repeat(36) + '@github.com/o/r.git')
  assert.doesNotMatch(out, /ghs_D/)
  assert.match(out, /https:\/\/\[REDACTED\]@github\.com/)
})

test('redact: Bearer tokens and AWS/OpenAI keys', () => {
  assert.match(redact('Authorization: Bearer abc.def-ghi_jkl'), /Bearer \[REDACTED\]/)
  assert.match(redact('AKIA' + 'A'.repeat(16)), /\[REDACTED\]/)
  assert.match(redact('key=sk-' + 'x'.repeat(40)), /\[REDACTED\]/)
})

test('redact: VIBE_RELAY_TOKEN env assignment (plain and export form)', () => {
  const secret = 'aGVsbG93b3JsZHRoaXNpc2FzZWNyZXR0b2tlbnZhbHVlAA=='

  const plain = redact(`VIBE_RELAY_TOKEN=${secret}`)
  assert.doesNotMatch(plain, /aGVsbG93/)
  assert.match(plain, /VIBE_RELAY_TOKEN=\[REDACTED\]/)

  const exported = redact(`export VIBE_RELAY_TOKEN=${secret}`)
  assert.doesNotMatch(exported, /aGVsbG93/)
  assert.match(exported, /export VIBE_RELAY_TOKEN=\[REDACTED\]/)
})

test('redact: --token CLI arg (space and = forms), but NOT --token-file', () => {
  const secret = 'c2VjcmV0Q2xpVG9rZW5WYWx1ZTEyMzQ1Njc4OTBhYmM='

  const spaced = redact(`vibe node daemon --relay wss://r --token ${secret}`)
  assert.doesNotMatch(spaced, /c2VjcmV0/)
  assert.match(spaced, /--token \[REDACTED\]/)

  const eq = redact(`vibe node daemon --token=${secret}`)
  assert.doesNotMatch(eq, /c2VjcmV0/)
  assert.match(eq, /--token=\[REDACTED\]/)

  // --token-file carries a path, not a secret, and must survive untouched.
  const file = redact('vibe node daemon --token-file /home/u/.config/vibe-symphony/token')
  assert.match(file, /--token-file \/home\/u\/\.config\/vibe-symphony\/token/)
  assert.doesNotMatch(file, /\[REDACTED\]/)
})

test('redact: token in URL query string (?token= and &token=)', () => {
  const secret = 'dXJsUXVlcnlUb2tlblNlY3JldFZhbHVlMTIzNDU2Nzg5'

  const q = redact(`wss://vibe-relay.example.ai/node?token=${secret}`)
  assert.doesNotMatch(q, /dXJsUXVl/)
  assert.match(q, /\?token=\[REDACTED\]/)

  const amp = redact(`wss://vibe-relay.example.ai/node?node_id=abc&token=${secret}`)
  assert.doesNotMatch(amp, /dXJsUXVl/)
  assert.match(amp, /&token=\[REDACTED\]/)

  // The query redaction must stop at a following param boundary.
  const trailing = redact(`wss://r/node?token=${secret}&node_id=keepme`)
  assert.match(trailing, /&node_id=keepme/)
})

test('redact: leaves ordinary text untouched', () => {
  const text = 'cloning repo, running tests, opening PR #4'
  assert.equal(redact(text), text)
})
