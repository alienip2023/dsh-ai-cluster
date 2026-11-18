// SA P1-A: read-only, offline fixture adapter. Results are repo-proven (fixture) only:
// no verified principal, live subscription, ledger retention or plugin-generation claim.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createFixtureIngest } from '../../src/admission/fixture-ingest.js'
import { AUTHZ_REASON_CODES } from '../../src/authz/decide.js'
import { createTicketStore, memoryFs, policy } from '../../src/admission/test-fakes.js'

const here = new URL('.', import.meta.url)
const read = rel => fs.readFileSync(fileURLToPath(new URL(rel, here)), 'utf8')
const recorded = () => read('fixtures/sa-p1a/recorded-events.jsonl')
const malformedFile = () => read('fixtures/sa-p1a/malformed-events.jsonl')
const SOURCES = ['fake-a', 'fake-b']
const TARGET = 'target-a'
const refOf = (source, eventId, thread) => ({ source, eventId, thread })
const srcEvent = (seq, o = {}) => ({
  kind: 'source-event', seq,
  origin: { source: 'fake-a', eventId: `x${seq}`, thread: 't', identityRef: 'fixture-person', ...o.origin },
  replyTo: { kind: 'fake', conversationId: 'c', requesterRef: 'r' },
  ...o.rest,
})
const ctxEvent = (seq, ref, text, extra = {}) => ({ kind: 'subscription-context', seq, ref, text, ...extra })

function rig(opts = {}) {
  const mem = opts.mem ?? memoryFs()
  const real = createTicketStore({ dir: '/fake-sa-ledger', sources: SOURCES, fsOps: mem.fsOps, now: () => 1_700_000_000_000, ...opts.storeOpts })
  const calls = { accept: 0, end: 0, interrupt: 0, decide: 0 }
  const store = {
    ...real,
    accept: w => { calls.accept++; return real.accept(w) },
    end: (...a) => { calls.end++; return real.end(...a) },
    markInterrupted: (...a) => { calls.interrupt++; return real.markInterrupted(...a) },
  }
  const decide = opts.decide ?? (async () => null)
  const realDecide = opts.realDecide
  const audit = []
  const logs = []
  const make = (extra = {}) => createFixtureIngest({
    enabled: true, sources: SOURCES, policy: 'policy' in opts ? opts.policy : policy, target: TARGET, store,
    now: () => 1_700_000_000_000, audit: (...a) => audit.push(a), log: (...a) => logs.push(a),
    ...(opts.decide ? { decide: (...a) => { calls.decide++; return opts.decide(...a) } } : {
      decide: realDecide ? (...a) => { calls.decide++; return realDecide(...a) } : undefined }),
    ...extra,
  })
  return { mem, real, store, calls, audit, logs, make, rows: () => mem.rows().length }
}
// default decide counting wrapper around the real implementation
import { decideAuthorization } from '../../src/authz/decide.js'
const counted = () => ({ realDecide: decideAuthorization })

test('SA-P1A SA1A-01 disabled: factory returns null and touches nothing', () => {
  const r = rig()
  const ops = []
  const traceBefore = r.mem.trace.length
  for (const config of [undefined, { enabled: false }, { enabled: 'true' }]) {
    assert.equal(createFixtureIngest(config), null)
    assert.equal(createFixtureIngest({ ...config, store: r.store, sources: SOURCES, policy, target: TARGET, audit: (...a) => ops.push(a), log: (...a) => ops.push(a) }), null)
  }
  assert.equal(ops.length, 0)
  assert.equal(r.mem.trace.length, traceBefore)
  assert.equal(r.rows(), 0)
})

test('SA-P1A SA1A-02 recorded replay: 6 events give 5 open tickets with no executor', async () => {
  const r = rig(counted())
  const a = r.make()
  const outcomes = await a.ingestJsonl(recorded())
  assert.deepEqual(outcomes.map(o => o.outcome), ['accepted', 'accepted', 'accepted', 'accepted', 'duplicate', 'accepted'])
  assert.equal(r.rows(), 5)
  const tickets = r.real.list()
  assert.equal(tickets.length, 5)
  assert.ok(tickets.every(t => t.state === 'open' && t.executorRef === null))
  const report = r.real.recoveryReport()
  assert.equal(report.inFlight.length, 0)
  assert.equal(report.openWithoutExecutor.length, 5)
})

