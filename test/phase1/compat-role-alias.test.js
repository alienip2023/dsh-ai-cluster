import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveServiceName } from '../../src/compat/ra-names.js'
import { apply } from '../../src/plugin/index.js'
import { makeCtx } from './_plugin-ctx.js'

test('compat: old role name resolves to the new name', () => {
  assert.equal(resolveServiceName('remote-agent:role'), 'ai-cluster:role')
})

test('compat: any remote-agent:<x> maps to ai-cluster:<x>; others pass through; never throws', () => {
  assert.equal(resolveServiceName('remote-agent:jobs'), 'ai-cluster:jobs')
  assert.equal(resolveServiceName('ai-cluster:role'), 'ai-cluster:role')
  assert.equal(resolveServiceName('other:role'), 'other:role')
  assert.doesNotThrow(() => resolveServiceName(undefined))
})

test('compat: the old name, resolved, is found through ctx.inject', (t) => {
  const ctx = makeCtx()
  const h = apply(ctx, { role: '', stateDir: ctx.stateDir })
  t.after(() => { h.dispose(); ctx.cleanup() })
  const resolved = ctx.inject(resolveServiceName('remote-agent:role'))
  assert.equal(resolved, 'worker')
  assert.equal(ctx.inject('ai-cluster:role'), resolved)
})
