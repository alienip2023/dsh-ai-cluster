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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BOTS_DIR = join(homedir(), '.dsh', 'bots')

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
 * @property {number} createdAt
 */

/**
 * Create a new Bot identity and save it to disk.
 * @param {{ name: string, role: string, homeNodeId: string, botsDir?: string }} opts
 * @returns {BotIdentityRecord}
 */
export function createBotIdentity({ name, role, homeNodeId, botsDir = BOTS_DIR }) {
  const { privateKey: privDer, publicKey: pubDer } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  })
  const publicKeyB64 = pubDer.toString('base64')
  const privateKeyB64 = privDer.toString('base64')
  const id = deriveBotId(publicKeyB64)
  const record = { id, privateKeyB64, publicKeyB64, name, role, homeNodeId, createdAt: Date.now() }
  const dir = join(botsDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'identity.json'), JSON.stringify(record, null, 2), 'utf8')
  return record
}

/**
 * Load a Bot identity from disk by ID.
 * @param {string} botId
 * @param {string} [botsDir]
 * @returns {BotIdentityRecord|undefined}
 */
export function loadBotIdentity(botId, botsDir = BOTS_DIR) {
  const path = join(botsDir, botId, 'identity.json')
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw.id === 'string' && raw.id === botId) return raw
  } catch {}
  return undefined
}

/**
 * List all Bot IDs on this machine.
 * @param {string} [botsDir]
 * @returns {string[]}
 */
export function listBotIds(botsDir = BOTS_DIR) {
  if (!existsSync(botsDir)) return []
  try {
    const { readdirSync } = await import('node:fs')
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
