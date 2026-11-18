import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTicketStore } from '../../src/tickets/index.js'

const at = '2026-11-18T00:00:00.000Z'
const work = eventId => ({
  origin: { source: 'source', eventId, thread: 'room', identityRef: 'caller' },
  replyTo: { kind: 'chat', conversationId: 'room', requesterRef: 'caller' },
})

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-snap-'))
  const file = path.join(dir, 'snapshot.json')
  const options = { dir, sources: ['source'], now: () => at }
  const stores = []
  t.after(async () => {
    try {
      for (const store of stores) await store.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  const open = opts => {
    const store = createTicketStore({ ...options, ...opts })
    stores.push(store)
    return store
  }
  return { dir, file, open, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) }
}

test('T-SNAP-1 snapshot is written to a temp file in the same directory, fsynced, then renamed (fsOps call order and dirname equality)', async t => {
  const { dir, file, open, read } = fixture(t)
  const calls = []
  const opened = new Map()
  const fsOps = {
    ...fs,
    openSync(name, ...args) {
      const fd = fs.openSync(name, ...args)
      calls.push(['open', name, ...args])
      opened.set(fd, name)
      return fd
    },
    writeSync(fd, ...args) {
      calls.push(['write', opened.get(fd)])
      return fs.writeSync(fd, ...args)
    },
    fsyncSync(fd) {
      calls.push(['fsync', opened.get(fd)])
      if (opened.get(fd) === dir) throw Object.assign(Error('directory fsync unsupported'), { code: 'ENOTSUP' })
      fs.fsyncSync(fd)
    },
    closeSync(fd) {
      calls.push(['close', opened.get(fd)])
      fs.closeSync(fd)
    },
    renameSync(from, to) {
      calls.push(['rename', from, to])
      fs.renameSync(from, to)
    },
  }
  const store = open({ fsOps, checkpointEvery: 1 })
  const { ticket } = await store.accept(work('first'))
  const temp = calls.find(([op, name]) => op === 'open' && path.basename(name).startsWith('snapshot.json.tmp-'))?.[1]
  assert.ok(temp, 'snapshot must use a temporary file')
  assert.equal(path.dirname(temp), dir, 'temp file must share the snapshot directory')
  assert.notEqual(temp, file)
  assert.deepEqual(calls.slice(-8), [
    ['open', temp, 'wx', 0o600], ['write', temp], ['fsync', temp], ['close', temp],
    ['rename', temp, file], ['open', dir, 'r'], ['fsync', dir], ['close', dir],
  ])
  assert.equal(store.readReport().syncDir, 'unsupported')
  assert.deepEqual(read().tickets, [ticket])
})

test('T-SNAP-2 a crash before rename leaves the previous snapshot intact and no temp file is read', async t => {
  const { dir, file, open } = fixture(t)
  const failure = Error('simulated interruption before rename')
  let crash = false
  let interruptedTemp
  const writer = open({ fsOps: {
    ...fs,
    renameSync(from, to) {
      if (crash && to === file) {
        interruptedTemp = fs.readFileSync(from)
        throw failure
      }
      fs.renameSync(from, to)
    },
  } })
  await writer.accept(work('before'))
  await writer.checkpoint()
  const before = fs.readFileSync(file)
  await writer.accept(work('after'))
  crash = true
  try {
    await assert.rejects(writer.checkpoint(), failure, 'expected checkpoint to reach the injected pre-rename crash')
  } finally {
    crash = false
  }
  assert.deepEqual(fs.readFileSync(file), before)
  const orphan = path.join(dir, 'snapshot.json.tmp-orphan')
  assert.ok(!fs.readdirSync(dir).some(name => name.startsWith('snapshot.json.tmp-')))
  fs.writeFileSync(orphan, interruptedTemp)
  const reads = []
  const reader = open({ readOnly: true, fsOps: {
    ...fs, readFileSync(name, ...args) { reads.push(name); return fs.readFileSync(name, ...args) },
  } })
  assert.deepEqual(reader.list(), writer.list())
  assert.ok(!reads.includes(orphan))
  assert.ok(fs.existsSync(orphan))
  await writer.close()
  await open().close()
  assert.ok(!fs.existsSync(orphan))
})

test('T-SNAP-3 snapshot plus replayed suffix equals full replay', async t => {
  const { file, open } = fixture(t)
  const writer = open({ durability: 'none' })
  const first = (await writer.accept(work('before'))).ticket
  await writer.checkpoint()
  await writer.end(first.ticketId, { outcome: 'ok' })
  await writer.accept(work('after'))
  let checkpointReader
  assert.doesNotThrow(() => { checkpointReader = open({ readOnly: true }) }, 'a valid checkpoint must load with its suffix')
  assert.equal(checkpointReader.readReport().snapshot, 'loaded')
  fs.unlinkSync(file)
  const full = open({ readOnly: true })
  assert.equal(full.readReport().snapshot, 'rebuilt')
  assert.deepEqual(checkpointReader.list(), full.list())
  assert.deepEqual(full.list(), writer.list())
})

test('T-SNAP-4 a snapshot ahead of the ledger or with a wrong head hash fails closed with TICKET_SNAPSHOT_MISMATCH', async t => {
  const { dir, file, open, read } = fixture(t)
  const writer = open()
  await writer.accept(work('first'))
  await writer.close()
  const good = read()
  const ledgerFile = path.join(dir, 'ledger.jsonl')
  const ledger = fs.readFileSync(ledgerFile)
  for (const change of [
    { throughSeq: good.throughSeq + 1 }, { throughOffset: good.throughOffset + 1 },
    { throughOffset: good.throughOffset - 1 }, { ledgerHeadSha256: '0'.repeat(64) },
    { tickets: [] }, { tickets: [{ ...good.tickets[0], state: 'ended' }] },
  ]) {
    const bad = JSON.stringify({ ...good, ...change })
    fs.writeFileSync(file, bad)
    assert.throws(() => open(), { code: 'TICKET_SNAPSHOT_MISMATCH' })
    assert.equal(fs.readFileSync(file, 'utf8'), bad)
    assert.deepEqual(fs.readFileSync(ledgerFile), ledger)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['ledger.jsonl', 'snapshot.json'])
  }
})

