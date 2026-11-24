/**
 * L4-3 roster/registry: the connection half of the old NodeRegistry (online state, hello
 * ingestion, heartbeat timeout, topology projection, connection log) plus the ingest and
 * handshake mixins, moved from lib/hub/{node-registry,registry-ingest,registry-handshake}.js.
 *
 * Task tracking (createTask / ensureTask / waiters / approvals / pulls / fs+share requests /
 * auto node picking) is NOT here; it belongs to src/task-run + src/task-book. The mixins
 * still call this.ensureTask / this.resolveWaiters / this.tasks / this.pulls /
 * this.handleFsRes / this.handleShareRes when a task frame arrives, so the assembler must
 * compose RosterRegistry with the task half to get the full old NodeRegistry. Connection-only
 * paths (hello, heartbeat, roster, resource, connectivity, mem/*, config-sync) need nothing.
 *
 * Injected instead of imported (those modules are outside wire/store/caps/trust):
 *   explainError         -> options.explainError(err, ctx) for connection-log hints
 *   createPeerRouter     -> options.createPeerRouter(...) and options.isPeerBotType(type)
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PULL_TIMEOUT_MS,
  ERROR_CODE,
  HUB_TO_NODE,
  NODE_TO_HUB,
  PEER,
  PEER_BOT_TYPES,
  RemoteAgentError,
  TASK_STATUS,
  TERMINAL_STATUS,
  MAX_MEMORY_FRAME_BYTES,
  MEMORY,
  PROTOCOL_VERSION,
  RELAY_FRAME,
  decodeBinaryFrame,
  decodeFrame,
  encodeBinaryFrame,
  encodeFrame,
  envelope,
  validateJobsFrame,
  validateHello,
  validateBotTurnResult,
  validateBotTrace,
  validateBotTurn,
  validateBotMessage,
  validateBotAssign,
  validateTeamAct,
  validateBotCreateResult,
  validateBotHistoryResult,
  validateBotUpdateResult,
  validateBotDeleteResult,
  validateBotStopResult,
  validateBotActionResult,
  validateMemAck,
  validateMemRead,
  validateMemWrite,
  validateNodeConfigResult,
} from '../wire/index.js'
import { HUB_CAPS } from '../caps/index.js'
import {
  E2E_MARKER,
  createSession,
  generateEphemeral,
  newNonce,
  normalizeE2EPub,
  signExchange,
  signIdentity,
  writeJsonAtomic,
} from '../trust/index.js'
import { cleanRosterSkills } from './report.js'

// Copies of lib/hub/hub-util.js (errText, numOr) and lib/hub/e2e-heal.js, kept byte-for-byte
// in behavior; lib/ is outside this slice's import boundary.
const errText = (err) => String(err?.message ?? err ?? 'unknown error')
const numOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * A bot/turn that names attachments follows its bot/attach chunks, which always travel on the hub link
 * (bot/attach is not a peer bot type). Sending that turn over a peer-direct socket could overtake the chunks,
 * so it takes the hub link too: one connection, so the chunks are in front of the turn.
 */
const HUB_ONLY_AFTER_ATTACH_MS = 120_000
function carriesAttachments(type, data) {
  return type === 'bot/turn' && Array.isArray(data?.attachments) && data.attachments.length > 0
}

export const E2E_HEAL_DEFAULTS = Object.freeze({
  /** First attempt after the node shows up without a session; each further attempt doubles the wait. */
  baseMs: 2_000,
  /** The wait never grows beyond this. */
  maxMs: 30_000,
  /** Attempts that actually left the hub per online period (0 = never). */
  maxAttempts: 10,
  /** After a frame that cannot be opened: at most one e2e-reset per node in this window. */
  resetMinMs: 5_000,
})

const posMs = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3_600_000

/** Options → complete settings. Every invalid field falls back to its own default. */
export function resolveE2EHeal(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const d = E2E_HEAL_DEFAULTS
  const baseMs = posMs(o.baseMs) ? o.baseMs : d.baseMs
  const maxMs = posMs(o.maxMs) ? Math.max(o.maxMs, baseMs) : Math.max(d.maxMs, baseMs)
  const maxAttempts = Number.isInteger(o.maxAttempts) && o.maxAttempts >= 0 && o.maxAttempts <= 1000 ? o.maxAttempts : d.maxAttempts
  const resetMinMs = posMs(o.resetMinMs) ? o.resetMinMs : d.resetMinMs
  return { baseMs, maxMs, maxAttempts, resetMinMs }
}

/** Wait before attempt n (1-based): base, 2×base, 4×base … capped. */
export function e2eHealDelayMs(n, cfg) {
  const k = Math.max(1, Math.floor(n))
  return Math.min(cfg.baseMs * 2 ** Math.min(k - 1, 30), cfg.maxMs)
}


/**
 * 单个节点可上报的模型数量上限（提案 #27）。
 *
 * 与副机侧的 MAX_MODELS 同量级 —— hub 侧必须**独立封顶**：不能信任对端
 * 遵守了自己的上限（旧版副机、或刻意构造的帧都可能更大）。这是"单帧
 * 故障隔离"不变式的一部分：畸形帧不能把注册表撑爆。
 */
const MAX_NODE_MODELS = 64

/**
 * 单个模型可带的思考等级上限（提案 #27 续）：与模型数一样是"对端自述"，
 * hub 侧独立封顶 + 逐项清洗（id 必填非空、≤64；name ≤128）。
 */
const MAX_NODE_EFFORTS = 16

/** 单帧 JSON 字节数；超限整帧丢弃（与节点侧 same-limit 闸对称）。 */
function memoryFrameBytes(d) {
  try {
    return Buffer.byteLength(JSON.stringify(d ?? {}), 'utf8')
  } catch {
    return Infinity
  }
}

