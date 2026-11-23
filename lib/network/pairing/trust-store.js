// trust-store.js — persistent peer trust relationships for the DSH Bot Network.
//
// Every pair of machines that have completed pairing shares:
//   - each other's public key (pinned on first contact, never rotated without re-pair)
//   - a shared HMAC secret (derived from DH during pairing, used in peer-link auth)
//   - a human alias for the remote machine
//
// Storage: ~/.dsh/trust.json (plain JSON, the secrets inside are low-sensitivity:
// they gate peer-link auth but all actual message content is E2E encrypted separately).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_TRUST_PATH = join(homedir(), '.dsh', 'trust.json')

/**
 * @typedef {object} TrustRecord
 * @property {string} peerId        Remote machine ID
 * @property {string} peerPubKeyB64 Remote machine's ed25519 public key (SPKI DER base64), pinned on first contact
 * @property {string} secret        32-byte shared HMAC secret (hex), derived during pairing
 * @property {string} [alias]       Human-readable name for this machine
 * @property {number} pairedAt      Unix ms timestamp when pairing completed
 * @property {number} lastSeen      Unix ms timestamp of last successful connection
 */

export class TrustStore {
  /**
   * @param {string} [storePath]
   */
  constructor(storePath = DEFAULT_TRUST_PATH) {
    this._path = storePath
    /** @type {Map<string, TrustRecord>} */
    this._records = new Map()
    this._load()
  }

  _load() {
    if (!existsSync(this._path)) return
    try {
      const raw = JSON.parse(readFileSync(this._path, 'utf8'))
      if (!Array.isArray(raw)) return
      for (const entry of raw) {
        if (typeof entry.peerId === 'string' && entry.peerId !== '') {
          this._records.set(entry.peerId, entry)
        }
      }
    } catch { /* corrupt file: start empty */ }
  }

  _save() {
    mkdirSync(dirname(this._path), { recursive: true })
    writeFileSync(this._path, JSON.stringify([...this._records.values()], null, 2), 'utf8')
  }

  /**
   * Add or update a trust record. Saves to disk immediately.
   * @param {TrustRecord} record
   */
  set(record) {
    if (typeof record.peerId !== 'string' || record.peerId === '') throw new Error('peerId required')
    this._records.set(record.peerId, { ...record })
    this._save()
  }

  /**
   * Retrieve a trust record by peer machine ID.
   * @param {string} peerId
   * @returns {TrustRecord|undefined}
   */
  get(peerId) {
    return this._records.get(peerId)
  }

  /**
   * Check whether we trust a given machine.
   */
  has(peerId) {
    return this._records.has(peerId)
  }

  /**
   * Remove a trust record (unpair). Saves to disk.
   */
  remove(peerId) {
    this._records.delete(peerId)
    this._save()
  }

  /**
   * All trusted machines.
   * @returns {TrustRecord[]}
   */
  list() {
    return [...this._records.values()]
  }

  /**
   * Update lastSeen for a peer without touching other fields.
   */
  touch(peerId) {
    const rec = this._records.get(peerId)
    if (!rec) return
    rec.lastSeen = Date.now()
    this._save()
  }

  /**
   * Returns the peer secret for use in peer-link authentication, or undefined if not trusted.
   * @param {string} peerId
   * @returns {string|undefined}
   */
  secretFor(peerId) {
    return this._records.get(peerId)?.secret
  }

  /**
   * Returns all peers as the shape peer-link's directory() method expects.
   * @returns {{ nodeId: string, url: string }[]}  (url comes from a separate source, filtered here)
   */
  credentialsSnapshot() {
    return this.list().map(r => ({ nodeId: r.peerId, secret: r.secret }))
  }
}
