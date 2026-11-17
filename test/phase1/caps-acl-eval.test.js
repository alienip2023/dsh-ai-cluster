import test from 'node:test'
import assert from 'node:assert/strict'
import { ACL_CAPABILITIES, ACL_DEFAULTS, checkAcl, assertAcl, describeAcl, resolveAclUpdate, makeAcl } from '../../src/caps/acl.js'
import { ERROR_CODE } from '../../src/wire/errors.js'

const acl = { version: 1, defaults: { ...ACL_DEFAULTS }, devices: { a: { allow: ['shell', 'write'], deny: ['write', 'delegate'] }, b: { allow: ['desktop'], deny: [] } } }

test('order: unknown capability first', () => {
  assert.deepEqual(checkAcl(acl, { node: 'a', capability: 'root' }), { allowed: false, reason: 'unknown-capability' })
})
test('order: device-deny beats allow', () => {
  assert.deepEqual(checkAcl(acl, { node: 'a', capability: 'write' }), { allowed: false, reason: 'device-deny' })
})
test('order: device-allow', () => {
  assert.deepEqual(checkAcl(acl, { node: 'a', capability: 'shell' }), { allowed: true, reason: 'device-allow' })
})
test('order: default; unknown device never auto-allow', () => {
  assert.deepEqual(checkAcl(acl, { node: 'zzz', capability: 'read' }), { allowed: true, reason: 'default' })
  assert.deepEqual(checkAcl(acl, { node: 'zzz', capability: 'shell' }), { allowed: false, reason: 'default' })
})
test('shell/desktop off for unlisted devices', () => {
  for (const node of ['x', '@hub', '__proto__', 'constructor']) {
    for (const capability of ['shell', 'desktop']) assert.equal(checkAcl(acl, { node, capability }).allowed, false)
  }
})
test('assertAcl error shape', () => {
  assert.doesNotThrow(() => assertAcl(acl, { node: 'a', capability: 'shell' }))
  try { assertAcl(acl, { node: 'x', capability: 'shell', tool: 'cluster_exec' }); assert.fail('no throw') } catch (e) {
    assert.equal(e.code, 'ACL_DENIED'); assert.equal(e.node, 'x'); assert.equal(e.capability, 'shell'); assert.equal(e.reason, 'default')
    assert.equal(e.wireCode, ERROR_CODE.ACL_DENIED)
  }
})
test('describeAcl equals checkAcl', () => {
  const d = describeAcl(acl, ['a', 'b', 'c'])
  for (const { node, effective } of d.devices) for (const c of ACL_CAPABILITIES) assert.equal(effective[c], checkAcl(acl, { node, capability: c }).allowed)
})
test('resolveAclUpdate: mutual exclusion, reset, invalid', () => {
  const r = resolveAclUpdate(makeAcl(), { node: 'n', allow: ['shell'] })
  assert.equal(r.changed, true)
  const r2 = resolveAclUpdate(r.acl, { node: 'n', deny: ['shell'] })
  assert.deepEqual(r2.acl.devices.n, { allow: [], deny: ['shell'] })
  assert.deepEqual(resolveAclUpdate(r2.acl, { reset: true }).acl, makeAcl())
  assert.throws(() => resolveAclUpdate(makeAcl(), { node: 'n', allow: ['shel'] }), { code: 'E_INVALID_ARG' })
  assert.throws(() => resolveAclUpdate(makeAcl(), { node: '../x', allow: ['read'] }), { code: 'E_INVALID_ARG' })
})
