/** wire/limits：任务/产物词表、超时与帧大小上限（数值沿用 lib/protocol.js）。 */

export const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  /** 两阶段审批（提案 #2）：hub 已受理但**尚未派给副机**，等面板批准。 */
  PENDING_APPROVAL: 'pending_approval',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
  INTERRUPTED: 'interrupted',
  /** 两阶段审批终态：面板拒绝 / 审批超时 / 挂起期间被取消。 */
  REJECTED: 'rejected',
})

export const TERMINAL_STATUS = new Set([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.ABORTED,
  TASK_STATUS.INTERRUPTED,
  TASK_STATUS.REJECTED,
])

export const TASK_MODE = Object.freeze({
  /** 副机本机起一个真实 DSH agent 会话，独立模型上下文，任务在副机持久运行。 */
  AGENT: 'agent',
  /** 副机直接执行一段命令（调试 / 简单活）。 */
  EXEC: 'exec',
})

export const ARTIFACT_ROLE = Object.freeze({
  /** 成品：允许 hub 显式 pull。 */
  FINAL: 'final',
  /** 中间产物：只在副机留存，仅上报元数据。 */
  INTERMEDIATE: 'intermediate',
  /** 未归类：上报元数据，默认不可 pull。 */
  OTHER: 'other',
})

export const ARTIFACT_KIND = Object.freeze({
  FILE: 'file',
  DIR: 'dir',
  DIFF: 'diff',
  REPORT: 'report',
  MEDIA: 'media',
})

export const DEFAULT_HEARTBEAT_MS = 15_000
export const DEFAULT_ACK_TIMEOUT_MS = 60_000
export const DEFAULT_PULL_TIMEOUT_MS = 30 * 60 * 1000
/** 单帧二进制分块上限：256 KiB（base64 回退时约 341 KiB）。 */
export const ARTIFACT_CHUNK_BYTES = 256 * 1024
/** 中继/控制帧的单帧文本上限，防止畸形帧吃内存。 */
export const MAX_CONTROL_FRAME_BYTES = 4 * 1024 * 1024
export const MAX_ARTIFACT_FRAME_BYTES = 8 * 1024 * 1024
