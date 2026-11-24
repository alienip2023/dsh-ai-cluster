// W0（重写 2026-11-24，DESIGN-work-model.md §8.3）：AC 主控侧三处会静默丢帧的问题。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { HUB_TO_NODE } from '../lib/protocol.js'

function registryWithNode({ stale = false } = {}) {
  const registry = new NodeRegistry({ log() {} })
  const wire = []
  const sealed = []
  registry.nodes.set('n1', {
    nodeId: 'n1', online: true, tasks: new Map(), hello: {},
    conn: { closed: false, send: text => wire.push(JSON.parse(text)) },
    e2e: { sealFrame: (type, id, d) => { sealed.push(type); return { sealed: true } } },
    e2eStale: stale,
  })
  return { registry, wire, sealed }
}

test('W0-1 after a reconnect, a frame that must be sealed is not sent with the stale session key', () => {
  const { registry, wire, sealed } = registryWithNode({ stale: true })
  assert.equal(registry.e2eReady('n1'), false)
  assert.equal(registry.sendViaHub('n1', HUB_TO_NODE.BOT_DIRECTORY, { bots: [] }), false, 'the caller sees it was not sent')
  assert.equal(registry.send('n1', HUB_TO_NODE.BOT_TURN, { exchangeId: 'x1', nodeId: 'n1', remoteBotId: 'b', text: 'hi' }), false, 'bot/turn refused (bridge-down), not dropped on the node')
  assert.deepEqual(wire, [])
  assert.deepEqual(sealed, [])
})

test('W0-2 with the current session the frame is sealed and sent', () => {
  const { registry, wire, sealed } = registryWithNode({ stale: false })
  assert.equal(registry.e2eReady('n1'), true)
  assert.equal(registry.sendViaHub('n1', HUB_TO_NODE.BOT_DIRECTORY, { bots: [] }), true)
  assert.equal(wire.length, 1)
  assert.deepEqual(sealed, [HUB_TO_NODE.BOT_DIRECTORY])
})

test('W0-3 a bot/turn the node dropped is failed under its own exchangeId, not the envelope id', () => {
  const { registry, wire } = registryWithNode({ stale: false })
  const results = []
  registry.on('botTurnResult', r => results.push(r))
  assert.equal(registry.sendViaHub('n1', HUB_TO_NODE.BOT_TURN, { exchangeId: 'ex-42', nodeId: 'n1', remoteBotId: 'b', text: 'hi' }), true)
  const envelopeId = wire[0].id
  assert.notEqual(envelopeId, 'ex-42')
  registry.handleFrameFor('n1', { v: 1, t: 'error', id: 'e1', d: { code: 'e2e-not-ready', droppedType: HUB_TO_NODE.BOT_TURN, droppedId: envelopeId } })
  assert.equal(results.length, 1)
  assert.equal(results[0].exchangeId, 'ex-42')
  assert.equal(results[0].error, 'bridge-down')
})

test('W0-4 a bot/assign the hub cannot forward is bounced back to its sender', async () => {
  const { withIngest } = await import('../lib/hub/registry-ingest.js')
  const { EventEmitter } = await import('node:events')
  class Core extends EventEmitter {
    constructor() { super(); this.nodes = new Map([['node010', { nodeId: 'node010', online: true }], ['node011', { nodeId: 'node011', online: true }]]); this.sent = []; this.log = () => {} }
    send(nodeId, type, data) { this.sent.push({ nodeId, type, data }); return nodeId !== 'node010' }
  }
  const registry = new (withIngest(Core))()
  const e11 = { id: 'joined:node011:e11', name: 'E11', nodeId: 'node011' }
  const e10 = { id: 'joined:node010:e10', name: 'E10', nodeId: 'node010' }
  registry.handleFrameFor('node011', { t: 'bot/assign', d: { op: 'deliver', frameId: 'f-1', from: e11, to: e10, role: 'request', exchangeId: 'x', text: 'hi' } })
  const bounce = registry.sent.find(s => s.nodeId === 'node011')
  assert.ok(bounce, 'the sender is told')
  assert.equal(bounce.data.op, 'bounce')
  assert.equal(bounce.data.reason, 'send-failed')
})
