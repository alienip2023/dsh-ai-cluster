// W0（DESIGN-work-model.md §8）：可靠通道。三方（node011、hub、node010）用内存网络接起来，注入断线、重复、
// 处理失败、重启、对方离线，检查「恰好处理一次」。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createReliableLink, REL_ACK, REL_FRAME } from '../lib/reliable-link.js'

function net() {
  const up = new Map()        // peer pair "a>b" → link is up
  const links = new Map()
  const wire = []             // every frame put on a wire
  let clock = 1_000
  const now = () => clock
  const key = (a, b) => `${a}>${b}`
  const isUp = (a, b) => up.get(key(a, b)) !== false
  function node(name, { file, deliver, accepts } = {}) {
    const handled = []
    const link = createReliableLink({
      self: name, file, now, accepts,
      ready: peer => isUp(name, peer),
      send: (peer, type, data) => {
        if (!isUp(name, peer)) return false
        wire.push({ from: name, to: peer, type, data: structuredClone(data) })
        queueMicrotask(() => { const other = links.get(peer); if (other && isUp(name, peer)) void other.link.receive(name, type, structuredClone(data)) })
        return true
      },
      deliver: deliver ?? (msg => { handled.push(msg) }),
    })
    links.set(name, { link, handled })
    return { link, handled }
  }
  const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(r => setImmediate(r)) }
  return {
    node, settle, wire,
    cut: (a, b) => { up.set(key(a, b), false); up.set(key(b, a), false) },
    mend: (a, b) => { up.set(key(a, b), true); up.set(key(b, a), true) },
    advance: ms => { clock += ms },
  }
}

test('REL-1 a message is handled once and the sender forgets it when acked', async () => {
  const n = net()
  const hub = n.node('hub')
  const a = n.node('n11')
  const rid = a.link.post('hub', 'test/echo', { x: 1 })
  await n.settle()
  assert.deepEqual(hub.handled.map(m => [m.type, m.data.x, m.from, m.rid]), [['test/echo', 1, 'n11', rid]])
  assert.deepEqual(a.link.pending(), [])
})

test('REL-2 a resend (ack lost) is acked again and never handled twice', async () => {
  const n = net()
  const hub = n.node('hub')
  n.node('n11')
  assert.equal(await hub.link.receive('n11', REL_FRAME, { rid: 'r1', type: 'test/echo', data: { x: 1 } }), 'delivered')
  assert.equal(await hub.link.receive('n11', REL_FRAME, { rid: 'r1', type: 'test/echo', data: { x: 1 } }), 'duplicate')
  assert.equal(hub.handled.length, 1)
  assert.equal(n.wire.filter(w => w.type === REL_ACK && w.data.rid === 'r1').length, 2)
})

test('REL-3 a handler that fails is not acked; the message is sent again after its backoff and handled then', async () => {
  const n = net()
  let fail = true
  const got = []
  n.node('hub', { deliver: m => { if (fail) throw new Error('not now'); got.push(m) } })
  const a = n.node('n11')
  a.link.post('hub', 'test/echo', { x: 1 })
  await n.settle()
  assert.equal(got.length, 0)
  assert.equal(a.link.pending().length, 1)
  fail = false
  a.link.tick()                    // not due yet: no resend
  await n.settle()
  assert.equal(got.length, 0)
  n.advance(10_000)
  a.link.tick()
  await n.settle()
  assert.equal(got.length, 1)
  assert.deepEqual(a.link.pending(), [])
})

test('REL-4 nothing is sent while the link is down, no clock runs, and it goes at once when the peer is ready', async () => {
  const n = net()
  const hub = n.node('hub')
  const a = n.node('n11')
  n.cut('n11', 'hub')
  a.link.post('hub', 'test/echo', { x: 1 })
  n.advance(60 * 60 * 1000)
  a.link.tick()
  await n.settle()
  assert.equal(n.wire.length, 0)
  assert.equal(a.link.pending()[0].tries, 0, 'no attempt counted while down')
  n.mend('n11', 'hub')
  a.link.peerReady('hub')
  await n.settle()
  assert.equal(hub.handled.length, 1)
  assert.deepEqual(a.link.pending(), [])
})

