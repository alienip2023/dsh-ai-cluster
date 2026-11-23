/** wire/validate：帧载荷校验与归一化（逐字取自 lib/protocol.js 471-1352）。 */
import { PROTOCOL_VERSION, normalizePeerUrl } from './frames.js'
import { ERROR_CODE, RemoteAgentError } from './errors.js'
import { TASK_MODE } from './limits.js'

/**
 * 校验 hello 帧。node 与 hub 共用，保证双方对"什么是合法节点"理解一致。
 * @returns {{ok:true, hello:object} | {ok:false, error:string}}
 */
export function validateHello(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: 'hello-missing' }
  if (typeof d.nodeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(d.nodeId)) {
    return { ok: false, error: 'hello-nodeId-invalid' }
  }
  if (d.protocol !== PROTOCOL_VERSION) {
    return { ok: false, error: ERROR_CODE.PROTOCOL_MISMATCH }
  }
  const os = d.os === 'windows' || d.os === 'linux' || d.os === 'darwin' ? d.os : undefined
  if (!os) return { ok: false, error: 'hello-os-invalid' }
  return {
    ok: true,
    hello: {
      nodeId: d.nodeId,
      protocol: d.protocol,
      os,
      arch: typeof d.arch === 'string' ? d.arch : 'unknown',
      hostname: typeof d.hostname === 'string' ? d.hostname : d.nodeId,
      dshVersion: typeof d.dshVersion === 'string' ? d.dshVersion : '',
      // The AC version this node runs (0.4.28+): lets the hub say which node is behind what ds-bot needs.
      acVersion: typeof d.acVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,24})?$/.test(d.acVersion) ? d.acVersion : '',
      shells: Array.isArray(d.shells) ? d.shells.filter((s) => typeof s === 'string') : [],
      roots: Array.isArray(d.roots) ? d.roots.filter((s) => typeof s === 'string') : [],
      caps: Array.isArray(d.caps) ? d.caps.filter((s) => typeof s === 'string') : [],
      profile: typeof d.profile === 'string' ? d.profile : '',
      agentMode: d.agentMode === true,
      transportMode: d.transportMode === 'direct' || d.transportMode === 'relay' ? d.transportMode : undefined,
      ...(normalizePeerUrl(d.peerUrl) ? { peerUrl: normalizePeerUrl(d.peerUrl) } : {}),
      // P2-11：本次连接的挑战随机数（hex）。hub 把它签进 welcome/hub-identity
      // 的身份证明，副机核对一致 —— 防"录一帧旧 welcome 重放给新连接"。
      // 缺失（旧版副机）时为空串，hub 退化成自拟 nonce + 时间戳窗口。
      nonce: typeof d.nonce === 'string' && /^[0-9a-f]{16,128}$/.test(d.nonce) ? d.nonce : '',
      time: typeof d.time === 'number' ? d.time : Date.now(),
    },
  }
}

/**
 * 归一化 `artifactRules`，**含内层形状校验**。
 *
 * 合法形状：`{ final?: string[], intermediate?: string[], caseInsensitive?: boolean }`
 * （见 lib/artifacts.js 的 `classify()` —— 它读 `rules.intermediate?.length` /
 * `rules.final?.length` 后交给 `compileRules`，后者要求数组）。
 *
 * 为什么必须校验内层：`typeof x === 'object'` 只挡住 null/undefined/数字/布尔，
 * **字符串与数组也能通过**。而 `'dist/**'.length` 是真值，于是：
 *   - 传 `{ final: 'dist/**' }` → `rules.final?.length` 为 7（真）→
 *     `compileRules('dist/**')` 把字符串按可迭代对象处理 → 逐字符编译成规则，
 *     得到 `["d","i","s","t","/","*","*"]` 这类垃圾。
 *   - 实测后果：单字符文件被误判为可 pull 的 final，而真正的 `dist/app.js`
 *     反而漏掉，**无异常、无日志**。
 *
 * 非数组一律丢弃（与 outputs / denyPaths 的处理方式一致），而不是静默透传。
 * `caseInsensitive` 只接受真正的布尔。
 */
export function normalizeArtifactRules(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const pick = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === 'string' && p !== '') : undefined)
  const out = {}
  const final = pick(raw.final)
  const intermediate = pick(raw.intermediate)
  if (final !== undefined) out.final = final
  if (intermediate !== undefined) out.intermediate = intermediate
  if (typeof raw.caseInsensitive === 'boolean') out.caseInsensitive = raw.caseInsensitive
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 归一化一个模型选择（可选）。
 *
 * 接受三种写法（对小白最友好到最精确）：
 *   - `'gpt-4o'`                  → `{ model: 'gpt-4o' }`（provider 用副机默认）
 *   - `'openai/gpt-4o'`           → `{ provider: 'openai', model: 'gpt-4o' }`
 *   - `{ provider, model, reasoningEffort? }` → 逐字段过滤后原样保留
 *
 * 其他输入（数字 / 数组 / 空串 / 字段类型不对）一律返回 undefined，
 * 与 outputs / denyPaths 的处理方式一致 —— 宁可丢掉一个坏参数回到
 * "副机默认模型"，也不能把垃圾透传给 runner。
 *
 * 注意：这里只传**选择**，不传凭证 —— 模型 key 始终在副机（核心不变式 1）。
 * 副机拿到选择后用自己的 provider 配置去跑；指定的 provider/model 在副机
 * 不存在时，错误会经 agent/error 监听如实进入 handoff（2026-10-15 修复后
 * 错误不再被静默吞掉）。
 */
export function normalizeModelSelection(raw) {
  if (raw === undefined || raw === null) return undefined

  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === '') return undefined
    // 'provider/model'：provider 段不含 '/'，model 段允许再带（如 openrouter 的 org/model）
    const slash = s.indexOf('/')
    if (slash > 0 && slash < s.length - 1) {
      return { provider: s.slice(0, slash).slice(0, 64), model: s.slice(slash + 1).slice(0, 128) }
    }
    return { model: s.slice(0, 128) }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  if (typeof raw.provider === 'string' && raw.provider !== '') out.provider = raw.provider.slice(0, 64)
  if (typeof raw.model === 'string' && raw.model !== '') out.model = raw.model.slice(0, 128)
  if (typeof raw.reasoningEffort === 'string' && raw.reasoningEffort !== '') {
    out.reasoningEffort = raw.reasoningEffort.slice(0, 32)
  }
  // 没有 model 的选择不是合法选择（provider 必须配 model，单独 provider 无效）——
  // 与 outputs / denyPaths 一致：坏参数丢掉，回到副机默认。
  if (out.model === undefined) return undefined
  return out
}

