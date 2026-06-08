/**
 * Redaction helpers for the Telegram monitor.
 *
 * The monitor handles four secrets (VIBE_RELAY_TOKEN, TELEGRAM_BOT_TOKEN,
 * TELEGRAM_CHAT_ID, LINEAR_API_KEY) plus whatever generic credential shapes
 * ../../redact.js already knows how to scrub. Every outbound message and log
 * line must run through redactSecrets — the known values are blanked by exact
 * match (catches them even when they don't match a generic pattern), then the
 * generic patterns run as a backstop.
 */
import { redact } from '../../redact.js'

const REDACTED = '[REDACTED]'

export function redactSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = text
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      out = out.split(secret).join(REDACTED)
    }
  }
  return redact(out)
}

/** Extract just the hostname from a relay URL — never logs/sends the full URL (which may carry a token). */
export function relayHostname(relayUrl: string): string {
  try {
    return new URL(relayUrl).hostname
  } catch {
    return relayUrl.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] || relayUrl
  }
}
