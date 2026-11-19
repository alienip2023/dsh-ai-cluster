import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createResultRelay } from '../../src/admission/result-relay.js'
import { config, deferred, identity, ledgerHarness, memoryFs } from '../../src/admission/test-fakes.js'

// repo-proven (fixture): these cases use an in-memory ledger and fake channel only.
function fakeStore(t) {
  const cfg = config()
  const { deps } = ledgerHarness({ memory: memoryFs() })
  const store = deps.openStore({ dir: cfg.ledgerDir, sources: cfg.sources, fsOps: deps.fsOps, now: deps.now })
  t.after(() => store.close())
  return store
}

function createFakeChannel() {
  const calls = []
  const visible = new Map()
  let hold
  let failures = 0
  let receiveBeforeFailure = false
  return {
    calls,
    holdUntil(promise) { hold = promise },
    failNext(count = 1, { received = false } = {}) {
      failures = count
      receiveBeforeFailure = received
    },
    visible: () => [...visible.values()],
    async send(message) {
      calls.push(message)
      if (hold) await hold
      const failThisSend = failures > 0
      if (failThisSend) failures--
      if ((!failThisSend || receiveBeforeFailure) && !visible.has(message.messageId)) {
        visible.set(message.messageId, { message, receipt: { messageId: message.messageId, seq: visible.size + 1 } })
      }
      if (failThisSend) throw new Error('fixture send failed')
      return visible.get(message.messageId).receipt
    },
  }
}

const workerAddress = { kind: 'fake', conversationId: 'attacker-conv', requesterRef: 'attacker' }
const hostileResult = () => ({ success: true, reply_to: workerAddress, nested: { replyTo: workerAddress, channel: 'attacker-channel' } })
const destinationMessage = 'Result must be sent to the replyTo fixed at creation'
const repeatMessage = 'Repeated result must not send extra messages'

function wouldBeTicketId({ source, eventId, thread }) {
  const digest = createHash('sha256').update(JSON.stringify(['tickets/v1', source, eventId, thread])).digest('hex')
  return 'tk_' + digest.slice(0, 24)
}

test('SA1C-01 replyTo is fixed at creation and is the only route', async t => {
  const store = fakeStore(t)
  const work = identity('fixed-route')
  const { ticket } = await store.accept(work)
  const { ticketId, replyTo } = ticket
  let lastRead
  const channel = createFakeChannel()
  const { deliver } = createResultRelay({ store: { get(id) { return (lastRead = store.get(id)) } }, channel })

  assert.equal((await deliver({ ticketId, resultId: 'first', result: { success: true } })).outcome, 'sent')
  assert.equal(channel.calls.length, 1)
  assert.deepEqual(channel.calls[0].replyTo, replyTo, destinationMessage)
  assert.notStrictEqual(channel.calls[0].replyTo, lastRead.replyTo)
  assert.equal(Object.isFrozen(channel.calls[0].replyTo), true)

  assert.equal((await deliver({ ticketId, resultId: 'hostile', result: hostileResult() })).outcome, 'sent')
  assert.equal(channel.calls.length, 2)
  assert.deepEqual(channel.calls[1].replyTo, replyTo, destinationMessage)
  assert.deepEqual(JSON.parse(channel.calls[1].body), hostileResult())

  const duplicate = await store.accept({ ...work, replyTo: workerAddress })
  assert.equal(duplicate.duplicate, true)
  assert.deepEqual(duplicate.ticket.replyTo, replyTo)
  assert.deepEqual(store.get(ticketId).replyTo, replyTo)
  assert.equal((await deliver({ ticketId, resultId: 'later', result: hostileResult() })).outcome, 'sent')
  assert.equal(channel.calls.length, 3)
  assert.ok(channel.calls.every(call => call.replyTo.conversationId !== workerAddress.conversationId))
  assert.deepEqual(channel.calls.map(call => call.replyTo), [replyTo, replyTo, replyTo], destinationMessage)

  const deniedChannel = createFakeChannel()
  const deniedRelay = createResultRelay({ store, channel: deniedChannel })
  const length = store.list().length
  for (const [event, invalid] of [['missing', undefined], ['blank', { ...replyTo, requesterRef: ' ' }]]) {
    const deniedWork = { ...identity(event), replyTo: invalid }
    assert.deepEqual(await store.accept(deniedWork), { denied: true, code: 'origin_unbound' })
    assert.deepEqual(await deniedRelay.deliver({ ticketId: wouldBeTicketId(deniedWork.origin), resultId: event, result: hostileResult() }),
      { outcome: 'rejected', code: 'unknown_ticket' })
  }
  assert.equal(store.list().length, length)
  assert.deepEqual(await deniedRelay.deliver({ ticketId: 'no-ticket', resultId: 'unknown', result: hostileResult() }),
    { outcome: 'rejected', code: 'unknown_ticket' })
  for (const broken of [undefined, { ...replyTo, kind: '' }, { ...replyTo, extra: true }]) {
    const relay = createResultRelay({ store: { get: () => ({ ...ticket, replyTo: broken }) }, channel: deniedChannel })
    assert.deepEqual(await relay.deliver({ ticketId, resultId: 'broken', result: hostileResult() }),
      { outcome: 'rejected', code: 'reply_unbound' })
  }
  assert.equal(deniedChannel.calls.length, 0)
})

