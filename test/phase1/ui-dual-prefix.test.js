import test from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_UI_API_PREFIX, UI_API_PREFIX } from '../../src/http/prefix.js'
import { registerUiRoutes } from '../../src/http/routes.js'
import { makeCtx } from './_plugin-ctx.js'

function fixture(t) {
  const ctx = makeCtx()
  const routes = new Map()
  const logs = []
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
    log: (level, message, data) => logs.push({ level, message, data }),
    config: { role: 'hub', stateDir: ctx.stateDir },
  })
  const dispose = () => { for (const d of disposers) d() }
  t.after(() => {
    dispose()
    ctx.cleanup()
  })
  return { routes, disposers, logs, dispose }
}

async function request(routes, pathname, { method = 'GET', headers = {} } = {}) {
  const route = routes.get(pathname)
  assert.ok(route, `missing UI route: ${pathname}`)
  const out = { status: 0, headers: null, body: null }
  await route.handler({ method, url: pathname, headers }, {
    writeHead(status, responseHeaders) { out.status = status; out.headers = responseHeaders },
    end(payload) { out.body = JSON.parse(payload) },
  })
  return out
}

test('every panel UI route is registered under both prefixes', (t) => {
  const { routes, disposers, logs } = fixture(t)
  const paths = [...routes.keys()]
  for (const name of ['overview', 'nodes', 'tasks', 'config']) {
    assert.ok(paths.includes(`/api/ai-cluster/ui/${name}`), `missing new UI route: /api/ai-cluster/ui/${name}`)
    assert.ok(paths.includes(`/api/remote-agent/ui/${name}`), `missing legacy UI route: /api/remote-agent/ui/${name}`)
  }
  assert.equal(UI_API_PREFIX, '/api/ai-cluster/ui')
  assert.equal(LEGACY_UI_API_PREFIX, '/api/remote-agent/ui')
  const suffixes = (prefix) => paths.filter((p) => p.startsWith(`${prefix}/`)).map((p) => p.slice(prefix.length)).sort()
  const current = suffixes(UI_API_PREFIX)
  assert.deepEqual(suffixes(LEGACY_UI_API_PREFIX), current)
  assert.equal(paths.length, current.length * 2, 'only panel UI paths should be registered')
  assert.ok([...routes.values()].every((route) => route.kind === 'exact'))
  assert.equal(disposers.length, paths.length, 'each registered path needs its own disposer')
  assert.deepEqual(logs.find(({ message }) => message === 'ui routes registered')?.data, {
    registered: paths.length, failed: 0, prefix: UI_API_PREFIX,
  })
})

test('both prefixes return the same status, headers and body and retain the guard', async (t) => {
  const { routes } = fixture(t)
  const expectedKeys = {
    overview: ['capabilities', 'connection', 'counts', 'discovery', 'nodes', 'ok', 'topology', 'transportSummary'],
    nodes: ['nodes'],
    tasks: ['tasks'],
    config: ['config', 'ok'],
  }
  for (const [name, keys] of Object.entries(expectedKeys)) {
    const current = await request(routes, `${UI_API_PREFIX}/${name}`)
    assert.equal(current.status, 200)
    assert.deepEqual(Object.keys(current.body).sort(), keys)
    assert.deepEqual(await request(routes, `${LEGACY_UI_API_PREFIX}/${name}`), current)
    for (const prefix of [UI_API_PREFIX, LEGACY_UI_API_PREFIX]) {
      const rejected = await request(routes, `${prefix}/${name}`, { headers: { 'sec-fetch-site': 'cross-site' } })
      assert.equal(rejected.status, 403)
      assert.deepEqual(rejected.body, { error: 'forbidden' })
      const wrongMethod = await request(routes, `${prefix}/${name}`, { method: 'POST' })
      assert.equal(wrongMethod.status, 405)
      assert.deepEqual(wrongMethod.body, { error: 'method' })
    }
  }
})

test('disposing twice removes every path registered by the UI module', (t) => {
  const { routes, dispose } = fixture(t)
  assert.ok(routes.has(`${UI_API_PREFIX}/overview`))
  assert.ok(routes.has(`${LEGACY_UI_API_PREFIX}/overview`))
  dispose()
  assert.equal(routes.size, 0)
  assert.doesNotThrow(dispose)
  assert.equal(routes.size, 0)
})
