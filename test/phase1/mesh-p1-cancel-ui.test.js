/** Mesh P1 S2（交办）UI：账本/回执/停滞/静态 alpha 文案，ID 前缀 MP1U-。渲染 harness 同 ui-p2-screens.test.js:11-37。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../../lib/client.js'), 'utf8')

function loadView() {
  let plugin = null
  const sandbox = { window: { __ModuleLoader__: { load(mod) {
    plugin = mod.factory(function (id) {
      if (id !== 'react') throw new Error('unexpected require ' + id)
      return {
        createElement(type, props, ...children) { return { type, props: props || {}, children } },
        useState(v) { return [v, function () {}] }, useEffect() {}, useRef(v) { return { current: v } }, useMemo(fn) { return fn() },
      }
    })
  } } }, console }
  vm.runInNewContext(src, sandbox, { filename: 'lib/client.js' })
  return plugin
}
const P = loadView()

function text(node) {
  if (node == null || node === false) return ''
  if (Array.isArray(node)) return node.map(text).join('|')
  if (typeof node !== 'object') return String(node)
  return text(node.children)
}
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze) } return o }
const row = (task) => text(P.TaskRow({ task, onAction() {} }))
const base = { taskId: 'task-1234567890', nodeId: 'node-1', goal: 'g', createdAt: 1, updatedAt: 2, startedAt: 0, endedAt: 0, durationMs: 0 }

test('MP1U-LEDGER exact labels (aborted labels are render-only fixtures; real pipeline fails closed)', () => {
  assert.equal(P.cancelEvidenceLabel({ cancelEvidence: { state: 'aborted', source: 'node' } }), '已取消（节点确认）')
  assert.equal(P.cancelEvidenceLabel({ cancelEvidence: { state: 'aborted', source: 'node', abortedBeforeStart: true } }), '已取消（未开始，节点确认）')
  for (const st of ['completed', 'failed', 'interrupted', 'rejected']) {
    assert.equal(P.cancelEvidenceLabel({ status: st, cancelEvidence: { state: 'terminal', source: 'node' } }), '')
    assert.doesNotMatch(row({ ...base, status: st, cancelEvidence: { state: 'terminal', source: 'node' } }), /已取消/)
  }
  assert.doesNotMatch(row({ ...base, status: 'failed', exit: { timedOut: true }, cancelEvidence: { state: 'terminal', source: 'node' } }), /已取消/)
  const unk = row({ ...base, status: 'aborted', cancelEvidence: { state: 'unknown', source: 'none' } })
  assert.ok(unk.length > 0)
  assert.doesNotMatch(unk, /已取消（/)
  assert.match(row({ ...base, status: 'aborted', cancelEvidence: { state: 'aborted', source: 'node' } }), /已取消（节点确认）/)
  assert.equal(P.cancelEvidenceLabel(null), '')
  assert.equal(P.cancelEvidenceLabel({}), '')
})

test('MP1U-RECEIPT three kinds, pre-click state wins, no forbidden claims', () => {
  const run = { status: 'running' }
  const cases = [
    [{ response: { requested: true }, before: run }, 'requested', '已提交取消请求，等待任务状态更新'],
    [{ response: { requested: false }, before: run }, 'notDelivered', '取消请求未送达'],
    [{ response: { requested: true }, before: { status: 'completed' } }, 'terminal', '任务已结束，无需取消'],
    [{ response: { requested: false }, before: { status: 'failed' } }, 'terminal', '任务已结束，无需取消'],
    [{ response: { requested: true }, before: { status: 'aborted' } }, 'terminal', '任务已结束，无需取消'],
    [{ response: { requested: true }, before: { status: 'queued' } }, 'requested', '已提交取消请求，等待任务状态更新'],
    [{ response: { requested: true }, before: { status: 'pending_approval' } }, 'requested', '已提交取消请求，等待任务状态更新'],
    [{ response: null, before: null }, 'notDelivered', '取消请求未送达'],
  ]
  for (const [args, kind, copy] of cases) {
    const r = P.cancelReceipt(args)
    assert.equal(r.kind, kind); assert.equal(r.text, copy)
    assert.doesNotMatch(r.text, /已送达|已发送|离线|已取消|marked/)
  }
  // requested:true never renders cancelled; a refreshed still-running task stays non-aborted
  assert.doesNotMatch(row({ ...base, status: 'running', cancelEvidence: { state: 'unknown', source: 'none' } }), /已取消/)
})

test('MP1U-NOMARK no marked text anywhere in the Tasks rendering path', () => {
  for (const st of ['running', 'queued', 'aborted', 'rejected', 'completed']) {
    assert.doesNotMatch(row({ ...base, status: st, cancelEvidence: { state: 'unknown', source: 'none' }, stallHint: { stalled: true, idleMs: 300000 } }), /marked/i)
  }
  assert.doesNotMatch(P.ALPHA_BOT_TURN_NOTE, /marked/i)
})

test('MP1U-STALL hint only for non-terminal tasks', () => {
  const sh = { stalled: true, idleMs: 300000 }
  assert.equal(P.stallLabel({ status: 'running', stallHint: sh }), '已 5 分钟无更新（仅提示）')
  assert.equal(P.stallLabel({ status: 'queued', stallHint: sh }), '已 5 分钟无更新（仅提示）')
  assert.equal(P.stallLabel({ status: 'completed', stallHint: sh }), '')
  assert.equal(P.stallLabel({ status: 'running', stallHint: { stalled: false, idleMs: 0 } }), '')
  assert.equal(P.stallLabel({ status: 'running' }), '')
  assert.match(row({ ...base, status: 'running', stallHint: sh }), /已 5 分钟无更新（仅提示）/)
})

test('MP1U-ALPHA static bounded notice on the tasks screen only', () => {
  const note = P.ALPHA_BOT_TURN_NOTE
  assert.equal(typeof note, 'string')
  assert.ok((note.match(/[。.]/g) || []).length <= 2)
  assert.doesNotMatch(note, /恢复(?!。)|重试|点击|http/)
  const tasksStart = src.indexOf("screen === 'tasks' ? h('div'")
  assert.ok(tasksStart > 0)
  const occ = [...src.matchAll(/ALPHA_BOT_TURN_NOTE/g)].map((m) => m.index)
  assert.equal(occ.filter((i) => i > tasksStart && i < tasksStart + 500).length, 1, 'rendered exactly once, inside the tasks branch')
  assert.equal(occ.length, 4, 'definition + tasks branch + export key/value only')
  // 渲染点必须是无条件的静态元素：整行恰为 h('div', { className: 'dra-hint' }, ALPHA_BOT_TURN_NOTE)，不绑定任何 tasks/加载数据
  const renderLine = src.split('\n').find((l, i) => l.includes('ALPHA_BOT_TURN_NOTE') && src.split('\n').slice(0, i).join('\n').length > tasksStart)
  assert.equal(renderLine.trim(), "h('div', { className: 'dra-hint' }, ALPHA_BOT_TURN_NOTE),", 'alpha notice is unconditional and data-independent')
})

test('MP1U-IMMUT render with deep-frozen tasks does not throw or mutate', () => {
  const tasks = deepFreeze([{ ...base, status: 'running', cancelEvidence: { state: 'unknown', source: 'none' }, stallHint: { stalled: true, idleMs: 130000 }, exit: { code: 1 } },
    { ...base, taskId: 't2', status: 'aborted', cancelEvidence: { state: 'aborted', source: 'node' } }])
  const snap = JSON.stringify(tasks)
  for (const t of tasks) { row(t); text(P.TaskDetail({ detail: { task: t }, onClose() {}, onAction() {} })) }
  assert.equal(JSON.stringify(tasks), snap)
  const detail = text(P.TaskDetail({ detail: { task: tasks[1] }, onClose() {}, onAction() {} }))
  assert.match(detail, /任务证据/); assert.match(detail, /已取消（节点确认）/)
  assert.match(text(P.TaskDetail({ detail: { task: tasks[0] }, onClose() {}, onAction() {} })), /停滞提示/)
})

test('MP1U-IMMUT cancel click: exactly one POST /cancel and one refresh; receipt from response', () => {
  const m = src.match(/if \(action === 'cancel'\) \{[\s\S]*?return\n\s*\}/)
  assert.ok(m)
  assert.equal((m[0].match(/apiPost\(/g) || []).length, 1)
  assert.equal((m[0].match(/refresh\(\)/g) || []).length, 1)
  assert.match(m[0], /cancelReceipt\(\{ response: resp, before: beforeTask \}\)/)
})

test('MP1U-LAYOUT screen ids/order/labels unchanged', () => {
  assert.deepEqual(Array.from(P.P2_SCREENS, (e) => e[0]), ['computers', 'tasks', 'bots', 'models', 'memory'])
  assert.deepEqual(Array.from(P.P2_SCREENS, (e) => e[1]), ['电脑', '交办', '机器人', '模型', '记忆'])
  assert.equal(P.selectHubScreen({ screen: 'tasks' }), 'tasks')
})
