import test from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_ALIASES } from '../../src/compat/ra-names.js'
import { registerClusterTools } from '../../src/tools/register.js'

function setup(registry = {}) {
  const tools = new Map()
  const calls = []
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        calls.push(definition)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { tools, calls, register: () => registerClusterTools({ ctx, registry }) }
}

test('registers exactly 23 cluster tools, 23 aliases, and one node_jobs', () => {
  const { tools, calls, register } = setup()
  const disposers = register()
  const aliases = Object.entries(TOOL_ALIASES)
  assert.equal(aliases.length, 23)
  assert.deepEqual(new Set(tools.keys()), new Set([...aliases.flat(), 'node_jobs']))
  assert.equal(calls.length, 47)
  assert.equal(calls.filter(({ name }) => name === 'node_jobs').length, 1)
  assert.equal(disposers.length, 47)
})

test('aliases share the same handler, schemas, and description as their cluster tools', () => {
  const { tools, register } = setup()
  register()
  assert.strictEqual(tools.get('remote_nodes').execute, tools.get('cluster_nodes').execute)
  for (const [alias, name] of Object.entries(TOOL_ALIASES)) {
    const oldTool = tools.get(alias)
    const tool = tools.get(name)
    assert.strictEqual(oldTool.execute, tool.execute, alias)
    assert.strictEqual(oldTool.parameters, tool.parameters, alias)
    assert.strictEqual(oldTool.output, tool.output, alias)
    assert.equal(oldTool.description, tool.description, alias)
  }
})

test('each nodes handler calls the underlying registry function once per invocation', async (t) => {
  const list = t.mock.fn(() => [])
  const { tools, register } = setup({ list })
  register()
  const args = {}
  const context = {}
  assert.equal(list.mock.callCount(), 0)
  const clusterResult = await tools.get('cluster_nodes').execute(args, context)
  assert.equal(list.mock.callCount(), 1)
  const remoteResult = await tools.get('remote_nodes').execute(args, context)
  assert.equal(list.mock.callCount(), 2)
  assert.deepEqual(remoteResult, clusterResult)
})

test('leaves remote_file and remote_screenshot to the advanced registrar', () => {
  const { tools, register } = setup()
  register()
  assert.equal(tools.has('remote_file'), false)
  assert.equal(tools.has('remote_screenshot'), false)
})

test('disposing removes both names and allows registration again with one node_jobs', () => {
  const { tools, calls, register } = setup()
  const disposers = register()
  const names = new Set(tools.keys())
  for (const dispose of disposers) dispose()
  assert.equal(tools.size, 0)

  const previousCalls = calls.length
  let nextDisposers
  assert.doesNotThrow(() => { nextDisposers = register() })
  assert.deepEqual(new Set(tools.keys()), names)
  assert.equal(tools.size, 47)
  assert.equal(calls.slice(previousCalls).filter(({ name }) => name === 'node_jobs').length, 1)
  for (const dispose of nextDisposers) dispose()
  assert.equal(tools.size, 0)
})
