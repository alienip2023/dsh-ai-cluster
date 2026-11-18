import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTicketStore } from '../../src/tickets/index.js'

const at = '2026-11-18T00:00:00.000Z'
const executorRef = { kind: 'test-executor', ref: 'opaque-ref' }
const work = (eventId, executorRef = null) => ({
  origin: { source: 'source', eventId, thread: 'room', identityRef: 'caller' },
  replyTo: { kind: 'chat', conversationId: 'room', requesterRef: 'caller' },
  executorRef,
})

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-recovery-'))
  const opts = { dir, sources: ['source'], now: () => at, durability: 'none', ...extra }
  const stores = []
  t.after(async () => {
    try {
      for (const store of stores) await store.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  const open = (optsForOpen = {}) => {
    const store = createTicketStore({ ...opts, ...optsForOpen })
    stores.push(store)
    return store
  }
  const bytes = () => Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name))]))
  const rows = () => fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trimEnd().split('\n').map(JSON.parse)
  return { open, bytes, rows }
}

test('T-REC-1 recovery reports open Tickets with an executorRef as in-flight and changes nothing on disk', async t => {
  const { open, bytes } = fixture(t)
  const writer = open()
  const withExec = (await writer.accept(work('in-flight', executorRef))).ticket
  const noExec = (await writer.accept(work('no-executor'))).ticket
  const toEnd = (await writer.accept(work('to-end', executorRef))).ticket
  const toInterrupt = (await writer.accept(work('to-interrupt', executorRef))).ticket
  await writer.end(toEnd.ticketId, { outcome: 'ok' })
  await writer.markInterrupted(toInterrupt.ticketId, 'unknown')
  await writer.close()
  const before = bytes()
  const reader = open({ readOnly: true })
  assert.deepEqual(reader.recoveryReport(), {
    inFlight: [{ ticketId: withExec.ticketId, executorRef, createdAt: at }],
    openWithoutExecutor: [noExec.ticketId], ended: 1, interrupted: 1,
    tornTail: null, duplicates: 0, snapshot: 'loaded',
    status: 'unverified: not assumed running, not assumed stopped',
  })
  reader.recoveryReport().inFlight[0].executorRef.ref = 'changed by caller'
  assert.deepEqual(reader.get(withExec.ticketId), withExec)
  await reader.close()
  assert.deepEqual(bytes(), before)
})

test('T-REC-2 recovery never calls any dispatch, requeue or send function (spy never called; module source imports only node: and ./)', async t => {
  const dispatch = t.mock.fn()
  const requeue = t.mock.fn()
  const send = t.mock.fn()
  const spies = { dispatch, requeue, send }
  const { open, rows } = fixture(t, spies)
  const writer = open()
  const { ticket } = await writer.accept({ ...work('in-flight', executorRef), ...spies })
  await writer.close()
  for (const readOnly of [true, false]) {
    const reopened = open({ readOnly, ...spies })
    assert.equal(reopened.recoveryReport(spies).inFlight[0].ticketId, ticket.ticketId)
    assert.equal(reopened.get(ticket.ticketId).state, 'open')
    await reopened.close()
  }
  assert.equal(dispatch.mock.callCount(), 0, 'recovery called an inert dispatch spy')
  assert.equal(requeue.mock.callCount(), 0, 'recovery called an inert requeue spy')
  assert.equal(send.mock.callCount(), 0, 'recovery called an inert send spy')
  assert.equal(rows().length, 1)
  const sourceDir = new URL('../../src/tickets/', import.meta.url)
  for (const name of fs.readdirSync(sourceDir)) {
    const source = fs.readFileSync(new URL(name, sourceDir), 'utf8')
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      assert.match(match[1], /^(node:|\.\/)/, name)
    }
  }
})

test('T-REC-3 markInterrupted is explicit, appends one row for an open Ticket, and nothing for others', async t => {
  const { open, rows } = fixture(t)
  const writer = open()
  const openTicket = (await writer.accept(work('in-flight', executorRef))).ticket
  const toEnd = (await writer.accept(work('to-end'))).ticket
  const { ticket: ended } = await writer.end(toEnd.ticketId, { outcome: 'ok' })
  const count = rows().length
  assert.equal(writer.recoveryReport().inFlight.length, 1)
  assert.equal(rows().length, count)
  const { ticket, duplicate } = await writer.markInterrupted(openTicket.ticketId, 'unknown execution reference')
  assert.equal(duplicate, false)
  assert.deepEqual(ticket, { ...openTicket, state: 'interrupted', endedAt: at, reason: 'unknown execution reference' })
  assert.deepEqual(rows().at(-1), {
    v: 1, seq: count + 1, type: 'interrupt', at, ticketId: openTicket.ticketId, reason: ticket.reason,
  })
  assert.deepEqual(await writer.markInterrupted(openTicket.ticketId, 'changed'), { ticket, duplicate: true })
  assert.deepEqual(await writer.markInterrupted(ended.ticketId, 'noop'), { ticket: ended, duplicate: true })
  assert.deepEqual(await writer.accept(work('in-flight', executorRef)), { ticket, duplicate: true })
  assert.equal(rows().length, count + 1)
  assert.equal(writer.recoveryReport().inFlight.length, 0)
  assert.equal(writer.recoveryReport().interrupted, 1)
  await writer.close()
  assert.deepEqual(open({ readOnly: true }).list(), [ticket, ended])
})