class RosterCore extends EventEmitter {
  /**
   * @param {object} [identity] hub 身份（lib/identity.js loadOrCreateHubIdentity 的返回值）。
   *   缺省 / 不完整 = hub 身份认证能力关闭：welcome 不带 identity，relay 不追发，
   *   副机按旧协议处理 —— 身份子系统故障绝不演变成"拒绝所有副机"。
   */
  constructor({ log, limits = {}, relay = null, identity = null, audit = null, e2eHeal = undefined, stateDir = '',
    explainError = null, createPeerRouter = null, isPeerBotType = null } = {}) {
    super()
    // Injected collaborators (their lib/ homes are outside this module's import boundary).
    this.explainErrorFn = typeof explainError === 'function' ? explainError : null
    this.createPeerRouterFn = typeof createPeerRouter === 'function' ? createPeerRouter : null
    this.isPeerBotTypeFn = typeof isPeerBotType === 'function' ? isPeerBotType : (type) => PEER_BOT_TYPES.includes(type)
    this.setMaxListeners(50)
    // fork.63: the hub starts the e2e handshake itself (see e2e-heal.js). Test/ops knob only; it is not a panel setting.
    this.e2eHealCfg = resolveE2EHeal(e2eHeal)
    /** nodeId → { attempts, waits, timer }: nodes that are online without a session and are being re-keyed. */
    this.e2eHealState = new Map()
    /** nodeId → last time an e2e-reset was sent because a frame could not be opened. */
    this.e2eOpenFailResetAt = new Map()
    this.log = log ?? (() => {})
    this.limits = {
      helloTimeoutMs: 10_000,
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
      pullTimeoutMs: DEFAULT_PULL_TIMEOUT_MS,
      maxPullBytes: 512 * 1024 * 1024,
      maxTasksPerNode: 64,
      // 两阶段审批（提案 #2）：挂起超过此时长自动拒绝（fail-closed）。
      // 0 = 不设超时（任务一直挂着等人，仍不会自动批准）。
      approvalTimeoutMs: 30 * 60 * 1000,
      ...limits,
    }
    /** @type {import('./audit-log.js').createAuditLog | null} 审计写入器（提案 #19，null = 关闭）。 */
    this.audit = audit && typeof audit.record === 'function' ? audit : null
    /** nodeId → rec */
    this.nodes = new Map()
    /**
     * 连接尝试历史（2026-10-20，体验提升 ①）。
     *
     * 问题：副机连不上时，主机只显示「0 在线」，**没有任何原因**。
     * 实测用户为此排查了两天（重启回引导页、19387 不监听、SMB 密码…）。
     *
     * 这里记**每一次连接尝试的结果**（成功/失败 + 原因 + 时间 + 远端地址），
     * 面板据此显示"最后尝试 2 分钟前 —— 握手超时 → 检查…"。
     *
     * 上限 50 条（环形）：这是给人看的诊断线索，不是审计日志
     * （审计是 audit.jsonl，那是给合规/追溯用的）。
     */
    this.connectionLog = []
    /** 等 hello 的连接 */
    this.pending = new Set()
    /** taskId → NodeJS.Timeout（两阶段审批的自动拒绝定时器，提案 #2） */
    this.pendingApprovals = new Map()
    /** taskId → HubTask（全局索引，工具只拿得到 taskId） */
    this.tasks = new Map()
    /** reqId → { resolve, timer }（提案 #25：远程文件请求的等待者表） */
    this.fsPending = new Map()
    /**
     * reqId → { resolve, timer }（2026-10-17：工作区共享请求的等待者表）。
     *
     * 与 fsPending **刻意分开**：fs 是"读文件内容"、share 是"探测共享状态并
     * 生成命令"，两者语义不同。混用一张表会让超时归因变模糊（一条 share 超时
     * 被记成 fs-timeout，排查方向直接跑偏）。
     */
    this.sharePending = new Map()
    /** @type {import('./pull-manager.js').PullManager | undefined} */
    this.pulls = undefined
    /** @type {import('./relay-link.js').RelayLink | undefined} */
    this.relay = relay ?? null
    /** hub 身份（P2-11）：privateKeyB64/publicKeyB64/fingerprint；null = 无身份能力。 */
    this.identity = identity && typeof identity.privateKeyB64 === 'string' ? identity : null
    this.timer = undefined
    this.closed = false
    this.startedAt = Date.now()
    this.jobsFile = typeof stateDir === 'string' && stateDir ? path.join(stateDir, 'node-jobs.json') : ''
    if (this.jobsFile) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.jobsFile, 'utf8'))
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('invalid node jobs snapshot')
        for (const [nodeId, snapshot] of Object.entries(saved)) {
          const checked = validateJobsFrame(snapshot)
          if (!checked.ok) { this.log('warn', 'invalid saved jobs snapshot', { nodeId, code: checked.error }); continue }
          this.nodes.set(nodeId, { nodeId, online: false, since: snapshot.at, lastSeen: snapshot.at,
            tasks: new Map(), pendingPulls: new Map(), jobs: checked.jobs.jobs, jobsAt: checked.jobs.at })
        }
      } catch (err) { if (err.code !== 'ENOENT') this.log('warn', 'jobs snapshot load failed', { error: errText(err) }) }
    }
  }

  persistJobs() {
    if (!this.jobsFile) return
    try {
      const saved = Object.fromEntries([...this.nodes.values()].filter(rec => Array.isArray(rec.jobs))
        .map(rec => [rec.nodeId, { at: rec.jobsAt, jobs: rec.jobs }]))
      writeJsonAtomic(this.jobsFile, saved)
    } catch (err) { this.log('warn', 'jobs snapshot save failed', { error: errText(err) }) }
  }

  /**
   * 审计一条事件（提案 #19）。绝不抛、绝不阻塞 —— 审计挂了任务链路照常跑，
   * 这是不变式（见 audit-log.js 头注释的优先级 1）。
   */
  auditRecord(event, fields) {
    try {
      this.audit?.record(event, fields)
    } catch {
      /* 审计层的任何异常都不上抛 */
    }
  }

  // ─────────────────────────── 发送 ───────────────────────────

  /** Directory contains addresses only; credentials travel separately inside hub E2E. */
  publishPeerDirectory() {
    const peers = [...this.nodes.values()].filter(rec => rec.online && rec.hello?.peerUrl)
      .map(rec => ({ nodeId: rec.nodeId, url: rec.hello.peerUrl }))
    if (!peers.length && !this.peerRouter) return
    const key = JSON.stringify(peers)
    if (key === this.peerDirectoryKey) return
    this.peerDirectoryKey = key
    if (!this.peerRouter && this.createPeerRouterFn) {
      this.peerRouter = this.createPeerRouterFn({ nodeId: '@hub', log: this.log,
        fallback: (nodeId, type, data, opts) => this.sendViaHub(nodeId, type, data, opts),
        onFrame: (frame, nodeId) => { if (this.nodes.get(nodeId)?.online) this.handleFrameFor(nodeId, frame, { peer: true }) },
      })
    }
    this.peerRouter?.directory(peers)
    this.peerRouter?.credentials(peers.map(peer => ({ nodeId: peer.nodeId, secret: this.nodes.get(peer.nodeId).peerSecret })))
    for (const rec of this.nodes.values()) {
      if (!rec.online || !rec.hello?.peerUrl) continue
      this.sendViaHub(rec.nodeId, PEER.DIRECTORY, { peers })
      this.sendPeerCredentials(rec)
    }
  }

  sendPeerCredentials(rec) {
    if (!rec.e2e || !rec.online || !rec.hello?.peerUrl) return
    const credentials = [...this.nodes.values()].filter(peer => peer.online && peer.hello?.peerUrl)
      .map(peer => ({ nodeId: peer.nodeId, secret: peer.peerSecret }))
    this.sendViaHub(rec.nodeId, PEER.DIRECTORY, { peers: credentials.map(peer => ({ nodeId: peer.nodeId, url: this.nodes.get(peer.nodeId).hello.peerUrl })) })
    this.sendViaHub(rec.nodeId, PEER.WELCOME, { credentials })
  }

  /**
   * E2E 明文帧类型（提案 #1）：这些帧在会话存在时也**不加密**。
   *
   *   - welcome / hub-identity：握手帧，会话建立之前发；hub 重启后重发时
   *     rec.e2e 可能还是旧会话（副机侧已重置）—— 封了密副机就解不开，
     *     永远上不了线。这两帧的内容是公钥与指纹，本就可公开。
   *   - hub/e2e：确认帧本身就是密钥交换的一部分，必须明文。
   *   - error(e2e-reset)：会话丢失时的重协商信号，双方此时无共享密钥。
   *   - ping/pong：应用层心跳，无秘密；明文还能在会话半建立期保活。
   */
  static E2E_CLEAR_TYPES = new Set([
    HUB_TO_NODE.WELCOME,
    HUB_TO_NODE.IDENTITY,
    HUB_TO_NODE.E2E_ACK,
    HUB_TO_NODE.PING,
    NODE_TO_HUB.PONG,
  ])

  /**
   * 该节点是否有已建立的 E2E 会话（只读）。节点记录不存在 → false。
   * 带密钥的下行（如 config-push）发送前用它做护栏：没有会话 send() 会发明文。
   */
  hasE2E(nodeId) {
    return Boolean(this.nodes.get(nodeId)?.e2e)
  }

  /**
   * 发一个文本帧给节点。
   * `to` 始终带上：直连时无害，经中继时是路由依据。
   * 节点有 E2E 会话（提案 #1）时 d 字段自动封密（上述明文白名单除外）。
   */
  send(nodeId, type, data, opts = {}) {
    // An image or a file is the user's own data: it never leaves unencrypted (the receiving side refuses plaintext too),
    // so a node whose E2E session is not up yet gets no chunk rather than a readable one. The sender fails the message.
    if (type === HUB_TO_NODE.BOT_ATTACH && !this.nodes.get(nodeId)?.e2e) {
      this.log('warn', 'bot/attach not sent: no e2e session with the node', { nodeId })
      return false
    }
    // A turn with attachments travels on the hub link (its chunks do). The turns right behind it must not overtake it by
    // taking the peer-direct link: for a while after one, every turn to that node uses the hub link too.
    const hubOnly = (this.hubOnlyUntil ??= new Map())
    if (carriesAttachments(type, data)) hubOnly.set(nodeId, Date.now() + HUB_ONLY_AFTER_ATTACH_MS)
    const keepOnHub = carriesAttachments(type, data) || (hubOnly.get(nodeId) ?? 0) > Date.now()
    if (this.peerRouter && !keepOnHub && this.isPeerBotTypeFn(type) && this.nodes.get(nodeId)?.online) {
      return this.peerRouter.send(nodeId, type, data, opts)
    }
    return this.sendViaHub(nodeId, type, data, opts)
  }

  sendViaHub(nodeId, type, data, opts = {}) {
    if (typeof nodeId !== 'string' || nodeId === '') return false
    const rec = this.nodes.get(nodeId)
    const env = envelope(type, data, opts)
    const e2eReset = type === HUB_TO_NODE.ERROR && data?.code === ERROR_CODE.E2E_RESET
    if (rec?.e2e && !RosterCore.E2E_CLEAR_TYPES.has(type) && !e2eReset) {
      try {
        env.d = rec.e2e.sealFrame(type, env.id, env.d)
      } catch (err) {
        // 封密失败（会话已销毁等）：丢帧比发明文更安全 —— 明文会进中继日志。
        this.log('warn', 'e2e seal failed, frame dropped', { nodeId, type, error: errText(err) })
        return false
      }
    }
    const text = encodeFrame({ ...env, to: nodeId })
    const conn = rec?.conn
    if (conn && !conn.closed) {
      try {
        conn.send(text)
        return true
      } catch (err) {
        this.log('warn', 'send failed on direct conn', { nodeId, error: errText(err) })
      }
    }
    if (this.relay?.ready) return this.relay.send(nodeId, text)
    return false
  }

  /**
   * 发一个二进制帧给节点（header.to 由中继用来路由）。
   * E2E 会话存在时整体封密：外层只留 t/seq/iv + to。
   */
  sendBinary(nodeId, header, payload) {
    if (typeof nodeId !== 'string' || nodeId === '') return false
    const rec = this.nodes.get(nodeId)
    let hdr = header ?? {}
    let pl = payload ?? Buffer.alloc(0)
    if (rec?.e2e) {
      try {
        const sealed = rec.e2e.sealBinary(hdr.t, hdr, pl)
        hdr = sealed.header
        pl = sealed.payload
      } catch (err) {
        this.log('warn', 'e2e binary seal failed, frame dropped', { nodeId, error: errText(err) })
        return false
      }
    }
    let buf
    try {
      buf = encodeBinaryFrame({ ...hdr, to: nodeId }, pl)
    } catch (err) {
      // 头部过大等编码失败：如实记日志并返回 false，不让调用方炸掉。
      this.log('warn', 'binary frame encode failed', { nodeId, error: errText(err) })
      return false
    }
    const conn = rec?.conn
    if (conn && !conn.closed) {
      try {
        conn.sendBinary(buf)
        return true
      } catch (err) {
        this.log('warn', 'sendBinary failed on direct conn', { nodeId, error: errText(err) })
      }
    }
    if (this.relay?.ready) return this.relay.sendBinary(nodeId, buf)
    return false
  }

  // ─────────────────────────── 节点视图 ───────────────────────────

  getNode(nodeId) {
    return this.nodes.get(nodeId)
  }

  onlineNodes() {
    return [...this.nodes.values()].filter((r) => r.online)
  }

  /** 按 nodeId 或主机名挑节点；prefer 为空时返回唯一在线节点。 */
  pickNode(prefer = '') {
    const online = this.onlineNodes()
    const want = String(prefer ?? '').trim().toLowerCase()
    if (want !== '') {
      const hit = online.find(
        (r) => r.nodeId.toLowerCase() === want || String(r.hello?.hostname ?? '').toLowerCase() === want,
      )
      if (hit) return hit
      const known = this.nodes.get(prefer)
      if (known) return known
      return undefined
    }
    if (online.length === 1) return online[0]
    return undefined
  }

  /** 工具 remote_nodes 的输出。 */
  list() {
    return [...this.nodes.values()].map((r) => ({
      nodeId: r.nodeId,
      os: r.hello?.os ?? 'unknown',
      arch: r.hello?.arch ?? 'unknown',
      hostname: r.hello?.hostname ?? r.nodeId,
      online: r.online === true,
      roots: Array.isArray(r.hello?.roots) ? r.hello.roots : [],
      caps: Array.isArray(r.hello?.caps) ? r.hello.caps : [],
      agentMode: r.hello?.agentMode === true,
      since: r.since,
      lastSeen: r.lastSeen,
      taskCount: r.tasks.size,
      jobs: Array.isArray(r.jobs) ? r.jobs.map(job => ({ ...job })) : null,
      jobsAt: r.jobsAt ?? null,
      // 资源遥测（最近一次 node/resource；null = 尚未上报）。离线节点保留
      // 最后一份 —— 带 at 时间戳，消费方自行判断新鲜度。
      resource: r.resource ?? null,
      connectivity: r.connectivity ?? null,
      peerCapable: r.online === true && typeof r.hello?.peerUrl === 'string' && r.hello.peerUrl !== '',
      // 队列健康快照（提案 #26-3）：null = 副机未上报（旧版本）。starved=true
      // 表示"有排队且并发占满且最久排队超 2 分钟"——派发前值得先看一眼。
      queue: r.queue ?? null,
      // 执行后端 + 默认模型（提案 #27）：面板显示与派发前校验的依据。
      // null = 副机未上报或未配置默认模型。
      runnerKind: typeof r.runnerKind === 'string' ? r.runnerKind : null,
      defaultModel: r.defaultModel && typeof r.defaultModel === 'object' ? r.defaultModel : null,
      // 可用模型清单（提案 #27 面板下拉的数据源）。null = 副机未上报
      // （旧版本 / 探测还没完成 / 全部失败）—— 消费方据此退回自由文本。
      // 空数组是**权威事实**（"确实一个都没有"），与 null 语义不同。
      models: Array.isArray(r.models) ? r.models : null,
      // 仓库清单（提案 #13）：路由提示。remote_nodes 给名字列表供选型，
      // repo 路由细节在 pickNodeByRepo。
      repos: Array.isArray(r.repos) ? r.repos.map((x) => x.name) : [],
      reposAt: r.reposAt ?? null,
      transportMode: typeof r.hello?.transportMode === 'string' ? r.hello.transportMode : null,
    }))
  }

  // ─────────────────────────── 连接尝试历史 ───────────────────────────

  /**
   * 记一次连接尝试（2026-10-20，体验提升 ①）。
   *
   * @param {object} o
   * @param {'ok'|'fail'} o.result
   * @param {string} [o.code] 失败码（协议错误码 / errno / 'hello-timeout' 等）
   * @param {string} [o.message] 原始错误文案
   * @param {string} [o.nodeId] 若已知
   * @param {string} [o.remote] 远端地址（IP:port 或 IP）
   * @param {string} [o.transport] 'direct' | 'relay'
   */
  noteConnectionAttempt({ result, code = '', message = '', nodeId = '', remote = '', transport = '' } = {}) {
    try {
      const entry = {
        at: Date.now(),
        result: result === 'ok' ? 'ok' : 'fail',
        code: typeof code === 'string' ? code : '',
        message: typeof message === 'string' ? message.slice(0, 300) : '',
        nodeId: typeof nodeId === 'string' ? nodeId : '',
        remote: typeof remote === 'string' ? remote : '',
        transport: typeof transport === 'string' ? transport : '',
      }
      // 失败时附上人话解释（面板直接用，不用再翻译一遍）
      if (entry.result === 'fail') {
        try {
          const ex = this.explainErrorFn({ code: entry.code, message: entry.message }, { isHub: true, context: '副机接入' })
          entry.title = ex.title
          entry.detail = ex.detail
          entry.hint = ex.hint
        } catch {
          /* 翻译失败不影响记录 */
        }
      }
      this.connectionLog.push(entry)
      // 环形上限 50：这是诊断线索，不是审计
      if (this.connectionLog.length > 50) this.connectionLog.splice(0, this.connectionLog.length - 50)
    } catch {
      /* 诊断记录绝不能影响连接流程本身 */
    }
  }

  /**
   * 取连接尝试历史（新的在前）+ 每台已知节点的最后状态。
   *
   * @param {number} [limit]
   */
  connectionReport(limit = 20) {
    const recent = this.connectionLog.slice(-Math.max(1, limit)).reverse()
    // 按 nodeId 归并：每台机器最后一次尝试是什么结果
    const byNode = new Map()
    for (const e of this.connectionLog) {
      if (e.nodeId !== '') byNode.set(e.nodeId, e)
    }
    return {
      recent,
      byNode: [...byNode.entries()].map(([k, v]) => ({ nodeId: k, ...v })),
      // 有没有过任何成功的连接 —— 面板据此区分"从没连上过"与"连上又断了"
      everConnected: this.connectionLog.some((e) => e.result === 'ok'),
    }
  }

  // ─────────────────────────── 生命周期 ───────────────────────────

  markOffline(nodeId, reason) {
    const rec = this.nodes.get(nodeId)
    if (!rec) return
    // a node that is gone is not re-keyed; the schedule starts over when it comes back
    this.clearE2EHeal(nodeId)
    if (!rec.online && !rec.conn) return
    rec.online = false
    rec.lastSeen = Date.now()
    rec.conn = undefined
    this.publishPeerDirectory()
    this.log('info', 'node offline', { nodeId, reason })
    // 节点下线事件广播（供 ds-bot worker-bridge 订阅）
    try { this.emit('nodeOffline', { nodeId }) } catch {}
    // 断连时在途的产物分块必然残缺，直接失败掉，别让临时文件挂着
    this.pulls?.onNodeOffline?.(nodeId)
    // 在途的远程文件请求同样 fail-fast（提案 #25）：等不到 fs/res 就别挂调用方
    this.fsCancelForNode(nodeId)
    // 在途的工作区共享请求同样 fail-fast（2026-10-17）
    this.shareCancelForNode(nodeId)
  }

  startHeartbeat() {
    if (this.timer || this.closed) return
    // 下限 1000ms：心跳巡检没必要更密，避免在大量节点时打满定时器
    const ms = Math.max(1000, this.limits.heartbeatMs)
    this.timer = setInterval(() => this.tick(), ms)
    if (this.timer.unref) this.timer.unref()
  }

  /**
   * 一次心跳巡检。
   *
   * 两条路径都要有超时兜底（D7 修复）：
   *
   *   direct 模式（rec.conn 存在）：ping + 超时 conn.destroy()
   *
   *   relay 模式（rec.conn === undefined）：早期版本这里只靠"中继会发 node/offline"，
   *   但**中继自己死了就没人发** —— 实测 relay 整体死亡后 rec.online 永远为 true
   *   （+20s 仍 online:true），remote_nodes 报在线、remote_task 才失败，
   *   运维看到的是"节点在线但派不动活"。现在同样用 lastSeen 做超时判定。
   *
   * 公开方法（不只是内部回调），因为它是 C2-1/D7 的可测试入口。
   */
  tick() {
    if (this.closed) return
    const now = Date.now()
    for (const rec of this.nodes.values()) {
      if (!rec.online) continue
      const conn = rec.conn

      if (conn && !conn.closed) {
        try {
          conn.ping()
        } catch {
          /* 已断，close 事件会接手 */
        }
        if (now - rec.lastSeen > this.limits.heartbeatMs * 4) {
          this.log('warn', 'node heartbeat timeout', { nodeId: rec.nodeId, mode: 'direct' })
          try {
            conn.destroy(new Error('heartbeat timeout'))
          } catch {
            /* 已销毁 */
          }
        }
        continue
      }

      // relay 模式：没有专属 socket 可 ping，只能看 lastSeen。
      // 阈值放宽到 8 倍（direct 是 4 倍）：relay 的上行帧要经一跳，
      // 且节点侧 heartbeat 与中继转发都有各自的抖动，宁可晚判也不误杀。
      const relayTimeoutMs = this.limits.heartbeatMs * 8
      if (now - rec.lastSeen > relayTimeoutMs) {
        this.log('warn', 'node heartbeat timeout', {
          nodeId: rec.nodeId,
          mode: 'relay',
          silentMs: now - rec.lastSeen,
        })
        // 没有 socket 可 destroy，走与"节点主动断开"相同的下线路径，
        // 保证 tasks 投影保留（任务状态真身在副机）而 online 翻 false。
        try {
          this.markOffline(rec.nodeId, 'heartbeat timeout (relay)')
        } catch {
          /* 已被其他路径下线 */
        }
      }
    }
  }


  dispose() {
    this.peerRouter?.stop()
    this.peerTurnOrigins?.clear()
    if (this.closed) return
    this.closed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    for (const pending of [...this.pending]) {
      pending.done = true
      if (pending.timer) clearTimeout(pending.timer)
      try {
        pending.conn.close(1001, 'hub shutting down')
      } catch {
        /* 已断 */
      }
    }
    this.pending.clear()
    // 两阶段审批的自动拒绝定时器一并清掉（否则卸载后定时器还会触发）
    for (const timer of this.pendingApprovals.values()) clearTimeout(timer)
    this.pendingApprovals.clear()
    for (const nodeId of [...this.e2eHealState.keys()]) this.clearE2EHeal(nodeId)
    this.e2eOpenFailResetAt.clear()
    for (const rec of this.nodes.values()) {
      const conn = rec.conn
      rec.online = false
      rec.conn = undefined
      if (conn && !conn.closed) {
        try {
          conn.close(1001, 'hub shutting down')
        } catch {
          /* 已断 */
        }
      }
    }
    for (const t of this.tasks.values()) {
      for (const w of [...t.waiters]) w.fail(new RemoteAgentError('hub shutting down', 'aborted'))
      t.waiters.clear()
    }
    this.tasks.clear()
    // rec.tasks 用可选链：dispose 是清理路径，不该因为某个 rec 形状不全而抛错
    // 把整个卸载流程打断（那会让后面的 nodes.clear / relay.stop 都执行不到）。
    for (const rec of this.nodes.values()) rec.tasks?.clear?.()
    // 节点表也要清：卸载后不该再有任何引用挂着副机的主机名 / 工作区根。
    this.nodes.clear()
    try {
      this.relay?.stop()
    } catch {
      /* 已停 */
    }
    this.relay = null
    this.pulls = undefined
  }
}

