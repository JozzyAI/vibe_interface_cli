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

test('redact: leaves ordinary text untouched', () => {
  const text = 'cloning repo, running tests, opening PR #4'
  assert.equal(redact(text), text)
})
