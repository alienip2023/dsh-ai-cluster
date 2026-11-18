import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as authz from '../../src/authz/decide.js'

const { decideAuthorization } = authz
const request = { action: 'read', target: 'file.one' }
const policy = (overrides = {}) => ({
  mode: 'explicit',
  actions: ['read', 'write'],
  targets: ['file.one', 'file.two'],
  allow: [{ ...request }, { action: 'write', target: 'file.two' }],
  ...overrides,
})

const check = (input, rules, reasonCode, decision = 'deny') => {
  assert.deepStrictEqual(decideAuthorization(input, rules), { decision, reasonCode })
}
const unreadable = () => { throw new Error('getter was read') }
const withGetter = (object, key) => Object.defineProperty(object, key, { get: unreadable, enumerable: true })
const names = (length, prefix) => Array.from({ length }, (_, i) => `${prefix}${i}`)

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

test('S2-R01 policy not plain data', () => {
  for (const rules of [null, [], false, new (class {})(), Object.create({ mode: 'explicit' }),
    withGetter({}, 'mode'), withGetter({ mode: 'off' }, 'allow'),
    { mode: 'off', [Symbol('extra')]: true }, Object.defineProperty({}, 'mode', { value: 'off' }),
  ]) check(request, rules, 'policy_malformed')
})

test('S2-R02 missing mode is off', () => {
  check(request, { actions: null }, 'mode_off')
  check(null, Object.create(null), 'mode_off')
})

test('S2-R03 null mode fails closed', () => {
  check(null, { mode: null }, 'mode_null')
})

test('S2-R04 off overrides malformed request', () => {
  check(request, policy({ mode: 'off' }), 'mode_off')
  check(withGetter({}, 'action'), { mode: 'off', actions: null, extra: true }, 'mode_off')
})

test('S2-R05 reserved modes fail closed', () => {
  for (const mode of ['observe', 'auto']) check(null, { mode }, 'mode_reserved')
})

test('S2-R06 non-string mode', () => {
  for (const mode of [undefined, 1, {}, false, Symbol('off')]) check(request, { mode }, 'mode_invalid')
})

test('S2-R07 unknown mode string', () => {
  for (const mode of ['Explicit', ' explicit', '', 'manual']) check(request, { mode }, 'mode_unknown')
})

test('S2-R08 policy shape', () => {
  check(request, policy({ extra: true }), 'policy_shape')
  for (const key of ['actions', 'targets', 'allow']) {
    const missing = policy()
    delete missing[key]
    check(request, missing, 'policy_shape')
    check(null, policy({ [key]: {} }), 'policy_shape')
  }
})

test('S2-R09 catalog entry invalid', () => {
  for (const actions of [[null], [1], ['READ'], ['read\n'], ['*'], ['a'.repeat(65)], ['read', 'read'],
    names(65, 'a'), Array(1), withGetter([], 0), Object.assign(['read'], { extra: true }),
    Object.defineProperty([], 0, { value: 'read' }),
  ]) check(null, policy({ actions, allow: [null] }), 'policy_catalog_invalid')
  check(request, policy({ targets: names(65, 't') }), 'policy_catalog_invalid')
})

test('S2-R10 allow entry invalid', () => {
  for (const entry of [null, [], Object.create(request), { action: 'read' },
    { ...request, role: 'admin' }, { ...request, target: '*' }, { ...request, [Symbol()]: true },
    withGetter({ ...request }, 'target'),
  ]) check(request, policy({ allow: [entry] }), 'policy_allow_invalid')
  for (const allow of [[request, { ...request }], Array(1), withGetter([], 0),
    names(257, 'a').map(action => ({ action, target: 'file.one' })),
    [{ action: 'uncataloged', target: 'file.one' }, null],
  ]) check(request, policy({ allow }), 'policy_allow_invalid')
})

test('S2-R11 allow outside catalog', () => {
  check(null, policy({ allow: [{ action: 'print', target: 'file.one' }] }), 'policy_allow_uncataloged')
  check(request, policy({ allow: [{ action: 'read', target: 'file.three' }] }), 'policy_allow_uncataloged')
})

