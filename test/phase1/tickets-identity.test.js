import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTicketStore, ticketIdOf, workKeyOf } from '../../src/tickets/index.js'

const at = '2026-11-18T00:00:00.000Z'
const origin = (source, eventId, thread) => ({ source, eventId, thread, identityRef: 'identity-1' })
const work = (eventId = 'c') => ({
  origin: origin('a', eventId, 't'),
  replyTo: { kind: 'chat', conversationId: 'room', requesterRef: 'caller' },
  mandateRef: 'opaque',
})

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-id-'))
  const ledgerFile = path.join(dir, 'ledger.jsonl')
  const store = createTicketStore({ dir, now: () => at, sources: ['a'], durability: 'none' })
  t.after(async () => {
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const rows = () => fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').split('\n').slice(0, -1) : []
  return { dir, ledgerFile, store, rows }
}

test('T-ID-1 workKey is stable and changes with each origin field', () => {
  const vectors = [
    [origin('a', 'c', 't'), '68f5740a10873d51e660706ecc250842e5d7273ae3dabcdeedee79d20b2443f5'],
    [origin('a', 'd', 't'), '167d9618cd194a99e7fc9db9eeccffde2586cef93ad9f019e2969cb139c0190a'],
    [origin('a', 'c', 'u'), 'e83bae9b6f36acc5a98ff7560ec9b2dcd3ac81408ffcf8a2fdb085ae9f13fa2a'],
    [origin('a:b', 'c', 't'), '798dcb787784c3655f7ab164c85f985248c023f36a618a8b20d51f1ad23f184a'],
  ]
  const keys = vectors.map(([value]) => workKeyOf(value))
  assert.equal(new Set(keys).size, vectors.length, 'changing any of the three origin fields must change the key')
  for (const [value, hash] of vectors) {
    assert.equal(workKeyOf(value), hash)
    assert.equal(workKeyOf({ ...value, identityRef: 'other' }), hash)
    assert.equal(ticketIdOf(hash), `tk_${hash.slice(0, 24)}`)
  }
  assert.doesNotThrow(() => workKeyOf(origin('a', 'x'.repeat(512), 't')))
  assert.throws(() => workKeyOf(origin('a', 'x'.repeat(513), 't')), TypeError)
})

test('T-ID-2 colon-containing fields do not collide', () => {
  const a = origin('a:b', 'c', 't')
  const b = origin('a', 'b:c', 't')
  assert.equal([a.source, a.eventId, a.thread].join(':'), [b.source, b.eventId, b.thread].join(':'))
  assert.notEqual(ticketIdOf(workKeyOf(a)), ticketIdOf(workKeyOf(b)))
  assert.equal(workKeyOf(a), '798dcb787784c3655f7ab164c85f985248c023f36a618a8b20d51f1ad23f184a')
  assert.equal(workKeyOf(b), '58fa483f2a3262df90e3687fe4b47b98ec862cb1d00d64d8020cce4d48b6d52f')
})

test('T-ID-3 ticketId collision with a different workKey fails closed and appends nothing', async t => {
  const { store, rows } = fixture(t)
  const first = await store.accept(work())
  const collisionInput = JSON.stringify(['tickets/v1', 'a', 'collision', 't'])
  const collisionKey = first.ticket.workKey.slice(0, 24) + 'f'.repeat(40)
  const createHash = crypto.createHash
  t.mock.method(crypto, 'createHash', (...args) => {
    const hash = createHash(...args)
    const update = hash.update.bind(hash)
    hash.update = (data, ...rest) => data === collisionInput ? { digest: () => collisionKey } : update(data, ...rest)
    return hash
  })
  const before = rows()
  await assert.rejects(store.accept(work('collision')), { code: 'TICKET_ID_COLLISION' })
  assert.deepEqual(rows(), before)
  assert.deepEqual(store.list(), [first.ticket])
})

test('T-ID-4 missing source, eventId, thread, identityRef or replyTo is denied with a closed code and appends nothing', async t => {
  const { store, rows } = fixture(t)
  for (const field of ['source', 'eventId', 'thread', 'identityRef', 'replyTo']) {
    const input = work()
    delete (field === 'replyTo' ? input : input.origin)[field]
    assert.deepEqual(await store.accept(input), {
      denied: true, code: field === 'identityRef' ? 'identity_unbound' : 'origin_unbound',
    }, field)
  }
  for (const input of [
    { ...work(), origin: origin('unknown', 'c', 't') },
    { ...work(), origin: origin('a', '   ', 't') },
    { ...work(), replyTo: { ...work().replyTo, requesterRef: '' } },
  ]) assert.deepEqual(await store.accept(input), { denied: true, code: 'origin_unbound' })
  assert.deepEqual(rows(), [])
  assert.deepEqual(store.list(), [])
})

test('T-DUP-1 replaying the same event returns the same ticketId with duplicate true and exactly one ledger row', async t => {
  const { store, rows } = fixture(t)
  const first = await store.accept({ ...work(), message: 'must never be stored' })
  first.ticket.replyTo.conversationId = 'changed by caller'
  assert.equal(first.duplicate, false)
  assert.equal(rows().length, 1)
  const second = await store.accept(work())
  assert.equal(second.ticket.ticketId, first.ticket.ticketId)
  assert.equal(second.ticket.replyTo.conversationId, 'room')
  assert.equal(second.duplicate, true)
  assert.equal(rows().length, 1, 'duplicate accept added a ledger row')
  assert.ok(!rows()[0].includes('must never be stored'))
  const distinct = await store.accept(work('different-event'))
  assert.notEqual(distinct.ticket.ticketId, first.ticket.ticketId, 'a distinct event was treated as a duplicate')
  assert.equal(distinct.duplicate, false)
  assert.equal(rows().length, 2)
})

test('T-DUP-2 a duplicate of an ended Ticket does not revive it and adds no row', async t => {
  const { dir, ledgerFile, store, rows } = fixture(t)
  const { ticket: { ticketId } } = await store.accept(work())
  const ended = await store.end(ticketId, { outcome: 'ok', reason: 'finished' })
  const before = rows()
  const duplicate = await store.accept(work())
  assert.equal(duplicate.ticket.state, 'ended', 'duplicate accept revived an ended ticket')
  assert.deepEqual(duplicate, { ticket: ended.ticket, duplicate: true })
  assert.deepEqual(await store.end(ticketId, { outcome: 'different' }), duplicate)
  assert.deepEqual(rows(), before)
  assert.equal(store.get(ticketId).state, 'ended')
  await store.close()
  fs.appendFileSync(ledgerFile, before[0] + '\n')
  const replay = createTicketStore({ dir, readOnly: true, now: () => at })
  t.after(() => replay.close())
  assert.equal(replay.readReport().duplicates, 1)
  assert.deepEqual(replay.get(ticketId), ended.ticket)
})

test('T-DUP-3 concurrent accepts of the same event in one process append once', async t => {
  const { store, rows } = fixture(t)
  const results = await Promise.all(Array.from({ length: 24 }, () => store.accept(work())))
  assert.equal(new Set(results.map(result => result.ticket.ticketId)).size, 1)
  assert.equal(results.filter(result => !result.duplicate).length, 1)
  assert.equal(rows().length, 1)
})
