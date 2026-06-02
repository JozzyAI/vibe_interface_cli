/**
 * Cryptographic helpers for Vibe identity and signed envelopes.
 *
 * Ed25519 — signing / message authenticity (MVP 4A)
 * X25519  — key agreement for payload encryption (reserved for MVP 4B)
 *
 * Both use Node.js built-in `crypto` — no external dependencies.
 */
import crypto from 'crypto'

// ── Key generation ─────────────────────────────────────────────────────────

export interface Ed25519Keypair {
  publicKey: Buffer   // SPKI DER
  privateKey: Buffer  // PKCS8 DER
}

export interface X25519Keypair {
  publicKey: Buffer   // SPKI DER
  privateKey: Buffer  // PKCS8 DER
}

export function generateEd25519(): Ed25519Keypair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
  })
  return { publicKey: publicKey as unknown as Buffer, privateKey: privateKey as unknown as Buffer }
}

export function generateX25519(): X25519Keypair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
  })
  return { publicKey: publicKey as unknown as Buffer, privateKey: privateKey as unknown as Buffer }
}

// ── Fingerprint ────────────────────────────────────────────────────────────

/** SHA-256 fingerprint of the signing public key (base64, no padding prefix). */
export function fingerprint(signingPublicKeyBase64: string): string {
  const raw = Buffer.from(signingPublicKeyBase64, 'base64')
  const hash = crypto.createHash('sha256').update(raw).digest('base64')
  return `SHA256:${hash}`
}

/** Derive a stable node_id from the signing public key. */
export function deriveIdFromPublicKey(signingPublicKeyBase64: string): string {
  const raw = Buffer.from(signingPublicKeyBase64, 'base64')
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  return `node_${hash.slice(0, 16)}`
}

// ── Canonical JSON ─────────────────────────────────────────────────────────

/**
 * Recursively sort object keys and produce stable JSON.
 * Used to produce a deterministic byte sequence for signing.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const obj = value as Record<string, unknown>
  const sorted = Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
  return `{${sorted.join(',')}}`
}

// ── Signing ────────────────────────────────────────────────────────────────

export interface EnvelopeSignature {
  alg: 'Ed25519'
  key_id: string   // identity id (node_id)
  value: string    // base64 signature over canonical envelope-without-signature
}

/**
 * Sign a relay envelope. The envelope must NOT contain a `signature` field —
 * pass the object without it; the returned signature covers the canonical form.
 */
export function signEnvelope(
  privateKeyBase64: string,
  keyId: string,
  envelopeWithoutSig: Record<string, unknown>,
): EnvelopeSignature {
  const canonical = canonicalize(envelopeWithoutSig)
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privKey)
  return { alg: 'Ed25519', key_id: keyId, value: sig.toString('base64') }
}

/**
 * Verify an envelope's signature.
 * Strips the `signature` field before canonicalizing to reproduce the original bytes.
 */
export function verifyEnvelope(
  signingPublicKeyBase64: string,
  envelope: Record<string, unknown>,
): boolean {
  const { signature, ...withoutSig } = envelope
  if (!signature || typeof signature !== 'object') return false
  const sig = signature as EnvelopeSignature
  if (sig.alg !== 'Ed25519') return false
  const canonical = canonicalize(withoutSig)
  const pubKey = crypto.createPublicKey({
    key: Buffer.from(signingPublicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  })
  try {
    return crypto.verify(null, Buffer.from(canonical, 'utf8'), pubKey, Buffer.from(sig.value, 'base64'))
  } catch {
    return false
  }
}
