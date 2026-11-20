/** Plan the next bind attempt after a listener startup error. */
export function planListenRetry({ attempt, code, disposed }) {
  if (disposed === true) return { retry: false, fatal: false, delayMs: 0, state: 'disposed' }
  if (!String(code ?? '').includes('EADDRINUSE')) {
    return { retry: false, fatal: true, delayMs: 0, state: 'fatal' }
  }
  if (attempt <= 3) {
    return { retry: true, fatal: false, delayMs: 200 * attempt, state: 'retrying-close' }
  }
  const delayMs = Math.min(30_000, 5_000 * 2 ** (attempt - 4))
  return { retry: true, fatal: false, delayMs, state: 'waiting-port' }
}

/** Project the public listener fields used by the panel. */
export function projectListener(listenRuntime) {
  if (listenRuntime == null) return null
  return {
    ok: listenRuntime.ok,
    disabled: typeof listenRuntime.disabled === 'string' ? listenRuntime.disabled : '',
    host: typeof listenRuntime.host === 'string' ? listenRuntime.host : '',
    port: Number.isFinite(listenRuntime.port) ? listenRuntime.port : null,
    source: typeof listenRuntime.source === 'string' ? listenRuntime.source : '',
    error: typeof listenRuntime.error === 'string' ? listenRuntime.error : '',
    state: typeof listenRuntime.state === 'string' ? listenRuntime.state : '',
    waitingSince: Number.isFinite(listenRuntime.waitingSince) ? listenRuntime.waitingSince : null,
  }
}
