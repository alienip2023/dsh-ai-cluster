/**
 * wire/session-framing：心跳/重连/E2E 门的**纯**辅助（取自 lib/node/transport.js）。
 * NodeTransport 类本身不在此；它属于后续 link 切片。
 */
import { HUB_TO_NODE, MEMORY, MEMORY_INBOUND_BODY, NODE_TO_HUB, PEER } from './frames.js'
import { ERROR_CODE } from './errors.js'

export const TRANSPORT_MODE = Object.freeze({ DIRECT: 'direct', RELAY: 'relay' })

/**
 * fork.61：duplicate-node 的重试预算。
 *
 * 为什么不再当致命错误：节点进程重启（配置推送后的 scheduleRestart 就是）时，
 * 中继还留着旧进程的记录（旧连接的 close 要晚到几秒），新连接因此被回
 * duplicate-node。这是一个几秒内自愈的竞态，不是配置错误。
 *
 * 高频阶段默认 1s/2s/4s/8s/16s/16s/…，累计（不含抖动）不超过 600s（约 10 分钟，约 40 次重连）；
 * 预算耗尽后按较慢的固定间隔继续探测，不再 stop()：旧进程可能更晚才退出。
 * 预算按「计划等待时间」累加而不是读时钟，这样行为可确定地测试。
 *
 * 为什么是 600s（fork.62，原 fork.61 为 120s）：中继对「没有 FIN 的旧连接」要靠空闲淘汰
 * 才会清掉记录——空闲 idleMs(3min) 发 ping，再等 idleMs 仍无回应才 destroy，加上扫描
 * 间隔 sweepMs(1min)，最坏约 7 分钟。120s 的预算在旧记录消失之前就 fatal 了（验收官用
 * 缩比中继实测：同比 120s 预算在 623ms 就停，3000ms 预算则成功）。
 */
export const DUPLICATE_RETRY_DEFAULTS = Object.freeze({ baseMs: 1000, maxMs: 16_000, totalMs: 600_000 })
const DUPLICATE_RETRY_TOTAL_CEILING_MS = 3_600_000

/** 合法 = 有限的正数（YAML 里写成字符串的数字不认）；非法的字段各自回退默认。 */
export function resolveDuplicateRetry(raw) {
  const d = DUPLICATE_RETRY_DEFAULTS
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0
  const baseMs = ok(src.baseMs) ? src.baseMs : d.baseMs
  let maxMs = ok(src.maxMs) ? src.maxMs : d.maxMs
  if (maxMs < baseMs) maxMs = baseMs
  const totalMs = ok(src.totalMs) && src.totalMs <= DUPLICATE_RETRY_TOTAL_CEILING_MS ? src.totalMs : d.totalMs
  return { baseMs, maxMs, totalMs }
}

/** 第 n 次（从 1 起）duplicate 重试的基础等待（不含抖动）。 */
export function duplicateBackoffMs(n, cfg = DUPLICATE_RETRY_DEFAULTS) {
  const k = Math.max(1, Math.floor(n))
  return Math.min(cfg.baseMs * 2 ** Math.min(k - 1, 30), cfg.maxMs)
}
/**
 * P2-11：relay 模式下等 hub 追发身份帧的宽限窗口。
 * direct 模式不需要它 —— 身份就在 welcome 里，随握手一起到。
 */
export const IDENTITY_GRACE_MS = 15_000
/** hub 身份帧时间戳容差：双方时钟各让 5 分钟。 */
export const IDENTITY_MAX_SKEW_MS = 5 * 60 * 1000

/**
 * 提案 #1：会话建立后**必须加密**的下行业务帧类型。
 * 明文形态出现在这里 = 伪造（中继运营者持有 enrollToken 可冒充 hub）或
 * hub 丢失会话 —— 一律拒绝执行并回 e2e-required。
 * welcome / hub/identity / error / ping / hub/e2e 是握手与控制面，永远明文豁免。
 */
