import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { FileTransferError, createFileTransferService } from '../../lib/node/file-transfer-service.js'
import { ERROR_CODE } from '../../lib/protocol.js'

const day = '2026-11-20'
const chunk = Buffer.from('abcd')

function fixture(t, dailyBytes = 10) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-daily-quota-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const input = path.join(root, 'input.bin')
  const usageFile = path.join(root, 'transfer-usage.json')
  fs.writeFileSync(input, chunk)
  const cfg = { roots: [root], dailyBytes, usageFile, now: () => Date.parse(`${day}T23:59:59Z`) }
  const create = () => {
    const service = createFileTransferService(cfg)
    t.after(() => service.dispose())
    return service
  }
  const read = (service) => service.readChunk({ path: input, length: chunk.length + 1 })
  const usage = () => JSON.parse(fs.readFileSync(usageFile, 'utf8'))
  return { root, input, cfg, create, read, usage }
}

function assertOverQuota(call, dailyBytes, usedToday) {
  assert.throws(call, (error) => {
    assert.ok(error instanceof FileTransferError)
    assert.equal(error.code, ERROR_CODE.ARTIFACT_TOO_LARGE)
    assert.match(error.message, /daily transfer quota exceeded/)
    assert.deepEqual(error.details, { dailyBytes, usedToday })
    return true
  })
}

test('QUOTA-UNDER', (t) => {
  const { create, read, usage } = fixture(t)
  assert.equal(read(create()).length, 4)
  assert.deepEqual(usage(), { day, bytes: 4 })
})

test('QUOTA-OVER', (t) => {
  const { create, read, usage } = fixture(t)
  const service = create()
  read(service)
  read(service)
  assertOverQuota(() => read(service), 10, 8)
  assert.deepEqual(usage(), { day, bytes: 8 })
})

test('QUOTA-WRITE', (t) => {
  const { root, input, create, read, usage } = fixture(t, 6)
  const service = create()
  service.stat({ path: input })
  const { transferId } = service.beginWrite({
    path: path.join(root, 'output.bin'),
    size: 8,
    sha256: createHash('sha256').update(chunk).update(chunk).digest('hex'),
  })
  const base64 = chunk.toString('base64')
  service.writeChunk({ transferId, offset: 0, base64 })
  assertOverQuota(() => read(service), 6, 4)
  assertOverQuota(() => service.writeChunk({ transferId, offset: 4, base64 }), 6, 4)
  assert.equal(service.abort({ transferId }).aborted, true)
  assert.deepEqual(usage(), { day, bytes: 4 })
})

test('QUOTA-RESET', (t) => {
  const { cfg, create, read, usage } = fixture(t, 4)
  let now = Date.parse(`${day}T23:59:59Z`)
  cfg.now = () => now
  const service = create()
  read(service)
  now += 1000
  assert.equal(read(service).length, 4)
  assert.deepEqual(usage(), { day: '2026-11-21', bytes: 4 })
})

test('QUOTA-RESTART', (t) => {
  const { create, read, usage } = fixture(t)
  const first = create()
  read(first)
  first.dispose()
  const second = create()
  read(second)
  assert.deepEqual(usage(), { day, bytes: 8 })
  assertOverQuota(() => read(second), 10, 8)
})

test('QUOTA-OFF', (t) => {
  const { create, read, usage } = fixture(t, 0)
  assert.equal(read(create()).length, 4)
  assert.deepEqual(usage(), { day, bytes: 4 })
})

test('QUOTA-BAD', () => {
  assert.throws(() => createFileTransferService({ dailyBytes: -1 }), RangeError)
  assert.throws(() => createFileTransferService({ dailyBytes: 1.5 }), RangeError)
})
