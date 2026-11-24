/**
 * test/style-injection.test.js
 *
 * 验证 CSS 样式注入机制正确实现。
 *
 * 背景（fork.19 回归根因）：
 *   `styles` 是 dynamic lane 的 builtin，window.__ModuleLoader__ 静态 bundle 里
 *   ctx.get('styles') 返回 undefined → styles.insert 不执行 → 面板无样式。
 *   正确做法是面板每个顶层视图自己渲染 <style>，随组件挂载（逐视图的行为断言见 test/panel/shell.test.js）。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8')

test('样式表含 --dra-accent 等 CSS token', () => {
  // CSS 数组应含 --dra-accent（核心 token）与 .dra-root（根容器）
  assert.match(CLIENT_SRC, /--dra-accent/, 'CSS 数组应包含 --dra-accent token')
  assert.match(CLIENT_SRC, /\.dra-root\{/, 'CSS 应包含 .dra-root 根规则')
})

test('Root 包装组件存在且接受 theme prop', () => {
  const code = CLIENT_SRC
  // function Root 必须存在
  assert.match(code, /function Root\(/, 'Root 包装组件必须存在')
  // Root 必须使用 dra-light 来自 props.theme
  assert.match(code, /theme.*dra-light|dra-light.*theme/, 'Root 必须根据 theme prop 挂 .dra-light')
})