test('T-SNAP-5 a missing or junk snapshot with an intact ledger rebuilds from the ledger', async t => {
  const { dir, file, open } = fixture(t)
  const writer = open()
  const { ticket } = await writer.accept(work('first'))
  await writer.close()
  fs.unlinkSync(file)
  const missing = open({ readOnly: true })
  assert.equal(missing.readReport().snapshot, 'rebuilt')
  assert.deepEqual(missing.list(), [ticket])
  assert.ok(!fs.existsSync(file))
  fs.writeFileSync(file, 'bad snapshot')
  const junk = open({ readOnly: true })
  assert.equal(junk.readReport().snapshot, 'rebuilt')
  assert.deepEqual(junk.list(), [ticket])
  assert.equal(fs.readFileSync(file, 'utf8'), 'bad snapshot')
  const rebuild = open()
  assert.equal(rebuild.readReport().snapshot, 'rebuilt')
  assert.deepEqual(rebuild.list(), [ticket])
  assert.ok(!fs.existsSync(file))
  const quarantined = fs.readdirSync(dir).filter(name => name.startsWith('snapshot.json.bad-'))
  assert.equal(quarantined.length, 1)
  assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), 'bad snapshot')
  await rebuild.close()
  assert.equal(open({ readOnly: true }).readReport().snapshot, 'loaded')
})

test('T-SNAP-6 checkpoint boundary: records at throughSeq and throughSeq+1 are applied exactly once', async t => {
  const { open, read } = fixture(t)
  const writer = open()
  const { ticket } = await writer.accept(work('first'))
  await writer.checkpoint()
  const { ticket: ended } = await writer.end(ticket.ticketId, { outcome: 'ok' })
  assert.equal(read().throughSeq, 1, 'checkpoint must cover the last record it included')
  assert.deepEqual(read().tickets, [ticket])
  const reader = open({ readOnly: true })
  assert.deepEqual(reader.list(), [ended])
  assert.equal(reader.readReport().duplicates, 0)
  await writer.checkpoint()
  assert.equal(read().throughSeq, 2)
  assert.deepEqual(open({ readOnly: true }).list(), [ended])
})
