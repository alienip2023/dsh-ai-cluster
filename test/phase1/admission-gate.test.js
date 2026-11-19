import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ADMISSION_REJECTED, createAdmission } from '../../src/admission/index.js'
import { AUTHZ_REASON_CODES, decideAuthorization } from '../../src/authz/decide.js'
import {
  config, currentRoutes, deferred, fakeHost, fakeRegistry, goal, identity, ledgerHarness,
  legacyRoute, memoryFs, modules, createTicketStore, OUTSIDE, policy, resolverFor, SCOPED,
} from '../../src/admission/test-fakes.js'

const root = path.resolve(import.meta.dirname, '../..')
const worker = path.join(root, 'src/admission/test-fakes.js')
const m = await modules()

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const args = { node: SCOPED, goal }
const rejection = { taskId: '', node: '', accepted: false, denied: true, hint: ADMISSION_REJECTED }
const count = (calls, name) => calls.filter(call => call === name).length
const assertGeneric = value => {
  assert.deepEqual(value, rejection)
  const text = JSON.stringify(value)
  for (const key of [...AUTHZ_REASON_CODES, 'target-a', SCOPED, 'explicit', 'TICKET_', 'identity_unbound', 'origin_unbound']) {
    assert.ok(!text.includes(key), `caller received ${key}`)
  }
}

async function setup(t, { ledger = {}, options = {}, ack } = {}) {
  const h = ledgerHarness(ledger)
  const host = fakeHost()
  const { registry, frames } = fakeRegistry(m, { calls: h.calls, ack })
  const admission = createAdmission(config(options), h.deps)
  t.after(() => admission.dispose())
  await admission.ready
  registry.checkTaskAdmission = admission.checkTaskAdmission
  const opts = { ctx: host.ctx, registry, admission, log() {} }
  m.registerClusterTools(opts)
  m.registerUiRoutes(opts)
  return { ...h, host, registry, frames, admission, tool: (overrides, exec) => host.tool('cluster_task', { ...args, ...overrides }, exec) }
}

// SHA-256 of each pinned baseline { value, calls, frames } capture, in a fresh
// process with deterministic clock/RNG. Frames are hashed as their raw strings.
const baseline = {
  'cluster_task': '2ad5c439fd38db8043993a61167bbb599338aa84edd877b4e235d1c3447dc003',
  'remote_task': 'c20d31dfccbbded75d25561cb39d12dac2227fe8b3b32e73fd14b4ae51675398',
  'cluster_task_batch': '305954a3d6b71d996f4dc39e7be836f9e9d19cd1f9c4b5194a8408ee67d14828',
  'remote_task_batch': 'a37251fd8173039b276eed9c823ad252658b1ab74b5b2e351667b67b0f6e49ed',
  '/api/ai-cluster/ui/dispatch': '070d385c94489232bb59b05273d5227d692cb6524a2d1ecd2a24f716ed437875',
  '/api/remote-agent/ui/dispatch': 'e2a0be95b65cb67231944195a75b147b59943769ce83b6524275b17d39404311',
  'subagent': '0b9d6f4353e51fc7c9627362fc0383c9c8b79ecf10d06cd81f67f6a278750a2a',
  './hub legacy UI': '5705cdd3911ea83be4597d9a5727c4cdd81494c5be2e44c96f877832731d5571',
  'legacy remote_task': '69dfb2ac716bd321cd38aab67108d140a1dae672db14bff43c6b7d88b699e3c2',
  'registry': 'fca7d1f445d9d0ccc43eafc79588b88758cf23c6da2aa2d597aa78943f4b424c',
}

function capture(mode) {
  const values = JSON.parse(execFileSync(process.execPath, [worker, '--ac2-capture', root, mode], { encoding: 'utf8' }))
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, hash(JSON.stringify(value))]))
}

test('AC-2 criterion 1: disabled caller parity', () => {
  assert.equal(createAdmission(config({ enabled: false })), null)
  assert.deepEqual(capture('disabled'), baseline)
})

test('AC-2 criterion 1: enabled out-of-scope caller and wire parity', () => {
  assert.deepEqual(capture('enabled'), baseline)
})

