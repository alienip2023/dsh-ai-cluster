import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { ADMISSION_REJECTED, createAdmission } from '../../src/admission/index.js'
import {
  config, createTicketStore, deferred, fakeHost, fakeRegistry, goal, ledgerHarness,
  memoryFs, modules, OUTSIDE, resolverFor, SCOPED,
} from '../../src/admission/test-fakes.js'

const m = await modules()
const ticketId = 'tk_efd6f106906f1d00a88a8146'
const taskId = 't-tk_efd6f106906f1d00a88a8146'
const nextId = 'tk_531f7af08d6ee9306c9d42c7'
const ref = id => ({ kind: 'cluster-task', ref: `t-${id}` })
const readout = (flight, interrupted, ended) => `admission recovery: inFlight=${flight} (unverified: not assumed running, not assumed stopped), interrupted=${interrupted} (includes not-dispatched: manual intervention, redispatch only via a new event ID), ended=${ended}`
const count = (h, name) => h.calls.filter(call => Array.isArray(call) ? call[0] === name : call === name).length
const ticket = (h, id = ticketId) => h.store.get(id)
const state = (h, expected, reason = null, id = ticketId) => {
  const actual = ticket(h, id)
  assert.equal(actual.state, expected, `${id} state`)
  assert.equal(actual.reason, reason, `${id} reason`)
  assert.deepEqual(actual.executorRef, ref(id))
}
const flightIds = report => report.inFlight.map(row => row.ticketId)
const duplicate = ({ taskId: id, accepted, duplicate, status }, expectedStatus = 'unconfirmed') => {
  assert.deepEqual({ id, accepted, duplicate, status }, { id: taskId, accepted: false, duplicate: true, status: expectedStatus })
}
function traffic(h, creates, frames) {
  assert.equal(count(h, 'createTask'), creates, 'createTask calls')
  assert.equal(h.frames.length, frames, 'frames sent')
}

async function setup(t, { event = 'event-1', memory, failRow, throwSinks, onAccept, closeGate, acceptRef, ack, approval = 'auto' } = {}) {
  let eventId = event
  let closing
  const work = []
  const h = ledgerHarness({ memory })
  const host = fakeHost()
  const { registry, frames } = fakeRegistry(m, { calls: h.calls, ack })
  const baseOpen = h.deps.openStore
  h.deps.resolver = { resolve: () => resolverFor(eventId).resolve() }
  h.deps.openStore = opts => {
    const store = baseOpen(opts)
    return {
      ...store,
      accept: async input => {
        const accepted = await store.accept(acceptRef ? { ...input, executorRef: acceptRef } : input)
        await onAccept?.()
        return accepted
      },
      close: () => (closing = closeGate ? closeGate.promise.then(() => store.close()) : store.close()),
    }
  }
  if (failRow) {
    const write = h.fsOps.writeSync
    h.fsOps.writeSync = (fd, bytes, offset, length) => {
      if (JSON.parse(bytes.toString()).type === failRow) throw new Error('synthetic append failure')
      return write(fd, bytes, offset, length)
    }
  }
  if (throwSinks) {
    h.deps.audit = () => { throw new Error('synthetic audit failure') }
    h.deps.log = () => { throw new Error('synthetic log failure') }
  }
  const admission = createAdmission(config(), h.deps)
  const close = () => { admission.dispose(); return closing }
  t.after(close)
  await admission.ready
  registry.checkTaskAdmission = admission.checkTaskAdmission
  const terminals = []
  if (admission.onTaskTerminal) {
    registry.onTaskTerminal = info => { terminals.push(info); work.push(admission.onTaskTerminal(info)) }
  }
  registry.getNode(SCOPED).hello.caps.push('selfcheck')
  registry.fsRequest = async () => ({ verdict: 'ok' })
  m.registerClusterTools({ ctx: host.ctx, registry, admission })
  return {
    ...h, host, registry, frames, admission, close, terminals,
    store: h.ledgers[0], setEvent: id => { eventId = id },
    tool: (args, exec) => host.tool('cluster_task', { node: SCOPED, goal, mode: 'exec', approval, ...args }, exec),
    settle: () => Promise.all(work.splice(0)),
  }
}

