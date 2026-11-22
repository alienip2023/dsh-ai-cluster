/**
 * NodeTransport audit fixes:
 *  - heartbeat: any inbound frame is liveness evidence, the timeout is configurable (default >= 3x the interval);
 *  - e2e handshake window: content frames wait for the session instead of leaving in plaintext (the hub now refuses those).
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { NodeTransport } from '../lib/node/transport.js'
import { E2E_MARKER, createSession, generateEphemeral } from '../lib/e2e.js'
import { HUB_TO_NODE, NODE_TO_HUB, PROTOCOL_VERSION, encodeFrame, envelope } from '../lib/protocol.js'

function fakeConn() {
  const conn = new EventEmitter()
  conn.closed = false
  conn.sent = []
  conn.pings = 0
  conn.destroyed = 0
  conn.send = (text) => { conn.sent.push(JSON.parse(text)); return true }
  conn.sendBinary = () => true
  conn.ping = () => { conn.pings += 1 }
  conn.destroy = () => { conn.destroyed += 1; conn.closed = true }
  conn.close = () => { conn.closed = true }
  return conn
}

function makeTransport(o = {}) {
  const tr = new NodeTransport({ mode: 'direct', url: 'ws://127.0.0.1:1/x', token: 't', hello: { nodeId: 'n1' }, e2e: true, ...o })
  tr.on('error', () => {})
  const conn = fakeConn()
  tr.conn = conn
  tr.online = true
  tr.attach(conn)
  return { tr, conn }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('HB-1: the default heartbeat timeout is at least 3x the interval, and it is configurable', () => {
  const a = makeTransport()
  assert.ok(a.tr.heartbeatTimeoutMs >= a.tr.heartbeatMs * 3)
  const b = makeTransport({ heartbeatMs: 40_000 })
  assert.ok(b.tr.heartbeatTimeoutMs >= 120_000, 'a longer interval widens the default timeout')
  const c = makeTransport({ heartbeatTimeoutMs: 1234 })
  assert.equal(c.tr.heartbeatTimeoutMs, 1234)
  const d = makeTransport({ heartbeatTimeoutMs: -5 })
  assert.ok(d.tr.heartbeatTimeoutMs >= 45_000, 'an invalid value falls back to the default')
})

test('HB-2: a link that keeps receiving business frames but no pong is not destroyed; a silent one is', async (t) => {
  const { tr, conn } = makeTransport({ heartbeatMs: 10, heartbeatTimeoutMs: 80 })
  t.after(() => tr.stop())
  tr.lastPongAt = Date.now()
  tr.startHeartbeat()
  // business frames from the hub every 20 ms for ~300 ms (almost 4x the timeout), never a pong
  const frame = encodeFrame(envelope(HUB_TO_NODE.TASK_QUERY, { taskId: 'x' }))
  for (let i = 0; i < 15; i++) {
    conn.emit('message', Buffer.from(frame), false)
    await sleep(20)
  }
  assert.equal(conn.destroyed, 0, 'inbound business frames kept the link alive')
  // now silence: the heartbeat must still catch a dead link
  await sleep(250)
  assert.equal(conn.destroyed, 1, 'a truly silent link is still destroyed')
})

test('HB-3: a WS pong still counts', async (t) => {
  const { tr, conn } = makeTransport({ heartbeatMs: 10, heartbeatTimeoutMs: 80 })
  t.after(() => tr.stop())
  tr.lastPongAt = Date.now()
  tr.startHeartbeat()
  for (let i = 0; i < 12; i++) { conn.emit('pong'); await sleep(20) }
  assert.equal(conn.destroyed, 0)
})

/* ───────────────────── e2e handshake window ───────────────────── */

function pairedSession() {
  const n = generateEphemeral()
  const h = generateEphemeral()
  return {
    node: createSession({ role: 'node', ownPrivB64: n.privateKeyB64, peerPubB64: h.publicKeyB64, nodePubB64: n.publicKeyB64, hubPubB64: h.publicKeyB64 }),
    hub: createSession({ role: 'hub', ownPrivB64: h.privateKeyB64, peerPubB64: n.publicKeyB64, nodePubB64: n.publicKeyB64, hubPubB64: h.publicKeyB64 }),
  }
}

test('HOLD-1: while an offer is in flight a content frame waits, then leaves sealed once the session exists', () => {
  const { tr, conn } = makeTransport()
  const pair = pairedSession()
  tr.e2eOffer = { nonce: 'n' } // offer sent, no ack yet
  assert.equal(tr.sendRaw(NODE_TO_HUB.TASK_SYNC, { tasks: [] }), true)
  assert.equal(tr.sendRaw(NODE_TO_HUB.BOT_TURN_RESULT, { text: 'answer' }), true)
  assert.equal(conn.sent.length, 0, 'nothing leaves in plaintext during the window')

  tr.e2e = pair.node
  tr.e2eOffer = null
  tr.flushE2EHold()
  assert.deepEqual(conn.sent.map((f) => f.t), [NODE_TO_HUB.TASK_SYNC, NODE_TO_HUB.BOT_TURN_RESULT], 'original order')
  for (const f of conn.sent) assert.equal(f.d.e2e, E2E_MARKER, 'sealed')
  const opened = pair.hub.openFrame(conn.sent[1].t, conn.sent[1].id, conn.sent[1].d)
  assert.equal(opened.text, 'answer')
})

test('HOLD-2: control frames are never held (the offer itself, pong, hello)', () => {
  const { tr, conn } = makeTransport()
  tr.e2eOffer = { nonce: 'n' }
  tr.sendRaw(NODE_TO_HUB.E2E_OFFER, { pub: 'p', nonce: 'n' })
  tr.sendRaw('pong', {})
  tr.sendRaw('hello', { nodeId: 'n1', protocol: PROTOCOL_VERSION })
  assert.deepEqual(conn.sent.map((f) => f.t), [NODE_TO_HUB.E2E_OFFER, 'pong', 'hello'])
})

test('HOLD-3: an offer that times out (old hub) releases the held frames in plaintext', () => {
  const { tr, conn } = makeTransport()
  tr.e2eOffer = { nonce: 'n' }
  tr.sendRaw(NODE_TO_HUB.TASK_SYNC, { tasks: [] })
  assert.equal(conn.sent.length, 0)
  tr.e2eOffer = null // what the offer timer does
  tr.flushE2EHold()
  assert.equal(conn.sent.length, 1)
  assert.equal(conn.sent[0].d.e2e, undefined)
})

test('HOLD-4: held frames of a dead connection are discarded loudly, and the queue is bounded', () => {
  const { tr } = makeTransport()
  const errors = []
  tr.on('error', (e) => errors.push(e.message))
  tr.e2eOffer = { nonce: 'n' }
  tr.E2E_HOLD_MAX = 3
  for (let i = 0; i < 5; i++) tr.sendRaw(NODE_TO_HUB.TASK_PROGRESS, { i })
  assert.equal(tr.e2eHold.length, 3)
  assert.equal(errors.filter((m) => /已丢弃最旧/.test(m)).length, 2, 'overflow is reported, not silent')
  tr.resetE2E()
  assert.equal(tr.e2eHold.length, 0)
  assert.ok(errors.some((m) => /排队帧已丢弃/.test(m)))
})

test('HOLD-5: no offer in flight and no session (e2e off or finished) -> frames go out immediately', () => {
  const { tr, conn } = makeTransport({ e2e: false })
  tr.sendRaw(NODE_TO_HUB.TASK_SYNC, { tasks: [] })
  assert.equal(conn.sent.length, 1)
})
