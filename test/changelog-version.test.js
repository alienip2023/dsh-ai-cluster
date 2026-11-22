/**
 * Doc drift: CHANGELOG.md used to stop at 0.4.6 while the package was 0.4.20 and nothing noticed.
 * scripts/check-doc-drift.mjs now compares package.json's version with the newest CHANGELOG heading and the
 * READMEs; this test runs it so `npm test` catches a release that forgot the changelog.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version

test('the newest CHANGELOG heading is the package.json version', () => {
  const heads = [...readFileSync(new URL('CHANGELOG.md', root), 'utf8').matchAll(/^## (\d+\.\d+\.\d+\S*)/gm)].map((m) => m[1])
  assert.equal(heads[0], version)
  assert.equal(new Set(heads).size, heads.length, 'no duplicated version heading')
})

test('every released 0.4.x version has a CHANGELOG entry', () => {
  const heads = new Set([...readFileSync(new URL('CHANGELOG.md', root), 'utf8').matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((m) => m[1]))
  const [major, minor, patch] = version.split('.').map(Number)
  for (let p = 0; p <= patch; p++) assert.ok(heads.has(`${major}.${minor}.${p}`), `missing ${major}.${minor}.${p}`)
})

test('check-doc-drift.mjs reports the version checks and finds no drift', () => {
  const out = JSON.parse(execFileSync(process.execPath, ['scripts/check-doc-drift.mjs', '--json'], { cwd: new URL('.', root), encoding: 'utf8' }))
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r]))
  assert.equal(byId['identity.changelog']?.ok, true)
  assert.equal(byId['identity.readme-version']?.ok, true)
  assert.equal(out.failed, 0)
})
