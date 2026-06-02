/**
 * Cryptographic helpers for Vibe identity, signed envelopes, and payload encryption.
 *
 * Ed25519 — signing / message authenticity (MVP 4A)
 * X25519  — ECDH key agreement + AES-256-GCM payload encryption (MVP 4B)
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

// ── X25519 payload encryption (MVP 4B) ────────────────────────────────────

/**
 * Encrypt a JSON-serialisable payload for a target node.
 *
 * Algorithm:
 *   1. Generate ephemeral X25519 keypair.
 *   2. ECDH(ephemeral_private, target_public) → shared_secret.
 *   3. HKDF-SHA256(shared_secret, info="vibe-run-start-v1") → 32-byte AES key.
 *   4. AES-256-GCM(key, nonce) → ciphertext ‖ auth_tag(16 bytes).
 *
 * Returns base64-encoded fields suitable for the outer wire envelope.
 */
export interface EncryptedPayload {
  ephemeralPublicKey: string  // base64 SPKI DER
  nonce: string               // base64 12 random bytes (GCM nonce)
  ciphertext: string          // base64 encrypted_data ‖ auth_tag(16)
}

const HKDF_INFO = Buffer.from('vibe-run-start-v1', 'utf8')

function deriveAesKey(sharedSecret: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), HKDF_INFO, 32),
  )
}

export function encryptPayload(
  targetEncPublicKeyBase64: string,
  payload: Record<string, unknown>,
): EncryptedPayload {
  const ephemeral = generateX25519()

  const targetPubKey = crypto.createPublicKey({
    key: Buffer.from(targetEncPublicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  })
  const ephemeralPrivKey = crypto.createPrivateKey({
    key: ephemeral.privateKey,
    format: 'der',
    type: 'pkcs8',
  })
  const sharedSecret = crypto.diffieHellman({ privateKey: ephemeralPrivKey, publicKey: targetPubKey })
  const aesKey = deriveAesKey(sharedSecret)

  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    ephemeralPublicKey: ephemeral.publicKey.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
  }
}

/**
 * Decrypt a payload encrypted with encryptPayload.
 * Throws if the auth tag fails (tampered ciphertext) or decryption fails for any reason.
 */
export function decryptPayload(
  nodeEncPrivateKeyBase64: string,
  enc: EncryptedPayload,
): Record<string, unknown> {
  const ephemeralPubKey = crypto.createPublicKey({
    key: Buffer.from(enc.ephemeralPublicKey, 'base64'),
    format: 'der',
    type: 'spki',
  })
  const nodePrivKey = crypto.createPrivateKey({
    key: Buffer.from(nodeEncPrivateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const sharedSecret = crypto.diffieHellman({ privateKey: nodePrivKey, publicKey: ephemeralPubKey })
  const aesKey = deriveAesKey(sharedSecret)

  const nonce = Buffer.from(enc.nonce, 'base64')
  const raw = Buffer.from(enc.ciphertext, 'base64')
  const tag = raw.subarray(raw.length - 16)
  const ciphertext = raw.subarray(0, raw.length - 16)

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>
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