test('AC-2 criterion 2: decide, fsynced accept, createTask, and awaitAccepted', async t => {
  const order = []
  const h = await setup(t, { ledger: { deps: { decide(request, actualPolicy) {
    assert.deepEqual(request, { action: 'dispatch', target: 'target-a' })
    order.push('decide')
    return decideAuthorization(request, actualPolicy)
  } } } })
  const sync = h.fsOps.fsyncSync
  h.fsOps.fsyncSync = fd => { sync(fd); if (h.trace.at(-1) === 'fsync:ledger.jsonl') order.push('fsync') }
  const create = h.registry.createTask
  h.registry.createTask = request => {
    assert.deepEqual(h.calls, ['open', 'accept'])
    order.push('accept', 'createTask')
    return create(request)
  }
  const wait = h.registry.awaitAccepted
  h.registry.awaitAccepted = (id, opts) => { order.push('awaitAccepted'); return wait(id, opts) }
  const result = await h.tool()
  assert.ok(result.accepted)
  assert.deepEqual(order, ['decide', 'fsync', 'accept', 'createTask', 'awaitAccepted'])
  assert.equal(h.rows().length, 1)
  assert.equal(h.frames.length, 1)
  assert.equal(h.rows()[0].executorRef.ref, result.taskId)
})

test('AC-2 criterion 2: selfcheck and manual approval follow durable authorization', async t => {
  const h = await setup(t)
  h.registry.getNode(SCOPED).hello.caps = ['selfcheck']
  h.registry.fsRequest = async () => {
    assert.deepEqual(h.calls, ['open', 'accept'])
    assert.equal(h.trace.at(-1), 'fsync:ledger.jsonl')
    h.calls.push('selfcheck')
    return { verdict: 'ready' }
  }
  const result = await h.tool({ approval: 'manual' })
  assert.equal(result.status, 'pending_approval')
  assert.deepEqual(h.calls, ['open', 'accept', 'selfcheck', 'createTask'])
  assert.equal(h.frames.length, 0)
  assert.equal(h.registry.approveTask(result.taskId), true)
  assert.equal(h.frames.length, 1)
})

test('AC-2 criterion 3: reject classes share caller text and keep reasons in audit', async t => {
  const unbound = work => ({ resolve: () => ({ ok: true, work }) })
  const failures = [
    ['pair_not_allowed', { options: { policy: { ...policy, allow: [] } } }],
    ['identity_unbound', { ledger: { deps: { resolver: undefined } } }],
    ['identity_unbound', { ledger: { deps: { resolver: { resolve() { throw new Error('private') } } } } }],
    ['origin_unbound', { ledger: { deps: { resolver: unbound({ ...identity('event'), replyTo: {} }) } } }],
    ['origin_unbound', { ledger: { accept: async () => ({ denied: true, code: 'origin_unbound' }) } }],
    ['request_field_invalid', { options: { aliases: {} } }],
    ...['STORE_FAILED', 'LOCKED', 'CLOSED', 'READ_ONLY', 'ID_COLLISION'].map(reason => {
      const code = `TICKET_${reason}`
      return [code, { ledger: { accept: async () => { throw Object.assign(new Error('target-a private'), { code }) } } }]
    }),
  ]
  for (const [reason, deps] of failures) {
    const h = await setup(t, deps)
    assertGeneric(await h.tool({ approval: 'manual', origin: identity('forged').origin }))
    assert.deepEqual(h.audit, [{ event: 'admission.reject', nodeId: SCOPED, entry: 'tool', reason }])
    assert.equal(count(h.calls, 'createTask'), 0)
    assert.equal(h.rows().length, 0)
    assert.equal(h.frames.length, 0)
    assert.equal(h.registry.approveTask('fake-id'), false)
    h.admission.dispose()
    await Promise.resolve()
  }
})

