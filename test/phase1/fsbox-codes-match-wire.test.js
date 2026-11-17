/** 漂移守卫：fsbox 本地错误码表必须与 wire 的 ERROR_CODE 同值。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ERROR_CODE } from '../../src/wire/index.js'
import { FS_ERROR_CODE } from '../../src/fsbox/index.js'

test('FS_ERROR_CODE 的每一项都等于 wire 的同名码', () => {
  assert.ok(Object.keys(FS_ERROR_CODE).length >= 5)
  for (const [k, v] of Object.entries(FS_ERROR_CODE)) assert.equal(v, ERROR_CODE[k], k)
})

test('fsbox 源码不 import wire / store', async () => {
  const fs = await import('node:fs')
  for (const f of ['index.js', 'glob.js']) {
    const text = fs.readFileSync(new URL(`../../src/fsbox/${f}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /^[ \t]*import\b[^\n]*from\s+['"][^'"\n]*(wire|store)[^'"\n]*['"]/m, f)
  }
})
