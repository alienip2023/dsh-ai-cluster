/**
 * trust/tls：自签证书 + 指纹归一化 + 对端 pin 表（STAGE2-DESIGN §1）。
 *
 * 只有证书、指纹、pin 表。不监听、不拨号（属于 link 切片）。
 * 零新依赖：X.509 DER 由本文件用 node:crypto 手写（ECDSA P-256 + SHA-256）。
 *
 * 与 hub-pin 的刻意区别：这里**没有任何接受"缺失 pin"的分支**。
 * 首次信任必须由调用方在用户确认后自己调 savePeerPin；endpoint 变化不是信任事件。
 * 错误码是普通 Error.code，不是帧 ERROR_CODE。
 */
import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWrite } from '../store/atomic.js'

export const PEER_PINS_FILE_NAME = 'peer-pins.json'
export const PEER_PINS_VERSION = 1
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX64_COLON = /^[0-9a-f]{2}(:[0-9a-f]{2}){31}$/

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra)
}

/* ───────────────────────── 最小 DER 写入器 ───────────────────────── */

function derLen(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body])
}
const seq = (...p) => tlv(0x30, ...p)
const set = (...p) => tlv(0x31, ...p)
const oid = (dotted) => {
  const n = dotted.split('.').map(Number)
  const out = [n[0] * 40 + n[1]]
  for (const v of n.slice(2)) {
    const chunk = [v & 0x7f]
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80)
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}
const derInt = (buf) => {
  let b = Buffer.from(buf)
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1)
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return tlv(0x02, b)
}
const utcTime = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, 'ascii'))
}
const extension = (oidStr, critical, value) =>
  seq(oid(oidStr), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value))

function buildSelfSignedCert({ privateKey, publicKey, commonName, sans, days, now }) {
  const sigAlg = seq(oid('1.2.840.10045.4.3.2'))
  const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))))
  const notAfter = new Date(now.getTime() + days * 86400000)
  const sanItems = sans.map((s) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
    return m ? tlv(0x87, Buffer.from(m.slice(1).map(Number))) : tlv(0x82, Buffer.from(s, 'ascii'))
  })
  const exts = tlv(
    0xa3,
    seq(
      extension('2.5.29.19', true, seq()), // CA:FALSE
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))), // digitalSignature
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'), oid('1.3.6.1.5.5.7.3.2'))),
      extension('2.5.29.17', false, seq(...sanItems)),
    ),
  )
  const tbs = seq(
    tlv(0xa0, derInt(Buffer.from([2]))),
    derInt(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    sigAlg,
    name,
    seq(utcTime(new Date(now.getTime() - 60000)), utcTime(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    exts,
  )
  const sig = edSign('sha256', tbs, privateKey) // ECDSA → DER
  return seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])))
}