/**
 * 校验 task/start 帧。
 * @returns {{ok:true, spec:object} | {ok:false, error:string}}
 */
export function validateTaskStart(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: 'task-missing' }
  if (typeof d.taskId !== 'string' || d.taskId === '') return { ok: false, error: 'task-taskId-missing' }
  if (typeof d.goal !== 'string' || d.goal.trim() === '') return { ok: false, error: 'task-goal-missing' }
  const mode = d.mode === TASK_MODE.EXEC ? TASK_MODE.EXEC : TASK_MODE.AGENT
  const c = d.constraints && typeof d.constraints === 'object' ? d.constraints : {}
  return {
    ok: true,
    spec: {
      taskId: d.taskId,
      goal: d.goal,
      workspace: typeof d.workspace === 'string' && d.workspace ? d.workspace : undefined,
      mode,
      model: normalizeModelSelection(d.model),
      constraints: {
        timeoutMs: Number.isFinite(c.timeoutMs) ? Math.max(1000, c.timeoutMs) : 60 * 60 * 1000,
        maxBytesWritten: Number.isFinite(c.maxBytesWritten) ? c.maxBytesWritten : 2 * 1024 * 1024 * 1024,
        allowNetwork: c.allowNetwork !== false,
        denyPaths: Array.isArray(c.denyPaths) ? c.denyPaths.filter((p) => typeof p === 'string') : [],
        extraEnv: c.extraEnv && typeof c.extraEnv === 'object' ? c.extraEnv : {},
      },
      outputs: Array.isArray(d.outputs) ? d.outputs.filter((p) => typeof p === 'string') : [],
      // 两阶段审批（提案 #2）：'manual' = hub 挂起待面板批准，只在调用方显式
      // 要求时才启用；缺省（含坏值）一律 'auto'。AC 是用户自己的集群，派给
      // 副机的任务不该默认卡在"待审批"里（exec 曾默认 manual，已改）。
      approval: d.approval === 'manual' ? 'manual' : 'auto',
      artifactRules: normalizeArtifactRules(d.artifactRules),
      summaryPolicy: d.summaryPolicy === 'stream' ? 'stream' : 'on-complete',
      requestedAt: typeof d.requestedAt === 'number' ? d.requestedAt : Date.now(),
      origin: typeof d.origin === 'string' ? d.origin : 'hub',
    },
  }
}

function requiredTurnId(value, code) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, error: code }
  return { ok: true, value: value.trim() }
}

function botNetworkString(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
}

function botNetworkIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!botNetworkString(value.id, 200) || !botNetworkString(value.name, 80) || !botNetworkString(value.nodeId, 80)) return null
  return { id: value.id, name: value.name, nodeId: value.nodeId }
}

/** 校验并重建 bot/message；坏帧抛出稳定错误，不透传未知字段。 */
export function validateBotMessage(d) {
  const invalid = () => { throw new RemoteAgentError('invalid bot/message payload', 'bot-message-invalid') }
  if (!d || typeof d !== 'object' || Array.isArray(d)) invalid()
  const from = botNetworkIdentity(d.from)
  const to = botNetworkIdentity(d.to)
  if (!botNetworkString(d.exchangeId, 200) || !['ask', 'reply'].includes(d.kind) || !from || !to ||
    typeof d.text !== 'string' || d.text.length > 65536 || !Number.isInteger(d.depth) || d.depth < 0 || d.depth > 3) invalid()
  return { exchangeId: d.exchangeId, kind: d.kind, from, to, text: d.text, depth: d.depth }
}

/** 目录最多 500 项；坏条目丢弃，身份上限与 bot/message 一致，role 可省略或为空。 */
export function validateBotDirectory(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.bots) || d.bots.length > 500) {
    throw new RemoteAgentError('invalid bot/directory payload', 'bot-directory-invalid')
  }
  const bots = []
  for (const raw of d.bots) {
    const identity = botNetworkIdentity(raw)
    if (!identity || (raw.role != null && typeof raw.role !== 'string')) continue
    bots.push({ ...identity, role: raw.role ?? '' })
  }
  const rooms = []
  for (const raw of Array.isArray(d.rooms) ? d.rooms.slice(0, 100) : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !botNetworkString(raw.id, 200) ||
      (raw.name !== undefined && typeof raw.name !== 'string') ||
      (raw.members !== undefined && (!Number.isInteger(raw.members) || raw.members < 0))) continue
    const room = { id: raw.id }
    if (raw.name !== undefined) room.name = raw.name.trim().slice(0, 80)
    if (raw.members !== undefined) room.members = raw.members
    rooms.push(room)
  }
  return { bots, rooms, at: Number.isFinite(d.at) ? d.at : Date.now() }
}

/**
 * bot/attach 与 bot/turn.attachments 清单的上限（hub 发图片/文件给节点 Bot，能力 bot-attach/1）。
 * 附件按块经 bot/attach 先到，随后的 bot/turn 用 attachments 清单点名它们。
 */
export const BOT_ATTACH_LIMITS = Object.freeze({
  maxAttachments: 8,
  maxChunks: 40,
  maxChunkChars: 1_100_000,
  maxNameChars: 200,
  maxMediaTypeChars: 64,
  maxBytes: 20 * 1024 * 1024,
})

const BASE64_CHARSET = /^[A-Za-z0-9+/]*={0,2}$/
const SHA256_HEX = /^[0-9a-f]{64}$/

function boundedInteger(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/**
 * 校验 bot/attach：hub → 节点的一块附件字节。同一 exchangeId 的第 index 个附件分 chunks 块，
 * chunk 从 0 起。没有结果帧；校验失败由处理方回 error 帧。
 * @returns {{ok:true, attach:object} | {ok:false, error:string}}
 */
export function validateBotAttach(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-attach-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-attach-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-attach-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const exchangeId = requiredTurnId(d.exchangeId, 'bot-attach-exchangeId-missing')
  if (!exchangeId.ok) return exchangeId
  const limits = BOT_ATTACH_LIMITS
  if (!boundedInteger(d.index, 0, limits.maxAttachments - 1)) return { ok: false, error: 'bot-attach-index-invalid' }
  if (!boundedInteger(d.chunks, 1, limits.maxChunks)) return { ok: false, error: 'bot-attach-chunks-invalid' }
  if (!boundedInteger(d.chunk, 0, d.chunks - 1)) return { ok: false, error: 'bot-attach-chunk-invalid' }
  if (typeof d.data !== 'string' || d.data === '') return { ok: false, error: 'bot-attach-data-missing' }
  if (d.data.length > limits.maxChunkChars) return { ok: false, error: 'bot-attach-data-too-large' }
  if (!BASE64_CHARSET.test(d.data)) return { ok: false, error: 'bot-attach-data-invalid' }
  return {
    ok: true,
    attach: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      exchangeId: exchangeId.value,
      index: d.index,
      chunk: d.chunk,
      chunks: d.chunks,
      data: d.data,
    },
  }
}