const E2E_REQUIRED_TYPES = new Set([
  PEER.DIRECTORY,
  NODE_TO_HUB.BOT_TURN_RESULT,
  HUB_TO_NODE.TASK_START,
  // 名单第 2 步：bot/turn 带会话正文，必须加密。
  HUB_TO_NODE.BOT_TURN,
  HUB_TO_NODE.BOT_DIRECTORY,
  HUB_TO_NODE.BOT_MESSAGE,
  HUB_TO_NODE.TASK_CANCEL,
  HUB_TO_NODE.TASK_QUERY,
  HUB_TO_NODE.ARTIFACT_LIST,
  HUB_TO_NODE.ARTIFACT_PULL,
  HUB_TO_NODE.ARTIFACT_CANCEL,
  // 远程文件请求（提案 #25）：目录结构与文件内容是敏感信息，必须加密。
  HUB_TO_NODE.FS_REQ,
  // 工作区共享请求（2026-10-17）：帧里含工作区**绝对路径**（暴露副机的
  // 目录结构），必须加密。
  HUB_TO_NODE.SHARE_REQ,
  // 名单第 3 步：bot/create 携带 modelRef / workDir / instructions，必须加密。
  HUB_TO_NODE.BOT_CREATE,
  HUB_TO_NODE.BOT_HISTORY,
  HUB_TO_NODE.BOT_UPDATE,
  // 停掉节点上的 Bot 回合：帧里带 Bot 身份，与其它 bot/* 帧同口径。
  HUB_TO_NODE.BOT_STOP,
  HUB_TO_NODE.BOT_STEER,
  // 主控对节点 Bot 的界面操作：params 里是用户的回答原文，必须加密。
  HUB_TO_NODE.BOT_ACTION,
  // 主控发给节点 Bot 的图片/文件分块：用户附件原文，必须加密。
  HUB_TO_NODE.BOT_ATTACH,
  // 并发上限下发：与其它控制帧同口径（帧里带节点身份）。
  HUB_TO_NODE.NODE_CONFIG,
  // 节点删除 Bot：帧里带 Bot 身份与请求号，与其它 bot/* 帧同口径。
  HUB_TO_NODE.BOT_DELETE,
  // 模型同步：帧里带节点身份与模型 ref，必须加密。
  HUB_TO_NODE.MODEL_SYNC,
  // 模型同步回执：加密发送与其它控制面回执同口径。
  NODE_TO_HUB.MODEL_SYNC_RESULT,
  // 审批答复（hub → node）：帧里带 Bot 身份与审批结果，必须加密。
  HUB_TO_NODE.APPROVAL_ANSWER,
  // 审批请求 / 结算（node → hub）：含 Bot 工具调用细节（文件路径/命令），必须加密。
  NODE_TO_HUB.APPROVAL_REQUEST,
  NODE_TO_HUB.APPROVAL_SETTLED,
  // 节点回执（bot/* 与 node/config）：result 里带 Bot 数据与用户回答原文，必须加密。
  NODE_TO_HUB.BOT_CREATE_RESULT,
  NODE_TO_HUB.BOT_HISTORY_RESULT,
  NODE_TO_HUB.BOT_UPDATE_RESULT,
  NODE_TO_HUB.BOT_DELETE_RESULT,
  NODE_TO_HUB.BOT_STOP_RESULT,
  NODE_TO_HUB.BOT_ACTION_RESULT,
  NODE_TO_HUB.NODE_CONFIG_RESULT,
  // bot/trace：节点 Bot 的推理与工具参数 / 输出正文，必须加密（上行表同样要有，hub 才会拒收明文）。
  NODE_TO_HUB.BOT_TRACE,
  // bot/stream：节点 Bot 的流式文本增量，含会话正文，必须加密。
  NODE_TO_HUB.BOT_STREAM,
  // M2：config-push 携带 apiKey 明文，必须加密。
  HUB_TO_NODE.CONFIG_PUSH,
  // T9a：peer roster 暴露主控的 Bot 名单，必须加密。
  HUB_TO_NODE.PEER_ROSTER,
  // M4：整个 mem/* 家族都进必加密集合（快照与读写结果就是用户正文）。
  ...Object.values(MEMORY),
])

/**
 * 判断一个帧类型是否必须加密。导出给测试和审计代码使用。
 * 刀：从 E2E_REQUIRED_TYPES 删掉 BOT_CREATE → isE2ERequired('bot/create') 返回 false → 测试红。
 */
export function isE2ERequired(type) {
  return E2E_REQUIRED_TYPES.has(type)
}

/**
 * 会话建立后 **node → hub** 必须加密的帧类型（hub 侧入站闸，与上面的下行表镜像）。
 *
 * 为什么另立一张表：下行表（E2E_REQUIRED_TYPES）是「节点拒收哪些明文」；这里是
 * 「hub 拒收哪些明文」。节点在会话就绪后发出的一切帧都封密（见 sendRaw 的
 * E2E_CLEAR_TYPES），所以会话就绪后 hub 看到明文的会话/控制帧 = 中继伪造或降级。
 * 豁免（永远可明文）：hello、hello/node、ping/pong、error、node/e2e 握手提议、
 * hub/config-sync-request（只带已应用 revision，无正文）；这些都不在表里。
 * 遥测（node/resource、node/connectivity）不带会话/控制正文，也不在表里。
 */
