import test from 'node:test'
import assert from 'node:assert/strict'
import { applyHub as sourceApplyHub } from '../../lib/hub/index.js'
import { applyHub as generatedApplyHub } from '../../lib/plugin/_lib/hub/index.js'
import { registerUiRoutes } from '../../src/http/routes.js'
import { makeCtx } from './_plugin-ctx.js'

function fixture(t, config, assemble) {
  const ctx = makeCtx()
  const routes = new Map()
  ctx.webServer = {
    register(route) {
      assert.equal(routes.has(route.path), false, `duplicate route: ${route.path}`)
      routes.set(route.path, route)
      return () => {
        if (routes.get(route.path) === route) routes.delete(route.path)
      }
    },
  }
  const disposers = assemble ? assemble(ctx) : registerUiRoutes({
    ctx,
    registry: { list: () => [], listTasks: () => [] },
    pulls: { activeCount: 0 },
    log() {},
    config,
  })
  t.after(() => {
    for (const dispose of disposers) dispose()
    ctx.cleanup()
  })
  return routes
}

async function request(routes, pathname) {
  const route = routes.get(pathname)
  assert.ok(route, `missing UI route: ${pathname}`)
  const out = { status: 0, headers: null, body: null }
  await route.handler({ method: 'GET', url: pathname, headers: {} }, {
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(payload) { out.body = JSON.parse(payload) },
  })
  return out
}

test('config routes expose raw config safely and identically under both prefixes', async (t) => {
  const routes = fixture(t, {
    role: 'worker', nodeToken: 'secret-token', relayUrl: 'wss://relay.example/ws',
  })
  const current = await request(routes, '/api/ai-cluster/ui/config')
  assert.equal(current.status, 200)
  assert.equal(current.body.config.role, 'worker')
  assert.equal(current.body.config.nodeTokenSet, true)
  assert.equal(current.body.config.relayUrl, 'wss://relay.example/ws')
  assert.equal(JSON.stringify(current.body).includes('secret-token'), false)
  assert.deepEqual(
    Object.keys(current.body.config).filter((key) => /nodeToken/i.test(key)),
    ['nodeTokenSet'],
  )
  assert.deepEqual(await request(routes, '/api/remote-agent/ui/config'), current)
})

test('empty config preserves the default panel config', async (t) => {
  const routes = fixture(t, {})
  const current = await request(routes, '/api/ai-cluster/ui/config')
  assert.equal(current.status, 200)
  assert.equal(current.body.config.role, 'hub')
  assert.equal(current.body.config.nodeTokenSet, false)
  assert.equal(current.body.config.relayUrl, '')
})

for (const [name, applyHub] of [['source', sourceApplyHub], ['generated', generatedApplyHub]]) {
  test(`${name} hub passes raw config, defaults and sessionGate to the injected UI registrar`, async (t) => {
    const config = {
      role: 'hub', uiEnabled: true, sessionGate: true,
      defaults: { timeoutMs: 4321 }, nodeToken: 'secret-token',
      listenPort: 0, audit: false, systemPrompt: false, discovery: { enabled: false },
    }
    const registrations = []
    let hub
    const routes = fixture(t, config, (ctx) => {
      config.stateDir = ctx.stateDir
      ctx.webServer.registerUpgrade = () => () => {}
      ctx.tools = { register: () => () => {} }
      hub = applyHub(ctx, config, {
        registerUiRoutes(options) {
          registrations.push(options)
          assert.equal(options.ctx, ctx)
          return registerUiRoutes(options)
        },
      })
      return [() => hub.disposeAll()]
    })
    assert.equal(registrations.length, 1, 'the injected registrar must be called exactly once')
    const options = registrations[0]
    assert.equal(options.config, config, 'pass the raw config object')
    assert.deepEqual(options.defaults, config.defaults)
    assert.equal(options.sessionGate, hub.sessionGate)
    assert.equal(options.sessionGate.required, true)
    assert.equal(options.registry, hub.registry)
    assert.equal(options.pulls, hub.pulls)
    assert.equal(typeof options.log, 'function')

    const current = await request(routes, '/api/ai-cluster/ui/config')
    assert.equal(current.status, 200)
    assert.equal(current.body.ok, true)
    assert.equal(current.body.config.role, config.role)
    assert.equal(current.body.config.uiEnabled, true)
    assert.equal(current.body.config.sessionGate, true)
    assert.equal(current.body.config.nodeTokenSet, true)
    assert.equal(JSON.stringify(current.body).includes(config.nodeToken), false)
    assert.deepEqual(await request(routes, '/api/remote-agent/ui/config'), current)
  })
}
