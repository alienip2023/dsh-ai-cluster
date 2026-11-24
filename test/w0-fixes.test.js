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
    e2e: { sealFrame: (type) => { sealed.push(type); return { sealed: true } } },
    e2eStale: stale, e2eReset: stale,
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

test('W0-5 a relay directory replay keeps the session usable; the relay saying the node connected again does not', async () => {
  const { PROTOCOL_VERSION } = await import('../lib/protocol.js')
  const registry = new NodeRegistry({ log() {} })
  registry.send = () => true
  const hello = { nodeId: 'n7', protocol: PROTOCOL_VERSION, os: 'linux', hostname: 'h', version: '1', caps: [] }
  registry.handleRelayFrame({ t: 'node/online', d: { node: hello } })
  const rec = registry.nodes.get('n7')
  assert.ok(rec, 'adopted')
  rec.e2e = { sealFrame: () => ({ sealed: true }) }
  registry.handleRelayFrame({ t: 'node/list', d: { nodes: [hello] } })
  assert.equal(registry.e2eReady('n7'), true, 'hub-side replay: the node may still hold the session')
  registry.handleRelayFrame({ t: 'node/online', d: { node: hello } })
  assert.equal(registry.e2eReady('n7'), false, 'the node connected again: its old session is gone')
})
