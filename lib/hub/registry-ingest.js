/**
 * NodeRegistry 的「上行帧处理」职责（P1-4 自 node-registry.js 拆出）。
 *
 * 以 mixin 形式合入：`class NodeRegistry extends withIngest(NodeRegistryCore)`。
 * 这是**纯搬移** —— 四个方法体与拆分前的 node-registry.js 一字不差，行为由
 * 652 条既有测试整体兜底（task/sync 对账、资源遥测摄入、产物分块路由等都在
 * 这段里）。搬出动机：帧摄入是「协议→注册表状态」的翻译层，与注册表的
 * 连接管理/视图查询是两种变更节奏，混在一个 1465 行的文件里没法读。
 *
 * this.* 依赖面（全部由 NodeRegistryCore 提供）：
 *   nodes / tasks / limits / log / pulls / send / ensureTask / resolveWaiters
 */
import {
  ERROR_CODE,
  HUB_TO_NODE,
  MAX_MEMORY_FRAME_BYTES,
  MEMORY,
  NODE_TO_HUB,
  TASK_STATUS,
  TERMINAL_STATUS,
  validateBotTurnResult,
  validateBotTrace,
  validateBotStream,
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
  validateBotLocateResult,
  validateMemAck,
  validateMemRead,
  validateMemWrite,
  validateNodeConfigResult,
  validateApprovalRequest,
  validateApprovalSettled,
  validateJobsFrame,
} from '../protocol.js'
import { E2E_MARKER } from '../e2e.js'
import { errText, numOr } from './hub-util.js'
import { cleanRosterBots, cleanRosterSkills } from '../roster-report.js'
import { checkUplinkE2EGate } from '../node/transport.js'

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

