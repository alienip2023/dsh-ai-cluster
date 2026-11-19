import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { generateEphemeral } from '../../lib/e2e.js'
import { NodeRegistry } from '../../lib/hub/node-registry.js'
import { generateIdentity } from '../../lib/identity.js'
import { createPeerRouter, PeerLink } from '../../lib/node/peer-link.js'
import { PEER, PROTOCOL_VERSION, encodeFrame, envelope } from '../../lib/protocol.js'
import { UI_API_PREFIX } from '../../lib/plugin/http/prefix.js'
import { registerUiRoutes } from '../../lib/plugin/http/routes.js'
import { makeCtx } from './_plugin-ctx.js'

async function openPeer(t) {
  const nodeId = 'pc-direct'
  const url = 'ws://localhost/peer'
  const heartbeatMs = 15000
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100000 })
  const conn = new EventEmitter()
  let sends = 0
  let pings = 0
  let connects = 0
  conn.send = () => {
    sends++
    const { publicKeyB64 } = generateEphemeral()
    conn.emit('message', encodeFrame(envelope(PEER.WELCOME, { nodeId, pub: publicKeyB64 })), false)
    return true
  }
  conn.ping = () => { pings++; return true }
  conn.destroy = () => { conn.closed = true; conn.emit('close') }
  const link = new PeerLink({
    nodeId: '@hub', remoteNodeId: nodeId, url, secret: 'secret', heartbeatMs,
    connectFn() { connects++; return conn },
  })
  const fail = () => assert.fail('an RTT read must not send or create a link')
  const router = createPeerRouter({ nodeId: '@hub', makeLink: fail, fallback: fail })
  t.after(() => router.stop())
  router.directory([{ nodeId, url }])
  assert.equal(router.rttOf(nodeId), null)
  assert.equal(router.adopt(nodeId, link), true)
  assert.equal(router.rttOf(nodeId), null)
  assert.deepEqual([connects, sends, pings], [0, 0, 0])
  await link.ready()
  return { nodeId, conn, router, heartbeatMs, counts: () => [connects, sends, pings] }
}

function registerReadRoutes(t, registry) {
  const ctx = makeCtx()
  const routes = new Map()
  ctx.webServer = { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } }
  const dispose = registerUiRoutes({ ctx, registry, pulls: { activeCount: 0 }, log() {}, config: { role: 'hub', stateDir: ctx.stateDir } })
  t.after(() => { for (const fn of dispose) fn(); ctx.cleanup() })
  return async (path) => {
    const pathname = UI_API_PREFIX + path
    let body
    await routes.get(pathname).handler({ method: 'GET', url: pathname, headers: {} }, {
      writeHead(status) { assert.equal(status, 200) },
      end(raw) { body = JSON.parse(raw) },
    })
    return body.nodes
  }
}

test('RTT-15 ignores welcome zero', async (t) => {
  const { nodeId, router, counts } = await openPeer(t)
  assert.equal(router.rttOf(nodeId), 0)
  assert.equal(router.frameRttOf(nodeId).length, 0, 'RTT-15: welcome value is not a sample')
  assert.deepEqual(counts(), [1, 1, 0])
})

test('RTT-15 caps at 30', async (t) => {
  const { nodeId, conn, router, heartbeatMs, counts } = await openPeer(t)
  let last = 0
  for (let ms = 1; ms <= 45; ms++) {
    t.mock.timers.tick(heartbeatMs - last)
    t.mock.timers.tick(ms)
    conn.emit('pong')
    last = ms
  }
  const expected = Array.from({ length: 30 }, (_, i) => i + 16)
  const samples = router.frameRttOf(nodeId)
  assert.deepEqual(samples, expected, 'RTT-15: ring capped at 30')
  samples.length = 0
  assert.equal(router.rttOf(nodeId), 45)

  const registry = new NodeRegistry({ identity: generateIdentity(), e2eHeal: { maxAttempts: 0 } })
  t.after(() => registry.dispose())
  registry.ingestHello({
    helloData: { nodeId, protocol: PROTOCOL_VERSION, os: 'linux', transportMode: 'direct' },
    transport: 'direct', conn: { send() { return true }, close() {} },
  })
  registry.peerRouter = router
  const read = registerReadRoutes(t, registry)
  for (const path of ['/node-status', '/overview']) {
    const [row] = await read(path)
    assert.deepEqual(row.frameRttMs, expected)
    assert.equal(row.confirm, 'confirmed')
    assert.equal(Object.hasOwn(row, 'identity'), false)
  }
  assert.deepEqual(counts(), [1, 1, 45])
})
