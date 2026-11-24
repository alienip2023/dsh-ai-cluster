// The panel writes cluster1:// (lib/plugin/trust/pairing.js); the node reads with lib/pairing.js.
// Before 0.4.34 the node only took dshra1://, so every code the panel showed was refused.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePairCode, encodePairCode, encodeDshBot1Code, expandPairConfig } from '../lib/pairing.js'
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

test('dshra1:// still works; anything else names all three prefixes', () => {
  assert.equal(decodePairCode(encodePairCode({ hubUrl: 'wss://h:1/x', token: 't' })).ok, true)
  assert.match(decodePairCode('foo://abc').error, /dshra1:\/\/ 或 cluster1:\/\//)
})

test('dshbot1:// is decoded and returns hubUrl + token (code)', () => {
  const code = encodeDshBot1Code({
    endpoints: ['wss://192.168.1.5:8124/api/remote-agent/node'],
    code: 'AB12CD34',
    hubKeyFp: 'hubfp1-aaaaaaaaaaaaaaaaaaaaaa',
  })
  assert.match(code, /^dshbot1:\/\//)
  const result = decodePairCode(code)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.payload.hubUrl, 'wss://192.168.1.5:8124/api/remote-agent/node')
  assert.ok(typeof result.payload.token === 'string' && result.payload.token.length >= 8)
  assert.equal(result.payload.hubFingerprint, 'hubfp1-aaaaaaaaaaaaaaaaaaaaaa')
})

test('dshbot1:// with multiple endpoints provides first endpoint as hubUrl', () => {
  const code = encodeDshBot1Code({
    endpoints: ['wss://192.168.1.5:8124/api/remote-agent/node', 'wss://10.0.0.5:8124/api/remote-agent/node'],
    code: 'EF56GH78',
  })
  const result = decodePairCode(code)
  assert.equal(result.ok, true)
  assert.equal(result.payload.hubUrl, 'wss://192.168.1.5:8124/api/remote-agent/node')
  assert.deepEqual(result.payload.endpoints, [
    'wss://192.168.1.5:8124/api/remote-agent/node',
    'wss://10.0.0.5:8124/api/remote-agent/node',
  ])
})

test('encodeDshBot1Code returns empty for missing endpoints or invalid code', () => {
  assert.equal(encodeDshBot1Code({ endpoints: [], code: 'AB12CD34' }), '')
  assert.equal(encodeDshBot1Code({ endpoints: ['wss://h:1/x'], code: 'short' }), '')
  assert.equal(encodeDshBot1Code({ endpoints: ['wss://h:1/x'], code: '' }), '')
})
