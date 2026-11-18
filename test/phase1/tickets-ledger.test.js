import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTicketStore } from '../../src/tickets/index.js'

const at = '2026-11-18T00:00:00.000Z'
const work = eventId => ({
  origin: { source: 'source', eventId, thread: '李', identityRef: 'caller' },
  replyTo: { kind: 'chat', conversationId: 'room', requesterRef: 'caller' },
})
const fragment = '{"v":1,"seq":4,"type":"acc'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-ledger-'))
  const file = path.join(dir, 'ledger.jsonl')
  const stores = []
  t.after(async () => {
    try {
      for (const store of stores) await store.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  const open = (opts = {}) => {
    const store = createTicketStore({ dir, sources: ['source'], now: () => at, ...opts })
    stores.push(store)
    return store
  }
  return { dir, file, open }
}

async function seed(t) {
  const f = fixture(t)
  const writer = f.open({ durability: 'none' })
  const first = (await writer.accept(work('first'))).ticket
  await writer.accept(work('second'))
  await writer.end(first.ticketId, { outcome: 'ok', reason: 'done' })
  const { ticket } = await writer.accept(work('fourth'))
  await writer.close()
  const rows = fs.readFileSync(f.file, 'utf8').trimEnd().split('\n')
  const valid = rows.slice(0, 3).join('\n') + '\n'
  fs.unlinkSync(path.join(f.dir, 'snapshot.json'))
  fs.writeFileSync(f.file, valid)
  return { ...f, rows, valid, fourth: ticket }
}

const files = dir => Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name))]))

function traceFs() {
  const calls = []
  const opened = new Map()
  const fsOps = {
    ...fs,
    openSync(file, ...args) {
      const fd = fs.openSync(file, ...args)
      opened.set(fd, path.basename(file))
      return fd
    },
    writeSync(fd, ...args) {
      calls.push(['write', opened.get(fd)])
      return fs.writeSync(fd, ...args)
    },
    fsyncSync(fd) {
      calls.push(['fsync', opened.get(fd)])
      fs.fsyncSync(fd)
    },
    renameSync(from, to) {
      calls.push(['rename', path.basename(to)])
      fs.renameSync(from, to)
    },
    unlinkSync(file) {
      calls.push(['unlink', path.basename(file)])
      fs.unlinkSync(file)
    },
  }
  return { fsOps, calls, opened }
}

test('T-DUP-4 an identical duplicated ledger line is skipped on replay and counted', async t => {
  const { file, rows, open } = await seed(t)
  fs.writeFileSync(file, [rows[0], rows[1], rows[1], rows[2], ''].join('\n'))
  const reader = open({ readOnly: true })
  assert.equal(reader.readReport().duplicates, 1)
  assert.equal(reader.list().length, 2)
  assert.equal(reader.list({ state: 'ended' }).length, 1)
  const writer = open()
  await writer.checkpoint()
  assert.equal(open({ readOnly: true }).readReport().duplicates, 1)
})

test('T-LOG-1 accept resolves only after write and fsync succeeded (fsOps order: write then fsync)', async t => {
  const f = fixture(t)
  const { fsOps, calls, opened } = traceFs()
  const write = fsOps.writeSync
  fsOps.writeSync = (fd, buffer, offset, length, position) => write(
    fd, buffer, offset, opened.get(fd) === 'ledger.jsonl' && offset === 0 ? Math.min(12, length) : length, position,
  )
  const store = f.open({ fsOps })
  const pending = store.accept(work('first'))
  assert.deepEqual(store.list(), [])
  const { ticket } = await pending
  assert.equal(store.readReport().durability, 'fsync')
  assert.deepEqual(calls.filter(([, file]) => file === 'ledger.jsonl'), [
    ['write', 'ledger.jsonl'], ['write', 'ledger.jsonl'], ['fsync', 'ledger.jsonl'],
  ])
  assert.deepEqual(store.list(), [ticket])
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).ticketId, ticket.ticketId)
})

