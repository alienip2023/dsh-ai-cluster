import assert from 'node:assert/strict'
import test from 'node:test'
// Runtime module: the one lib/hub/registry-ingest.js imports (not the src/roster copy).
import { cleanRosterBots } from '../../lib/roster-report.js'

test('runtime cleanRosterBots: legal clusterBotId survives, illegal is dropped, absent is unchanged', () => {
  const out = cleanRosterBots([
    { id: 'legal', name: 'L', role: 'r', clusterBotId: 'cb-1.alpha_2' },
    { id: 'illegal', name: 'I', role: 'r', clusterBotId: 'has space' },
    { id: 'plain', name: 'P', role: 'r' },
  ])
  assert.equal(out.length, 3)
  assert.equal(out[0].clusterBotId, 'cb-1.alpha_2')
  assert.equal('clusterBotId' in out[1], false)
  assert.deepEqual(out[1], { id: 'illegal', name: 'I', role: 'r' })
  assert.deepEqual(out[2], { id: 'plain', name: 'P', role: 'r' })
})
