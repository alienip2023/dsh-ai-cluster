/**
 * M4 S2：节点侧 `mem/*` 通道。
 *
 * 只做「连接绑定 + 发送闸门 + 分派」三件事；缓存/outbox/注入是 S4，hub 落盘是 S3。
 * 这里是节点唯一的发送入口，四条闸门必须按顺序全部通过：
 *
 *   1. **只发 mem/***：别的类型从这里发不出去，避免被当成通用发送器。
 *   2. **在线且已绑定连接**：nodeId 只取连接身份，绝不从调用方参数里拿；
 *      payload 里的 `nodeId` 永远被覆盖成本连接的值。
 *   3. **hub 声明了 memory-sync/1**：hub 在 welcome 里带 caps；缺这条就
 *      一个帧都不发（旧 hub 不会懂这些帧）。
 *   4. **正文帧要求 E2E 会话语义就绪**：read/write 走密文；hello/ack 是
 *      控制帧，可以在加密会话建立前通过（它们不带用户正文）。
 *
 * 另有一条大小闸：整帧 JSON 超过 MAX_MEMORY_FRAME_BYTES 就丢弃并计数。
 * 丢弃只记 warn，不抛 —— 记忆同步不能把节点的回合拖死。
 */
import {
  MAX_MEMORY_FRAME_BYTES,
  MEMORY,
  MEMORY_NODE_BODY,
  isMemoryFrameType,
} from '../wire/index.js'
import { MEMORY_CAPS } from '../caps/index.js'

/**
 * Memory scope kinds. `clusterBot` is RESERVED (MEMORY-STORE-DESIGN.md section 8): the
 * validator accepts it, every read/write rejects it with E_SCOPE_RESERVED before any
 * frame or disk access. No directory, file or migration exists for it in this slice.
 */
export const SCOPE_KINDS = Object.freeze(['team', 'node', 'bot', 'own', 'clusterBot'])
export const RESERVED_SCOPE_KINDS = Object.freeze(['clusterBot'])
export const E_SCOPE_RESERVED = 'E_SCOPE_RESERVED'

export function isScopeKind(scope) {
  return typeof scope === 'string' && SCOPE_KINDS.includes(scope)
}

export function isReservedScope(scope) {
  return typeof scope === 'string' && RESERVED_SCOPE_KINDS.includes(scope)
}

export function assertScopeUsable(scope) {
  if (isReservedScope(scope)) {
    const err = new Error('memory scope reserved: ' + scope)
    err.code = E_SCOPE_RESERVED
    throw err
  }
  return scope
}

const NODE_BODY = new Set(MEMORY_NODE_BODY)

function cleanId(value) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (t === '' || t.length > 128) return null
  return t
}

function safeSeq(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function frameBytes(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8')
  } catch {
    return Infinity
  }
}

/**
 * @param {object} o
 * @param {(type:string, data:object)=>boolean} o.send 底层 transport.send
 * @param {string} [o.nodeId] 连接级节点身份；连上后由 bind() 再确认一次
 * @param {()=>string[]} [o.hubCaps] hub 在 welcome 里宣告的能力
 * @param {()=>number} [o.appliedSeq] 已应用快照的 seq（S4 从缓存读，S2 恒 0）
 * @param {()=>boolean} [o.e2eReady] E2E 会话是否就绪；正文帧要求 true
 * @param {{warn?:Function}} [o.logger]
 * @param {number} [o.maxBytes]
 */
