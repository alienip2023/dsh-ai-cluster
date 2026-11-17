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

test('no remote_* name is registered any more', () => {
  assert.deepEqual([...defs.keys()].filter((n) => n.startsWith('remote_')), [])
})

// 偏差记录：旧 registerRemoteTools 实际注册 24 个，多出的 node_jobs 不在简报的 23 个里。
// 它原样保留（job-frame.test.js 依赖），这里钉住"唯一的非 cluster_ 工具"。
test('node_jobs is the only non-cluster_ tool (kept unchanged)', () => {
  assert.deepEqual([...defs.keys()].filter((n) => !n.startsWith('cluster_')), ['node_jobs'])
})
