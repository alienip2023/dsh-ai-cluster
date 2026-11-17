/**
 * 两阶段审批测试（提案 #2）。
 *
 * 三层覆盖：
 *   - 协议层：validateTaskStart 的 approval 缺省语义（exec→manual、agent→auto、
 *     显式传值双向覆盖）
 *   - 注册表层：manual 任务挂起不派帧 / approve 派帧 / reject 终态 / 超时自动
 *     拒绝（fail-closed）/ cancel 挂起任务走本地拒绝 / sync 对账不清挂起任务
 *   - 面板路由：approve/reject 的 404/409/502 语义
 *
 * 与 auto-routing.test.js 同款手法：节点记录直接摆进 registry.nodes，send 用
 * stub 记帧（manual 任务绝不能发出 TASK_START，这是本提案的核心断言）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { NodeRegistry } from '../../lib/hub/node-registry.js'
import { registerUiRoutes, UI_API_PREFIX } from '../../src/http/index.js'
import { HUB_TO_NODE, TASK_STATUS, TERMINAL_STATUS, validateTaskStart } from '../../lib/protocol.js'


/* ══════════════════════════════════════════════════════════════════
 * 2. 注册表层
 * ══════════════════════════════════════════════════════════════════ */

/** registry + 一个在线节点；frames 记录所有发出的帧；audit 记事件。 */
function setup(t, { approvalTimeoutMs, ackTimeoutMs } = {}) {
  const frames = []
  const events = []
  const registry = new NodeRegistry({
    log: () => {},
    limits: { ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}), ...(ackTimeoutMs !== undefined ? { ackTimeoutMs } : {}) },
    audit: { record: (event, fields) => events.push({ event, fields }) },
  })
  registry.send = (nodeId, type, data) => {
    frames.push({ nodeId, type, data })
    return true
  }
  registry.nodes.set('n1', {
    nodeId: 'n1',
    online: true,
    hello: { agentMode: true, roots: ['D:\\w'] },
    resource: null,
    repos: [],
    tasks: new Map(),
    conn: null,
  })
  t.after(() => registry.dispose())
  return { registry, frames, events }
}

const EXEC_SPEC = (taskId) => validateTaskStart({
  taskId,
  goal: 'echo hi',
  mode: 'exec',
  approval: 'manual',
  origin: 'hub',
}).spec



/* ══════════════════════════════════════════════════════════════════
 * 3. 面板路由：404 / 409 / 502 语义
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 组一个最小 UI 路由环境（照 ui-routes.test.js 的"捕获 handler 直调"手法：
 * fake ctx.webServer.register 捕获路由表，再直接以假 req/res 调 handler）。
 */
function setupUi(t) {
  const env = setup(t)
  const captured = []
  const ctx = {
    webServer: { register: (r) => { captured.push(r); return () => {} } },
    connection: undefined,
  }
  const disposers = registerUiRoutes({
    ctx,
    registry: env.registry,
    pulls: {},
    log: () => {},
    defaults: {},
    config: { role: 'hub' },
  })
  t.after(() => { for (const d of disposers) { try { d() } catch { /* 忽略 */ } } })

  const call = async (routePath, method, body) => {
    const handler = captured.find((r) => r.path === `${UI_API_PREFIX}/${routePath}`)?.handler
    if (!handler) throw new Error(`route not registered: ${routePath}`)
    const out = { status: 0, body: null }
    const res = {
      writeHead(code) { out.status = code },
      end(payload) { out.body = payload ? JSON.parse(payload) : null },
    }
    const req = {
      method,
      url: `${UI_API_PREFIX}/${routePath}`,
      headers: { 'content-type': 'application/json' },
      // readJson 用 for-await 消费 body（见 ui-routes.js readJson）
      *[Symbol.asyncIterator]() {
        yield Buffer.from(body ? JSON.stringify(body) : '')
      },
    }
    await handler(req, res)
    return { status: out.status, json: out.body }
  }
  return { ...env, call }
}

test('UI dispatch：exec 缺省 manual（面板与 cluster_task 同一缺省语义）', async (t) => {
  const { registry, frames, call } = setupUi(t)
  const r = await call('dispatch', 'POST', { node: 'n1', goal: 'echo hi', mode: 'exec' })
  assert.equal(r.status, 200)
  assert.equal(r.json.approval, 'manual')
  assert.equal(registry.getTask(r.json.taskId).status, TASK_STATUS.PENDING_APPROVAL)
  assert.equal(frames.length, 0, '挂起期间不派帧')
  // agent 缺省 auto：立即派
  const r2 = await call('dispatch', 'POST', { node: 'n1', goal: '做点事', mode: 'agent' })
  assert.equal(r2.json.approval, 'auto')
  assert.equal(frames.length, 1, 'agent 任务应立即派发')
})

test('UI 路由：approve 的 404 / 409 / 成功 / 405', async (t) => {
  const { registry, call } = setupUi(t)
  assert.equal((await call('approve', 'POST', { taskId: 'nope' })).status, 404)
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  assert.equal((await call('approve', 'POST', { taskId: 't1' })).status, 200)
  // 已批准（非挂起态）再批 → 409
  assert.equal((await call('approve', 'POST', { taskId: 't1' })).status, 409)
  // GET 打到 POST 路由 → 405
  assert.equal((await call('approve', 'GET')).status, 405)
})

test('UI 路由：reject 幂等成功 / 非 pending 409 / approve 节点掉线 502', async (t) => {
  const { registry, call } = setupUi(t)
  assert.equal((await call('reject', 'POST', { taskId: 'nope' })).status, 404)
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  assert.equal((await call('reject', 'POST', { taskId: 't1', reason: '不要了' })).status, 200)
  assert.equal(registry.getTask('t1').status, TASK_STATUS.REJECTED)

  // 掉线批准 → 502
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t2') })
  registry.nodes.get('n1').online = false
  const r = await call('approve', 'POST', { taskId: 't2' })
  assert.equal(r.status, 502)
  assert.equal(r.json.error, 'node-unreachable')
})