/**
 * bot/turn 的 attachments 清单。缺省 / null / 空数组 = 没有附件（返回 []）；
 * 任何一条不合格都返回 null，调用方整帧拒绝，绝不悄悄丢掉某一条。
 */
function cleanBotAttachments(raw) {
  if (raw === undefined || raw === null) return []
  const limits = BOT_ATTACH_LIMITS
  if (!Array.isArray(raw) || raw.length > limits.maxAttachments) return null
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    if (!boundedInteger(item.index, 0, limits.maxAttachments - 1) || seen.has(item.index)) return null
    if (typeof item.name !== 'string') return null
    const name = item.name.trim()
    if (name === '' || name.length > limits.maxNameChars) return null
    if (item.kind !== 'image' && item.kind !== 'file') return null
    if (item.mediaType !== undefined && (typeof item.mediaType !== 'string' || item.mediaType.length > limits.maxMediaTypeChars)) return null
    if (!boundedInteger(item.bytes, 1, limits.maxBytes)) return null
    if (typeof item.sha256 !== 'string' || !SHA256_HEX.test(item.sha256)) return null
    if (!boundedInteger(item.chunks, 1, limits.maxChunks)) return null
    seen.add(item.index)
    out.push({
      index: item.index,
      name,
      kind: item.kind,
      ...(typeof item.mediaType === 'string' && item.mediaType !== '' ? { mediaType: item.mediaType } : {}),
      bytes: item.bytes,
      sha256: item.sha256,
      chunks: item.chunks,
    })
  }
  return out
}

/**
 * 校验 bot/turn。缺 nodeId / remoteBotId / exchangeId / text 即拒绝。
 * 不读 mode，不改写成 agent，不调用 validateTaskStart。
 * @returns {{ok:true, turn:object} | {ok:false, error:string}}
 */
export function validateBotTurn(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-turn-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-turn-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-turn-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const exchangeId = requiredTurnId(d.exchangeId, 'bot-turn-exchangeId-missing')
  if (!exchangeId.ok) return exchangeId
  if (typeof d.text !== 'string') return { ok: false, error: 'bot-turn-text-missing' }
  const sender = {}
  for (const field of ['senderBotId', 'senderName']) {
    if (!Object.hasOwn(d, field)) continue
    if (typeof d[field] !== 'string' || d[field].trim() === '') return { ok: false, error: 'bot-turn-sender-invalid' }
    const value = d[field].trim()
    if (value.length > 80) return { ok: false, error: 'bot-turn-sender-too-long' }
    sender[field] = value
  }
  const room = {}
  for (const [field, limit] of [['roomId', 200], ['roomName', 80]]) {
    if (!Object.hasOwn(d, field)) continue
    if (typeof d[field] !== 'string' || d[field].trim() === '') return { ok: false, error: 'bot-turn-room-invalid' }
    const value = d[field].trim()
    if (value.length > limit) return { ok: false, error: 'bot-turn-room-invalid' }
    room[field] = value
  }
  // How the sender wants a busy Bot to take it: 'steer' joins the turn in flight, 'queue' waits for
  // it. Anything else is read as not given (the node then queues, as it always did).
  const mode = d.mode === 'steer' || d.mode === 'queue' ? { mode: d.mode } : {}
  // Images / files the hub put on the link as bot/attach chunks just before this turn (bot-attach/1).
  // One bad entry rejects the whole turn: an attachment is never dropped on the way.
  const attachmentList = cleanBotAttachments(d.attachments)
  if (attachmentList === null) return { ok: false, error: 'bot-turn-attachments-invalid' }
  const attachments = attachmentList.length > 0 ? { attachments: attachmentList } : {}
  return {
    ok: true,
    turn: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      exchangeId: exchangeId.value,
      text: d.text,
      ...sender,
      ...room,
      ...mode,
      ...attachments,
    },
  }
}

/**
 * 校验 bot/turn-result。正文可为空字符串；缺身份字段拒绝。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
/**
 * 校验 bot/create。缺 nodeId / name / requestId 即拒绝。
 * @returns {{ok:true, create:object} | {ok:false, error:string}}
 */
function cleanMemoryConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  if (typeof input.backend !== 'string') return null
  const backend = input.backend.trim()
  if (backend === '' || backend.length > 32) return null
  return { backend }
}

/**
 * `bot/update` 的 memoryConfig：出现即必须是 `{backend: 非空字符串 ≤32}`。
 *
 * 与 create 的宽松读法不同 —— update 是显式改后端，坏形状整帧拒绝，
 * 不能静默读成「没给」然后回一个 ok。backend 是否属于记忆后端枚举由节点上的
 * ds-bot roster 判（这里只管形状，未知枚举值由 roster 丢弃，不拒帧）。
 */
function parseMemoryConfig(input) {
  if (input === undefined || input === null) return { ok: true, value: null }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false }
  if (typeof input.backend !== 'string') return { ok: false }
  const backend = input.backend.trim()
  if (backend === '' || backend.length > 32) return { ok: false }
  return { ok: true, value: { backend } }
}

