import assert from 'node:assert/strict'
import test from 'node:test'
import { ROSTER_CAP, cleanRosterBots, rosterFrame } from '../../src/roster/report.js'

test('valid clusterBotId survives; unknown fields do not', () => {
  const [bot] = cleanRosterBots([{ id: 'b1', name: 'N', role: 'r', clusterBotId: 'cb-1.alpha_2', secret: 'x' }])
  assert.equal(bot.clusterBotId, 'cb-1.alpha_2')
  assert.equal('secret' in bot, false)
  assert.deepEqual(Object.keys(bot).sort(), ['clusterBotId', 'id', 'name', 'role'])
})

test('empty, malformed and missing clusterBotId are omitted, the bot is kept', () => {
  const out = cleanRosterBots([
    { id: 'a', name: 'A', role: 'r', clusterBotId: '' },
    { id: 'b', name: 'B', role: 'r', clusterBotId: 'has space' },
    { id: 'c', name: 'C', role: 'r' },
    { id: 'd', name: 'D', role: 'r', clusterBotId: '-leading' },
    { id: 'e', name: 'E', role: 'r', clusterBotId: 'x'.repeat(65) },
    { id: 'f', name: 'F', role: 'r', clusterBotId: 42 },
  ])
  assert.equal(out.length, 6)
  for (const entry of out) assert.equal('clusterBotId' in entry, false, entry.id)
})

test('64-char clusterBotId is the longest accepted', () => {
  const id = 'a' + 'b'.repeat(63)
  assert.equal(cleanRosterBots([{ id: 'z', clusterBotId: id }])[0].clusterBotId, id)
})

test('the 65th bot is dropped', () => {
  assert.equal(ROSTER_CAP, 64)
  const bots = Array.from({ length: 65 }, (_, i) => ({ id: `b${i}`, name: 'n', role: 'r', clusterBotId: `cb${i}` }))
  const out = cleanRosterBots(bots)
  assert.equal(out.length, 64)
  assert.equal(out.at(-1).id, 'b63')
})

test('rosterFrame passes the field through without a second copy step', () => {
  const frame = rosterFrame({ nodeId: 'n1', hostname: 'h', bots: [{ id: 'b', clusterBotId: 'cb-9', secret: 's' }] })
  assert.deepEqual(frame.bots, [{ id: 'b', name: '', role: '', clusterBotId: 'cb-9' }])
})
