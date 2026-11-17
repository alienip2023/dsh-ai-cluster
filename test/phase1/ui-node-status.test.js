import test from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_UI_API_PREFIX, UI_API_PREFIX } from '../../src/http/prefix.js'
import { registerUiRoutes } from '../../src/http/routes.js'
import { makeCtx } from './_plugin-ctx.js'

const statusPath = `${UI_API_PREFIX}/node-status`
const nodeKeys = ['nodeId', 'online', 'lastSeen', 'silentMs', 'stale', 'thresholdMs', 'resource', 'connectivity', 'queue', 'transportMode']

function listedNode() {
  return {
    nodeId: 'pc-b', online: true, lastSeen: 1000, transportMode: 'direct',
    resource: { cpuPct: 12, load1: 0.5, memUsedMb: 4096, memTotalMb: 16384, at: 900, secret: 'no' },
    connectivity: { transportMode: 'relay', tunnelState: 'ready', tunnel: null, probes: [], sampledAt: 900 },
    queue: { queued: 1, running: 2, maxConcurrent: 4, oldestQueuedMs: 10, starved: false },
    hostname: 'private', bots: [], roots: ['/private'], caps: [], models: [], repos: [],
  }
}

function fixture(t, registry = { list: () => [] }) {
  const ctx = makeCtx()
  const routes = new Map()
  ctx.webServer = {
    register(route) {
      assert.equal(routes.has(route.path), false, `duplicate route: ${route.path}`)
      routes.set(route.path, route)
      return () => {
        if (routes.get(route.path) === route) routes.delete(route.path)
      }
    },
  }
  const disposers = registerUiRoutes({
    ctx, registry, pulls: { activeCount: 0 }, log() {},
    config: { role: 'hub', stateDir: ctx.stateDir },
  })
  t.after(() => {
    for (const dispose of disposers) dispose()
    ctx.cleanup()
  })
  return routes
}

async function request(routes, pathname = statusPath, { method = 'GET', headers = {}, now = 100000 } = {}) {
  const route = routes.get(pathname)
  assert.ok(route, `missing UI route: ${pathname}`)
  const out = { status: 0, headers: null, body: null }
  const originalNow = Date.now
  Date.now = () => now
  try {
    await route.handler({ method, url: pathname, headers }, {
      writeHead(status, responseHeaders) { out.status = status; out.headers = responseHeaders },
      end(payload) { out.body = JSON.parse(payload) },
    })
  } finally {
    Date.now = originalNow
  }
  return out
}

test('node-status registers exact routes under both prefixes with identical responses', async (t) => {
  const routes = fixture(t, { list: () => [listedNode()] })
  const current = await request(routes)
  assert.equal(current.status, 200)
  assert.equal(current.body.ok, true)
  assert.equal(current.body.heartbeatMs, 15000)
  assert.deepEqual(Object.keys(current.body), ['ok', 'heartbeatMs', 'nodes'])
  for (const prefix of [UI_API_PREFIX, LEGACY_UI_API_PREFIX]) {
    const pathname = `${prefix}/node-status`
    assert.equal(routes.get(pathname)?.kind, 'exact')
    assert.deepEqual(await request(routes, pathname), current)
  }
})

