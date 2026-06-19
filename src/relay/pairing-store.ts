/**
 * Persistent storage for relay paired-node identities.
 *
 * MVP 4A pairing state — which nodes are allowed to register under
 * `relay dev --require-pairing` — was previously held only in an in-memory Map,
 * so restarting the relay dropped every pairing and forced each node to re-run
 * `vibe node pair` before it could register again. This module persists the
 * paired *public* identities to disk so pairings survive a relay restart.
 *
 * The file stores ONLY public identity material (public keys, ids, display
 * names, fingerprints). It never contains a relay auth token or any private
 * key, so it carries no secret that a `--token` rotation would invalidate.
 */
import fs from 'fs'
import path from 'path'
import type { PublicIdentity } from '../identity.js'

/** On-disk shape. Versioned so the format can evolve without a silent break. */
interface PairingsFileV1 {
  version: 1
  pairings: Record<string, PublicIdentity>
}

/**
 * Load paired identities from disk. Returns an empty map if the file does not
 * exist or cannot be parsed — a missing or corrupt file must never crash the
 * relay; it simply starts with no pairings, exactly like the old in-memory
 * behaviour (the node then re-pairs once).
 */
export function loadPairings(file: string): Map<string, PublicIdentity> {
  const map = new Map<string, PublicIdentity>()
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return map // missing file → no pairings yet
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PairingsFileV1>
    const pairings = parsed?.pairings
    if (pairings && typeof pairings === 'object') {
      for (const [nodeId, identity] of Object.entries(pairings)) {
        if (identity && typeof identity === 'object') {
          map.set(nodeId, identity as PublicIdentity)
        }
      }
    }
  } catch {
    // corrupt JSON → start empty rather than crash the relay
  }
  return map
}

/**
 * Persist paired identities to disk atomically: write a temp file in the same
 * directory, fsync it, then rename it over the target (rename is atomic on the
 * same filesystem, so a concurrent reader never sees a partial file). The file
 * is created 0600 so only the relay's own user can read it. Only public
 * identity material is written — never a token or private key.
 */
export function savePairings(file: string, pairings: Map<string, PublicIdentity>): void {
  const data: PairingsFileV1 = { version: 1, pairings: Object.fromEntries(pairings) }
  const json = JSON.stringify(data, null, 2)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })

  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  // rename preserves the temp file's mode, but re-assert defensively.
  try { fs.chmodSync(file, 0o600) } catch { /* best-effort */ }
}