test('AC-2 criterion 4: concurrent duplicate events dispatch exactly once', async t => {
  const h = await setup(t)
  const [first, retry] = await Promise.all([h.tool(), h.tool()])
  assert.ok(first.accepted)
  assert.equal(retry.taskId, first.taskId)
  assert.equal(retry.duplicate, true)
  assert.equal(count(h.calls, 'createTask'), 1)
  assert.equal(h.frames.length, 1)
  assert.equal(h.rows().length, 1)
})

test('AC-2 criterion 5: timeout and abort stay open and never resend', async t => {
  for (const reason of ['timeout', 'aborted']) {
    const abort = new AbortController()
    const h = await setup(t, { ack(_id, { signal }) {
      assert.equal(signal, abort.signal)
      if (reason === 'aborted') abort.abort()
      return Promise.reject(new Error(reason))
    } })
    await assert.rejects(h.tool({}, { signal: abort.signal }), new RegExp(reason))
    const duplicate = await h.tool()
    assert.ok(duplicate.duplicate)
    const [ticket] = h.ledgers[0].list()
    assert.equal(ticket.state, 'open')
    assert.deepEqual(ticket.executorRef, { kind: 'cluster-task', ref: duplicate.taskId })
    assert.equal(count(h.calls, 'createTask'), 1)
    assert.equal(count(h.calls, 'end'), 0)
    assert.equal(h.calls.filter(Array.isArray).length, 0)
    assert.equal(h.frames.length, 1)
    h.admission.dispose()
    await Promise.resolve()
  }
})

test('AC-2 criterion 6: known offline interrupts and only a new event can dispatch', async t => {
  let eventId = 'first'
  const h = await setup(t, { ledger: { deps: { resolver: { resolve: () => resolverFor(eventId).resolve() } } } })
  const node = h.registry.getNode(SCOPED)
  // The node drops offline immediately before createTask, after admission.
  const create = h.registry.createTask
  h.registry.createTask = request => { node.online = false; return create(request) }
  await assert.rejects(h.tool(), /node offline/)
  const [ticket] = h.ledgers[0].list()
  assert.equal(ticket.state, 'interrupted')
  assert.deepEqual(h.calls.filter(Array.isArray), [['interrupt', ticket.ticketId, 'not-dispatched']])
  assert.equal(h.frames.length, 0)
  node.online = true
  h.registry.createTask = create
  assert.equal((await h.tool()).duplicate, true)
  assert.equal(count(h.calls, 'createTask'), 1)
  assert.equal(h.frames.length, 0)
  eventId = 'next'
  assert.equal((await h.tool()).accepted, true)
  assert.equal(count(h.calls, 'createTask'), 2)
  assert.equal(h.frames.length, 1)
})

test('AC-2 criterion 7: crash after accept recovers an in-flight ticket without replay', async t => {
  const child = spawnSync(process.execPath, [worker, '--ac2-crash'], { encoding: 'utf8', timeout: 5_000 })
  assert.equal(child.status, 73, child.stderr || child.error?.message)
  const { bytes, frames, calls, trace } = JSON.parse(child.stdout)
  assert.deepEqual(calls, ['open', 'accept'])
  assert.deepEqual(frames, [])
  assert.ok(trace.includes('fsync:ledger.jsonl'))
  const memory = memoryFs(bytes)
  // Simulate operator removal of the verified stale lock from the dead child.
  memory.fsOps.unlinkSync(path.join(config().ledgerDir, 'ledger.lock'))
  const reopened = createTicketStore({ fsOps: memory.fsOps, dir: config().ledgerDir, sources: ['fake'] })
  t.after(() => reopened.close())
  const [ticket] = memory.rows()
  assert.deepEqual(reopened.recoveryReport().inFlight, [{
    ticketId: ticket.ticketId, executorRef: ticket.executorRef, createdAt: ticket.createdAt,
  }])
  assert.equal(reopened.recoveryReport().status, 'unverified: not assumed running, not assumed stopped')
})

