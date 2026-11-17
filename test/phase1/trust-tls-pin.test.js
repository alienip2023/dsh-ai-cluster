import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  checkPeerPin, fingerprintOfCert, generateCert, loadPeerPins, normalizeTlsFingerprint, removePeerPin, savePeerPin,
} from '../../src/trust/tls.js'

const FP_A = 'a'.repeat(64)
const FP_B = 'b'.repeat(64)
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trust-tls-'))

test('未变指纹可重连：checkPeerPin → { ok: true }', async () => {
  const dir = tmp()
  await savePeerPin(dir, { nodeId: 'lab-02', fingerprint: FP_A, endpoint: 'wss://10.0.0.2:8124/x' })
  const { pins } = loadPeerPins(dir)
  assert.deepEqual(checkPeerPin({ pins, nodeId: 'lab-02', fingerprint: FP_A }), { ok: true })
  // 冒号 / 大写写法等价
  assert.deepEqual(checkPeerPin({ pins, nodeId: 'lab-02', fingerprint: FP_A.toUpperCase().match(/../g).join(':') }), { ok: true })
})

test('指纹变了被拒，且 pin 不被更新', async () => {
  const dir = tmp()
  await savePeerPin(dir, { nodeId: 'lab-02', fingerprint: FP_A })
  const before = fs.readFileSync(path.join(dir, 'peer-pins.json'), 'utf8')
  const table = loadPeerPins(dir)
  const r = checkPeerPin({ pins: table.pins, nodeId: 'lab-02', fingerprint: FP_B })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_PIN_MISMATCH')
  assert.equal(r.expected, FP_A)
  assert.equal(r.actual, FP_B)
  assert.equal(loadPeerPins(dir).pins['lab-02'].fingerprint, FP_A)
  assert.equal(fs.readFileSync(path.join(dir, 'peer-pins.json'), 'utf8'), before)
  assert.equal(table.pins['lab-02'].fingerprint, FP_A, 'checkPeerPin 不改传入的表')
})

test('没有 pin 的 nodeId 一律失败（无 TOFU）', async () => {
  const dir = tmp()
  const empty = loadPeerPins(dir)
  assert.deepEqual(empty, { version: 1, pins: {} })
  assert.equal(fs.existsSync(path.join(dir, 'peer-pins.json')), false, '读缺失文件不写盘')
  assert.deepEqual(checkPeerPin({ pins: empty.pins, nodeId: 'ghost', fingerprint: FP_A }), { ok: false, code: 'E_PIN_ABSENT' })
  assert.deepEqual(checkPeerPin({ pins: empty, nodeId: 'ghost', fingerprint: FP_A }), { ok: false, code: 'E_PIN_ABSENT' })
  await savePeerPin(dir, { nodeId: 'other', fingerprint: FP_A })
  assert.equal(checkPeerPin({ pins: loadPeerPins(dir).pins, nodeId: 'ghost', fingerprint: FP_A }).code, 'E_PIN_ABSENT')
  assert.equal(checkPeerPin({ pins: loadPeerPins(dir).pins, nodeId: '__proto__', fingerprint: FP_A }).ok, false)
  assert.equal(checkPeerPin({}).ok, false)
})

test('endpoint 变化不是信任事件；removePeerPin 是唯一解除路径', async () => {
  const dir = tmp()
  await savePeerPin(dir, { nodeId: 'n1', fingerprint: FP_A, endpoint: 'wss://1.1.1.1:8124' })
  await savePeerPin(dir, { nodeId: 'n1', fingerprint: FP_A, endpoint: 'wss://2.2.2.2:8124' })
  assert.equal(checkPeerPin({ pins: loadPeerPins(dir).pins, nodeId: 'n1', fingerprint: FP_A }).ok, true)
  assert.equal(await removePeerPin(dir, 'n1'), true)
  assert.equal(checkPeerPin({ pins: loadPeerPins(dir).pins, nodeId: 'n1', fingerprint: FP_A }).code, 'E_PIN_ABSENT')
  assert.equal(await removePeerPin(dir, 'n1'), false)
})

