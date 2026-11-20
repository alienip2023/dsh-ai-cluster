import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { applyHub } from '../../lib/hub/index.js'
import { planListenRetry, projectListener } from '../../lib/hub/listen-retry.js'
import { registerUiRoutes as registerPanelRoutes } from '../../src/http/routes.js'
import { makeCtx } from './_plugin-ctx.js'

const inUse = 'EADDRINUSE'

for (const [attempt, delayMs] of [[1, 200], [2, 400], [3, 600]]) {
  test(`retrying-close: attempt ${attempt} waits ${delayMs} ms`, () => {
    assert.deepEqual(planListenRetry({ attempt, code: inUse, disposed: false }), {
      retry: true, fatal: false, delayMs, state: 'retrying-close',
    })
  })
}

for (const [attempt, delayMs] of [[4, 5000], [5, 10000], [6, 20000], [7, 30000], [99, 30000]]) {
  test(`waiting-port: attempt ${attempt} waits ${delayMs} ms`, () => {
    assert.deepEqual(planListenRetry({ attempt, code: inUse, disposed: false }), {
      retry: true, fatal: false, delayMs, state: 'waiting-port',
    })
  })
}

test('waiting-port: retry delays never decrease across the short and long phases', () => {
  let previous = 0
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const { retry, delayMs } = planListenRetry({ attempt, code: inUse, disposed: false })
    assert.equal(retry, true, `attempt ${attempt} should retry`)
    assert.ok(delayMs >= previous, `attempt ${attempt} should not shorten the delay`)
    previous = delayMs
  }
})

test('a listen error string containing EADDRINUSE is retryable', () => {
  assert.deepEqual(planListenRetry({ attempt: 1, code: 'listen EADDRINUSE: address already in use', disposed: false }), {
    retry: true, fatal: false, delayMs: 200, state: 'retrying-close',
  })
})

test('disposal takes precedence over retry and fatal errors', () => {
  for (const [attempt, code] of [[1, inUse], [4, inUse], [99, 'ECONNREFUSED']]) {
    assert.deepEqual(planListenRetry({ attempt, code, disposed: true }), {
      retry: false, fatal: false, delayMs: 0, state: 'disposed',
    })
  }
})

test('ECONNREFUSED is fatal without a retry', () => {
  assert.deepEqual(planListenRetry({ attempt: 1, code: 'ECONNREFUSED', disposed: false }), {
    retry: false, fatal: true, delayMs: 0, state: 'fatal',
  })
})

const PORT = 19388
const LEGACY_OVERVIEW = '/api/remote-agent/ui/overview'
const PANEL_OVERVIEW = '/api/ai-cluster/ui/overview'

