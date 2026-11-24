/**
 * turn-seq.js — per-remoteBotId monotonic sequence number generator.
 *
 * createTurnSeq(stateDir, { log, now })
 *   → { next(remoteBotId): number, reset(remoteBotId): void }
 *
 * next() is strictly monotone across restarts: the state lives in <stateDir>/turn-seq.json
 * (mode 0600) and is written atomically (temp file + rename) on every call, so a crash in the
 * middle of a write leaves the previous complete file, never a half-written one.
 *
 * A seq that goes backwards is silently dropped as stale by the receiver (it dedupes on seq), so a
 * state file that EXISTS but cannot be read (corrupt, permission, I/O error) must not restart the
 * counters at 0. The failure is logged, and the affected counters restart from a time-based floor
 * (epoch milliseconds), which is above any counter a previous run could have reached. A file that
 * is simply absent is a fresh install and starts at 0.
 *
 * reset() is provided for tests only.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const noop = () => {}

export function createTurnSeq(stateDir, { log = noop, now = Date.now } = {}) {
  if (typeof stateDir !== 'string' || stateDir === '') stateDir = ''
  const filePath = stateDir ? join(stateDir, 'turn-seq.json') : ''
  const warn = (message, extra) => { try { log('warn', message, extra) } catch { /* logging must not break seq */ } }

  // Time-based floor, set when the state file exists but is unusable.
  let floor
  let state = {}
  if (filePath) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('turn-seq state is not an object')
      state = parsed
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        floor = now()
        warn('turn-seq state unreadable; counters restart from a time-based floor', { file: filePath, error: String(err?.message ?? err), floor })
      }
    }
  }

  let saveFailureLogged = false
  function saveState() {
    if (!filePath) return
    const tmp = `${filePath}.${process.pid}.tmp`
    try {
      if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
      renameSync(tmp, filePath)
      saveFailureLogged = false
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* nothing to clean */ }
      // In-memory counters keep working, but a restart will fall back to the floor: say so once per failure streak.
      if (!saveFailureLogged) {
        saveFailureLogged = true
        warn('turn-seq state not saved; seq is in-memory only until it can be written', { file: filePath, error: String(err?.message ?? err) })
      }
    }
  }

  return {
    /**
     * Return the next seq for remoteBotId. Monotone: result is always > all prior results
     * for this remoteBotId in this stateDir (across restarts).
     * @param {string} remoteBotId
     * @returns {number}
     */
    next(remoteBotId) {
      let current = state[remoteBotId]
      if (typeof current !== 'number' || !Number.isFinite(current)) {
        // Never issued (fresh) -> start at 0; an entry that exists but is corrupt, or a state file that
        // was unreadable, must not go below the floor.
        const corrupt = remoteBotId in state
        current = floor !== undefined || corrupt ? Math.max(floor ?? 0, corrupt ? now() : 0) - 1 : -1
      }
      const next = current + 1
      state[remoteBotId] = next
      saveState()
      return next
    },

    /**
     * Reset the counter for remoteBotId. FOR TESTS ONLY.
     * @param {string} remoteBotId
     */
    reset(remoteBotId) {
      delete state[remoteBotId]
      saveState()
    },
  }
}