export function validateBotCreate(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-create-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-create-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const requestId = requiredTurnId(d.requestId, 'bot-create-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.name !== 'string' || d.name.trim() === '') return { ok: false, error: 'bot-create-name-missing' }
  // Only the hub may claim a Bot; an unknown marker is refused, never read as "not given",
  // because losing it would silently turn fail-closed model selection back into a fallback.
  if (d.managedBy !== undefined && d.managedBy !== null && d.managedBy !== 'hub') {
    return { ok: false, error: 'bot-create-managedBy-invalid' }
  }
  return {
    ok: true,
    create: {
      nodeId: nodeId.value,
      requestId: requestId.value,
      name: d.name.trim().slice(0, 40),
      role: typeof d.role === 'string' ? d.role.trim().slice(0, 24) : '',
      // The spec the main sent for the Bot itself. A field of the wrong type is read as
      // "not given" (null) rather than refusing the frame; the receiver validates the values
      // (model served, workDir inside the node's roots). No length cut here: the instructions
      // limit (8000 bytes) is enforced once, on the sending side.
      modelRef: stringOrNull(d.modelRef),
      effort: stringOrNull(d.effort),
      // The hub's level when the creator named none (≤64, as the hub sends it) and the
      // ownership marker a later turn reads to fail closed instead of falling back.
      defaultEffort: typeof d.defaultEffort === 'string' && d.defaultEffort !== '' ? d.defaultEffort.slice(0, 64) : null,
      managedBy: d.managedBy === 'hub' ? 'hub' : null,
      workDir: stringOrNull(d.workDir),
      instructions: stringOrNull(d.instructions),
      // M4 S4: the memory backend the main picked for this Bot (`{backend:'federation'}`).
      // The node's own roster validates the value against MEMORY_BACKENDS; here it only
      // has to arrive as a small object, and a wrong shape reads as "not given".
      memoryConfig: cleanMemoryConfig(d.memoryConfig),
    },
  }
}

/**
 * Validate bot/history request from hub.
 * @returns {{ok:true, hist:object} | {ok:false, error:string}}
 */
export function validateBotHistory(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-history-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-history-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const requestId = requiredTurnId(d.requestId, 'bot-history-requestId-missing')
  if (!requestId.ok) return requestId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-history-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  return {
    ok: true,
    hist: {
      nodeId: nodeId.value,
      requestId: requestId.value,
      remoteBotId: remoteBotId.value,
      cursor: d.cursor != null && typeof d.cursor === 'object' ? d.cursor : null,
    },
  }
}

/**
 * Validate bot/history-result from node.
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotHistoryResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-history-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-history-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (d.ok === false) {
    return { ok: true, result: { requestId: requestId.value, ok: false, error: typeof d.error === 'string' ? d.error : 'bot-history-failed' } }
  }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: true,
      sessionId: typeof d.sessionId === 'string' ? d.sessionId : '',
      items: Array.isArray(d.items) ? d.items : [],
      cursor: d.cursor != null ? d.cursor : null,
    },
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 校验 bot/create-result。缺 requestId 即拒绝；失败时 ok:false + error。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotCreateResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-create-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-create-result-requestId-missing')
  if (!requestId.ok) return requestId
  const success = d.ok !== false
  if (success) {
    const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-create-result-remoteBotId-missing')
    if (!remoteBotId.ok) return remoteBotId
    return {
      ok: true,
      result: {
        requestId: requestId.value,
        ok: true,
        remoteBotId: remoteBotId.value,
        name: typeof d.name === 'string' ? d.name.trim().slice(0, 40) : '',
        role: typeof d.role === 'string' ? d.role.trim().slice(0, 24) : '',
      },
    }
  }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: false,
      error: typeof d.error === 'string' && d.error !== '' ? d.error : 'bot-create-failed',
    },
  }
}

export function validateBotTurnResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-turn-result-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-turn-result-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-turn-result-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const exchangeId = requiredTurnId(d.exchangeId, 'bot-turn-result-exchangeId-missing')
  if (!exchangeId.ok) return exchangeId
  if (d.text !== undefined && typeof d.text !== 'string') return { ok: false, error: 'bot-turn-result-text-invalid' }
  if (d.seq === undefined || typeof d.seq !== 'number' || !Number.isInteger(d.seq))
    return { ok: false, error: 'bot-turn-result-seq-missing' }
  if (d.seq < 0)
    return { ok: false, error: 'bot-turn-result-seq-invalid' }
  const room = {}
  if (Object.hasOwn(d, 'roomId')) {
    if (typeof d.roomId !== 'string' || d.roomId.trim() === '' || d.roomId.trim().length > 200)
      return { ok: false, error: 'bot-turn-result-room-invalid' }
    room.roomId = d.roomId.trim()
  }
  return {
    ok: true,
    result: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      exchangeId: exchangeId.value,
      text: typeof d.text === 'string' ? d.text : '',
      ok: d.ok !== false,
      seq: d.seq,
      ...(typeof d.error === 'string' && d.error !== '' ? { error: d.error } : {}),
      ...room,
    },
  }
}

/**
 * bot/trace 的上限。节点与 hub 两边都按这张表裁；文本超长时在文末写明截掉了多少字，
 * 条数 / 字节超限丢掉的数量记在 clipped（帧内）与 omitted（节点自报），不静默。
 */
export const BOT_TRACE_LIMITS = Object.freeze({
  /** 一个回合的步骤总数（final 帧）。 */
  maxItems: 400,
  /** 一个实时帧里的步骤数。 */
  maxBatchItems: 64,
  think: 6000,
  args: 1500,
  out: 3000,
  name: 120,
  callId: 200,
  /** 一条助手消息里的工具调用数。 */
  calls: 16,
  /** 一帧 items 序列化后的字节上限（ws 帧 4 MiB 上限之内留足余量）。 */
  frameBytes: 384 * 1024,
})

function traceClip(value, max, stats) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= max) return value
  let end = max
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  stats.clipped += 1
  return `${value.slice(0, end)}…[已截断 ${value.length - end} 字]`
}

// 工具参数是模型给的原始 JSON 串。超长时仍给一个合法 JSON，页面解析它不会出错。
function traceArgs(value, max, stats) {
  const raw = typeof value === 'string' ? value : ''
  if (raw.length <= max) return raw
  stats.clipped += 1
  const head = raw.slice(0, 300)
  return JSON.stringify({ _truncated: `${head}…[已截断 ${raw.length - head.length} 字]` })
}

function cleanTraceItem(raw, limits, stats) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Number.isSafeInteger(raw.i) || raw.i < 1) return null
  if (raw.t === 'a') {
    const item = { i: raw.i, t: 'a' }
    const think = traceClip(raw.think, limits.think, stats)
    if (think !== '') item.think = think
    if (Array.isArray(raw.calls)) {
      const calls = []
      for (const call of raw.calls.slice(0, limits.calls)) {
        if (!call || typeof call !== 'object' || typeof call.id !== 'string' || call.id.trim() === '' || call.id.length > limits.callId
          || typeof call.name !== 'string' || call.name.trim() === '') { stats.clipped += 1; continue }
        calls.push({ id: call.id, name: call.name.slice(0, limits.name), args: traceArgs(call.args, limits.args, stats) })
      }
      stats.clipped += Math.max(0, raw.calls.length - limits.calls)
      if (calls.length > 0) item.calls = calls
    }
    if (raw.end === true) item.end = true
    return item
  }
  if (raw.t === 'r') {
    if (typeof raw.id !== 'string' || raw.id.trim() === '' || raw.id.length > limits.callId) return null
    const item = { i: raw.i, t: 'r', id: raw.id, ok: raw.ok !== false }
    const out = traceClip(raw.out, limits.out, stats)
    if (out !== '') item.out = out
    return item
  }
  return null
}