test('SA1C-02 repeated and parallel results are delivered once', async t => {
  const store = fakeStore(t)
  const { ticket } = await store.accept(identity('dedup'))
  const { ticketId, replyTo } = ticket
  const channel = createFakeChannel()
  const { deliver } = createResultRelay({ store, channel })
  const envelope = { ticketId, resultId: 'sequential', result: { list: [{ z: 2, a: 1 }], ok: true } }
  const first = await deliver(envelope)
  assert.equal(first.outcome, 'sent')
  assert.equal(channel.calls.length, 1)
  for (const result of [envelope.result, { ok: true, list: [{ a: 1, z: 2 }] }]) {
    const repeat = await deliver({ ...envelope, result })
    assert.equal(channel.calls.length, 1, repeatMessage)
    assert.equal(repeat.outcome, 'duplicate')
    assert.strictEqual(repeat.receipt, first.receipt)
  }

  const held = deferred()
  const parallel = { ...envelope, resultId: 'parallel' }
  channel.holdUntil(held.promise)
  const joined = Promise.all(Array.from({ length: 5 }, () => deliver(parallel)))
  try {
    for (let i = 0; i < 5; i++) await Promise.resolve()
    assert.equal(channel.calls.length - 1, 1, 'Parallel duplicates must produce exactly one send')
    const conflict = await deliver({ ...parallel, result: { ok: false } })
    assert.deepEqual(conflict, { outcome: 'conflict', code: 'fingerprint_mismatch' })
  } finally {
    held.resolve()
  }
  const outcomes = await joined
  assert.deepEqual(outcomes.map(out => out.outcome), ['sent', 'duplicate', 'duplicate', 'duplicate', 'duplicate'])
  assert.ok(outcomes.every(out => out.receipt === outcomes[0].receipt))
  assert.equal(channel.calls.length, 2)

  assert.deepEqual(await deliver({ ...envelope, result: { ok: false } }), { outcome: 'conflict', code: 'fingerprint_mismatch' })
  assert.equal(channel.calls.length, 2)
  const otherReply = { ...replyTo, conversationId: 'second-conversation' }
  const other = await store.accept({ ...identity('other-ticket'), replyTo: otherReply })
  const onOtherTicket = await deliver({ ...envelope, ticketId: other.ticket.ticketId })
  assert.equal(onOtherTicket.outcome, 'sent', 'Same resultId on another ticket must still be delivered to its own replyTo')
  assert.equal(channel.calls.length, 3)
  assert.deepEqual([channel.calls[0].replyTo, channel.calls[2].replyTo], [replyTo, otherReply])
  assert.equal((await deliver({ ...envelope, resultId: 'distinct' })).outcome, 'sent')
  assert.equal(channel.calls.length, 4)

  const cappedChannel = createFakeChannel()
  const capped = createResultRelay({ store, channel: cappedChannel, limits: { maxResults: 1 } })
  assert.equal((await capped.deliver(envelope)).outcome, 'sent')
  assert.deepEqual(await capped.deliver({ ...envelope, resultId: 'overflow' }), { outcome: 'rejected', code: 'limit' })
  assert.equal((await capped.deliver(envelope)).outcome, 'duplicate')
  for (const resultId of ['', ' ', 'x'.repeat(201), 1]) {
    assert.deepEqual(await capped.deliver({ ...envelope, resultId }), { outcome: 'rejected', code: 'invalid_result_id' })
  }
  assert.equal(cappedChannel.calls.length, 1)
})

