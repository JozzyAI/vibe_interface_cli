/**
 * Safe (de)serialization for the Node journal. Persisted JSON is UNTRUSTED on
 * read: bounded, parsed defensively, and never evaluated. Errors are sanitized —
 * they never echo payloads, filesystem paths, or SQL.
 */
import { JournalError } from './contract.js'

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

export function nowIso(): string { return new Date().toISOString() }
export function isIsoUtc(s: unknown): s is string { return typeof s === 'string' && ISO_UTC_RE.test(s) }

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

export function encodeJson(value: unknown, maxBytes: number, label: string): string {
  let text: string
  try { text = JSON.stringify(value) } catch { throw new JournalError('invalid_record', `${label}: not JSON-serializable`) }
  if (text === undefined) throw new JournalError('invalid_record', `${label}: not JSON-serializable`)
  if (byteLen(text) > maxBytes) throw new JournalError('too_large', `${label}: exceeds ${maxBytes} bytes`)
  return text
}

export function decodeJson(text: string, maxBytes: number, label: string): unknown {
  if (byteLen(text) > maxBytes) throw new JournalError('corruption', `${label}: persisted JSON exceeds ${maxBytes} bytes`)
  try { return JSON.parse(text) } catch { throw new JournalError('corruption', `${label}: persisted JSON is malformed`) }
}
