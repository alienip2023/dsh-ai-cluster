// AC 0.4.40 — node ↔ node direct links for the reliable link (docs/reliable-link.md §直连).
//
// REL-P1..P7: the routing rules, on the real reliable link and the real hub ingest, with the direct links stood in for
// by an in-memory mesh (each pair up or down at will). REL-P8..P9: the pair-key handshake on real sockets.
// REL-P10: two assembled workers and a real hub over TCP, direct links on by default, then the hub goes away.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { createHubBotNetwork } from '../lib/hub/bot-network.js'
import { createBotNetwork } from '../lib/node/bot-network.js'
import { createFrameDispatcher } from '../lib/node/dispatch.js'
import { attachHubReliable, attachNodeReliable } from '../lib/reliable-wire.js'
import { PeerLink } from '../lib/node/peer-link.js'
import { startPeerListener, peerHostToward } from '../lib/node/peer-listener.js'
import { createPairKeyStore, helloProof, loadPeerBook } from '../lib/node/peer-auth.js'
import { generateIdentity } from '../lib/identity.js'
import { generateEphemeral } from '../lib/e2e.js'
import { PEER, PROTOCOL_VERSION, encodeFrame, envelope } from '../lib/protocol.js'
import { startListenServer } from '../lib/listen-server.js'
import { applyWorker } from '../lib/node/index.js'
import { NodeTransport } from '../lib/node/transport.js'

const settle = async () => { for (let i = 0; i < 16; i += 1) await new Promise(r => setImmediate(r)) }
async function until(predicate, message = 'condition', timeoutMs = 5000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// The hub as in reliable-integration.test.js, plus a mesh of direct links between the nodes.
function cluster() {
  const registry = new NodeRegistry({ log() {} })
  registry.e2eReady = nodeId => registry.nodes.get(nodeId)?.online === true
  const hubNet = createHubBotNetwork({ registry, ctx: { get: () => undefined } })
  const detachHub = attachHubReliable({ registry, network: hubNet })
  const nodes = {}
  const pairs = new Map()        // 'a>b' → 'connected' | 'connecting' | 'down'
  const dropAcks = new Set()     // 'b>a': acks b sends straight to a are lost
  const hubFrames = []           // rel frames a node sent to the hub: [from, to]
  const routes = []
  const stateOf = (from, to) => pairs.get(`${from}>${to}`) ?? 'down'
  const setPair = (a, b, state) => {
    pairs.set(`${a}>${b}`, state); pairs.set(`${b}>${a}`, state)
    if (state === 'connected') { nodes[a]?.rel.peerReady(b); nodes[b]?.rel.peerReady(a) }
  }
  function peersFor(nodeId) {
    return {
      relState: to => (nodes[to]?.direct === true ? stateOf(nodeId, to) : 'none'),
      sendRel: (to, type, data) => {
        if (stateOf(nodeId, to) !== 'connected') return false
        if (type === 'rel/ack' && dropAcks.has(`${nodeId}>${to}`)) return true
        queueMicrotask(() => nodes[to]?.rel.receivePeer(nodeId, type, structuredClone(data)))
        return true
      },
      noteRoute: (to, via) => routes.push([nodeId, to, via]),
    }
  }
  function addNode(nodeId, { direct = true, stateDir } = {}) {
    const transport = new EventEmitter()
    transport.online = true
    const network = createBotNetwork({ nodeId })
    const send = (type, data) => {
      if (!transport.online) return false
      if (type === 'rel/frame') hubFrames.push([nodeId, data.to ?? 'hub', data.rid])
      queueMicrotask(() => registry.handleFrameFor(nodeId, { v: 1, t: type, id: 'x', d: structuredClone(data) }))
      return true
    }
    const dispatch = createFrameDispatcher({ network, send, sendError() {}, logger: {}, ctx: undefined })
    const rel = attachNodeReliable({ nodeId, transport, send, network, stateDir, ...(direct ? { peers: peersFor(nodeId) } : {}) })
    registry.nodes.set(nodeId, { nodeId, online: true, tasks: new Map(), hello: {}, conn: { closed: false, send: text => { if (!transport.online) throw new Error('closed'); const f = JSON.parse(text); queueMicrotask(() => dispatch(f, f.d)) } } })
    nodes[nodeId] = { transport, network, rel, direct }
    return nodes[nodeId]
  }
  const hubDown = () => { for (const [id, n] of Object.entries(nodes)) { n.transport.online = false; registry.nodes.get(id).online = false } }
  const hubBack = () => {
    for (const [id, n] of Object.entries(nodes)) {
      n.transport.online = true; registry.nodes.get(id).online = true
      registry.emit('e2eEstablished', { nodeId: id }); n.transport.emit('e2e', 'ok')
    }
  }
  return { registry, hubNet, nodes, addNode, setPair, dropAcks, hubFrames, routes, hubDown, hubBack,
    detach: () => { detachHub(); for (const n of Object.values(nodes)) n.rel() } }
}

test('REL-P1 node → node goes straight over the direct link; the hub sees none of it', async t => {
  const c = cluster(); t.after(c.detach)
  const a = c.addNode('a')
  const b = c.addNode('b')
  c.setPair('a', 'b', 'connected')
  const got = []
  b.network.onReliable('work/handoff', m => { got.push(m) })
  a.network.post('work/handoff', { id: 'w-1' }, { to: 'b' })
  await settle()
  assert.deepEqual(got.map(m => [m.from, m.data.id]), [['a', 'w-1']])
  assert.deepEqual(c.hubFrames, [], 'nothing went to the hub')
  assert.deepEqual(a.network.reliablePending(), [], 'acked over the direct link')
  assert.deepEqual(c.routes, [['a', 'b', 'direct']])
})

test('REL-P2 no direct link: through the hub at once; a link that never comes up: through the hub after 10 s', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 })
  const c = cluster(); t.after(c.detach)
  const a = c.addNode('a')
  const b = c.addNode('b')
  const got = []
  b.network.onReliable('work/handoff', m => { got.push(m) })
  // down (dialed lately, failed): the hub forwards it, and b is told it is from a
  a.network.post('work/handoff', { id: 'w-down' }, { to: 'b' })
  await settle()
  assert.deepEqual(got.map(m => [m.from, m.data.id]), [['a', 'w-down']])
  assert.deepEqual(c.hubFrames.map(f => f.slice(0, 2)), [['a', 'b']])
  assert.deepEqual(a.network.reliablePending(), [])
  // connecting: it waits for the link, then gives up on it and goes through the hub
  c.setPair('a', 'b', 'connecting')
  a.network.post('work/handoff', { id: 'w-slow' }, { to: 'b' })
  await settle()
  assert.equal(got.length, 1, 'waits while the link comes up')
  t.mock.timers.tick(5_000); await settle()
  assert.equal(got.length, 1, 'still within 10 s')
  t.mock.timers.tick(5_000); await settle()
  assert.deepEqual(got.map(m => m.data.id), ['w-down', 'w-slow'])
  assert.deepEqual(a.network.reliablePending(), [])
  // connecting, then up within the 10 s: it goes direct the moment the link is there
  a.network.post('work/handoff', { id: 'w-quick' }, { to: 'b' })
  await settle()
  c.setPair('a', 'b', 'connected'); await settle()
  assert.deepEqual(got.map(m => m.data.id), ['w-down', 'w-slow', 'w-quick'])
  assert.deepEqual(c.routes.at(-1), ['a', 'b', 'direct'])
})

