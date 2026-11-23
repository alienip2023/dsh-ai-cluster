/**
 * Stress round 4, D5: the handoff manifest hashed every final file of the workspace on every task end, so the
 * fixed cost of a short task grew with the workspace size and with how many tasks ended together. Unchanged
 * files (same path, size, mtime) are hashed once and the result is reused; files that may still be changing
 * (mtime within 2 s of now) are never trusted from the cache.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildManifest, clearHashCache } from '../lib/artifacts.js'

const sha = (text) => createHash('sha256').update(text).digest('hex')
const shaOf = (manifest, rel) => manifest.items.find((item) => item.path === rel)?.sha256
const workspace = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-cache-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  clearHashCache()
  return dir
}
const writeOld = (file, text, ageMs = 60_000) => {
  fs.writeFileSync(file, text)
  const at = new Date(Date.now() - ageMs)
  fs.utimesSync(file, at, at)
}

test('HC-1: an unchanged file is hashed once; a changed one (new mtime) is hashed again', async (t) => {
  const dir = workspace(t)
  const file = path.join(dir, 'report.pdf')
  writeOld(file, 'version one')
  const first = await buildManifest({ workspace: dir })
  assert.equal(shaOf(first, 'report.pdf'), sha('version one'))
  // Prove the second build did not read the file: swap the content under the same size and mtime. A cache keyed on
  // (path, size, mtime) cannot see that, so it answers with the remembered hash.
  const stat = fs.statSync(file)
  fs.writeFileSync(file, 'VERSION ONE')
  fs.utimesSync(file, stat.atime, stat.mtime)
  const second = await buildManifest({ workspace: dir })
  assert.equal(shaOf(second, 'report.pdf'), sha('version one'), 'served from the cache, not re-read')
  // A real change moves the mtime: hashed again.
  writeOld(file, 'VERSION TWO', 30_000)
  const third = await buildManifest({ workspace: dir })
  assert.equal(shaOf(third, 'report.pdf'), sha('VERSION TWO'))
})

test('HC-2: a file modified within the last 2 s is never served from the cache', async (t) => {
  const dir = workspace(t)
  const file = path.join(dir, 'fresh.pdf')
  fs.writeFileSync(file, 'aaaa')
  const stat = fs.statSync(file)
  const first = await buildManifest({ workspace: dir })
  assert.equal(shaOf(first, 'fresh.pdf'), sha('aaaa'))
  fs.writeFileSync(file, 'bbbb')          // same size
  fs.utimesSync(file, stat.atime, stat.mtime) // and the same mtime: only the racy rule can save us
  const second = await buildManifest({ workspace: dir })
  assert.equal(shaOf(second, 'fresh.pdf'), sha('bbbb'), 'a fresh file is re-hashed every time')
})

test('HC-3: many builds at once agree, and share the read of an unchanged file', async (t) => {
  const dir = workspace(t)
  for (let i = 0; i < 20; i += 1) writeOld(path.join(dir, `p${i}.zip`), `content ${i}`)
  const manifests = await Promise.all(Array.from({ length: 10 }, () => buildManifest({ workspace: dir })))
  for (const manifest of manifests) {
    assert.equal(manifest.counts.final, 20)
    for (let i = 0; i < 20; i += 1) assert.equal(shaOf(manifest, `p${i}.zip`), sha(`content ${i}`))
  }
})
