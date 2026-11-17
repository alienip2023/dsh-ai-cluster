import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOffer, encodeOffer, decodeOffer, createPeerTable, createDiscovery,
  normalizeDiscoveryConfig, DISCOVERY_SERVICE,
} from '../lib/discovery.js'

const base = { node: 'a', hostname: '10.0.0.1', port: 19387, role: 'hub', pluginVersion: '0.1.0' }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('1 编解码：往返一致；缺字段/坏 JSON 被忽略；不带密钥', () => {
  const offer = buildOffer(base)
  assert.deepEqual(Object.keys(offer).sort(), ['hostname', 'node', 'pairRequired', 'pluginVersion', 'port', 'role', 'service', 'type', 'v'])
  assert.equal(offer.pairRequired, true)
  assert.deepEqual(decodeOffer(encodeOffer(offer)), base)
  assert.equal(decodeOffer(Buffer.from('{not json')), null)
  for (const k of ['node', 'hostname', 'port', 'role', 'pluginVersion']) {
    const o = { ...offer }; delete o[k]
    assert.equal(decodeOffer(encodeOffer(o)), null, `缺 ${k}`)
  }
  assert.equal(decodeOffer(Buffer.from('[]')), null)
})

test('2 过滤：service 不对 / >4KB / groupKey 不匹配', () => {
  const offer = buildOffer(base)
  assert.equal(decodeOffer(encodeOffer({ ...offer, service: 'dsh-mesh' })), null)
  const big = encodeOffer({ ...offer, node: 'x', pad: 'y'.repeat(5000) })
  assert.ok(big.length > 4096)
  assert.equal(decodeOffer(big), null)
  // 对端带 key、本端没配 → 不要求 proof，接受；
  // 本端配了 key：无 proof / 错 key → 拒绝；对 key → 接受
  const keyed = buildOffer({ ...base, groupKey: 'k1' })
  assert.ok(decodeOffer(encodeOffer(keyed), { groupKey: 'k1' }))
  assert.equal(decodeOffer(encodeOffer(keyed), { groupKey: 'k2' }), null)
  assert.equal(decodeOffer(encodeOffer(offer), { groupKey: 'k1' }), null)
  assert.ok(decodeOffer(encodeOffer(offer), { groupKey: '' }))
  // 篡改身份字段 → proof 失效
  assert.equal(decodeOffer(encodeOffer({ ...keyed, hostname: '6.6.6.6' }), { groupKey: 'k1' }), null)
})

test('3 过期：intervalMs*3 后消失；有刷新则保留', () => {
  let t = 1000
  const tbl = createPeerTable({ intervalMs: 100, now: () => t })
  tbl.upsert({ ...base, node: 'p1' })
  tbl.upsert({ ...base, node: 'p2' })
  t += 200
  tbl.upsert({ ...base, node: 'p2' }) // 刷新 p2
  t += 150 // p1 距今 350 > 300；p2 距今 150
  const names = tbl.list().map((p) => p.node)
  assert.deepEqual(names, ['p2'])
  t += 400
  assert.equal(tbl.list().length, 0)
})

test('3b peers 按 at 倒序，含 at/role/port/pluginVersion', () => {
  let t = 0
  const tbl = createPeerTable({ intervalMs: 1000, now: () => t })
  t = 1; tbl.upsert({ ...base, node: 'old' })
  t = 2; tbl.upsert({ ...base, node: 'new', role: 'node' })
  const l = tbl.list()
  assert.deepEqual(l.map((p) => p.node), ['new', 'old'])
  assert.deepEqual(Object.keys(l[0]).sort(), ['at', 'hostname', 'node', 'pluginVersion', 'port', 'role'])
})

test('4 上限：65 个 peer 只留 64，丢最旧', () => {
  let t = 0
  const tbl = createPeerTable({ intervalMs: 1e9, now: () => ++t })
  for (let i = 0; i < 65; i++) tbl.upsert({ ...base, node: `n${i}` })
  const names = tbl.list().map((p) => p.node)
  assert.equal(names.length, 64)
  assert.ok(!names.includes('n0'))
  assert.ok(names.includes('n64'))
})