test('REL-P3 the direct ack is lost: the resend goes through the hub, b handles it once, a is settled by the hub', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 2_000_000 })
  const c = cluster(); t.after(c.detach)
  const a = c.addNode('a')
  const b = c.addNode('b')
  c.setPair('a', 'b', 'connected')
  c.dropAcks.add('b>a')
  let handled = 0
  b.network.onReliable('work/result', () => { handled += 1 })
  a.network.post('work/result', { id: 'r-1' }, { to: 'b' })
  await settle()
  assert.equal(handled, 1)
  assert.equal(a.network.reliablePending().length, 1, 'no ack came back yet')
  t.mock.timers.tick(10_000); await settle()
  assert.equal(handled, 1, 'the copy through the hub is not handled again')
  assert.deepEqual(c.hubFrames.map(f => f.slice(0, 2)), [['a', 'b']])
  assert.deepEqual(a.network.reliablePending(), [], 'the hub acked it')
  assert.deepEqual(c.hubNet.reliablePending(), [], 'b acked the hub too')
})

test('REL-P4 the hub is down: node ↔ node work goes on over the direct link', async t => {
  const c = cluster(); t.after(c.detach)
  const a = c.addNode('a')
  const b = c.addNode('b')
  c.setPair('a', 'b', 'connected')
  c.hubDown()
  const got = []
  b.network.onReliable('work/handoff', m => { got.push(m) })
  a.network.onReliable('work/result', m => { got.push(m) })
  a.network.post('work/handoff', { id: 'w-1' }, { to: 'b' })
  await settle()
  b.network.post('work/result', { id: 'w-1' }, { to: 'a' })
  await settle()
  assert.deepEqual(got.map(m => [m.type, m.from]), [['work/handoff', 'a'], ['work/result', 'b']])
  assert.deepEqual(a.network.reliablePending(), [])
  assert.deepEqual(b.network.reliablePending(), [])
  assert.deepEqual(c.hubFrames, [])
})