export function withIngest(Base) {
  return class extends Base {
    /**
     * 结果帧校验不过：记审计，并在能确定是哪个回合时回一个失败结果。
     * 失败结果的 nodeId 用认证连接名 —— 该节点只能判自己的回合失败。
     */
    rejectTurnResult(nodeId, d, reason) {
      const exchangeId = typeof d?.exchangeId === 'string' ? d.exchangeId.trim() : ''
      const remoteBotId = typeof d?.remoteBotId === 'string' ? d.remoteBotId.trim() : ''
      this.log('warn', 'bot/turn-result rejected', { nodeId, reason, exchangeId })
      this.auditRecord?.('ingest.rejected', { frame: 'bot/turn-result', reason, connection: nodeId, exchangeId, remoteBotId })
      if (exchangeId === '') return
      try {
        this.emit('botTurnResult', { nodeId, remoteBotId, exchangeId, text: '', ok: false, error: `ingest-rejected:${reason}` })
      } catch { /* a listener must not take the ingest path down */ }
    }

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
     * 名册清洗丢掉了什么：被丢的整条（无 id / remote-worker / 超上限）与被丢的键名。
     * 每个节点每分钟最多一条 warn —— ds-bot 每 5 秒重发一次名册，不能刷屏，但也不能静默。
     */
    noteRosterDrops(nodeId, rawBots, cleaned) {
      const dropped = new Set()
      let skipped = 0
      const byId = new Map(cleaned.map((b) => [b.id, b]))
      for (const raw of rawBots) {
        const id = raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id.trim().slice(0, 200) : ''
        const kept = id !== '' ? byId.get(id) : undefined
        if (!kept) { skipped += 1; continue }
        for (const key of Object.keys(raw)) if (!(key in kept)) dropped.add(key)
      }
      if (dropped.size === 0 && skipped === 0) return
      this.rosterDropLogAt ??= new Map()
      const now = Date.now()
      if (now - (this.rosterDropLogAt.get(nodeId) ?? -Infinity) < 60_000) return
      this.rosterDropLogAt.set(nodeId, now)
      this.log('warn', 'roster entries were cleaned', { nodeId, droppedKeys: [...dropped].sort().slice(0, 20), skippedEntries: skipped })
    }

    /**
     * 回执帧（bot/*-result）校验不过：warn + 审计，并在 requestId 可解析时立刻按失败
     * 结算请求方（发出和正常回执同名的事件，ok:false + 校验错误），而不是让它等到超时。
     * nodeId 用认证连接名。
     */
    rejectResult(nodeId, type, d, error, eventName) {
      this.log('warn', `${type} rejected`, { nodeId, error })
      this.auditRecord?.('ingest.rejected', { nodeId, type, error })
      const requestId = typeof d?.requestId === 'string' ? d.requestId.trim() : ''
      if (requestId === '' || requestId.length > 200) return
      try {
        const failed = { requestId, nodeId, ok: false, error: `ingest-rejected:${error}` }
        if (eventName === 'botStopResult') failed.stopped = false // same shape as a real stop result
        this.emit(eventName, failed)
      } catch { /* a listener must not take the ingest path down */ }
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
      let wasEncrypted = false
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
        wasEncrypted = true
      }

      // 上行 E2E 闸（与节点侧 checkE2EGate 对称）：会话一旦建立，会话/控制类帧
      // 必须是密文。明文到这里 = 中继伪造或降级，整帧丢弃 + 审计 + 回 e2e-required。
      // rec.e2eStale：节点用新连接重新 hello 之后、新会话建好之前，上一连接的旧会话
      // 不再代表这条链路（节点本端已重置），此时不闸，等新握手。
      // meta.peer：这帧来自节点↔hub 的直连 peer 链路（自带加密与认证，见 peer-link.js），
      // 不走 hub 会话密钥，所以不适用本闸。
      if (rec?.e2e && !rec.e2eStale && meta.peer !== true) {
        const gate = checkUplinkE2EGate(frame, { e2e: true, wasEncrypted })
        if (gate.rejected) {
          this.log('warn', 'plaintext uplink frame rejected (e2e session active)', { nodeId, type: frame.t })
          this.auditRecord?.('ingest.rejected', { nodeId, type: frame.t, reason: ERROR_CODE.E2E_REQUIRED })
          this.send(nodeId, HUB_TO_NODE.ERROR, { code: gate.code, message: gate.message })
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
          if (t.status === d.handoff?.status && TERMINAL_STATUS.has(t.status)) {
            try { this.onTaskTerminal?.({ taskId: t.taskId, status: t.status, reason: d.handoff.error?.code }) } catch {}
          }
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
          this.assignmentLedger?.record(t)
          if (typeof d.durationMs === 'number') t.durationMs = d.durationMs
          if (d.error && typeof d.error === 'object') t.error = d.error
          if (d.manifestCounts && typeof d.manifestCounts === 'object') t.manifestCounts = d.manifestCounts
          t.updatedAt = Date.now()
          this.log('info', 'task ended', { taskId: t.taskId, nodeId, status: t.status })
          // 任务终态事件广播（供 ds-bot worker-bridge 的 waitForTask 订阅）
          try { this.emit('taskEnd', { taskId: t.taskId, nodeId, status: t.status, exitCode: t.exit?.code, summary: t.summary?.text }) } catch {}
          this.resolveWaiters(t)
          // A conflicting frame cannot confirm a local terminal view (e.g. node-unreachable).
          if (t.status === d.status && TERMINAL_STATUS.has(t.status)) {
            try { this.onTaskTerminal?.({ taskId: t.taskId, status: t.status, reason: d.error?.code }) } catch {}
          }
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
            const rawBots = Array.isArray(d.bots) ? d.bots : []
            // One cleaned list for everything downstream: the stored roster AND the 'roster' event
            // (ds-bot applies the event). Before, the event carried the raw entries while the store
            // held the cleaned ones, so the two disagreed on caps, truncation and dropped bots.
            const bots = cleanRosterBots(rawBots)
            this.noteRosterDrops(nodeId, rawBots, bots)
            const report = {
              nodeId,
              hostname: typeof d.hostname === 'string' ? d.hostname : '',
              bots,
              online: true,
            }
            if (Array.isArray(d.trimmed) && d.trimmed.length > 0) {
              report.trimmed = d.trimmed.filter((x) => typeof x === 'string').slice(0, 8)
              this.log('warn', 'roster frame was trimmed by the node to fit its byte budget', { nodeId, trimmed: report.trimmed })
            }
            // 名册落到已有的节点记录上（只认已握手的节点；未知节点不建影子记录）。
            // 离线时不清除 —— rosterList() 会把它标成 online:false，保留最后一份。
            const known = this.nodes.get(nodeId)
            if (known) {
              known.roster = { hostname: report.hostname, bots, at: Date.now() }
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
            if (sent === false && assign.op === 'deliver') {
              this.send(nodeId, HUB_TO_NODE.BOT_ASSIGN, { op: 'bounce', frameId: assign.frameId, from: assign.to, to: assign.from, reason: 'send-failed', at: Date.now() })
            }
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
          // 这条帧是页面回合的唯一出口：丢了，主控那边的回合就悬到超时。所以每条
          // 丢弃路径都写一条会落盘的审计记录（audit.jsonl），能回答"结果到没到、
          // 被谁丢的"；能安全告诉 ds-bot 的，同时回一个明确的失败结果。
          const checked = validateBotTurnResult(d)
          if (!checked.ok) {
            this.rejectTurnResult(nodeId, d, `invalid:${checked.error}`)
            return
          }
          // 回合结果同样必须落在认证连接名下；冒名帧整帧丢弃，不改写。
          // 这里**不**替冒名的一方回失败：waiter 按 nodeId 过滤，用连接名发出去
          // 也到不了它；用声称的名字发，等于让一个节点能替另一个节点判回合失败。
          if (checked.result.nodeId !== nodeId) {
            this.log('warn', 'peer-node-mismatch', { connection: nodeId, claimed: checked.result.nodeId, frame: 'bot/turn-result' })
            this.auditRecord?.('ingest.rejected', { frame: 'bot/turn-result', reason: 'node-mismatch', connection: nodeId, claimed: checked.result.nodeId, exchangeId: checked.result.exchangeId })
            return
          }
          if (rec?.hello?.peerUrl) {
            const origin = this.peerTurnOrigins?.get(JSON.stringify([nodeId, checked.result.exchangeId]))
            // The reply target comes from what the hub registered when it routed the turn
            // (peerTurnOrigins), never from the node: `peerReplyTo` is node-supplied, so honouring it
            // would let a node push a forged result at any peer. A claim that disagrees with the
            // registered origin is ignored, with a warn and an audit record.
            const target = origin && Date.now() - origin.at < 300_000 ? origin.nodeId : ''
            if (typeof d.peerReplyTo === 'string' && d.peerReplyTo !== '' && d.peerReplyTo !== target) {
              this.log('warn', 'peerReplyTo ignored: not a registered turn origin', { nodeId, claimed: d.peerReplyTo, exchangeId: checked.result.exchangeId })
              this.auditRecord?.('ingest.rejected', { nodeId, type: 'bot/turn-result', error: 'peer-reply-to-unregistered', claimed: d.peerReplyTo, exchangeId: checked.result.exchangeId })
            }
            if (target && this.nodes.get(target)?.hello?.peerUrl && this.nodes.get(target)?.online) {
              const forwarded = this.send(target, NODE_TO_HUB.BOT_TURN_RESULT, checked.result) === true
              this.auditRecord?.('ingest.forwarded', { frame: 'bot/turn-result', from: nodeId, to: target, exchangeId: checked.result.exchangeId, delivered: forwarded })
              if (forwarded) return
              // 转发没发出去：落回本地 emit，总比让回合悬着强。
              this.log('warn', 'turn-result forward failed; delivering locally', { from: nodeId, to: target })
            }
          }
          this.auditRecord?.('ingest.turn-result', { nodeId, remoteBotId: checked.result.remoteBotId, exchangeId: checked.result.exchangeId, ok: checked.result.ok !== false, seq: checked.result.seq })
          try { this.emit('botTurnResult', { ...checked.result, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_TRACE: {
          // 节点 Bot 的思考过程与工具步骤（bot-trace/1）。只是页面的附加显示：坏帧不让回合失败，
          // 只记 warn 与审计；真正的权威是 bot/turn-result 的文本，trace 缺了页面照样有答案。
          const checked = validateBotTrace(d)
          if (!checked.ok) {
            this.log('warn', 'bot/trace rejected', { nodeId, error: checked.error })
            this.auditRecord?.('ingest.rejected', { frame: 'bot/trace', reason: `invalid:${checked.error}`, connection: nodeId })
            return
          }
          const trace = checked.trace
          // 与回合结果同口径：必须落在认证连接名下，冒名帧整帧丢弃。
          if (trace.nodeId !== nodeId) {
            this.log('warn', 'peer-node-mismatch', { connection: nodeId, claimed: trace.nodeId, frame: 'bot/trace' })
            this.auditRecord?.('ingest.rejected', { frame: 'bot/trace', reason: 'node-mismatch', connection: nodeId, claimed: trace.nodeId, exchangeId: trace.exchangeId })
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

        case NODE_TO_HUB.BOT_STREAM: {
          // 节点 Bot 的流式文本增量（bot-stream/1）。只是页面的附加显示，坏帧不让回合失败。
          const checked = validateBotStream(d)
          if (!checked.ok) {
            this.log('warn', 'bot/stream rejected', { nodeId, error: checked.error })
            return
          }
          const stream = checked.stream
          if (stream.nodeId !== nodeId) {
            this.log('warn', 'peer-node-mismatch', { connection: nodeId, claimed: stream.nodeId, frame: 'bot/stream' })
            return
          }
          try { this.emit('botStream', { ...stream, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_CREATE_RESULT: {
          const checked = validateBotCreateResult(d)
          if (!checked.ok) { this.rejectResult(nodeId, frame.t, d, checked.error, 'botCreateResult'); return }
          try { this.emit('botCreateResult', { ...checked.result, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_HISTORY_RESULT: {
          const checked = validateBotHistoryResult(d)
          if (!checked.ok) { this.rejectResult(nodeId, frame.t, d, checked.error, 'botHistoryResult'); return }
          try { this.emit('botHistoryResult', { ...checked.result, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_UPDATE_RESULT: {
          const checked = validateBotUpdateResult(d)
          if (!checked.ok) { this.rejectResult(nodeId, frame.t, d, checked.error, 'botUpdateResult'); return }
          try { this.emit('botUpdateResult', { ...checked.result, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_DELETE_RESULT: {
          const checked = validateBotDeleteResult(d)
          if (!checked.ok) { this.rejectResult(nodeId, frame.t, d, checked.error, 'botDeleteResult'); return }
          try { this.emit('botDeleteResult', { ...checked.result, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_STOP_RESULT: {
          const checked = validateBotStopResult(d)
          if (!checked.ok) { this.rejectResult(nodeId, frame.t, d, checked.error, 'botStopResult'); return }
          try { this.emit('botStopResult', { ...checked.result, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_ACTION_RESULT: {
          const checked = validateBotActionResult(d)
          if (!checked.ok) { this.rejectResult(nodeId, frame.t, d, checked.error, 'botActionResult'); return }
          try { this.emit('botActionResult', { ...checked.result, nodeId }) } catch { /* a listener must not take the ingest path down */ }
          return
        }

        case NODE_TO_HUB.BOT_LOCATE_RESULT: {
          // Verified by locateBot (lib/hub/bot-locate.js); nodeId is the authenticated connection.
          const checked = validateBotLocateResult(d)
          if (!checked.ok) { this.rejectResult(nodeId, frame.t, d, checked.error, 'botLocateResult'); return }
          try { this.emit('botLocateResult', { ...checked.result, nodeId }) } catch { /* a listener must not take the ingest path down */ }
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

        case NODE_TO_HUB.APPROVAL_REQUEST: {
          // 审批中继：节点上 ds-bot 把待批工具调用上报到主控面板。
          // 连接身份优先：载荷 nodeId 不一致整帧丢。
          const checked = validateApprovalRequest(d)
          if (!checked.ok) {
            this.log('warn', 'node/approval-request invalid', { nodeId, error: checked.error })
            return
          }
          if (checked.req.nodeId !== nodeId) {
            this.log('warn', 'node/approval-request identity mismatch', { connection: nodeId, claimed: checked.req.nodeId })
            return
          }
          try { this.emit('approvalRequest', checked.req) } catch { /* must not take ingest down */ }
          return
        }

        case NODE_TO_HUB.APPROVAL_SETTLED: {
          // 审批已被其他路径（abort/超时/卡牌）结算，通知主控撤销 pending 条目。
          const checked = validateApprovalSettled(d)
          if (!checked.ok) {
            this.log('warn', 'node/approval-settled invalid', { nodeId, error: checked.error })
            return
          }
          if (checked.settled.nodeId !== nodeId) {
            this.log('warn', 'node/approval-settled identity mismatch', { connection: nodeId, claimed: checked.settled.nodeId })
            return
          }
          try { this.emit('approvalSettled', checked.settled) } catch { /* must not take ingest down */ }
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
          if (d.code === 'e2e-not-ready' && typeof d.droppedId === 'string' && d.droppedId !== '') {
            // 节点丢弃了一帧（E2E 未建立时收到加密帧）并告知 hub。
            // 如果被丢的是 bot/turn，合成一个 bridge-down 结果让主控不必等到超时。
            this.log('warn', 'node dropped encrypted frame (e2e not ready)', { nodeId, droppedType: d.droppedType, droppedId: d.droppedId })
            if (d.droppedType === HUB_TO_NODE.BOT_TURN) {
              try {
                this.emit('botTurnResult', {
                  nodeId,
                  exchangeId: this.turnEnvelopes?.get(d.droppedId) ?? d.droppedId,
                  ok: false,
                  error: 'bridge-down',
                  text: '',
                  seq: 0,
                })
              } catch { /* must not take ingest down */ }
            }
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
      const ledger = this.assignmentLedger
      const updated = ledger ? new Set() : undefined
      const seen = new Set()
      for (const view of list) {
        if (!view || typeof view.taskId !== 'string') continue
        seen.add(view.taskId)
        const t = this.ensureTask(nodeId, view.taskId)
        if (!t) continue
        this.applyView(t, view)
        updated?.add(t)
      }
      if (updated) {
        for (const t of updated) ledger.record(t)
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