const boom = new Error('selfcheck boom')
const failSelfcheck = h => { h.registry.fsRequest = () => Promise.reject(boom) }
const blocked = h => { h.registry.fsRequest = async () => ({ verdict: 'blocked', blockingFailures: [{ id: 'fake-root' }] }) }
const badMessage = '副机自检未通过（fake-root）；先运行 cluster_selfcheck 查看修复建议'
const rejectBlocked = h => assert.rejects(h.tool(), { name: 'RemoteAgentError', message: badMessage, code: m.ERROR_CODE.INTERNAL })
const rejectBoom = h => assert.rejects(h.tool(), error => error === boom)
function preDispatchStopped(h) {
  state(h, 'interrupted', 'not-dispatched')
  assert.deepEqual(h.calls.filter(Array.isArray), [['interrupt', ticketId, 'not-dispatched']])
  assert.deepEqual(h.rows().map(row => row.type), ['accept', 'interrupt'])
  assert.equal(count(h, 'end'), 0)
  traffic(h, 0, 0)
}
const nodeFrame = (h, type, data, node = SCOPED) => h.registry.handleFrameFor(node, { t: type, d: data })
const nodeEnd = (h, status, id = taskId, node = SCOPED) => nodeFrame(h, m.NODE_TO_HUB.TASK_END, { taskId: id, status }, node)
const nodeSummary = (h, status) => nodeFrame(h, m.NODE_TO_HUB.TASK_SUMMARY, { taskId, handoff: { status } })
async function reopen(t, h) {
  await h.close()
  return setup(t, { memory: memoryFs(h.bytes()) })
}

// Compare the complete wire strings in fresh processes with identical clocks,
// RNG and protocol frame counters, so no normalization can hide a difference.
if (process.argv[2] === '--ac3-outside-wire') {
  const fakeTest = { after() {} }
  const h = await setup(fakeTest)
  Date.now = () => 1_700_000_000_000
  Math.random = () => 0.125
  if (process.argv[3] === 'control') delete h.registry.onTaskTerminal
  const receipt = await h.tool({ node: OUTSIDE })
  nodeEnd(h, 'completed', receipt.taskId, OUTSIDE)
  await h.settle()
  await h.close()
  await new Promise(resolve => process.stdout.write(JSON.stringify({ frames: h.frames, status: h.registry.getTask(receipt.taskId).status, rows: h.rows() }), resolve))
  process.exit(0)
}

test('AC-3 AC3-01: blocked selfcheck interrupts a durably accepted ticket', async t => {
  const h = await setup(t)
  blocked(h)
  await rejectBlocked(h)
  preDispatchStopped(h)
})

test('AC-3 AC3-02: a rejected selfcheck preserves the original error and interrupts', async t => {
  const h = await setup(t)
  const timeout = new Error('fsRequest timeout')
  h.registry.fsRequest = () => Promise.reject(timeout)
  await assert.rejects(h.tool(), error => error === timeout)
  preDispatchStopped(h)
})

test('AC-3 AC3-03: a synchronous pre-createTask throw interrupts', async t => {
  const h = await setup(t)
  const getNode = h.registry.getNode.bind(h.registry)
  const error = new Error('getNode boom after accept')
  h.registry.getNode = id => {
    if (count(h, 'accept') === 1) throw error
    return getNode(id)
  }
  await assert.rejects(h.tool(), actual => actual === error)
  preDispatchStopped(h)
})

test('AC-3 AC3-04: reproduce the AC-2 ruling probe for the literal ticket', async t => {
  const h = await setup(t)
  failSelfcheck(h)
  await rejectBoom(h)
  const [accepted] = h.rows()
  assert.equal(accepted.ticketId, 'tk_efd6f106906f1d00a88a8146')
  assert.deepEqual(accepted.executorRef, { kind: 'cluster-task', ref: 't-tk_efd6f106906f1d00a88a8146' })
  traffic(h, 0, 0)
  assert.equal(count(h, 'end'), 0)
  t.diagnostic(JSON.stringify({ after_first_state: ticket(h).state, after_first_executorRef: ticket(h).executorRef, rows: h.rows().length, calls: h.calls }))
  preDispatchStopped(h)
})