/**
 * 校验 bot/trace。缺身份 / seq / items 整帧拒绝；单条步骤不合法只丢那一条并记入 clipped。
 * @returns {{ok:true, trace:object} | {ok:false, error:string}}
 */
export function validateBotTrace(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-trace-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-trace-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-trace-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const exchangeId = requiredTurnId(d.exchangeId, 'bot-trace-exchangeId-missing')
  if (!exchangeId.ok) return exchangeId
  if (typeof d.seq !== 'number' || !Number.isInteger(d.seq)) return { ok: false, error: 'bot-trace-seq-missing' }
  if (d.seq < 1) return { ok: false, error: 'bot-trace-seq-invalid' }
  if (!Array.isArray(d.items)) return { ok: false, error: 'bot-trace-items-missing' }
  const room = {}
  if (Object.hasOwn(d, 'roomId')) {
    if (typeof d.roomId !== 'string' || d.roomId.trim() === '' || d.roomId.trim().length > 200) return { ok: false, error: 'bot-trace-room-invalid' }
    room.roomId = d.roomId.trim()
  }
  const limits = BOT_TRACE_LIMITS
  const final = d.final === true
  const cap = final ? limits.maxItems : limits.maxBatchItems
  const stats = { clipped: Math.max(0, d.items.length - cap) }
  const seen = new Set()
  const items = []
  let bytes = 0
  for (const raw of d.items.slice(0, cap)) {
    const item = cleanTraceItem(raw, limits, stats)
    if (item === null || seen.has(item.i)) { stats.clipped += 1; continue }
    bytes += Buffer.byteLength(JSON.stringify(item), 'utf8')
    if (bytes > limits.frameBytes) { stats.clipped += 1; continue }
    seen.add(item.i)
    items.push(item)
  }
  items.sort((a, b) => a.i - b.i)
  const omitted = Number.isSafeInteger(d.omitted) && d.omitted > 0 ? d.omitted : 0
  return {
    ok: true,
    trace: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      exchangeId: exchangeId.value,
      seq: d.seq,
      ...(final ? { final: true } : {}),
      items,
      ...(omitted > 0 ? { omitted } : {}),
      ...(stats.clipped > 0 ? { clipped: stats.clipped } : {}),
      ...room,
    },
  }
}

/**
 * 校验 bot/update。至少一个字段非 null；类型不对按 null，不整帧拒绝。
 * @returns {{ok:true, update:object} | {ok:false, error:string}}
 */
export function validateBotUpdate(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-update-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-update-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-update-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const requestId = requiredTurnId(d.requestId, 'bot-update-requestId-missing')
  if (!requestId.ok) return requestId
  const model = stringOrNull(d.model)
  const effort = stringOrNull(d.effort)
  const instructions = stringOrNull(d.instructions)
  const workDir = stringOrNull(d.workDir)
  const profile = cleanBotUpdateProfile(d)
  const memory = parseMemoryConfig(d.memoryConfig)
  if (!memory.ok) return { ok: false, error: 'bot-update-memoryConfig-invalid' }
  if (model === null && effort === null && instructions === null && workDir === null && memory.value === null
    && Object.values(profile).every(value => value === null)) {
    return { ok: false, error: 'bot-update-all-null' }
  }
  return {
    ok: true,
    update: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      requestId: requestId.value,
      model,
      effort,
      instructions,
      workDir,
      ...profile,
      // 只改记忆后端时其余字段全 null：这条帧是新节点才认的形状，老节点会以
      // bot-update-all-null 拒掉，所以 hub 靠 BOT_MEMORY_UPDATE_CAP 决定发不发。
      memoryConfig: memory.value,
    },
  }
}

/**
 * 校验 bot/update-result。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotUpdateResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-update-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-update-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'bot-update-result-ok-missing' }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: d.ok,
      error: stringOrNull(d.error),
      model: stringOrNull(d.model),
      effort: stringOrNull(d.effort),
      instructions: stringOrNull(d.instructions),
      workDir: stringOrNull(d.workDir),
      ...cleanBotUpdateProfile(d),
      // 节点应用后的后端（null = 这帧没带 memoryConfig，或旧节点不认识该字段）。
      memoryConfig: cleanMemoryConfig(d.memoryConfig),
    },
  }
}

function cleanBotUpdateProfile(d) {
  return {
    name: typeof d.name === 'string' && d.name.trim() !== '' ? d.name.trim().slice(0, 40) : null,
    role: typeof d.role === 'string' ? d.role.trim().slice(0, 24) : null,
    color: typeof d.color === 'string' && d.color.trim().length <= 32 ? d.color.trim() : null,
    avatar: cleanBotUpdateAvatar(d.avatar),
  }
}

function cleanBotUpdateAvatar(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  // null means no change on the wire; an empty object explicitly resets the avatar.
  if (Object.keys(value).length === 0) return {}
  const avatar = {}
  if (value.shape !== undefined) {
    if (typeof value.shape !== 'string' || !/^[a-z][\w-]{0,31}$/.test(value.shape)) return null
    avatar.shape = value.shape
  }
  if (value.image !== undefined) {
    if (typeof value.image !== 'string' || value.image.length > 160_000
      || !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value.image)) return null
    avatar.image = value.image
  }
  return Object.keys(avatar).length > 0 ? avatar : null
}

/**
 * 校验 bot/delete。缺 nodeId / remoteBotId / requestId 即拒绝。
 * @returns {{ok:true, del:object} | {ok:false, error:string}}
 */
export function validateBotDelete(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-delete-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-delete-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-delete-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const requestId = requiredTurnId(d.requestId, 'bot-delete-requestId-missing')
  if (!requestId.ok) return requestId
  return {
    ok: true,
    del: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      requestId: requestId.value,
    },
  }
}

/**
 * 校验 bot/delete-result。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotDeleteResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-delete-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-delete-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'bot-delete-result-ok-missing' }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: d.ok,
      error: stringOrNull(d.error),
    },
  }
}

/**
 * 校验 bot/stop。缺 nodeId / remoteBotId / requestId 即拒绝。
 * @returns {{ok:true, stop:object} | {ok:false, error:string}}
 */
export function validateBotStop(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-stop-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-stop-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-stop-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const requestId = requiredTurnId(d.requestId, 'bot-stop-requestId-missing')
  if (!requestId.ok) return requestId
  return {
    ok: true,
    stop: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      requestId: requestId.value,
    },
  }
}

