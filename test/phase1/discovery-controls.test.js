import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { apply } from '../../lib/index.js'
import { applyHub } from '../../lib/hub/index.js'
import { buildOffer, encodeOffer } from '../../lib/discovery.js'
import { RelayLink } from '../../lib/hub/relay-link.js'
import { makeCtx } from './_plugin-ctx.js'

const current = '/api/ai-cluster/ui'
const legacy = '/api/remote-agent/ui'

function fixture(t, { standalone = false } = {}) {
  const ctx = makeCtx()
  const routes = new Map()
  ctx.webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    registerUpgrade: () => () => {},
  }
  ctx.tools = { register: () => () => {} }
  ctx.systemPrompt = { section: () => () => {} }
  // Simulate a host that exposes connection through the non-strict lookup.
  const connection = { requestRejection: ({ headers }) => headers.cookie === 'session=ok' ? undefined : 401 }
  ctx.services.set('connection', connection)
  const file = path.join(ctx.stateDir, 'instance.json')
  const initial = { nodeToken: 'existing-token', roots: ['/existing'], custom: { retain: true } }
  writeFileSync(file, JSON.stringify(initial))
  const config = { role: 'hub', listenPort: 0, audit: false, stateDir: ctx.stateDir, discovery: { port: 8128 } }
  const sockets = []
  const socketFactory = t.mock.method(dgram, 'createSocket', () => {
    const socket = Object.assign(new EventEmitter(), {
      offers: [],
      bind(port, _host, ready) { this.port = port; queueMicrotask(ready) },
      address() { return { port: this.port } },
      setBroadcast() {},
      send(buf, port, address) { this.offers.push({ offer: JSON.parse(buf), port, address }) },
      close() { this.closed = true },
    })
    sockets.push(socket)
    return socket
  })
  function mount() {
    if (!standalone) return apply(ctx, config)
    const hub = applyHub(ctx, config)
    return { hub, dispose: hub.disposeAll }
  }
  let handles = mount()
  t.after(() => { handles.dispose(); ctx.cleanup() })
  return {
    ctx, file, initial, sockets, socketFactory,
    registry: () => handles.hub.registry,
    restart() {
      handles.dispose()
      ctx.services.clear()
      ctx.services.set('connection', connection)
      handles = mount()
    },
    async request(routePath, { body, method = 'POST', headers = { cookie: 'session=ok' } } = {}) {
      const route = routes.get(routePath)
      assert.ok(route, `missing route ${routePath}`)
      const out = {}
      await route.handler({ method, headers, url: routePath, async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      } }, {
        writeHead(status) { out.status = status },
        end(text) { out.body = JSON.parse(text) },
      })
      return out
    },
  }
}

test('authenticated switch starts, persists across restart, and closes discovery', async (t) => {
  const f = fixture(t)
  assert.equal(f.socketFactory.mock.callCount(), 0)
  const toggle = `${current}/discovery/toggle`
  for (const prefix of [current, legacy]) {
    assert.equal((await f.request(`${prefix}/discovery/toggle`, { body: { enabled: true }, headers: {} })).status, 401)
    assert.equal((await f.request(`${prefix}/discovery/scan`, { headers: {} })).status, 401)
  }
  assert.equal((await f.request(toggle, { method: 'GET' })).status, 405)
  assert.equal((await f.request(toggle, {
    body: { enabled: true }, headers: { cookie: 'session=ok', 'sec-fetch-site': 'cross-site' },
  })).status, 403)
  const auth = f.ctx.services.get('connection')
  f.ctx.services.delete('connection')
  assert.equal((await f.request(toggle, { body: { enabled: true } })).status, 401)
  f.ctx.services.set('connection', auth)
  assert.equal((await f.request(toggle, { body: { enabled: 'true' } })).status, 400)
  assert.equal((await f.request(`${current}/discovery/scan`)).status, 409)
  assert.equal((await f.request(toggle, { body: { enabled: false } })).body.discovery.enabled, false)
  assert.equal(f.socketFactory.mock.callCount(), 0)
  assert.equal((await f.request(toggle, { body: { enabled: true } })).body.discovery.enabled, true)
  assert.equal(f.socketFactory.mock.callCount(), 1)
  assert.equal(f.sockets[0].port, 8128)
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { ...f.initial, discoveryEnabled: true })

  f.restart()
  assert.equal(f.sockets[0].closed, true)
  assert.equal(f.socketFactory.mock.callCount(), 2)
  await Promise.resolve() // Complete the restarted listener's asynchronous bind.
  assert.equal((await f.request(`${current}/overview`, { method: 'GET' })).body.discovery.enabled, true)
  assert.equal((await f.request(`${legacy}/discovery/toggle`, { body: { enabled: false } })).body.discovery.enabled, false)
  assert.equal(f.sockets[1].closed, true)
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { ...f.initial, discoveryEnabled: false })
  f.restart()
  assert.equal(f.socketFactory.mock.callCount(), 2)
})

test('scan sends one offer to the existing targets and returns peers without pairing or connecting', async (t) => {
  const f = fixture(t)
  const connect = t.mock.method(f.registry(), 'attachDirect')
  const pair = t.mock.method(f.registry(), 'ingestHello')
  const relayConnect = t.mock.method(RelayLink.prototype, 'start')
  assert.equal((await f.request(`${current}/discovery/toggle`, { body: { enabled: true } })).status, 200)
  const [socket] = f.sockets
  const initialOffers = socket.offers.slice()
  assert.ok(initialOffers.length > 0)
  const peer = { node: 'other', hostname: '10.0.0.12', port: 19387, role: 'node', pluginVersion: '1.0.0' }
  socket.emit('message', encodeOffer(buildOffer(peer)))
  const before = readFileSync(f.file, 'utf8')
  const scan = await f.request(`${legacy}/discovery/scan`)
  assert.equal(scan.status, 200)
  assert.equal(scan.body.discovery.peers.length, 1)
  const { at, ...discovered } = scan.body.discovery.peers[0]
  assert.ok(Number.isFinite(at))
  assert.deepEqual(discovered, peer)
  assert.deepEqual(socket.offers.slice(initialOffers.length), initialOffers)
  assert.equal(f.socketFactory.mock.callCount(), 1)
  assert.equal(connect.mock.callCount(), 0)
  assert.equal(pair.mock.callCount(), 0)
  assert.equal(relayConnect.mock.callCount(), 0)
  assert.equal(readFileSync(f.file, 'utf8'), before)
})

test('a discovery toggle preserves unreadable config and keeps discovery off', async (t) => {
  const f = fixture(t)
  const broken = '{"custom":'
  writeFileSync(f.file, broken)
  const toggle = await f.request(`${current}/discovery/toggle`, { body: { enabled: true } })
  assert.equal(toggle.status, 500)
  assert.equal(readFileSync(f.file, 'utf8'), broken)
  assert.equal(f.socketFactory.mock.callCount(), 0)
})


test('standalone hub restores the switch through the same instance config', async (t) => {
  const f = fixture(t, { standalone: true })
  assert.equal(f.socketFactory.mock.callCount(), 0)
  assert.equal((await f.request(`${legacy}/discovery/toggle`, { body: { enabled: true } })).status, 200)
  f.restart()
  assert.equal(f.socketFactory.mock.callCount(), 2)
  await Promise.resolve()
  assert.equal((await f.request(`${legacy}/discovery/scan`)).body.discovery.enabled, true)
})
