import test from 'node:test'
import assert from 'node:assert/strict'
import * as inventory from '../../src/http/model-list.js'

const { modelListOf } = inventory

test('exports exactly modelListOf', () => {
  assert.deepEqual(Object.keys(inventory), ['modelListOf'])
})

test('null models means the node has not reported', () => {
  const [row] = modelListOf([{ nodeId: 'n1', models: null }])
  assert.equal(row.reported, false)
  assert.deepEqual(row.ids, [])
})

test('absent models means the node has not reported', () => {
  const [row] = modelListOf([{ nodeId: 'n1' }])
  assert.equal(row.reported, false)
  assert.deepEqual(row.ids, [])
})

test('non-array models means the node has not reported', () => {
  for (const models of [undefined, false, 0, '', 'a', {}, { id: 'a' }]) {
    const [row] = modelListOf([{ nodeId: 'n1', models }])
    assert.equal(row.reported, false)
    assert.deepEqual(row.ids, [])
  }
})

test('an empty models array is a reported inventory', () => {
  const [row] = modelListOf([{ nodeId: 'n1', models: [] }])
  assert.equal(row.reported, true)
  assert.deepEqual(row.ids, [])
})

test('model ids retain their order and duplicates', () => {
  const [row] = modelListOf([{
    nodeId: 'n1',
    models: [{ id: 'a' }, { id: '' }, {}, { id: 'b' }, { id: 'a' }],
  }])
  assert.deepEqual(row.ids, ['a', 'b', 'a'])
})

test('invalid model entries are dropped without coercion', () => {
  const [row] = modelListOf([{
    nodeId: 'n1',
    models: [null, undefined, 'a', 1, false, {}, { id: null }, { id: 1 }, { id: ' ' }],
  }])
  assert.deepEqual(row.ids, [' '])
})

test('defaultModel preserves non-empty strings and otherwise becomes null', () => {
  const rows = modelListOf([
    { nodeId: 'empty', defaultModel: '' },
    { nodeId: 'absent' },
    { nodeId: 'valid', defaultModel: 'x' },
    { nodeId: 'null', defaultModel: null },
    { nodeId: 'number', defaultModel: 1 },
    { nodeId: 'space', defaultModel: ' ' },
  ])
  assert.deepEqual(rows.map((row) => row.defaultModel), [null, null, 'x', null, null, ' '])
})

test('invalid nodes are dropped and valid node order is preserved', () => {
  const rows = modelListOf([
    null, {}, { nodeId: '' }, undefined, 'n0', 1, false, { nodeId: 1 },
    { nodeId: 'n2' }, { nodeId: 'n1' },
  ])
  assert.deepEqual(rows, [
    { nodeId: 'n2', defaultModel: null, reported: false, ids: [] },
    { nodeId: 'n1', defaultModel: null, reported: false, ids: [] },
  ])
})

test('credentials are never read and result keys are exactly the public projection', () => {
  const guard = (value, allowed) => new Proxy(value, {
    get(target, key) {
      assert.ok(allowed.includes(key), `unexpected field read: ${String(key)}`)
      return Reflect.get(target, key)
    },
    ownKeys() {
      assert.fail('must not enumerate credential-bearing objects')
    },
  })
  const node = guard({
    nodeId: 'n1',
    defaultModel: 'a',
    apiKey: 'private',
    token: 'private',
    secret: 'private',
    key: 'private',
    providerCredentials: { password: 'private' },
    models: [guard({ id: 'a', apiKey: 'private' }, ['id'])],
  }, ['nodeId', 'models', 'defaultModel'])

  let rows
  assert.doesNotThrow(() => { rows = modelListOf([node]) })
  assert.deepEqual(Object.keys(rows[0]), ['nodeId', 'defaultModel', 'reported', 'ids'])
  assert.deepEqual(rows, [{ nodeId: 'n1', defaultModel: 'a', reported: true, ids: ['a'] }])
})

test('input array and nested entries are not mutated', () => {
  const nodes = [
    null,
    { nodeId: 'n1', defaultModel: 'a', models: [{ id: 'a' }, { id: '' }, { id: 'a' }], apiKey: 'private' },
    { nodeId: 'n2', models: null },
    { nodeId: 'n3', models: [] },
  ]
  const before = structuredClone(nodes)
  modelListOf(nodes)
  assert.deepEqual(nodes, before)
  assert.deepEqual(modelListOf([]), [])
})
