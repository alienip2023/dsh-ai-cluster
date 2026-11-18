import assert from 'node:assert/strict'
import test from 'node:test'
import * as runtime from '../../lib/protocol.js'
import * as wire from '../../src/wire/frames.js'

test('peer protocol vocabulary matches the runtime at version 1', () => {
  assert.equal(wire.PROTOCOL_VERSION, 1)
  assert.equal(wire.PROTOCOL_VERSION, runtime.PROTOCOL_VERSION)
  assert.deepEqual(wire.PEER, runtime.PEER)
  assert.deepEqual(wire.PEER_BOT_TYPES, runtime.PEER_BOT_TYPES)
})

const wsPeer = 'ws://10.0.0.42:19388/api/remote-agent/peer'
const wssPeer = 'wss://example.com/api/remote-agent/peer'
const cases = [
  ['canonical ws', wsPeer, wsPeer],
  ['canonical wss', wssPeer, wssPeer],
  ['obsolete ai-cluster path', 'ws://10.0.0.42:19388/api/ai-cluster/peer', ''],
  ['HTTP', 'http://10.0.0.42:19388/api/remote-agent/peer', ''],
  ['credentials', 'ws://user:pw@10.0.0.42:19388/api/remote-agent/peer', ''],
  ['query', `${wsPeer}?x=1`, ''],
  ['fragment', `${wsPeer}#f`, ''],
  ['overlong URL', 'ws://' + 'a'.repeat(2049), ''],
  ['null', null, ''],
  ['undefined', undefined, ''],
  ['number', 42, ''],
]

for (const [label, raw, expected] of cases) {
  test(`normalizePeerUrl parity: ${label}`, () => {
    const runtimeResult = runtime.normalizePeerUrl(raw)
    assert.equal(runtimeResult, expected, 'runtime URL contract')
    assert.equal(wire.normalizePeerUrl(raw), runtimeResult, 'wire must match runtime')
  })
}
