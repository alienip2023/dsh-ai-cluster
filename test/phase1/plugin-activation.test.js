import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/plugin/index.js'
import { makeCtx } from './_plugin-ctx.js'

function fixture(t) {
  const ctx = makeCtx()
  const tools = new Map()
  const toolNames = []
  const routes = new Map()
  const upgrades = new Map()
  const events = []
  const register = (table, key, value, kind) => {
    assert.equal(table.has(key), false, `duplicate ${kind}: ${key}`)
    table.set(key, value)
    events.push(`register ${key}`)
    return () => {
      if (table.get(key) !== value) return
      table.delete(key)
      events.push(`dispose ${key}`)
    }
  }
  ctx.tools = {
    register: (def) => {
      toolNames.push(def.name)
      return register(tools, def.name, def, 'tool')
    },
  }
  ctx.webServer = {
    register: (route) => register(routes, route.path, route, 'route'),
    registerUpgrade: (route) => register(upgrades, route.path, route, 'upgrade'),
  }
  ctx.systemPrompt = { section: () => () => {} }
  ctx.set = (name, value) => {
    assert.ok(ctx.services.has(name), `service not provided: ${name}`)
    ctx.services.set(name, value)
  }
  const activate = (role) => apply(ctx, { role, stateDir: ctx.stateDir, listenPort: 0, audit: false })
  t.after(() => {
    // Also releases a generation whose registration threw before apply returned.
    try { activate('').dispose() } finally { ctx.cleanup() }
  })
  return { ctx, tools, toolNames, routes, events, activate }
}

test('hub apply registers cluster tools', (t) => {
  const { tools, toolNames, activate } = fixture(t)
  activate('hub')
  assert.ok(tools.has('cluster_nodes'), 'cluster_nodes was not registered')
  assert.ok(tools.has('cluster_task'), 'cluster_task was not registered')
  assert.equal(new Set(toolNames).size, toolNames.length, 'tool names must be registered only once')
  assert.ok(tools.has('node_jobs'), 'node_jobs was not registered')
  assert.equal(toolNames.filter((name) => name === 'node_jobs').length, 1, 'node_jobs must be registered exactly once')
})

test('hub apply registers UI routes', (t) => {
  const { routes, activate } = fixture(t)
  activate('hub')
  assert.ok([...routes.keys()].some((path) => path.startsWith('/api/ai-cluster/ui')))
})

test('worker apply tolerates webServer without inject and registers no hub tools or UI routes', async (t) => {
  const { ctx, tools, routes, activate } = fixture(t)
  Object.defineProperty(ctx, 'webServer', {
    configurable: true,
    get() { throw new Error('cannot get property "webServer" without inject') },
  })
  let handles
  assert.doesNotThrow(() => { handles = activate('worker') })
  // Let the dynamic worker import finish; no hub URL means no network dialing.
  await import('../../lib/node/index.js')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal([...tools.keys()].some((name) => name.startsWith('cluster_')), false)
  assert.equal([...routes.keys()].some((path) => path.startsWith('/api/ai-cluster/ui')), false)
  handles.dispose()
})

test('unconfigured apply registers no cluster tools or UI routes', (t) => {
  const { tools, routes, activate } = fixture(t)
  activate('')
  assert.equal([...tools.keys()].some((name) => name.startsWith('cluster_')), false)
  assert.equal([...routes.keys()].some((path) => path.startsWith('/api/ai-cluster/ui')), false)
})

test('reapply disposes cluster tools before registering the next generation', (t) => {
  const { tools, events, activate } = fixture(t)
  const first = activate('hub')
  assert.ok(tools.has('cluster_nodes'), 'cluster_nodes was not registered')
  const second = activate('hub')
  assert.deepEqual(events.filter((event) => event.endsWith(' cluster_nodes')), [
    'register cluster_nodes', 'dispose cluster_nodes', 'register cluster_nodes',
  ])
  first.dispose()
  assert.ok(tools.has('cluster_nodes'))
  second.dispose()
  assert.equal(tools.has('cluster_nodes'), false)
})

test('disposing handles removes cluster tools and UI routes', (t) => {
  const { tools, routes, activate } = fixture(t)
  const handles = activate('hub')
  assert.ok(tools.has('cluster_nodes'), 'cluster_nodes was not registered')
  handles.dispose()
  assert.equal(tools.has('cluster_nodes'), false)
  assert.equal([...routes.keys()].some((path) => path.startsWith('/api/ai-cluster/ui')), false)
  assert.doesNotThrow(() => handles.dispose())
})

test('dispose runs hub, tools, routes, setup, worker, role despite disposer failures', (t) => {
  const { ctx, activate } = fixture(t)
  const order = []
  const provide = ctx.provide.bind(ctx)
  ctx.provide = (name, value) => {
    const dispose = provide(name, value)
    return () => {
      if (name === 'ai-cluster:role') order.push('role')
      dispose()
    }
  }
  const handles = activate('')
  const disposer = (label, fail = false) => () => {
    order.push(label)
    if (fail) throw new Error(`${label} failed`)
  }
  handles.hub = { disposeAll: disposer('hub', true) }
  handles.tools = [disposer('tool 1', true), disposer('tool 2')]
  handles.routes = [disposer('route 1', true), disposer('route 2')]
  handles.setup.push(disposer('setup', true))
  handles.worker = disposer('worker', true)
  assert.doesNotThrow(() => handles.dispose())
  assert.deepEqual(order, ['hub', 'tool 1', 'tool 2', 'route 1', 'route 2', 'setup', 'worker', 'role'])
  handles.dispose()
  assert.equal(order.length, 8)
})
