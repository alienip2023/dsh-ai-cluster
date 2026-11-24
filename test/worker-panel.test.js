/**
 * 副机面板（worker 视图）的回归。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 背景：一个结构性死设计
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dsh.client` 是**包级声明**（loader 扫 package.json 的 `dsh.client`），
 * 装了插件就加载面板，**无法按 role 条件化**。而 hub 的 UI 路由只在
 * `applyHub` 里注册 —— 副机跑 `applyWorkerBranch`，没有那些路由。
 *
 * 结果：副机侧栏有「远程同事」，点开是**全 404 的破面板**。
 *
 * ── 修法不是"藏掉 404" ──────────────────────────────────────────────────
 *
 * 副机**也有** webServer（`dsh-web-app` 是桌面版基础 bundle，实测监听
 * 19387），而 worker 分支早就有 `/api/remote-agent/status` 端点。
 * 所以让面板**显示副机自己**：角色 / 连的 hub / 任务队列 / roots / 错误。
 *
 * 这些断言锁住这个能力，防止它被"简化"回去。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const nodeIndex = read('lib/node/index.js')

/* ─────────────── 1. 副机侧的状态端点必须存在 ─────────────── */

test('worker 分支注册了状态端点（面板的数据源）', () => {
  assert.match(nodeIndex, /const STATUS_PATH = ['"]\/api\/remote-agent\/status['"]/, '应定义 STATUS_PATH')
  // 必须真的注册（不是只定义常量）
  const i = nodeIndex.indexOf('webServer.register({ kind: \'exact\', path: STATUS_PATH')
  assert.ok(i >= 0, 'STATUS_PATH 必须被 webServer.register 注册')
  // 且注册在 optionalDisposers 里（可选服务，没有 webServer 时不报错）
  const around = nodeIndex.slice(i, i + 400)
  assert.match(around, /optionalDisposers\.push/, '注册的 disposer 应进 optionalDisposers（可选能力）')
})

test('statusSnapshot 覆盖面板要显示的每一项', () => {
  const i = nodeIndex.indexOf('function statusSnapshot()')
  assert.ok(i >= 0, '应存在 statusSnapshot')
  const seg = nodeIndex.slice(i, i + 1400)
  // 面板 worker 视图读的字段
  for (const f of ['nodeId', 'protocol', 'online', 'transportMode', 'url', 'stateDir', 'roots', 'runner', 'dshVersion', 'caps', 'tasks', 'lastError']) {
    assert.ok(new RegExp(`\\b${f}\\b`).test(seg), `statusSnapshot 应提供 ${f}（面板要显示它）`)
  }
  // tasks 里要有队列计数（面板卡片用）
  assert.match(seg, /running/, 'tasks 应含 running')
  assert.match(seg, /queued/, 'tasks 应含 queued')
})
