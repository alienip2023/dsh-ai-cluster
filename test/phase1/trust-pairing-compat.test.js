import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PAIR_SCHEME, decodePairCode, encodePairCode } from '../../src/trust/pairing.js'
import { decodeLegacyPairCode } from '../../src/trust/pairing-compat.js'

const LEGACY = 'dshra1://'
const FP = 'hubfp1-AAAAAAAAAAAAAAAAAAAAAA'
const input = { hubUrl: 'ws://192.168.1.10:19387/api/remote-agent/node', token: 'nt_abc', nodeId: 'slave-pc', hubFingerprint: FP }

test('新编码器只产 cluster1://', () => {
  assert.equal(PAIR_SCHEME, 'cluster1://')
  assert.ok(encodePairCode(input).startsWith('cluster1://'))
})

test('dshra1:// 码经 decodeLegacyPairCode 得到与 cluster1:// 形式相同的载荷', () => {
  const fresh = encodePairCode(input)
  const legacy = LEGACY + fresh.slice(PAIR_SCHEME.length)
  const viaNew = decodePairCode(fresh)
  const viaCompat = decodeLegacyPairCode(legacy)
  assert.equal(viaNew.ok, true)
  assert.equal(viaCompat.ok, true)
  assert.deepEqual(viaCompat.payload, viaNew.payload)
  assert.equal(viaCompat.payload.hubFingerprint, FP)
})

test('compat 层保持与新解码器相同的校验（坏载荷同样被拒）', () => {
  const bad = LEGACY + Buffer.from('{"v":2,"hubUrl":"ws://h"}', 'utf8').toString('base64url')
  assert.equal(decodeLegacyPairCode(bad).ok, false)
  assert.match(decodeLegacyPairCode(bad).error, /版本不受支持/)
})

test('decodePairCode 拒绝 dshra1://（与旧解码器对未知前缀的错误相同）', () => {
  const legacy = LEGACY + encodePairCode(input).slice(PAIR_SCHEME.length)
  const r = decodePairCode(legacy)
  assert.equal(r.ok, false)
  assert.match(r.error, /不是配对码/)
  assert.deepEqual(r, decodePairCode('http://example/x'.replace('http://', 'foo://')))
})

test('decodeLegacyPairCode 拒绝 cluster1:// 与其它前缀', () => {
  assert.equal(decodeLegacyPairCode(encodePairCode(input)).ok, false)
  assert.equal(decodeLegacyPairCode('foo://abc').ok, false)
  assert.equal(decodeLegacyPairCode('').ok, false)
  assert.equal(decodeLegacyPairCode(undefined).ok, false)
})
