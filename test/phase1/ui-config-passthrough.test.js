import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerUiRoutes } from '../../src/http/routes.js'
import { makeCtx } from './_plugin-ctx.js'

function fixture(t, config) {
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
  const disposers = registerUiRoutes({
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

test('plugin passes raw config alongside defaults and sessionGate to registerUiRoutes', () => {
  const source = readFileSync(new URL('../../src/plugin/index.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /handles\.routes\s*=\s*registerUiRoutes\(\{\s*ctx, registry, pulls, log, defaults, sessionGate: handles\.hub\.sessionGate, config\s*\}\)/,
    'registerUiRoutes must receive config with defaults and sessionGate',
  )
})
