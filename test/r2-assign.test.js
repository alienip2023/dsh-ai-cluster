// R2（重写 2026-11-24）：bot/assign —— 跨机器的 Bot 间投递。主控只负责搬运：
// 给自己的 Bot 交给宿主，给别的节点就转发，目标节点不在线就退回发送方（bounce）。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { BOT_ASSIGN_OPS, HUB_TO_NODE, NODE_TO_HUB, validateBotAssign } from '../lib/protocol.js'
import { withIngest } from '../lib/hub/registry-ingest.js'
import { createHubBotNetwork } from '../lib/hub/bot-network.js'
import { createBotNetwork } from '../lib/node/bot-network.js'

const ID11 = 'bbbbbbbbbbbbbbbb'
const e11 = { id: 'joined:node011:e11', name: 'node011执行', nodeId: 'node011' }
const e10 = { id: 'joined:node010:e10', name: 'node010执行', nodeId: 'node010' }
const chief = { id: 'chief', name: 'Chief', nodeId: 'hub' }
const deliver = (over = {}) => ({ op: 'deliver', frameId: 'f-1', from: e11, to: e10, role: 'request', exchangeId: 'x-1', text: '第 1 回合', at: 1, ...over })

class Core extends EventEmitter {
  constructor(online = { node010: true, node011: true }) {
    super()
    this.nodes = new Map(Object.entries(online).map(([nodeId, up]) => [nodeId, { nodeId, online: up }]))
    this.sent = []
    this.logs = []
  }
  send(nodeId, type, data) { this.sent.push({ nodeId, type, data }); return true }
  log(...args) { this.logs.push(args) }
}

test('R2-1 bot/assign constants and validator', () => {
  assert.equal(HUB_TO_NODE.BOT_ASSIGN, 'bot/assign')
  assert.equal(NODE_TO_HUB.BOT_ASSIGN, 'bot/assign')
  assert.deepEqual([...BOT_ASSIGN_OPS], ['deliver', 'ack', 'bounce'])
  assert.deepEqual(validateBotAssign({ ...deliver(), extra: 'drop', replyTo: 'x-0' }), { ...deliver(), replyTo: 'x-0' })
  assert.deepEqual(validateBotAssign({ op: 'ack', frameId: 'f-1', from: e10, to: e11, at: 2, text: 'ignored' }), { op: 'ack', frameId: 'f-1', from: e10, to: e11, at: 2 })
  assert.equal(validateBotAssign({ op: 'bounce', frameId: 'f', from: e10, to: e11, reason: ' offline ' }).reason, 'offline')
  for (const bad of [deliver({ op: 'shout' }), deliver({ role: 'default' }), deliver({ text: 'x'.repeat(65537) }), deliver({ exchangeId: '' }), deliver({ frameId: undefined }), deliver({ from: { id: 'a' } }), deliver({ replyTo: '' })]) {
    assert.throws(() => validateBotAssign(bad), { code: 'bot-assign-invalid' })
  }
})

test('R2-2 hub forwards a node-to-node delivery to the online target node, unchanged', () => {
  const registry = new (withIngest(Core))()
  registry.handleFrameFor('node011', { t: 'bot/assign', d: deliver() })
  assert.deepEqual(registry.sent, [{ nodeId: 'node010', type: 'bot/assign', data: deliver() }])
})

test('R2-3 hub bounces a delivery to an offline node back to the sender; an ack to it is dropped', () => {
  const registry = new (withIngest(Core))({ node010: false, node011: true })
  registry.handleFrameFor('node011', { t: 'bot/assign', d: deliver() })
  assert.equal(registry.sent.length, 1)
  const { nodeId, type, data } = registry.sent[0]
  assert.equal(nodeId, 'node011')
  assert.equal(type, 'bot/assign')
  assert.equal(data.op, 'bounce')
  assert.equal(data.frameId, 'f-1')
  assert.deepEqual(data.to, e11)
  assert.equal(data.reason, 'offline')
  registry.handleFrameFor('node011', { t: 'bot/assign', d: { op: 'ack', frameId: 'f-9', from: e11, to: e10 } })
  assert.equal(registry.sent.length, 1)
})

test('R2-4 hub hands deliveries for its own Bots to the host and drops a spoofed sender', async () => {
  const registry = new (withIngest(Core))()
  const network = createHubBotNetwork({ registry, ctx: { get: () => undefined } })
  const got = []
  const off = network.onAssign(payload => { got.push(payload) })
  registry.handleFrameFor('node011', { t: 'bot/assign', d: deliver({ to: chief }) })
  registry.handleFrameFor('node010', { t: 'bot/assign', d: deliver({ to: chief, frameId: 'f-2' }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(got.length, 1, 'a frame whose sender is on another node than the connection is dropped')
  assert.equal(got[0].to.id, 'chief')
  assert.equal(registry.sent.length, 0)
  off()
  network.dispose()
})

test('R2-5 hub sendAssign: only hub Bot → node Bot; false when the node is not connected', () => {
  const registry = new (withIngest(Core))({ node010: false, node011: true })
  const network = createHubBotNetwork({ registry, ctx: { get: () => undefined } })
  assert.equal(network.sendAssign(deliver({ from: chief, to: e11 })), true)
  assert.equal(registry.sent[0].type, 'bot/assign')
  assert.equal(network.sendAssign(deliver({ from: chief, to: e10 })), false)
  assert.throws(() => network.sendAssign(deliver({ from: e11, to: chief })), { code: 'bot-assign-invalid' })
  network.dispose()
})

test('R2-6 node sendAssign goes over the hub link with the sender identityId; receiveAssign checks the target node', async () => {
  const hub = []
  const peer = []
  const network = createBotNetwork({ nodeId: 'node011', send: (type, data) => { peer.push({ type, data }); return true }, sendHub: (type, data) => { hub.push({ type, data }); return true }, identityOf: id => (id === 'e11' ? ID11 : undefined) })
  assert.equal(network.sendAssign(deliver()), true)
  assert.equal(peer.length, 0, 'never on the peer-direct path')
  assert.equal(hub[0].type, 'bot/assign')
  assert.equal(hub[0].data.from.identityId, ID11, 'team-wide id resolved to the local Bot for the identity book')
  assert.throws(() => network.sendAssign(deliver({ from: e10 })), { code: 'bot-assign-invalid' })
  const got = []
  network.onAssign(payload => { got.push(payload) })
  network.receiveAssign(deliver({ from: e10, to: e11 }))
  network.receiveAssign(deliver({ from: e11, to: e10 }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(got.length, 1)
  assert.equal(got[0].to.id, e11.id)
  network.dispose()
})
