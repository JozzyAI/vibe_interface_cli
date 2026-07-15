/**
 * Strict, bounded parsing of agent output for the Workflow Runtime.
 *
 * Planner/executor outputs CONTROL routing, so parsing is deliberately strict and
 * PURE: no heuristic JSON-scraping of arbitrary prose, no LLM repair, no silent
 * coercion. Two functions:
 *   - extractAgentOutputText: aggregate the agent's canonical stdout output from
 *     persisted Task events (never SSE comments, never stderr/logs).
 *   - parseSingleJsonObject: accept exactly one JSON object (optionally in a single
 *     ```json fence) and nothing else.
 */

/** Max aggregate agent output we will consider (bytes of UTF-8). */
export const MAX_AGENT_OUTPUT_BYTES = 256 * 1024

/** A minimal shape for a canonical Task event as delivered by the AgentTaskClient. */
export interface RuntimeTaskEvent {
  type?: string
  payload?: { stream?: string; text?: string } | Record<string, unknown>
}

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

/**
 * Aggregate the agent's authoritative textual output from ordered canonical Task
 * events. Prefers a terminal `agent.output.completed` text bookend when present;
 * otherwise concatenates `agent.output.delta` STDOUT text in event order. stderr
 * deltas (diagnostic logs) and SSE comments are never treated as output. The
 * result is bounded — `truncated` is set if the cap was hit.
 */
export function extractAgentOutputText(events: readonly RuntimeTaskEvent[], maxBytes: number = MAX_AGENT_OUTPUT_BYTES): { text: string; truncated: boolean } {
  // A terminal completed-output bookend (if the protocol ever provides one) wins.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'agent.output.completed') {
      const t = (e.payload as { text?: unknown } | undefined)?.text
      if (typeof t === 'string') return boundText(t, maxBytes)
    }
  }
  let out = ''
  let truncated = false
  for (const e of events) {
    if (e.type !== 'agent.output.delta') continue
    const p = e.payload as { stream?: string; text?: string } | undefined
    if (!p || typeof p.text !== 'string') continue
    if (p.stream !== undefined && p.stream !== 'stdout') continue // stderr/logs are not output
    if (byteLen(out) + byteLen(p.text) > maxBytes) { out += p.text.slice(0, Math.max(0, maxBytes - byteLen(out))); truncated = true; break }
    out += p.text
  }
  return { text: out, truncated }
}

function boundText(t: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLen(t) <= maxBytes) return { text: t, truncated: false }
  return { text: t.slice(0, maxBytes), truncated: true }
}

export type ParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: 'output_empty' | 'output_too_large' | 'output_not_json' | 'output_not_object'; message: string }

const FENCE_RE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/

/**
 * Parse EXACTLY one JSON object. Accepts either a bare JSON object or a single
 * ```json fenced block with no other non-whitespace prose. Rejects arrays,
 * primitives, multiple objects, and trailing prose (JSON.parse itself rejects
 * trailing non-whitespace). PURE; never throws.
 */
export function parseSingleJsonObject(raw: string, maxBytes: number = MAX_AGENT_OUTPUT_BYTES): ParseResult {
  if (typeof raw !== 'string') return { ok: false, code: 'output_not_json', message: 'output is not a string' }
  if (byteLen(raw) > maxBytes) return { ok: false, code: 'output_too_large', message: 'output exceeds the maximum size' }
  let trimmed = raw.trim()
  if (trimmed === '') return { ok: false, code: 'output_empty', message: 'output is empty' }
  if (trimmed.startsWith('```')) {
    const m = FENCE_RE.exec(trimmed)
    if (!m) return { ok: false, code: 'output_not_json', message: 'output is not a single well-formed ```json fence' }
    trimmed = m[1].trim()
  } else if (trimmed.includes('```')) {
    return { ok: false, code: 'output_not_json', message: 'output mixes prose/fences with JSON' }
  }
  if (!trimmed.startsWith('{')) return { ok: false, code: 'output_not_object', message: 'output must be a single JSON object' }
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return { ok: false, code: 'output_not_json', message: 'output is not exactly one JSON value (trailing prose or multiple objects are rejected)' } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, code: 'output_not_object', message: 'output must be a JSON object (not an array or primitive)' }
  return { ok: true, value: parsed as Record<string, unknown> }
}
