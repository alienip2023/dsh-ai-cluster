import test from 'node:test'
import assert from 'node:assert/strict'
import { registerClusterTools } from '../../src/tools/index.js'

function collect() {
  const defs = new Map()
  const disposers = registerClusterTools({
    ctx: { tools: { register(def) { defs.set(def.name, def); return () => defs.delete(def.name) } } },
    registry: {}, pulls: {}, defaults: {},
  })
  return { defs, disposers }
}

const { defs } = collect()
const clusterNames = [...defs.keys()].filter((n) => n.startsWith('cluster_'))

test('tool registered: cluster_selfcheck', () => {
  assert.ok(defs.has('cluster_selfcheck'))
})

test('tool registered: cluster_agents', () => {
  assert.ok(defs.has('cluster_agents'))
})

test('tool registered: cluster_nodes', () => {
  assert.ok(defs.has('cluster_nodes'))
})

test('tool registered: cluster_task', () => {
  assert.ok(defs.has('cluster_task'))
})

test('tool registered: cluster_task_batch', () => {
  assert.ok(defs.has('cluster_task_batch'))
})

test('tool registered: cluster_status', () => {
  assert.ok(defs.has('cluster_status'))
})

test('tool registered: cluster_handoff', () => {
  assert.ok(defs.has('cluster_handoff'))
})

test('tool registered: cluster_manifest', () => {
  assert.ok(defs.has('cluster_manifest'))
})

test('tool registered: cluster_pull', () => {
  assert.ok(defs.has('cluster_pull'))
})

test('tool registered: cluster_purge', () => {
  assert.ok(defs.has('cluster_purge'))
})

test('tool registered: cluster_cancel', () => {
  assert.ok(defs.has('cluster_cancel'))
})

test('tool registered: cluster_interrupt', () => {
  assert.ok(defs.has('cluster_interrupt'))
})

test('tool registered: cluster_ls', () => {
  assert.ok(defs.has('cluster_ls'))
})

test('tool registered: cluster_read', () => {
  assert.ok(defs.has('cluster_read'))
})

test('tool registered: cluster_grep', () => {
  assert.ok(defs.has('cluster_grep'))
})

test('tool registered: cluster_tree', () => {
  assert.ok(defs.has('cluster_tree'))
})

test('tool registered: cluster_write', () => {
  assert.ok(defs.has('cluster_write'))
})

test('tool registered: cluster_mkdir', () => {
  assert.ok(defs.has('cluster_mkdir'))
})

test('tool registered: cluster_move', () => {
  assert.ok(defs.has('cluster_move'))
})

test('tool registered: cluster_delete', () => {
  assert.ok(defs.has('cluster_delete'))
})

test('tool registered: cluster_ps', () => {
  assert.ok(defs.has('cluster_ps'))
})

test('tool registered: cluster_port', () => {
  assert.ok(defs.has('cluster_port'))
})

test('tool registered: cluster_kill', () => {
  assert.ok(defs.has('cluster_kill'))
})

test('exactly 23 cluster_* tools, none extra', () => {
  assert.equal(clusterNames.length, 23)
})

test('every remote_* tool is an alias of the same cluster_* tool', () => {
  const remoteNames = [...defs.keys()].filter((n) => n.startsWith('remote_'))
  assert.equal(remoteNames.length, 23)
  for (const remote of remoteNames) {
    const canonical = 'cluster_' + remote.slice('remote_'.length)
    const a = defs.get(canonical)
    const b = defs.get(remote)
    assert.ok(a, `${canonical} must exist for ${remote}`)
    assert.equal(b.execute, a.execute, `${remote} must reuse ${canonical}'s handler`)
    assert.deepEqual(b.parameters, a.parameters, `${remote} must keep ${canonical}'s schema`)
  }
})

test('the non-cluster_ names are the 23 aliases plus node_jobs', () => {
  const remoteNames = [...defs.keys()].filter((n) => n.startsWith('remote_'))
  assert.deepEqual(
    [...defs.keys()].filter((n) => !n.startsWith('cluster_')).sort(),
    [...remoteNames, 'node_jobs'].sort(),
  )
  // A Map cannot hold duplicate keys; single registration is covered by test/phase1/tool-alias-register.test.js.
  assert.equal(defs.has('node_jobs'), true)
})
