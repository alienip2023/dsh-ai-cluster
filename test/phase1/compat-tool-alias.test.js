import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveToolName } from '../../src/compat/ra-names.js'

const PAIRS = [
  ['remote_nodes', 'cluster_nodes'],
  ['remote_agents', 'cluster_agents'],
  ['remote_task', 'cluster_task'],
  ['remote_task_batch', 'cluster_task_batch'],
  ['remote_status', 'cluster_status'],
  ['remote_handoff', 'cluster_handoff'],
  ['remote_manifest', 'cluster_manifest'],
  ['remote_pull', 'cluster_pull'],
  ['remote_cancel', 'cluster_cancel'],
  ['remote_interrupt', 'cluster_interrupt'],
  ['remote_purge', 'cluster_purge'],
  ['remote_selfcheck', 'cluster_selfcheck'],
  ['remote_ls', 'cluster_ls'],
  ['remote_read', 'cluster_read'],
  ['remote_grep', 'cluster_grep'],
  ['remote_tree', 'cluster_tree'],
  ['remote_write', 'cluster_write'],
  ['remote_mkdir', 'cluster_mkdir'],
  ['remote_move', 'cluster_move'],
  ['remote_delete', 'cluster_delete'],
  ['remote_ps', 'cluster_ps'],
  ['remote_port', 'cluster_port'],
  ['remote_kill', 'cluster_kill'],
]

test('the alias table has 23 entries', () => {
  assert.equal(PAIRS.length, 23)
})

for (const [oldName, newName] of PAIRS) {
  test(`resolveToolName(${oldName}) -> ${newName}`, () => {
    assert.equal(resolveToolName(oldName), newName)
  })
}

test('resolveToolName passes remote_file through unchanged', () => {
  assert.equal(resolveToolName('remote_file'), 'remote_file')
})
