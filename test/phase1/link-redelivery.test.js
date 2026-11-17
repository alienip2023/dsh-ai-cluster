import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { NodeTransport, TRANSPORT_MODE } from '../../src/link/transport.js'
import { createFrameDeduper } from '../../src/link/dedupe.js'
import { encodeFrame, envelope } from '../../src/wire/index.js'

class FakeConn extends EventEmitter {
  closed = false
  send() { return true }
  sendBinary() { return true }
  ping() { return true }
  close() { this.closed = true; this.emit('close', 1000, '') }
  destroy() { this.close() }
}

function make(extra = {}) {
  const trust = new Proxy({}, { get: () => () => {} })
  trust.E2E_MARKER = 1
  trust.newNonce = () => 'n'
  trust.normalizeFingerprint = () => ''
  const conns = []
  const tr = new NodeTransport({
    mode: TRANSPORT_MODE.RELAY, url: 'ws://127.0.0.1:1/relay', hello: { nodeId: 'n1' }, e2e: false, trust,
    connectFn: async () => { const c = new FakeConn(); conns.push(c); return c }, ...extra,
  })
  return { tr, conns }
}
const tick = () => new Promise((r) => setImmediate(r))
const deliver = (conn, frame) => conn.emit('message', Buffer.from(encodeFrame(frame)), false)

test('投递 → 断线 → 重连 → 重放同一 id：接收方只计 1 次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { tr, conns } = make()
  const got = []
  tr.on('frame', (f) => got.push(f.id))
  tr.on('error', () => {})
  tr.start(); await tick()
  assert.equal(conns.length, 1)
  const frame = envelope('task/query', { taskId: 'x' })
  deliver(conns[0], frame)
  assert.deepEqual(got, [frame.id])

  conns[0].close() // 断线 → scheduleReconnect
  t.mock.timers.tick(3000) // 越过退避（1s + ≤20% 抖动）
  await tick()
  assert.equal(conns.length, 2, '已重连到新连接')
  deliver(conns[1], frame) // 重放同一 id
  assert.equal(got.length, 1, '同一 frame id 不得交付两次')

  deliver(conns[1], envelope('task/query', { taskId: 'y' }))
  assert.equal(got.length, 2, '新 id 正常交付')
  tr.stop()
})

test('deduper：有界且按 ttl 过期', () => {
  let now = 0
  const d = createFrameDeduper({ maxIds: 2, ttlMs: 100, now: () => now })
  assert.equal(d.seen('a'), false); assert.equal(d.seen('a'), true)
  d.seen('b'); d.seen('c')
  assert.equal(d.size, 2); assert.equal(d.seen('a'), false, '最旧的被挤出')
  now = 500
  assert.equal(d.seen('c'), false, 'ttl 过期后可再交付')
})
