// Why a node went offline is kept in the audit trail: under load a heartbeat timeout looks like a crash,
// and the info log is not persisted.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NodeRegistry } from '../lib/hub/node-registry.js'

test('markOffline records node.offline with its reason', () => {
  const recorded = []
  const registry = new NodeRegistry({ log: () => {}, audit: { record: (event, fields) => recorded.push({ event, fields }) } })
  registry.nodes.set('n1', { nodeId: 'n1', online: true, conn: {}, tasks: new Map(), hello: {} })
  registry.markOffline('n1', 'heartbeat timeout (relay)')
  assert.deepEqual(recorded.map(item => item.event), ['node.offline'])
  assert.equal(recorded[0].fields.nodeId, 'n1')
  assert.equal(recorded[0].fields.reason, 'heartbeat timeout (relay)')
  registry.markOffline('n1', 'again')
  assert.equal(recorded.length, 1, 'an already-offline node is not recorded twice')
})

// Stress round 3, D3: coming back is audited too, with how long the node was away and why it left.
const hello = { type: 'hello', protocol: 1, nodeId: 'n1', os: 'linux', arch: 'x64', hostname: 'n1', version: '0.4.22', roots: ['/w'], caps: [] }

test('a node coming online is audited; one coming back after a drop also says how long and why', () => {
  const recorded = []
  const registry = new NodeRegistry({ log: () => {}, audit: { record: (event, fields) => recorded.push({ event, fields }) } })
  registry.send = () => true
  registry.sendIdentityFrame = () => {}
  registry.ingestHello({ helloData: hello, conn: undefined, transport: 'relay', pending: undefined })
  assert.deepEqual(recorded.map(item => item.event), ['node.online'], 'a first connection is not a reconnect')
  assert.equal(recorded[0].fields.reconnected, false)

  registry.markOffline('n1', 'socket closed 1006: read ETIMEDOUT')
  registry.nodes.get('n1').offlineAt = Date.now() - 150_000
  recorded.length = 0
  registry.ingestHello({ helloData: hello, conn: undefined, transport: 'relay', pending: undefined })
  assert.deepEqual(recorded.map(item => item.event), ['node.online', 'node.reconnected'])
  assert.equal(recorded[0].fields.reconnected, true)
  const back = recorded[1].fields
  assert.equal(back.nodeId, 'n1')
  assert.equal(back.lastReason, 'socket closed 1006: read ETIMEDOUT')
  assert.ok(back.downMs >= 150_000 && back.downMs < 160_000, `downMs ${back.downMs}`)
})
