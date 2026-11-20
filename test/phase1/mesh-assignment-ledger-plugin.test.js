import assert from 'node:assert/strict'
import test from 'node:test'
import { registerUiRoutes } from '../../src/http/routes.js'

const prefixes = ['/api/ai-cluster/ui', '/api/remote-agent/ui']

function register(t, registry) {
  const routes = new Map()
  const disposers = registerUiRoutes({
    ctx: {
      webServer: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    config: { role: 'hub' },
    registry,
    pulls: {},
    log() {},
  })
  t.after(() => { for (const dispose of disposers) dispose() })

  return async (prefix, { method = 'GET', query = '' } = {}) => {
    const pathname = `${prefix}/assignments`
    const route = routes.get(pathname)
    assert.ok(route, `missing UI route: ${pathname}`)
    const response = {}
    await route.handler({ method, url: pathname + query, headers: {} }, {
      writeHead(status) { response.status = status },
      end(raw) { response.body = JSON.parse(raw) },
    })
    return response
  }
}

for (const prefix of prefixes) {
  test(`assignment ledger GET and query options on ${prefix}`, async (t) => {
    const rows = [{ taskId: 'task-1', nodeId: 'worker 1', status: 'running' }]
    const list = t.mock.fn(() => rows)
    const request = register(t, { assignmentLedger: { list } })
    const expected = { status: 200, body: { assignments: rows } }

    assert.deepEqual(await request(prefix), expected)
    assert.deepEqual(await request(prefix, { query: '?node=worker%201&limit=2' }), expected)
    assert.deepEqual(list.mock.calls.map(({ arguments: args }) => args), [
      [{ nodeId: undefined, limit: undefined }],
      [{ nodeId: 'worker 1', limit: 2 }],
    ])
  })

  test(`assignment ledger rejects POST on ${prefix}`, async (t) => {
    const list = t.mock.fn(() => [])
    const request = register(t, { assignmentLedger: { list } })

    assert.deepEqual(await request(prefix, { method: 'POST' }), { status: 405, body: { error: 'method' } })
    assert.equal(list.mock.callCount(), 0)
  })

  test(`assignment ledger GET without a ledger on ${prefix}`, async (t) => {
    const request = register(t, {})

    assert.deepEqual(await request(prefix), { status: 200, body: { assignments: [] } })
  })
}