test('T-LOG-2 a write or fsync failure rejects, leaves memory unchanged, and fails the store closed', async t => {
  for (const operation of ['write', 'fsync']) {
    const f = fixture(t)
    const { fsOps, opened } = traceFs()
    const failure = Error(`simulated ${operation} failure`)
    const write = fsOps.writeSync
    fsOps.writeSync = (fd, buffer, offset, length, position) => {
      if (operation === 'write' && opened.get(fd) === 'ledger.jsonl') {
        if (offset !== 0) throw failure
        return write(fd, buffer, offset, 12, position)
      }
      return write(fd, buffer, offset, length, position)
    }
    const sync = fsOps.fsyncSync
    fsOps.fsyncSync = fd => {
      if (operation === 'fsync' && opened.get(fd) === 'ledger.jsonl') throw failure
      sync(fd)
    }
    const store = f.open({ fsOps })
    const pending = store.accept(work('first'))
    const queued = store.accept(work('queued'))
    await assert.rejects(pending, failure)
    await assert.rejects(queued, { code: 'TICKET_STORE_FAILED' })
    await assert.rejects(store.accept(work('later')), { code: 'TICKET_STORE_FAILED' })
    await assert.rejects(store.end('later', { outcome: 'ok' }), { code: 'TICKET_STORE_FAILED' })
    await assert.rejects(store.markInterrupted('later', 'unknown'), { code: 'TICKET_STORE_FAILED' })
    await assert.rejects(store.checkpoint(), { code: 'TICKET_STORE_FAILED' })
    assert.deepEqual(store.list(), [])
    await store.close()
    assert.equal(fs.existsSync(path.join(f.dir, 'snapshot.json')), false)
    const reopened = f.open()
    assert.equal(reopened.list().length, operation === 'fsync' ? 1 : 0)
    assert.equal(Boolean(reopened.readReport().tornTail), operation === 'write')
    await reopened.accept(work('later'))
  }
})

test('T-TAIL-1 an unterminated final line is ignored, valid JSON or not', async t => {
  const { file, valid, rows, open, fourth } = await seed(t)
  for (const tail of [fragment, rows[3]]) {
    fs.writeFileSync(file, valid + tail)
    const reader = open({ readOnly: true })
    assert.deepEqual(reader.readReport().tornTail, { bytes: Buffer.byteLength(tail), offset: Buffer.byteLength(valid) })
    assert.equal(reader.list().length, 2)
    assert.equal(reader.get(fourth.ticketId), undefined)
  }
})

test('T-TAIL-2 opening for write quarantines the torn tail and truncates to the last newline, and the next append starts on a clean line', async t => {
  for (const complete of [false, true]) {
    const { dir, file, valid, rows, open } = await seed(t)
    const tail = complete ? rows[3] : fragment
    fs.writeFileSync(file, valid + tail)
    const { fsOps, calls, opened } = traceFs()
    fsOps.ftruncateSync = (fd, size) => {
      calls.push(['truncate', opened.get(fd)])
      fs.ftruncateSync(fd, size)
    }
    const writer = open({ fsOps })
    const { quarantine, bytes, offset } = writer.readReport().tornTail
    assert.equal(typeof quarantine, 'string', 'torn tail was not quarantined')
    assert.match(quarantine, /^ledger\.jsonl\.torn-.*-0$/)
    assert.equal(fs.readFileSync(path.join(dir, quarantine), 'utf8'), tail)
    assert.equal(bytes, Buffer.byteLength(tail))
    assert.equal(offset, Buffer.byteLength(valid))
    assert.equal(fs.readFileSync(file, 'utf8'), valid)
    assert.deepEqual(calls.slice(-4), [
      ['write', quarantine], ['fsync', quarantine], ['truncate', 'ledger.jsonl'], ['fsync', 'ledger.jsonl'],
    ])
    await writer.accept(work('replacement'))
    const appended = fs.readFileSync(file, 'utf8')
    assert.ok(appended.startsWith(valid))
    assert.equal(JSON.parse(appended.slice(valid.length)).seq, 4)
    assert.equal(open({ readOnly: true }).list().length, 3)
  }
})

test('T-TAIL-3 a read-only open ignores the tail and changes no byte on disk', async t => {
  const { dir, file, valid, open } = await seed(t)
  fs.writeFileSync(file, valid + fragment)
  fs.writeFileSync(path.join(dir, 'snapshot.json'), 'junk')
  fs.writeFileSync(path.join(dir, 'snapshot.json.tmp-crashed'), 'orphan')
  const before = files(dir)
  const first = open({ readOnly: true })
  const second = open({ readOnly: true })
  assert.deepEqual(first.list(), second.list())
  assert.equal(first.readReport().tornTail.bytes, fragment.length)
  assert.throws(() => first.checkpoint(), { code: 'TICKET_READ_ONLY' })
  await first.close()
  await second.close()
  assert.deepEqual(files(dir), before)
})