/**
 * 校验 bot/stop-result。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotStopResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-stop-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-stop-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'bot-stop-result-ok-missing' }
  if (typeof d.stopped !== 'boolean') return { ok: false, error: 'bot-stop-result-stopped-missing' }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: d.ok,
      stopped: d.stopped,
      error: stringOrNull(d.error),
    },
  }
}

/** bot/action 允许的操作。未知操作整帧拒绝，不静默忽略。 */
export const BOT_ACTIONS = Object.freeze(['card-answer', 'task-stop', 'task-send', 'task-start'])

/**
 * 校验 bot/action。缺 nodeId / remoteBotId / requestId 或操作未知即拒绝。
 * params 逐字段过滤：只留 cardId / choice / text / taskId / relation 五个字符串，其余丢弃。
 * @returns {{ok:true, action:object} | {ok:false, error:string}}
 */
export function validateBotAction(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-action-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-action-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-action-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const requestId = requiredTurnId(d.requestId, 'bot-action-requestId-missing')
  if (!requestId.ok) return requestId
  if (!BOT_ACTIONS.includes(d.action)) return { ok: false, error: 'bot-action-unknown' }
  const raw = d.params && typeof d.params === 'object' && !Array.isArray(d.params) ? d.params : {}
  const params = {}
  for (const [field, limit] of [['cardId', 200], ['choice', 64], ['text', 4000], ['taskId', 64], ['relation', 16]]) {
    if (typeof raw[field] === 'string' && raw[field] !== '') params[field] = raw[field].slice(0, limit)
  }
  if (d.action === 'card-answer' && (params.cardId === undefined || (params.choice === undefined && params.text === undefined))) {
    return { ok: false, error: 'bot-action-card-answer-incomplete' }
  }
  if ((d.action === 'task-stop' || d.action === 'task-send') && params.taskId === undefined) return { ok: false, error: 'bot-action-taskId-missing' }
  if (d.action === 'task-send' && params.text === undefined) return { ok: false, error: 'bot-action-text-missing' }
  if (d.action === 'task-start' && params.text === undefined) return { ok: false, error: 'bot-action-text-missing' }
  return { ok: true, action: { nodeId: nodeId.value, remoteBotId: remoteBotId.value, requestId: requestId.value, action: d.action, params } }
}

/**
 * 校验 bot/action-result。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotActionResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-action-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-action-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'bot-action-result-ok-missing' }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: d.ok,
      error: stringOrNull(typeof d.error === 'string' ? d.error.slice(0, 200) : null),
      detail: typeof d.detail === 'string' ? d.detail.slice(0, 500) : null,
    },
  }
}

/** peer/roster 允许的联邦级别，顺序即强弱：off < roster < dispatch < groups。 */
export const PEER_LEVELS = Object.freeze(['off', 'roster', 'dispatch', 'groups'])

/** hubId 由 host 生成：短、稳定、能出现在 id 里（不用 nodeId，节点可能连多个 hub）。 */
const PEER_HUB_ID = /^[A-Za-z0-9._-]+$/

/**
 * 校验主控下发的 peer/roster（T9a）。
 *
 * 名单是**另一台机器的自述**，hub 侧只按形状收；身份归属由连接 nodeId 决定，
 * 不在这里出现。重复 botId 只留第一条（同一帧里后者视为噪声），空 bots 合法
 * （`off` 清场帧就带空的）。
 *
 * @returns {{ok:true, value:{hubId:string,level:string,hostname:string,bots:object[]}} | {ok:false,error:string}}
 */
export function validatePeerRoster(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'peer-roster-missing' }
  if (typeof d.hubId !== 'string') return { ok: false, error: 'peer-roster-hubId-missing' }
  const hubId = d.hubId.trim()
  if (hubId.length < 1 || hubId.length > 64 || !PEER_HUB_ID.test(hubId)) {
    return { ok: false, error: 'peer-roster-hubId-invalid' }
  }
  if (typeof d.level !== 'string' || !PEER_LEVELS.includes(d.level)) {
    return { ok: false, error: 'peer-roster-level-invalid' }
  }
  const hostname = typeof d.hostname === 'string' ? d.hostname.trim().slice(0, 80) : ''
  if (!Array.isArray(d.bots)) return { ok: false, error: 'peer-roster-bots-missing' }
  if (d.bots.length > 64) return { ok: false, error: 'peer-roster-bots-too-many' }

  const bots = []
  const seen = new Set()
  for (const raw of d.bots) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'peer-roster-bot-invalid' }
    if (typeof raw.id !== 'string' || raw.id.trim() === '') return { ok: false, error: 'peer-roster-bot-id-missing' }
    const id = raw.id.trim()
    if (id.length > 80) return { ok: false, error: 'peer-roster-bot-id-invalid' }
    if (seen.has(id)) continue
    seen.add(id)
    if (typeof raw.name !== 'string' || typeof raw.role !== 'string') {
      return { ok: false, error: 'peer-roster-bot-invalid' }
    }
    const bot = { id, name: raw.name.slice(0, 40), role: raw.role.slice(0, 24) }
    if (typeof raw.main === 'boolean') bot.main = raw.main
    if (typeof raw.model === 'string' && raw.model !== '') bot.model = raw.model.slice(0, 120)
    bots.push(bot)
  }
  return { ok: true, value: { hubId, level: d.level, hostname, bots } }
}

/**
 * 校验 node/config（hub → node 的并发上限下发）。
 * maxConcurrent 必须是 1–64 的整数；不合法即整帧拒绝，绝不夹到边界后假装成功。
 * @returns {{ok:true, config:object} | {ok:false, error:string}}
 */
export function validateNodeConfig(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'node-config-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'node-config-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const requestId = requiredTurnId(d.requestId, 'node-config-requestId-missing')
  if (!requestId.ok) return requestId
  if (!Number.isInteger(d.maxConcurrent) || d.maxConcurrent < 1 || d.maxConcurrent > 64) {
    return { ok: false, error: 'node-config-maxConcurrent-invalid' }
  }
  return { ok: true, config: { nodeId: nodeId.value, requestId: requestId.value, maxConcurrent: d.maxConcurrent } }
}

