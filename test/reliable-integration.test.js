// W0 集成：AC 真实的主控 ingest（NodeRegistry）+ 真实的节点 bot-network 与帧分发，跑可靠通道的整条路：
// 节点 → 主控交给宿主；主控 → 节点；节点 → 主控 → 另一节点（目标离线时主控存住、上线即送）；E2E 重新就绪时补发。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { createHubBotNetwork } from '../lib/hub/bot-network.js'
import { createBotNetwork } from '../lib/node/bot-network.js'
import { createFrameDispatcher } from '../lib/node/dispatch.js'
import { attachHubReliable, attachNodeReliable } from '../lib/reliable-wire.js'

const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise(r => setImmediate(r)) }

function cluster() {
  const registry = new NodeRegistry({ log() {} })
  registry.e2eReady = nodeId => registry.nodes.get(nodeId)?.online === true   // sealing is covered elsewhere (w0-fixes)
  const hubNet = createHubBotNetwork({ registry, ctx: { get: () => undefined } })
  const detachHub = attachHubReliable({ registry, network: hubNet })
  const nodes = {}
  function addNode(nodeId) {
    const transport = new EventEmitter()
    transport.online = true
    const network = createBotNetwork({ nodeId })
    // node → hub: the hub's real ingest, as the connection of this node
    const send = (type, data) => { if (!transport.online) return false; queueMicrotask(() => registry.handleFrameFor(nodeId, { v: 1, t: type, id: 'x', d: structuredClone(data) })); return true }
    const dispatch = createFrameDispatcher({ network, send, sendError() {}, logger: {}, ctx: undefined })
    const detach = attachNodeReliable({ nodeId, transport, send, network })
    // hub → node: the hub's real sendViaHub writes to this conn; the node's real dispatcher takes the frame
    registry.nodes.set(nodeId, { nodeId, online: true, tasks: new Map(), hello: {}, conn: { closed: false, send: text => { if (!transport.online) throw new Error('closed'); const f = JSON.parse(text); queueMicrotask(() => dispatch(f, f.d)) } } })
    nodes[nodeId] = { transport, network, detach }
    return nodes[nodeId]
  }
  const goDown = nodeId => { nodes[nodeId].transport.online = false; registry.nodes.get(nodeId).online = false }
  const comeBack = nodeId => {
    nodes[nodeId].transport.online = true; registry.nodes.get(nodeId).online = true
    registry.emit('e2eEstablished', { nodeId }); nodes[nodeId].transport.emit('e2e', 'ok')
  }
  return { registry, hubNet, addNode, goDown, comeBack, detach: () => { detachHub(); for (const n of Object.values(nodes)) n.detach() } }
}

test('REL-INT-1 node → hub host, and hub → node, each handled once and acked', async t => {
  const c = cluster(); t.after(c.detach)
  const n11 = c.addNode('n11')
  const atHub = []
  const atNode = []
  c.hubNet.onReliable('test/echo', m => { atHub.push(m) })
  n11.network.onReliable('test/echo', m => { atNode.push(m) })
  n11.network.post('test/echo', { x: 1 })
  c.hubNet.post('n11', 'test/echo', { y: 2 })
  await settle()
  assert.deepEqual(atHub.map(m => [m.from, m.data.x]), [['n11', 1]])
  assert.deepEqual(atNode.map(m => [m.from, m.data.y]), [['hub', 2]])
  assert.deepEqual(n11.network.reliablePending(), [])
  assert.deepEqual(c.hubNet.reliablePending(), [])
})

test('REL-INT-2 node → node through the hub: the target is away, the hub keeps it, it arrives when the target is back', async t => {
  const c = cluster(); t.after(c.detach)
  const n11 = c.addNode('n11')
  const n10 = c.addNode('n10')
  const got = []
  n10.network.onReliable('work/handoff', m => { got.push(m) })
  c.goDown('n10')
  n11.network.post('work/handoff', { id: 'w-1' }, { to: 'n10' })
  await settle()
  assert.deepEqual(n11.network.reliablePending(), [], 'the hub took it')
  assert.equal(c.hubNet.reliablePending('n10').length, 1, 'kept at the hub for n10')
  assert.equal(got.length, 0)
  c.comeBack('n10')
  await settle()
  assert.deepEqual(got.map(m => [m.from, m.data.id]), [['n11', 'w-1']], 'delivered once, from n11')
  assert.deepEqual(c.hubNet.reliablePending(), [])
})

test('REL-INT-3 the link drops after the frame left: nothing is lost, it is resent when E2E is up again', async t => {
  const c = cluster(); t.after(c.detach)
  const n11 = c.addNode('n11')
  const atHub = []
  c.hubNet.onReliable('test/echo', m => { atHub.push(m) })
  // the frame leaves n11, but the hub never sees it (connection dies under it)
  const realSend = c.registry.handleFrameFor.bind(c.registry)
  let dropping = true
  c.registry.handleFrameFor = (nodeId, frame, meta) => (dropping ? undefined : realSend(nodeId, frame, meta))
  n11.network.post('test/echo', { x: 9 })
  await settle()
  assert.equal(atHub.length, 0)
  assert.equal(n11.network.reliablePending().length, 1, 'still owed: no ack came back')
  dropping = false
  c.goDown('n11'); c.comeBack('n11')
  await settle()
  assert.deepEqual(atHub.map(m => m.data.x), [9])
  assert.deepEqual(n11.network.reliablePending(), [])
})

test('REL-INT-4 a message with no handler yet is kept, and handled once the host registers one (AC loads before ds-bot)', async t => {
  const c = cluster(); t.after(c.detach)
  const n11 = c.addNode('n11')
  n11.network.post('work/result', { id: 'w-2' })
  await settle()
  assert.equal(n11.network.reliablePending().length, 1)
  const atHub = []
  c.hubNet.onReliable('work/result', m => { atHub.push(m) })
  c.comeBack('n11')
  await settle()
  assert.deepEqual(atHub.map(m => m.data.id), ['w-2'])
})