test('REL-P5 hub down and no direct link: it waits with no clock, and goes by whichever way comes back first', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 3_000_000 })
  const c = cluster(); t.after(c.detach)
  const a = c.addNode('a')
  const b = c.addNode('b')
  c.hubDown()
  const got = []
  b.network.onReliable('work/handoff', m => { got.push(m) })
  a.network.post('work/handoff', { id: 'w-direct' }, { to: 'b' })
  a.network.post('work/handoff', { id: 'w-hub' }, { to: 'b' })
  t.mock.timers.tick(60 * 60_000); await settle()
  assert.equal(got.length, 0)
  assert.equal(a.network.reliablePending().length, 2, 'kept, however long')
  c.setPair('a', 'b', 'connected'); await settle()
  assert.deepEqual(got.map(m => m.data.id).sort(), ['w-direct', 'w-hub'])
  assert.deepEqual(a.network.reliablePending(), [])
  // and the other way round: the direct link stays down, the hub comes back
  c.setPair('a', 'b', 'down')
  a.network.post('work/handoff', { id: 'w-later' }, { to: 'b' })
  c.hubBack(); await settle()
  assert.deepEqual(got.map(m => m.data.id).sort(), ['w-direct', 'w-hub', 'w-later'])
})

test('REL-P6 a node restarts with a message still unsent: it goes out once a way is up', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-p6-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const c = cluster(); t.after(c.detach)
  c.addNode('a', { stateDir: dir })
  const b = c.addNode('b')
  c.hubDown()
  c.nodes.a.network.post('work/handoff', { id: 'w-1' }, { to: 'b' })
  await settle()
  c.nodes.a.rel()            // the process goes
  const again = c.addNode('a', { stateDir: dir })
  again.transport.online = false
  c.registry.nodes.get('a').online = false
  const got = []
  b.network.onReliable('work/handoff', m => { got.push(m) })
  c.setPair('a', 'b', 'connected'); await settle()
  assert.deepEqual(got.map(m => [m.from, m.data.id]), [['a', 'w-1']])
  assert.deepEqual(again.network.reliablePending(), [])
})

test('REL-P7 a frame straight from a node is from that node, whatever it says; only the hub names another sender', async t => {
  const c = cluster(); t.after(c.detach)
  const b = c.addNode('b')
  const got = []
  b.network.onReliable('work/handoff', m => { got.push(m) })
  b.rel.receivePeer('c', 'rel/frame', { rid: 'spoof-1', type: 'work/handoff', data: { id: 'x' }, from: 'a' })
  b.rel.receivePeer('c', 'rel/frame', { rid: 'spoof-2', type: 'work/handoff', data: { id: 'y' }, to: 'd' })
  await settle()
  assert.deepEqual(got.map(m => [m.from, m.data.id]), [['c', 'x'], ['c', 'y']], 'not forwarded, not passed off as a')
  assert.deepEqual(c.hubNet.reliablePending(), [])
})

test('REL-P7b a node without direct links (an older node) still reaches and is reached through the hub', async t => {
  const c = cluster(); t.after(c.detach)
  const a = c.addNode('a')
  const old = c.addNode('old', { direct: false })
  const got = []
  old.network.onReliable('work/handoff', m => { got.push(m) })
  a.network.onReliable('work/result', m => { got.push(m) })
  a.network.post('work/handoff', { id: 'w-1' }, { to: 'old' })
  await settle()
  old.network.post('work/result', { id: 'w-1' }, { to: 'a' })
  await settle()
  assert.deepEqual(got.map(m => [m.type, m.from]), [['work/handoff', 'a'], ['work/result', 'old']])
  assert.deepEqual(c.hubFrames.map(f => f.slice(0, 2)), [['a', 'old'], ['old', 'a']])
})

// ── the handshake, on real sockets ──

const K_AB = 'ab'.repeat(32)
const K_BC = 'bc'.repeat(32)
const keysOfB = { a: K_AB, c: K_BC }

