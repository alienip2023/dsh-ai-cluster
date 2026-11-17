import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAclConfig } from '../../src/caps/acl.js'

const bad = {
  'non-object': [], null: null, string: 'x',
  'wrong version': { version: 2 }, 'missing version': {},
  'non-boolean default': { version: 1, defaults: { read: 'yes' } },
  'unknown default cap': { version: 1, defaults: { sudo: true } },
  'allow not array': { version: 1, devices: { a: { allow: 'shell' } } },
  'deny not array': { version: 1, devices: { a: { deny: {} } } },
  'non-string entry': { version: 1, devices: { a: { allow: [1] } } },
  'bad nodeId': { version: 1, devices: { '-bad': { allow: [] } } },
  'nodeId too long': { version: 1, devices: { ['a'.repeat(65)]: {} } },
  'typo shel in allow': { version: 1, devices: { a: { allow: ['shel'] } } },
  'typo in deny': { version: 1, devices: { a: { deny: ['writ'] } } },
  'device not object': { version: 1, devices: { a: 1 } },
}
for (const [name, raw] of Object.entries(bad)) {
  test(`rejects ${name}`, () => {
    const r = normalizeAclConfig(raw)
    assert.equal(r.ok, false); assert.ok(r.errors.length > 0)
  })
}
test('allow+deny overlap: deny wins with note', () => {
  const r = normalizeAclConfig({ version: 1, devices: { a: { allow: ['shell', 'read'], deny: ['shell'] } } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.acl.devices.a, { allow: ['read'], deny: ['shell'] })
  assert.ok(r.notes.length === 1)
})
test('accepts @hub and minimal file', () => {
  assert.equal(normalizeAclConfig({ version: 1 }).ok, true)
  assert.equal(normalizeAclConfig({ version: 1, devices: { '@hub': { allow: ['shell'] } } }).ok, true)
})
