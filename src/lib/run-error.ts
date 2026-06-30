/**
 * Structured remote-error contract for `vibe run start/stream/stop`.
 *
 * Remote run failures used to collapse to "exit 1 + a human line on stderr", so
 * an orchestrator (Symphony) had to regex prose to tell `node_offline` from an
 * auth failure from `run_not_found`. This module turns the error an already-
 * classified relay/client rejection carries into a stable, machine-readable
 * envelope on stdout plus a small exit-code map.
 *
 * The JSON `code` is the stable contract a caller branches on; the human
 * `message` is best-effort and may change. No token value is ever placed in the
 * envelope: the relay/client Error messages classified here are built from
 * relay codes, relay messages, and transport errors (host:port, HTTP status),
 * none of which carry the token — the token only ever travels in the WS URL
 * query, which these messages do not include.
 */

/** Stable error codes a caller may branch on. */
export type RunErrorCode =
  | 'relay_unavailable'   // relay unreachable: refused / DNS / timeout / closed before a reply
  | 'node_offline'        // owning node unknown to the relay or not connected
  | 'unauthorized'        // relay rejected the token (HTTP 401/403, pairing required)
  | 'run_not_found'       // the run id is unknown to the owning node / relay
  | 'agent_not_supported' // the node does not offer the requested agent
  | 'already_terminal'    // stop requested on a run already in a terminal state
  | 'remote_error'        // a relay/node error with a code we do not map specifically
  | 'unknown_error'       // unclassifiable (non-coded message / non-Error throw)

export interface RunErrorEnvelope {
  error: true
  code: RunErrorCode
  message: string
  run_id?: string
  ts: string
}

/** Leading `snake_case:` code token a relay/client Error message carries, if any. */
function leadingCode(message: string): string | undefined {
  const m = /^([a-z][a-z0-9_]+):/.exec(message)
  return m?.[1]
}

/** Relay/node ack codes we surface under a specific stable code. */
const CODE_MAP: Record<string, RunErrorCode> = {
  run_not_found: 'run_not_found',
  already_terminal: 'already_terminal',
  node_offline: 'node_offline',
  node_not_found: 'node_offline',     // unknown-to-relay node ⇒ unavailable, like offline
  agent_not_supported: 'agent_not_supported',
}

/**
 * Classify a remote run failure into a stable {@link RunErrorCode}. Pure: takes
 * the thrown value (or any value), never touches process/fs. Precedence:
 *   1. a recognised relay/node ack code (run_not_found, node_offline, …)
 *   2. an auth signal (HTTP 401/403, "unauthorized", pairing required)
 *   3. a transport-reachability signal (ECONNREFUSED/ENOTFOUND/timeout/closed)
 *   4. any other coded relay/node message ⇒ remote_error
 *   5. otherwise ⇒ unknown_error
 */
export function classifyRunError(err: unknown): RunErrorCode {
  const message = err instanceof Error ? err.message : String(err)

  const head = leadingCode(message)
  if (head && head in CODE_MAP) return CODE_MAP[head]

  if (/\b40[13]\b|unauthor|forbidden|invalid token|bad token|require[-_ ]?pairing|not paired/i.test(message)) {
    return 'unauthorized'
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|getaddrinfo|connection closed|closed before|Timeout waiting|\bconnect /i.test(message)) {
    return 'relay_unavailable'
  }

  // Any remaining coded relay/node message is a remote failure we don't map
  // specifically; an uncoded/odd throw is genuinely unknown.
  return head ? 'remote_error' : 'unknown_error'
}

/**
 * Build the machine-readable envelope printed to stdout for a remote run
 * failure. `run_id` is included when the caller knows it (stream/stop); `ts`
 * defaults to now (overridable for deterministic tests).
 */
export function buildRunErrorEnvelope(
  err: unknown,
  opts: { run_id?: string; ts?: string } = {},
): RunErrorEnvelope {
  const message = err instanceof Error ? err.message : String(err)
  return {
    error: true,
    code: classifyRunError(err),
    message,
    ...(opts.run_id ? { run_id: opts.run_id } : {}),
    ts: opts.ts ?? new Date().toISOString(),
  }
}

/**
 * Exit code for a remote run failure. Intentionally tiny for this contract:
 *   3 → run_not_found (matches the local missing-run exit code)
 *   1 → every other remote failure
 * The structured `code` — not the exit code — is the branching contract.
 */
export function runErrorExitCode(code: RunErrorCode): 1 | 3 {
  return code === 'run_not_found' ? 3 : 1
}
