/**
 * Single source of truth for this package's version, used by both `vibe --version`
 * and the MCP server's `serverInfo.version`. Resolves package.json by walking up
 * from this module's directory to the nearest `vibe-interface-cli` package.json —
 * which is correct in BOTH the compiled dist layout (`dist/src/lib/…` → repo root)
 * and an installed `node_modules/vibe-interface-cli/…` layout, unlike a fixed
 * relative `require('../../package.json')` that only lined up in the TS source tree.
 *
 * Never throws and never leaks a filesystem path or stack trace: on any failure it
 * returns the `'0.0.0'` sentinel (which the release regression test forbids for a
 * normal packaged build).
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const UNKNOWN_VERSION = '0.0.0'
const PACKAGE_NAME = 'vibe-interface-cli'

let cached: string | undefined

export function readPackageVersion(): string {
  if (cached !== undefined) return cached
  cached = resolve()
  return cached
}

function resolve(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    // Bounded upward walk (defends against an unexpected filesystem root loop).
    for (let i = 0; i < 12; i++) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
        if (parsed.name === PACKAGE_NAME && typeof parsed.version === 'string' && parsed.version) return parsed.version
      } catch { /* no package.json here (or unreadable) — keep walking up */ }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* fall through to the safe sentinel */ }
  return UNKNOWN_VERSION
}
