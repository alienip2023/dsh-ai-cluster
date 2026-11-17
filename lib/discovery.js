/**
 * 局域网发现（阶段 1b，默认关闭）。
 *
 * 只做两件事：周期性广播一个「我在这里」的 offer，以及把收到的 offer 记进内存表。
 * 绝不自动连接、绝不自动配对；发现结果只进内存与面板数据。
 * 不广播任何密钥 / token / 证书；groupKey 只用来算 HMAC 证明，本身不出网。
 * 无 TLS（留给阶段 2）。
 */
import nodeDgram from 'node:dgram'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { readFileSync } from 'node:fs'

export const DISCOVERY_SERVICE = 'dsh-ai-unified'
export const DISCOVERY_VERSION = 1
export const DISCOVERY_DEFAULT_PORT = 8129
export const DISCOVERY_DEFAULT_INTERVAL_MS = 5000
export const DISCOVERY_MAX_PACKET = 4096
export const DISCOVERY_MAX_PEERS = 64
const PROOF_PREFIX = 'dsh-ai-unified-lan:'

/** 读 package.json 的 version（读不到给 0.0.0，不抛）。 */
export function readPluginVersion() {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

/** 归一化配置。默认关闭：只有 enabled === true 才算开。 */
export function normalizeDiscoveryConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const port = Number.isInteger(c.port) && c.port >= 0 && c.port < 65536 ? c.port : DISCOVERY_DEFAULT_PORT
  const intervalMs = Number.isFinite(c.intervalMs) && c.intervalMs >= 100 ? c.intervalMs : DISCOVERY_DEFAULT_INTERVAL_MS
  return {
    enabled: c.enabled === true,
    port,
    intervalMs,
    groupKey: typeof c.groupKey === 'string' ? c.groupKey : '',
  }
}

/** 对 offer 的身份字段做 HMAC-SHA256（前缀 dsh-ai-unified-lan:）。 */
export function groupProof(groupKey, offer) {
  if (!groupKey) return ''
  const body = [offer.node, offer.hostname, offer.port, offer.role, offer.pluginVersion].join('|')
  return createHmac('sha256', groupKey).update(PROOF_PREFIX + body).digest('hex')
}

/** 构造 offer。字段固定，不带任何凭证；proof 仅在配置了 groupKey 时附带。 */
export function buildOffer({ node, hostname, port, role, pluginVersion, groupKey = '' }) {
  const offer = {
    service: DISCOVERY_SERVICE,
    v: DISCOVERY_VERSION,
    type: 'offer',
    node: String(node),
    hostname: String(hostname),
    port: Number(port),
    role: role === 'hub' ? 'hub' : 'node',
    pluginVersion: String(pluginVersion),
    pairRequired: true,
  }
  if (groupKey) offer.proof = groupProof(groupKey, offer)
  return offer
}

export function encodeOffer(offer) {
  return Buffer.from(JSON.stringify(offer), 'utf8')
}

/**
 * 解码并校验一个数据报。不合格返回 null（调用方直接忽略）。
 * groupKey 非空 → 必须带正确 proof；groupKey 为空 → 不要求 proof。
 */
export function decodeOffer(buf, { groupKey = '' } = {}) {
  if (!buf || buf.length > DISCOVERY_MAX_PACKET) return null
  let msg
  try {
    msg = JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf))
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null
  if (msg.service !== DISCOVERY_SERVICE) return null
  if (msg.v !== DISCOVERY_VERSION || msg.type !== 'offer') return null
  if (typeof msg.node !== 'string' || msg.node === '' || msg.node.length > 128) return null
  if (typeof msg.hostname !== 'string' || msg.hostname === '' || msg.hostname.length > 128) return null
  if (!Number.isInteger(msg.port) || msg.port < 0 || msg.port > 65535) return null
  if (msg.role !== 'hub' && msg.role !== 'node') return null
  if (typeof msg.pluginVersion !== 'string' || msg.pluginVersion.length > 64) return null
  if (groupKey) {
    if (typeof msg.proof !== 'string') return null
    const expect = Buffer.from(groupProof(groupKey, msg), 'utf8')
    const got = Buffer.from(msg.proof, 'utf8')
    if (expect.length !== got.length || !timingSafeEqual(expect, got)) return null
  }
  return { node: msg.node, hostname: msg.hostname, port: msg.port, role: msg.role, pluginVersion: msg.pluginVersion }
}

/** peers 表：key = node + hostname；过期清除；上限丢最旧。时钟可注入。 */
export function createPeerTable({ intervalMs = DISCOVERY_DEFAULT_INTERVAL_MS, now = Date.now, max = DISCOVERY_MAX_PEERS } = {}) {
  const map = new Map()
  const ttl = intervalMs * 3
  const prune = () => {
    const t = now()
    for (const [k, p] of map) if (t - p.at > ttl) map.delete(k)
  }
  return {
    upsert(p) {
      const key = `${p.node}\u0000${p.hostname}`
      map.delete(key) // 重新插入以保持 Map 迭代序 = 刷新序
      map.set(key, { node: p.node, hostname: p.hostname, role: p.role, port: p.port, pluginVersion: p.pluginVersion, at: now() })
      prune()
      while (map.size > max) map.delete(map.keys().next().value)
    },
    /** 已过期过滤、按 at 倒序。 */
    list() {
      prune()
      return [...map.values()].map((p) => ({ ...p })).reverse().sort((a, b) => b.at - a.at)
    },
    clear() { map.clear() },
    get size() { return map.size },
  }
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address)) return i.address
    }
  }
  return '127.0.0.1'
}