test('T-TAIL-4 an invalid terminated line anywhere, including the last line, fails closed with line and offset', async t => {
  const { dir, file, rows, open } = await seed(t)
  const invalid = [
    [1, '{not json', 'interior'], [2, 'garbage', 'last terminated'], [2, '', 'empty terminated'],
    [2, JSON.stringify({ ...JSON.parse(rows[2]), v: 2 }), 'wrong version'],
    [2, JSON.stringify({ ...JSON.parse(rows[2]), reason: [] }), 'wrong shape'],
    [2, JSON.stringify({ ...JSON.parse(rows[2]), ticketId: 'tk_absent' }), 'unknown ticket'],
    [1, JSON.stringify({ ...JSON.parse(rows[1]), workKey: 'f'.repeat(64) }), 'invalid work key'],
    [1, JSON.stringify({ ...JSON.parse(rows[1]), ticketId: 'tk_wrong' }), 'invalid ticket ID'],
    [3, JSON.stringify({ ...JSON.parse(rows[2]), seq: 4 }), 'already ended'],
    [3, JSON.stringify({ ...JSON.parse(rows[2]), seq: 4, type: 'interrupt' }), 'invalid interrupt'],
  ]
  for (const [index, replacement, label] of invalid) {
    const input = rows.slice(0, 3)
    input[index] = replacement
    fs.writeFileSync(file, input.join('\n') + '\n')
    const before = files(dir)
    const expected = {
      code: 'TICKET_LEDGER_CORRUPT', line: index + 1,
      offset: Buffer.byteLength(rows.slice(0, index).join('\n') + '\n'),
    }
    assert.throws(() => open({ readOnly: true }), expected, label)
    assert.throws(() => open(), expected, label)
    assert.deepEqual(files(dir), before)
  }
  fs.writeFileSync(file, rows.slice(0, 3).join('\n') + '\n')
  await open().close()
  const wrongShape = JSON.stringify({ ...JSON.parse(rows[2]), reason: [] })
  fs.writeFileSync(file, [rows[0], rows[1], wrongShape, ''].join('\n'))
  assert.throws(() => open(), { code: 'TICKET_LEDGER_CORRUPT', line: 3 }, 'stale snapshot hash cannot mask ledger corruption')
})

test('T-TAIL-5 a gap or conflicting duplicate seq fails closed', async t => {
  const { file, rows, open } = await seed(t)
  const conflicting = JSON.stringify({ ...JSON.parse(rows[1]), mandateRef: 'different' })
  for (const line of [rows[3], conflicting, rows[1] + ' ']) {
    fs.writeFileSync(file, [rows[0], rows[1], line, ''].join('\n'))
    assert.throws(() => open(), {
      code: 'TICKET_LEDGER_CORRUPT', line: 3, offset: Buffer.byteLength(rows[0] + '\n' + rows[1] + '\n'),
    })
  }
})

test('T-ADM-1 mutations after close are rejected with TICKET_CLOSED', async t => {
  const { open } = fixture(t)
  const store = open()
  const close = store.close()
  const attempt = action => {
    let result
    let error
    try { result = action() } catch (caught) { error = caught }
    result?.catch(() => {})
    assert.equal(error?.code, 'TICKET_CLOSED', 'mutation must throw TICKET_CLOSED synchronously')
  }
  attempt(() => store.accept(work('late')))
  attempt(() => store.end('late', { outcome: 'ok' }))
  attempt(() => store.markInterrupted('late', 'unknown'))
  attempt(() => store.checkpoint())
  assert.equal(store.close(), close)
  await close
  attempt(() => store.accept(work('after close resolved')))
  assert.deepEqual(store.list(), [])
})

test('T-ADM-2 mutations admitted before close all complete before the final checkpoint and lock release', async t => {
  const { dir, open } = fixture(t)
  const { fsOps, calls } = traceFs()
  const store = open({ fsOps })
  const first = store.accept(work('first'))
  const second = store.accept(work('second'))
  const closed = store.close()
  assert.equal(fs.existsSync(path.join(dir, 'ledger.lock')), true)
  const tickets = (await Promise.all([first, second])).map(result => result.ticket)
  await closed
  assert.deepEqual(calls.filter(([, file]) => ['ledger.jsonl', 'snapshot.json', 'ledger.lock'].includes(file)).slice(1), [
    ['write', 'ledger.jsonl'], ['fsync', 'ledger.jsonl'], ['write', 'ledger.jsonl'], ['fsync', 'ledger.jsonl'],
    ['rename', 'snapshot.json'], ['unlink', 'ledger.lock'],
  ])
  assert.equal(fs.existsSync(path.join(dir, 'ledger.lock')), false)
  assert.deepEqual(open({ readOnly: true }).list(), tickets)
})

test('T-ADM-3 a second writer on the same directory fails with TICKET_LOCKED and a stale lock is never stolen', async t => {
  const { dir, open } = fixture(t)
  const lock = path.join(dir, 'ledger.lock')
  const writer = open()
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), { pid: process.pid, startedAt: at })
  assert.throws(() => open(), { code: 'TICKET_LOCKED', message: /operator/ })
  assert.deepEqual(open({ readOnly: true }).list(), [])
  await writer.close()
  const stale = JSON.stringify({ pid: 999999999, startedAt: '2000-01-01T00:00:00.000Z' })
  fs.writeFileSync(lock, stale)
  assert.throws(() => open(), { code: 'TICKET_LOCKED', message: /operator/ })
  assert.equal(fs.readFileSync(lock, 'utf8'), stale)
  fs.unlinkSync(lock)
  await open().close()
})