/** Strict all-or-nothing validation; only ledger display fields cross the wire. */
export function validateJobsFrame(d) {
  const invalid = { ok: false, error: 'jobs-invalid' }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Number.isFinite(d.at) || d.at < 0 || !Array.isArray(d.jobs)) return invalid
  if (d.jobs.length > 200) return { ok: false, error: 'jobs-too-many' }
  const jobs = []
  const ids = new Set()
  for (const job of d.jobs) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) return invalid
    for (const key of ['id', 'name', 'cwd']) {
      if (typeof job[key] !== 'string' || !job[key].trim() || job[key].length > (key === 'id' ? 256 : 4096)) return invalid
    }
    if (ids.has(job.id) || !Number.isSafeInteger(job.pid) || job.pid < 1 ||
        !Number.isFinite(job.startedAt) || job.startedAt < 0 || !['running', 'done', 'lost'].includes(job.status)) return invalid
    ids.add(job.id)
    const clean = { id: job.id, name: job.name, pid: job.pid, cwd: job.cwd, startedAt: job.startedAt, status: job.status }
    if (Object.hasOwn(job, 'progressLines')) {
      if (!Number.isSafeInteger(job.progressLines) || job.progressLines < 0) return invalid
      clean.progressLines = job.progressLines
    }
    if (Object.hasOwn(job, 'duplicateOf')) {
      if (typeof job.duplicateOf !== 'string' || !job.duplicateOf.trim() || job.duplicateOf.length > 256 || job.duplicateOf === job.id) return invalid
      clean.duplicateOf = job.duplicateOf
    }
    jobs.push(clean)
  }
  return { ok: true, jobs: { at: d.at, jobs } }
}

/**
 * 校验 node/model-sync（hub → node 的模型同步帧）。
 * scope='default' 只带 modelRef；'bot' 带 modelRef + botId；'all' 带 modelRef。
 * effort 可选。旧节点（无此 case）按未知帧忽略，不回 result；hub 超时后标「不支持」。
 * @returns {{ok:true, sync:object} | {ok:false, error:string}}
 */
export function validateModelSync(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'model-sync-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'model-sync-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const requestId = requiredTurnId(d.requestId, 'model-sync-requestId-missing')
  if (!requestId.ok) return requestId
  const SCOPES = new Set(['default', 'bot', 'all'])
  if (typeof d.scope !== 'string' || !SCOPES.has(d.scope)) return { ok: false, error: 'model-sync-scope-invalid' }
  if (typeof d.modelRef !== 'string' || d.modelRef.trim() === '') return { ok: false, error: 'model-sync-modelRef-missing' }
  const modelRef = d.modelRef.trim().slice(0, 256)
  if (d.scope === 'bot') {
    if (typeof d.botId !== 'string' || d.botId.trim() === '') return { ok: false, error: 'model-sync-botId-missing' }
  }
  const effort = typeof d.effort === 'string' && d.effort.trim() !== '' ? d.effort.trim().slice(0, 64) : undefined
  const botId = d.scope === 'bot' ? d.botId.trim().slice(0, 256) : undefined
  return { ok: true, sync: { nodeId: nodeId.value, requestId: requestId.value, scope: d.scope, modelRef, ...(botId !== undefined ? { botId } : {}), ...(effort !== undefined ? { effort } : {}) } }
}

/**
 * 校验 node/model-sync-result（node → hub 的模型同步回执）。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateModelSyncResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'model-sync-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'model-sync-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'model-sync-result-ok-missing' }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      nodeId: stringOrNull(d.nodeId),
      ok: d.ok,
      applied: Array.isArray(d.applied) ? d.applied.map(s => String(s).slice(0, 256)).slice(0, 64) : [],
      error: stringOrNull(d.error),
    },
  }
}

/**
 * 校验 node/config-result（node → hub 的并发上限回执）。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateNodeConfigResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'node-config-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'node-config-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'node-config-result-ok-missing' }
  const maxConcurrent = Number.isInteger(d.maxConcurrent) && d.maxConcurrent >= 1 && d.maxConcurrent <= 64
    ? d.maxConcurrent
    : null
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      nodeId: stringOrNull(d.nodeId),
      ok: d.ok,
      maxConcurrent,
      error: stringOrNull(d.error),
    },
  }
}


/**
 * 校验 node/approval-request（node → hub）：ds-bot 把待批工具调用中继给主控。
 * 载荷 { approvalId, nodeId, botId, roomId?, tool, reason, detail:{text?,code?}, at, fingerprint }。
 * @returns {{ok:true, req:object} | {ok:false, error:string}}
 */
export function validateApprovalRequest(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'approval-request-missing' }
  for (const f of ['approvalId', 'nodeId', 'botId', 'tool', 'fingerprint']) {
    if (typeof d[f] !== 'string' || d[f].trim() === '') return { ok: false, error: `approval-request-${f}-missing` }
  }
  if (!Number.isFinite(d.at)) return { ok: false, error: 'approval-request-at-missing' }
  const detail = d.detail && typeof d.detail === 'object' && !Array.isArray(d.detail) ? d.detail : {}
  return {
    ok: true,
    req: {
      approvalId: String(d.approvalId).trim().slice(0, 128),
      nodeId: String(d.nodeId).trim().slice(0, 64),
      botId: String(d.botId).trim().slice(0, 128),
      roomId: typeof d.roomId === 'string' && d.roomId.trim() !== '' ? d.roomId.trim().slice(0, 128) : undefined,
      tool: String(d.tool).trim().slice(0, 128),
      reason: typeof d.reason === 'string' ? d.reason.slice(0, 500) : '',
      detail: {
        text: typeof detail.text === 'string' ? detail.text.slice(0, 2000) : undefined,
        code: typeof detail.code === 'string' ? detail.code.slice(0, 1000) : undefined,
      },
      at: d.at,
      fingerprint: String(d.fingerprint).slice(0, 128),
    },
  }
}

/**
 * 校验 hub/approval-answer（hub → node）：主控回传审批结果。
 * 载荷 { requestId, nodeId, approvalId, choice: 'allow'|'reject'|'cancel' }。
 * @returns {{ok:true, answer:object} | {ok:false, error:string}}
 */
export function validateApprovalAnswer(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'approval-answer-missing' }
  for (const f of ['requestId', 'nodeId', 'approvalId']) {
    if (typeof d[f] !== 'string' || d[f].trim() === '') return { ok: false, error: `approval-answer-${f}-missing` }
  }
  const CHOICES = new Set(['allow', 'reject', 'cancel'])
  if (!CHOICES.has(d.choice)) return { ok: false, error: 'approval-answer-choice-invalid' }
  return {
    ok: true,
    answer: {
      requestId: String(d.requestId).trim().slice(0, 128),
      nodeId: String(d.nodeId).trim().slice(0, 64),
      approvalId: String(d.approvalId).trim().slice(0, 128),
      choice: d.choice,
    },
  }
}

/**
 * 校验 node/approval-settled（node → hub）：通知主控某审批已被其他路径结算。
 * 载荷 { approvalId, nodeId, outcome }。
 * @returns {{ok:true, settled:object} | {ok:false, error:string}}
 */
