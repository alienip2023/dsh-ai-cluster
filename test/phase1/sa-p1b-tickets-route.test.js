import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAdmission } from '../../src/admission/index.js'
import { LEGACY_UI_API_PREFIX, registerUiRoutes, UI_API_PREFIX } from '../../src/http/routes.js'

const prefixes = [UI_API_PREFIX, LEGACY_UI_API_PREFIX]
const cookie = 'dsh-auth-x=v1.abc.def'

function register(admission) {
  const handlers = new Map()
  registerUiRoutes({
    admission,
    log() {},
    ctx: {
      webServer: {
        register(route) {
          assert.equal(route.kind, 'exact')
          handlers.set(route.path, route.handler)
          return () => handlers.delete(route.path)
        },
      },
      // Same host Connection fixture as the guard test in test/ui-routes.test.js.
      // Requests still go through registerUiRoutes' real guard and response writer.
      connection: {
        requestRejection({ headers }) {
          if (headers.origin !== undefined && headers.origin !== 'http://127.0.0.1') return 403
          return headers.cookie ? undefined : 401
        },
      },
    },
  })
  return async (method = 'GET', prefix = UI_API_PREFIX, headers = { cookie }) => {
    const url = `${prefix}/tickets`
    const handler = handlers.get(url)
    assert.ok(handler, `missing exact route ${url}`)
    const response = {}
    await handler({ method, url, headers: { host: '127.0.0.1', ...headers } }, {
      writeHead(status) { response.status = status },
      end(payload) { response.body = JSON.parse(payload) },
    })
    return response
  }
}

function admissionWithStore(t, list, openStore) {
  const store = {
    list,
    recoveryReport: () => ({ inFlight: [], openWithoutExecutor: [], ended: 0, interrupted: 0 }),
    close() {},
  }
  const admission = createAdmission({
    enabled: true, ledgerDir: 'p1b-memory-fixture', scope: { nodes: ['n'] }, aliases: { n: 'node' },
  }, { openStore: openStore ?? (() => store), wait: async () => {} })
  t.after(() => admission.dispose())
  return admission
}

function ticket(ticketId, state = 'open', executorRef = null) {
  return { ticketId, state, executorRef, origin: {}, replyTo: {}, mandateRef: {}, reason: 'private', createdAt: 1 }
}

const ok = tickets => ({ status: 200, body: { tickets } })

test('tickets route returns null for a disabled gate on both prefixes', async () => {
  const request = register(createAdmission({ enabled: false }))
  for (const prefix of prefixes) assert.deepEqual(await request('GET', prefix), ok(null))
})

test('tickets route returns null before readiness and after disposal', async (t) => {
  const admission = admissionWithStore(t, () => [])
  assert.equal(admission.ticketView(), null)
  const request = register(admission)
  assert.deepEqual(await request(), ok(null))
  await admission.ready
  assert.deepEqual(await request(), ok([]))
  admission.dispose()
  assert.deepEqual(await request(), ok(null))
})

test('tickets route returns null on an unavailable ledger or list failure', async (t) => {
  for (const code of ['TICKET_LOCKED', 'TICKET_STORE_FAILED']) {
    const admission = admissionWithStore(t, undefined, () => {
      throw Object.assign(new Error('private store error'), { code })
    })
    await admission.ready
    assert.deepEqual(await register(admission)(), ok(null))
  }
  const admission = admissionWithStore(t, () => { throw new Error('private list error') })
  await admission.ready
  assert.equal(admission.ticketView(), null)
  assert.deepEqual(await register(admission)(), ok(null))
})

test('tickets route returns an empty array for an open empty ledger', async (t) => {
  const admission = admissionWithStore(t, () => [])
  await admission.ready
  const request = register(admission)
  for (const prefix of prefixes) assert.deepEqual(await request('GET', prefix), ok([]))
})

test('ticketView rows have exactly three keys', async (t) => {
  const admission = admissionWithStore(t, () => [
    ticket('tk_z', 'open', { kind: 'cluster-task', ref: 't-tk_z' }),
    ticket(17), null, ticket('tk_bad', {}), ticket('tk_a', 'interrupted'), ticket('tk_end', 'ended'),
  ])
  await admission.ready
  const request = register(admission)
  for (const prefix of prefixes) {
    const result = await request('GET', prefix)
    assert.equal(result.status, 200)
    for (const row of result.body.tickets) {
      assert.deepEqual(Object.keys(row).sort(), ['hasExecutor', 'state', 'ticketId'], 'ticketView 只能含 ticketId,state,hasExecutor')
    }
    assert.deepEqual(result, ok([
      { ticketId: 'tk_z', state: 'open', hasExecutor: true },
      { ticketId: 'tk_a', state: 'interrupted', hasExecutor: false },
      { ticketId: 'tk_end', state: 'ended', hasExecutor: false },
    ]))
  }
})

test('tickets route rejects non-GET with 405', async () => {
  let calls = 0
  const request = register({ ticketView() { calls++; return [] } })
  for (const prefix of prefixes) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.deepEqual(await request(method, prefix), { status: 405, body: { error: 'method' } }, '/tickets 非 GET 必须返回 405')
    }
  }
  assert.equal(calls, 0)
})

test('tickets route polls live state without mutating the ledger', async (t) => {
  const rows = [ticket('tk_first')]
  const admission = admissionWithStore(t, () => rows)
  await admission.ready
  const request = register(admission)
  const first = await request()
  assert.deepEqual(first, ok([{ ticketId: 'tk_first', state: 'open', hasExecutor: false }]))
  assert.deepEqual(await request(), first)
  assert.deepEqual(rows, [ticket('tk_first')])
  rows[0].state = 'ended'
  assert.deepEqual(await request(), ok([{ ticketId: 'tk_first', state: 'ended', hasExecutor: false }]))
})

test('tickets route returns null when ticketView throws', async () => {
  const request = register({ ticketView() { throw new Error('private ticket view error') } })
  assert.deepEqual(await request(), ok(null))
})

test('tickets route enforces the registered UI guard on both prefixes', async () => {
  let calls = 0
  const request = register({ ticketView() { calls++; return [] } })
  for (const prefix of prefixes) {
    assert.deepEqual(await request('GET', prefix, {}), { status: 401, body: { error: 'unauthorized' } })
    assert.deepEqual(await request('GET', prefix, { cookie, origin: 'http://other' }), { status: 403, body: { error: 'forbidden' } })
  }
  assert.equal(calls, 0)
})

test('tickets route test exercises the admission seam without importing src/tickets', () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  assert.doesNotMatch(source, /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"][^'"\r\n]*src\/tickets\//)
})
