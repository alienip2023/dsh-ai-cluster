// machine-identity.js — persistent Machine identity for the DSH Bot Network.
//
// Every machine has a stable identity derived from an ed25519 key pair that persists
// across restarts, re-installs, and hub reconnects. Machine ID = first 16 hex chars
// of SHA-256(publicKeyDer) — stable, collision-resistant, derivable from public key alone.
//
// Storage: ~/.dsh/machine-identity.json (created once on first run, never rotated)
// The private key here is for peer authentication only, not data encryption.
// E2E session keys in peer-link.js are ephemeral and separate.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_IDENTITY_PATH = join(homedir(), '.dsh', 'machine-identity.json')

// ── key derivation ──────────────────────────────────────────────────────────

/**
 * Derive a stable machine ID from an ed25519 public key (DER buffer or base64 string).
 * Returns the first 16 hex characters of SHA-256(pubKey).
 */
export function deriveMachineId(publicKey) {
  const buf = typeof publicKey === 'string' ? Buffer.from(publicKey, 'base64') : publicKey
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

// ── generation and persistence ──────────────────────────────────────────────

/**
 * Generate a new machine identity key pair.
 * Returns { id, privateKeyB64, publicKeyB64 } — all strings.
 */
export function generateMachineIdentity() {
  const { privateKey: privDer, publicKey: pubDer } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  })
  const publicKeyB64 = pubDer.toString('base64')
  const privateKeyB64 = privDer.toString('base64')
  const id = deriveMachineId(pubDer)
  return { id, privateKeyB64, publicKeyB64 }
}

/**
 * Load the machine identity from disk, creating it on first run.
 * @param {string} [identityPath]
 * @returns {{ id: string, privateKeyB64: string, publicKeyB64: string, createdAt: number }}
 */
export function loadMachineIdentity(identityPath = DEFAULT_IDENTITY_PATH) {
  if (existsSync(identityPath)) {
    try {
      const raw = JSON.parse(readFileSync(identityPath, 'utf8'))
      if (typeof raw.id === 'string' && typeof raw.privateKeyB64 === 'string' && typeof raw.publicKeyB64 === 'string') {
        return raw
      }
    } catch { /* corrupt file: regenerate below */ }
  }
  const identity = { ...generateMachineIdentity(), createdAt: Date.now() }
  mkdirSync(dirname(identityPath), { recursive: true })
  writeFileSync(identityPath, JSON.stringify(identity, null, 2), 'utf8')
  return identity
}

// ── signing and verification ─────────────────────────────────────────────────

/**
 * Sign arbitrary data with a private key (base64 PKCS#8 DER).
 * Returns base64 signature.
 */
export function signData(privateKeyB64, data) {
  const keyObj = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' })
  return sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data), keyObj).toString('base64')
}

/**
 * Verify a signature against a public key (base64 SPKI DER).
 */
export function verifyData(publicKeyB64, data, signatureB64) {
  try {
    const keyObj = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' })
    return verify(null, Buffer.isBuffer(data) ? data : Buffer.from(data), keyObj, Buffer.from(signatureB64, 'base64'))
  } catch { return false }
}

// ── MachineIdentity class ────────────────────────────────────────────────────

/**
 * A loaded, ready-to-use machine identity. Instantiate once at startup.
 *
 * @example
 *   const identity = new MachineIdentity()
 *   console.log(identity.id)          // '3f8a1b2c4d5e6f7a'
 *   const sig = identity.sign(nonce)
 *   const ok = MachineIdentity.verify(peerPubKey, nonce, sig)
 */
export class MachineIdentity {
  /**
   * @param {string} [identityPath]  override default ~/.dsh/machine-identity.json
   */
  constructor(identityPath = DEFAULT_IDENTITY_PATH) {
    const raw = loadMachineIdentity(identityPath)
    this.id = raw.id
    this.publicKeyB64 = raw.publicKeyB64
    this.createdAt = raw.createdAt
    // Pre-parsed key objects for fast signing
    this._privateKey = createPrivateKey({
      key: Buffer.from(raw.privateKeyB64, 'base64'), format: 'der', type: 'pkcs8',
    })
    this._publicKey = createPublicKey({
      key: Buffer.from(raw.publicKeyB64, 'base64'), format: 'der', type: 'spki',
    })
  }

  /**
   * Sign arbitrary data, returning a base64 signature.
   * @param {Buffer|string} data
   */
  sign(data) {
    return sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data), this._privateKey).toString('base64')
  }

  /**
   * Verify a signature made by another machine against their known public key.
   * @param {string} publicKeyB64  SPKI DER base64
   * @param {Buffer|string} data
   * @param {string} signatureB64
   */
  static verify(publicKeyB64, data, signatureB64) {
    return verifyData(publicKeyB64, data, signatureB64)
  }

  /**
   * A plain-object descriptor safe to send over the wire to peers.
   */
  descriptor() {
    return { id: this.id, publicKeyB64: this.publicKeyB64 }
  }
}