test('AC-3 AC3-05: same-key retry never resurrects the interrupted ticket', async t => {
  const h = await setup(t)
  failSelfcheck(h)
  await rejectBoom(h)
  duplicate(await h.tool())
  preDispatchStopped(h)
  const reopened = await reopen(t, h)
  state(reopened, 'interrupted', 'not-dispatched')
  assert.equal(reopened.admission.recoveryReport().interrupted, 1)
  assert.deepEqual(reopened.logs.filter(log => log.level === 'info').map(log => log.msg), [readout(0, 1, 0)])
  assert.equal(h.logs.filter(log => log.msg === 'ticket not dispatched; manual redispatch needs a new event ID').length, 1)
})

test('AC-3 AC3-06: an authorized new event ID dispatches exactly once', async t => {
  const h = await setup(t)
  failSelfcheck(h)
  await rejectBoom(h)
  h.setEvent('next')
  const receipt = await h.tool({ precheck: false })
  assert.equal(receipt.taskId, `t-${nextId}`)
  assert.equal(receipt.accepted, true)
  traffic(h, 1, 1)
  state(h, 'interrupted', 'not-dispatched')
  state(h, 'open', null, nextId)
  assert.deepEqual(flightIds(h.admission.recoveryReport()), [nextId])
})

test('AC-3 AC3-07: awaitAccepted timeout and abort stay uncertain through reopen', async t => {
  for (const kind of ['timeout', 'abort']) {
    const waiting = deferred()
    const controller = new AbortController()
    const failure = new Error(`awaitAccepted ${kind}`)
    const h = await setup(t, { ack: (_id, { signal }) => {
      assert.equal(signal, controller.signal)
      if (kind === 'abort') signal.addEventListener('abort', () => waiting.reject(failure), { once: true })
      else waiting.reject(failure)
      return waiting.promise
    } })
    const receipt = h.tool({}, { signal: controller.signal })
    if (kind === 'abort') {
      // A sentinel at the awaitAccepted spy, without sleeping or changing timeouts.
      const ack = h.registry.awaitAccepted
      h.registry.awaitAccepted = (...args) => { const result = ack(...args); controller.abort(); return result }
    }
    await assert.rejects(receipt, error => error === failure)
    duplicate(await h.tool(), 'queued')
    state(h, 'open')
    traffic(h, 1, 1)
    assert.equal(count(h, 'end'), 0)
    assert.equal(count(h, 'interrupt'), 0)
    assert.equal(h.rows().length, 1)
    assert.deepEqual(flightIds(h.store.recoveryReport()), [ticketId])
    const reopened = await reopen(t, h)
    state(reopened, 'open')
    assert.deepEqual(flightIds(reopened.store.recoveryReport()), [ticketId])
    traffic(reopened, 0, 0)
  }
})

test('AC-3 AC3-08: node completion, failure and abort end their tickets', async t => {
  const h = await setup(t)
  const cases = ['completed', 'failed', 'aborted']
  const ids = []
  for (const [i] of cases.entries()) {
    if (i) h.setEvent(`terminal-${i}`)
    const receipt = await h.tool()
    ids.push(receipt.taskId.slice(2))
  }
  assert.deepEqual(flightIds(h.store.recoveryReport()), ids)
  for (const [i, outcome] of cases.entries()) {
    const id = ids[i]
    nodeFrame(h, i === 1 ? m.NODE_TO_HUB.TASK_SUMMARY : m.NODE_TO_HUB.TASK_END,
      i === 1 ? { taskId: `t-${id}`, handoff: { status: outcome } } : { taskId: `t-${id}`, status: outcome })
    await h.settle()
    state(h, 'ended', null, id)
    assert.deepEqual(h.rows().filter(row => row.type === 'end' && row.ticketId === id).map(row => row.outcome), [outcome])
    assert.deepEqual(flightIds(h.admission.recoveryReport()), ids.slice(i + 1))
    assert.equal(count(h, 'end'), i + 1)
    traffic(h, 3, 3)
  }
})

