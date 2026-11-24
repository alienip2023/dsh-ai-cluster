import assert from 'node:assert/strict'
import test from 'node:test'
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
