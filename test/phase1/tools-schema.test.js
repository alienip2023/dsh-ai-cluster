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

test('cluster_selfcheck: required', () => {
  const p = defs.get('cluster_selfcheck').parameters
  assert.deepEqual(p.required, [])
  assert.equal(p.additionalProperties, false)
})

test('cluster_agents: required', () => {
  const p = defs.get('cluster_agents').parameters
  assert.deepEqual(p.required, [])
  assert.equal(p.additionalProperties, false)
})

test('cluster_nodes: required', () => {
  const p = defs.get('cluster_nodes').parameters
  assert.deepEqual(p.required, [])
  assert.equal(p.additionalProperties, false)
})

test('cluster_task: required', () => {
  const p = defs.get('cluster_task').parameters
  assert.deepEqual(p.required, ['goal'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_task_batch: required', () => {
  const p = defs.get('cluster_task_batch').parameters
  assert.deepEqual(p.required, ['tasks'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_status: required', () => {
  const p = defs.get('cluster_status').parameters
  assert.deepEqual(p.required, ['taskId'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_handoff: required', () => {
  const p = defs.get('cluster_handoff').parameters
  assert.deepEqual(p.required, ['taskId'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_manifest: required', () => {
  const p = defs.get('cluster_manifest').parameters
  assert.deepEqual(p.required, ['taskId'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_pull: required', () => {
  const p = defs.get('cluster_pull').parameters
  assert.deepEqual(p.required, ['taskId', 'paths'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_purge: required', () => {
  const p = defs.get('cluster_purge').parameters
  assert.deepEqual(p.required, [])
  assert.equal(p.additionalProperties, false)
})

test('cluster_cancel: required', () => {
  const p = defs.get('cluster_cancel').parameters
  assert.deepEqual(p.required, ['taskId'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_interrupt: required', () => {
  const p = defs.get('cluster_interrupt').parameters
  assert.deepEqual(p.required, ['taskId'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_ls: required', () => {
  const p = defs.get('cluster_ls').parameters
  assert.deepEqual(p.required, ['path'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_read: required', () => {
  const p = defs.get('cluster_read').parameters
  assert.deepEqual(p.required, ['path'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_grep: required', () => {
  const p = defs.get('cluster_grep').parameters
  assert.deepEqual(p.required, ['path', 'pattern'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_tree: required', () => {
  const p = defs.get('cluster_tree').parameters
  assert.deepEqual(p.required, ['path'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_write: required', () => {
  const p = defs.get('cluster_write').parameters
  assert.deepEqual(p.required, ['path', 'confirm', 'content'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_mkdir: required', () => {
  const p = defs.get('cluster_mkdir').parameters
  assert.deepEqual(p.required, ['path', 'confirm'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_move: required', () => {
  const p = defs.get('cluster_move').parameters
  assert.deepEqual(p.required, ['from', 'to', 'confirm'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_delete: required', () => {
  const p = defs.get('cluster_delete').parameters
  assert.deepEqual(p.required, ['path', 'confirm'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_ps: required', () => {
  const p = defs.get('cluster_ps').parameters
  assert.deepEqual(p.required, undefined)
  assert.equal(p.additionalProperties, false)
})

test('cluster_port: required', () => {
  const p = defs.get('cluster_port').parameters
  assert.deepEqual(p.required, ['port'])
  assert.equal(p.additionalProperties, false)
})

test('cluster_kill: required', () => {
  const p = defs.get('cluster_kill').parameters
  assert.deepEqual(p.required, ['pid', 'confirm'])
  assert.equal(p.additionalProperties, false)
})

