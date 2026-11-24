// bot-identity.js — persistent Bot identity for the DSH Bot Network.
//
// Every Bot has a global identity derived from an ed25519 key pair.
// The Bot ID is the first 16 hex characters of SHA-256(publicKeyDer).
// Identity is stored in ~/.dsh/bots/<botId>/identity.json and travels
// with the Bot when it migrates between machines.
//
// Unlike machine-identity.js, bot identity files may be copied/synced
// between machines to enable Bot migration.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { botsRoot } from '../persist/bots-root.js'
/** @deprecated resolved at import time; use botsRoot(). Kept for callers that read it. */
export const BOTS_DIR = botsRoot()

/** A Bot identity id: the first 16 hex chars of SHA-256 over the public key (self-certifying). */
export const BOT_IDENTITY_ID_RE = /^[0-9a-f]{16}$/

export function deriveBotId(publicKeyB64) {
  const buf = Buffer.from(publicKeyB64, 'base64')
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

/**
 * @typedef {object} BotIdentityRecord
 * @property {string} id
 * @property {string} privateKeyB64
 * @property {string} publicKeyB64
 * @property {string} name
 * @property {string} role
 * @property {string} homeNodeId    preferred machine ID
 * @property {string} [localBotId]  the ds-bot Bot id this identity belongs to on its machine
 * @property {number} createdAt
 */

/**
 * Create a new Bot identity and save it to disk.
 * @param {{ name: string, role: string, homeNodeId: string, botsDir?: string }} opts
 * @returns {BotIdentityRecord}
 */
export function createBotIdentity({ name, role, homeNodeId, localBotId, botsDir = botsRoot() }) {
  const { privateKey: privDer, publicKey: pubDer } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  })
  const publicKeyB64 = pubDer.toString('base64')
  const privateKeyB64 = privDer.toString('base64')
  const id = deriveBotId(publicKeyB64)
  const record = { id, privateKeyB64, publicKeyB64, name, role, homeNodeId, ...(typeof localBotId === 'string' && localBotId !== '' ? { localBotId } : {}), createdAt: Date.now() }
  const dir = join(botsDir, id)
  // The file holds the private key: owner-only.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'identity.json'), JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
  return record
}

/**
 * Load a Bot identity from disk by ID.
 * @param {string} botId
 * @param {string} [botsDir]
 * @returns {BotIdentityRecord|undefined}
 */
export function loadBotIdentity(botId, botsDir = botsRoot()) {
  const path = join(botsDir, botId, 'identity.json')
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    // The id must be the one the key derives: a copied or edited file cannot claim another Bot's id.
    if (typeof raw.id === 'string' && raw.id === botId && typeof raw.publicKeyB64 === 'string' && deriveBotId(raw.publicKeyB64) === botId) return raw
  } catch {}
  return undefined
}

/**
 * List all Bot IDs on this machine.
 * @param {string} [botsDir]
 * @returns {string[]}
 */
export function listBotIds(botsDir = botsRoot()) {
  if (!existsSync(botsDir)) return []
  try {
    return readdirSync(botsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(botsDir, d.name, 'identity.json')))
      .map(d => d.name)
  } catch { return [] }
}

export class BotIdentity {
  constructor(record) {
    this.id = record.id
    this.name = record.name
    this.role = record.role
    this.homeNodeId = record.homeNodeId
    this.publicKeyB64 = record.publicKeyB64
    this.createdAt = record.createdAt
    this._privateKey = createPrivateKey({ key: Buffer.from(record.privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' })
    this._publicKey = createPublicKey({ key: Buffer.from(record.publicKeyB64, 'base64'), format: 'der', type: 'spki' })
  }

  sign(data) {
    return sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data), this._privateKey).toString('base64')
  }

  static verify(publicKeyB64, data, signatureB64) {
    try {
      const pub = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' })
      return verify(null, Buffer.isBuffer(data) ? data : Buffer.from(data), pub, Buffer.from(signatureB64, 'base64'))
    } catch { return false }
  }

  descriptor() {
    return { id: this.id, name: this.name, role: this.role, publicKeyB64: this.publicKeyB64, homeNodeId: this.homeNodeId }
  }
}

/**
 * The identity of a local ds-bot Bot, created on first use. Bots are matched by the
 * `localBotId` recorded in their identity file; `cache` (localBotId → identity id) spares
 * a directory scan on every roster report.
 * @returns {BotIdentityRecord|undefined} undefined when the identity cannot be read or written
 */
export function ensureBotIdentityFor({ localBotId, name = '', role = '', homeNodeId = '', botsDir = botsRoot(), cache } = {}) {
  if (typeof localBotId !== 'string' || localBotId.trim() === '') return undefined
  const known = cache?.get(localBotId)
  if (known) {
    const record = loadBotIdentity(known, botsDir)
    if (record?.localBotId === localBotId) return record
    cache.delete(localBotId)
  }
  for (const id of listBotIds(botsDir)) {
    const record = loadBotIdentity(id, botsDir)
    if (record?.localBotId === localBotId) { cache?.set(localBotId, id); return record }
  }
  try {
    const record = createBotIdentity({ name, role, homeNodeId, localBotId, botsDir })
    cache?.set(localBotId, record.id)
    return record
  } catch { return undefined }
}