test('S2-R12 request not plain data', () => {
  for (const input of [null, [], 'read', Object.create(request), withGetter({ ...request }, 'action'),
    { ...request, [Symbol('extra')]: true }, Object.defineProperty({ ...request }, 'hidden', { value: true }),
  ]) check(input, policy(), 'request_malformed')
})

test('S2-R13 extra request field', () => {
  check({ ...request, authorized: true }, policy(), 'request_extra_field')
  check({ action: 'read', role: 'admin' }, policy(), 'request_extra_field')
})

test('S2-R14 missing request field', () => {
  for (const input of [{}, { action: 'read' }, { target: 'file.one' }]) {
    check(input, policy(), 'request_missing_field')
  }
})

test('S2-R15 request field invalid', () => {
  for (const field of ['action', 'target']) {
    for (const value of [undefined, null, 1, {}, '', 'READ', ' read', 'read\n', 'read:all', 'a'.repeat(65)]) {
      check({ ...request, [field]: value }, policy(), 'request_field_invalid')
    }
  }
})

test('S2-R16 unknown action', () => {
  check({ action: 'reader', target: 'file.one' }, policy(), 'action_unknown')
  check({ action: 'reader', target: 'unknown' }, policy(), 'action_unknown')
})

test('S2-R17 unknown target', () => {
  check({ action: 'read', target: 'file' }, policy(), 'target_unknown')
})

test('S2-R18 valid but unlisted pair', () => {
  check({ action: 'read', target: 'file.two' }, policy(), 'pair_not_allowed')
  check(request, policy({ allow: [] }), 'pair_not_allowed')
})

test('S2-R19 exact listed pair allows', () => {
  check(request, policy(), 'pair_allowed', 'allow')
  const makeRecord = properties => Object.assign(Object.create(null), properties)
  const action = 'a' + 'z0_.-'.repeat(12) + 'z0_'
  const actions = [action, ...names(63, 'a')]
  const targets = names(64, 't')
  const allow = actions.slice(0, 4).flatMap(name => targets.map(target => makeRecord({ action: name, target })))
  check(makeRecord({ action, target: 't63' }), makeRecord(policy({ actions, targets, allow })), 'pair_allowed', 'allow')
})

test('S2-X1 inputs are not mutated', () => {
  const inputs = deepFreeze([{ ...request }, policy()])
  const before = JSON.stringify(inputs)
  decideAuthorization(...inputs)
  assert.equal(JSON.stringify(inputs), before)
})

test('S2-X2 deterministic repeat', () => {
  const rules = policy()
  const first = decideAuthorization(request, rules)
  const second = decideAuthorization(request, rules)
  assert.deepStrictEqual(first, second)
  assert.notStrictEqual(first, second)
  assert.ok(Object.isFrozen(first) && Object.isFrozen(second))
})

test('S2-X3 source purity', () => {
  const source = readFileSync(new URL('../../src/authz/decide.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /import|Date|Math\.random|process|console|require/)
})

test('S2-X4 export surface', () => {
  assert.deepStrictEqual(Object.keys(authz).sort(), [
    'AUTHZ_DECISIONS', 'AUTHZ_MODES', 'AUTHZ_REASON_CODES', 'decideAuthorization',
  ])
  assert.equal(typeof decideAuthorization, 'function')
  assert.deepStrictEqual(authz.AUTHZ_DECISIONS, ['allow', 'deny', 'needs-human'])
  assert.deepStrictEqual(authz.AUTHZ_MODES, ['off', 'explicit', 'observe', 'auto'])
  assert.deepStrictEqual(authz.AUTHZ_REASON_CODES, [
    'policy_malformed', 'mode_off', 'mode_null', 'mode_reserved', 'mode_invalid', 'mode_unknown',
    'policy_shape', 'policy_catalog_invalid', 'policy_allow_invalid', 'policy_allow_uncataloged',
    'request_malformed', 'request_extra_field', 'request_missing_field', 'request_field_invalid',
    'action_unknown', 'target_unknown', 'pair_not_allowed', 'pair_allowed',
  ])
  for (const list of [authz.AUTHZ_DECISIONS, authz.AUTHZ_MODES, authz.AUTHZ_REASON_CODES]) {
    assert.ok(Object.isFrozen(list))
  }
})