export function withIngest(Base) {
  return class extends Base {
    // ─────────────────────────── 上行帧处理 ───────────────────────────

    /**
     * 记忆帧丢弃：整帧不写、不广播、不抛，只记一次 warn 并计数。
     * 冒充帧与坏帧都走这里 —— 审计需要的是「看到过一次」，不是每层各记一遍。
     */
    memoryDrop(nodeId, type, reason) {
      this.memoryDrops = this.memoryDrops ?? { oversize: 0, invalid: 0, identity: 0, e2e: 0 }
      this.memoryDrops[reason] = (this.memoryDrops[reason] ?? 0) + 1
      this.log('warn', 'memory frame dropped', { nodeId, type, reason })
    }

    /**
     * 上行文本帧分发。未知帧记日志忽略；任何异常都被吞掉。
     */
    handleFrameFor(nodeId, frame, meta = {}) {
      const rec = this.nodes.get(nodeId)
      if (rec) {
        rec.lastSeen = Date.now()
        if (rec.transport === 'direct' && !rec.conn && meta.conn) rec.conn = meta.conn
      } else if (frame.t !== NODE_TO_HUB.HELLO) {
        // 未知来源的上行帧（hub 重启后副机仍在跑）：登记一个"影子节点"，不丢任务视图
        this.log('warn', 'frame from unknown node', { nodeId, type: frame.t })
      }

      // E2E 解密（提案 #1）：带标记的帧先拆密再做业务分发。
      // 会话不存在（hub 重启后副机的连接还在、密钥已丢）→ 回 e2e-reset 让
      // 副机重新握手，本帧丢弃 —— 副机的遥测/仓库帧是周期性的，重协商
      // 最迟一个遥测周期内自动完成。
      let payload = frame.d
      if (payload && payload.e2e === E2E_MARKER) {
        if (!rec?.e2e) {
          this.log('warn', 'e2e frame without session, requesting re-key', { nodeId, type: frame.t })
          this.send(nodeId, HUB_TO_NODE.ERROR, { code: ERROR_CODE.E2E_RESET, message: 'e2e session unknown; please re-offer' })
          return
        }
        try {
          payload = rec.e2e.openFrame(frame.t, frame.id, payload)
        } catch (err) {
          // 认证失败 = 中间人伪造 / 实现错乱。丢这一帧并大声记录；
          // 不杀连接 —— 单帧失败不应放大成断连，连续伪造会在日志里显形。
          this.log('warn', 'e2e open failed, frame dropped', { nodeId, type: frame.t, error: errText(err) })
          this.resetAfterOpenFailure(nodeId)
          return
        }
      }
      const d = payload && typeof payload === 'object' ? payload : {}

      switch (frame.t) {
        case NODE_TO_HUB.HELLO:
          this.ingestHello({ helloData: d, conn: meta.conn, transport: meta.transport ?? 'direct', pending: undefined })
          return

        case NODE_TO_HUB.TASK_ACCEPT: {
          const t = this.ensureTask(nodeId, d.taskId)
          if (!t) return
          t.accepted = true
          t.acceptedAt = Date.now()
          t.duplicate = d.duplicate === true
          if (typeof d.status === 'string') t.status = d.status
          if (typeof d.workspace === 'string') t.workspace = d.workspace
          if (typeof d.runner === 'string') t.runner = d.runner
          t.updatedAt = Date.now()
          this.resolveWaiters(t)
          return
        }

        case NODE_TO_HUB.TASK_PROGRESS: {
          const t = this.ensureTask(nodeId, d.taskId)
          if (!t) return
          if (typeof d.status === 'string') t.status = d.status
          const entry = {
            phase: typeof d.phase === 'string' ? d.phase : 'progress',
            detail: typeof d.detail === 'string' ? d.detail : typeof d.command === 'string' ? d.command : undefined,
            at: typeof d.at === 'number' ? d.at : Date.now(),
          }
          t.progressTail.push(entry)
          if (t.progressTail.length > 20) t.progressTail.splice(0, t.progressTail.length - 20)
          t.updatedAt = Date.now()
          this.resolveWaiters(t)
          return
        }

        case NODE_TO_HUB.TASK_SUMMARY: {
          const t = this.ensureTask(nodeId, d.taskId)
          if (!t) return
          if (d.handoff && typeof d.handoff === 'object') {
            t.handoff = d.handoff
            // ⚠ 终态守卫（2026-10-17 修 v0.9.0 审查 L5）。
            //
            // 场景：approveTask 时 send 返回 false → 我们已把任务置成
            // FAILED(node-unreachable)，但那一帧其实在途 → 节点跑完回传
            // 真实终态。原实现无条件 `t.status = d.handoff.status`，会把
            // 已置的 FAILED 改写掉。
            //
            // 后果良性（记录反而更真实），但破坏"终态即终态"的心智模型，
            // 且让"批准者已收到 unreachable 错误、可能重派"的双跑风险更难察觉。
            //
            // 守卫规则：**已经是终态就不再被后来的帧改写**。
            // 例外：同一个终态值重复到达是幂等的，允许（无副作用）。
            const incoming = typeof d.handoff.status === 'string' ? d.handoff.status : ''
            if (incoming !== '' && (t.status === incoming || !TERMINAL_STATUS.has(t.status))) {
              t.status = incoming
            }
            if (Array.isArray(d.handoff.changed)) t.changed = d.handoff.changed
            if (d.handoff.summary && typeof d.handoff.summary === 'object') t.summary = d.handoff.summary
            if (d.handoff.exit && typeof d.handoff.exit === 'object') t.exit = d.handoff.exit
            if (typeof d.handoff.workspace === 'string') t.workspace = d.handoff.workspace
            const a = d.handoff.artifacts
            if (a && typeof a === 'object') {
              t.manifest = {
                counts: a.counts ?? null,
                bytesFinal: typeof a.bytesFinal === 'number' ? a.bytesFinal : 0,
                final: Array.isArray(a.final) ? a.final : [],
                intermediateCount: typeof a.intermediateCount === 'number' ? a.intermediateCount : 0,
                note: typeof a.note === 'string' ? a.note : '',
              }
            }
          }
          t.updatedAt = Date.now()
          this.resolveWaiters(t)
          return
        }

        case NODE_TO_HUB.TASK_END: {
          const t = this.ensureTask(nodeId, d.taskId)
          if (!t) return
          // ⚠ 终态守卫（2026-10-17 修 v0.9.0 审查 L5，与 TASK_SUMMARY 同款）：
          // 已是终态就不再被改写，除非到达的是**同一个**终态（幂等重发）。
          if (typeof d.status === 'string' && (t.status === d.status || !TERMINAL_STATUS.has(t.status))) {
            t.status = d.status
          }
          t.endedAt = typeof d.endedAt === 'number' ? d.endedAt : Date.now()
          if (typeof d.durationMs === 'number') t.durationMs = d.durationMs
          if (d.error && typeof d.error === 'object') t.error = d.error
          if (d.manifestCounts && typeof d.manifestCounts === 'object') t.manifestCounts = d.manifestCounts
          t.updatedAt = Date.now()
          this.log('info', 'task ended', { taskId: t.taskId, nodeId, status: t.status })
          // 任务终态事件广播（供 ds-bot worker-bridge 的 waitForTask 订阅）
          try { this.emit('taskEnd', { taskId: t.taskId, nodeId, status: t.status, exitCode: t.exit?.code, summary: t.summary?.text }) } catch {}
          this.resolveWaiters(t)
          return
        }

        case NODE_TO_HUB.TASK_SYNC:
          this.applySync(nodeId, d)
          return

        case NODE_TO_HUB.ARTIFACT_MANIFEST: {
          const t = this.ensureTask(nodeId, d.taskId)
          if (!t) return
          if (d.manifest && typeof d.manifest === 'object') t.manifest = d.manifest
          t.updatedAt = Date.now()
          return
        }

        case NODE_TO_HUB.ARTIFACT_DONE:
          // 允许副机把 done 走文本帧（正常走二进制帧，见 handleBinaryFor）
          this.pulls?.ingestDone?.(d)
          return

        case HUB_TO_NODE.PING: {
          // 副机的应用层心跳：回 pong，并顺手刷新 lastSeen（上面已做）
          this.send(nodeId, NODE_TO_HUB.PONG, { echo: frame.id })
          return
        }

        case NODE_TO_HUB.JOBS: {
          const checked = validateJobsFrame(payload)
          if (!checked.ok) {
            this.log('warn', 'jobs frame rejected', { nodeId, code: checked.error })
            return
          }
          if (!rec) return
          rec.jobs = checked.jobs.jobs
          rec.jobsAt = checked.jobs.at
          this.persistJobs()
          this.emit('jobs', { nodeId, ...checked.jobs })
          return
        }

        case NODE_TO_HUB.CONNECTIVITY:
          if (rec && payload && typeof payload === 'object' && !Array.isArray(payload)) rec.connectivity = { ...payload }
          return

        case NODE_TO_HUB.RESOURCE: {
          // 资源遥测（~30s 一次）：只更新 rec.resource，绝不影响任务链路。
          // 尽力而为的字段级校验：缺/类型不对就落 null —— 一个畸形遥测帧
          // 不能让节点记录缺胳膊少腿，更不能抛（单帧故障隔离不变式）。
          //
          // ⚠ `rec` 必须判空（2026-10-17 修）。未知节点（hub 重启后副机还没
          // 重连的"影子节点"竞态）发来 resource 帧 —— 30s 一次，**必然发生**：
          // `rec.resource = {...}` 对 undefined 抛 TypeError。外层 try/catch
          // 能兜住（不崩溃、不断连），但会打一条误导性 error 日志并丢一帧遥测。
          //
          // 同文件 REPOS 分支有 `if (rec)` 护栏 —— 同一份单帧隔离不变式，
          // 两个分支一个做一个漏。
          if (!rec) return
          const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
          rec.resource = {
            cpuPct: num(d.cpuPct),
            load1: num(d.load1),
            memUsedMb: num(d.memUsedMb),
            memTotalMb: num(d.memTotalMb),
            at: Date.now(),
          }
          // 资源遥测事件广播（供 ds-bot worker-bridge 负载均衡订阅）
          try { this.emit('nodeResource', { nodeId: rec.nodeId, cpu: rec.resource.cpuPct, mem: rec.resource.memUsedMb, taskCount: rec.tasks instanceof Map ? rec.tasks.size : 0 }) } catch {}
          // 队列健康快照（提案 #26-3，新副机随帧搭车）。旧副机不发 queue ——
          // 保留 rec.queue 原值（可能是 undefined），remote_nodes 按 null 展示。
          const q = d.queue && typeof d.queue === 'object' && !Array.isArray(d.queue) ? d.queue : null
          if (q) {
            rec.queue = {
              queued: num(q.queued) ?? 0,
              running: num(q.running) ?? 0,
              maxConcurrent: num(q.maxConcurrent) ?? 0,
              oldestQueuedMs: num(q.oldestQueuedMs) ?? 0,
              starved: q.starved === true,
            }
          }
          // 执行后端 + 默认模型（提案 #27）：面板显示与派发前校验的依据。
          // 每帧整体替换（副机是这一事实的权威）；旧副机不上报则保留原值。
          if (typeof d.runnerKind === 'string' && d.runnerKind !== '') rec.runnerKind = d.runnerKind.slice(0, 32)
          const dm = d.defaultModel && typeof d.defaultModel === 'object' && !Array.isArray(d.defaultModel) ? d.defaultModel : null
          if (dm && typeof dm.model === 'string' && dm.model !== '') {
            rec.defaultModel = {
              provider: typeof dm.provider === 'string' ? dm.provider.slice(0, 64) : '',
              model: dm.model.slice(0, 128),
            }
          } else {
            // 显式 null 是合法上报（副机没配默认模型）—— 清掉旧值避免误导
            if (d.defaultModel === null) rec.defaultModel = null
          }

          // 可用模型清单（提案 #27 面板下拉的数据源）。
          //
          // 与 defaultModel 一样是"副机自述"，但**整帧替换**的语义要更小心：
          //   · 副机上报 `models: null`（探测失败 / 还没探完）→ **保留旧值**，
          //     不要清空。否则一次网络抖动会让面板下拉退回自由文本，
          //     用户刚记住的选项突然消失。
          //   · 副机上报 `models: {models: [...]}` → 替换（含空数组：那是
          //     "确实一个都没有"的权威事实）。
          //
          // 字段级清洗 + 上限：一个畸形帧不能伤害注册表（单帧故障隔离不变式）。
          const rawModels = d.models && typeof d.models === 'object' && !Array.isArray(d.models) ? d.models : null
          if (rawModels) {
            const list = Array.isArray(rawModels.models) ? rawModels.models : []
            const cleaned = []
            for (const m of list.slice(0, MAX_NODE_MODELS)) {
              if (!m || typeof m !== 'object') continue
              const id = typeof m.id === 'string' ? m.id.trim() : ''
              if (id === '') continue
              // 思考等级跟模型一起过界（提案 #27 续）：不清洗就会在 hub 侧丢掉，
              // 主控的选择器只看到模型、看不到等级行。与 id 一样不信任对端：
              // 非对象/空 id 丢弃，超长截断，条数独立封顶。
              const efforts = []
              if (Array.isArray(m.efforts)) {
                for (const e of m.efforts.slice(0, MAX_NODE_EFFORTS)) {
                  if (!e || typeof e !== 'object') continue
                  const eid = typeof e.id === 'string' ? e.id.trim() : ''
                  if (eid === '') continue
                  efforts.push({
                    id: eid.slice(0, 64),
                    name: typeof e.name === 'string' && e.name.trim() !== '' ? e.name.slice(0, 128) : eid.slice(0, 128),
                  })
                }
              }
              const entry = {
                provider: typeof m.provider === 'string' ? m.provider.slice(0, 64) : '',
                id: id.slice(0, 128),
                name: typeof m.name === 'string' && m.name !== '' ? m.name.slice(0, 128) : id.slice(0, 128),
              }
              if (efforts.length > 0) entry.efforts = efforts
              cleaned.push(entry)
            }
            rec.models = cleaned
          }
          return
        }

        case NODE_TO_HUB.REPOS: {
          // 仓库清单（提案 #13）：整帧替换 rec.repos —— 清单是全量快照，
          // 不是增量。字段级清洗 + 数量/长度封顶，与遥测同一条不变式：
          // 一个畸形帧不能伤害注册表，更不能抛。节点下线后清单保留
          // （rec 是持久的），路由时靠 online 过滤，重连后副机会重报。
          // rec 为空（hub 重启后的影子节点）直接丢帧 —— 没有登记点可挂。
          const REPOS_CAP = 50
          const s = (v, cap) => (typeof v === 'string' ? v.slice(0, cap) : '')
          const list = Array.isArray(d.repos) ? d.repos : []
          if (rec) {
            rec.repos = []
            for (const r of list) {
              if (rec.repos.length >= REPOS_CAP) break
              if (!r || typeof r !== 'object') continue
              const name = s(r.name, 200)
              const url = s(r.url, 500)
              const p = s(r.path, 500)
              if (name === '' && url === '' && p === '') continue
              rec.repos.push({ name, url, path: p })
            }
            rec.reposAt = Date.now()
            this.log('info', 'node repos updated', { nodeId, count: rec.repos.length })
          }
          return
        }

        case NODE_TO_HUB.E2E_OFFER:
          // E2E 密钥交换提议（提案 #1）：握手职责在 registry-handshake（那里
          // 有身份密钥）。明文帧 —— 此时还没有任何共享密钥。
          this.handleE2EOffer(nodeId, d)
          return

        case NODE_TO_HUB.PONG:
          return

        case NODE_TO_HUB.FS_RES:
          // 远程文件响应（提案 #25）：按 replyTo 唤醒 hub 侧的 fsRequest 等待者。
          // 加密帧 —— fs 结果（目录结构 / 文件内容）不许明文过中继。
          this.handleFsRes(nodeId, d)
          return

        case NODE_TO_HUB.SHARE_RES:
          // 工作区共享响应（2026-10-17）：按 replyTo 唤醒 shareRequest 等待者。
          // 与 FS_RES 分开 —— 两张 pending 表不能混（混了会让超时归因变模糊）。
          this.handleShareRes(nodeId, d)
          return

        case NODE_TO_HUB.ROSTER: {
          // 副机 DS-Bot 名单。不进 hello，不在这里派活。
          // 身份以认证连接为准：载荷里的 nodeId 只当一致性声明。不一致就整帧丢掉，
          // 不做「用连接 id 覆盖」——覆盖会把冒充洗成合法数据，审计上也看不见。
          const claimed = typeof d.nodeId === 'string' ? d.nodeId.trim() : ''
          if (claimed !== '' && claimed !== nodeId) {
            this.log('warn', 'peer-node-mismatch', { connection: nodeId, claimed })
            return
          }
          try {
            const report = {
              nodeId,
              hostname: typeof d.hostname === 'string' ? d.hostname : '',
              bots: Array.isArray(d.bots) ? d.bots : [],
              online: true,
            }
            const skills = cleanRosterSkills(d.skills)
            if (skills !== undefined) report.skills = skills
            this.emit('roster', report)
          } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.TEAM_ACT: {
          // A node Bot asks the hub to run a team-management tool for it; the host decides.
          let act
          try { act = validateTeamAct(d) } catch { return }
          if (act.actor.nodeId !== nodeId) {
            this.log('warn', 'peer-node-mismatch', { connection: nodeId, claimed: act.actor.nodeId, frame: frame.t })
            return
          }
          try { this.emit('teamAct', { ...act, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_ASSIGN: {
          // Bot-to-Bot delivery across machines. The hub only carries it: to its own host, on to the
          // target node, or back to the sender as a bounce when the target node is not connected.
          let assign
          try { assign = validateBotAssign(d) } catch { return }
          if (assign.from.nodeId !== nodeId) {
            this.log('warn', 'peer-node-mismatch', { connection: nodeId, claimed: assign.from.nodeId, frame: frame.t })
            return
          }
          // Every hop is on record (audit) and told to the host, so the hub can show node-to-node exchanges it carries.
          const relayed = (outcome) => {
            try {
              this.auditRecord?.('bot.assign', {
                op: assign.op, frameId: assign.frameId, outcome,
                from: `${assign.from.nodeId}/${assign.from.name}`, to: `${assign.to.nodeId}/${assign.to.name}`,
                ...(assign.op === 'deliver' ? { role: assign.role, exchangeId: assign.exchangeId, chars: assign.text.length } : {}),
              })
            } catch { /* audit is best effort */ }
            try { this.emit('botAssignRelayed', { frame: assign, outcome }) } catch { /* a listener must not take the ingest path down */ }
          }
          if (assign.to.nodeId === 'hub') {
            relayed('to-hub')
            try { this.emit('botAssign', assign) } catch { /* a listener must not take the ingest path down */ }
            return
          }
          if (this.nodes.get(assign.to.nodeId)?.online) {
            const sent = this.send(assign.to.nodeId, HUB_TO_NODE.BOT_ASSIGN, assign)
            relayed(sent === false ? 'send-failed' : 'forwarded')
            return
          }
          relayed('target-offline')
          if (assign.op === 'deliver') {
            this.send(nodeId, HUB_TO_NODE.BOT_ASSIGN, { op: 'bounce', frameId: assign.frameId, from: assign.to, to: assign.from, reason: 'offline', at: Date.now() })
          }
          return
        }

        case NODE_TO_HUB.BOT_MESSAGE: {
          let message
          try { message = validateBotMessage(d) } catch { return }
          if (message.from.nodeId !== nodeId) {
            this.log('warn', 'peer-node-mismatch', { connection: nodeId, claimed: message.from.nodeId, frame: frame.t })
            return
          }
          try { this.emit('botMessage', message) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case HUB_TO_NODE.BOT_TURN: {
          // Only opted-in peers originate node-to-node turns; hub remains the fallback router.
          if (!rec?.hello?.peerUrl || !rec.online) return
          const checked = validateBotTurn(d)
          if (!checked.ok || !this.nodes.get(checked.turn.nodeId)?.online) return
          this.peerTurnOrigins ??= new Map()
          for (const [key, origin] of this.peerTurnOrigins) if (Date.now() - origin.at >= 300_000) this.peerTurnOrigins.delete(key)
          const key = JSON.stringify([checked.turn.nodeId, checked.turn.exchangeId])
          const previous = this.peerTurnOrigins.get(key)
          if (previous && previous.nodeId !== nodeId) return
          if (this.peerTurnOrigins.size >= 512) this.peerTurnOrigins.delete(this.peerTurnOrigins.keys().next().value)
          this.peerTurnOrigins.set(key, { nodeId, at: Date.now() })
          this.send(checked.turn.nodeId, HUB_TO_NODE.BOT_TURN, checked.turn)
          return
        }

        case NODE_TO_HUB.BOT_TURN_RESULT: {
          const checked = validateBotTurnResult(d)
          if (!checked.ok) return
          // 回合结果同样必须落在认证连接名下；冒名帧整帧丢弃，不改写。
          if (checked.result.nodeId !== nodeId) {
            this.log('warn', 'peer-node-mismatch', { connection: nodeId, claimed: checked.result.nodeId, frame: 'bot/turn-result' })
            return
          }
          if (rec?.hello?.peerUrl) {
            const origin = this.peerTurnOrigins?.get(JSON.stringify([nodeId, checked.result.exchangeId]))
            const target = typeof d.peerReplyTo === 'string' ? d.peerReplyTo
              : origin && Date.now() - origin.at < 300_000 ? origin.nodeId : ''
            if (target && this.nodes.get(target)?.hello?.peerUrl && this.nodes.get(target)?.online) {
              this.send(target, NODE_TO_HUB.BOT_TURN_RESULT, checked.result)
              return
            }
          }
          try { this.emit('botTurnResult', { ...checked.result, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_TRACE: {
          // 节点 Bot 的思考过程与工具步骤（bot-trace/1）。只是页面的附加显示：坏帧不让回合失败，
          // 只记 warn 与审计；真正的权威是 bot/turn-result 的文本，trace 缺了页面照样有答案。
          const checked = validateBotTrace(d)
          if (!checked.ok) {
            this.log?.('warn', 'bot/trace rejected', { nodeId, error: checked.error })
            return
          }
          const trace = checked.trace
          // 与回合结果同口径：必须落在认证连接名下，冒名帧整帧丢弃。
          if (trace.nodeId !== nodeId) {
            this.log('warn', 'peer-node-mismatch', { connection: nodeId, claimed: trace.nodeId, frame: 'bot/trace' })
            return
          }
          // 原样重放（同一帧发了两次）只算一次。key 带上条数与末尾序号：节点重启后同一 exchangeId
          // 重新从 seq 1 开始，内容不同的帧不会被误当成重放。ds-bot 另按步骤序号 i 去重，这里只是省一次投递。
          this.traceSeen ??= new Set()
          const seenKey = `${nodeId}\u0000${trace.exchangeId}\u0000${trace.seq}\u0000${trace.final === true ? 'f' : ''}\u0000${trace.items.length}\u0000${trace.items.at(-1)?.i ?? 0}`
          if (this.traceSeen.has(seenKey)) return
          if (this.traceSeen.size >= 4096) this.traceSeen.delete(this.traceSeen.values().next().value)
          this.traceSeen.add(seenKey)
          try { this.emit('botTrace', { ...trace, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_CREATE_RESULT: {
          const checked = validateBotCreateResult(d)
          if (!checked.ok) return
          try { this.emit('botCreateResult', checked.result) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_HISTORY_RESULT: {
          const checked = validateBotHistoryResult(d)
          if (!checked.ok) return
          try { this.emit('botHistoryResult', checked.result) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_UPDATE_RESULT: {
          const checked = validateBotUpdateResult(d)
          if (!checked.ok) return
          try { this.emit('botUpdateResult', checked.result) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_DELETE_RESULT: {
          const checked = validateBotDeleteResult(d)
          if (!checked.ok) return
          try { this.emit('botDeleteResult', checked.result) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_ACTION_RESULT: {
          const checked = validateBotActionResult(d)
          if (!checked.ok) return
          try { this.emit('botActionResult', { ...checked.result, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_STOP_RESULT: {
          const checked = validateBotStopResult(d)
          if (!checked.ok) return
          try { this.emit('botStopResult', checked.result) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.NODE_CONFIG_RESULT: {
          // 并发上限回执。nodeId 以认证过的连接身份为准，不信任载荷自述。
          const checked = validateNodeConfigResult(d)
          if (!checked.ok) return
          try { this.emit('nodeConfigResult', { ...checked.result, nodeId }) } catch { /* must not take ingest down */ }
          return
        }

        case MEMORY.HELLO: {
          // 记忆通道上线：只带已应用 seq，不带任何正文。
          if (memoryFrameBytes(d) > MAX_MEMORY_FRAME_BYTES) { this.memoryDrop(nodeId, frame.t, 'oversize'); return }
          const claimed = typeof d.nodeId === 'string' ? d.nodeId.trim() : ''
          if (claimed !== '' && claimed !== nodeId) { this.memoryDrop(nodeId, frame.t, 'identity'); return }
          const appliedSeq = Number.isInteger(d.appliedSeq) && d.appliedSeq >= 0 ? d.appliedSeq : 0
          try { this.emit('memoryHello', { nodeId, appliedSeq }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case MEMORY.READ: {
          if (memoryFrameBytes(d) > MAX_MEMORY_FRAME_BYTES) { this.memoryDrop(nodeId, frame.t, 'oversize'); return }
          const checked = validateMemRead(d)
          if (checked === null) { this.memoryDrop(nodeId, frame.t, 'invalid'); return }
          // 连接身份是唯一可信来源；载荷自称的 nodeId 不一致就整帧丢。
          const claimed = typeof d.nodeId === 'string' ? d.nodeId.trim() : ''
          if (claimed !== '' && claimed !== nodeId) { this.memoryDrop(nodeId, frame.t, 'identity'); return }
          if (!rec?.e2e) { this.memoryDrop(nodeId, frame.t, 'e2e'); return }
          try { this.emit('memoryRead', { ...checked, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case MEMORY.WRITE: {
          if (memoryFrameBytes(d) > MAX_MEMORY_FRAME_BYTES) { this.memoryDrop(nodeId, frame.t, 'oversize'); return }
          const checked = validateMemWrite(d)
          if (checked === null) { this.memoryDrop(nodeId, frame.t, 'invalid'); return }
          const claimed = typeof d.nodeId === 'string' ? d.nodeId.trim() : ''
          if (claimed !== '' && claimed !== nodeId) { this.memoryDrop(nodeId, frame.t, 'identity'); return }
          if (!rec?.e2e) { this.memoryDrop(nodeId, frame.t, 'e2e'); return }
          try { this.emit('memoryWrite', { ...checked, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case MEMORY.ACK: {
          if (memoryFrameBytes(d) > MAX_MEMORY_FRAME_BYTES) { this.memoryDrop(nodeId, frame.t, 'oversize'); return }
          const checked = validateMemAck(d)
          if (checked === null) { this.memoryDrop(nodeId, frame.t, 'invalid'); return }
          const claimed = typeof d.nodeId === 'string' ? d.nodeId.trim() : ''
          if (claimed !== '' && claimed !== nodeId) { this.memoryDrop(nodeId, frame.t, 'identity'); return }
          try { this.emit('memoryAck', { seq: checked.seq, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.CONFIG_SYNC_REQUEST: {
          // M2：节点重连后上报已应用 revision，hub 检查是否需要推送全量配置。
          const nodeRevision = Number.isInteger(d?.appliedRevision) ? d.appliedRevision : 0
          try { this.emit('configSyncRequest', { nodeId, appliedRevision: nodeRevision }) } catch { /* must not take ingest down */ }
          return
        }

        case NODE_TO_HUB.CONFIG_ACK: {
          // M2：节点回执配置应用结果。
          // the authenticated node id goes last: a frame field of the same name must not override it
          try { this.emit('configAck', { ...d, nodeId }) } catch { /* must not take ingest down */ }
          return
        }

        case NODE_TO_HUB.ERROR:
          this.log('warn', 'node reported error', { nodeId, code: d.code, taskId: d.taskId })
          if (d.code === ERROR_CODE.E2E_REQUIRED) {
            // 副机在会话已建立后收到明文业务帧才会报这个错 —— 典型成因是
            // hub 侧丢了会话（重启）。让副机重新走一次握手（它还握着旧会话，
            // 但 hub 这边已经没有了）。
            this.send(nodeId, HUB_TO_NODE.ERROR, { code: ERROR_CODE.E2E_RESET, message: 'hub lost e2e session; please re-offer' })
          }
          if (d.taskId) {
            const t = this.tasks.get(d.taskId)
            if (t) {
              t.error = { code: d.code ?? 'node-error', message: d.message ?? '' }
              t.updatedAt = Date.now()
              this.resolveWaiters(t)
            }
          }
          return

        default:
          this.log('info', 'unknown frame ignored', { nodeId, type: String(frame.t) })
      }
    }

    /** 二进制上行帧：产物分块 / 完成帧交给 PullManager。 */
    handleBinaryFor(nodeId, header, payload, meta = {}) {
      // E2E 解密（提案 #1）：带标记的先拆密。外层 header 只留 t/seq/iv，
      // pullId/offset/sha256 等都在内层密文里 —— 中继看不到文件名与完整性字段。
      let hdr = header
      let pl = payload
      if (header && header.e2e === E2E_MARKER) {
        const rec = this.nodes.get(nodeId)
        if (!rec?.e2e) {
          this.log('warn', 'e2e binary frame without session, dropped', { nodeId, type: header.t })
          this.send(nodeId, HUB_TO_NODE.ERROR, { code: ERROR_CODE.E2E_RESET, message: 'e2e session unknown; please re-offer' })
          return
        }
        try {
          const opened = rec.e2e.openBinary(header.t, header, payload)
          hdr = opened.header
          pl = opened.payload
        } catch (err) {
          this.log('warn', 'e2e binary open failed, frame dropped', { nodeId, type: header.t, error: errText(err) })
          return
        }
      }
      const type = hdr?.t
      if (type === NODE_TO_HUB.ARTIFACT_CHUNK) {
        this.pulls?.ingestBinary?.(hdr, pl, { conn: meta.conn })
        return
      }
      if (type === NODE_TO_HUB.ARTIFACT_DONE) {
        this.pulls?.ingestDone?.(hdr)
        return
      }
      this.log('info', 'unknown binary frame ignored', { nodeId, type: String(type) })
    }

    /**
     * task/sync：副机的**全量**任务列表 → 重建该节点视图。
     * 列表里没有的、且不是"刚派出去还在途"的任务，从 hub 视图里移除。
     */
    applySync(nodeId, d) {
      const rec = this.nodes.get(nodeId)
      if (!rec) return
      const list = Array.isArray(d?.tasks) ? d.tasks : null
      if (!list) {
        this.log('warn', 'task/sync without tasks[]', { nodeId })
        return
      }
      const seen = new Set()
      for (const view of list) {
        if (!view || typeof view.taskId !== 'string') continue
        seen.add(view.taskId)
        const t = this.ensureTask(nodeId, view.taskId)
        if (!t) continue
        this.applyView(t, view)
      }
      for (const [taskId, t] of [...rec.tasks]) {
        if (seen.has(taskId)) continue
        // 审批挂起中的任务从未到过副机（提案 #2）：它本来就不会出现在
        // sync 里，宽限期逻辑不适用 —— 绝不能因为 sync 里没有就被清掉。
        if (t.status === TASK_STATUS.PENDING_APPROVAL) continue
        // 宽限期只给"本 hub 派出去、还没等到 accept"的任务 —— 它可能正在路上。
        // 副机上报过（adopted）却不再出现在 sync 里的任务，说明副机那边已经没有了，
        // 以副机为权威直接移除；否则幽灵任务会一直挂在 hub 视图里。
        if (t.adopted !== true && t.accepted !== true && Date.now() - t.createdAt < this.limits.ackTimeoutMs) continue
        rec.tasks.delete(taskId)
        if (this.tasks.get(taskId) === t) this.tasks.delete(taskId)
      }

      // ── 顺手做一次自动清理（防视图无限累积）────────────────────────────
      //
      // 副机的 TaskStore 默认保留 7 天，所以它会在 sync 里**持续上报**这些终态
      // 任务 —— 上面那个"不在 sync 里就删"的循环因此不会清理它们。hub 视图
      // 一路累积到 `maxTasksPerNode`，然后**任何新任务都被拒**（实测踩到，
      // 连"派一条清理命令"都做不到）。
      //
      // 所以这里主动清：**终态 + 已上报 + 超过保留期**的视图。条件是保守的 ——
      // 只看超过 retainMs 的，刚结束的任务仍可被 remote_status / remote_handoff
      // 查到（那是用户最需要看结果的时候）。
      //
      // 想立即清（不等保留期）用 `remote_purge`。
      const retainMs = this.limits.taskViewRetainMs
      if (retainMs > 0) {
        const cutoff = Date.now() - retainMs
        let pruned = 0
        for (const [taskId, t] of [...rec.tasks]) {
          if (!TERMINAL_STATUS.has(t.status)) continue
          const endedAt = numOr(t.endedAt, 0) || numOr(t.updatedAt, 0) || numOr(t.createdAt, 0)
          if (endedAt >= cutoff) continue
          rec.tasks.delete(taskId)
          if (this.tasks.get(taskId) === t) this.tasks.delete(taskId)
          pruned += 1
        }
        if (pruned > 0) {
          this.log('info', 'pruned old task views', { nodeId, pruned, retainMs })
        }
      }

      this.log('info', 'node task view rebuilt from sync', { nodeId, count: seen.size })
    }

    applyView(t, view) {
      const strFields = ['status', 'mode', 'goal', 'workspace', 'sessionId']
      for (const f of strFields) {
        if (typeof view[f] === 'string') t[f] = view[f]
      }
      const numFields = ['createdAt', 'updatedAt', 'startedAt', 'endedAt', 'durationMs']
      for (const f of numFields) {
        if (typeof view[f] === 'number') t[f] = view[f]
      }
      if (view.exit && typeof view.exit === 'object') t.exit = view.exit
      if (Array.isArray(view.changed)) t.changed = view.changed
      if (view.error && typeof view.error === 'object') t.error = view.error
      if (view.summary && typeof view.summary === 'object') t.summary = view.summary
      if (view.manifestCounts && typeof view.manifestCounts === 'object') t.manifestCounts = view.manifestCounts
      if (Array.isArray(view.progressTail)) t.progressTail = view.progressTail.slice(-20)
      if (Array.isArray(view.logTail)) t.logTail = view.logTail.slice(-40)
      t.viewUpdatedAt = Date.now()
      this.resolveWaiters(t)
    }
  }
}



export function withHandshake(Base) {
  return class extends Base {
    // ─────────────────────────── 连接接入 ───────────────────────────

    /**
     * 接管一条刚 upgrade 完的直连 socket。
     * 第一帧必须是 hello；超时未收到就拒绝并关闭。
     */
    attachDirect(conn, meta = {}) {
      const pending = { conn, remote: meta.remote ?? '', nodeId: '', timer: undefined, done: false }
      this.pending.add(pending)
      pending.timer = setTimeout(() => {
        if (pending.done) return
        pending.done = true
        this.pending.delete(pending)
        this.log('warn', 'hello timeout', { remote: pending.remote })
        this.rejectConn(conn, 'hello-timeout', 'hello frame required as the first frame')
      }, this.limits.helloTimeoutMs)
      if (pending.timer.unref) pending.timer.unref()

      conn.on('message', (payload, isBinary) => {
        try {
          if (isBinary) {
            this.onDirectBinary(pending, payload)
            return
          }
          const dec = decodeFrame(payload)
          if (!dec.ok) {
            this.log('warn', 'node frame undecodable', { error: dec.error, remote: pending.remote })
            return
          }
          this.onDirectFrame(pending, dec.frame)
        } catch (err) {
          this.log('error', 'node frame handler failed', { error: errText(err) })
        }
      })

      const onGone = (reason) => {
        pending.done = true
        if (pending.timer) clearTimeout(pending.timer)
        this.pending.delete(pending)
        const nodeId = pending.nodeId
        if (nodeId) {
          const rec = this.nodes.get(nodeId)
          // 只有"当前生效的那条连接"断开才算掉线（重复实例被拒后断开不算）
          if (rec && rec.conn === conn) this.markOffline(nodeId, reason)
        }
        this.log('info', 'node socket closed', { nodeId: nodeId || undefined, reason })
      }

      conn.on('close', (code, reason) => onGone(`socket closed ${code}${reason ? `: ${reason}` : ''}`))

      // 对端硬断（FIN 无 close 帧）由冻结层统一处理：ws.js 的 WSConnection 构造时
      // 就挂了 `socket.on('end')` → finish(1006) + destroy，所以这里只监听 conn 的
      // 'close' 即可，半关闭不会漏掉下线、fd 也已释放。
      // **不要**再补一层 conn.socket.on('end') 兜底 —— 对端干净 FIN 时同一个事件会
      // 走两遍 onGone，日志里 'node socket closed' 打两条。

      conn.on('error', (err) => this.log('warn', 'node socket error', { error: errText(err) }))
    }

    /** 绑定中继链路：上行帧由中继转发，下行帧靠 header.to / frame.to 路由。 */
    attachRelay(link) {
      this.relay = link
    }

    onDirectFrame(pending, frame) {
      if (!pending.nodeId) {
        if (frame.t !== NODE_TO_HUB.HELLO) {
          this.rejectConn(pending.conn, 'hello-required', `expected hello, got ${frame.t}`)
          return
        }
        this.ingestHello({
          helloData: frame.d,
          conn: pending.conn,
          transport: 'direct',
          pending,
        })
        return
      }
      this.handleFrameFor(pending.nodeId, frame, { conn: pending.conn, transport: 'direct' })
    }

    onDirectBinary(pending, payload) {
      if (!pending.nodeId) {
        this.log('warn', 'binary frame before hello, dropped', { remote: pending.remote })
        return
      }
      const dec = decodeBinaryFrame(payload)
      if (!dec.ok) {
        this.log('warn', 'binary frame undecodable', { error: dec.error })
        return
      }
      this.handleBinaryFor(pending.nodeId, dec.header, dec.payload, { conn: pending.conn })
    }

    /** 中继上行文本帧：中继已把来源写在 frame.from。 */
    handleRelayFrame(frame) {
      try {
        if (frame.t === RELAY_FRAME.HELLO_HUB || frame.t === RELAY_FRAME.NODE_LIST) {
          const list = Array.isArray(frame.d?.nodes) ? frame.d.nodes : []
          for (const summary of list) this.adoptRelaySummary(summary)
          this.log('info', 'relay node directory received', { count: list.length })
          return
        }
        if (frame.t === RELAY_FRAME.NODE_ONLINE) {
          this.adoptRelaySummary(frame.d?.node)
          return
        }
        if (frame.t === RELAY_FRAME.NODE_OFFLINE) {
          const nodeId = frame.d?.nodeId
          if (typeof nodeId === 'string') this.markOffline(nodeId, `relay: ${frame.d?.reason ?? 'offline'}`)
          return
        }
        if (frame.t === RELAY_FRAME.ERROR) {
          this.log('warn', 'relay reported error', { code: frame.d?.code, nodeId: frame.d?.nodeId })
          return
        }
        const from = typeof frame.from === 'string' ? frame.from : ''
        if (from === '') {
          this.log('warn', 'relay frame without source node', { type: frame.t })
          return
        }
        this.handleFrameFor(from, frame, { transport: 'relay' })
      } catch (err) {
        this.log('error', 'relay frame handler failed', { error: errText(err) })
      }
    }

    /** 中继上行二进制帧：来源在 header.from。 */
    handleRelayBinary(header, payload) {
      try {
        const from = typeof header?.from === 'string' ? header.from : ''
        if (from === '') {
          this.log('warn', 'relay binary frame without source node')
          return
        }
        this.handleBinaryFor(from, header, payload, { transport: 'relay' })
      } catch (err) {
        this.log('error', 'relay binary handler failed', { error: errText(err) })
      }
    }

    /**
     * 中继模式下 hub 看不到副机的 hello 帧（中继自己消费了 hello/node），
     * 只广播节点摘要。这里用摘要补一个等价 hello，让上层视图保持一致。
     */
    adoptRelaySummary(summary) {
      if (!summary || typeof summary !== 'object') return
      if (typeof summary.nodeId !== 'string') return
      this.ingestHello({
        helloData: { ...summary, protocol: summary.protocol ?? PROTOCOL_VERSION },
        conn: undefined,
        transport: 'relay',
        pending: undefined,
      })
    }

    /**
     * 处理 hello：校验 → 同 id 冲突判定 → 登记 / 回 welcome。
     */
    ingestHello({ helloData, conn, transport, pending }) {
      const v = validateHello(helloData)
      if (!v.ok) {
        const code = v.error === ERROR_CODE.PROTOCOL_MISMATCH ? ERROR_CODE.PROTOCOL_MISMATCH : 'hello-invalid'
        this.log('warn', 'hello rejected', { reason: v.error, transport })
        if (transport === 'direct') this.rejectConn(conn, code, `invalid hello: ${v.error}`)
        else this.send(helloData?.nodeId, HUB_TO_NODE.ERROR, { code, message: `invalid hello: ${v.error}` })
        this.finishPending(pending)
        return undefined
      }

      const hello = v.hello
      const existing = this.nodes.get(hello.nodeId)
      // 同 id 第二实例：拒掉新连接，保住已经在跑的那个（任务不能被打断）
      if (existing && existing.online && existing.conn && existing.conn !== conn && !existing.conn.closed) {
        this.log('warn', 'duplicate node rejected', { nodeId: hello.nodeId, transport })
        if (transport === 'direct') {
          this.rejectConn(conn, ERROR_CODE.DUPLICATE_NODE, 'another live connection owns this nodeId', hello.nodeId)
        } else {
          this.send(hello.nodeId, HUB_TO_NODE.ERROR, {
            code: ERROR_CODE.DUPLICATE_NODE,
            message: 'another live connection owns this nodeId',
            nodeId: hello.nodeId,
          })
        }
        this.finishPending(pending)
        return undefined
      }

      const rec = existing ?? {
        nodeId: hello.nodeId,
        hello,
        online: false,
        transport,
        since: Date.now(),
        lastSeen: Date.now(),
        conn: undefined,
        tasks: new Map(),
        pendingPulls: new Map(),
      }
      if (!existing) {
        rec.since = Date.now()
        this.nodes.set(hello.nodeId, rec)
      }
      rec.hello = hello
      rec.transport = transport
      rec.online = true
      rec.lastSeen = Date.now()
      rec.conn = transport === 'direct' ? conn : undefined
      if (hello.peerUrl && !rec.peerSecret) rec.peerSecret = randomBytes(32).toString('hex')
      this.finishPending(pending, hello.nodeId)

      if (transport === 'direct') this.sendWelcome(rec)
      else this.sendIdentityFrame(rec) // relay：hub 在握手期对副机静默，身份帧必须在上线后追发
      this.publishPeerDirectory()
      // 记一次成功的连接尝试（2026-10-20，体验提升 ①）——
      // 面板据此区分"从没连上过"与"连上又断了"，这是排查方向的分水岭。
      try {
        this.noteConnectionAttempt({
          result: 'ok',
          nodeId: hello.nodeId,
          remote: remoteOf(conn),
          transport,
        })
      } catch {
        /* 诊断记录绝不能影响上线流程 */
      }
      this.log('info', 'node online', { nodeId: hello.nodeId, os: hello.os, transport })
      // Let a hub plugin re-apply per-node settings (e.g. the task concurrency the
      // user saved) without waiting for the next manual action.
      try { this.emit('nodeOnline', { nodeId: hello.nodeId, transport }) } catch {}
      this.scheduleE2EHeal(hello.nodeId)
      return rec
    }

    /**
     * fork.63: an online node without an e2e session gets an e2e-reset, which makes it offer.
     *
     * Until now only the node started the handshake (on its own connect, or after the hub answered
     * one of its sealed frames with a reset). A hub that restarted while the node kept its relay
     * connection therefore stayed without a session for as long as the node had nothing sealed to
     * say. Attempts follow e2e-heal.js (2/4/8/16/30s, capped); the first one waits long enough for
     * a node that is connecting right now to offer by itself.
     *
     * Called on every hello / directory entry, so a repeat must not restart the schedule: while a
     * schedule exists (running or exhausted) it is left alone. It ends when the session exists,
     * when the node goes offline, or when the hub is disposed.
     */
    scheduleE2EHeal(nodeId) {
      const cfg = this.e2eHealCfg
      const rec = this.nodes.get(nodeId)
      if (this.closed || cfg.maxAttempts === 0 || !this.identity) return
      if (!rec || !rec.online || rec.e2e) return
      if (this.e2eHealState.has(nodeId)) return
      const state = { attempts: 0, waits: 0, timer: undefined }
      this.e2eHealState.set(nodeId, state)
      this.armE2EHeal(nodeId, state)
    }

    armE2EHeal(nodeId, state) {
      state.waits += 1
      state.timer = setTimeout(() => this.fireE2EHeal(nodeId), e2eHealDelayMs(state.waits, this.e2eHealCfg))
      if (state.timer.unref) state.timer.unref()
    }

    fireE2EHeal(nodeId) {
      const state = this.e2eHealState.get(nodeId)
      if (!state) return
      state.timer = undefined
      const rec = this.nodes.get(nodeId)
      if (this.closed || !rec || !rec.online || rec.e2e || !this.identity) {
        this.clearE2EHeal(nodeId)
        return
      }
      // Only attempts that really left the hub count against the cap (the relay link may be down).
      const sent = this.send(nodeId, HUB_TO_NODE.ERROR, { code: ERROR_CODE.E2E_RESET, message: 'e2e session missing; please offer' })
      if (sent !== false) state.attempts += 1
      if (state.attempts === 1 && sent !== false) this.log('info', 'e2e heal: asking node to offer', { nodeId })
      if (state.attempts >= this.e2eHealCfg.maxAttempts) {
        this.log('info', 'e2e heal: attempts used up, leaving it to the node', { nodeId, attempts: state.attempts })
        return // schedule stays as a marker so a repeated directory does not start it again
      }
      this.armE2EHeal(nodeId, state)
    }

    clearE2EHeal(nodeId) {
      const state = this.e2eHealState.get(nodeId)
      if (!state) return
      if (state.timer) clearTimeout(state.timer)
      this.e2eHealState.delete(nodeId)
    }

    /**
     * fork.63: a frame the hub cannot open (keys out of step) used to be dropped in silence, for
     * as long as the node kept sending — 228 lines in one real incident, healed only by restarting
     * the master. Ask the node to re-key, at most once per node per resetMinMs.
     */
    resetAfterOpenFailure(nodeId) {
      const now = Date.now()
      const last = this.e2eOpenFailResetAt.get(nodeId) ?? -Infinity
      if (this.closed || now - last < this.e2eHealCfg.resetMinMs) return false
      this.e2eOpenFailResetAt.set(nodeId, now)
      return this.send(nodeId, HUB_TO_NODE.ERROR, { code: ERROR_CODE.E2E_RESET, message: 'e2e frame could not be opened; please re-offer' }) !== false
    }

    finishPending(pending, nodeId) {
      if (!pending || pending.done) return
      pending.done = true
      if (pending.timer) clearTimeout(pending.timer)
      this.pending.delete(pending)
      if (nodeId) pending.nodeId = nodeId
    }

    /** welcome 里带 config 限制，让副机知道自己该守什么；P2-11 起再带一帧身份证明。 */
    sendWelcome(rec) {
      const data = {
        protocol: PROTOCOL_VERSION,
        nodeId: rec.nodeId,
        limits: {
          heartbeatMs: this.limits.heartbeatMs,
          ackTimeoutMs: this.limits.ackTimeoutMs,
          pullTimeoutMs: this.limits.pullTimeoutMs,
          maxPullBytes: this.limits.maxPullBytes,
          maxTasksPerNode: this.limits.maxTasksPerNode,
        },
        serverTime: Date.now(),
        // M4：能力宣告。节点据此决定要不要发 mem/*（旧 hub 没有这一项，
        // 节点一个记忆帧都不发）。
        caps: [...HUB_CAPS],
      }
      // 身份证明放在 welcome 里：副机在 markOnline **之前**先验 hub，
      // 验不过连上线资格都没有（副机侧 transport.js 负责拒绝）。
      const identity = this.buildIdentityPayload(rec)
      if (identity) data.identity = identity
      if (rec.hello?.peerUrl) data.peerSecret = rec.peerSecret
      this.send(rec.nodeId, HUB_TO_NODE.WELCOME, data)
    }

    /**
     * 构造 hub 身份证明载荷（P2-11）。
     *
     * nonce 优先用副机 hello 里带来的 —— hub 对"本次连接"签名，副机核对一致
     * 即可确认这不是重放的旧帧。旧版副机 / 中继摘要不带 nonce 时自拟一个，
     * 副机退化为只靠 ±5min 时间窗（主防线仍是 pin 匹配）。
     *
     * 签名失败（私钥坏）返回 undefined：welcome 不带 identity，绝不抛 ——
     * 身份子系统故障不能拖垮接入路径。
     */
    buildIdentityPayload(rec) {
      if (!this.identity) return undefined
      const nonce = typeof rec?.hello?.nonce === 'string' && rec.hello.nonce !== '' ? rec.hello.nonce : newNonce()
      const at = Date.now()
      let sig
      try {
        sig = signIdentity(this.identity.privateKeyB64, {
          fingerprint: this.identity.fingerprint,
          nodeId: rec.nodeId,
          nonce,
          at,
        })
      } catch (err) {
        this.log('warn', 'hub identity sign failed', { error: errText(err) })
        return undefined
      }
      return { fp: this.identity.fingerprint, pub: this.identity.publicKeyB64, sig, at, nonce }
    }

    /**
     * relay 模式追发身份帧（P2-11）。
     *
     * relay 模式下副机的"在线"信号是中继的 hello/node accepted，hub 在握手期
     * 对副机**完全静默** —— 假中继正是利用这个空窗冒充 hub 下发任务。所以
     * 节点一经登记，hub 立刻经中继补一帧 hub/identity。链路未就绪时帧会丢，
     * 靠两条既有路径自愈：hub 与中继重连后 requestNodeList 会重播节点目录
     * （adoptRelaySummary → 本方法），中继的 node/online 通知同理。
     */
    sendIdentityFrame(rec) {
      const payload = this.buildIdentityPayload(rec)
      if (!payload) return false
      // relay 模式没有 welcome，身份帧是节点唯一能拿到 hub 能力的地方。
      // caps 放在签名载荷外层：签名只覆盖身份字段，能力只是"hub 声明"，
      // 节点据它决定发不发 mem/*（旧 hub 不带这一项 → 节点保持零帧）。
      return this.send(rec.nodeId, HUB_TO_NODE.IDENTITY, { ...payload, caps: [...HUB_CAPS],
        ...(rec.hello?.peerUrl ? { peerSecret: rec.peerSecret } : {}),
      })
    }

    /**
     * E2E 密钥交换（提案 #1）：处理副机的 node/e2e 提议。
     *
     * 流程：校验副机的一次性 X25519 公钥 → 生成本方一次性 X25519 →
     * ECDH 派生 AES-256-GCM 会话密钥（存 rec.e2e，此后本节点的收发自动
     * 加解密）→ 用持久 ed25519 身份签 hub/e2e 确认帧回给副机。签名绑定
     * 双方公钥 + 副机提议里的连接 nonce —— 中继既伪造不了签名，也偷换不了
     * 任何一侧公钥（偷换后另一端验签必败）。
     *
     * hub 身份不可用（identity=null）时直接跳过：E2E 的认证锚就是这把身份，
     * 没有它签出的确认帧一文不值 —— 副机等不到 ack 自然按明文继续（兼容旧版）。
     *
     * 会话随 rec 生存：重连 → 新 offer → 新会话覆盖旧会话（旧密钥销毁）。
     */
    handleE2EOffer(nodeId, d) {
      const rec = this.nodes.get(nodeId)
      if (!rec) {
        this.log('warn', 'e2e offer from unknown node', { nodeId })
        return false
      }
      const pub = normalizeE2EPub(d?.pub)
      const nonce = typeof d?.nonce === 'string' && /^[0-9a-f]{16,128}$/.test(d.nonce) ? d.nonce : ''
      if (pub === '' || nonce === '') {
        this.log('warn', 'e2e offer rejected: malformed', { nodeId })
        return false
      }
      if (!this.identity) {
        this.log('info', 'e2e skipped: hub identity unavailable, link stays plaintext', { nodeId })
        return false
      }
      let session
      let ackSig
      let ackPub
      // 签名与传输必须是**同一个** at —— 两次 Date.now() 会让副机验签必败
      // （实测踩过：签名载荷里的 at 和帧里的 at 差几毫秒，验签 false）。
      const now = Date.now()
      try {
        const eph = generateEphemeral()
        session = createSession({
          role: 'hub',
          ownPrivB64: eph.privateKeyB64,
          peerPubB64: pub,
          nodePubB64: pub,
          hubPubB64: eph.publicKeyB64,
        })
        ackSig = signExchange(this.identity.privateKeyB64, {
          fingerprint: this.identity.fingerprint,
          nodeId,
          nonce,
          pub: eph.publicKeyB64,
          peerPub: pub,
          at: now,
        })
        ackPub = eph.publicKeyB64
      } catch (err) {
        this.log('warn', 'e2e session setup failed, link stays plaintext', { nodeId, error: errText(err) })
        return false
      }
      // 旧会话（若有）销毁密钥材料后再覆盖 —— 重连重协商是常态路径。
      if (rec.e2e && typeof rec.e2e.destroy === 'function') rec.e2e.destroy()
      rec.e2e = session
      rec.e2eAt = now
      this.send(nodeId, HUB_TO_NODE.E2E_ACK, { pub: ackPub, sig: ackSig, at: now })
      this.sendPeerCredentials?.(rec)
      this.clearE2EHeal(nodeId)
      this.log('warn', 'e2e session established', { nodeId })
      try { this.emit('e2eEstablished', { nodeId }) } catch { /* must not take handshake down */ }
      return true
    }

    /** 在指定连接上回 error 帧然后关闭。 */
    rejectConn(conn, code, message, nodeId) {
      // 记一次失败的连接尝试（2026-10-20，体验提升 ①）——
      // 副机连不上时，面板要能说清"为什么"，而不是只显示 0 在线。
      try {
        this.noteConnectionAttempt({
          result: 'fail',
          code: typeof code === 'string' ? code : '',
          message: typeof message === 'string' ? message : '',
          nodeId: typeof nodeId === 'string' ? nodeId : '',
          remote: remoteOf(conn),
          transport: 'direct',
        })
      } catch {
        /* 诊断记录绝不能影响拒绝流程本身 */
      }
      try {
        conn.send(encodeFrame(envelope(HUB_TO_NODE.ERROR, { code, message, nodeId })))
      } catch {
        /* 连接可能已断 */
      }
      try {
        conn.close(1008, code)
      } catch {
        /* 已关闭 */
      }
    }
  }
}

/**
 * 从连接对象上尽力取远端地址（用于诊断记录）。
 * WSConnection 不一定暴露 remote，取不到就返回空串。
 */
function remoteOf(conn) {
  try {
    const s = conn?.socket
    const addr = s?.remoteAddress
    const port = s?.remotePort
    if (typeof addr === 'string' && addr !== '') {
      return typeof port === 'number' ? `${addr}:${port}` : addr
    }
  } catch {
    /* 取不到就算了 */
  }
  return ''
}



export class RosterRegistry extends withHandshake(withIngest(RosterCore)) {}
