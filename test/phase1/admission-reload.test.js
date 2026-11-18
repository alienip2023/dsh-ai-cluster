import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPlugin, Config } from '../../src/plugin/index.js'
import { ADMISSION_REJECTED, createAdmission } from '../../src/admission/index.js'
import {
  config, createTicketStore, deferred, fakeHost, fakeRegistry, goal, ledgerHarness, modules, OUTSIDE, SCOPED,
} from '../../src/admission/test-fakes.js'

const m = await modules()
const tool = 'cluster_task'
const denied = { taskId: '', node: '', accepted: false, denied: true, hint: ADMISSION_REJECTED }

function fakePlugin(t, h) {
  const host = fakeHost()
  const controllers = []
  const frames = []
  const handles = []
  host.ctx.logger = { info() {}, warn() {} }
  const reload = () => {
    const plugin = applyPlugin(host.ctx, { role: 'hub', admission: config() }, (cfg, deps) => {
      const admission = createAdmission(cfg, {
        ...h.deps, audit(event, fields) { deps.audit(event, fields) },
      })
      controllers.push(admission)
      return admission
    }, (ctx, _config, { registerUiRoutes }) => {
      const generation = fakeRegistry(m, { audit: h.audit, calls: h.calls })
      frames.push(generation.frames)
      registerUiRoutes({ ctx, registry: generation.registry, log() {} })
      return { registry: generation.registry }
    })
    handles.push(plugin)
    return { plugin, ready: controllers.at(-1).ready }
  }
  t.after(() => handles.forEach(h => h.dispose()))
  return { reload, frames, run: (node = SCOPED) => host.tool(tool, { node, goal }) }
}

test('AC-2 criterion 10: same-host reapplies wait for late close, then admit', async t => {
  const closing = deferred()
  t.after(() => closing.resolve())
  let first = true
  const h = ledgerHarness({ close(store) {
    if (!first) return store.close()
    first = false
    return closing.promise.then(() => store.close())
  } })
  const host = fakePlugin(t, h)
  const firstGen = host.reload()
  await firstGen.ready
  const secondGen = host.reload()
  assert.equal(firstGen.plugin.dispose(), undefined)
  assert.deepEqual(h.calls, ['open', 'close'])
  assert.deepEqual(await host.run(), denied)
  assert.equal(h.audit.at(-1).reason, 'TICKET_LOCKED')
  assert.equal(h.rows().length, 0)
  assert.equal(host.frames[1].length, 0)
  assert.equal((await host.run(OUTSIDE)).accepted, true)
  assert.equal(h.trace.filter(s => s.startsWith('lock:')).length, 1)
  closing.resolve()
  await secondGen.ready
  assert.deepEqual(h.trace.filter(s => s.startsWith('lock:')), ['lock:acquired', 'lock:released', 'lock:acquired'])
  assert.equal((await host.run()).accepted, true)
  assert.deepEqual(h.audit.filter(r => r.event === 'admission.reject').map(r => r.reason), ['TICKET_LOCKED'])
  assert.equal(h.calls.filter(s => s === 'open').length, 2)
  assert.equal(h.calls.filter(s => s === 'close').length, 1)
  assert.equal(h.retries.length, 0)
  assert.equal(h.rows().length, 1)
  assert.equal(host.frames[1].length, 2)
})

test('AC-2 criterion 10: injected lock retries recover or stop at the bound', async t => {
  for (const exhausted of [false, true]) {
    const h = ledgerHarness()
    const external = createTicketStore({ dir: config().ledgerDir, fsOps: h.fsOps })
    const wait = h.deps.wait
    const unblock = deferred()
    h.deps.wait = async ms => {
      await wait(ms)
      if (!exhausted && h.retries.length === 2) { await external.close(); unblock.resolve() }
    }
    const host = fakePlugin(t, h)
    const generation = host.reload()
    await generation.ready
    assert.deepEqual(h.retries, [10, 25])
    assert.equal(h.calls.filter(s => s === 'open').length, 3)
    if (exhausted) {
      assert.deepEqual(await host.run(), denied)
      assert.equal(h.audit.at(-1).reason, 'TICKET_LOCKED')
      assert.equal(h.logs.at(-1).reason, 'TICKET_LOCKED')
      assert.equal(h.rows().length, 0)
      assert.equal(host.frames[0].length, 0)
      assert.equal((await host.run(OUTSIDE)).accepted, true)
      assert.equal(h.trace.filter(s => s === 'lock:acquired').length, 1)
      assert.equal(h.trace.filter(s => s === 'lock:busy').length, 3)
      await external.close()
    } else {
      await unblock.promise
      assert.equal((await host.run()).accepted, true)
      assert.equal(h.audit.some(r => r.event === 'admission.reject'), false)
      assert.equal(h.rows().length, 1)
      assert.deepEqual(h.trace.filter(s => s.startsWith('lock:')), [
        'lock:acquired', 'lock:busy', 'lock:busy', 'lock:released', 'lock:acquired',
      ])
    }
    generation.plugin.dispose()
  }
})

test('AC-2 criterion 10: default resolver control denies for identity on healthy store', async t => {
  const h = ledgerHarness({ deps: { resolver: undefined } })
  const host = fakePlugin(t, h)
  assert.equal(Config({}).admission.enabled, false)
  await host.reload().ready
  assert.deepEqual(await host.run(), denied)
  assert.deepEqual(h.audit.map(r => r.reason), ['identity_unbound'])
  assert.deepEqual(h.calls, ['open'])
  assert.equal(h.retries.length, 0)
  assert.equal(h.rows().length, 0)
  assert.equal(host.frames[0].length, 0)
})

test('AC-2 criterion 10: async close rejection is logged, with synchronous idempotent disposal', async t => {
  const h = ledgerHarness({ async close(store) {
    await store.close()
    throw new Error('fake close failure')
  } })
  const host = fakePlugin(t, h)
  const first = host.reload()
  await first.ready
  assert.equal(first.plugin.dispose(), undefined)
  assert.equal(first.plugin.dispose(), undefined)
  await host.reload().ready
  assert.equal(h.logs.filter(r => r.reason === 'TICKET_STORE_FAILED').length, 1)
  assert.deepEqual(h.calls, ['open', 'close', 'open'])
  assert.equal((await host.run()).accepted, true)
  assert.equal(h.audit.some(r => r.event === 'admission.reject'), false)
})
