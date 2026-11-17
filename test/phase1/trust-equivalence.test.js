import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import * as oldId from '../../lib/identity.js'
import * as newId from '../../src/trust/identity.js'
import * as oldPin from '../../lib/node/hub-pin.js'
import * as newPin from '../../src/trust/hub-pin.js'
import * as oldE2e from '../../lib/e2e.js'
import * as newE2e from '../../src/trust/e2e.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trust-eq-'))
const flip = (b64) => {
  const buf = Buffer.from(b64, 'base64url')
  buf[0] ^= 1
  return buf.toString('base64url')
}

test('identity：导出名一致；指纹往返相同；hubfp1- 前缀 + 22 字符', () => {
  assert.deepEqual(Object.keys(newId).sort(), Object.keys(oldId).sort())
  assert.equal(newId.FINGERPRINT_PREFIX, 'hubfp1-')
  assert.equal(newId.IDENTITY_CONTEXT, oldId.IDENTITY_CONTEXT)
  const id = oldId.generateIdentity()
  const der = Buffer.from(id.publicKeyB64, 'base64url')
  assert.equal(newId.fingerprintOf(der), id.fingerprint)
  assert.equal(id.fingerprint.length, 'hubfp1-'.length + 22)
  assert.equal(newId.normalizeFingerprint(id.fingerprint), id.fingerprint)
  assert.equal(oldId.normalizeFingerprint(id.fingerprint), id.fingerprint)
  for (const bad of [id.fingerprint + 'x', id.fingerprint.slice(0, -1), 'hubfp2-' + id.fingerprint.slice(7), '', null]) {
    assert.equal(newId.normalizeFingerprint(bad), oldId.normalizeFingerprint(bad))
    assert.equal(newId.normalizeFingerprint(bad), '')
  }
})

test('identity：旧签名新验签接受；改一字节旧、新验签都拒绝', () => {
  const id = oldId.generateIdentity()
  const fields = { fingerprint: id.fingerprint, nodeId: 'n1', nonce: oldId.newNonce(), at: 1763380800000 }
  assert.equal(newId.identitySignPayload(fields), oldId.identitySignPayload(fields))
  const sig = oldId.signIdentity(id.privateKeyB64, fields)
  assert.equal(newId.signIdentity(id.privateKeyB64, fields), sig, 'ed25519 确定性：新旧签名逐字节相同')
  assert.equal(newId.verifyIdentity(id.publicKeyB64, fields, sig), true)
  assert.equal(oldId.verifyIdentity(id.publicKeyB64, fields, flip(sig)), false)
  assert.equal(newId.verifyIdentity(id.publicKeyB64, fields, flip(sig)), false)
})

test('identity：loadOrCreateHubIdentity 新旧读同一文件得到同一指纹', () => {
  const file = path.join(tmp(), oldId.IDENTITY_FILE_NAME)
  const a = oldId.loadOrCreateHubIdentity(file)
  const b = newId.loadOrCreateHubIdentity(file)
  assert.equal(a.created, true)
  assert.equal(b.created, false)
  assert.equal(b.fingerprint, a.fingerprint)
  assert.deepEqual(newId.readHubIdentity(file)?.fingerprint, oldId.readHubIdentity(file)?.fingerprint)
})

test('hub-pin：新旧输出一致；缺失 / 损坏 = null 且不抛；非法指纹不落盘', () => {
  assert.deepEqual(Object.keys(newPin).sort(), Object.keys(oldPin).sort())
  const dir = tmp()
  assert.equal(newPin.loadHubPin(dir), null)
  assert.equal(oldPin.loadHubPin(dir), null)
  const fp = oldId.generateIdentity().fingerprint
  assert.equal(newPin.saveHubPin(dir, { fingerprint: fp, endpoint: 'ws://h' }), true)
  assert.deepEqual(newPin.loadHubPin(dir), oldPin.loadHubPin(dir))
  assert.equal(newPin.loadHubPin(dir).fingerprint, fp)
  fs.writeFileSync(path.join(dir, 'hub-pin.json'), '{garbage')
  assert.equal(newPin.loadHubPin(dir), null)
  assert.equal(oldPin.loadHubPin(dir), null)
  assert.equal(newPin.saveHubPin(dir, { fingerprint: 'nope' }), false)
  newPin.clearHubPin(dir)
  assert.equal(fs.existsSync(path.join(dir, 'hub-pin.json')), false)
})

test('e2e：导出名/常量一致；同输入派生同密钥；旧签名新验签接受，改一字节拒绝', () => {
  assert.deepEqual(Object.keys(newE2e).sort(), Object.keys(oldE2e).sort())
  assert.equal(newE2e.E2E_CONTEXT, oldE2e.E2E_CONTEXT)
  assert.equal(newE2e.E2E_MARKER, oldE2e.E2E_MARKER)
  const node = oldE2e.generateEphemeral()
  const hub = oldE2e.generateEphemeral()
  const base = { nodePubB64: node.publicKeyB64, hubPubB64: hub.publicKeyB64 }
  const k1 = oldE2e.deriveSessionKey({ role: 'node', ownPrivB64: node.privateKeyB64, peerPubB64: hub.publicKeyB64, ...base })
  const k2 = newE2e.deriveSessionKey({ role: 'node', ownPrivB64: node.privateKeyB64, peerPubB64: hub.publicKeyB64, ...base })
  assert.deepEqual(k2.key, k1.key)
  assert.deepEqual(k2.dir, k1.dir)

  const id = oldId.generateIdentity()
  const fields = {
    fingerprint: id.fingerprint, nodeId: 'n1', nonce: 'abc', nodePub: node.publicKeyB64, hubPub: hub.publicKeyB64, at: 1,
  }
  const sig = oldE2e.signExchange(id.privateKeyB64, fields)
  assert.equal(newE2e.exchangeSignPayload(fields), oldE2e.exchangeSignPayload(fields))
  assert.equal(newE2e.verifyExchange(id.publicKeyB64, fields, sig), true)
  assert.equal(oldE2e.verifyExchange(id.publicKeyB64, fields, flip(sig)), false)
  assert.equal(newE2e.verifyExchange(id.publicKeyB64, fields, flip(sig)), false)
})