test('pin 文件 0600；损坏文件改名保留、返回空表、不 TOFU', async () => {
  const dir = tmp()
  await savePeerPin(dir, { nodeId: 'n1', fingerprint: FP_A })
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'peer-pins.json')).mode & 0o777, 0o600)
  fs.writeFileSync(path.join(dir, 'peer-pins.json'), '{not json')
  const t = loadPeerPins(dir)
  assert.deepEqual(t, { version: 1, pins: {} })
  const names = fs.readdirSync(dir)
  assert.ok(names.some((n) => n.startsWith('peer-pins.json.corrupt-')), '损坏文件被保留')
  assert.equal(names.includes('peer-pins.json'), false)
  assert.equal(checkPeerPin({ pins: t.pins, nodeId: 'n1', fingerprint: FP_A }).code, 'E_PIN_ABSENT')
})

test('并发 savePeerPin 不丢条目', async () => {
  const dir = tmp()
  await Promise.all(['a1', 'a2', 'a3', 'a4'].map((id) => savePeerPin(dir, { nodeId: id, fingerprint: FP_A })))
  assert.deepEqual(Object.keys(loadPeerPins(dir).pins).sort(), ['a1', 'a2', 'a3', 'a4'])
})

test('normalizeTlsFingerprint：64 hex（可带冒号）→ 裸小写；其余抛 E_BAD_FINGERPRINT', () => {
  assert.equal(normalizeTlsFingerprint('AB'.repeat(32)), 'ab'.repeat(32))
  assert.equal(normalizeTlsFingerprint('ab:'.repeat(31) + 'ab'), 'ab'.repeat(32))
  for (const bad of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), null, undefined, 5, 'hubfp1-AAAAAAAAAAAAAAAAAAAAAA']) {
    assert.throws(() => normalizeTlsFingerprint(bad), { code: 'E_BAD_FINGERPRINT' })
  }
})

test('generateCert：可解析、指纹 64 hex、0600、不覆盖、force 才替换', async () => {
  const dir = tmp()
  const a = await generateCert({ stateDir: dir })
  const x = new X509Certificate(fs.readFileSync(a.certFile))
  assert.match(a.fingerprint256, /^[0-9a-f]{64}$/)
  assert.equal(a.fingerprint256, fingerprintOfCert(fs.readFileSync(a.certFile, 'utf8')))
  assert.equal(a.fingerprint256, x.fingerprint256.replaceAll(':', '').toLowerCase())
  assert.equal(x.ca, false)
  assert.ok(x.verify(x.publicKey), '自签名验证通过')
  assert.ok(a.certFile.startsWith(path.join(dir, 'tls')))
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(a.keyFile).mode & 0o777, 0o600)
    assert.equal(fs.statSync(a.certFile).mode & 0o777, 0o600)
  }
  const again = await generateCert({ stateDir: dir })
  assert.equal(again.fingerprint256, a.fingerprint256, '无 force 不覆盖')
  const forced = await generateCert({ stateDir: dir, force: true })
  assert.notEqual(forced.fingerprint256, a.fingerprint256)
})

test('generateCert：只剩一个文件且无 force → 不覆盖；写失败 → E_TLS_GENERATE 且旧证书不变', async () => {
  const dir = tmp()
  const a = await generateCert({ stateDir: dir })
  fs.rmSync(a.keyFile)
  await assert.rejects(generateCert({ stateDir: dir }), { code: 'E_TLS_MISSING' })
  assert.ok(fs.existsSync(a.certFile))

  const dir2 = tmp()
  const b = await generateCert({ stateDir: dir2 })
  const certBefore = fs.readFileSync(b.certFile)
  const keyBefore = fs.readFileSync(b.keyFile)
  // 让 cert.pem 的写入失败：把 cert.pem 路径换成非空目录，rename 无法覆盖
  fs.rmSync(b.certFile)
  fs.mkdirSync(b.certFile)
  fs.writeFileSync(path.join(b.certFile, 'x'), '1')
  await assert.rejects(generateCert({ stateDir: dir2, force: true }), { code: 'E_TLS_GENERATE' })
  assert.deepEqual(fs.readFileSync(b.keyFile), keyBefore, '旧 key 保持原样')
  assert.ok(certBefore.length > 0)
})

test('fingerprintOfCert：坏 PEM 抛 E_TLS_INVALID', () => {
  for (const bad of ['', 'nonsense', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', null]) {
    assert.throws(() => fingerprintOfCert(bad), { code: 'E_TLS_INVALID' })
  }
})

test('tls.js 不带监听/拨号', () => {
  const src = fs.readFileSync(new URL('../../src/trust/tls.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /node:(net|tls|https?)'/)
  assert.doesNotMatch(src, /\.listen\(|\.connect\(/)
})
