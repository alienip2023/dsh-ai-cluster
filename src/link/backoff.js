/**
 * L3 link：唯一的重连 / 退避实现。
 *
 * 吸收：
 *   - lib/node/transport.js:56-75   resolveDuplicateRetry / duplicateBackoffMs
 *   - lib/node/transport.js:1062-1079 scheduleReconnect 的延迟公式 (base 1000, cap 30000, +20% jitter)
 *   - lib/hub/relay-link.js:~232     schedule() 的延迟公式 (reconnectMs*2^min(attempt,4), cap 60000, +20% jitter)
 *   - lib/node/peer-link.js          没有重连循环（惰性拨出，失败即 fallback），无需合并
 * 以及两处各自私有的 `connecting` 并发闸门 → createReconnectGate。
 */

/**
 * fork.61：duplicate-node 的重试预算（数值与注释见 lib/node/transport.js:40-55）。
 * 高频阶段默认 1s/2s/4s/8s/16s/16s/…，累计不超过 600s；预算耗尽后降频，不再 stop()。
 */
export const DUPLICATE_RETRY_DEFAULTS = Object.freeze({ baseMs: 1000, maxMs: 16_000, totalMs: 600_000 })
const DUPLICATE_RETRY_TOTAL_CEILING_MS = 3_600_000

/** 直连 / 中继通用重连默认：与旧 transport 的 BACKOFF_* 一致。 */
export const RECONNECT_DEFAULTS = Object.freeze({ baseMs: 1000, maxMs: 30_000 })

/** 合法 = 有限的正数；非法字段各自回退默认。 */
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
 * 通用指数退避 + 20% 抖动。transport 与 relay-link 共用。
 * @param {number} attempt0 已失败次数（第一次重连传 0）
 * @param {{ baseMs: number, maxMs: number, maxExp?: number, random?: () => number }} cfg
 * @returns {{ baseMs: number, delayMs: number }}
 */
export function reconnectDelay(attempt0, { baseMs, maxMs, maxExp = Infinity, random = Math.random }) {
  const exp = Math.min(Math.max(0, attempt0), maxExp)
  const base = Math.min(baseMs * 2 ** exp, maxMs)
  return { baseMs: base, delayMs: base + Math.floor(base * 0.2 * random()) }
}

/**
 * 重连闸门：同一时刻只允许一次连接尝试在途。
 *   claim()   → 空闲时返回 true 并占住；在途时返回 false
 *   release() → 释放，允许下一次 claim
 *   wait(n)   → 第 n 次 duplicate 重试的基础等待（不含抖动）
 */
export function createReconnectGate({ retry } = {}) {
  const cfg = resolveDuplicateRetry(retry)
  let inFlight = false
  return {
    claim() {
      if (inFlight) return false
      inFlight = true
      return true
    },
    release() {
      inFlight = false
    },
    wait(n) {
      return duplicateBackoffMs(n, cfg)
    },
    get inFlight() {
      return inFlight
    },
  }
}
