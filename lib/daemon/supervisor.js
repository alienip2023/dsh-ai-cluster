// Supervisor: keep one child process alive.
//
// Restarts the child on exit with backoff (1 s → 60 s). A child that stayed up for
// `stableMs` counts as healthy again, so the next crash starts from the short delay.
// Kept free of process-global side effects (signals, pid files) so tests can drive it.
import { spawn as nodeSpawn } from 'node:child_process'

export const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000, 60000]
export const STABLE_MS = 60_000

export function backoffDelay(attempt) {
  return BACKOFF_DELAYS[Math.min(Math.max(attempt, 0), BACKOFF_DELAYS.length - 1)]
}

/**
 * @param {{ command: string, args?: string[], cwd?: string, env?: object, stdio?: any,
 *   spawn?: Function, setTimer?: Function, clearTimer?: Function, now?: Function,
 *   stableMs?: number, log?: (msg: string) => void }} opts
 */
export function createSupervisor({
  command, args = [], cwd, env, stdio = 'inherit',
  spawn = nodeSpawn, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
  stableMs = STABLE_MS, log = () => {},
}) {
  if (typeof command !== 'string' || command === '') throw new Error('supervisor: no command to run')
  let child
  let timer
  let attempt = 0
  let startedAt = 0
  let stopping = false
  let restarts = 0

  const schedule = (reason) => {
    if (stopping) return
    if (now() - startedAt >= stableMs) attempt = 0
    const delay = backoffDelay(attempt)
    attempt += 1
    restarts += 1
    log(`child ${reason}; restarting in ${delay}ms`)
    // Not unref'd: this timer is what keeps the supervisor alive between children.
    timer = setTimer(() => { timer = undefined; run() }, delay)
  }

  const run = () => {
    if (stopping) return
    startedAt = now()
    log(`starting: ${command} ${args.join(' ')}`)
    let settled = false
    const once = (reason) => { if (settled) return; settled = true; child = undefined; schedule(reason) }
    try {
      child = spawn(command, args, { cwd, env, stdio, windowsHide: true })
    } catch (err) {
      once(`failed to start (${err?.message ?? err})`)
      return
    }
    child.on('exit', (code, signal) => once(`exited (${signal ?? code})`))
    child.on('error', (err) => once(`error (${err?.message ?? err})`))
  }

  return {
    start() { stopping = false; run() },
    /** Stop supervising and end the child. Resolves when the child is gone. */
    stop(signal = 'SIGTERM') {
      stopping = true
      if (timer !== undefined) { clearTimer(timer); timer = undefined }
      const current = child
      if (!current) return Promise.resolve()
      return new Promise((resolve) => {
        current.once('exit', () => resolve())
        try { current.kill(signal) } catch { resolve() }
      })
    },
    status() { return { running: child !== undefined, pid: child?.pid, attempt, restarts, stopping } },
  }
}
