/**
 * Worker-side wiring (from lib/index.js applyWorkerBranch). The worker body still
 * lives in lib/node/index.js (no src/ equivalent for the whole assembly yet).
 * Dynamic import: a hub process never loads the worker stack.
 */
export async function applyWorkerBranch(ctx, config, log) {
  let mod
  try {
    mod = await import('../../lib/node/index.js')
  } catch (err) {
    log('error', 'worker 分支加载失败：lib/node/index.js 不可用', {
      error: String(err?.message ?? err),
    })
    return undefined
  }
  const fn = typeof mod?.applyWorker === 'function' ? mod.applyWorker : typeof mod?.apply === 'function' ? mod.apply : undefined
  if (typeof fn !== 'function') {
    log('error', 'worker 分支加载失败：lib/node/index.js 未导出 applyWorker')
    return undefined
  }
  try {
    return fn(ctx, config)
  } catch (err) {
    log('error', 'worker 分支挂载失败', { error: String(err?.message ?? err) })
    return undefined
  }
}
