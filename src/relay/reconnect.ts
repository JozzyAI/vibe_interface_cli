/**
 * Reconnect backoff for the relay node daemon.
 *
 * The daemon must survive a relay restart: when the relay WebSocket closes it
 * waits a bounded, growing delay and reconnects, rather than exiting. This is a
 * pure helper so the backoff schedule can be unit-tested without sockets — the
 * key property is that it never returns 0 (no busy-loop) and is capped (no
 * unbounded growth).
 */
export interface BackoffOpts {
  /** First-retry delay in ms. Default 1000. */
  baseMs?: number
  /** Maximum delay in ms. Default 30000. */
  capMs?: number
}

/**
 * Delay (ms) before reconnect attempt number `attempt` (0 = first retry).
 * Exponential — base, base*2, base*4, … — clamped to `capMs`. Always >= base,
 * so the loop can never spin without waiting.
 */
export function nextBackoffMs(attempt: number, opts: BackoffOpts = {}): number {
  const base = opts.baseMs ?? 1000
  const cap = opts.capMs ?? 30000
  const n = attempt < 0 ? 0 : attempt
  const delay = base * 2 ** n
  return Math.min(delay, cap)
}

/** Sleep `ms`, resolving early (without throwing) if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
