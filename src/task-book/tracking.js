/**
 * 主控侧任务账本（L4-2 task-book）：NodeRegistry 的「任务跟踪」半边。
 *
 * 来源：lib/hub/node-registry.js 的 ensureTask(313) / getTask(355) / listTasks(359) /
 * taskView(373) / waitFor(396) / awaitAccepted(440) / awaitTerminal(451) /
 * resolveWaiters(461) / createTask(477) / cancelTask(587) / approveTask(616) /
 * rejectTask(671) / purgeTasks(721) —— 方法体逐字搬运，只做 mixin 包装。
 * 连接半边（send / markOffline / tick / fs/share 请求 …）不在此处，留给 roster 切片。
 *
 * 宿主需提供：this.nodes / this.tasks / this.limits / this.pendingApprovals /
 * this.send / this.log / this.auditRecord。
 * 偏差：taskView 依赖的 lib/hub/views.js 不在允许导入范围，改为由装配方注入
 * `taskProjection`（签名与 views.js taskView 相同）。
 */
import {
  ERROR_CODE,
  HUB_TO_NODE,
  RemoteAgentError,
  TASK_STATUS,
  TERMINAL_STATUS,
} from '../wire/index.js'

export function withTaskTracking(Base, { taskProjection } = {}) {
  if (typeof taskProjection !== 'function') throw new TypeError('withTaskTracking: taskProjection is required')
  return class TaskTracking extends Base {
    ensureTask(nodeId, taskId) {
      if (typeof taskId !== 'string' || taskId === '') {
        this.log('warn', 'frame without taskId', { nodeId })
        return undefined
      }
      const existing = this.tasks.get(taskId)
      if (existing) return existing
      const rec = this.nodes.get(nodeId)
      if (!rec) return undefined
      const t = {
        taskId,
        nodeId,
        spec: null,
        status: TASK_STATUS.QUEUED,
        accepted: false,
        adopted: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: null,
        endedAt: null,
        durationMs: null,
        mode: null,
        goal: null,
        workspace: null,
        sessionId: null,
        exit: null,
        changed: [],
        error: null,
        summary: null,
        manifestCounts: null,
        manifest: null,
        handoff: null,
        progressTail: [],
        logTail: [],
        waiters: new Set(),
      }
      rec.tasks.set(taskId, t)
      this.tasks.set(taskId, t)
      this.log('info', 'task adopted from node report', { taskId, nodeId })
      return t
    }
  
    getTask(taskId) {
      return this.tasks.get(taskId)
    }
  
    listTasks() {
      return [...this.tasks.values()]
    }
  
    /**
     * 工具 remote_status 的输出形状。
     *
     * **必须经 views.js 投影**：这里的每个字段都源自副机上报（`exit`/`changed`/
     * `summary`/`error` 里可能有副机版本的诊断字段），而工具返回值会进会话日志。
     * 此前是逐字段裸拷贝（`exit: t.exit` 等），等于把"副机写什么就回什么"交给模型。
     *
     * 与 UI 路径共用同一份白名单 —— 这是把投影收敛到 views.js 的意义：
     * 新增消费方无处可绕开。
     */
    taskView(t) {
      const rec = this.nodes.get(t.nodeId)
      const base = taskProjection(
        {
          ...t,
          nodeOnline: Boolean(rec?.online),
          // taskProjection 读 t.summary.text，而注册表里存的是 summary 对象
          summary: t.summary && typeof t.summary === 'object' ? t.summary : null,
        },
        { tail: 6 },
      )
      return {
        ...base,
        accepted: t.accepted === true,
        handoffAvailable: Boolean(t.handoff),
      }
    }
  
    // ─────────────────────────── 等待器 ───────────────────────────
  
    /**
     * 等一个任务满足条件。超时与取消都会 reject，且一定清理定时器与监听器。
     */
    waitFor(t, predicate, { timeoutMs = 0, signal, label = 'wait' } = {}) {
      if (predicate(t)) return Promise.resolve(t)
      return new Promise((resolve, reject) => {
        const state = { settled: false, timer: undefined, onAbort: undefined }
        const waiter = { check: () => {}, fail: () => {} }
        const settle = (fn, arg) => {
          if (state.settled) return
          state.settled = true
          if (state.timer) clearTimeout(state.timer)
          if (state.onAbort && signal) {
            try {
              signal.removeEventListener('abort', state.onAbort)
            } catch {
              /* signal 可能已失效 */
            }
          }
          t.waiters.delete(waiter)
          fn(arg)
        }
        waiter.check = () => {
          if (predicate(t)) settle(resolve, t)
        }
        waiter.fail = (err) => settle(reject, err)
  
        if (timeoutMs > 0) {
          state.timer = setTimeout(() => {
            settle(reject, new RemoteAgentError(`${label}: timeout after ${timeoutMs}ms`, ERROR_CODE.INTERNAL))
          }, timeoutMs)
          if (state.timer.unref) state.timer.unref()
        }
        if (signal) {
          state.onAbort = () => settle(reject, new RemoteAgentError(`${label}: aborted`, 'aborted'))
          if (signal.aborted) {
            state.onAbort()
            return
          }
          signal.addEventListener('abort', state.onAbort, { once: true })
        }
        t.waiters.add(waiter)
        if (predicate(t)) waiter.check()
      })
    }
  
    /** 等 task/accept（或任务直接进入终态 —— 例如工作区被拒）。 */
    awaitAccepted(taskId, opts = {}) {
      const t = this.tasks.get(taskId)
      if (!t) return Promise.reject(new RemoteAgentError(`unknown taskId: ${taskId}`, ERROR_CODE.TASK_UNKNOWN))
      return this.waitFor(t, (x) => x.accepted === true || TERMINAL_STATUS.has(x.status), {
        label: `task ${taskId} accept`,
        timeoutMs: opts.timeoutMs ?? this.limits.ackTimeoutMs,
        signal: opts.signal,
      })
    }
  
    /** 等任务进入终态。 */
    awaitTerminal(taskId, opts = {}) {
      const t = this.tasks.get(taskId)
      if (!t) return Promise.reject(new RemoteAgentError(`unknown taskId: ${taskId}`, ERROR_CODE.TASK_UNKNOWN))
      return this.waitFor(t, (x) => TERMINAL_STATUS.has(x.status), {
        label: `task ${taskId} terminal`,
        timeoutMs: opts.timeoutMs ?? 0,
        signal: opts.signal,
      })
    }
  
    resolveWaiters(t) {
      if (!t.waiters || t.waiters.size === 0) return
      for (const w of [...t.waiters]) {
        try {
          w.check()
        } catch {
          /* 单个等待者出错不影响其他 */
        }
      }
    }
  
    // ─────────────────────────── 任务下发 ───────────────────────────
  
    /**
     * 下发一条任务（spec 必须是 validateTaskStart 归一化后的形状）。
     */
    createTask({ nodeId, spec }) {
      const rec = this.nodes.get(nodeId)
      if (!rec) throw new RemoteAgentError(`unknown node: ${nodeId}`, ERROR_CODE.TASK_UNKNOWN)
      if (!rec.online) throw new RemoteAgentError(`node offline: ${nodeId}`, ERROR_CODE.INTERNAL)
  
      // ═══════════════════════════════════════════════════════════════════════
      // 上限必须按**在跑的任务**算，不能按历史累计
      // ═══════════════════════════════════════════════════════════════════════
      //
      // 原实现：`if (rec.tasks.size >= maxTasksPerNode)` —— 而 `rec.tasks` 里
      // **包含已完成的任务**：它们只在副机的 `task/sync` 不再上报时才被移除
      // （见 applySync 的清理分支），而副机的 TaskStore 默认保留 7 天。
      //
      // 后果（实测踩到）：连续派几十条测试任务后，hub 侧累计到 64 条，
      // **之后任何新任务都被拒**，报 `already holds 64 tasks` —— 连"派一条
      // 清理命令"都做不到，节点彻底不可用。这不是"限制并发"的本意。
      //
      // 正确语义：上限约束**同时进行的任务数**（防一个节点被压垮），
      // 终态任务不该占额度。这里按状态过滤。
      const activeCount = [...rec.tasks.values()].filter(
        (t) => t && !TERMINAL_STATUS.has(t.status),
      ).length
      if (activeCount >= this.limits.maxTasksPerNode) {
        throw new RemoteAgentError(
          `node ${nodeId} already has ${activeCount} active tasks (maxTasksPerNode=${this.limits.maxTasksPerNode})`,
          ERROR_CODE.INTERNAL,
        )
      }
      if (this.tasks.has(spec.taskId)) {
        throw new RemoteAgentError(`taskId already used: ${spec.taskId}`, ERROR_CODE.TASK_DUPLICATE)
      }
  
      const t = {
        taskId: spec.taskId,
        nodeId,
        spec,
        status: TASK_STATUS.QUEUED,
        accepted: false,
        adopted: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: null,
        endedAt: null,
        durationMs: null,
        mode: spec.mode,
        goal: spec.goal,
        approval: spec.approval === 'manual' ? 'manual' : 'auto',
        workspace: spec.workspace ?? null,
        sessionId: null,
        exit: null,
        changed: [],
        error: null,
        summary: null,
        manifestCounts: null,
        manifest: null,
        handoff: null,
        progressTail: [],
        logTail: [],
        waiters: new Set(),
      }
      rec.tasks.set(spec.taskId, t)
      this.tasks.set(spec.taskId, t)
  
      // 两阶段审批（提案 #2）：manual 任务**挂起在 hub**，不派帧 —— 副机根本
      // 不知道它的存在，直到面板批准。超时自动拒绝（fail-closed：等不到人
      // 就是不跑，绝不默认放行）；approvalTimeoutMs=0 表示无限等待。
      if (spec.approval === 'manual') {
        t.status = TASK_STATUS.PENDING_APPROVAL
        this.log('info', 'task pending approval', { taskId: spec.taskId, nodeId })
        this.auditRecord('approval.pending', {
          taskId: spec.taskId,
          nodeId,
          mode: spec.mode,
          goal: typeof spec.goal === 'string' ? spec.goal : '',
          timeoutMs: this.limits.approvalTimeoutMs,
        })
        if (this.limits.approvalTimeoutMs > 0) {
          const timer = setTimeout(() => {
            this.pendingApprovals.delete(spec.taskId)
            this.rejectTask(spec.taskId, { by: 'timeout', reason: 'approval-timeout' })
          }, this.limits.approvalTimeoutMs)
          if (timer.unref) timer.unref()
          this.pendingApprovals.set(spec.taskId, timer)
        }
        return t
      }
  
      const sent = this.send(nodeId, HUB_TO_NODE.TASK_START, { ...spec })
      if (!sent) {
        rec.tasks.delete(spec.taskId)
        this.tasks.delete(spec.taskId)
        throw new RemoteAgentError(`node unreachable: ${nodeId}`, ERROR_CODE.INTERNAL)
      }
      this.log('info', 'task dispatched', { taskId: spec.taskId, nodeId, mode: spec.mode })
      // 审计（提案 #19）：任务派发是"hub 替谁在哪台机器上跑了什么"的证据链起点。
      // 字段刻意保持扁平且过 sanitizeExtra（打码 + 400 字符截断）—— goal 可能
      // 含整段任务书，绝不能整段落盘。
      this.auditRecord('task.dispatch', {
        taskId: spec.taskId,
        nodeId,
        mode: spec.mode,
        workspace: typeof spec.workspace === 'string' ? spec.workspace : '',
        goal: typeof spec.goal === 'string' ? spec.goal : '',
        outputsCount: Array.isArray(spec.outputs) ? spec.outputs.length : 0,
        timeoutMs: spec.constraints?.timeoutMs,
      })
      return t
    }
  
    /** 取消任务。找不到 / 节点不在线都返回 false，不抛。 */
    cancelTask(taskId) {
      const t = this.tasks.get(taskId)
      if (!t) return false
      // 审批挂起中的任务还没到副机：发 TASK_CANCEL 只会换来 unknown taskId。
      // 直接本地拒绝（终态 rejected），副作用一致、语义更真。
      if (t.status === TASK_STATUS.PENDING_APPROVAL) {
        this.rejectTask(taskId, { by: 'hub-cancel', reason: 'cancelled while pending approval' })
        return true
      }
      const ok = this.send(t.nodeId, HUB_TO_NODE.TASK_CANCEL, { taskId, reason: 'hub-request' })
      if (ok) this.log('info', 'task cancel requested', { taskId, nodeId: t.nodeId })
      this.auditRecord('task.cancel', { taskId, nodeId: t.nodeId, delivered: ok === true })
      return ok
    }
  
    // ─────────────────────────── 两阶段审批（提案 #2） ───────────────────────────
  
    /**
     * 批准一个挂起任务：此刻才把 TASK_START 派给副机。
     *
     * 返回 false 表示"没有这条任务 / 不在挂起态"（调用方映射 404/409）；
     * 副机不可达时抛 node unreachable（与 createTask 同款，调用方映射 502）——
     * 批准动作要给出**明确的失败**，而不是把任务留在挂起态假装成功。
     *
     * @param {string} taskId
     * @param {object} [o]
     * @param {string} [o.by] 审批人标识（面板固定 'ui'；审计留痕用）
     * @returns {boolean}
     */
    approveTask(taskId, { by = 'ui' } = {}) {
      const t = this.tasks.get(taskId)
      if (!t || t.status !== TASK_STATUS.PENDING_APPROVAL) return false
      const timer = this.pendingApprovals.get(taskId)
      if (timer) {
        clearTimeout(timer)
        this.pendingApprovals.delete(taskId)
      }
      const rec = this.nodes.get(t.nodeId)
      const sent = rec?.online ? this.send(t.nodeId, HUB_TO_NODE.TASK_START, { ...t.spec }) : false
      if (!sent) {
        // 批准时节点已掉线：任务转 **failed 终态**，绝不静默退回挂起
        // （退回挂起会让"批了但没跑"变成无头案）。
        //
        // ⚠ 2026-10-17 修：原实现是 `this.tasks.delete(taskId)` —— 那让任务从
        // hub 视图**彻底消失**（不是失败、不是挂起，是不存在），与这段注释
        // 自称的"转 failed 终态"直接矛盾。后果：
        //   · `remote_status` / 面板都查不到该任务，用户以为批准成功
        //   · subagent provider 的 `awaitTerminal` 等不到终态，只能靠超时兜底
        //     （最长可挂 1 小时+）
        //   · 与 ui-routes 的 502 分支文案（"任务已转 failed"）不符
        //
        // 改成**保留记录并置终态**：状态可见、可查、可重试。
        t.status = TASK_STATUS.FAILED
        t.endedAt = Date.now()
        t.error = {
          code: 'node-unreachable',
          message: `approval could not be delivered: node ${t.nodeId} is unreachable`,
        }
        rec?.tasks.delete(taskId)
        this.auditRecord('approval.granted', { taskId, nodeId: t.nodeId, by, delivered: false })
        // 唤醒 awaitTerminal 等待者（不唤醒会让它们挂到超时）
        this.resolveWaiters(t)
        throw new RemoteAgentError(`node unreachable: ${t.nodeId}`, ERROR_CODE.INTERNAL)
      }
      t.status = TASK_STATUS.QUEUED
      t.updatedAt = Date.now()
      this.log('info', 'task approved and dispatched', { taskId, nodeId: t.nodeId, by })
      this.auditRecord('approval.granted', { taskId, nodeId: t.nodeId, by, delivered: true })
      this.auditRecord('task.dispatch', {
        taskId,
        nodeId: t.nodeId,
        mode: t.spec?.mode,
        workspace: typeof t.spec?.workspace === 'string' ? t.spec.workspace : '',
        goal: typeof t.spec?.goal === 'string' ? t.spec.goal : '',
        outputsCount: Array.isArray(t.spec?.outputs) ? t.spec.outputs.length : 0,
        timeoutMs: t.spec?.constraints?.timeoutMs,
      })
      return true
    }
  
    /**
     * 拒绝一个挂起任务（面板拒绝 / 审批超时 / 挂起期间取消共用此路径）。
     * 幂等：任务不存在或已不在挂起态返回 false。
     */
    rejectTask(taskId, { by = 'ui', reason = '' } = {}) {
      const t = this.tasks.get(taskId)
      if (!t || t.status !== TASK_STATUS.PENDING_APPROVAL) return false
      const timer = this.pendingApprovals.get(taskId)
      if (timer) {
        clearTimeout(timer)
        this.pendingApprovals.delete(taskId)
      }
      t.status = TASK_STATUS.REJECTED
      t.endedAt = Date.now()
      t.updatedAt = t.endedAt
      t.error = { code: reason === 'approval-timeout' ? 'approval-timeout' : 'approval-rejected', message: `审批未通过（${by}）${reason ? `：${reason}` : ''}` }
      this.log('info', 'task approval rejected', { taskId, nodeId: t.nodeId, by, reason })
      this.auditRecord('approval.rejected', { taskId, nodeId: t.nodeId, by, reason })
      this.resolveWaiters(t)
      return true
    }
  
    /**
     * 清理 hub 侧的**终态**任务视图。
     *
     * ═══════════════════════════════════════════════════════════════════════════
     * 为什么需要它（实测踩到的死锁）
     * ═══════════════════════════════════════════════════════════════════════════
     *
     * hub 侧的任务视图只在**副机的 `task/sync` 不再上报某任务**时才清理
     * （见 `applySync`）。而副机的 TaskStore 默认保留 7 天 —— 于是：
     *
     *   连续派 N 条任务 → hub 视图累积 N 条 → 撞上 `maxTasksPerNode`
     *   → **之后任何新任务都被拒**，连"派一条清理命令"都做不到
     *
     * 这是**自锁**：唯一的解法是人工去副机删文件。实测连续几十条测试任务后
     * 节点就不可用了。
     *
     * ── 这个方法的语义 ────────────────────────────────────────────────────────
     * **只清 hub 侧的视图，不碰副机的任务状态** —— 副机是任务状态的权威
     * （见 lib/node/task-store.js），hub 只是投影。所以：
     *
     *   - 清掉后，如果副机还在 sync 里上报这些任务，它们会**自动重建**
     *     （`applySync` → `ensureTask`）。这没问题 —— 说明副机还认为它们该在。
     *   - 清掉后，`remote_status` 查不到已清的任务。这是**用户主动要求**的结果。
     *
     * 也就是说：本方法是"重置 hub 视图"的逃生舱，幂等、可重复调用。
     *
     * @param {object} [o]
     * @param {string} [o.nodeId] 只清这个节点；省略则清全部
     * @param {boolean} [o.includeActive=false] 是否连**在跑的任务**也清
     *   （默认只清终态。清在跑的会让 `remote_status` 查不到，但任务仍在副机继续跑）
     * @returns {{removed: number, kept: number}}
     */
    purgeTasks({ nodeId, includeActive = false } = {}) {
      let removed = 0
      let kept = 0
      for (const [taskId, t] of [...this.tasks]) {
        if (typeof nodeId === 'string' && nodeId !== '' && t.nodeId !== nodeId) continue
        const terminal = TERMINAL_STATUS.has(t.status)
        if (!terminal && !includeActive) {
          kept += 1
          continue
        }
        this.tasks.delete(taskId)
        const rec = this.nodes.get(t.nodeId)
        if (rec) rec.tasks.delete(taskId)
        removed += 1
      }
      if (removed > 0) this.log('info', 'task views purged', { removed, kept, nodeId: nodeId ?? '(all)' })
      return { removed, kept }
    }
  
  }
}
