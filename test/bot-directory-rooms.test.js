import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { validateBotDirectory } from '../lib/protocol.js'
import { createBotNetwork } from '../lib/node/bot-network.js'
import { createHubBotNetwork } from '../lib/hub/bot-network.js'

const room = { id: 'r1', name: '二开收口', members: 3 }
const bot = { id: 'b1', name: 'Bot', nodeId: 'node-a', role: '' }

test('1 validateBotDirectory keeps valid rooms and accepts optional fields', () => {
  const rooms = [room, { id: 'r2' }, { id: 'r3', name: '' }, { id: 'r4', members: 0 },
    { id: 'r'.repeat(200), name: 'n'.repeat(80), members: 1 }]
  const input = { bots: [bot], rooms: [{ ...room, name: `  ${room.name}  ` }, ...rooms.slice(1)], at: 1 }
  const checked = validateBotDirectory(input)
  assert.deepEqual(checked, { bots: [bot], rooms, at: 1 })
  assert.notEqual(checked.rooms, input.rooms)
  assert.notEqual(checked.rooms[0], input.rooms[0])
})

test('2 validateBotDirectory caps rooms at the first 100 entries', () => {
  const rooms = Array.from({ length: 105 }, (_, i) => ({ ...room, id: `r${i}` }))
  assert.deepEqual(validateBotDirectory({ bots: [], rooms }).rooms, rooms.slice(0, 100))
  assert.equal(validateBotDirectory({ bots: [], rooms: [null, ...rooms] }).rooms.length, 99)
})

test('3 validateBotDirectory drops rooms with invalid id, name or members', () => {
  const invalid = [null, [], {}, { name: room.name, members: 3 },
    { ...room, id: '' }, { ...room, id: '   ' }, { ...room, id: 1 }, { ...room, id: 'r'.repeat(201) },
    { ...room, name: null }, { ...room, name: 1 }, { ...room, name: [] },
    { ...room, members: -1 }, { ...room, members: '3' }, { ...room, members: 0.5 },
    { ...room, members: Infinity }, { ...room, members: NaN }, { ...room, members: null }]
  assert.deepEqual(validateBotDirectory({ bots: [], rooms: [...invalid, room] }).rooms, [room])
})

test('4 validateBotDirectory drops unknown fields', () => {
  const checked = validateBotDirectory({ bots: [{ ...bot, extra: true }],
    rooms: [{ ...room, extra: true }], at: 1, extra: true })
  assert.deepEqual(checked, { bots: [bot], rooms: [room], at: 1 })
})

test('5 receiveDirectory caches rooms and exposes isolated copies', t => {
  const network = createBotNetwork({ nodeId: 'node-a' })
  t.after(() => network.dispose())
  assert.deepEqual(network.rooms(), [])
  const input = { bots: [{ ...bot }], rooms: [{ ...room }] }
  network.receiveDirectory(input)
  assert.deepEqual(network.rooms(), [room])
  assert.deepEqual(network.directory(), [bot])
  input.rooms[0].name = 'changed'
  const snapshot = network.rooms()
  snapshot[0].members = 99
  snapshot.pop()
  assert.deepEqual(network.rooms(), [room])
  for (const frame of [null, [], {}, { bots: 'invalid', rooms: [] }]) {
    assert.doesNotThrow(() => network.receiveDirectory(frame))
    assert.deepEqual(network.rooms(), [room])
    assert.deepEqual(network.directory(), [bot])
  }
  network.receiveDirectory({ bots: [bot] })
  assert.deepEqual(network.rooms(), [])
})

test('6 directory events carry isolated bots and rooms snapshots', t => {
  const network = createBotNetwork({ nodeId: 'node-a' })
  t.after(() => network.dispose())
  let events = 0
  network.on('directory', value => {
    events++
    assert.deepEqual(value, { bots: [bot], rooms: [room], machines: [] })
    value.bots[0].name = 'changed'
    value.rooms[0].name = 'changed'
    value.rooms.pop()
  })
  network.receiveDirectory({ bots: [bot], rooms: [room] })
  assert.equal(events, 1)
  assert.deepEqual(network.directory(), [bot])
  assert.deepEqual(network.rooms(), [room])
})

test('7 disposal clears both rooms and bots and ignores later directories', () => {
  const network = createBotNetwork({ nodeId: 'node-a' })
  network.receiveDirectory({ bots: [bot], rooms: [room] })
  assert.deepEqual(network.rooms(), [room])
  network.dispose()
  assert.deepEqual(network.rooms(), [])
  assert.deepEqual(network.directory(), [])
  network.receiveDirectory({ bots: [bot], rooms: [room] })
  assert.deepEqual(network.rooms(), [])
  assert.deepEqual(network.directory(), [])
})

test('8 hub sendDirectory forwards rooms and defaults them to an empty array', t => {
  const registry = new EventEmitter()
  const sent = []
  registry.send = (nodeId, type, data) => { sent.push({ nodeId, type, data }); return true }
  const hub = createHubBotNetwork({ registry })
  t.after(() => hub.dispose())
  assert.equal(hub.sendDirectory('node-a', [bot], [{ ...room, extra: true }, {}]), true)
  assert.deepEqual(sent[0], { nodeId: 'node-a', type: 'bot/directory',
    data: { bots: [bot], rooms: [room], at: sent[0].data.at } })
  assert.equal(Number.isFinite(sent[0].data.at), true)
  assert.equal(hub.sendDirectory('node-a', [bot]), true)
  assert.deepEqual(sent[1].data.rooms, [])
})

test('9 validateBotDirectory defaults missing or invalid rooms to an empty array', () => {
  assert.deepEqual(validateBotDirectory({ bots: [], at: 1 }), { bots: [], rooms: [], at: 1 })
  for (const rooms of [undefined, null, {}, 'rooms', 3, false]) {
    assert.deepEqual(validateBotDirectory({ bots: [], rooms, at: 1 }), { bots: [], rooms: [], at: 1 })
  }
})

test('10 validateBotDirectory trims and truncates oversized room names to 80 characters', () => {
  assert.deepEqual(validateBotDirectory({ bots: [], rooms: [
    { ...room, name: `  ${'n'.repeat(81)}  ` }, { id: 'r2', name: '   ', members: 0 },
  ] }).rooms, [{ ...room, name: 'n'.repeat(80) }, { id: 'r2', name: '', members: 0 }])
})
