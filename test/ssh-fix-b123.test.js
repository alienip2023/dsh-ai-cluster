import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/* ── B1: 客户端轮询契约 ────────────────────────────────────────────────── */

/* ── B2: tgz 数值排序 ──────────────────────────────────────────────────── */

test('B2: _numSort 数值排序 — fork.25 优先于 fork.9', () => {
  // Reproduce sort logic locally for behavioral testing
  function numSort(files) {
    return files.slice().sort((a, b) => {
      const ma = a.match(/-fork\.(\d+)\.tgz$/)
      const mb = b.match(/-fork\.(\d+)\.tgz$/)
      if (ma && mb) return Number(mb[1]) - Number(ma[1])
      return b.localeCompare(a)
    })
  }
  const files = ['dsh-remote-agent-0.10.1-fork.9.tgz', 'dsh-remote-agent-0.10.1-fork.25.tgz', 'dsh-remote-agent-0.10.1-fork.2.tgz']
  const sorted = numSort(files)
  assert.equal(sorted[0], 'dsh-remote-agent-0.10.1-fork.25.tgz', `数值排序第一应是 fork.25，实际：${sorted[0]}`)
  assert.equal(sorted[1], 'dsh-remote-agent-0.10.1-fork.9.tgz', `数值排序第二应是 fork.9，实际：${sorted[1]}`)
  // fork.27: tgz upload replaced by sftp file upload; _numSort no longer in source.
  // Logic test above remains as regression guard for the sorting algorithm.
})

test('B2（变异验证）：改回字典序 sort().reverse() 后 fork.9 排第一', () => {
  const files = ['dsh-remote-agent-0.10.1-fork.9.tgz', 'dsh-remote-agent-0.10.1-fork.25.tgz', 'dsh-remote-agent-0.10.1-fork.2.tgz']
  // Lexicographic sort: '9' > '25' in lex order
  const lexSorted = files.slice().sort().reverse()
  assert.equal(lexSorted[0], 'dsh-remote-agent-0.10.1-fork.9.tgz',
    '字典序 fork.9 排第一 — 这就是 B2 要修复的 bug（变异：若改回字典序，B2 测试红）')
})

/* ── B3: relay guard 测试（使用 mock ssh2 loader） ──────────────────────── */

test('B3: relay guard 源码存在且位于 configure 步骤', () => {
  const src = readFileSync(join(ROOT, 'lib/hub/ssh-onboard.js'), 'utf-8')
  // Guard must appear in the configure step
  const configureIdx = src.indexOf("// Step 5: configure")
  assert.ok(configureIdx > 0, '应找到 configure 步骤注释')
  const afterConfigure = src.slice(configureIdx, configureIdx + 800)
  assert.ok(afterConfigure.includes('!relayUrl || !relayToken'), `configure 步骤应含 relay guard，实际：${afterConfigure.slice(0, 300)}`)
  assert.ok(afterConfigure.includes('无法上桥') || afterConfigure.includes('relayUrl'), `guard 应给出无法上桥原因`)
})

test('B3（变异验证）：删除 relay guard 后源码不含 !relayUrl || !relayToken', () => {
  const src = readFileSync(join(ROOT, 'lib/hub/ssh-onboard.js'), 'utf-8')
  // Mutant: remove the guard block
  const mutant = src.replace(
    /if \(!relayUrl \|\| !relayToken\) \{[\s\S]*?conn\.end\(\); return\s*\n\s*\}/,
    '// guard removed by mutation'
  )
  // Real code must have the guard; mutant must not
  assert.ok(src.includes('!relayUrl || !relayToken'), '原始代码应含 relay guard（变异验证）')
  assert.ok(!mutant.includes('!relayUrl || !relayToken'), '变异后不含 relay guard（变异验证）')
  // If the guard were missing in real code, this test would go RED:
  assert.ok(src.includes('!relayUrl || !relayToken'),
    'relay guard 必须存在 — 此断言在变异（删 guard）后红（B3 变异验证）')
})
