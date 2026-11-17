/** caps/acl：设备能力 ACL 的纯函数（STAGE2-DESIGN §3.2–3.3）。无 I/O。 */
import { ERROR_CODE } from '../wire/errors.js'

export const ACL_CAPABILITIES = Object.freeze(['read', 'write', 'delegate', 'shell', 'desktop'])
export const ACL_DEFAULTS = Object.freeze({ read: true, write: true, delegate: true, shell: false, desktop: false })
/** 坏文件的回落：只读（用户标准规则，见 Commander 更正 1）。 */
export const ACL_READ_ONLY = Object.freeze({ read: true, write: false, delegate: false, shell: false, desktop: false })

export const HUB_IDENTITY = '@hub'
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const isCap = (c) => typeof c === 'string' && ACL_CAPABILITIES.includes(c)
const isNodeId = (n) => typeof n === 'string' && (n === HUB_IDENTITY || NODE_ID_RE.test(n))
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

function aclError(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra)
}

/** 空 ACL（devices 为空）：以 `defaults` 为全局默认。 */
export function makeAcl(defaults = ACL_DEFAULTS) {
  return { version: 1, defaults: { ...defaults }, devices: {} }
}

export function normalizeAclConfig(raw) {
  const errors = []
  const notes = []
  if (!isPlainObject(raw)) return { ok: false, errors: ['acl must be an object'] }
  if (raw.version !== 1) errors.push(`unsupported version: ${JSON.stringify(raw.version)}`)

  const defaults = { ...ACL_DEFAULTS }
  if (raw.defaults !== undefined) {
    if (!isPlainObject(raw.defaults)) errors.push('defaults must be an object')
    else {
      for (const [k, v] of Object.entries(raw.defaults)) {
        if (!isCap(k)) errors.push(`defaults: unknown capability ${JSON.stringify(k)}`)
        else if (typeof v !== 'boolean') errors.push(`defaults.${k} must be boolean`)
        else defaults[k] = v
      }
    }
  }

  const devices = {}
  if (raw.devices !== undefined) {
    if (!isPlainObject(raw.devices)) errors.push('devices must be an object')
    else {
      for (const [node, entry] of Object.entries(raw.devices)) {
        if (!isNodeId(node)) { errors.push(`devices: bad node id ${JSON.stringify(node)}`); continue }
        if (!isPlainObject(entry)) { errors.push(`devices.${node} must be an object`); continue }
        const lists = {}
        for (const field of ['allow', 'deny']) {
          const v = entry[field]
          if (v === undefined) { lists[field] = []; continue }
          if (!Array.isArray(v)) { errors.push(`devices.${node}.${field} must be an array`); continue }
          const ok = []
          for (const c of v) {
            if (typeof c !== 'string') errors.push(`devices.${node}.${field}: non-string entry`)
            else if (!isCap(c)) errors.push(`devices.${node}.${field}: unknown capability ${JSON.stringify(c)}`)
            else if (!ok.includes(c)) ok.push(c)
          }
          lists[field] = ok
        }
        if (lists.allow && lists.deny) {
          const both = lists.allow.filter((c) => lists.deny.includes(c))
          if (both.length) {
            lists.allow = lists.allow.filter((c) => !both.includes(c))
            notes.push(`devices.${node}: ${both.join(',')} in both allow and deny; deny wins`)
          }
          devices[node] = { allow: lists.allow, deny: lists.deny }
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors }
  return { ok: true, acl: { version: 1, defaults, devices }, notes }
}

export function checkAcl(acl, { node, capability } = {}) {
  if (!isCap(capability)) return { allowed: false, reason: 'unknown-capability' }
  const dev = acl && isPlainObject(acl.devices) && typeof node === 'string' && has(acl.devices, node) ? acl.devices[node] : null
  if (dev?.deny?.includes(capability)) return { allowed: false, reason: 'device-deny' }
  if (dev?.allow?.includes(capability)) return { allowed: true, reason: 'device-allow' }
  return { allowed: acl?.defaults?.[capability] === true, reason: 'default' }
}

export function assertAcl(acl, { node, capability, tool } = {}) {
  const res = checkAcl(acl, { node, capability })
  if (res.allowed) return
  throw aclError('ACL_DENIED', `acl denied: ${node} may not use ${capability}${tool ? ` (${tool})` : ''} [${res.reason}]`, {
    node, capability, reason: res.reason, tool, wireCode: ERROR_CODE.ACL_DENIED,
  })
}

/**
 * 更新：`node` 指明被改的设备（reset 时可省）。allow/deny 为能力名数组，互斥：
 * 加入 allow 会从 deny 移除，反之亦然。校验失败抛 E_INVALID_ARG，不产生新 ACL。
 */
export function resolveAclUpdate(current, { node, allow, deny, reset } = {}) {
  const base = normalizeAclConfig(current)
  if (!base.ok) throw aclError('E_INVALID_ARG', `current acl invalid: ${base.errors.join('; ')}`)
  const notes = []
  if (reset === true) {
    const acl = makeAcl()
    return { acl, changed: JSON.stringify(acl) !== JSON.stringify(base.acl), notes: ['reset to defaults'] }
  }
  const lists = { allow: allow ?? [], deny: deny ?? [] }
  for (const [f, v] of Object.entries(lists)) {
    if (!Array.isArray(v) || v.some((c) => !isCap(c))) throw aclError('E_INVALID_ARG', `${f} must be an array of known capabilities`)
  }
  if (!lists.allow.length && !lists.deny.length) return { acl: base.acl, changed: false, notes }
  if (!isNodeId(node)) throw aclError('E_INVALID_ARG', `bad node id ${JSON.stringify(node)}`)
  const acl = JSON.parse(JSON.stringify(base.acl))
  const cur = has(acl.devices, node) ? acl.devices[node] : { allow: [], deny: [] }
  for (const c of lists.allow) {
    if (!cur.allow.includes(c)) cur.allow.push(c)
    if (cur.deny.includes(c)) { cur.deny = cur.deny.filter((x) => x !== c); notes.push(`${c} removed from deny`) }
  }
  for (const c of lists.deny) {
    if (!cur.deny.includes(c)) cur.deny.push(c)
    if (cur.allow.includes(c)) { cur.allow = cur.allow.filter((x) => x !== c); notes.push(`${c} removed from allow`) }
  }
  acl.devices[node] = cur
  return { acl, changed: JSON.stringify(acl) !== JSON.stringify(base.acl), notes }
}

export function describeAcl(acl, nodeIds = []) {
  return {
    defaults: { ...acl.defaults },
    devices: nodeIds.map((node) => ({
      node,
      effective: Object.fromEntries(ACL_CAPABILITIES.map((capability) => [capability, checkAcl(acl, { node, capability }).allowed])),
    })),
  }
}