function toPem(der, label) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`
}

/* ───────────────────────── 证书 / 指纹 ───────────────────────── */

/** SHA-256 of the leaf certificate (DER) → 64 lowercase hex. */
export function fingerprintOfCert(pem) {
  try {
    const x = new X509Certificate(typeof pem === 'string' || Buffer.isBuffer(pem) ? pem : '')
    return createHash('sha256').update(x.raw).digest('hex')
  } catch (err) {
    throw codedError('E_TLS_INVALID', `TLS 证书无法解析：${err.message}`, { cause: err })
  }
}

/** 64 hex（可带冒号，大小写不限）→ 裸小写；否则抛 E_BAD_FINGERPRINT。 */
export function normalizeTlsFingerprint(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (HEX64.test(s)) return s
  if (HEX64_COLON.test(s)) return s.replaceAll(':', '')
  throw codedError('E_BAD_FINGERPRINT', 'TLS 指纹必须是 64 位十六进制（可带冒号）')
}

export function tlsPaths(stateDir) {
  const dir = path.join(stateDir, 'tls')
  return { dir, certFile: path.join(dir, 'cert.pem'), keyFile: path.join(dir, 'key.pem') }
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * 生成自签证书。已存在且 force 不为真 → 原样返回，绝不覆盖。
 * 只剩一个文件且无 force → E_TLS_MISSING（不覆盖留下的那个）。
 * 写失败 → E_TLS_GENERATE，且恢复旧 key，旧证书保持原样。
 */
export async function generateCert({ stateDir, force = false } = {}) {
  if (typeof stateDir !== 'string' || stateDir === '') {
    throw codedError('E_TLS_GENERATE', 'generateCert 需要 stateDir')
  }
  const { certFile, keyFile } = tlsPaths(stateDir)
  let oldCert
  let oldKey
  try {
    oldCert = readIfExists(certFile)
    oldKey = readIfExists(keyFile)
  } catch (err) {
    throw codedError('E_TLS_GENERATE', `读取现有证书失败：${err.message}`, { cause: err })
  }
  if (!force) {
    if (oldCert && oldKey) return { certFile, keyFile, fingerprint256: fingerprintOfCert(oldCert) }
    if (oldCert || oldKey) {
      throw codedError('E_TLS_MISSING', 'cert.pem / key.pem 只剩一个，拒绝覆盖（用 force 重新生成）', { certFile, keyFile })
    }
  }
  let certPem
  let keyPem
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const sans = [...new Set(['localhost', '127.0.0.1', os.hostname()].filter((s) => /^[A-Za-z0-9.-]+$/.test(s)))]
    const der = buildSelfSignedCert({ privateKey, publicKey, commonName: 'ai-cluster-node', sans, days: 825, now: new Date() })
    certPem = toPem(der, 'CERTIFICATE')
    keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    new X509Certificate(certPem) // 自检：解析不了就别落盘
  } catch (err) {
    throw codedError('E_TLS_GENERATE', `证书生成失败：${err.message}`, { cause: err })
  }
  try {
    await atomicWrite(keyFile, keyPem, { mode: 0o600 })
    try {
      await atomicWrite(certFile, certPem, { mode: 0o600 })
    } catch (err) {
      // 证书没写成：把 key 还原，保证旧的 cert/key 仍是一对
      if (oldKey) await atomicWrite(keyFile, oldKey, { mode: 0o600 }).catch(() => {})
      else fs.rmSync(keyFile, { force: true })
      throw err
    }
  } catch (err) {
    throw codedError('E_TLS_GENERATE', `证书写入失败：${err.message}`, { cause: err })
  }
  return { certFile, keyFile, fingerprint256: fingerprintOfCert(certPem) }
}

/* ───────────────────────── pin 表 ───────────────────────── */

const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const emptyTable = () => ({ version: PEER_PINS_VERSION, pins: {} })
const pinsFile = (stateDir) => path.join(stateDir, PEER_PINS_FILE_NAME)

function parseTable(text) {
  const parsed = JSON.parse(text)
  if (!isPlain(parsed) || parsed.version !== PEER_PINS_VERSION || !isPlain(parsed.pins)) throw new Error('bad shape')
  const pins = Object.create(null)
  for (const [nodeId, p] of Object.entries(parsed.pins)) {
    if (!NODE_ID_RE.test(nodeId) || !isPlain(p)) throw new Error('bad pin entry')
    pins[nodeId] = {
      fingerprint: normalizeTlsFingerprint(p.fingerprint),
      endpoint: typeof p.endpoint === 'string' ? p.endpoint : '',
      pinnedAt: typeof p.pinnedAt === 'number' ? p.pinnedAt : 0,
    }
  }
  return { version: PEER_PINS_VERSION, pins: { ...pins } }
}

/** 缺失 → 空表（不写盘）；损坏 → 改名 .corrupt-<ts> 保留并返回空表。永不 TOFU。 */
export function loadPeerPins(stateDir) {
  if (typeof stateDir !== 'string' || stateDir === '') return emptyTable()
  const file = pinsFile(stateDir)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return emptyTable()
  }
  try {
    return parseTable(text)
  } catch {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* 改名失败也不覆盖、不删除 */
    }
    return emptyTable()
  }
}

const writeQueues = new Map()
function serialized(stateDir, job) {
  const prev = writeQueues.get(stateDir) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(job)
  writeQueues.set(stateDir, next)
  return next
}

async function writeTable(stateDir, table) {
  await atomicWrite(pinsFile(stateDir), `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 })
}

/** 写入/更新一个 pin。只应在用户确认后由调用方调用。 */
export function savePeerPin(stateDir, { nodeId, fingerprint, endpoint = '' } = {}) {
  return serialized(stateDir, async () => {
    if (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId)) {
      throw codedError('E_BAD_NODE_ID', 'nodeId 不合法')
    }
    const fp = normalizeTlsFingerprint(fingerprint)
    const table = loadPeerPins(stateDir)
    table.pins[nodeId] = { fingerprint: fp, endpoint: typeof endpoint === 'string' ? endpoint : '', pinnedAt: Date.now() }
    await writeTable(stateDir, table)
    return true
  })
}

/** 显式解除钉住（唯一路径）。返回是否真的移除了东西。 */
export function removePeerPin(stateDir, nodeId) {
  return serialized(stateDir, async () => {
    const table = loadPeerPins(stateDir)
    if (!Object.hasOwn(table.pins, nodeId)) return false
    delete table.pins[nodeId]
    await writeTable(stateDir, table)
    return true
  })
}

/**
 * 纯函数：不读盘、不写盘、不改 pins。
 * `pins` 可以是 loadPeerPins 的整表，也可以是其中的 pins 映射。
 * 缺 pin → E_PIN_ABSENT；不等 → E_PIN_MISMATCH；格式坏的指纹也不放行。
 */
export function checkPeerPin({ pins, nodeId, fingerprint } = {}) {
  const map = isPlain(pins) && pins.version === PEER_PINS_VERSION && isPlain(pins.pins) ? pins.pins : pins
  if (!isPlain(map) || typeof nodeId !== 'string' || !Object.hasOwn(map, nodeId)) {
    return { ok: false, code: 'E_PIN_ABSENT' }
  }
  let actual
  try {
    actual = normalizeTlsFingerprint(fingerprint)
  } catch {
    return { ok: false, code: 'E_BAD_FINGERPRINT' }
  }
  const expected = map[nodeId]?.fingerprint
  if (expected !== actual) return { ok: false, code: 'E_PIN_MISMATCH', expected, actual }
  return { ok: true }
}
