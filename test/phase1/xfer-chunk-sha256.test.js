import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createFileTransferService, DEFAULT_TRANSFER_CHUNK_BYTES } from '../../src/xfer/transfer.js'

const sha = (b) => createHash('sha256').update(b).digest('hex')

function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xfer-chunk-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, svc: createFileTransferService({ roots: [dir] }) }
}
const payload = () => {
  const b = Buffer.alloc(1024 * 1024 + 1)
  for (let i = 0; i < b.length; i += 1) b[i] = (i * 31 + 7) & 0xff
  return b
}
const chunks = (buf) => {
  const out = []
  for (let off = 0; off < buf.length; off += DEFAULT_TRANSFER_CHUNK_BYTES) out.push({ offset: off, data: buf.subarray(off, off + DEFAULT_TRANSFER_CHUNK_BYTES) })
  return out
}

test('1 MiB + 1 字节：5 块、offset 等于累计值、整体 sha256 通过、落盘', (t) => {
  const { dir, svc } = setup(t)
  const buf = payload()
  const target = path.join(dir, 'out.bin')
  const { transferId } = svc.beginWrite({ path: target, size: buf.length, sha256: sha(buf) })
  const parts = chunks(buf)
  assert.equal(parts.length, 5, '1 MiB + 1 B 跨越块边界：4 个满块 + 1 个 1 字节块')
  let running = 0
  for (const c of parts) {
    assert.equal(c.offset, running, '每块 offset 等于已接收累计字节')
    const r = svc.writeChunk({ transferId, offset: c.offset, base64: c.data.toString('base64') })
    running += c.data.length
    assert.equal(r.offset, running)
  }
  assert.equal(fs.existsSync(target), false, '提交前读者看不到半个文件')
  const done = svc.commit({ transferId })
  assert.equal(done.sha256, sha(buf))
  assert.deepEqual(fs.readFileSync(target), buf)
  assert.deepEqual(fs.readdirSync(dir), ['out.bin'], '无残留临时文件')
})

test('错 offset 被拒且不推进计数', (t) => {
  const { dir, svc } = setup(t)
  const buf = payload()
  const { transferId } = svc.beginWrite({ path: path.join(dir, 'o.bin'), size: buf.length, sha256: sha(buf) })
  const [c0, c1] = chunks(buf)
  svc.writeChunk({ transferId, offset: 0, base64: c0.data.toString('base64') })
  assert.throws(() => svc.writeChunk({ transferId, offset: c1.offset + 1, base64: c1.data.toString('base64') }), (e) => e.code === 'offset-conflict' && e.details?.expectedOffset === c1.offset)
  const r = svc.writeChunk({ transferId, offset: c1.offset, base64: c1.data.toString('base64') })
  assert.equal(r.offset, c1.offset + c1.data.length)
})

test('第二块翻转 1 bit：commit 被拒，不留文件', (t) => {
  const { dir, svc } = setup(t)
  const buf = payload()
  const target = path.join(dir, 'bad.bin')
  const { transferId } = svc.beginWrite({ path: target, size: buf.length, sha256: sha(buf) })
  const bad = Buffer.from(buf)
  bad[DEFAULT_TRANSFER_CHUNK_BYTES + 10] ^= 0x01
  for (const c of chunks(bad)) svc.writeChunk({ transferId, offset: c.offset, base64: c.data.toString('base64') })
  assert.throws(() => svc.commit({ transferId }), (e) => /sha256 mismatch/.test(e.message))
  assert.equal(fs.existsSync(target), false)
  assert.deepEqual(fs.readdirSync(dir), [], '部分文件已删除')
})
