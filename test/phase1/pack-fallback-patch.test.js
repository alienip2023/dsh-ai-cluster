import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rewriteBundlePatch } from '../../scripts/rewrite-bundle-patch.mjs'

const targetName = 'dsh-remote-agent'
const original = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
const pair = '    - id: remote-agent\n      name: dsh-ai-cluster'

test('rewrites the inserted entry name', () => {
  assert.ok(rewriteBundlePatch(original, targetName).includes(
    '    - id: remote-agent\n      name: dsh-remote-agent',
  ))
})

test('preserves the id, comments, role, inject and every other byte', () => {
  const offset = original.indexOf('      name: dsh-ai-cluster') + '      name: '.length
  assert.ok(offset >= '      name: '.length)
  const expected = original.slice(0, offset) + targetName + original.slice(offset + 'dsh-ai-cluster'.length)
  assert.deepEqual(Buffer.from(rewriteBundlePatch(original, targetName)), Buffer.from(expected))
})

test('returns already-correct input unchanged', () => {
  const correct = original.replace(pair, pair.replace('dsh-ai-cluster', targetName))
  assert.equal(rewriteBundlePatch(correct, targetName), correct)
})

test('throws when there are zero id/name pairs', () => {
  assert.throws(() => rewriteBundlePatch(original.replace(pair, ''), targetName), /exactly one.*0 id\/name pairs/)
})

test('throws when there are two id/name pairs, even if one is already correct', () => {
  const second = '- insert:\n' + pair.replace('dsh-ai-cluster', targetName) + '\n'
  assert.throws(() => rewriteBundlePatch(original + second, targetName), /exactly one.*2 id\/name pairs/)
  assert.throws(() => rewriteBundlePatch(original.replace(pair, pair + '\n' + pair), targetName), /exactly one.*2 id\/name pairs/)
})

test('ignores matching pairs outside insert and in nested config lists', () => {
  const outside = '- update:\n' + pair + '\n'
  const nested = '- insert:\n    - id: other\n      config:\n        items:\n          - id: remote-agent\n            name: dsh-ai-cluster\n'
  const input = outside + nested + original
  assert.equal(rewriteBundlePatch(input, targetName), outside + nested + rewriteBundlePatch(original, targetName))
  assert.throws(() => rewriteBundlePatch(outside + nested, targetName), /exactly one.*0 id\/name pairs/)
})

test('preserves CRLF, inline comments, trailing spaces and a missing final newline', () => {
  const input = '# comment\r\n- insert:\r\n    - id: remote-agent # stable\r\n      name: dsh-ai-cluster  # import\r\n      config:\r\n        role: auto'
  assert.equal(rewriteBundlePatch(input, targetName), input.replace('name: dsh-ai-cluster', 'name: dsh-remote-agent'))
})

test('throws for an id without an adjacent name', () => {
  assert.throws(() => rewriteBundlePatch('- insert:\n    - id: remote-agent\n      config: {}\n', targetName), /exactly one.*0 id\/name pairs/)
})
