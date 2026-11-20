import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAssignmentLedger } from '../../lib/hub/assignment-ledger.js'
import { NodeRegistry } from '../../lib/hub/node-registry.js'
import { registerUiRoutes, UI_API_PREFIX } from '../../lib/hub/ui-routes.js'
import { NODE_TO_HUB } from '../../lib/protocol.js'

const nodeId = 'worker'
const retainMs = 60_000

function makeRegistry(t, log = () => {}) {
  const registry = new NodeRegistry({
    log,
    limits: { taskViewRetainMs: retainMs, ackTimeoutMs: 0, helloTimeoutMs: 10_000 },
  })
  t.after(() => registry.dispose())
  registry.assignmentLedger = createAssignmentLedger({ file: '' })
  const rec = registry.ingestHello({
    helloData: { nodeId, protocol: 1, os: 'windows', nonce: '', time: Date.now() },
    conn: { send() {}, close() {} },
    transport: 'direct',
    pending: undefined,
  })
  assert.ok(rec)
  return { registry, rec, ledger: registry.assignmentLedger }
}

test('LEDGER-APPEND', () => {
  let at = 10
  const ledger = createAssignmentLedger({ file: '', now: () => at++ })
  const view = { taskId: 'a', nodeId, status: 'running', goal: 'private', workspace: '/private', logTail: ['private'] }
  ledger.record(view)
  ledger.record({ ...view, status: 'completed', startedAt: 1 })
  ledger.record({ ...view, status: 'completed', startedAt: 1 })
  assert.deepEqual(ledger.list(), [
    { taskId: 'a', nodeId, status: 'completed', startedAt: 1, endedAt: 0, at: 11 },
    { taskId: 'a', nodeId, status: 'running', startedAt: 0, endedAt: 0, at: 10 },
  ])
  ledger.record({ ...view, status: 'completed', startedAt: 1, endedAt: 2 })
  assert.deepEqual(ledger.list().map(row => row.endedAt), [2, 0, 0])
})

test('LEDGER-CAP', () => {
  const max = 55
  const ledger = createAssignmentLedger({ file: '', max })
  assert.throws(() => createAssignmentLedger({ file: '', max: 0 }), RangeError)
  for (let i = 0; i < max + 5; i++) ledger.record({ taskId: `task-${i}`, nodeId, status: 'running' })
  assert.equal(ledger.list().length, 50)
  const rows = ledger.list({ limit: max + 5 })
  assert.equal(rows.length, max)
  assert.equal(rows[0].taskId, 'task-59')
  assert.equal(rows.at(-1).taskId, 'task-5')
  assert.ok(!rows.some(row => row.taskId === 'task-0'))
})

test('LEDGER-RESTART', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assignment-ledger-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'assignment-ledger.json')
  const warnings = []
  const log = (level) => warnings.push(level)
  const ledger = createAssignmentLedger({ file, log })
  assert.deepEqual(ledger.list(), [])
  for (const taskId of ['a', 'b', 'c']) ledger.record({ taskId, nodeId, status: 'completed', endedAt: 3 })
  const restarted = createAssignmentLedger({ file, log })
  assert.deepEqual(restarted.list(), ledger.list())
  assert.deepEqual(restarted.list().map(row => row.taskId), ['c', 'b', 'a'])
  restarted.record({ taskId: 'a', nodeId, status: 'completed', endedAt: 3 })
  assert.deepEqual(restarted.list(), ledger.list())
  assert.deepEqual(warnings, [])

  fs.writeFileSync(file, '{broken')
  assert.deepEqual(createAssignmentLedger({ file, log }).list(), [])
  assert.deepEqual(warnings, ['warn'])
})

test('LEDGER-PRUNE-KEEPS', (t) => {
  const pruning = []
  const { registry, rec, ledger } = makeRegistry(t, (_level, message, data) => {
    if (message === 'pruned old task views') pruning.push(data.pruned)
  })
  const endedAt = Date.now() - 2 * retainMs
  registry.applySync(nodeId, {
    tasks: [{ taskId: 'old', status: 'completed', endedAt, logTail: ['private'] }],
  })
  assert.deepEqual(pruning, [1])
  assert.ok(!registry.tasks.has('old'))
  assert.ok(!rec.tasks.has('old'))
  assert.deepEqual(ledger.list().map(({ at, ...row }) => row), [
    { taskId: 'old', nodeId, status: 'completed', startedAt: 0, endedAt },
  ])
})

test('LEDGER-PURGE-KEEPS', (t) => {
  const { registry, rec, ledger } = makeRegistry(t)
  const endedAt = Date.now()
  registry.handleFrameFor(nodeId, { t: NODE_TO_HUB.TASK_END, d: { taskId: 'done', status: 'completed', endedAt } })
  assert.equal(registry.tasks.size, 1)
  assert.equal(rec.tasks.size, 1)
  const rows = ledger.list()
  assert.deepEqual(rows.map(({ taskId, status, endedAt }) => ({ taskId, status, endedAt })), [
    { taskId: 'done', status: 'completed', endedAt },
  ])
  assert.deepEqual(registry.purgeTasks(), { removed: 1, kept: 0 })
  assert.equal(registry.tasks.size, 0)
  assert.equal(rec.tasks.size, 0)
  assert.deepEqual(ledger.list(), rows)
})

test('LEDGER-NO-FRAME', () => {
  const source = fs.readFileSync(new URL('../../lib/hub/assignment-ledger.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /send\(|sendViaHub|NODE_TO_HUB/)
})

test('ROUTE-GET', async (t) => {
  const assignmentLedger = createAssignmentLedger({ file: '' })
  assignmentLedger.record({ taskId: 'a', nodeId, status: 'running' })
  assignmentLedger.record({ taskId: 'b', nodeId: 'other', status: 'running' })
  assignmentLedger.record({ taskId: 'c', nodeId, status: 'running' })
  const registry = { assignmentLedger }
  const routes = new Map()
  const disposers = registerUiRoutes({
    ctx: { webServer: { register(route) { routes.set(route.path, route); return () => {} } } },
    config: { role: 'hub' }, registry, pulls: {}, log() {},
  })
  t.after(() => { for (const dispose of disposers) dispose() })
  const pathname = `${UI_API_PREFIX}/assignments`
  const route = routes.get(pathname)
  assert.ok(route)

  async function request(method = 'GET', query = '') {
    let status, body
    await route.handler({ method, url: pathname + query, headers: {} }, {
      writeHead(code) { status = code },
      end(raw) { body = JSON.parse(raw) },
    })
    return { status, body }
  }

  const rows = assignmentLedger.list()
  assert.deepEqual(rows.map(row => row.taskId), ['c', 'b', 'a'])
  assert.deepEqual(await request(), { status: 200, body: { assignments: rows } })
  assert.equal((await request('POST')).status, 405)
  assert.deepEqual(await request('GET', '?node=unknown'), { status: 200, body: { assignments: [] } })
  assert.deepEqual(await request('GET', '?node=worker&limit=1'), { status: 200, body: { assignments: [rows[0]] } })
  delete registry.assignmentLedger
  assert.deepEqual(await request(), { status: 200, body: { assignments: [] } })
})