test('node-status rejects non-GET methods and cross-site requests on both prefixes', async (t) => {
  const routes = fixture(t, { list() { assert.fail('rejected requests must not read the registry') } })
  for (const prefix of [UI_API_PREFIX, LEGACY_UI_API_PREFIX]) {
    const pathname = `${prefix}/node-status`
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await request(routes, pathname, { method })
      assert.equal(response.status, 405)
      assert.deepEqual(response.body, { error: 'method' })
    }
    const response = await request(routes, pathname, { headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(response.status, 403)
    assert.deepEqual(response.body, { error: 'forbidden' })
  }
})

test('node-status projects resource cpuPct 12 and only the allowed node fields', async (t) => {
  const raw = listedNode()
  const routes = fixture(t, { list: () => [raw] })
  const { body } = await request(routes)
  assert.equal(body.nodes[0].resource?.cpuPct, 12)
  assert.deepEqual(Object.keys(body.nodes[0]), nodeKeys)
  assert.deepEqual(body.nodes[0], {
    nodeId: 'pc-b', online: true, lastSeen: 1000, silentMs: 99000,
    stale: true, thresholdMs: body.heartbeatMs * 4,
    resource: { cpuPct: 12, load1: 0.5, memUsedMb: 4096, memTotalMb: 16384, at: 900 },
    connectivity: { transportMode: 'relay', tunnelState: 'ready', tunnel: null, probes: [], sampledAt: 900 },
    queue: { queued: 1, running: 2, maxConcurrent: 4, oldestQueuedMs: 10, starved: false },
    transportMode: 'direct',
  })
  assert.equal(Object.hasOwn(body.nodes[0].resource, 'secret'), false)
  assert.equal(raw.online, true)
  assert.equal(raw.resource.secret, 'no')
})

test('node-status uses configured heartbeat and relay thresholds for every non-direct mode', async (t) => {
  const routes = fixture(t, {
    limits: { heartbeatMs: 2500 },
    list: () => ['direct', 'relay', 'unknown', undefined, 7].map(transportMode => ({ ...listedNode(), transportMode })),
  })
  const { body } = await request(routes)
  assert.equal(body.heartbeatMs, 2500)
  assert.deepEqual(body.nodes.map(n => n.thresholdMs), [10000, 20000, 20000, 20000, 20000])
  assert.deepEqual(body.nodes.map(n => n.transportMode), ['direct', 'relay', 'unknown', null, null])
})

test('node-status defaults missing and invalid heartbeat limits to 15000', async (t) => {
  for (const heartbeatMs of [undefined, null, 0, -1, NaN, Infinity, '2500']) {
    const routes = fixture(t, { limits: { heartbeatMs }, list: () => [] })
    assert.deepEqual((await request(routes)).body, { ok: true, heartbeatMs: 15000, nodes: [] })
  }
})

test('node-status computes silence and strict stale boundaries without changing online', async (t) => {
  const now = 200000
  const rawNodes = [
    { lastSeen: now - 60000, transportMode: 'direct', online: true },
    { lastSeen: now - 60001, transportMode: 'direct', online: true },
    { lastSeen: now - 120000, transportMode: 'relay', online: false },
    { lastSeen: now - 120001, transportMode: 'relay', online: true },
    { lastSeen: now + 1000 },
    {}, { lastSeen: NaN }, { lastSeen: Infinity }, { lastSeen: '1000' }, { lastSeen: null },
  ]
  const routes = fixture(t, { list: () => rawNodes })
  const { body } = await request(routes, statusPath, { now })
  assert.deepEqual(body.nodes.map(n => n.silentMs), [60000, 60001, 120000, 120001, 0, null, null, null, null, null])
  assert.deepEqual(body.nodes.map(n => n.stale), [false, true, false, true, false, null, null, null, null, null])
  assert.deepEqual(body.nodes.map(n => n.online), [true, true, false, true, false, false, false, false, false, false])
  assert.deepEqual(body.nodes.slice(5).map(n => n.lastSeen), [null, null, null, null, null])
  assert.equal(body.nodes[5].nodeId, '')
})

test('node-status captures Date.now once for all nodes in a request', async (t) => {
  const routes = fixture(t, { list: () => [listedNode(), listedNode()] })
  const originalNow = Date.now
  let calls = 0
  Date.now = () => { calls += 1; return 100000 + calls }
  try {
    let body
    await routes.get(statusPath).handler({ method: 'GET', headers: {} }, {
      writeHead() {}, end(payload) { body = JSON.parse(payload) },
    })
    assert.equal(calls, 1)
    assert.deepEqual(body.nodes.map(n => n.silentMs), [99001, 99001])
  } finally {
    Date.now = originalNow
  }
})

test('node-status preserves null queue and normalizes invalid numeric and boolean fields', async (t) => {
  const routes = fixture(t, {
    list: () => [
      { queue: null },
      { nodeId: 7, online: 'true', resource: { cpuPct: '12', load1: NaN, memUsedMb: Infinity, memTotalMb: null },
        queue: { queued: '1', running: NaN, maxConcurrent: Infinity, oldestQueuedMs: null, starved: 'true', secret: 'no' } },
      { queue: { starved: true } },
    ],
  })
  const { body } = await request(routes)
  assert.equal(body.nodes[0].queue, null)
  assert.equal(body.nodes[0].resource, null)
  assert.equal(body.nodes[0].connectivity, null)
  assert.equal(body.nodes[1].nodeId, '')
  assert.equal(body.nodes[1].online, false)
  assert.deepEqual(body.nodes[1].resource, { cpuPct: null, load1: null, memUsedMb: null, memTotalMb: null, at: null })
  assert.deepEqual(body.nodes[1].queue, { queued: 0, running: 0, maxConcurrent: 0, oldestQueuedMs: 0, starved: false })
  assert.equal(body.nodes[2].queue.starved, true)
})

test('node-status applies connectivity allow-lists, field limits and nested projections', async (t) => {
  const routes = fixture(t, {
    list: () => [
      { connectivity: {
        transportMode: 'direct', tunnelState: 'configured', sampledAt: 900, secret: 'no',
        tunnel: { kind: 'k'.repeat(20), server: 's'.repeat(130), localPort: 80, remotePort: Infinity, secret: 'no' },
        probes: [null, { target: 't'.repeat(130), result: 'open', rttMs: 4, secret: 'no' },
          { target: 'bad', result: 'invalid', rttMs: Infinity },
          ...Array.from({ length: 7 }, () => ({ target: 'host', result: 'closed', rttMs: 0 }))],
      } },
      { connectivity: { transportMode: 'invalid', tunnelState: 'invalid', tunnel: [], probes: 'invalid', sampledAt: NaN } },
      { connectivity: [] },
    ],
  })
  const { body } = await request(routes)
  assert.deepEqual(body.nodes[0].connectivity, {
    transportMode: 'direct', tunnelState: 'configured',
    tunnel: { kind: 'k'.repeat(16), server: 's'.repeat(120), localPort: 80, remotePort: null },
    probes: [{ target: 't'.repeat(120), result: 'open', rttMs: 4 },
      { target: 'bad', result: 'timeout', rttMs: null },
      ...Array.from({ length: 5 }, () => ({ target: 'host', result: 'closed', rttMs: 0 }))],
    sampledAt: 900,
  })
  assert.deepEqual(body.nodes[1].connectivity, { transportMode: null, tunnelState: null, tunnel: null, probes: [], sampledAt: null })
  assert.equal(body.nodes[2].connectivity, null)
})

test('node-status returns an empty successful snapshot when list throws or is missing', async (t) => {
  for (const registry of [{ limits: { heartbeatMs: 5000 }, list() { throw new Error('unavailable') } }, {}]) {
    const response = await request(fixture(t, registry))
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { ok: true, heartbeatMs: registry.limits?.heartbeatMs ?? 15000, nodes: [] })
  }
})

test('node-status leaves projection errors to the existing 500 wrapper', async (t) => {
  const raw = listedNode()
  Object.defineProperty(raw, 'resource', { get() { throw new Error('projection failed') } })
  const response = await request(fixture(t, { list: () => [raw] }))
  assert.equal(response.status, 500)
  assert.equal(response.body.message, 'projection failed')
})

test('overview still omits resource from node objects', async (t) => {
  const raw = listedNode()
  assert.equal(raw.resource.cpuPct, 12)
  const routes = fixture(t, { list: () => [raw], listTasks: () => [] })
  for (const prefix of [UI_API_PREFIX, LEGACY_UI_API_PREFIX]) {
    const { status, body } = await request(routes, `${prefix}/overview`)
    assert.equal(status, 200)
    assert.equal(body.nodes.length, 1)
    assert.equal(body.nodes[0].nodeId, 'pc-b')
    assert.equal(Object.hasOwn(body.nodes[0], 'resource'), false)
  }
})
