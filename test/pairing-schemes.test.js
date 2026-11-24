// The panel writes cluster1:// (lib/plugin/trust/pairing.js); the node reads with lib/pairing.js.
// Before 0.4.34 the node only took dshra1://, so every code the panel showed was refused.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePairCode, encodePairCode, expandPairConfig } from '../lib/pairing.js'
import { encodePairCode as panelEncode } from '../lib/plugin/trust/pairing.js'

test('a node decodes the code the hub panel shows (cluster1://)', () => {
  const code = panelEncode({ hubUrl: 'wss://hub.example:8124/api/remote-agent/node', token: 'tok-1' })
  assert.match(code, /^cluster1:\/\//)
  const decoded = decodePairCode(code)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.payload.token, 'tok-1')
  const { config, error } = expandPairConfig({ pair: code })
  assert.equal(error, '')
  assert.equal(config.hubUrl, 'wss://hub.example:8124/api/remote-agent/node')
})

test('dshra1:// still works; anything else names both prefixes', () => {
  assert.equal(decodePairCode(encodePairCode({ hubUrl: 'wss://h:1/x', token: 't' })).ok, true)
  assert.match(decodePairCode('foo://abc').error, /dshra1:\/\/ 或 cluster1:\/\//)
})
