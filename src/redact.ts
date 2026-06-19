/**
 * Best-effort secret redaction for anything we persist to the event log or a
 * handoff document. Each rule replaces a match with [REDACTED]; rules that need
 * to keep surrounding context (env-var name, URL scheme/host) use a capture
 * group in the replacement.
 *
 * This is defense-in-depth, not a guarantee — we still avoid putting secrets
 * into logs/remotes in the first place.
 */
interface Rule {
  pattern: RegExp
  replacement: string
}

const RULES: Rule[] = [
  // GitHub tokens: classic PAT (ghp_), OAuth (gho_), user/server/refresh (ghu_/ghs_/ghr_).
  { pattern: /gh[posru]_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED]' },
  // GitHub fine-grained PAT.
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: '[REDACTED]' },
  // AWS access key id.
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED]' },
  // OpenAI-style keys.
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED]' },
  // Authorization: Bearer <token>.
  { pattern: /Bearer [A-Za-z0-9\-._~+/]+=*/g, replacement: 'Bearer [REDACTED]' },
  // Credentials embedded in a URL: https://user:token@host or https://token@host.
  { pattern: /(https?:\/\/)[^\s/@]+@/g, replacement: '$1[REDACTED]@' },
  // Token-bearing env assignments (GH_TOKEN=..., GITHUB_TOKEN: ..., GH_PAT=...).
  { pattern: /\b(GH_TOKEN|GITHUB_TOKEN|GH_PAT|GITHUB_PAT|GHE_TOKEN)\b(\s*[=:]\s*)\S+/gi, replacement: '$1$2[REDACTED]' },
  // Private key PEM headers.
  { pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, replacement: '[REDACTED]' },
]

export function redact(text: string): string {
  let out = text
  for (const { pattern, replacement } of RULES) {
    out = out.replace(pattern, replacement)
  }
  return out
}