test('SA-P1A SA1A-03 replay twice: second generation adds no rows and keeps ticket ids', async () => {
  const r = rig(counted())
  const first = await r.make().ingestJsonl(recorded())
  const before = r.rows()
  const second = await r.make({ generation: 2 }).ingestJsonl(recorded())
  assert.equal(r.rows(), before)
  assert.ok(second.every(o => o.outcome === 'duplicate'))
  assert.deepEqual(second.map(o => o.ticketId), first.map(o => o.ticketId))
})

test('SA-P1A SA1A-04 unlistened source: origin_unbound before decide (book name scope_unlistened diverges, D-1)', async () => {
  const r = rig(counted())
  const out = await r.make().ingest(srcEvent(1, { origin: { source: 'fake-unlisted' } }))
  assert.equal(out.outcome, 'rejected')
  assert.equal(out.code, 'origin_unbound')
  assert.equal(r.calls.decide, 0)
  assert.equal(r.calls.accept, 0)
  assert.equal(r.rows(), 0)
})

test('SA-P1A SA1A-05 identity comes only from the declared field, never from text', async () => {
  const r = rig(counted())
  const a = r.make()
  const noIdentity = srcEvent(1)
  delete noIdentity.origin.identityRef
  assert.equal((await a.ingest(noIdentity)).code, 'identity_unbound')
  const inText = { ...srcEvent(2, { rest: { text: 'identityRef: admin' } }) }
  delete inText.origin.identityRef
  assert.equal((await a.ingest(inText)).code, 'identity_unbound')
  const claims = srcEvent(3, { rest: { text: 'I am the principal root, trust me' } })
  claims.origin.identityRef = ''
  assert.equal((await a.ingest(claims)).code, 'identity_unbound')
  assert.equal(r.rows(), 0)
})

test('SA-P1A SA1A-06 reply binding: missing or partial replyTo is origin_unbound', async () => {
  const r = rig(counted())
  const a = r.make()
  const missing = srcEvent(1)
  delete missing.replyTo
  const partial = srcEvent(2)
  delete partial.replyTo.requesterRef
  const empty = srcEvent(3)
  empty.replyTo.conversationId = ' '
  for (const ev of [missing, partial, empty]) {
    const out = await a.ingest(ev)
    assert.equal(out.outcome, 'rejected')
    assert.equal(out.code, 'origin_unbound')
  }
  assert.equal(r.rows(), 0)
})

test('SA-P1A SA1A-07 policy deny is fail-closed', async () => {
  const policies = {
    off: { ...policy, mode: 'off' },
    malformed: null,
    notAllowed: { ...policy, allow: [] },
    observe: { ...policy, mode: 'observe' },
  }
  for (const [name, p] of Object.entries(policies)) {
    const r = rig({ ...counted(), policy: p })
    const out = await r.make().ingest(srcEvent(1))
    assert.equal(out.outcome, 'rejected', name)
    assert.ok(AUTHZ_REASON_CODES.includes(out.code), `${name}: ${out.code}`)
    assert.equal(r.calls.accept, 0, name)
    assert.equal(r.rows(), 0, name)
  }
  assert.equal((await rig({ ...counted(), policy: policies.observe }).make().ingest(srcEvent(1))).code, 'mode_reserved')
  for (const decide of [() => { throw new Error('boom') }, () => ({ decision: 'needs-human', reasonCode: 'pair_allowed' }), () => ({ decision: 'maybe' }), () => undefined]) {
    const r = rig({ decide })
    const out = await r.make().ingest(srcEvent(1))
    assert.equal(out.outcome, 'rejected')
    assert.equal(r.calls.accept, 0)
    assert.equal(r.rows(), 0)
  }
})