async function listenerB(t, keys = keysOfB) {
  const received = []
  const listener = await startPeerListener({ nodeId: 'b', host: '127.0.0.1', port: 0, getSecret: () => '', getPairKey: id => keys[id],
    onFrame: (frame, reply, peerId) => received.push([peerId, frame.t, frame.d]) })
  t.after(() => listener.close())
  return { listener, received }
}

test('REL-P8 only the holder of the pair key gets in, as the node of that key; the listener has to prove it too', async t => {
  const { listener, received } = await listenerB(t)
  // a with the (a, b) key: in, and reliable frames may cross
  const a = new PeerLink({ nodeId: 'a', remoteNodeId: 'b', url: listener.url, pairKey: K_AB })
  t.after(() => a.stop())
  await a.ready()
  assert.equal(a.sendNow('rel/frame', { rid: 'r1', type: 'test/x', data: {} }), true)
  await until(() => received.length === 1, 'rel frame in')
  assert.deepEqual(received[0].slice(0, 2), ['a', 'rel/frame'])
  // c holds the (b, c) key and claims to be a: refused
  const posing = new PeerLink({ nodeId: 'a', remoteNodeId: 'b', url: listener.url, pairKey: K_BC })
  t.after(() => posing.stop())
  await assert.rejects(posing.ready())
  // the old way (a secret in the clear) no longer lets a node in
  const legacy = new PeerLink({ nodeId: 'a', remoteNodeId: 'b', url: listener.url, secret: K_AB })
  t.after(() => legacy.stop())
  await assert.rejects(legacy.ready())
  // a listener that does not hold the key cannot answer for b
  const { listener: fake } = await listenerB(t, { a: 'ee'.repeat(32) })
  const fooled = new PeerLink({ nodeId: 'a', remoteNodeId: 'b', url: fake.url, pairKey: K_AB })
  t.after(() => fooled.stop())
  await assert.rejects(fooled.ready())
  assert.equal(received.length, 1)
})

test('REL-P8c a listener that takes any hello but cannot prove the key is not trusted as b', async t => {
  const server = await startListenServer({ host: '127.0.0.1', port: 0, path: '/api/remote-agent/peer',
    onUpgrade: conn => conn.on('message', () => {
      conn.send(encodeFrame(envelope(PEER.WELCOME, { nodeId: 'b', time: Date.now(), pub: generateEphemeral().publicKeyB64, proof: 'ff'.repeat(32) })))
    }) })
  t.after(() => server.close())
  const link = new PeerLink({ nodeId: 'a', remoteNodeId: 'b', url: `ws://127.0.0.1:${server.port}/api/remote-agent/peer`, pairKey: K_AB })
  t.after(() => link.stop())
  await assert.rejects(link.ready())
  assert.notEqual(link.state, 'connected')
})

test('REL-P8b a stale hello is refused, and the key never crosses the wire', async t => {
  const { listener } = await listenerB(t)
  const { connect } = await import('../lib/ws.js')
  const conn = await connect(listener.url, { timeoutMs: 1000, name: 'stale' })
  const frames = []
  conn.on('message', raw => frames.push(JSON.parse(raw)))
  const time = Date.now() - 10 * 60_000
  const pub = generateEphemeral().publicKeyB64
  conn.send(encodeFrame(envelope(PEER.HELLO, { nodeId: 'a', protocol: PROTOCOL_VERSION, time, pub, proof: helloProof(K_AB, { from: 'a', to: 'b', time, pub }) })))
  await until(() => frames.length > 0, 'answer')
  assert.equal(frames[0].d.code, 'peer-auth-failed')
  const sent = []
  const link = new PeerLink({ nodeId: 'a', remoteNodeId: 'b', url: listener.url, pairKey: K_AB })
  t.after(() => link.stop())
  link.connectFn = async (...args) => { const c = await connect(...args); const send = c.send.bind(c); c.send = raw => { sent.push(String(raw)); return send(raw) }; return c }
  await link.ready()
  assert.equal(sent.some(raw => raw.includes(K_AB)), false)
})

test('REL-P9 the hub makes one key per pair, keeps it, and destroys every key of a revoked node', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-p9-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'keys.json')
  const store = createPairKeyStore(file)
  const ab = store.keyOf('a', 'b')
  assert.equal(store.keyOf('b', 'a'), ab, 'one key per pair')
  const ac = store.keyOf('a', 'c')
  assert.notEqual(ac, ab)
  store.keyOf('b', 'c')
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600')
  assert.equal(createPairKeyStore(file).keyOf('a', 'b'), ab, 'kept across a restart')
  store.forget('a')
  assert.equal(store.size(), 1)
  assert.notEqual(createPairKeyStore(file).keyOf('a', 'b'), ab, 'a gets a new key if it comes back')
})

