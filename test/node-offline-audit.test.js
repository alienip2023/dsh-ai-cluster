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
