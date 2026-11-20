import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { repairWrite } from '../../lib/hub/repair-template.js'

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-repair-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const root = path.join(tmp, 'root')
  const backupDir = path.join(tmp, 'backups')
  fs.mkdirSync(root)
  fs.mkdirSync(backupDir)
  return { tmp, root, backupDir }
}

test('REPAIR-OK', (t) => {
  const { root, backupDir } = fixture(t)
  const relPath = 'target.txt'
  const target = path.join(root, relPath)
  const oldBytes = Buffer.from([0, 1, 255])
  const bytes = Buffer.from([255, 2, 0])
  fs.writeFileSync(target, oldBytes)

  const result = repairWrite({ root, relPath, bytes, backupDir })
  assert.equal(result.path, target)
  assert.equal(result.created, false)
  assert.deepEqual(fs.readFileSync(target), bytes)
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(path.dirname(result.backup), backupDir)
  assert.ok(path.basename(result.backup).includes(relPath))
  assert.deepEqual(fs.readFileSync(result.backup), oldBytes)

  const second = repairWrite({ root, relPath, bytes: oldBytes, backupDir })
  assert.notEqual(second.backup, result.backup)
  assert.deepEqual(fs.readFileSync(result.backup), oldBytes)
  assert.deepEqual(fs.readFileSync(second.backup), bytes)
})

test('REPAIR-CREATE', (t) => {
  const { root, backupDir } = fixture(t)
  const bytes = Buffer.from('new file')
  const result = repairWrite({ root, relPath: 'new.txt', bytes, backupDir })
  assert.equal(result.path, path.join(root, 'new.txt'))
  assert.equal(result.created, true)
  assert.equal(result.backup, null)
  assert.deepEqual(fs.readFileSync(result.path), bytes)
  assert.deepEqual(fs.readdirSync(backupDir), [])
})

test('REPAIR-ESCAPE', (t) => {
  const { tmp, root, backupDir } = fixture(t)
  const bytes = Buffer.from('must not be written')
  const write = (relPath) => repairWrite({ root, relPath, bytes, backupDir })
  const outside = path.join(tmp, 'outside.txt')
  assert.throws(() => write('../outside.txt'), { code: 'path-escape' })
  assert.throws(() => write(outside), { code: 'path-escape' })
  assert.equal(fs.existsSync(outside), false)
  assert.deepEqual(fs.readdirSync(root), [])

  fs.symlinkSync(outside, path.join(root, 'dangling-link'))
  fs.symlinkSync(tmp, path.join(root, 'directory-link'))
  assert.throws(() => write('dangling-link'), { code: 'path-escape' })
  assert.throws(() => write('directory-link/outside.txt'), { code: 'path-escape' })
  assert.equal(fs.existsSync(outside), false)

  fs.writeFileSync(outside, 'outside bytes')
  fs.symlinkSync(outside, path.join(root, 'file-link'))
  assert.throws(() => write('file-link'), { code: 'path-escape' })
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside bytes')
  assert.deepEqual(fs.readdirSync(root).sort(), ['dangling-link', 'directory-link', 'file-link'])
  assert.deepEqual(fs.readdirSync(backupDir), [])
})

test('REPAIR-ROLLBACK', (t) => {
  const { root, backupDir } = fixture(t)
  const relPath = 'target.txt'
  const target = path.join(root, relPath)
  const bytes = Buffer.from('replacement bytes')
  const original = 'original bytes'
  fs.writeFileSync(target, original)
  const readFileSync = fs.readFileSync
  let forcedMismatch = false

  try {
    fs.readFileSync = (file, ...args) => {
      const actual = readFileSync(file, ...args)
      if (file === target && Buffer.isBuffer(actual) && actual.equals(bytes)) {
        forcedMismatch = true
        return Buffer.from('mismatched verification bytes')
      }
      return actual
    }
    assert.throws(() => repairWrite({ root, relPath, bytes, backupDir }), { code: 'verify-failed' })
  } finally {
    fs.readFileSync = readFileSync
  }

  assert.equal(forcedMismatch, true)
  assert.equal(fs.readFileSync(target, 'utf8'), original, 'target bytes must be restored')
})

test('REPAIR-NO-TOOL', () => {
  const source = fs.readFileSync(new URL('../../lib/hub/repair-template.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /fs_write|PROTOCOL_VERSION|mcp/)
})