test('the listen address faces the hub: the address on the hub\'s /24', () => {
  const candidates = [{ address: '192.168.5.9' }, { address: '10.0.0.47' }, { address: '100.64.1.2' }]
  assert.equal(peerHostToward('ws://10.0.0.90:19387/api/remote-agent/node', candidates), '10.0.0.47')
  assert.equal(peerHostToward('ws://hub.local:19387/x', candidates), '')
  assert.equal(peerHostToward('ws://172.16.0.1:1/x', candidates), '')
})

// ── assembled: a real hub and two workers over TCP ──

test('REL-P10 two workers with default settings: work goes direct, keeps going with the hub gone, books are 0600', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-p10-'))
  const transports = new Map()
  const originalOn = NodeTransport.prototype.on
  t.mock.method(NodeTransport.prototype, 'on', function (...args) { transports.set(this.hello.nodeId, this); return originalOn.apply(this, args) })
  const registry = new NodeRegistry({ identity: generateIdentity(), log() {}, stateDir: path.join(root, 'hub') })
  const hubRel = []
  const ingest = registry.handleFrameFor.bind(registry)
  registry.handleFrameFor = (nodeId, frame, ...rest) => { if (frame?.t === 'rel/frame') hubRel.push(nodeId); return ingest(nodeId, frame, ...rest) }
  const sockets = new Set()
  const hub = await startListenServer({ host: '127.0.0.1', port: 0, path: '/api/remote-agent/node',
    onUpgrade: conn => { sockets.add(conn); registry.attachDirect(conn) } })
  const botHub = createHubBotNetwork({ registry, ctx: { get: () => undefined } })
  const detachHubRel = attachHubReliable({ registry, network: botHub, stateDir: path.join(root, 'hub') })
  const contexts = {}
  const disposers = []
  const quiet = { info() {}, debug() {}, warn() {}, error() {} }
  let hubOpen = true
  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose()
    detachHubRel(); botHub.dispose(); registry.dispose()
    if (hubOpen) await hub.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const nodeId of ['a', 'b']) {
    const services = new Map()
    services.set('webServer', { register() {} })
    const ctx = { logger: quiet, get: key => services.get(key), provide: (key, value) => services.set(key, value), set: (key, value) => services.set(key, value) }
    contexts[nodeId] = ctx
    // peerDirect is not set: on by default
    disposers.push(applyWorker(ctx, { nodeId, transportMode: 'direct', hubUrl: `ws://127.0.0.1:${hub.port}/api/remote-agent/node`,
      stateDir: path.join(root, nodeId), roots: [root], peerListenHost: '127.0.0.1', peerListenPort: 0, resourceIntervalMs: 0, reposIntervalMs: 0,
      connectivityProbe: false }))
  }
  await until(() => transports.size === 2 && [...transports.values()].every(tr => tr.e2e), 'hub E2E')
  await until(() => ['a', 'b'].every(id => loadPeerBook(path.join(root, id, 'peers.json')).credentials.length === 1), 'books with pair keys')
  for (const id of ['a', 'b']) assert.equal((fs.statSync(path.join(root, id, 'peers.json')).mode & 0o777).toString(8), '600')
  const netA = contexts.a.get('remote-agent:bot-network')
  const netB = contexts.b.get('remote-agent:bot-network')
  const got = []
  netB.onReliable('test/echo', m => { got.push([m.from, m.data.n]) })
  netA.post('test/echo', { n: 1 }, { to: 'b' })
  await until(() => got.length === 1, 'direct delivery')
  assert.deepEqual(got, [['a', 1]])
  await until(() => netA.reliablePending().length === 0, 'acked')
  assert.deepEqual(hubRel, [], 'the hub carried none of it')
  const route = contexts.a.get('remote-agent:peer-direct').snapshot().peers.find(p => p.nodeId === 'b')
  assert.equal(route.state, 'connected')
  assert.equal(route.routes.direct, 1)
  // the hub goes away
  await hub.close(); hubOpen = false
  for (const conn of sockets) conn.destroy?.()
  await until(() => [...transports.values()].every(tr => tr.online !== true), 'workers see the hub gone')
  netA.post('test/echo', { n: 2 }, { to: 'b' })
  await until(() => got.length === 2, 'direct delivery with the hub gone')
  assert.deepEqual(got[1], ['a', 2])
})
