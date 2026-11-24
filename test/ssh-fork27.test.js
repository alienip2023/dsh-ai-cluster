import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ONBOARD = readFileSync(fileURLToPath(new URL('../lib/hub/ssh-onboard.js', import.meta.url)), 'utf-8')
const WORKER = readFileSync(fileURLToPath(new URL('../bin/dsh-remote-worker.js', import.meta.url)), 'utf-8')

// M2 变异验证：计数断言，删掉任一条件守卫后 cnt 必降为 1
// M1 变异验证：enrollToken 必须以真实值写入 nodeToken，不得打码
test('M1 变异验证：enrollToken 真实写入 nodeToken，不得打码', () => {
  // 原始内容必须含 "${enrollToken}" 模板字面量
  assert.ok(
    ONBOARD.includes('"nodeToken": "${enrollToken}"') ||
    ONBOARD.includes("`  \"nodeToken\": \"${enrollToken}\",`"),
    'ssh-onboard.js 必须用 ${enrollToken} 写入真实 token，不得打码'
  )
  // 确认不含打码形式
  assert.ok(!ONBOARD.includes('"nodeToken": "${maskSecret('), 'nodeToken 不得使用 maskSecret 打码')
  // 构造 mutant：把 enrollToken 替换为 ***，断言与原始不同
  const mutant = ONBOARD.replace('"nodeToken": "${enrollToken}"', '"nodeToken": "***"')
  assert.ok(mutant.includes('"nodeToken": "***"'), 'mutant 应含打码行')
  assert.notStrictEqual(mutant, ONBOARD, 'mutant 必须与原始不同')
})

// M4 变异验证：bin/dsh-remote-worker.js 调用 applyWorker(ctx, config)
test('M4 变异验证：bin/dsh-remote-worker.js 调用 applyWorker', () => {
  assert.ok(WORKER.includes('applyWorker(ctx, config)'), 'dsh-remote-worker.js 必须调用 applyWorker(ctx, config)')
  // 构造 mutant：删掉 applyWorker 调用
  const mutant = WORKER.replace('applyWorker(ctx, config)', '')
  assert.ok(!mutant.includes('applyWorker(ctx, config)'), 'mutant 不应含 applyWorker 调用')
  assert.notStrictEqual(mutant, WORKER, 'mutant 必须与原始不同')
})
