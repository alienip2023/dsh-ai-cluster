import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../../src/plugin/index.js'
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

// Drive the real apply() -> applyHub -> registerUiRoutes hand-off and capture what the
// route layer receives / serves. Registration is now delegated through the applyHub
// callback, so the call shape is pinned by behavior rather than by source text.
function applyFixture(t, config) {
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    get() { return undefined },
    provide() {},
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => { if (routes.get(route.path) === route) routes.delete(route.path) }
      },
      registerUpgrade() { return () => {} },
    },
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    subagents: { registerProvider: () => () => {} },
  }
  // Isolated stateDir: apply() merges <stateDir>/instance.json over the loader config,
  // so without this the test would read the machine's real instance profile.
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ai-passthrough-'))
  const handles = apply(ctx, { ...config, stateDir })
  t.after(() => {
    handles.dispose?.()
    rmSync(stateDir, { recursive: true, force: true })
  })
  return routes
}

test('plugin hands registerUiRoutes the raw config and defaults through the applyHub callback', async (t) => {
  const config = {
    role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0,
    relayUrl: 'wss://relay.example/ws', sessionGate: true,
  }
  const routes = applyFixture(t, config)
  const view = await request(routes, '/api/ai-cluster/ui/config')
  assert.equal(view.status, 200)
  // raw config reached the route layer (values the normalized defaults could not supply)
  assert.equal(view.body.config.relayUrl, 'wss://relay.example/ws')
  assert.equal(view.body.config.nodeTokenSet, true)
  // config.sessionGate is reachable and takes effect on the route side
  assert.equal(view.body.config.sessionGate, true)
  assert.deepEqual(await request(routes, '/api/remote-agent/ui/config'), view)
})

test('sessionGate defaults to false on the route side when config does not set it', async (t) => {
  const routes = applyFixture(t, { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0 })
  const view = await request(routes, '/api/ai-cluster/ui/config')
  assert.equal(view.body.config.sessionGate, false)
})