function fixture(t, codes, registerUiRoutes) {
  const ctx = makeCtx()
  const routes = new Map()
  const warnings = []
  const timers = new Set()
  let attempts = 0
  ctx.logger.warn = (message, fields) => warnings.push({ message, ...fields })
  ctx.webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
    registerUpgrade: () => () => {},
  }
  ctx.tools = { register: () => () => {} }
  ctx.systemPrompt = { section: () => () => {} }
  ctx.services.set('connection', { requestRejection: ({ headers }) => headers.cookie === 'session=ok' ? undefined : 401 })
  t.mock.method(http, 'createServer', () => Object.assign(new EventEmitter(), {
    listen(port, host, ready) {
      assert.equal(port, PORT)
      assert.equal(host, '127.0.0.1')
      const code = codes[attempts++]
      if (code) this.emit('error', Object.assign(new Error(`listen ${code}`), { code }))
      else ready()
    },
    address: () => ({ port: PORT }),
    close: (done) => done(),
  }))
  t.mock.method(globalThis, 'setTimeout', (run, delay) => {
    const timer = { run, delay, unrefed: false, unref() { this.unrefed = true } }
    timers.add(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', (timer) => timers.delete(timer))
  const hub = applyHub(ctx, {
    listenPort: PORT, listenHost: '127.0.0.1', nodeToken: 'test-token', audit: false, stateDir: ctx.stateDir,
  }, { registerUiRoutes })
  t.after(() => { hub.disposeAll(); ctx.cleanup() })

  return {
    routes, warnings, timers, hub,
    attempts: () => attempts,
    async advance(delay) {
      assert.equal(timers.size, 1)
      const [timer] = timers
      assert.equal(timer.delay, delay)
      assert.equal(timer.unrefed, true)
      timers.delete(timer)
      timer.run()
      await setImmediate()
    },
  }
}

async function request(handler, { method = 'GET', headers = { cookie: 'session=ok' } } = {}) {
  const response = {}
  assert.equal(typeof handler, 'function')
  await handler({ method, headers }, {
    writeHead(status) { response.status = status },
    end(payload) { response.body = JSON.parse(payload) },
  })
  return response
}

async function listenerOf(handler) {
  const response = await request(handler)
  assert.equal(response.status, 200)
  return response.body.capabilities.listener
}

test('waiting-port: the standalone overview reports retry, sustained wait and recovery', async (t) => {
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  const f = fixture(t, Array(5).fill('EADDRINUSE'))
  const handler = f.routes.get(LEGACY_OVERVIEW)
  await setImmediate()
  assert.equal((await listenerOf(handler)).state, 'retrying-close')
  for (const delay of [200, 400, 600]) await f.advance(delay)

  const waiting = await listenerOf(handler)
  assert.equal(waiting.state, 'waiting-port')
  assert.equal(waiting.waitingSince, now)
  now += 5000
  await f.advance(5000)
  assert.equal((await listenerOf(handler)).waitingSince, waiting.waitingSince)
  assert.deepEqual(f.warnings.filter(({ message }) => message.includes('listen:')).map(
    ({ host, port, attempt, waitingMs }) => ({ host, port, attempt, waitingMs }),
  ), [
    { host: '127.0.0.1', port: PORT, attempt: 1, waitingMs: 200 },
    { host: '127.0.0.1', port: PORT, attempt: 4, waitingMs: 5000 },
  ])
  await f.advance(10000)
  const ready = await listenerOf(handler)
  assert.equal(ready.state, 'ready')
  assert.equal(ready.waitingSince ?? 0, 0)
  assert.equal(ready.ok, true)
  assert.equal(ready.error, '')
  assert.equal(f.timers.size, 0)
})

test('waiting-port: both panel overview aliases report the wait and dispose cancels it', async (t) => {
  const f = fixture(t, Array(4).fill('EADDRINUSE'), registerPanelRoutes)
  await setImmediate()
  for (const delay of [200, 400, 600]) await f.advance(delay)
  const handler = f.routes.get(PANEL_OVERVIEW)
  const waiting = await listenerOf(handler)
  assert.equal(waiting.state, 'waiting-port')
  assert.ok(waiting.waitingSince > 0)
  assert.deepEqual(await listenerOf(f.routes.get(LEGACY_OVERVIEW)), waiting)
  assert.deepEqual(await request(handler, { headers: {} }), { status: 401, body: { error: 'unauthorized' } })
  assert.deepEqual(await request(handler, { method: 'POST' }), { status: 405, body: { error: 'method' } })

  assert.equal(f.timers.size, 1)
  assert.equal([...f.timers][0].unrefed, true)
  f.hub.disposeAll()
  await setImmediate()
  assert.equal(f.routes.has(PANEL_OVERVIEW), false)
  assert.equal(f.timers.size, 0)
  assert.equal(f.attempts(), 4)
  const disposed = await listenerOf(handler)
  assert.equal(disposed.state, 'disposed')
  assert.equal(disposed.waitingSince ?? 0, 0)
})

test('a non-EADDRINUSE bind error is terminal without scheduling a retry', async (t) => {
  const f = fixture(t, ['EACCES'])
  await setImmediate()
  const failed = await listenerOf(f.routes.get(LEGACY_OVERVIEW))
  assert.equal(failed.state, 'fatal')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /EACCES/)
  assert.equal(f.attempts(), 1)
  assert.equal(f.timers.size, 0)
})

test('projectListener: absent runtime projects to null', () => {
  assert.equal(projectListener(undefined), null)
  assert.equal(projectListener(null), null)
})

test('projectListener: preserves all public fields and omits internal fields', () => {
  const fields = {
    ok: false,
    disabled: 'disabled reason',
    host: '127.0.0.1',
    port: PORT,
    source: 'config',
    error: 'bind error',
    state: 'fatal',
    waitingSince: 1_800_000_000_000,
  }
  assert.deepEqual(projectListener({ ...fields, internal: 'private' }), fields)
})

test('projectListener: normalizes invalid strings and non-finite numbers', () => {
  assert.deepEqual(projectListener({
    ok: false, disabled: true, host: 42, port: 'x', source: {}, error: null, state: [], waitingSince: NaN,
  }), {
    ok: false, disabled: '', host: '', port: null, source: '', error: '', state: '', waitingSince: null,
  })
  const infinite = projectListener({ port: Infinity, waitingSince: -Infinity })
  assert.equal(infinite.port, null)
  assert.equal(infinite.waitingSince, null)
})

test('projectListener: projects state and waitingSince for a port wait', () => {
  const waitingSince = 1_800_000_000_000
  const listener = projectListener({ state: 'waiting-port', waitingSince })
  assert.equal(listener.state, 'waiting-port')
  assert.equal(listener.waitingSince, waitingSince)
  assert.equal(projectListener({ state: 'ready' }).waitingSince, null)
})