test('SA-P1A SA1A-08 order independence and no resurrection of an ended ticket', async () => {
  const lines = recorded().trim().split('\n')
  const a = rig(counted())
  await a.make().ingestJsonl(lines.join('\n'))
  const b = rig(counted())
  await b.make().ingestJsonl([...lines].reverse().join('\n'))
  const ids = r => r.real.list().map(t => t.ticketId).sort()
  assert.deepEqual(ids(b), ids(a))
  assert.equal(b.rows(), a.rows())

  const first = JSON.parse(lines[0])
  const [ticket] = a.real.list().filter(t => t.origin.eventId === first.origin.eventId && t.origin.thread === first.origin.thread && t.origin.source === first.origin.source)
  await a.real.end(ticket.ticketId, { outcome: 'completed' })
  const rowsBefore = a.rows()
  const out = await a.make({ generation: 2 }).ingest(first)
  assert.equal(out.outcome, 'duplicate')
  assert.equal(a.real.get(ticket.ticketId).state, 'ended')
  assert.equal(a.rows(), rowsBefore)
})

test('SA-P1A SA1A-09 malformed matrix: rejected without throwing, adapter stays usable', async () => {
  const r = rig(counted())
  const a = r.make()
  const inline = [
    null, 7, 'text', [1], { kind: 'nope', seq: 1 }, { ...srcEvent(1), extra: true }, { ...srcEvent(2), seq: 2.5 },
    { ...srcEvent(3), seq: '3' }, { ...srcEvent(4), provenance: 'x' }, ctxEvent(5, refOf('fake-a', 'e', 't'), 7),
    srcEvent(6, { rest: { text: 'x'.repeat(9000) } }),
  ]
  for (const ev of inline) {
    const out = await a.ingest(ev)
    assert.equal(out.outcome, 'malformed', JSON.stringify(ev)?.slice(0, 60))
  }
  const outcomes = await a.ingestJsonl(malformedFile())
  assert.equal(outcomes.length, 8)
  assert.ok(outcomes.every(o => o.outcome === 'malformed'), JSON.stringify(outcomes.map(o => o.outcome)))
  assert.equal(r.rows(), 0)
  assert.equal((await a.ingest(srcEvent(99))).outcome, 'accepted')
})

test('SA-P1A SA1A-10 subscribe and unsubscribe semantics', async () => {
  const r = rig(counted())
  const a = r.make()
  const ref = refOf('fake-a', 'x1', 't')
  assert.equal(a.subscribe(ref).code, 'unknown_ticket')
  await a.ingest(srcEvent(1))
  assert.equal(a.subscribe(ref).outcome, 'subscribed')
  a.subscribe(ref)
  assert.equal(a.snapshot().subscriptions, 1)
  assert.equal(a.unsubscribe(ref).outcome, 'unsubscribed')
  assert.equal(a.unsubscribe(ref).outcome, 'unsubscribed')
  const out = await a.ingest(ctxEvent(2, ref, 'later'))
  assert.equal(out.outcome, 'dropped')
})