export function createMemoryLink(o = {}) {
  const sendRaw = typeof o.send === 'function' ? o.send : () => false
  const hubCaps = typeof o.hubCaps === 'function' ? o.hubCaps : () => []
  let appliedSeq = typeof o.appliedSeq === 'function' ? o.appliedSeq : () => 0
  const e2eReady = typeof o.e2eReady === 'function' ? o.e2eReady : () => false
  const logger = o.logger ?? null
  const maxBytes = Number.isFinite(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : MAX_MEMORY_FRAME_BYTES

  let bound = cleanId(o.nodeId)
  let isOnline = false
  const handlers = new Map()
  const stats = { sent: 0, failed: 0, blocked: 0, oversize: 0, e2eBlocked: 0, dispatched: 0 }

  function hubSupportsMemory() {
    try {
      const caps = hubCaps()
      return Array.isArray(caps) && caps.includes(MEMORY_CAPS)
    } catch {
      return false
    }
  }

  function bind(nodeId) {
    bound = cleanId(nodeId)
    return bound
  }

  function on(type, fn) {
    if (!isMemoryFrameType(type) || typeof fn !== 'function') return () => {}
    let set = handlers.get(type)
    if (!set) {
      set = new Set()
      handlers.set(type, set)
    }
    set.add(fn)
    return () => { set.delete(fn) }
  }

  function send(type, data) {
    if (!isMemoryFrameType(type)) return false
    // Reserved scope fails before every other gate: no stats, no frame, no disk.
    if (type === MEMORY.READ || type === MEMORY.WRITE) assertScopeUsable(data?.scope)
    if (bound === null || !isOnline) {
      stats.blocked += 1
      return false
    }
    if (!hubSupportsMemory()) {
      stats.blocked += 1
      return false
    }
    if (NODE_BODY.has(type) && !e2eReady()) {
      stats.e2eBlocked += 1
      return false
    }
    // 连接身份永远覆盖调用方给的 nodeId —— 节点不能自证来源。
    const payload = { ...(data ?? {}), nodeId: bound }
    if (frameBytes(payload) > maxBytes) {
      stats.oversize += 1
      logger?.warn?.('memory frame dropped: too large', { type, nodeId: bound })
      return false
    }
    let ok = false
    try {
      ok = sendRaw(type, payload) === true
    } catch (err) {
      logger?.warn?.('memory frame send failed', { type, nodeId: bound, error: String(err?.message ?? err) })
      ok = false
    }
    if (ok) stats.sent += 1
    else stats.failed += 1
    return ok
  }

  /** 连接上线：绑定连接 id，并在 hub 支持时发 mem/hello。 */
  /**
   * Which snapshot this node has applied. S4 sets this after it loads its cache, so the
   * hello a reconnect sends tells the hub how far behind the node is. The hub may push
   * a full snapshot anyway; the seq only saves a needless one.
   */
  function setAppliedSeq(fn) {
    if (typeof fn === 'function') appliedSeq = fn
    return safeSeq(appliedSeq())
  }

  function online() {
    isOnline = true
    if (bound === null) return false
    if (!hubSupportsMemory()) {
      stats.blocked += 1
      return false
    }
    return send(MEMORY.HELLO, { appliedSeq: safeSeq(appliedSeq()) })
  }

  /** Send the hello again now, if this link is online and the hub speaks memory. */
  function announce() {
    if (!isOnline) return false
    return online()
  }

  function offline() {
    isOnline = false
  }

  /** 把 hub 下行帧交给已注册的处理器；S2 没有消费者时返回 false。 */
  function dispatch(type, data) {
    if (!isMemoryFrameType(type)) return false
    const set = handlers.get(type)
    if (!set || set.size === 0) return false
    let handled = false
    for (const fn of [...set]) {
      try {
        fn(data)
        handled = true
      } catch (err) {
        logger?.warn?.('memory frame handler failed', { type, error: String(err?.message ?? err) })
      }
    }
    if (handled) stats.dispatched += 1
    return handled
  }

  return {
    get nodeId() { return bound },
    get isOnline() { return isOnline },
    get stats() { return { ...stats } },
    bind,
    on,
    setAppliedSeq,
    announce,
    send,
    read: (data) => send(MEMORY.READ, data),
    write: (data) => send(MEMORY.WRITE, data),
    online,
    offline,
    dispatch,
    hubSupportsMemory,
  }
}

/**
 * relay 模式：hub 的能力搭在 hub/identity 上，比"在线"信号晚到。第一次
 * online() 因此被挡在 memory-sync/1 闸门外。能力一到就重发 hello —— 只补
 * announce（内部重走四道闸门），不重放 online（那会重复 syncAll/sendRepos）。
 *
 * 单独抽出来是为了让这段接线本身可测：去掉 announce 就等于能力永远不生效。
 */
export function attachCapsAnnounce(transport, memoryLink, logger) {
  return transport.on('caps', (caps) => {
    try {
      logger?.info?.('hub caps updated', { caps })
    } catch {
      /* 日志失败不能挡住记忆通道 */
    }
    memoryLink.announce()
  })
}

/**
 * 本进程中继配置覆盖层。
 *
 * 写盘成功后必须立刻让本进程看见 relay.url / relay.token，否则
 * ssh-onboard 与 /ui/config 仍读到空值，用户还得再重启一次。
 * cordis 有时会冻结 config：赋值抛错时只留 overlay，读取口径只有这一份。
 */
// ---- copied verbatim from lib/setup.js (outside this module's import boundary) ----
const MANAGED_BEGIN = '# --- dsh-remote-agent (managed by dsh-remote-setup - do not edit) ---'
const MANAGED_END = '# --- end dsh-remote-agent managed block ---'
/**
 * 从**现有托管块**里抽出"本次表单不管辖"的 config 字段，原样返回（含缩进）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要（2026-10-20，v0.9.3 审查 H2）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `upsertManagedBlock` 是**块级整体替换**：新块进来，旧块整段消失。
 * 而面板的 setup 表单只提交 role/nodeId/transportMode/hubUrl/relayUrl/roots。
 *
 * 于是用户在面板点一次「保存」，托管块里的 `nodeToken`、`uiPullRoot`、
 * `listenHost`、`listenPort`、`relay` **全部被静默删掉**（已实证）。
 * 而 instance.json 那边也没存这些 —— 等于"点一次保存，凭证和设置就没了"。
 *
 * 修法不是让表单管更多字段（字段会一直加），而是**只重写自己管辖的那几个**，
 * 其余原样搬回来。
 *
 * 实现刻意走**文本级切分**而不是 YAML 解析：
 *   · 不需要引入解析器（本包零运行时依赖是硬约束）
 *   · 保留用户的原始格式（注释、引号风格、键顺序）—— 解析再序列化会全部丢失
 *
 * @param {string} blockText 托管块正文（`MANAGED_BEGIN/END` 之间的内容）
 * @param {Set<string>|string[]} ownedKeys 本次由表单管辖的顶层 config 键
 * @returns {string[]} 需要原样保留的行
 */
export function extractPreservedConfig(blockText, ownedKeys) {
  const src = typeof blockText === 'string' ? blockText : ''
  const owned = ownedKeys instanceof Set ? ownedKeys : new Set(Array.isArray(ownedKeys) ? ownedKeys : [])
  const lines = src.split('\n')

  // 定位 `  config:`（两个空格缩进 —— loader 条目的标准形态）
  const start = lines.findIndex((l) => /^\s{2}config:\s*$/.test(l))
  if (start === -1) return []

  const groups = []
  let cur = null
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') {
      // 空行跟着当前组（保留段落感），组还没开始就忽略
      if (cur) cur.lines.push(line)
      continue
    }
    // 顶层字段：4 个空格 + key:
    const m = /^ {4}([A-Za-z0-9_]+):/.exec(line)
    if (m) {
      cur = { key: m[1], lines: [line] }
      groups.push(cur)
      continue
    }
    // 更深缩进（嵌套对象 / 列表项）→ 属于当前组
    if (cur && /^ {5,}\S/.test(line)) {
      cur.lines.push(line)
      continue
    }
    // 缩进 ≤3 或新条目 —— config 段结束
    break
  }

  const kept = []
  for (const g of groups) {
    if (owned.has(g.key)) continue
    // 去掉尾部多余空行，避免拼回去时积累空行
    const ls = g.lines.slice()
    while (ls.length > 0 && ls[ls.length - 1].trim() === '') ls.pop()
    kept.push(...ls)
  }
  return kept
}

