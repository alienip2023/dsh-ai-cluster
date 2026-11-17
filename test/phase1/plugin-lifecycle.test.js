import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/plugin/index.js'
import { makeCtx } from './_plugin-ctx.js'

test('apply registers the role under ai-cluster:role; dispose removes it; second dispose is a no-op', (t) => {
  const ctx = makeCtx()
  t.after(() => ctx.cleanup())
  const h = apply(ctx, { role: '', stateDir: ctx.stateDir })
  assert.equal(ctx.services.has('ai-cluster:role'), true)
  assert.equal(ctx.services.has('remote-agent:role'), false)
  h.dispose()
  assert.equal(ctx.services.has('ai-cluster:role'), false)
  assert.doesNotThrow(() => h.dispose())
})

test('apply twice without dispose leaves exactly one generation', (t) => {
  const ctx = makeCtx()
  t.after(() => ctx.cleanup())
  const first = apply(ctx, { role: '', stateDir: ctx.stateDir })
  const second = apply(ctx, { role: '', stateDir: ctx.stateDir })
  assert.equal([...ctx.services.keys()].filter((k) => k === 'ai-cluster:role').length, 1)
  assert.equal(ctx.services.size, 1)
  // stale dispose of the first generation must not remove the second's service
  first.dispose()
  assert.equal(ctx.services.has('ai-cluster:role'), true)
  second.dispose()
  assert.equal(ctx.services.size, 0)
})