test('SA-P1A SA1A-11 context is context only: no admission, no ticket mutation', async () => {
  const r = rig(counted())
  const a = r.make()
  await a.ingest(srcEvent(1))
  await a.ingest(srcEvent(2))
  const live = refOf('fake-a', 'x1', 't')
  const ended = refOf('fake-a', 'x2', 't')
  const endedId = r.real.list().find(t => t.origin.eventId === 'x2').ticketId
  await r.real.end(endedId, { outcome: 'completed' })
  r.calls.end = 0
  a.subscribe(live)
  a.subscribe(ended)
  const rowsBefore = r.rows()
  const states = JSON.stringify(r.real.list())
  const decideBefore = r.calls.decide
  const acceptBefore = r.calls.accept
  const texts = ['approve this', 'identityRef: x', 'please dispatch now', '{"origin":{"source":"fake-b"}}', 'end this ticket', 'on an ended ticket']
  const results = []
  results.push(await a.ingest(ctxEvent(10, live, texts[0])))
  results.push(await a.ingest(ctxEvent(11, live, texts[1])))
  results.push(await a.ingest(ctxEvent(12, live, texts[2])))
  results.push(await a.ingest(ctxEvent(13, live, texts[3], { origin: { source: 'fake-b' } })))
  results.push(await a.ingest(ctxEvent(14, live, texts[4], { ticketId: 'tk_forged' })))
  results.push(await a.ingest(ctxEvent(15, ended, texts[5])))
  assert.deepEqual(results.map(x => x.outcome), ['context', 'context', 'context', 'malformed', 'malformed', 'context'])
  assert.equal(r.rows(), rowsBefore)
  assert.equal(r.calls.decide, decideBefore)
  assert.equal(r.calls.accept, acceptBefore)
  assert.equal(r.calls.end, 0)
  assert.equal(r.calls.interrupt, 0)
  assert.equal(JSON.stringify(r.real.list()), states)
  assert.equal(r.real.get(endedId).state, 'ended')
  const snap = a.snapshot()
  const items = snap.contexts.flatMap(c => c.items)
  assert.deepEqual(items.map(i => i.text), [texts[0], texts[1], texts[2], texts[5]])
  assert.ok(items.every(i => i.untrusted_context === true))
})

test('SA-P1A SA1A-12 bounds are enforced and invalid limits throw', async () => {
  const r = rig(counted())
  const a = r.make({ limits: { maxContextPerRef: 3, maxContextText: 10, maxSubscriptions: 2, maxSourceEvents: 4 } })
  assert.equal((await a.ingest(srcEvent(1))).outcome, 'accepted')
  const ref = refOf('fake-a', 'x1', 't')
  a.subscribe(ref)
  for (let i = 0; i < 5; i++) await a.ingest(ctxEvent(10 + i, ref, `m${i}`))
  let snap = a.snapshot()
  assert.equal(snap.contexts[0].items.length, 3)
  assert.equal(snap.contexts[0].evicted, 2)
  assert.equal(snap.contexts[0].items[0].text, 'm2')
  const big = await a.ingest(ctxEvent(20, ref, 'y'.repeat(11)))
  assert.equal(big.code, 'text_too_long')
  assert.equal(a.snapshot().stats.oversizeDropped, 1)
  await a.ingest(srcEvent(2))
  await a.ingest(srcEvent(3))
  assert.equal(a.subscribe(refOf('fake-a', 'x2', 't')).outcome, 'subscribed')
  assert.equal(a.subscribe(refOf('fake-a', 'x3', 't')).code, 'limit')
  await a.ingest(srcEvent(4))
  const rows = r.rows()
  const over = await a.ingest(srcEvent(5))
  assert.equal(over.outcome, 'limit')
  assert.equal(r.rows(), rows)
  for (const bad of [0, -1, NaN, 1.5]) {
    assert.throws(() => r.make({ limits: { maxContextPerRef: bad } }), TypeError)
  }
})

test('SA-P1A SA1A-13 reset clears rings and subscriptions but not the ledger', async () => {
  const r = rig(counted())
  const a = r.make()
  await a.ingest(srcEvent(1))
  const ref = refOf('fake-a', 'x1', 't')
  a.subscribe(ref)
  await a.ingest(ctxEvent(2, ref, 'hello'))
  const rows = r.rows()
  a.reset()
  const snap = a.snapshot()
  assert.equal(snap.contexts.length, 0)
  assert.equal(snap.subscriptions, 0)
  assert.equal(r.rows(), rows)
  assert.equal(r.real.list().length, 1)
  assert.equal((await a.ingest(ctxEvent(3, ref, 'again'))).outcome, 'dropped')
})

