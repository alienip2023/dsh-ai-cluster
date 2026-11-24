import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dualProvide } from '../../src/compat/dual-provide.js'
import { PROVIDED_SERVICE_SUFFIXES, SERVICE_ALIASES } from '../../src/compat/ra-names.js'
import { exposeRole } from '../../src/caps/role.js'
import { exposeRegistry } from '../../lib/hub/expose-registry.js'
import { makeCtx } from './_plugin-ctx.js'

test('role exposes both names and disposes both', (t) => {
  const ctx = makeCtx()
  t.after(() => ctx.cleanup())
  const dispose = exposeRole(ctx, 'hub')
  t.after(dispose)
  assert.equal(ctx.get('ai-cluster:role'), 'hub')
  assert.equal(ctx.get('remote-agent:role'), ctx.get('ai-cluster:role'))
  dispose()
  assert.equal(ctx.get('ai-cluster:role'), undefined)
  assert.equal(ctx.get('remote-agent:role'), undefined)
})

test('registry exposes the same object under both names and can be exposed again', (t) => {
  const ctx = makeCtx()
  t.after(() => ctx.cleanup())
  const registry = { nodes: new Map() }
  const dispose = exposeRegistry(ctx, registry)
  t.after(dispose)
  assert.ok(ctx.get('remote-agent:registry'), 'remote-agent:registry missing')
  assert.equal(ctx.get('remote-agent:registry'), ctx.get('ai-cluster:registry'))
  assert.equal(ctx.get('ai-cluster:registry'), registry)

  let repeatedDispose
  assert.doesNotThrow(() => { repeatedDispose = exposeRegistry(ctx, registry) })
  assert.equal(repeatedDispose, dispose)
  assert.equal(ctx.services.size, 2)
  assert.equal(ctx.get('remote-agent:registry'), registry)
  assert.equal(ctx.get('ai-cluster:registry'), registry)
  repeatedDispose()
  assert.equal(ctx.get('remote-agent:registry'), undefined)
  assert.equal(ctx.get('ai-cluster:registry'), undefined)
  assert.doesNotThrow(dispose)

  let nextDispose
  assert.doesNotThrow(() => { nextDispose = exposeRegistry(ctx, registry) })
  t.after(nextDispose)
  dispose()
  assert.equal(ctx.get('remote-agent:registry'), registry)
  assert.equal(ctx.get('ai-cluster:registry'), registry)
  nextDispose()
  assert.equal(ctx.services.size, 0)
})

test('owned service table is read-only and contains nine aliases', () => {
  assert.ok(Object.isFrozen(PROVIDED_SERVICE_SUFFIXES))
  assert.ok(Object.isFrozen(SERVICE_ALIASES))
  assert.equal(PROVIDED_SERVICE_SUFFIXES.length, 9)
  assert.equal(Object.keys(SERVICE_ALIASES).length, 9)
})

for (const suffix of PROVIDED_SERVICE_SUFFIXES) {
  test(`dualProvide: ${suffix} shares one object and removes both names`, (t) => {
    const ctx = makeCtx()
    t.after(() => ctx.cleanup())
    const legacyName = `remote-agent:${suffix}`
    const name = SERVICE_ALIASES[legacyName]
    const service = { suffix }
    const dispose = dualProvide(ctx, suffix, service)
    t.after(dispose)
    assert.equal(name, `ai-cluster:${suffix}`)
    assert.equal(ctx.get(legacyName), service)
    assert.equal(ctx.get(name), service)
    assert.equal(ctx.get(legacyName), ctx.get(name))
    assert.equal(dualProvide(ctx, suffix, service), dispose)
    assert.equal(ctx.services.size, 2)
    dispose()
    assert.equal(ctx.get(legacyName), undefined)
    assert.equal(ctx.get(name), undefined)
  })
}

test('updates use set only after the name has been provided', (t) => {
  const ctx = makeCtx()
  t.after(() => ctx.cleanup())
  const updates = []
  const get = ctx.get
  ctx.get = (name, required) => {
    assert.equal(required, false)
    return get(name)
  }
  ctx.set = (name, value) => {
    assert.ok(ctx.services.has(name), 'set called before provide')
    updates.push(name)
    ctx.services.set(name, value)
  }
  const first = { version: 1 }
  const dispose = dualProvide(ctx, 'tasks', first)
  t.after(dispose)
  assert.deepEqual(updates, [])
  const second = { version: 2 }
  assert.equal(dualProvide(ctx, 'tasks', second), dispose)
  assert.deepEqual(updates, ['ai-cluster:tasks', 'remote-agent:tasks'])
  assert.equal(ctx.get('remote-agent:tasks', false), second)
  assert.equal(ctx.get('ai-cluster:tasks', false), second)
  dispose()
  assert.equal(ctx.services.size, 0)
})

test('a failed second publication releases the first name', (t) => {
  const ctx = makeCtx()
  t.after(() => ctx.cleanup())
  const provide = ctx.provide
  ctx.provide = (name, value) => {
    if (name === 'remote-agent:registry') throw new Error('publication failed')
    return provide(name, value)
  }
  assert.throws(() => exposeRegistry(ctx, {}), /publication failed/)
  assert.equal(ctx.services.size, 0)
})

test('production files do not name ds-bot receivers and the helper rejects them', (t) => {
  const ctx = makeCtx()
  t.after(() => ctx.cleanup())
  const receiverSuffixes = [
    'bot-message', 'bot-page', 'bot-create', 'bot-update', 'bot-delete', 'bot-turn', 'bot-stop',
  ]
  for (const file of [
    'src/compat/ra-names.js', 'src/compat/dual-provide.js', 'src/caps/role.js',
    'lib/expose-role.js', 'lib/hub/expose-registry.js',
  ]) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    for (const suffix of receiverSuffixes) {
      assert.ok(!source.includes(`remote-agent:${suffix}`), `${file} names a ds-bot receiver`)
    }
  }
  for (const suffix of receiverSuffixes) {
    assert.throws(() => dualProvide(ctx, suffix, {}), /unsupported owned service/)
  }
  assert.equal(ctx.services.size, 0)
})