test('SA1C-03 fake send failure retries once with a stable messageId and never double-posts', async t => {
  const store = fakeStore(t)
  const { ticket } = await store.accept(identity('retry'))
  const { ticketId, replyTo } = ticket
  const channel = createFakeChannel()
  const { deliver } = createResultRelay({ store, channel })
  const envelope = { ticketId, resultId: 'retry', result: { ok: true } }
  const failure = { outcome: 'failed', code: 'send_failed' }
  const held = deferred()
  channel.holdUntil(held.promise)
  channel.failNext()
  const pending = deliver(envelope)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  const inFlightRetry = deliver(envelope)
  held.resolve()
  assert.deepEqual(await pending, failure)
  assert.deepEqual(await inFlightRetry, failure)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  assert.equal(channel.calls.length, 1)
  assert.equal(channel.visible().length, 0)

  const retried = await deliver(envelope)
  assert.equal(retried.outcome, 'sent', 'A failed send must not be recorded as delivered')
  assert.equal(channel.calls.length, 2)
  assert.equal(channel.calls[1].messageId, channel.calls[0].messageId, 'Retry must reuse the same messageId')
  assert.equal(channel.calls[1].messageId, `ac-result:${ticketId}:${envelope.resultId}`)
  assert.deepEqual(channel.calls[1].replyTo, replyTo)
  assert.equal(channel.visible().length, 1)
  const repeat = await deliver(envelope)
  assert.equal(channel.calls.length, 2, repeatMessage)
  assert.strictEqual(repeat.receipt, retried.receipt)
  assert.equal(repeat.outcome, 'duplicate')

  // An ambiguous failure is at-least-once. One visible post depends on fake-channel dedup and proves no restart guarantee.
  const ambiguousChannel = createFakeChannel()
  const ambiguous = createResultRelay({ store, channel: ambiguousChannel })
  ambiguousChannel.failNext(1, { received: true })
  assert.deepEqual(await ambiguous.deliver(envelope), failure)
  assert.equal(ambiguousChannel.visible().length, 1)
  assert.equal((await ambiguous.deliver(envelope)).outcome, 'sent')
  assert.equal(ambiguousChannel.calls.length, 2)
  assert.equal(ambiguousChannel.visible().length, 1)

  const failingChannel = createFakeChannel()
  const limited = createResultRelay({ store, channel: failingChannel, limits: { maxAttemptsPerResult: 2 } })
  failingChannel.failNext(2)
  for (let i = 0; i < 2; i++) assert.deepEqual(await limited.deliver(envelope), failure)
  assert.deepEqual(await limited.deliver(envelope), { outcome: 'failed', code: 'attempts_exhausted' })
  assert.equal(failingChannel.calls.length, 2)
  assert.equal(failingChannel.visible().length, 0)

  assert.throws(() => createResultRelay({ store: {}, channel }), TypeError)
  assert.throws(() => createResultRelay({ store, channel: {} }), TypeError)
  for (const invalid of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '3']) {
    for (const name of ['maxResults', 'maxAttemptsPerResult']) {
      assert.throws(() => createResultRelay({ store, channel, limits: { [name]: invalid } }), TypeError)
    }
  }
  const source = readFileSync(new URL('../../src/admission/result-relay.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm)].map(match => match[1])
  assert.equal(imports.length, (source.match(/^import\b/gm) ?? []).length)
  assert.ok(imports.every(specifier => ['node:crypto', '../tickets/index.js'].includes(specifier)))
  assert.doesNotMatch(source, /\bimport\s*\(/)
  assert.doesNotMatch(source, /node:(?:net|http|https|dgram|tls|child_process)\b|\bfetch\s*\(|\b(?:setTimeout|setInterval|createTask|registry)\b|Date\.now|process\.env/)
  assert.doesNotMatch(source, /\b(?:accept|end|markInterrupted|checkpoint|close)\s*\(/)
})
