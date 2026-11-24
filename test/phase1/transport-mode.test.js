/**
 * test/transport-mode.test.js
 *
 * 验证面板连接方式（transportMode）选择功能。
 * 覆盖：表单渲染、提交体内容、配对码解析、中文化显示、变异验证。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const code = stripComments(CLIENT_SRC)

/* ── 1. 表单渲染出连接方式选项 ─────────────────────────────────────── */

test('SetupView 渲染连接方式选择卡片（中继 + 直连）', () => {
  assert.match(code, /连接方式/, '表单应有「连接方式」标签')
  assert.match(code, /中继（relay）/, '应有中继选项')
  assert.match(code, /直连（direct）/, '应有直连选项')
})

/* ── 3. role=hub 提交也带 relayUrl ─────────────────────────────────── */

/* ── 4. parsePair 保留 transportMode ──────────────────────────────── */

/* ── 5. applyPair 切换 transportMode ──────────────────────────────── */

/* ── 6. 中文化显示 ────────────────────────────────────────────────── */

/* ── 7. setup-routes 放开 hub ──────────────────────────────────────── */

test('setup-routes: transportMode 不再只限 worker', () => {
  const routesSrc = fs.readFileSync(path.join(ROOT, 'lib/setup-routes.js'), 'utf8')
  // 旧的写法：role === 'worker' ? ... : 'relay'
  assert.ok(!/role === 'worker'.*transportMode.*direct.*relay/.test(routesSrc),
    '不应再用 role === worker 限制 transportMode 赋值')
  // 新写法：直接从 body 读
  assert.match(routesSrc, /str\(body\.transportMode\) === 'direct' \? 'direct' : 'relay'/,
    '应直接从 body.transportMode 读，不限 role')
  // lines.push transportMode 应不在 if (role === worker) 条件内
  assert.match(routesSrc, /lines\.push\(` {4}transportMode: \$\{transportMode\}`\)/,
    'transportMode 应无条件写入 patch（hub 也写）')
})

/* ── 8. 变异验证 ──────────────────────────────────────────────────── */




/* ── 9. ConfigPanel 模板按模式分支 ─────────────────────────────────── */

/* ── 10. worker 回填 cfg ──────────────────────────────────────────── */

/* ── B1: ConfigPanel TDZ 顺序 ──────────────────────────────────────── */

/* ── B2: buildNodeHello transportMode + registry 透传 ────────────── */

test('B2: buildNodeHello 包含 transportMode 字段', () => {
  const nodeSrc = fs.readFileSync(path.join(ROOT, 'lib/node/index.js'), 'utf8')
  const bIdx = nodeSrc.indexOf('export function buildNodeHello(')
  assert.ok(bIdx >= 0, 'buildNodeHello 应存在')
  const bSeg = nodeSrc.slice(bIdx, bIdx + 2000)
  assert.match(bSeg, /transportMode:/, 'buildNodeHello 应输出 transportMode 字段')
  const regSrc = fs.readFileSync(path.join(ROOT, 'lib/hub/node-registry.js'), 'utf8')
  assert.match(regSrc, /hello\.transportMode/, 'registry list() 应从 r.hello.transportMode 取 transportMode')
})

test('B2 变异验证：buildNodeHello 删掉 transportMode → 测试红', () => {
  const nodeSrc = fs.readFileSync(path.join(ROOT, 'lib/node/index.js'), 'utf8')
  const bIdx = nodeSrc.indexOf('export function buildNodeHello(')
  const bSeg = nodeSrc.slice(bIdx, bIdx + 2000)
  const mutant = bSeg.replace(/[ \t]+transportMode:[^\n]+\n/, '')
  assert.ok(!/transportMode:/.test(mutant),
    '变异后 buildNodeHello 里不应再有 transportMode 行')
})

/* ── B3: worker cfg 回填路径 ──────────────────────────────────────── */

