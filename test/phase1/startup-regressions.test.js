import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { apply } from '../../lib/index.js'
import { registerUiRoutes } from '../../lib/plugin/http/routes.js'
import { LEGACY_UI_API_PREFIX, UI_API_PREFIX } from '../../lib/plugin/http/prefix.js'
import { makeCtx } from './_plugin-ctx.js'

const prefixes = [UI_API_PREFIX, LEGACY_UI_API_PREFIX]
const suffixes = [
  '/bots', '/models', '/memory', '/node-status', '/overview', '/nodes', '/tasks',
  '/task', '/dispatch', '/cancel', '/approve', '/reject', '/purge', '/pull',
  '/config', '/env-check', '/fix', '/tools', '/share', '/pair-info', '/diag',
  '/templates', '/templates/save', '/templates/delete', '/mint-enroll',
  '/relay-enroll', '/ssh-hosts', '/ssh-probe', '/ssh-deploy',
  '/ssh-deploy/install-runtime', '/relay-autoconfig',
]

// Extend the existing phase1 context with the strict DSH route-table semantics.
function fixture(t) {
  const ctx = makeCtx()
  const routes = new Map()
  const attempts = new Map()
  const errors = []
  ctx.logger.error = (...args) => errors.push(args)
  ctx.set = (name, value) => {
    if (value === undefined) ctx.services.delete(name)
    else ctx.services.set(name, value)
  }
  ctx.webServer = {
    register(route) {
      attempts.set(route.path, (attempts.get(route.path) ?? 0) + 1)
      if (routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    registerUpgrade() { return () => {} },
  }
  ctx.tools = { register() { return () => {} } }
  const config = {
    role: 'hub', uiEnabled: true, stateDir: ctx.stateDir, uiPullRoot: ctx.stateDir,
    listenPort: 0, audit: false, systemPrompt: false, discovery: { enabled: false },
  }
  t.after(() => ctx.cleanup())
  return { ctx, routes, attempts, errors, config }
}

async function request(routes, pathname, method = 'GET') {
  const route = routes.get(pathname)
  assert.equal(route?.kind, 'exact', pathname)
  const response = {}
  await route.handler({ method, url: pathname, headers: {} }, {
    writeHead(status) { response.status = status },
    end(payload) { response.body = JSON.parse(payload) },
  })
  return response
}

test('hub composition registers every UI route once and serves both prefixes', async (t) => {
  const { ctx, routes, attempts, errors, config } = fixture(t)
  let handles
  t.after(() => handles?.dispose())
  assert.doesNotThrow(() => { handles = apply(ctx, config) })
  assert.equal(handles.routes.length, suffixes.length * prefixes.length)
  assert.deepEqual(errors, [], 'registration must not silently catch duplicate routes')
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      const pathname = `${prefix}${suffix}`
      assert.equal(attempts.get(pathname), 1, pathname)
      assert.equal((await request(routes, pathname, 'OPTIONS')).status, 405, pathname)
    }
    const overview = await request(routes, `${prefix}/overview`)
    assert.equal(overview.status, 200)
    assert.equal(overview.body.ok, true)
    assert.deepEqual(overview.body.nodes, [])
    assert.equal(overview.body.capabilities.pullRoot, ctx.stateDir)
    assert.equal(overview.body.capabilities.pull, true)
    assert.ok(overview.body.capabilities.listener, 'retain the hub listener runtime')
  }
  const current = await request(routes, `${UI_API_PREFIX}/config`)
  assert.deepEqual(await request(routes, `${LEGACY_UI_API_PREFIX}/config`), current)
  handles.dispose()
  assert.equal(routes.size, 0)
  assert.deepEqual(errors, [])
  const next = apply(ctx, config)
  t.after(() => next.dispose())
  handles.dispose()
  assert.equal(next.routes.length, suffixes.length * prefixes.length)
  for (const prefix of prefixes) {
    for (const suffix of suffixes) assert.equal(attempts.get(`${prefix}${suffix}`), 2)
  }
  assert.equal((await request(routes, `${UI_API_PREFIX}/overview`)).status, 200)
  assert.deepEqual(errors, [])
})

test('repeated UI registration skips existing routes and can register again after disposal', (t) => {
  const { ctx, routes, attempts, errors, config } = fixture(t)
  const options = { ctx, config, registry: {}, pulls: {}, log: (...args) => {
    if (args[0] === 'error') errors.push(args)
  } }
  const disposers = registerUiRoutes(options)
  t.after(() => disposers.forEach(dispose => dispose()))
  let repeated
  assert.doesNotThrow(() => { repeated = registerUiRoutes(options) })
  assert.equal(repeated.length, 0, 'a repeated call must not take ownership of existing routes')
  assert.equal(routes.size, suffixes.length * prefixes.length)
  assert.ok([...attempts.values()].every(count => count === 1))
  assert.deepEqual(errors, [])
  disposers.forEach(dispose => dispose())
  assert.equal(routes.size, 0)
  const next = registerUiRoutes(options)
  t.after(() => next.forEach(dispose => dispose()))
  disposers.forEach(dispose => dispose())
  assert.equal(routes.size, suffixes.length * prefixes.length)
  assert.ok([...attempts.values()].every(count => count === 2))
  assert.deepEqual(errors, [])
})

test('uiEnabled false leaves hub UI routes unregistered', (t) => {
  const { ctx, routes, config } = fixture(t)
  const handles = apply(ctx, { ...config, uiEnabled: false })
  t.after(() => handles.dispose())
  assert.equal(handles.routes, undefined)
  assert.ok([...routes.keys()].every(pathname => !prefixes.some(prefix => pathname.startsWith(`${prefix}/`))))
})

test('client module and paired slots use dsh-ai-cluster alongside the legacy module', () => {
  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  const modules = new Map([['dsh-remote-agent', {}]])
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(definition) {
      assert.equal(definition.id, 'dsh-ai-cluster')
      assert.equal(modules.has(definition.id), false, 'module id collision')
      modules.set(definition.id, definition)
    } } },
  }, { filename: 'lib/client.js' })
  assert.equal(modules.size, 2)
  const plugin = modules.get('dsh-ai-cluster').factory(id => {
    assert.equal(id, 'react')
    return { createElement() {} }
  })
  const slots = []
  plugin.apply({ slots: {
    inject(_name, callback) { callback() },
    register(definition) { slots.push(definition) },
  } })
  assert.equal(slots.length, 2)
  assert.equal(slots[0].name, 'sidebar.panellist')
  assert.equal(slots[0].id, 'dsh-ai-cluster')
  assert.equal(slots[1].name, 'main')
  assert.equal(slots[1].key, slots[0].id)
  assert.doesNotMatch(source, /['"]dsh-remote-agent['"]/, 'legacy module, panel or slot keys must not remain')
  assert.match(source, /const API = '\/api\/ai-cluster\/ui'/)
  assert.match(source, /const API_FALLBACK = '\/api\/remote-agent\/ui'/)
})
