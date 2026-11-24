// Sentinel: out-of-process health check for DSH and the daemon.
// Reads data files directly — works even when the DSH or daemon process is hung or crashed.
//
// Checks:
//   1. DSH state file (last-modified age) — did DSH write recently?
//   2. Daemon PID file — is the daemon running?
//   3. Node connectivity log — are nodes heartbeating?
//
// Returns a plain JSON-serialisable report; never throws.

import { readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_DSH_IDLE_MS = 5 * 60 * 1000     // 5 min without DSH state write = likely hung
const MAX_NODE_IDLE_MS = 2 * 60 * 1000    // 2 min without node heartbeat = likely offline
const MAX_DAEMON_RESTART_COUNT = 5         // more than this in a window = crash-loop

/**
 * Run all sentinel checks.
 * @param {object} [opts]
 * @param {string} [opts.dshHome]   DSH state directory (default ~/.dsh)
 * @param {string} [opts.daemonPid] Path to daemon PID file
 * @param {function} [opts.now]     Clock (default Date.now)
 * @returns {{ ok: boolean, checks: object[], summary: string }}
 */
export function runSentinel({ dshHome = join(homedir(), '.dsh'), daemonPid, now = Date.now } = {}) {
  const checks = []
  const at = now()

  // ── 1. DSH state file age ──────────────────────────────────────────────────
  const stateFile = join(dshHome, 'state.json')
  if (existsSync(stateFile)) {
    try {
      const { mtimeMs } = statSync(stateFile)
      const ageMs = at - mtimeMs
      checks.push({
        name: 'dsh-state-file',
        ok: ageMs < MAX_DSH_IDLE_MS,
        detail: `last write ${Math.round(ageMs / 1000)}s ago`,
      })
    } catch (err) {
      checks.push({ name: 'dsh-state-file', ok: false, detail: `stat failed: ${String(err?.message ?? err).slice(0, 80)}` })
    }
  } else {
    checks.push({ name: 'dsh-state-file', ok: false, detail: 'file not found' })
  }

  // ── 2. Daemon PID file ─────────────────────────────────────────────────────
  if (daemonPid) {
    if (existsSync(daemonPid)) {
      try {
        const pid = parseInt(readFileSync(daemonPid, 'utf8').trim(), 10)
        let alive = false
        if (pid > 0) {
          try { process.kill(pid, 0); alive = true } catch { alive = false }
        }
        checks.push({ name: 'daemon-pid', ok: alive, detail: alive ? `pid ${pid} alive` : `pid ${pid} not running` })
      } catch (err) {
        checks.push({ name: 'daemon-pid', ok: false, detail: `read failed: ${String(err?.message ?? err).slice(0, 80)}` })
      }
    } else {
      checks.push({ name: 'daemon-pid', ok: false, detail: 'PID file not found — daemon may not be running' })
    }
  }

  // ── 3. Node connectivity log ───────────────────────────────────────────────
  const connLog = join(dshHome, 'ac-state', 'connectivity.json')
  if (existsSync(connLog)) {
    try {
      const data = JSON.parse(readFileSync(connLog, 'utf8'))
      const nodes = Array.isArray(data.nodes) ? data.nodes : []
      const online = nodes.filter(n => n?.lastSeen && (at - n.lastSeen) < MAX_NODE_IDLE_MS)
      checks.push({
        name: 'node-heartbeats',
        ok: nodes.length === 0 || online.length > 0,
        detail: nodes.length === 0 ? 'no nodes configured' : `${online.length}/${nodes.length} nodes heartbeating`,
      })
    } catch (err) {
      checks.push({ name: 'node-heartbeats', ok: null, detail: `read failed: ${String(err?.message ?? err).slice(0, 80)}` })
    }
  }

  // ── 4. Daemon restart log (crash-loop guard) ───────────────────────────────
  const restartLog = join(dshHome, 'ac-state', 'daemon-restarts.json')
  if (existsSync(restartLog)) {
    try {
      const data = JSON.parse(readFileSync(restartLog, 'utf8'))
      const recent = Array.isArray(data.restarts)
        ? data.restarts.filter(r => typeof r.at === 'number' && (at - r.at) < 60 * 60 * 1000)
        : []
      checks.push({
        name: 'daemon-crash-loop',
        ok: recent.length <= MAX_DAEMON_RESTART_COUNT,
        detail: `${recent.length} restarts in the last hour`,
      })
    } catch { /* log absent or unreadable — skip */ }
  }

  const failed = checks.filter(c => c.ok === false)
  const ok = failed.length === 0
  const summary = ok
    ? `all ${checks.length} checks pass`
    : `${failed.length} check(s) failed: ${failed.map(c => c.name).join(', ')}`

  return { ok, checks, summary }
}
