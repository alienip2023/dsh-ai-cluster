// The hub snapshot poll that feeds the fleet screens, ported from the old panel-perf test:
// adaptive delay, no requests while the page is hidden, immediate first load, timer cleared on unmount.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createData, dataPollDelay, dataSetupStatePath, dataShouldPoll, dataActivePollMs, dataPollMs, dataStatusPath } from '../../src/panel/data.js'

test('shouldPoll: only hidden === true suppresses polling', () => {
  assert.equal(dataShouldPoll({ hidden: true }), false)
  assert.equal(dataShouldPoll({ hidden: false }), true)
  assert.equal(dataShouldPoll(undefined), true)
  assert.equal(dataShouldPoll(null), true)
  assert.equal(dataShouldPoll({ hidden: 1 }), true)
})

test('poll delay: 8 s when idle, 3 s while any task is active', () => {
  assert.equal(dataPollMs, 8000)
  assert.equal(dataActivePollMs, 3000)
  assert.equal(dataPollDelay(0), 8000)
  assert.equal(dataPollDelay(undefined), 8000)
  assert.equal(dataPollDelay(1), 3000)
  assert.equal(dataPollDelay(25), 3000)
})

function harness() {
  const requests = []
  const effects = []
  const timers = []
  const cleared = []
  const states = []
  const React = {
    useState(v) { const slot = { v }; states.push(slot); return [v, (n) => { slot.v = typeof n === 'function' ? n(slot.v) : n }] },
    useEffect(fn) { effects.push(fn) },
    useRef(v) { return { current: v } },
    useCallback(fn) { return fn },
  }
  const control = { failOverview: false }
  const api = {
    get(path) {
      requests.push(path)
      if (path === '/overview' && control.failOverview) return Promise.reject(new Error('overview-failed'))
      return Promise.resolve(path === '/overview' ? { nodes: [{ nodeId: 'a', online: true }, { nodeId: 'b', online: true }], counts: {}, topology: { peerLinks: [] } } : path === '/tasks' ? { tasks: [] } : {})
    },
    getPath(path) { requests.push(path); return Promise.resolve({ nodeId: 'local-worker' }) },
  }
  const safe = (p) => p.then((d) => d, (e) => ({ ok: false, error: String(e) }))
  const data = createData({ React, api, safe })
  const hubApi = data.useHub(true, true)
  const stubbed = (fn) => {
    const realSet = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    globalThis.setTimeout = (cb, ms) => { timers.push({ fn: cb, ms }); return timers.length }
    globalThis.clearTimeout = (id) => { cleared.push(id) }
    try { return fn() } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear }
  }
  /** Run the poll effect with the timer functions stubbed; returns its cleanup (also stubbed). */
  const start = () => {
    const cleanup = stubbed(() => effects.at(-1)())
    return () => stubbed(cleanup)
  }
  const overviews = () => requests.filter((p) => p === '/overview').length
  return { hubApi, data, start, timers, cleared, overviews, control, states, requests, effects }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('poll runtime: first load is immediate, hidden ticks make no request, visible ticks resume, cleanup clears the timer', async () => {
  const h = harness()
  const cleanup = h.start()
  await settle()
  assert.equal(h.overviews(), 1, 'initial load stays immediate')
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0].ms, 8000)
  const real = Object.getOwnPropertyDescriptor(globalThis, 'document')
  try {
    globalThis.document = { hidden: true }
    h.timers[0].fn()
    await settle()
    assert.equal(h.overviews(), 1, 'a hidden tick must not request')
    globalThis.document = { hidden: false }
    h.timers[0].fn()
    await settle()
    await settle()
    assert.equal(h.overviews(), 2, 'a visible tick resumes loading')
  } finally {
    if (real) Object.defineProperty(globalThis, 'document', real); else delete globalThis.document
  }
  cleanup()
  assert.deepEqual(h.cleared, [1])
})

test('poll runtime: with no document at all, polling still runs', async () => {
  const h = harness()
  const cleanup = h.start()
  await settle()
  h.timers[0].fn()
  await settle()
  await settle()
  assert.equal(h.overviews(), 2)
  cleanup()
})

test('a failed refresh keeps the last good snapshot and records the error; the next success clears it', async () => {
  const h = harness()
  h.start()
  await settle()
  await settle()
  const hub = () => h.states[0].v
  assert.equal(hub().nodes.length, 2)
  assert.equal(hub().error, '')
  assert.equal(hub().loading, false)
  h.control.failOverview = true
  h.timers[0].fn()
  await settle()
  await settle()
  assert.equal(hub().error, 'overview-failed')
  assert.equal(hub().nodes.length, 2, 'the last successful machines are kept')
  assert.deepEqual(hub().topology, { peerLinks: [] })
  h.control.failOverview = false
  h.timers.at(-1).fn()
  await settle()
  await settle()
  assert.equal(hub().error, '')
})

test('a second poll while one is in flight is dropped', async () => {
  const h = harness()
  h.start()
  const first = h.hubApi.refresh()
  const second = h.hubApi.refresh()
  await Promise.all([first, second])
  await settle()
  assert.equal(h.overviews(), 1)
})

test('both role reads the local worker status through the fixed status path', async () => {
  assert.equal(dataStatusPath, '/api/remote-agent/status')
  assert.equal(dataSetupStatePath, '/api/remote-agent/setup/state')
  const h = harness()
  const worker = h.data.useWorker(true, true)
  assert.equal(typeof worker.refresh, 'function')
  h.effects.at(-1)()
  await settle()
  assert.ok(h.requests.includes('/api/remote-agent/status'))
  assert.equal(h.states.at(-2).v.status.nodeId, 'local-worker')
})