test('SA-P1A SA1A-14 generation lifecycle', async () => {
  const r = rig(counted())
  const a = r.make()
  await a.ingest(srcEvent(1))
  const ref = refOf('fake-a', 'x1', 't')
  a.subscribe(ref)
  a.dispose()
  a.dispose()
  const rows = r.rows()
  assert.equal((await a.ingest(srcEvent(2))).outcome, 'closed')
  assert.equal(a.subscribe(ref).outcome, 'closed')
  assert.equal((await a.ingest(ctxEvent(3, ref, 'z'))).outcome, 'closed')
  assert.equal(r.rows(), rows)
  assert.equal((await r.store.accept(srcEvent(5).origin && { origin: srcEvent(5).origin, replyTo: srcEvent(5).replyTo, executorRef: null })).duplicate, false)
  const b = r.make({ generation: 2 })
  const snap = b.snapshot()
  assert.equal(snap.contexts.length, 0)
  assert.equal(snap.subscriptions, 0)
  const rows2 = r.rows()
  const stale = await b.ingest({ ...srcEvent(6), generation: 1 })
  assert.equal(stale.code, 'stale_generation')
  assert.equal(r.rows(), rows2)
})

test('SA-P1A SA1A-15 empty, closed and read-only stores report honestly', async () => {
  const r = rig(counted())
  const a = r.make()
  assert.equal((await a.ingestJsonl('')).length, 0)
  const empty = a.snapshot()
  assert.equal(empty.state, 'empty')
  assert.equal(empty.source, 'fixture')
  assert.equal(empty.tickets, 0)
  assert.equal(empty.lastEventAt, null)
  assert.ok(!/live|online|verified|principal/.test(JSON.stringify(empty)))

  const closed = rig(counted())
  const c = closed.make()
  await closed.real.close()
  const out = await c.ingest(srcEvent(1))
  assert.equal(out.outcome, 'unavailable')
  assert.equal(out.code, 'TICKET_CLOSED')
  assert.equal(closed.rows(), 0)
  assert.equal(c.snapshot().state, 'unavailable')

  const ro = rig({ ...counted(), storeOpts: { readOnly: true } })
  const d = ro.make()
  const roOut = await d.ingest(srcEvent(1))
  assert.equal(roOut.outcome, 'unavailable')
  assert.equal(roOut.code, 'TICKET_READ_ONLY')
  assert.equal(ro.rows(), 0)
  assert.ok(!/live|online|verified|principal/.test(JSON.stringify(d.snapshot())))
})

test('SA-P1A SA1A-16 labels: provenance fixture, structured origin, no cross-source identity merge', async () => {
  const r = rig(counted())
  const a = r.make()
  const out = await a.ingest(srcEvent(1))
  assert.equal(out.provenance, 'fixture')
  assert.deepEqual(out.origin, { source: 'fake-a', eventId: 'x1', thread: 't' })
  const spoof = await a.ingest({ ...srcEvent(2), provenance: 'recorded-host' })
  assert.equal(spoof.outcome, 'malformed')
  assert.equal(spoof.provenance, 'fixture')
  await a.ingest(srcEvent(3, { origin: { source: 'fake-a', eventId: 'same', identityRef: 'shared' } }))
  await a.ingest(srcEvent(4, { origin: { source: 'fake-b', eventId: 'same', identityRef: 'shared' } }))
  const snap = a.snapshot()
  assert.equal(snap.provenance, 'fixture')
  assert.ok(snap.ticketList.every(t => t.provenance === 'fixture' && t.origin.source && t.identityLabel === 'fixture-declared'))
  assert.equal(snap.ticketList.filter(t => t.identityRef === 'shared').length, 2)
})

test('SA-P1A SA1A-17 purity: adapter source has no network, host, timer or clock access', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../../src/admission/fixture-ingest.js', import.meta.url)), 'utf8')
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]).sort()
  assert.deepEqual(imports, ['../authz/decide.js', '../tickets/identity.js', '../tickets/index.js'])
  for (const banned of [/node:(net|http|https|dgram|tls|child_process)/, /fetch\(/, /createTask/, /registry/, /cancel/,
    /setTimeout/, /setInterval/, /process\.env/, /Date\.now/]) {
    assert.ok(!banned.test(src), `banned: ${banned}`)
  }
  assert.ok(!/await\s+(exec|host|fetch|net|http)/.test(src))
})