export function validateApprovalSettled(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'approval-settled-missing' }
  for (const f of ['approvalId', 'nodeId']) {
    if (typeof d[f] !== 'string' || d[f].trim() === '') return { ok: false, error: `approval-settled-${f}-missing` }
  }
  const OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled'])
  if (!OUTCOMES.has(d.outcome)) return { ok: false, error: 'approval-settled-outcome-invalid' }
  return {
    ok: true,
    settled: {
      approvalId: String(d.approvalId).trim().slice(0, 128),
      nodeId: String(d.nodeId).trim().slice(0, 64),
      outcome: d.outcome,
    },
  }
}

/* ─────────────────────────── M4：mem/* 校验器 ─────────────────────────── */

/**
 * 四个 validator 的统一契约（契约 §3.1）：任何输入都不抛；不合法返回 `null`，
 * 合法返回**清洗后的新对象**。调用方只判 `=== null`，绝不假设异常。
 *
 * 不合法包括：null / 字符串 / 数组 / 超大对象 / 缺必填字段 / 类型不对 /
 * 越界值。上限在这里按字段收（文本 8KB、query 512B、topic 64B…），单帧
 * 总上限在 transport/ingest 层用 MAX_MEMORY_FRAME_BYTES 再兜一次。
 */
const MEMORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MEMORY_SCOPES = new Set(['team', 'node', 'bot', 'own'])
const MEMORY_OPS = new Set(['add', 'replace', 'forget'])
const MEMORY_TEXT_BYTES = 8 * 1024

function memPlain(d) {
  return d && typeof d === 'object' && !Array.isArray(d) ? d : null
}

function memId(v) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return MEMORY_ID_RE.test(t) ? t : null
}

function memBounded(v, max) {
  if (typeof v !== 'string') return null
  return Buffer.byteLength(v, 'utf8') <= max ? v : null
}

function memText(v, max = MEMORY_TEXT_BYTES) {
  if (typeof v !== 'string' || v.length === 0) return null
  return Buffer.byteLength(v, 'utf8') <= max ? v : null
}

function memOptional(obj, key, read) {
  if (obj[key] === undefined) return { ok: true, absent: true }
  const value = read(obj[key])
  return value === null ? { ok: false } : { ok: true, value }
}

/**
 * mem/read：`{requestId, remoteBotId, scope, query?, topic?, limit?}`。
 * scope 只接受 team/node/bot/own；真正的权限在 hub（S3）按连接身份判。
 */
export function validateMemRead(d) {
  const o = memPlain(d)
  if (!o) return null
  const requestId = memId(o.requestId)
  if (requestId === null) return null
  const remoteBotId = memId(o.remoteBotId)
  if (remoteBotId === null) return null
  if (typeof o.scope !== 'string' || !MEMORY_SCOPES.has(o.scope)) return null
  const out = { requestId, remoteBotId, scope: o.scope }
  const query = memOptional(o, 'query', (v) => memText(v, 512))
  if (!query.ok) return null
  if (!query.absent) out.query = query.value
  const topic = memOptional(o, 'topic', (v) => memText(v, 64))
  if (!topic.ok) return null
  if (!topic.absent) out.topic = topic.value
  if (o.limit !== undefined) {
    if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 50) return null
    out.limit = o.limit
  }
  return out
}

/**
 * mem/write：`{requestId, remoteBotId, op, scope, text?, replace?, topic?, until?, pin?, always?}`。
 * team 写在这里是**语法合法**的——拒绝由 hub 的权限层给出明确 code，
 * 协议层不替业务做决定。
 */
export function validateMemWrite(d) {
  const o = memPlain(d)
  if (!o) return null
  const requestId = memId(o.requestId)
  if (requestId === null) return null
  const remoteBotId = memId(o.remoteBotId)
  if (remoteBotId === null) return null
  if (typeof o.op !== 'string' || !MEMORY_OPS.has(o.op)) return null
  if (typeof o.scope !== 'string' || !MEMORY_SCOPES.has(o.scope)) return null
  const out = { requestId, remoteBotId, op: o.op, scope: o.scope }
  if (o.text !== undefined) {
    const text = memText(o.text)
    if (text === null) return null
    out.text = text
  }
  if (o.op !== 'forget' && out.text === undefined) return null
  if (o.op === 'forget' && out.text === undefined && o.replace === undefined) return null
  if (o.replace !== undefined) {
    const replace = memText(o.replace, 512)
    if (replace === null) return null
    out.replace = replace
  }
  if (o.topic !== undefined) {
    const topic = memText(o.topic, 64)
    if (topic === null) return null
    out.topic = topic
  }
  if (o.until !== undefined) {
    const until = typeof o.until === 'string' && o.until.length <= 32 ? o.until : null
    if (until === null) return null
    out.until = until
  }
  for (const key of ['pin', 'always']) {
    if (o[key] === undefined) continue
    if (typeof o[key] !== 'boolean') return null
    out[key] = o[key]
  }
  return out
}

/**
 * mem/snapshot（hub→node）：全量渲染文本，按 bot 分段。
 * 单段 64KB 上限只是防御；真正的 32KB 预算由 hub 渲染层（S3）执行。
 */
export function validateMemSnapshot(d) {
  const o = memPlain(d)
  if (!o) return null
  if (!Number.isInteger(o.seq) || o.seq < 0) return null
  const team = memBounded(o.team ?? '', 64 * 1024)
  const node = memBounded(o.node ?? '', 64 * 1024)
  if (team === null || node === null) return null
  const botsRaw = memPlain(o.bots ?? {})
  if (botsRaw === null) return null
  const keys = Object.keys(botsRaw)
  if (keys.length > 64) return null
  const bots = {}
  for (const key of keys) {
    const id = memId(key)
    if (id === null) return null
    const raw = botsRaw[key]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const text = memBounded(raw.text ?? '', 64 * 1024)
    if (text === null) return null
    const bot = { text }
    if (raw.truncated !== undefined) {
      if (typeof raw.truncated !== 'boolean') return null
      bot.truncated = raw.truncated
    }
    bots[id] = bot
  }
  const out = { seq: o.seq, team, node, bots }
  if (o.truncated !== undefined) {
    if (typeof o.truncated !== 'boolean') return null
    out.truncated = o.truncated
  }
  if (o.truncatedAt !== undefined) {
    if (!Number.isInteger(o.truncatedAt) && typeof o.truncatedAt !== 'string') return null
    out.truncatedAt = o.truncatedAt
  }
  return out
}

/** mem/ack：`{seq}`；seq 必须是既有的非负整数，绝不接受 NaN/字符串。 */
export function validateMemAck(d) {
  const o = memPlain(d)
  if (!o) return null
  if (!Number.isInteger(o.seq) || o.seq < 0) return null
  return { seq: o.seq }
}
