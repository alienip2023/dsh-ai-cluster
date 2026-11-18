import test from 'node:test'
import assert from 'node:assert/strict'
import { createFrameDispatcher } from '../../lib/node/dispatch.js'
import { createBotNetwork, HUB_NODE_ID } from '../../lib/node/bot-network.js'

// 与 ds-bot/test/bot-network.test.js:58-65 中 directoryOf 的输出同形。
const dsBotBots = () => [
  { id: 'local', name: 'local', role: 'Writer', nodeId: null },
  { id: 'joined:n2:b', name: 'Remote', role: 'Research', nodeId: 'n2' },
]
const mapped = [
  { id: 'local', name: 'local', role: 'Writer', nodeId: 'hub' },
  { id: 'joined:n2:b', name: 'Remote', role: 'Research', nodeId: 'n2' },
]
function setup(t, nodeId = 'n1') {
  const sent = []
  const warns = []
  const network = createBotNetwork({ nodeId, send: (type, payload) => { sent.push({ type, payload }); return true },
    logger: { warn: (msg, meta) => warns.push(meta) } })
  t.after(() => network.dispose())
  const dispatch = createFrameDispatcher({ network })
  return { network, dispatch, sent, warns }
}

test('hub-own Bot (nodeId:null) is kept with the hub stand-in; joined Bot untouched', t => {
  const { network, dispatch } = setup(t)
  assert.equal(HUB_NODE_ID, 'hub')
  assert.equal(dispatch({ t: 'bot/directory', d: { bots: dsBotBots(), at: 1 } }), true)
  assert.deepEqual(network.directory(), mapped)
})

test('directory event carries the mapped list', t => {
  const { network, dispatch } = setup(t)
  const events = []
  network.on('directory', e => events.push(e))
  dispatch({ t: 'bot/directory', d: { bots: dsBotBots(), at: 1 } })
  assert.equal(events.length, 1)
  assert.deepEqual(events[0].bots, mapped)
})

test('incoming data is not mutated', t => {
  const { network } = setup(t)
  const data = { bots: dsBotBots(), at: 1 }
  const clone = structuredClone(data)
  network.receiveDirectory(data)
  assert.deepEqual(data, clone)
  assert.equal(data.bots[0].nodeId, null)
})

test('malformed entry beside a hub-own one is dropped, hub-own survives', t => {
  const { network } = setup(t)
  network.receiveDirectory({ bots: [null, 'x', { id: '', name: 'bad', nodeId: null }, dsBotBots()[0]], at: 1 })
  assert.deepEqual(network.directory(), [mapped[0]])
})

test('round trip: ask to a hub-own Bot is sent with to.nodeId hub', t => {
  const { network, sent } = setup(t)
  network.receiveDirectory({ bots: dsBotBots(), at: 1 })
  const target = network.directory().find(b => b.id === 'local')
  const ok = network.send({ from: { id: 'mine', name: 'Mine', nodeId: 'n1' },
    to: { id: target.id, name: target.name, nodeId: target.nodeId },
    exchangeId: 'x1', kind: 'ask', text: 'hi', depth: 0 })
  assert.equal(ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'bot/message')
  assert.equal(sent[0].payload.to.nodeId, 'hub')
})

test('a real node named hub warns once and is kept', t => {
  const { network, warns } = setup(t)
  network.receiveDirectory({ bots: [{ id: 'h', name: 'H', role: '', nodeId: 'hub' }], at: 1 })
  assert.equal(warns.length, 1)
  assert.deepEqual(network.directory(), [{ id: 'h', name: 'H', role: '', nodeId: 'hub' }])
})
