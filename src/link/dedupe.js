/**
 * 帧 id 去重窗口（新增，slice 4 验收项 3）。
 * 重连后对端可能按 id 重放同一帧；窗口跨连接存活（属于 transport 实例，不随 close 清零），
 * 有界（maxIds）且按 ttlMs 过期。seen(id) 首次返回 false 并记下，再次返回 true。
 */
export function createFrameDeduper({ maxIds = 1024, ttlMs = 600_000, now = Date.now } = {}) {
  const ids = new Map()
  return {
    seen(id) {
      if (typeof id !== 'string' || id === '') return false
      const t = now()
      const at = ids.get(id)
      if (at !== undefined && t - at < ttlMs) return true
      ids.delete(id)
      ids.set(id, t)
      while (ids.size > maxIds) ids.delete(ids.keys().next().value)
      return false
    },
    get size() { return ids.size },
  }
}
