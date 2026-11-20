import fs from 'node:fs'
import { writeJsonAtomic } from '../identity.js'

function hasRowStrings(row) {
  return typeof row?.taskId === 'string' && typeof row.nodeId === 'string' && typeof row.status === 'string'
}

function isRow(row) {
  return hasRowStrings(row) && Object.keys(row).length === 6 &&
    Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt) && Number.isFinite(row.at)
}

function timeOrZero(value) {
  return Number.isFinite(value) ? value : 0
}

export function createAssignmentLedger({ file, max = 200, now = Date.now, log = () => {} }) {
  if (!(max >= 1)) throw new RangeError('assignment ledger max must be at least 1')
  const capacity = Math.floor(max)
  let rows = []
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(saved) || !saved.every(isRow)) throw new Error('invalid assignment ledger rows')
      rows = saved.slice(-capacity)
    } catch (err) {
      if (err.code !== 'ENOENT') log('warn', 'assignment ledger load failed', { error: err.message })
    }
  }

  function record(view) {
    if (!hasRowStrings(view)) return
    const { taskId, nodeId, status } = view
    const endedAt = timeOrZero(view.endedAt)
    const latest = rows.findLast(row => row.taskId === taskId)
    if (latest?.status === status && latest.endedAt === endedAt) return

    rows.push({ taskId, nodeId, status, startedAt: timeOrZero(view.startedAt), endedAt, at: timeOrZero(now()) })
    if (rows.length > capacity) rows.shift()
    if (file) {
      try {
        writeJsonAtomic(file, rows)
      } catch (err) {
        log('warn', 'assignment ledger save failed', { error: err.message })
      }
    }
  }

  function list({ nodeId, limit = 50 } = {}) {
    const count = Math.min(capacity, Math.max(0, Math.floor(limit) || 0))
    const result = []
    for (let i = rows.length - 1; i >= 0 && result.length < count; i--) {
      const row = rows[i]
      if (nodeId === undefined || row.nodeId === nodeId) result.push({ ...row })
    }
    return result
  }

  return { record, list }
}