test('AC-3 AC3-09: node interruption, approval timeout, reject and hub-cancel map to durable outcomes', async t => {
  const interrupted = await setup(t)
  await interrupted.tool()
  nodeEnd(interrupted, 'interrupted')
  await interrupted.settle()
  state(interrupted, 'interrupted', 'interrupted')
  traffic(interrupted, 1, 1)
  assert.equal(count(interrupted, 'interrupt'), 1)
  assert.equal(count(interrupted, 'end'), 0)
  for (const reason of ['approval-timeout', 'approval-rejected', 'hub-cancel']) {
    const h = await setup(t, { approval: 'manual' })
    assert.equal((await h.tool()).status, 'pending_approval')
    if (reason === 'hub-cancel') h.registry.cancelTask(taskId)
    else assert.equal(h.registry.rejectTask(taskId, { by: reason === 'approval-timeout' ? 'timeout' : 'ui', reason }), true)
    await h.settle()
    const reject = reason === 'approval-rejected'
    state(h, reject ? 'ended' : 'interrupted', reason)
    assert.equal(count(h, 'end'), reject ? 1 : 0)
    assert.equal(count(h, 'interrupt'), reject ? 0 : 1)
    assert.equal(h.rows().length, 2)
    assert.equal(h.rows()[1].outcome, reject ? 'rejected' : undefined)
    traffic(h, 1, 0)
  }
})

test('AC-3 AC3-10: terminal races, duplicates, conflicting and nonterminal arrivals are guarded', async t => {
  const h = await setup(t)
  await h.tool()
  nodeEnd(h, 'running')
  nodeSummary(h, 'running')
  await h.settle()
  assert.deepEqual(h.terminals, [], 'running must not reach the terminal hook')
  assert.equal(h.rows().length, 1)
  nodeEnd(h, 'completed')
  nodeEnd(h, 'completed')
  nodeEnd(h, 'failed')
  await h.settle()
  assert.equal(h.registry.getTask(taskId).status, 'completed')
  state(h, 'ended')
  assert.deepEqual(h.rows().slice(1).map(row => [row.type, row.outcome]), [['end', 'completed']])
  traffic(h, 1, 1)

  const late = await setup(t)
  failSelfcheck(late)
  await rejectBoom(late)
  nodeEnd(late, 'completed')
  await late.settle()
  preDispatchStopped(late)

  const timeout = { by: 'timeout', reason: 'approval-timeout' }
  const cancel = { by: 'hub-cancel', reason: 'cancelled while pending approval' }
  for (const [first, second, winner] of [[timeout, cancel, 'approval-timeout'], [cancel, timeout, 'hub-cancel']]) {
    const pending = await setup(t, { approval: 'manual' })
    await pending.tool()
    assert.equal(pending.registry.rejectTask(taskId, first), true)
    assert.equal(pending.registry.rejectTask(taskId, second), false)
    await pending.settle()
    state(pending, 'interrupted', winner)
    assert.equal(pending.rows().length, 2)
    traffic(pending, 1, 0)
  }

  const uncertain = await setup(t, { approval: 'manual' })
  await uncertain.tool()
  uncertain.registry.getNode(SCOPED).conn.closed = true
  assert.throws(() => uncertain.registry.approveTask(taskId), /node unreachable/)
  assert.equal(uncertain.registry.getTask(taskId).status, 'failed')
  nodeEnd(uncertain, 'completed')
  nodeSummary(uncertain, 'completed')
  await uncertain.settle()
  assert.equal(uncertain.registry.getTask(taskId).status, 'failed')
  state(uncertain, 'open')
  assert.deepEqual(uncertain.terminals, [])
  assert.equal(uncertain.rows().length, 1)
  traffic(uncertain, 1, 0)
})

test('AC-3 AC3-11: out-of-scope tasks and real mismatched executor refs cannot alter the ledger', async t => {
  const h = await setup(t, { acceptRef: { kind: 'cluster-task', ref: 'different-task' } })
  await h.tool()
  assert.deepEqual(ticket(h).executorRef, { kind: 'cluster-task', ref: 'different-task' })
  await h.admission.onTaskTerminal?.({ taskId: 't-tk_unknown', status: 'completed' })
  nodeEnd(h, 'completed')
  await h.settle()
  assert.equal(ticket(h).state, 'open')
  assert.equal(h.rows().length, 1)
  assert.equal(count(h, 'end'), 0)
  traffic(h, 1, 1)
  const capture = mode => JSON.parse(execFileSync(process.execPath, [import.meta.filename, '--ac3-outside-wire', mode], { encoding: 'utf8' }))
  const actual = capture('hook')
  assert.deepEqual(actual, capture('control'))
  assert.equal(actual.frames.length, 1)
  assert.equal(JSON.parse(actual.frames[0]).t, m.HUB_TO_NODE.TASK_START)
  assert.equal(actual.status, 'completed')
  assert.deepEqual(actual.rows, [])
})

