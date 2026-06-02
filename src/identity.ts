/**
 * Vibe node identity — stable keypair stored at ~/.vibe/identity.json.
 *
 * Ed25519  — signing / message authenticity (used in MVP 4A)
 * X25519   — encryption key agreement (reserved for MVP 4B)
 *
 * The identity file contains private keys and must be created with
 * restrictive permissions (0o600). Never print private keys to stdout.
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { generateEd25519, generateX25519, fingerprint, deriveIdFromPublicKey } from './crypto.js'
import { vibeDir } from './config.js'

// ── Types ──────────────────────────────────────────────────────────────────

export type IdentityKind = 'node' | 'client' | 'relay'

export interface IdentityFile {
  version: 1
  kind: IdentityKind
  id: string
  display_name: string
  created_at: string
  signing: {
    alg: 'Ed25519'
    public_key: string   // base64 SPKI DER
    private_key: string  // base64 PKCS8 DER
  }
  encryption: {
    alg: 'X25519'
    public_key: string   // base64 SPKI DER
    private_key: string  // base64 PKCS8 DER
  }
}

export interface PublicIdentity {
  version: 1
  kind: IdentityKind
  id: string
  display_name: string
  signing_alg: 'Ed25519'
  signing_public_key: string
  encryption_alg: 'X25519'
  encryption_public_key: string
  fingerprint: string
}

// ── Path ───────────────────────────────────────────────────────────────────

export function identityPath(): string {
  return path.join(vibeDir(), 'identity.json')
}

// ── Load / create ──────────────────────────────────────────────────────────

export function loadIdentity(): IdentityFile | null {
  const p = identityPath()
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as IdentityFile
  } catch {
    return null
  }
}

export function createIdentity(kind: IdentityKind = 'node'): IdentityFile {
  const signing = generateEd25519()
  const encryption = generateX25519()
  const sigPub = signing.publicKey.toString('base64')
  const identity: IdentityFile = {
    version: 1,
    kind,
    id: deriveIdFromPublicKey(sigPub),
    display_name: os.hostname(),
    created_at: new Date().toISOString(),
    signing: {
      alg: 'Ed25519',
      public_key: sigPub,
      private_key: signing.privateKey.toString('base64'),
    },
    encryption: {
      alg: 'X25519',
      public_key: encryption.publicKey.toString('base64'),
      private_key: encryption.privateKey.toString('base64'),
    },
  }

  const p = identityPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(identity, null, 2), { mode: 0o600 })
  return identity
}

/** Load the identity, creating one if it does not exist. */
export function ensureIdentity(): IdentityFile {
  return loadIdentity() ?? createIdentity()
}

// ── Public view ────────────────────────────────────────────────────────────

export function toPublicIdentity(identity: IdentityFile): PublicIdentity {
  return {
    version: 1,
    kind: identity.kind,
    id: identity.id,
    display_name: identity.display_name,
    signing_alg: 'Ed25519',
    signing_public_key: identity.signing.public_key,
    encryption_alg: 'X25519',
    encryption_public_key: identity.encryption.public_key,
    fingerprint: fingerprint(identity.signing.public_key),
  }
}
