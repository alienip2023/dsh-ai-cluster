import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { applyHub } from '../../lib/hub/index.js'
import { applyWorker } from '../../lib/node/index.js'
import { exposeRole } from '../../src/caps/role.js'
import { dualProvide } from '../../src/compat/dual-provide.js'
import { PROVIDED_SERVICE_SUFFIXES } from '../../src/compat/ra-names.js'
import { makeCtx } from './_plugin-ctx.js'

const owned = {
  hub: ['registry', 'tasks', 'bot-network', 'config-sync', 'role', 'bot-identity'],
  worker: ['jobs', 'bot-network', 'memory-link', 'node-policy', 'role'],
  both: PROVIDED_SERVICE_SUFFIXES,
}

function fixture(t, { setOnly = false, failingAlias } = {}) {
  const ctx = makeCtx()
  const events = new EventEmitter()
  const disposers = []
  const warnings = []
  const provide = ctx.provide
  ctx.provide = (name, value) => {
    if (name === failingAlias) throw new Error(`cannot publish ${name}`)
    const dispose = provide(name, value)
    disposers.push(dispose)
    return dispose
  }
  if (setOnly) delete ctx.provide
  ctx.set = (name, value) => {
    if (!setOnly) assert.ok(ctx.services.has(name), `set before provide: ${name}`)
    if (value === undefined) ctx.services.delete(name)
    else ctx.services.set(name, value)
  }
  ctx.on = (name, listener) => {
    events.on(name, listener)
    const dispose = () => events.off(name, listener)
    disposers.push(dispose)
    return dispose
  }
  ctx.logger.warn = (...args) => warnings.push(args)
  ctx.webServer = { register: () => () => {}, registerUpgrade: () => () => {} }
  ctx.tools = { register: () => () => {} }
  ctx.systemPrompt = { section: () => () => {} }
  const dispose = () => {
    for (const release of disposers.splice(0).reverse()) release()
  }
  t.after(() => {
    dispose()
    ctx.cleanup()
  })
  const assemble = (role) => {
    const config = {
      stateDir: ctx.stateDir, roots: [ctx.stateDir], nodeId: 'dual-provide-test',
      listenPort: 0, hubUrl: '', relayUrl: '', audit: false,
      discovery: { enabled: false }, peerDirect: false, connectivityProbe: false,
      resourceIntervalMs: 0, reposIntervalMs: 0,
    }
    disposers.push(exposeRole(ctx, role))
    if (role === 'hub' || role === 'both') {
      const hub = applyHub(ctx, config)
      disposers.push(() => hub.disposeAll())
    }
    if (role === 'worker' || role === 'both') disposers.push(applyWorker(ctx, config))
  }
  return { ctx, warnings, assemble, dispose }
}

function assertAliases(ctx, suffixes) {
  for (const suffix of suffixes) {
    const legacy = ctx.get(`remote-agent:${suffix}`)
    assert.notEqual(legacy, undefined, `missing ${suffix}`)
    assert.equal(ctx.get(`ai-cluster:${suffix}`), legacy, `alias mismatch: ${suffix}`)
  }
}

for (const role of ['hub', 'worker', 'both']) {
  test(`${role} assembly publishes its owned services under both names`, (t) => {
    const { ctx, assemble, dispose } = fixture(t)
    assemble(role)
    assertAliases(ctx, owned[role])
    dispose()
    for (const suffix of owned[role]) {
      assert.equal(ctx.get(`ai-cluster:${suffix}`), undefined, suffix)
      assert.equal(ctx.get(`remote-agent:${suffix}`), undefined, suffix)
    }
  })

  test(`${role} assembly supports a context with set and no provide`, (t) => {
    const { ctx, assemble } = fixture(t, { setOnly: true })
    assert.doesNotThrow(() => assemble(role))
    assertAliases(ctx, owned[role])
  })
}

for (const [role, suffixes] of [
  ['hub', ['bot-network', 'tasks', 'config-sync']],
  ['worker', ['jobs', 'bot-network', 'memory-link', 'node-policy']],
]) {
  for (const suffix of suffixes) {
    test(`${role} keeps legacy ${suffix} and warns if its alias cannot be published`, (t) => {
      const failingAlias = `ai-cluster:${suffix}`
      const { ctx, warnings, assemble, dispose } = fixture(t, { failingAlias })
      assert.doesNotThrow(() => assemble(role))
      assert.notEqual(ctx.get(`remote-agent:${suffix}`), undefined)
      assert.equal(ctx.get(failingAlias), undefined)
      assert.ok(warnings.some(args => JSON.stringify(args).includes(`cannot publish ${failingAlias}`)))
      assertAliases(ctx, owned[role].filter(name => name !== suffix))
      dispose()
      assert.equal(ctx.get(`remote-agent:${suffix}`), undefined)
    })
  }
}

for (const suffix of PROVIDED_SERVICE_SUFFIXES) {
  test(`${suffix} publication shares a disposer for both names`, (t) => {
    const { ctx } = fixture(t)
    const value = { suffix }
    const dispose = dualProvide(ctx, suffix, value)
    assertAliases(ctx, [suffix])
    assert.equal(dualProvide(ctx, suffix, value), dispose)
    dispose()
    assert.equal(ctx.get(`ai-cluster:${suffix}`), undefined)
    assert.equal(ctx.get(`remote-agent:${suffix}`), undefined)
    assert.doesNotThrow(dispose)
  })
}
