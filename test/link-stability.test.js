/**
 * The link between hub and node must not be cut because a node was busy:
 *  - the hub counts a WS pong / ping / any message as proof of life (it used to count application frames only);
 *  - a direct node may stay silent 8 heartbeats before it is cut (it was 4);
 *  - a tick that arrives late because the hub itself was stalled judges nobody;
 *  - a node whose own event loop stalled forgives the silence once and says so.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { NodeTransport } from '../lib/node/transport.js'

function fakeConn() {
  const conn = new EventEmitter()
  conn.closed = false
  conn.destroyed = 0
  conn.pings = 0
  conn.send = () => true
  conn.ping = () => { conn.pings += 1 }
  conn.destroy = () => { conn.destroyed += 1; conn.closed = true }
  conn.close = () => { conn.closed = true }
  return conn
}
function hubWith(conn, silentMs) {
  const registry = new NodeRegistry({ log: () => {}, limits: { heartbeatMs: 1000 } })
  registry.nodes.set('n1', { nodeId: 'n1', conn, online: true, lastSeen: Date.now() - silentMs, since: 0, tasks: new Map(), hello: { nodeId: 'n1', hostname: 'n1' } })
  return registry
}

test('LS-1: a direct node silent for 7 heartbeats stays, one silent for 9 is cut', (t) => {
  const quiet = fakeConn()
  const a = hubWith(quiet, 7_000)
  t.after(() => a.dispose())
  a.tick()
  assert.equal(quiet.destroyed, 0)
  const dead = fakeConn()
  const b = hubWith(dead, 9_000)
  t.after(() => b.dispose())
  b.tick()
  assert.equal(dead.destroyed, 1)
})

test('LS-2: a late timer tick (the hub was stalled) judges nobody', (t) => {
  const conn = fakeConn()
  const registry = hubWith(conn, 9_000)
  t.after(() => registry.dispose())
  registry.lastTickAt = Date.now() - 30_000   // the previous timer tick was 30 s ago: this process stalled
  registry.tick({ fromTimer: true })
  assert.equal(conn.destroyed, 0, 'no node is cut on a round that came late')
  assert.equal(conn.pings, 1, 'it is still pinged')
  registry.tick({ fromTimer: true })
  assert.equal(conn.destroyed, 1, 'the next, on-time round judges as usual')
})

test('LS-3: a WS pong, ping or message from the connection refreshes the node\'s lastSeen', (t) => {
  const registry = new NodeRegistry({ log: () => {}, limits: { heartbeatMs: 1000 } })
  t.after(() => registry.dispose())
  const conn = fakeConn()
  registry.attachDirect(conn, { remote: 'test' })
  // the first frame names the node; reproduce what a finished handshake leaves behind
  const pendingNode = { nodeId: 'n1', conn, online: true, lastSeen: 1, since: 0, tasks: new Map(), hello: { nodeId: 'n1' }, transport: 'direct' }
  registry.nodes.set('n1', pendingNode)
  const [pending] = [...registry.pending]
  pending.nodeId = 'n1'
  for (const event of ['pong', 'ping']) {
    pendingNode.lastSeen = 1
    conn.emit(event)
    assert.ok(Date.now() - pendingNode.lastSeen < 1000, `${event} counts as alive`)
  }
  pendingNode.lastSeen = 1
  conn.emit('message', Buffer.from('not a frame'), false)
  assert.ok(Date.now() - pendingNode.lastSeen < 1000, 'any message counts as alive, even one that does not decode')
  // a connection that is no longer the node's current one does not keep it alive
  pendingNode.conn = fakeConn()
  pendingNode.lastSeen = 1
  conn.emit('pong')
  assert.equal(pendingNode.lastSeen, 1)
})

test('LS-4: the node default timeout is 6 heartbeats, and a stalled event loop is forgiven once', async (t) => {
  const tr = new NodeTransport({ mode: 'direct', url: 'ws://127.0.0.1:1/x', token: 't', hello: { nodeId: 'n1' }, heartbeatMs: 20, heartbeatTimeoutMs: 100 })
  tr.on('error', () => {})
  assert.equal(new NodeTransport({ mode: 'direct', url: 'ws://127.0.0.1:1/x', token: 't', hello: { nodeId: 'n1' } }).heartbeatTimeoutMs, 90_000)
  const conn = fakeConn()
  tr.conn = conn
  tr.online = true
  tr.attach(conn)
  t.after(() => tr.stop())
  const stalls = []
  tr.on('stall', info => stalls.push(info))
  tr.lastPongAt = Date.now()
  tr.startHeartbeat()
  // block this very event loop longer than the timeout: the pong that would prove life is queued behind it
  const until = Date.now() + 250
  while (Date.now() < until) { /* busy */ }
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(conn.destroyed, 0, 'silence caused by our own stall is not a dead link')
  assert.ok(stalls.length >= 1 && stalls[0].lagMs > 100, 'the stall is reported')
})