test('AC-2 criterion 8: dry run and abort before accept add no rows', async t => {
  const observed = []
  let result
  const h = await setup(t, { ledger: { deps: { resolver: { async resolve(input) {
    observed.push(input)
    return result.promise
  } } } } })
  assert.equal((await h.tool({ dryRun: true })).dryRun, true)
  assertGeneric(await h.tool({}, { signal: AbortSignal.abort() }))
  assert.deepEqual(observed, [])
  result = deferred()
  const controller = new AbortController()
  const exec = { signal: controller.signal }
  const waiting = h.tool({}, exec)
  controller.abort()
  result.resolve(resolverFor().resolve())
  assertGeneric(await waiting)
  assert.deepEqual(observed, [{ entry: 'tool', nodeId: SCOPED, exec }])
  assert.equal(observed[0].exec, exec)
  assert.equal(count(h.calls, 'createTask'), 0)
  assert.equal(h.rows().length, 0)
})

test('AC-2 criterion 9: caller matrix rejects scoped bypasses and the whole batch', async t => {
  const h = await setup(t)
  const { registry, host } = h
  const start = m.validateTaskStart({ taskId: 'unmarked', goal }).spec
  for (const mark of [undefined, {}, 'admitted']) {
    assert.throws(() => registry.createTask({ nodeId: SCOPED, spec: start, admissionMark: mark }), { message: ADMISSION_REJECTED })
  }
  const calls = h.calls.length
  for (const name of ['cluster_task_batch', 'remote_task_batch']) {
    await assert.rejects(host.tool(name, { tasks: [{ node: OUTSIDE, goal }, args] }), { message: ADMISSION_REJECTED })
  }
  for (const route of currentRoutes) {
    assert.deepEqual(await host.post(route, args), { status: 403, value: { error: ADMISSION_REJECTED } })
  }
  await assert.rejects(m.createRemoteAgentProvider({ registry }).start({ label: SCOPED, prompt: goal }), { message: ADMISSION_REJECTED })
  assert.equal(h.calls.length, calls)
  const legacy = fakeHost()
  assert.equal(typeof m.publicHub.applyHub, 'function')
  m.legacyRoutes({ ctx: legacy.ctx, registry, log() {} })
  m.legacyTools({ ctx: legacy.ctx, registry, log() {} })
  assert.deepEqual(await legacy.post(legacyRoute, args), { status: 500, value: { error: 'internal', message: ADMISSION_REJECTED } })
  await assert.rejects(legacy.tool('remote_task', args), { message: ADMISSION_REJECTED })
  assert.deepEqual(h.audit.map(({ entry, reason }) => [entry, reason]), [
    ['registry', 'admission_required'], ['registry', 'admission_required'], ['registry', 'admission_required'],
    ['tool-batch', 'batch_unsupported'], ['tool-batch', 'batch_unsupported'],
    ['ui', 'identity_unbound'], ['ui', 'identity_unbound'], ['subagent', 'identity_unbound'],
    ['registry', 'admission_required'], ['registry', 'admission_required'],
  ])
  assert.equal(h.rows().length, 0)
  assert.equal(h.frames.length, 0)
  assert.equal(count(h.calls, 'createTask'), 5)
  assert.equal(registry.tasks.size, 0)
})

test('AC-2 criterion 11: protocol and client pin, no admission fields in a scoped frame', async t => {
  const h = await setup(t)
  assert.equal(m.PROTOCOL_VERSION, 1)
  const releaseCheck = readFileSync(path.join(root, 'scripts/check-release-reachability.mjs'), 'utf8')
  const clientHash = releaseCheck.match(/^const clientHash = '([a-f0-9]{64})'$/m)?.[1]
  assert.ok(clientHash, 'missing release client hash')
  assert.equal(hash(readFileSync(path.join(root, 'lib/client.js'))), clientHash)
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'))).version, '0.4.2')
  const result = await h.tool()
  assert.equal(h.frames.length, 1)
  const [wire] = h.frames
  const frame = JSON.parse(wire)
  assert.equal(frame.v, 1)
  assert.equal(frame.t, 'task/start')
  assert.match(result.taskId, /^t-tk_[0-9a-f]{24}$/)
  assert.equal(frame.d.taskId, result.taskId)
  assert.equal('admissionMark' in h.registry.getTask(result.taskId).spec, false)
  assert.doesNotMatch(wire, /denied|admissionMark|fake-person|target-a/)
})
