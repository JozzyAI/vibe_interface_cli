const PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{36}/g,
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9]{32,}/g,
  /Bearer [A-Za-z0-9\-._~+/]+=*/g,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
]

export function redact(text: string): string {
  let out = text
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, '[REDACTED]')
  }
  return out
}
