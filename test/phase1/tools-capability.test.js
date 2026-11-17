import test from 'node:test'
import assert from 'node:assert/strict'
import { registerClusterTools } from '../../src/tools/index.js'
import { makeAcl, ACL_READ_ONLY } from '../../src/caps/index.js'

// "只持有 read 的会话" = defaults 为 ACL_READ_ONLY 的 ACL。
function setup(acl) {
  const defs = new Map()
  const calls = []
  const registry = {
    pickNode: (id) => ({ nodeId: id, online: true }),
    onlineNodes: () => [{ nodeId: 'n1' }],
    pickAutoNode: () => 'n1',
    fsRequest: async (...a) => { calls.push(a); return { ok: true } },
  }
  registerClusterTools({
    ctx: { tools: { register(def) { defs.set(def.name, def); return () => {} } } },
    registry, pulls: {}, defaults: {}, acl,
  })
  return { defs, calls }
}

test('cluster_write：只有 read 的会话被拒，且什么都没写', async () => {
  const { defs, calls } = setup(makeAcl(ACL_READ_ONLY))
  let err
  try { await defs.get('cluster_write').execute({ node: 'n1', path: '/w/a.txt', content: 'x', confirm: 'yes' }) } catch (e) { err = e }
  assert.ok(err, 'must throw')
  assert.equal(err.code, 'ACL_DENIED')
  assert.equal(calls.length, 0)
})

test('cluster_write：持有 write 时放行', async () => {
  const { defs, calls } = setup(makeAcl())
  await defs.get('cluster_write').execute({ node: 'n1', path: '/w/a.txt', content: 'x', confirm: 'yes' })
  assert.equal(calls.length, 1)
})

for (const name of ['cluster_mkdir', 'cluster_delete']) {
  test(`${name}：read-only 被拒`, async () => {
    const { defs, calls } = setup(makeAcl(ACL_READ_ONLY))
    await assert.rejects(defs.get(name).execute({ node: 'n1', path: '/w/a', confirm: 'yes' }), (e) => e.code === 'ACL_DENIED')
    assert.equal(calls.length, 0)
  })
}

test('cluster_move：read-only 被拒', async () => {
  const { defs, calls } = setup(makeAcl(ACL_READ_ONLY))
  await assert.rejects(defs.get('cluster_move').execute({ node: 'n1', from: '/w/a', to: '/w/b', confirm: 'yes' }), (e) => e.code === 'ACL_DENIED')
  assert.equal(calls.length, 0)
})

test('cluster_ls：read-only 仍可读', async () => {
  const { defs, calls } = setup(makeAcl(ACL_READ_ONLY))
  await defs.get('cluster_ls').execute({ node: 'n1', path: '/w' })
  assert.equal(calls.length, 1)
})

test('cluster_kill：默认无 shell 能力，被拒', async () => {
  const { defs, calls } = setup(makeAcl())
  await assert.rejects(defs.get('cluster_kill').execute({ node: 'n1', pid: 4242, confirm: 'yes' }), (e) => e.code === 'ACL_DENIED')
  assert.equal(calls.length, 0)
})

test('未提供 acl：与旧行为一致（不拦截）', async () => {
  const { defs, calls } = setup(null)
  await defs.get('cluster_write').execute({ node: 'n1', path: '/w/a.txt', content: 'x', confirm: 'yes' })
  assert.equal(calls.length, 1)
})