test('AC-3 AC3-12: append and sink failures preserve caller and registry outcomes', async t => {
  const results = []
  for (const throwSinks of [false, true]) {
    const h = await setup(t, { failRow: 'interrupt', throwSinks })
    failSelfcheck(h)
    await rejectBoom(h)
    traffic(h, 0, 0)
    state(h, 'open')
    assert.deepEqual(h.rows().map(row => row.type), ['accept'])
    const reopened = await reopen(t, h)
    state(reopened, 'open')
    assert.deepEqual(flightIds(reopened.store.recoveryReport()), [ticketId])
    traffic(reopened, 0, 0)
    results.push(h)
  }
  const terminal = await setup(t, { failRow: 'end' })
  await terminal.tool()
  const waiting = m.NodeRegistry.prototype.awaitTerminal.call(terminal.registry, taskId)
  assert.doesNotThrow(() => nodeEnd(terminal, 'completed'))
  assert.equal((await waiting).status, 'completed')
  await terminal.settle()
  assert.equal(terminal.registry.getTask(taskId).status, 'completed')
  assert.equal(terminal.registry.getTask(taskId).waiters.size, 0)
  state(terminal, 'open')
  assert.deepEqual(terminal.rows().map(row => row.type), ['accept'])
  assert.deepEqual(flightIds(terminal.store.recoveryReport()), [ticketId])
  traffic(terminal, 1, 1)
  const terminalReopened = await reopen(t, terminal)
  assert.deepEqual(flightIds(terminalReopened.store.recoveryReport()), [ticketId])
  traffic(terminalReopened, 0, 0)

  assert.equal(count(results[0], 'interrupt'), 1)
  assert.equal(count(results[1], 'interrupt'), 1)
  assert.deepEqual(results[0].audit.filter(row => row.event === 'admission.interrupt_failed'), [
    { event: 'admission.interrupt_failed', entry: 'tool', nodeId: SCOPED, reason: 'TICKET_STORE_FAILED' },
  ])
  assert.equal(results[0].logs.filter(row => row.level === 'warn' && row.msg.includes('admission.interrupt_failed')).length, 1)
  assert.equal(count(terminal, 'end'), 1)
  assert.deepEqual(terminal.audit.filter(row => row.event === 'admission.terminal_failed'), [
    { event: 'admission.terminal_failed', taskId, status: 'completed', reason: 'TICKET_STORE_FAILED' },
  ])
  assert.equal(terminal.logs.filter(row => row.level === 'warn' && row.msg.includes('admission.terminal_failed')).length, 1)
})

test('AC-3 AC3-13: drained reload preserves the interrupt and a torn tail stays uncertain', async t => {
  const closeGate = deferred()
  const h = await setup(t, { closeGate })
  let ledgerImage
  try {
    blocked(h)
    await rejectBlocked(h)
    ledgerImage = h.bytes()
  } finally {
    const draining = h.close()
    closeGate.resolve()
    await draining
  }
  const reopened = await setup(t, { memory: memoryFs(h.bytes()) })
  preDispatchStopped(h)
  state(reopened, 'interrupted', 'not-dispatched')
  assert.deepEqual(reopened.rows(), h.rows())
  assert.deepEqual(flightIds(reopened.admission.recoveryReport()), [])
  traffic(reopened, 0, 0)

  const tornImage = ledgerImage.filter(([file]) => file.endsWith('/ledger.jsonl')).map(([file, base64]) => {
    const bytes = Buffer.from(base64, 'base64')
    return [file, bytes.subarray(0, bytes.length - 8).toString('base64')]
  })
  const memory = memoryFs(tornImage)
  const fs = memory.fsOps
  const open = fs.openSync
  const handles = new Map()
  fs.openSync = (file, mode) => {
    const fd = open(file, mode)
    handles.set(fd, file)
    return fd
  }
  fs.ftruncateSync = (fd, length) => {
    const file = handles.get(fd)
    const prefix = fs.readFileSync(file).subarray(0, length)
    fs.unlinkSync(file)
    const replacement = open(file, 'wx')
    fs.writeSync(replacement, prefix, 0, prefix.length)
    fs.closeSync(replacement)
  }
  const torn = await setup(t, { memory })
  state(torn, 'open')
  const report = torn.admission.recoveryReport()
  assert.ok(report.tornTail, 'partial interrupt line was reported')
  assert.deepEqual(flightIds(report), [ticketId])
  assert.deepEqual(torn.rows().map(row => row.type), ['accept'])
  traffic(torn, 0, 0)
  duplicate(await torn.tool())
  traffic(torn, 0, 0)
})