/**
 * 读取文件里现有托管块的正文（不含标记行）。没有托管块时返回 ''。
 * @param {string} fileText
 * @returns {string}
 */
export function readManagedBlockBody(fileText) {
  const src = typeof fileText === 'string' ? fileText : ''
  const i = src.indexOf(MANAGED_BEGIN)
  if (i === -1) return ''
  const j = src.indexOf(MANAGED_END, i)
  if (j === -1) return ''
  return src.slice(i + MANAGED_BEGIN.length, j)
}

// ---- absorbed from lib/hub/relay-memory.js ----
const overlays = new WeakMap()

function slotOf(config) {
  let slot = overlays.get(config)
  if (!slot) {
    slot = { url: '', token: '', transportMode: '' }
    overlays.set(config, slot)
  }
  return slot
}

export function readRelayUrl(config) {
  const slot = overlays.get(config)
  if (slot && typeof slot.url === 'string' && slot.url !== '') return slot.url
  if (typeof config?.relay?.url === 'string' && config.relay.url !== '') return config.relay.url
  if (typeof config?.relayUrl === 'string') return config.relayUrl
  return ''
}

export function readRelayToken(config) {
  const slot = overlays.get(config)
  if (slot && typeof slot.token === 'string' && slot.token !== '') return slot.token
  if (typeof config?.relay?.token === 'string' && config.relay.token !== '') return config.relay.token
  if (typeof config?.relayToken === 'string') return config.relayToken
  return ''
}

