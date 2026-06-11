/**
 * Unit tests for detectPrUrl() — the GitHub PR URL heuristic shared by
 * codex-runner.ts and claude-runner.ts to populate `pr_created` events.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectPrUrl, createPrUrlTracker } from '../src/pr-detect.js'

test('detectPrUrl: finds a PR URL in plain text', () => {
  const url = detectPrUrl('Opened PR: https://github.com/JozzyAI/fin_bot/pull/4')
  assert.equal(url, 'https://github.com/JozzyAI/fin_bot/pull/4')
})

test('detectPrUrl: returns undefined when no PR URL is present', () => {
  assert.equal(detectPrUrl('Completed task: write hello world'), undefined)
})

test('detectPrUrl: ignores non-PR github URLs', () => {
  assert.equal(detectPrUrl('See https://github.com/JozzyAI/fin_bot for details'), undefined)
  assert.equal(detectPrUrl('Issue: https://github.com/JozzyAI/fin_bot/issues/4'), undefined)
})

test('detectPrUrl: multiple PR URLs — last match wins', () => {
  const url = detectPrUrl(
    'Superseded https://github.com/JozzyAI/fin_bot/pull/3 with https://github.com/JozzyAI/fin_bot/pull/4',
  )
  assert.equal(url, 'https://github.com/JozzyAI/fin_bot/pull/4')
})

test('detectPrUrl: matches across multiple lines, last match wins', () => {
  const text = [
    'Opened https://github.com/JozzyAI/fin_bot/pull/3',
    'PR #3 is open, clean, mergeable, and references JOZ-14:',
    'https://github.com/JozzyAI/fin_bot/pull/4',
  ].join('\n')
  assert.equal(detectPrUrl(text), 'https://github.com/JozzyAI/fin_bot/pull/4')
})

test('createPrUrlTracker: first sighting of a URL is new', () => {
  const isNewPrUrl = createPrUrlTracker()
  assert.equal(isNewPrUrl('https://github.com/JozzyAI/fin_bot/pull/4'), true)
})

test('createPrUrlTracker: repeated URL is not new', () => {
  const isNewPrUrl = createPrUrlTracker()
  assert.equal(isNewPrUrl('https://github.com/JozzyAI/fin_bot/pull/4'), true)
  assert.equal(isNewPrUrl('https://github.com/JozzyAI/fin_bot/pull/4'), false)
  assert.equal(isNewPrUrl('https://github.com/JozzyAI/fin_bot/pull/4'), false)
})

test('createPrUrlTracker: different URLs are each new once', () => {
  const isNewPrUrl = createPrUrlTracker()
  assert.equal(isNewPrUrl('https://github.com/JozzyAI/fin_bot/pull/3'), true)
  assert.equal(isNewPrUrl('https://github.com/JozzyAI/fin_bot/pull/4'), true)
  assert.equal(isNewPrUrl('https://github.com/JozzyAI/fin_bot/pull/3'), false)
})

test('createPrUrlTracker: trackers are independent per instance', () => {
  const a = createPrUrlTracker()
  const b = createPrUrlTracker()
  assert.equal(a('https://github.com/JozzyAI/fin_bot/pull/4'), true)
  assert.equal(b('https://github.com/JozzyAI/fin_bot/pull/4'), true)
})
