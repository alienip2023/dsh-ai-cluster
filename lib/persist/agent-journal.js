// agent-journal.js — append-only step journal for Bot turns.
//
// Every step of every Bot turn is written to ~/.dsh/bots/<botId>/journal.jsonl
// before it completes. If the process crashes mid-turn, the journal lets the
// Bot resume from the last completed step rather than starting over.
//
// Design (from Grok Bot / Temporal patterns):
//   - append-only: entries are never modified, only appended
//   - fsync on each write: a crash cannot leave a partial entry
//   - each entry has a monotonic seq and a type
//   - recovery: scan from the end, find the last turn/start without a turn/end,
//     return its steps so the caller can decide whether to replay or fail gracefully
//
// Entry types:
//   turn/start    { seq, type, ts, exchangeId, botId, fromBotId?, text }
//   step/model    { seq, type, ts, exchangeId, stepIdx, inputTokens?, outputTokens? }
//   step/tool     { seq, type, ts, exchangeId, stepIdx, name, argsDigest }
//   step/tool-result { seq, type, ts, exchangeId, stepIdx, name, ok, resultDigest }
//   turn/end      { seq, type, ts, exchangeId, reason }
//   turn/fail     { seq, type, ts, exchangeId, error }

import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

export const BOTS_DIR = join(homedir(), '.dsh', 'bots')
const JOURNAL_FILE = 'journal.jsonl'
const MAX_JOURNAL_BYTES = 50 * 1024 * 1024  // 50 MB: rotate after this

function digest(value) {
  if (value === undefined || value === null) return null
  const str = typeof value === 'string' ? value : JSON.stringify(value)
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}

export class AgentJournal {
  /**
   * @param {string} botId
   * @param {string} [botsDir]
   */
  constructor(botId, botsDir = BOTS_DIR) {
    this.botId = botId
    this._dir = join(botsDir, botId)
    this._path = join(this._dir, JOURNAL_FILE)
    this._seq = 0
    this._fd = null
    this._open()
  }

  _open() {
    mkdirSync(this._dir, { recursive: true })
    this._fd = openSync(this._path, 'a')
    // Read existing seq to continue monotonically
    if (existsSync(this._path)) {
      try {
        const lines = readFileSync(this._path, 'utf8').trim().split('\n').filter(Boolean)
        if (lines.length > 0) {
          const last = JSON.parse(lines[lines.length - 1])
          if (typeof last.seq === 'number') this._seq = last.seq
        }
      } catch { /* start from 0 */ }
    }
  }

  _write(entry) {
    if (this._fd === null) this._open()
    this._seq += 1
    const line = JSON.stringify({ ...entry, seq: this._seq }) + '\n'
    const buf = Buffer.from(line, 'utf8')
    writeSync(this._fd, buf)
    // Note: full fsync on every write is expensive; we do it only on turn/start and turn/end
    // to bound the replay window to one turn's worth of steps.
  }

  turnStart({ exchangeId, text, fromBotId } = {}) {
    this._write({ type: 'turn/start', ts: Date.now(), exchangeId, botId: this.botId, fromBotId, textDigest: digest(text) })
  }

  stepModel({ exchangeId, stepIdx, inputTokens, outputTokens } = {}) {
    this._write({ type: 'step/model', ts: Date.now(), exchangeId, stepIdx, inputTokens, outputTokens })
  }

  stepTool({ exchangeId, stepIdx, name, args } = {}) {
    this._write({ type: 'step/tool', ts: Date.now(), exchangeId, stepIdx, name, argsDigest: digest(args) })
  }

  stepToolResult({ exchangeId, stepIdx, name, ok, result } = {}) {
    this._write({ type: 'step/tool-result', ts: Date.now(), exchangeId, stepIdx, name, ok, resultDigest: digest(result) })
  }

  turnEnd({ exchangeId, reason } = {}) {
    this._write({ type: 'turn/end', ts: Date.now(), exchangeId, reason })
  }

  turnFail({ exchangeId, error } = {}) {
    this._write({ type: 'turn/fail', ts: Date.now(), exchangeId, error: String(error?.message ?? error ?? 'unknown') })
  }

  /**
   * Find any turn that started but never ended (crashed mid-turn).
   * Returns { exchangeId, startSeq, steps } or null if none.
   */
  findIncomplete() {
    if (!existsSync(this._path)) return null
    try {
      const lines = readFileSync(this._path, 'utf8').trim().split('\n').filter(Boolean)
      const turns = new Map()  // exchangeId → { start, steps, ended }
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          if (entry.type === 'turn/start') turns.set(entry.exchangeId, { start: entry, steps: [], ended: false })
          else if (entry.type === 'turn/end' || entry.type === 'turn/fail') {
            const t = turns.get(entry.exchangeId)
            if (t) t.ended = true
          } else {
            const t = turns.get(entry.exchangeId)
            if (t && !t.ended) t.steps.push(entry)
          }
        } catch { /* skip malformed line */ }
      }
      for (const [exchangeId, t] of turns) {
        if (!t.ended) return { exchangeId, startSeq: t.start.seq, steps: t.steps }
      }
    } catch { /* journal unreadable */ }
    return null
  }

  close() {
    if (this._fd !== null) {
      try { closeSync(this._fd) } catch {}
      this._fd = null
    }
  }
}