function broadcastTargets() {
  const out = new Set(['255.255.255.255'])
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && i.netmask) {
        const ip = i.address.split('.').map(Number)
        const m = i.netmask.split('.').map(Number)
        out.add(ip.map((n, k) => (n & m[k]) | (~m[k] & 255)).join('.'))
      }
    }
  }
  return [...out]
}

/**
 * 可 start/stop 的发现组件。
 * @param {object} o
 * @param {object} o.config      { enabled, port, intervalMs, groupKey }
 * @param {'hub'|'node'} o.role
 * @param {string} o.node        节点名
 * @param {number} o.port        对外宣告的 hub 端口
 * @param {string} o.pluginVersion
 * 测试注入：dgram、now、hostname、bindHost、targets（[{address,port}]，默认=局域网广播地址:config.port）、log
 */
export function createDiscovery({
  config,
  role = 'node',
  node = 'local',
  port = 0,
  pluginVersion = '0.0.0',
  dgram = nodeDgram,
  now = Date.now,
  hostname,
  bindHost = '0.0.0.0',
  targets,
  log,
} = {}) {
  const cfg = normalizeDiscoveryConfig(config)
  const table = createPeerTable({ intervalMs: cfg.intervalMs, now })
  let socket = null
  let timer = null
  let active = false
  let boundPort = null
  let customTargets = targets || null
  const warn = (msg) => { try { log?.warn?.(msg) } catch { /* ignore */ } }
  const info = (msg) => { try { log?.info?.(msg) } catch { /* ignore */ } }

  const portOf = () => (typeof port === 'function' ? port() : port)

  function self() {
    return { node: String(node), hostname: hostname || lanAddress() }
  }

  function sendOffer() {
    if (!socket) return
    const me = self()
    const buf = encodeOffer(buildOffer({ ...me, port: portOf(), role, pluginVersion, groupKey: cfg.groupKey }))
    const list = customTargets || broadcastTargets().map((address) => ({ address, port: cfg.port }))
    for (const t of list) {
      try { socket.send(buf, t.port, t.address, () => {}) } catch { /* 发送失败不致命 */ }
    }
  }

  function onMessage(buf) {
    const p = decodeOffer(buf, { groupKey: cfg.groupKey })
    if (!p) return
    const me = self()
    if (p.node === me.node && p.hostname === me.hostname && p.port === Number(portOf())) return // 自己的回声
    table.upsert(p)
  }

  function teardownSocket() {
    if (timer) { clearInterval(timer); timer = null }
    const s = socket
    socket = null
    if (s) { try { s.close() } catch { /* ignore */ } }
  }

  return {
    get enabled() { return active },
    get boundPort() { return boundPort },
    setTargets(list) { customTargets = list },
    /** 返回 Promise<boolean>：true=已启用。关闭 / 绑定失败都返回 false，且不抛。 */
    start() {
      if (!cfg.enabled) return Promise.resolve(false) // 默认关闭：不碰 dgram
      if (socket) return Promise.resolve(active)
      return new Promise((resolve) => {
        let settled = false
        const done = (ok) => { if (!settled) { settled = true; resolve(ok) } }
        let s
        try {
          s = dgram.createSocket({ type: 'udp4', reuseAddr: false })
        } catch (err) {
          warn(`[discovery] 无法创建 socket，局域网发现保持未启用：${err?.message || err}`)
          return done(false)
        }
        socket = s
        let warned = false
        s.on('error', (err) => {
          if (!warned) { warned = true; warn(`[discovery] udp/${cfg.port} 不可用（${err?.code || err?.message || err}），局域网发现降级为未启用`) }
          if (!active) { teardownSocket(); table.clear() }
          done(false)
        })
        s.on('message', onMessage)
        try {
          s.bind(cfg.port, bindHost, () => {
            if (socket !== s) return done(false)
            try { s.setBroadcast(true) } catch { /* ignore */ }
            try { boundPort = s.address().port } catch { boundPort = cfg.port }
            active = true
            info(`[discovery] 已启用，监听 udp/${boundPort}（仅广播/接收，不自动连接）`)
            sendOffer()
            timer = setInterval(sendOffer, cfg.intervalMs)
            timer.unref?.()
            done(true)
          })
        } catch (err) {
          warn(`[discovery] 绑定失败，局域网发现保持未启用：${err?.message || err}`)
          teardownSocket()
          done(false)
        }
      })
    },
    stop() {
      active = false
      boundPort = null
      teardownSocket()
      table.clear()
    },
    /** 面板 / selfcheck 用：{ enabled, peers }。 */
    snapshot() {
      return { enabled: active, peers: active ? table.list() : [] }
    },
  }
}