test('AC-3 AC3-14: ready reports exact recovery counts and manual-intervention wording', async t => {
  const memory = memoryFs()
  const seed = createTicketStore({ dir: config().ledgerDir, sources: ['fake'], fsOps: memory.fsOps })
  for (const [event, terminal] of [['event-1', 'open'], ['next', 'ended'], ['first', 'interrupted'], ['unassigned', 'unassigned']]) {
    const binding = resolverFor(event).resolve().work
    const id = (await seed.accept({ ...binding, ...(terminal === 'unassigned' ? {} : { executorRef: { kind: 'cluster-task', ref: event } }) })).ticket.ticketId
    if (terminal === 'ended') await seed.end(id, { outcome: 'completed' })
    if (terminal === 'interrupted') await seed.markInterrupted(id, 'not-dispatched')
  }
  await seed.close()
  const h = await setup(t, { memory })
  const report = h.admission.recoveryReport()
  assert.deepEqual(flightIds(report), [ticketId])
  assert.equal(report.openWithoutExecutor.length, 1)
  assert.equal(report.interrupted, 1)
  assert.equal(report.ended, 1)
  assert.deepEqual(h.audit, [{ event: 'admission.recovery', inFlight: 1, openWithoutExecutor: 1, ended: 1, interrupted: 1 }])
  assert.deepEqual(h.logs, [{ level: 'info', msg: readout(1, 1, 1) }])
  traffic(h, 0, 0)
  const noStore = createAdmission(config(), { openStore: () => { throw new Error('synthetic open failure') }, log: () => { throw boom } })
  await noStore.ready
  assert.deepEqual(noStore.recoveryReport(), { unavailable: 'TICKET_STORE_FAILED' })
  noStore.dispose()
})

test('AC-3 AC3-15: dispose after fresh accept closes or audibly hands off the accepted ticket', async t => {
  const results = []
  for (const [writable, throwSinks] of [[true, false], [false, false], [false, true]]) {
    const accepted = deferred()
    const releaseAccept = deferred()
    const closeGate = writable ? deferred() : undefined
    const h = await setup(t, { onAccept: () => { accepted.resolve(); return releaseAccept.promise }, closeGate, throwSinks })
    const first = h.tool()
    await accepted.promise
    assert.equal(h.rows().length, 1)
    const closing = h.close()
    if (!writable) await closing
    releaseAccept.resolve()
    const denial = await first
    closeGate?.resolve()
    await closing
    const reopened = await setup(t, { memory: memoryFs(h.bytes()) })
    duplicate(await reopened.tool())
    traffic(h, 0, 0)
    traffic(reopened, 0, 0)
    assert.equal(count(h, 'end'), 0)
    assert.equal(count(reopened, 'end'), 0)
    results.push({ h, reopened, denial, writable, throwSinks })
  }
  for (const { h, reopened, denial, writable, throwSinks } of results) {
    assert.deepEqual(denial, { taskId: '', node: '', accepted: false, denied: true, hint: ADMISSION_REJECTED })
    state(reopened, writable ? 'interrupted' : 'open', writable ? 'not-dispatched' : null)
    assert.deepEqual(h.rows().map(row => row.type), writable ? ['accept', 'interrupt'] : ['accept'])
    assert.equal(count(h, 'interrupt'), 1)
    assert.deepEqual(flightIds(reopened.store.recoveryReport()), writable ? [] : [ticketId])
    if (!throwSinks) {
      assert.deepEqual(h.audit.filter(row => row.event === 'admission.reject'), [
        { event: 'admission.reject', entry: 'tool', nodeId: SCOPED, reason: 'TICKET_CLOSED' },
      ])
      if (!writable) {
        assert.deepEqual(h.audit.filter(row => row.event === 'admission.interrupt_failed'), [
          { event: 'admission.interrupt_failed', entry: 'tool', nodeId: SCOPED, reason: 'TICKET_CLOSED' },
        ])
        assert.equal(h.logs.filter(row => row.level === 'warn' && row.msg.includes('admission.interrupt_failed')).length, 1)
      }
    }
  }
})
