import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { makeCore, makeReact, textOf } from './_fake.js'
import { createData, dataAttachLink, dataCounts, dataMergeNodes, dataSavedRole } from '../../src/panel/data.js'
import { shellRolePlan, shellScreenId, shellTabKey, shellTabs } from '../../src/panel/shell.js'
import { coreVersionAtLeast } from '../../src/panel/core.js'
import { buildClient } from '../../scripts/build-client.mjs'

test('built client is in step with the sources and registers both slots', () => {
  assert.equal(fs.readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8'), buildClient())
  const src = buildClient()
  let plugin = null
  vm.runInNewContext(src, { console, window: { __ModuleLoader__: { load(m) { plugin = m.factory(() => makeReact()) } } } })
  const slots = []
  plugin.apply({ slots: { inject(name, fn) { slots.push(name); fn() }, register(meta) { slots.push(meta.id || meta.key); return () => {} } } })
  assert.deepEqual(slots.filter((s) => /sidebar|main/.test(s)), ['sidebar.panellist', 'main'])
  assert.ok(slots.includes('dsh-ai-cluster'))
})

test('shell: tabs, keys and role plan', () => {
  assert.deepEqual(shellTabs('team', { nodes: 3, online: 2, active: 1 }).map((t) => [t.id, t.selected, t.count]),
    [['overview', false, null], ['machines', false, '2/3'], ['team', true, null], ['tasks', false, 1]])
  assert.equal(shellScreenId('nope'), 'overview')
  assert.equal(shellTabKey('tasks', 'ArrowRight'), 'overview')
  assert.equal(shellTabKey('overview', 'ArrowLeft'), 'tasks')
  assert.equal(shellTabKey('overview', 'x'), null)
  assert.deepEqual(shellRolePlan('both'), { hub: true, worker: true, both: true, view: 'hub' })
  assert.deepEqual(shellRolePlan('worker'), { hub: false, worker: true, both: false, view: 'worker' })
  assert.equal(shellRolePlan('').view, 'none')
})

test('data: role, merge, counts, link', () => {
  assert.equal(dataSavedRole(null), '')
  assert.equal(dataSavedRole({ configured: false }), '')
  assert.equal(dataSavedRole({ effectiveRole: 'Worker' }), 'worker')
  assert.equal(dataSavedRole({ configured: true }), 'hub')
  const ov = dataMergeNodes({ nodes: [{ nodeId: 'a', secret: 1 }, { nodeId: 'b' }] },
    { nodes: [{ nodeId: 'a', resource: { cpuPct: 3 }, queue: { queued: 1 }, extra: 'drop' }] })
  assert.deepEqual(ov.nodes[0], { nodeId: 'a', secret: 1, resource: { cpuPct: 3 }, queue: { queued: 1 } })
  assert.deepEqual(ov.nodes[1], { nodeId: 'b' })
  const c = dataCounts([{ status: 'running' }, { status: 'completed' }, { status: 'rejected' }], { nodes: [{ online: true }, { online: false }] })
  assert.deepEqual(c, { nodes: 2, online: 1, tasks: 3, running: 1, active: 1, done: 1, failed: 1 })
  const n = dataAttachLink([{ nodeId: 'a' }, { nodeId: 'b' }], { nodes: [{ nodeId: 'a', pending: 2, oldestMs: 9, maxTries: 1, types: { 'work/x': 2 } }] })
  assert.equal(n[0].link.pending, 2)
  assert.equal('link' in n[1], false)
})

test('core: version compare treats unknown as unknown, not old', () => {
  assert.equal(coreVersionAtLeast('0.4.36', '0.4.34'), true)
  assert.equal(coreVersionAtLeast('0.4.33', '0.4.34'), false)
  assert.equal(coreVersionAtLeast('0.10.0', '0.4.34'), true)
  assert.equal(coreVersionAtLeast(undefined, '0.4.34'), null)
})

test('core primitives render text and keep status glyph classes', () => {
  const core = makeCore()
  assert.match(textOf(core.h(core.Badge, { tone: 'ok' }, '在线')), /在线/)
  assert.match(textOf(core.h(core.Card, { title: 'T', sub: 'S' }, 'body')), /TSbody/)
  assert.equal(typeof createData(core).useHub, 'function')
})
