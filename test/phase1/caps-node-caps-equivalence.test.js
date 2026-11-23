import test from 'node:test'
import assert from 'node:assert/strict'
import * as oldP from '../../lib/protocol.js'
import * as newP from '../../src/caps/node-caps.js'

for (const platform of ['win32', 'darwin', 'linux', undefined]) {
  for (const base of [[], ['fs', 'exec', 'artifact', 'agent']]) {
    test(`nodeCaps equal: platform=${platform} base=${base.length}`, () => {
      assert.deepEqual(newP.nodeCaps(base, platform), oldP.nodeCaps(base, platform))
    })
  }
}
test('cap constants equal', () => {
  assert.equal(newP.MEMORY_CAPS, oldP.MEMORY_CAPS)
  assert.equal(newP.BOT_MEMORY_UPDATE_CAP, oldP.BOT_MEMORY_UPDATE_CAP)
  assert.equal(newP.BOT_PROFILE_UPDATE_CAP, oldP.BOT_PROFILE_UPDATE_CAP)
  for (const name of ['BOT_TURN_MODE_CAP', 'BOT_ACTION_CAP', 'ROSTER_CARDS_CAP', 'BOT_TRACE_CAP', 'BOT_ATTACH_CAP']) assert.equal(newP[name], oldP[name], name)
  assert.deepEqual([...newP.HUB_CAPS], [...oldP.HUB_CAPS])
  assert.ok(Object.isFrozen(newP.HUB_CAPS))
})
