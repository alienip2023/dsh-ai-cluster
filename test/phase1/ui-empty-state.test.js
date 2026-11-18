import test from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_UI_API_PREFIX, UI_API_PREFIX } from '../../src/http/prefix.js'
import { registerUiRoutes } from '../../src/http/routes.js'
import { makeCtx } from './_plugin-ctx.js'

const prefixes = [UI_API_PREFIX, LEGACY_UI_API_PREFIX]
const screens = [
  { name: 'bots', screen: 'S1', reason: null }, // p3-s1：不再是桩，由 ui-p3-s1-roster.test.js 覆盖数据契约
  { name: 'models', screen: 'S3', reason: null }, // p3-s3：不再是桩，由 ui-p3-s3-models.test.js 覆盖数据契约
  { name: 'memory', screen: 'S4', reason: 'memory-store-not-built' },
]

function fixture(t, registry = { list: () => [], listTasks: () => [], rosterList: () => [], modelList: () => [] }) {
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
  const config = { role: 'hub', stateDir: ctx.stateDir }
  const disposers = registerUiRoutes({
    ctx, registry, pulls: { activeCount: 0 }, log() {}, config,
  })
  t.after(() => {
    for (const dispose of disposers) dispose()
    ctx.cleanup()
  })
  return { routes, config }
}

async function request(routes, pathname, { method = 'GET', headers = {}, query = '', body } = {}) {
  const route = routes.get(pathname)
  assert.ok(route, `missing UI route: ${pathname}`)
  const out = { status: 0, headers: null, body: null }
  await route.handler({
    method, url: `${pathname}${query}`, headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }, {
    writeHead(status, responseHeaders) { out.status = status; out.headers = responseHeaders },
    end(payload) { out.body = JSON.parse(payload) },
  })
  return out
}

const stripAt = (r) => { const { at, ...rest } = r.body ?? {}; return { ...r, body: rest } }

for (const { name, screen, reason } of screens) {
  const expected = { ok: false, code: 'not-available', screen, reason }

  if (reason === null) test(`${name} is served by its registry store: exact routes, empty store is ok:true,total:0`, async (t) => {
    const { routes } = fixture(t)
    for (const prefix of prefixes) {
      const pathname = `${prefix}/${name}`
      assert.equal(routes.get(pathname)?.kind, 'exact')
      const r = await request(routes, pathname)
      assert.equal(r.status, 200)
      assert.equal(r.body.ok, true)
      assert.equal(r.body.total, 0)
      assert.deepEqual(r.body.nodes, [])
    }
  })

  else test(`${name} registers exact routes under both prefixes with identical refusals`, async (t) => {
    const { routes } = fixture(t)
    const current = await request(routes, `${UI_API_PREFIX}/${name}`)
    assert.equal(current.status, 200)
    assert.deepEqual(current.headers, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    assert.deepEqual(current.body, expected)
    assert.deepEqual(Object.keys(current.body).sort(), ['code', 'ok', 'reason', 'screen'])
    for (const prefix of prefixes) {
      const pathname = `${prefix}/${name}`
      assert.equal(routes.get(pathname)?.kind, 'exact')
      assert.deepEqual(await request(routes, pathname), current)
    }
  })

  test(`${name} rejects non-GET methods and cross-site GETs under both prefixes`, async (t) => {
    const { routes } = fixture(t)
    for (const prefix of prefixes) {
      const pathname = `${prefix}/${name}`
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        const response = await request(routes, pathname, { method })
        assert.equal(response.status, 405)
        assert.deepEqual(response.body, { error: 'method' })
      }
      const response = await request(routes, pathname, { headers: { 'sec-fetch-site': 'cross-site' } })
      assert.equal(response.status, 403)
      assert.deepEqual(response.body, { error: 'forbidden' })
    }
  })

  test(`${name} ignores query scope and JSON bodies under both prefixes`, async (t) => {
    const { routes } = fixture(t)
    for (const prefix of prefixes) {
      const pathname = `${prefix}/${name}`
      const current = stripAt(await request(routes, pathname))
      for (const input of [
        { query: '?scope=pc-b' },
        { headers: { 'content-type': 'application/json' }, body: { scope: 'pc-b', items: ['invented'] } },
        { query: '?scope=pc-b', headers: { 'content-type': 'application/json' }, body: { scope: 'all' } },
      ]) {
        assert.deepEqual(stripAt(await request(routes, pathname, input)), current)
      }
    }
  })
}

test('empty-state refusals do not read the registry or config', async (t) => {
  let listCalls = 0
  let taskCalls = 0
  const { routes, config } = fixture(t, {
    list() { listCalls += 1; return [{ nodeId: 'pc-b' }] },
    listTasks() { taskCalls += 1; return [] },
  })
  for (const key of Object.keys(config)) delete config[key]
  Object.setPrototypeOf(config, new Proxy({}, {
    get(_target, key) { assert.fail(`empty-state routes must not read config.${String(key)}`) },
  }))
  for (const { name, screen, reason } of screens.filter((x) => x.reason !== null)) {
    for (const prefix of prefixes) {
      const response = await request(routes, `${prefix}/${name}`)
      assert.equal(response.status, 200)
      assert.deepEqual(response.body, { ok: false, code: 'not-available', screen, reason })
    }
  }
  assert.equal(listCalls, 0)
  assert.equal(taskCalls, 0)
})

test('node-status still returns a successful empty snapshot under both prefixes', async (t) => {
  let listCalls = 0
  const { routes } = fixture(t, {
    list() { listCalls += 1; return [] },
  })
  for (const prefix of prefixes) {
    const pathname = `${prefix}/node-status`
    assert.equal(routes.get(pathname)?.kind, 'exact')
    const response = await request(routes, pathname)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { ok: true, heartbeatMs: 15000, nodes: [] })
    assert.equal(Object.hasOwn(response.body, 'code'), false)
  }
  assert.equal(listCalls, prefixes.length)
})
