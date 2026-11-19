import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { NodeRegistry } from '../../lib/hub/node-registry.js'
import { nodeView } from '../../lib/hub/views.js'
import { generateIdentity } from '../../lib/identity.js'

const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')

function render(node, actions = {}) {
  let NodeCard
  const instrumented = source.replace('nodeCardView: nodeCardView,', 'NodeCard: NodeCard, nodeCardView: nodeCardView,')
  const react = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...props, children })
      return { type, props, children: children.flat(Infinity) }
    },
  }
  vm.runInNewContext(instrumented, {
    ...actions,
    fetch: actions.send,
    window: { ...actions, __ModuleLoader__: { load(mod) { NodeCard = mod.factory(() => react).NodeCard } } },
  }, { filename: 'lib/client.js' })
  return NodeCard({ node, ...actions, onAction: actions.send })
}

function elements(tree) {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...tree.children.flatMap(elements)]
}

function text(tree) {
  return elements(tree).flatMap(el => el.children).filter(child => typeof child === 'string').join(' ')
}

test('RTT-15 relay draws nothing', (t) => {
  const registry = new NodeRegistry()
  t.after(() => registry.dispose())
  registry.adoptRelaySummary({ nodeId: 'pc-relay', os: 'linux', transportMode: 'relay' })
  registry.tick()
  assert.equal(registry.peerRouter, undefined)
  const row = registry.list()[0]
  const projected = nodeView(row)
  const msg = 'RTT-15: relay must not draw a line'
  for (const node of [row, projected]) {
    assert.ok(node.frameRttMs === undefined || (Array.isArray(node.frameRttMs) && node.frameRttMs.length === 0), msg)
    assert.equal(elements(render(node)).some(el => el.type === 'polyline'), false, msg)
  }
})

test('RTT-trust unknown is not confirmed', (t) => {
  const registry = new NodeRegistry({ identity: { ...generateIdentity(), privateKeyB64: 'invalid' } })
  t.after(() => registry.dispose())
  registry.adoptRelaySummary({ nodeId: 'pc-invalid-signature', os: 'linux', transportMode: 'relay' })
  assert.equal(registry.list()[0].confirm, 'unknown')
  registry.identity = null
  registry.adoptRelaySummary({ nodeId: 'pc-no-identity', os: 'linux', transportMode: 'relay' })
  const row = nodeView(registry.list().find(n => n.nodeId === 'pc-no-identity'))
  const rendered = text(render(row))
  const msg = 'RTT-trust: missing identity is unknown'
  assert.equal(row.confirm, 'unknown', msg)
  assert.ok(rendered.includes('确认: 未知'), msg)
  assert.equal(rendered.includes('已确认'), false, msg)
})

test('RTT-trust badge does not route', () => {
  const msg = 'RTT-trust: badge must not decide'
  const fail = () => assert.fail(msg)
  const actions = { send: fail, approve: fail, connect: fail }
  let card
  assert.doesNotThrow(() => {
    card = render({ nodeId: 'pc-direct', online: true, transportMode: 'direct', confirm: 'confirmed', frameRttMs: [0, 12] }, actions)
  }, msg)
  const badge = elements(card).find(el => el.children.includes('确认: 已确认'))
  assert.equal(badge?.type, 'span', msg)
  assert.equal(Object.keys(badge.props).some(key => key.startsWith('on')), false, msg)
  assert.equal(elements(card).find(el => el.type === 'polyline')?.props.points, '1,17 89,1')
})