test('5 默认关闭：不创建 socket、peers 为空', async () => {
  assert.equal(normalizeDiscoveryConfig(undefined).enabled, false)
  assert.equal(normalizeDiscoveryConfig({}).enabled, false)
  assert.equal(normalizeDiscoveryConfig({ enabled: 'true' }).enabled, false)
  let calls = 0
  const dgram = { createSocket() { calls++; throw new Error('should not be called') } }
  for (const config of [undefined, {}, { enabled: false }]) {
    const d = createDiscovery({ config, dgram })
    assert.equal(await d.start(), false)
    assert.equal(calls, 0)
    assert.deepEqual(d.snapshot(), { enabled: false, peers: [] })
    d.stop()
  }
})

test('5b 端口被占用：warn 一次并降级，不抛', async () => {
  const handlers = {}
  const fake = {
    on(ev, fn) { handlers[ev] = fn },
    bind() { queueMicrotask(() => handlers.error(Object.assign(new Error('in use'), { code: 'EADDRINUSE' }))) },
    close() { this.closed = true },
  }
  const warns = []
  const d = createDiscovery({ config: { enabled: true }, dgram: { createSocket: () => fake }, log: { warn: (m) => warns.push(m) } })
  assert.equal(await d.start(), false)
  handlers.error(new Error('again'))
  assert.equal(warns.length, 1)
  assert.equal(fake.closed, true)
  assert.deepEqual(d.snapshot(), { enabled: false, peers: [] })
})

test('6 集成：127.0.0.1 临时端口上两实例互相发现；stop 清空', async () => {
  const mk = (node, port) => createDiscovery({
    config: { enabled: true, port: 0, intervalMs: 100 },
    role: node === 'A' ? 'hub' : 'node', node, port, pluginVersion: '0.1.0',
    hostname: '127.0.0.1', bindHost: '127.0.0.1', targets: [], // 先不发任何地方
  })
  const a = mk('A', 19387)
  const b = mk('B', 19388)
  try {
    assert.equal(await a.start(), true)
    assert.equal(await b.start(), true)
    a.setTargets([{ address: '127.0.0.1', port: b.boundPort }])
    b.setTargets([{ address: '127.0.0.1', port: a.boundPort }])
    for (let i = 0; i < 40 && (a.snapshot().peers.length === 0 || b.snapshot().peers.length === 0); i++) await wait(50)
    assert.deepEqual(a.snapshot().peers.map((p) => [p.node, p.role, p.port]), [['B', 'node', 19388]])
    assert.deepEqual(b.snapshot().peers.map((p) => [p.node, p.role, p.port]), [['A', 'hub', 19387]])
  } finally {
    a.stop(); b.stop()
  }
  assert.deepEqual(a.snapshot(), { enabled: false, peers: [] })
  assert.equal(a.boundPort, null)
})

test('6b 集成：groupKey 不一致互不可见', async () => {
  const mk = (node, groupKey) => createDiscovery({
    config: { enabled: true, port: 0, intervalMs: 100, groupKey },
    node, port: 1, pluginVersion: '0.1.0', hostname: '127.0.0.1', bindHost: '127.0.0.1', targets: [],
  })
  const a = mk('A', 'k1'); const b = mk('B', 'k2')
  try {
    await a.start(); await b.start()
    a.setTargets([{ address: '127.0.0.1', port: b.boundPort }])
    b.setTargets([{ address: '127.0.0.1', port: a.boundPort }])
    await wait(450)
    assert.equal(a.snapshot().peers.length, 0)
    assert.equal(b.snapshot().peers.length, 0)
  } finally { a.stop(); b.stop() }
})

test('服务名常量', () => assert.equal(DISCOVERY_SERVICE, 'dsh-ai-unified'))