const E2E_REQUIRED_UPLINK_TYPES = new Set([
  NODE_TO_HUB.TASK_SYNC,
  NODE_TO_HUB.TASK_ACCEPT,
  NODE_TO_HUB.TASK_PROGRESS,
  NODE_TO_HUB.TASK_SUMMARY,
  NODE_TO_HUB.TASK_END,
  NODE_TO_HUB.ARTIFACT_MANIFEST,
  NODE_TO_HUB.JOBS,
  NODE_TO_HUB.REPOS,
  NODE_TO_HUB.FS_RES,
  NODE_TO_HUB.SHARE_RES,
  NODE_TO_HUB.ROSTER,
  NODE_TO_HUB.BOT_TURN_RESULT,
  NODE_TO_HUB.BOT_MESSAGE,
  NODE_TO_HUB.BOT_CREATE_RESULT,
  NODE_TO_HUB.BOT_HISTORY_RESULT,
  NODE_TO_HUB.BOT_UPDATE_RESULT,
  NODE_TO_HUB.BOT_DELETE_RESULT,
  NODE_TO_HUB.BOT_STOP_RESULT,
  NODE_TO_HUB.BOT_ACTION_RESULT,
  NODE_TO_HUB.NODE_CONFIG_RESULT,
  NODE_TO_HUB.CONFIG_ACK,
  NODE_TO_HUB.MODEL_SYNC_RESULT,
  NODE_TO_HUB.APPROVAL_REQUEST,
  NODE_TO_HUB.APPROVAL_SETTLED,
  // 节点间 Bot 回合经 hub 转发时，origin 节点以 bot/turn 上行（带会话正文）。
  HUB_TO_NODE.BOT_TURN,
  // bot/trace：见下行表同名条目。
  NODE_TO_HUB.BOT_TRACE,
  // bot/stream：节点 Bot 的流式文本增量，含会话正文，必须加密。
  NODE_TO_HUB.BOT_STREAM,
  ...Object.values(MEMORY),
])

export function isE2ERequiredUplink(type) {
  return E2E_REQUIRED_UPLINK_TYPES.has(type)
}

/**
 * hub 侧入站闸（纯函数）：会话已建立时，上行的明文会话/控制帧一律拒绝。
 * 会话尚未建立（`e2e` 为假）永远放行 —— 与旧节点、关闭 e2e 的节点混跑。
 *
 * @param {{ t: string }} frame
 * @param {{ e2e: boolean, wasEncrypted: boolean }} opts
 */
export function checkUplinkE2EGate(frame, { e2e, wasEncrypted }) {
  if (e2e && !wasEncrypted && E2E_REQUIRED_UPLINK_TYPES.has(frame?.t)) {
    return {
      rejected: true,
      code: ERROR_CODE.E2E_REQUIRED,
      message: `unencrypted ${frame.t} rejected while e2e session active`,
    }
  }
  return { rejected: false }
}

/**
 * 纯函数：判断入站帧是否应被 E2E 门拒绝。
 * 抽出来让测试可以直接调用，不依赖 WebSocket 基础设施。
 * 刀：把 wasEncrypted 去掉（恒 true）→ 即使明文帧也通过 → 测试红。
 *
 * @param {{ t: string }} frame 入站帧
 * @param {{ e2e: boolean, wasEncrypted: boolean }} opts
 * @returns {{ rejected: true, code: string, message: string } | { rejected: false }}
 */
const MEMORY_BODY_INBOUND = new Set(MEMORY_INBOUND_BODY)

export function checkE2EGate(frame, { e2e, wasEncrypted }) {
  // M4：记忆正文只允许经过 E2E。会话未建立时连「明文 + 未加密」这一档都不接受
  // —— hello/ack 这类控制帧不在本表里，仍可通行。
  if (!e2e && MEMORY_BODY_INBOUND.has(frame?.t)) {
    return {
      rejected: true,
      code: ERROR_CODE.E2E_REQUIRED,
      message: `${frame.t} requires an e2e session`,
    }
  }
  if (e2e && !wasEncrypted && E2E_REQUIRED_TYPES.has(frame.t)) {
    return {
      rejected: true,
      code: ERROR_CODE.E2E_REQUIRED,
      message: `unencrypted ${frame.t} rejected while e2e session active`,
    }
  }
  return { rejected: false }
}

/** 把各种写法收敛成 ws:// 或 wss:// 的 URL。 */
export function normalizeWsUrl(raw, fallbackPath = '/') {
  if (typeof raw !== 'string' || raw.trim() === '') return ''
  let s = raw.trim()
  if (!/^wss?:\/\//i.test(s)) {
    if (/^https:\/\//i.test(s)) s = `wss://${s.slice(8)}`
    else if (/^http:\/\//i.test(s)) s = `ws://${s.slice(7)}`
    else s = `ws://${s}`
  }
  try {
    const u = new URL(s)
    if (u.pathname === '/' || u.pathname === '') u.pathname = fallbackPath
    return u.toString()
  } catch {
    return ''
  }
}

