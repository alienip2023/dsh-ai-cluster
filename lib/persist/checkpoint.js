// checkpoint.js — periodic state snapshots for Bot turns.
//
// While agent-journal.js records every step append-only,
// checkpoint.js writes a full state snapshot after each completed turn.
// On restart: load checkpoint, replay any journal entries after it.
//
// Storage: ~/.dsh/bots/<botId>/checkpoint.json (atomic write via tmp+rename)

import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const BOTS_DIR = join(homedir(), '.dsh', 'bots')
const CHECKPOINT_FILE = 'checkpoint.json'
const CHECKPOINT_TMP = 'checkpoint.json.tmp'

/**
 * @typedef {object} Checkpoint
 * @property {string} botId
 * @property {number} journalSeq   last journal seq included in this snapshot
 * @property {number} savedAt
 * @property {object} state        arbitrary Bot state (memory refs, task state, etc.)
 */

export class Checkpoint {
  /**
   * @param {string} botId
   * @param {string} [botsDir]
   */
  constructor(botId, botsDir = BOTS_DIR) {
    this.botId = botId
    this._dir = join(botsDir, botId)
    this._path = join(this._dir, CHECKPOINT_FILE)
    this._tmpPath = join(this._dir, CHECKPOINT_TMP)
  }

  /**
   * Save a checkpoint atomically (write to .tmp, then rename).
   * @param {{ journalSeq: number, state: object }} opts
   */
  save({ journalSeq, state }) {
    mkdirSync(this._dir, { recursive: true })
    /** @type {Checkpoint} */
    const snap = { botId: this.botId, journalSeq, savedAt: Date.now(), state }
    writeFileSync(this._tmpPath, JSON.stringify(snap, null, 2), 'utf8')
    renameSync(this._tmpPath, this._path)
  }

  /**
   * Load the most recent checkpoint, or null if none exists.
   * @returns {Checkpoint|null}
   */
  load() {
    if (!existsSync(this._path)) return null
    try {
      const raw = JSON.parse(readFileSync(this._path, 'utf8'))
      if (raw.botId === this.botId && typeof raw.journalSeq === 'number') return raw
    } catch {}
    return null
  }

  /**
   * Check whether a checkpoint exists for this Bot.
   */
  exists() {
    return existsSync(this._path)
  }
}
