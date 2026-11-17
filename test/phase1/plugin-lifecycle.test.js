import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/plugin/index.js'
import { makeCtx } from './_plugin-ctx.js'

test('apply registers both role names with the same object; dispose removes both; second dispose is a no-op', (t) => {
  const ctx = makeCtx()
  t.after(() => ctx.cleanup())
  const h = apply(ctx, { role: '', stateDir: ctx.stateDir })
  assert.equal(ctx.services.has('ai-cluster:role'), true)
  assert.equal(ctx.services.has('remote-agent:role'), true)
  assert.equal(ctx.services.get('ai-cluster:role'), ctx.services.get('remote-agent:role'))
  h.dispose()
  assert.equal(ctx.services.has('ai-cluster:role'), false)
  assert.equal(ctx.services.has('remote-agent:role'), false)
  assert.doesNotThrow(() => h.dispose())
})

test('apply twice without dispose leaves exactly one generation per role name', (t) => {
  const ctx = makeCtx()
  t.after(() => ctx.cleanup())
  const first = apply(ctx, { role: '', stateDir: ctx.stateDir })
  const second = apply(ctx, { role: '', stateDir: ctx.stateDir })
  assert.equal([...ctx.services.keys()].filter((k) => k === 'ai-cluster:role').length, 1)
  assert.equal([...ctx.services.keys()].filter((k) => k === 'remote-agent:role').length, 1)
  assert.equal(ctx.services.size, 2)
  const currentRole = ctx.services.get('ai-cluster:role')
  assert.equal(currentRole, ctx.services.get('remote-agent:role'))
  // stale dispose of the first generation must not remove the second's service
  first.dispose()
  assert.equal(ctx.services.size, 2)
  assert.equal(ctx.services.get('ai-cluster:role'), currentRole)
  assert.equal(ctx.services.get('remote-agent:role'), currentRole)
  second.dispose()
  assert.equal(ctx.services.size, 0)
})