export function readRelayTransportMode(config) {
  const slot = overlays.get(config)
  if (slot && typeof slot.transportMode === 'string' && slot.transportMode !== '') return slot.transportMode
  if (typeof config?.transportMode === 'string' && config.transportMode !== '') return config.transportMode
  return 'relay'
}

export function applyRelayMemory(config, { relayUrl = '', token = '' } = {}) {
  if (!config || typeof config !== 'object') return
  const slot = slotOf(config)
  slot.url = String(relayUrl || '')
  slot.token = String(token || '')
  slot.transportMode = 'relay'
  try {
    const prev = config.relay && typeof config.relay === 'object' ? config.relay : {}
    config.relay = { ...prev, url: slot.url, token: slot.token }
    config.relayUrl = slot.url
    config.transportMode = 'relay'
  } catch {
    /* frozen: overlay already holds the values */
  }
}

function q(s) {
  return `'${String(s ?? '').replace(/'/g, "''")}'`
}

function configScalar(body, key, fallback) {
  const re = new RegExp(`^ {4}${key}:\\s*(.*)$`, 'm')
  const m = String(body || '').match(re)
  if (!m) return fallback
  const value = m[1].trim()
  return value === '' ? fallback : value
}

function injectLine(body) {
  const m = String(body || '').match(/^ {2}inject:.*$/m)
  return m ? m[0].trim() : "inject: ['webServer', 'tools', 'systemPrompt']"
}

/** 生成托管块正文（不含标记）。保留 inject/role/transportMode，写入 relayUrl 与 relay.url/token。 */
export function buildRelayAutoconfigYaml(existingText, { relayUrl, hubToken } = {}) {
  const body = readManagedBlockBody(existingText)
  const preserved = extractPreservedConfig(body, ['role', 'transportMode', 'relayUrl', 'relay'])
  const lines = [
    '- id: remote-agent',
    '  name: dsh-remote-agent',
    `  ${injectLine(body)}`,
    '  config:',
    `    role: ${configScalar(body, 'role', 'hub')}`,
    `    transportMode: ${configScalar(body, 'transportMode', 'relay')}`,
    `    relayUrl: ${q(relayUrl)}`,
    '    relay:',
    `      url: ${q(relayUrl)}`,
    `      token: ${q(hubToken)}`,
  ]
  if (preserved.length > 0) lines.push(...preserved)
  return `${lines.join('\n')}\n`
}
