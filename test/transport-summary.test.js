import assert from 'node:assert/strict'
import test from 'node:test'
import * as views from '../lib/hub/views.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'

const online = (transportMode) => ({ online: true, transportMode })
const summarize = (nodes) => views.summarizeTransportModes(nodes)

test('all-direct: eight online direct nodes display 直连', () => {
  const result = summarize(Array.from({ length: 8 }, () => online('direct')))
  assert.equal(result.mode, 'direct')
  assert.equal(result.label, '直连')
})

test('all-relay: online relay nodes display 中继', () => {
  const result = summarize([online('relay'), online('relay')])
  assert.equal(result.mode, 'relay')
  assert.equal(result.label, '中继')
})

test('mixed: count only online nodes of each mode', () => {
  const result = summarize([
    online('direct'), online('relay'), online('direct'),
    { online: false, transportMode: 'relay' },
  ])
  assert.equal(result.mode, 'mixed')
  assert.equal(result.label, '混合（直连 2 台 / 中继 1 台）')
})

test('no online nodes: unknown must never default to relay', () => {
  for (const nodes of [undefined, null, [], [{ online: false, transportMode: 'relay' }]]) {
    const result = summarize(nodes)
    assert.equal(result.mode, 'unknown')
    assert.notEqual(result.mode, 'relay')
    assert.equal(result.label, '未知（暂无在线节点）')
  }
})

test('missing or unrecognized reports stay unknown, including partially known fleets', () => {
  for (const value of [undefined, null, '', 'other']) {
    const result = summarize([online(value)])
    assert.equal(result.mode, 'unknown')
    assert.equal(result.label, '未知（1 台在线节点未上报有效连接方式）')
  }
  const result = summarize([online('direct'), online('relay'), online(null)])
  assert.equal(result.mode, 'unknown')
  assert.equal(result.label, '未知（直连 1 台 / 中继 1 台 / 未知 1 台）')
})

test('summary is pure and ignores nodes without an explicit online flag', () => {
  const nodes = Object.freeze([
    Object.freeze(online('direct')),
    Object.freeze({ transportMode: 'relay' }),
    null,
  ])
  assert.equal(summarize(nodes).label, '直连')
  assert.equal(nodes.length, 3)
})

test('nodeView preserves reported modes and projects missing fields to null', () => {
  assert.equal(views.nodeView({}).transportMode, null)
  assert.equal(views.nodeView({ transportMode: null }).transportMode, null)
  for (const transportMode of ['direct', 'relay']) {
    assert.equal(views.nodeView({ transportMode }).transportMode, transportMode)
  }
})

test('registry list → nodeView cannot manufacture relay for an old hello', () => {
  const registry = new NodeRegistry({ log() {} })
  registry.nodes.set('old-node', { nodeId: 'old-node', online: true, hello: {}, tasks: new Map() })
  const nodes = registry.list().map(views.nodeView)
  assert.equal(nodes[0].transportMode, null)
  assert.equal(summarize(nodes).mode, 'unknown')
})
