import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { registerUiRoutes as registerSourceRoutes } from '../../src/http/routes.js'
import { registerUiRoutes as registerRuntimeRoutes } from '../../lib/plugin/http/routes.js'

for (const [layer, registerUiRoutes] of [['source', registerSourceRoutes], ['runtime', registerRuntimeRoutes]]) {
  test(`${layer} /ui/memory returns the compatibility stub`, async () => {
    const routes = new Map()
    registerUiRoutes({
      ctx: { webServer: { register(route) { routes.set(route.path, route) } } },
      log() {},
    })

    for (const path of ['/api/ai-cluster/ui/memory', '/api/remote-agent/ui/memory']) {
      const route = routes.get(path)
      assert.equal(route?.kind, 'exact', path)
      let status, body
      await route.handler({ method: 'GET', url: path, headers: {} }, {
        writeHead(code) { status = code },
        end(payload) { body = JSON.parse(payload) },
      })
      assert.equal(status, 200, path)
      assert.deepEqual(body, {
        ok: false, code: 'not-available', screen: 'S4', reason: 'memory-store-not-built',
      }, path)
    }
  })
}

const clientSource = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')

test('memory screen reads scopes via POST /api/bot and preserves success and missing outcomes', async () => {
  assert.match(clientSource, /\bmemoryScopes\(\)\.then\(/, 'the screen must read through memoryScopes')

  const calls = []
  const value = { team: { entries: 0 }, nodes: [] }
  let status = 200
  let client
  runInNewContext(clientSource, {
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) })
      return { status, text: async () => JSON.stringify({ ok: true, value }) }
    },
    window: { __ModuleLoader__: { load(module) { client = module.factory(() => ({})) } } },
  }, { filename: 'lib/client.js' })

  assert.deepEqual(JSON.parse(JSON.stringify(await client.memoryScopes())), value)
  assert.deepEqual(calls, [{
    url: '/api/bot', method: 'POST', body: { endpoint: 'memory-hub-scopes', payload: {} },
  }])

  status = 404
  await assert.rejects(client.memoryScopes(), { missing: true, reason: 'memory-api-missing' })
})