test('REL-5 node to node through the hub: held at the hub while the target is away, delivered when it is back', async () => {
  const n = net()
  const hub = n.node('hub')
  const a = n.node('n11')
  const b = n.node('n10')
  n.cut('hub', 'n10')
  a.link.post('hub', 'test/echo', { x: 7 }, { to: 'n10', from: 'n99-spoofed' })
  await n.settle()
  assert.deepEqual(a.link.pending(), [], 'the hub took it: n11 is done with it')
  assert.equal(hub.handled.length, 0, 'the hub does not handle a forwarded message itself')
  assert.equal(hub.link.pending('n10').length, 1, 'the hub keeps it for n10')
  n.mend('hub', 'n10')
  hub.link.peerReady('n10')
  await n.settle()
  assert.equal(b.handled.length, 1)
  assert.equal(b.handled[0].from, 'n11', 'the sender is the node the hub got it from, not what the frame said')
  assert.equal(b.handled[0].data.x, 7)
  assert.deepEqual(hub.link.pending(), [])
})

test('REL-6 a restart keeps what was not acked and what was already handled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-'))
  try {
    const n = net()
    n.node('hub')
    const file = join(dir, 'reliable.json')
    const a1 = n.node('n11', { file })
    n.cut('n11', 'hub')
    const rid = a1.link.post('hub', 'test/echo', { x: 1 })
    // n11 restarts before the hub ever saw it
    const a2 = n.node('n11', { file })
    assert.deepEqual(a2.link.pending().map(p => p.rid), [rid])
    n.mend('n11', 'hub')
    a2.link.peerReady('hub')
    await n.settle()
    assert.deepEqual(a2.link.pending(), [])
    // the hub restarts after handling it; a resend of the same id is still recognised
    const hubFile = join(dir, 'hub.json')
    const h1 = n.node('hub', { file: hubFile })
    assert.equal(await h1.link.receive('n11', REL_FRAME, { rid: 'r9', type: 'test/echo', data: {} }), 'delivered')
    const h2 = n.node('hub', { file: hubFile })
    assert.equal(await h2.link.receive('n11', REL_FRAME, { rid: 'r9', type: 'test/echo', data: {} }), 'duplicate')
    assert.equal(h2.handled.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('REL-7 backoff grows and is capped; seen ids are forgotten after their time', async () => {
  const n = net()
  n.node('hub', { deliver: () => { throw new Error('down') } })
  const a = n.node('n11')
  a.link.post('hub', 'test/echo', {})
  const gaps = []
  for (let i = 0; i < 8; i += 1) {
    await n.settle()
    const before = n.wire.filter(w => w.type === REL_FRAME).length
    let waited = 0
    while (n.wire.filter(w => w.type === REL_FRAME).length === before && waited < 300_000) { n.advance(1_000); waited += 1_000; a.link.tick() }
    gaps.push(waited)
  }
  assert.ok(gaps[1] > gaps[0] && gaps[2] > gaps[1], `backoff grows: ${gaps}`)
  assert.ok(gaps.at(-1) <= 120_000, `capped at 2 min: ${gaps}`)

  const m = net()
  const hub = m.node('hub')
  await hub.link.receive('n11', REL_FRAME, { rid: 'old', type: 'test/echo', data: {} })
  assert.equal(hub.link.seenCount(), 1)
  m.advance(8 * 24 * 60 * 60 * 1000)
  hub.link.tick()
  assert.equal(hub.link.seenCount(), 0)
})

test('REL-8 an inner type this side does not take is acked and dropped (never resent forever)', async () => {
  const n = net()
  const hub = n.node('hub', { accepts: t => t.startsWith('work/') })
  const a = n.node('n11')
  a.link.post('hub', 'evil/thing', {})
  await n.settle()
  assert.equal(hub.handled.length, 0)
  assert.deepEqual(a.link.pending(), [])
})
