import test from 'node:test'
import assert from 'node:assert/strict'
import { createReconnectGate, duplicateBackoffMs } from '../../src/link/backoff.js'
import { NodeTransport, TRANSPORT_MODE } from '../../src/link/transport.js'
import { duplicateBackoffMs as oldBackoff, resolveDuplicateRetry as oldResolve } from '../../lib/node/transport.js'
import { resolveDuplicateRetry } from '../../src/link/backoff.js'

test('claim() 第一次 true，第二次 false，release 后再 true', () => {
  const gate = createReconnectGate({})
  assert.equal(gate.claim(), true)
  assert.equal(gate.claim(), false)
  gate.release()
  assert.equal(gate.claim(), true)
})

test('重复的连接尝试被闸门挡住：只拨一次', async () => {
  let dials = 0
  const trust = new Proxy({}, { get: () => () => {} })
  trust.E2E_MARKER = 1
  const tr = new NodeTransport({
    mode: TRANSPORT_MODE.DIRECT, url: 'ws://127.0.0.1:1/x', hello: { nodeId: 'n1' }, e2e: false, trust,
    connectFn: () => { dials += 1; return new Promise(() => {}) }, // 永不 resolve：在途
  })
  void tr.connectOnce()
  void tr.connectOnce()
  void tr.connectOnce()
  await new Promise((r) => setImmediate(r))
  assert.equal(dials, 1, '在途时再次 connectOnce 不得再拨号')
  assert.equal(tr.connecting, true)
})

test('duplicateBackoffMs / resolveDuplicateRetry 与旧 lib 输出相等', () => {
  for (const n of [0, 1, 2, 3, 5, 6, 7, 40, 2.7]) assert.equal(duplicateBackoffMs(n), oldBackoff(n))
  for (const r of [undefined, {}, { baseMs: 5, maxMs: 2, totalMs: 9e9 }, { baseMs: '1' }, { totalMs: 3_600_000 }]) {
    assert.deepEqual(resolveDuplicateRetry(r), oldResolve(r))
  }
  assert.equal(createReconnectGate({ retry: { baseMs: 20, maxMs: 40 } }).wait(3), 40)
})
