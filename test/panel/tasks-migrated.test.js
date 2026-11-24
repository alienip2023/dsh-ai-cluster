// 从旧 lib/client.js 的测试迁来的、新任务屏仍然在用的行为：取消证据/回执/停滞、工单折叠、模板接线、清理确认、轮询不重置状态。
import assert from 'node:assert/strict'
import test from 'node:test'
import { expand, findAll, findButtons, makeCore, texts, textOf } from './_fake.js'
import { createData, dataEmptyHub } from '../../src/panel/data.js'
import {
  createTasks, tasksAttentionRows, tasksCancelEvidenceLabel, tasksCancelReceipt, tasksFormFromTemplate, tasksNewForm, tasksSortAttention,
  tasksStallLabel, tasksTicketStage,
} from '../../src/panel/tasks.js'

const noop = () => {}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
const base = { taskId: 'task-1234567890', nodeId: 'node-1', goal: 'g', createdAt: 1, updatedAt: 2, startedAt: 0, endedAt: 0, durationMs: 0, mode: 'agent' }
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze) } return o }
const tplEmpty = { loading: false, list: [], max: 0, degraded: false, reason: '', file: '', error: '' }

function view(over) {
  const core = makeCore()
  const { TasksView } = createTasks(core).parts
  const hub = Object.assign({}, dataEmptyHub, { loading: false, nodes: [{ nodeId: 'node-1', online: true, os: 'linux' }], tasks: [], caps: { pull: true, pullRoot: '/r' }, tickets: undefined }, over && over.hub)
  const props = Object.assign({
    now: 1_000_000, go: noop, note: null, onNoteClose: noop, form: tasksNewForm(), onForm: noop, modelCustom: false, onModelCustom: noop, dispatching: false,
    onDispatch: noop, tpl: tplEmpty, tplMsg: '', tplBusy: false, onTplApply: noop, onTplSave: noop, onTplDelete: noop, filter: 'all', onFilter: noop,
    purgeBusy: false, onPurge: noop, selected: '', detail: null, detailRef: { current: null }, busyKeys: {}, onSelect: noop, onClose: noop, onAct: noop,
  }, over, { hub })
  return core.h(TasksView, props)
}
const rowText = (task) => textOf(view({ hub: { tasks: [Object.assign({}, base, task)] } }))
const detailText = (task, handoff) => textOf(view({ hub: { tasks: [task] }, selected: task.taskId, detail: { id: task.taskId, task, handoff: handoff || null, error: '' } }))

/** 能真更新状态、按依赖数组重跑 effect 的最小 React 桩（Screen / useHub 都能在上面跑多次渲染）。 */
function live() {
  const slots = []
  let i = 0
  const React = Object.assign({}, makeCore().React, {
    useState(v) {
      const k = i++
      if (!(k in slots)) slots[k] = { v: typeof v === 'function' ? v() : v }
      const cell = slots[k]
      return [cell.v, (n) => { cell.v = typeof n === 'function' ? n(cell.v) : n }]
    },
    useRef(v) { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k] },
    useCallback(fn) { i++; return fn },
    useEffect(fn, deps) {
      const k = i++
      const prev = slots[k]
      if (!prev || !deps || deps.some((d, j) => d !== prev.deps[j])) { slots[k] = { deps }; fn() }
    },
  })
  return { React, begin() { i = 0 } }
}

/* ── 取消证据 / 回执 / 停滞 ── */

test('cancel evidence labels: only a node-confirmed abort says cancelled, in the row and in the detail', () => {
  assert.equal(tasksCancelEvidenceLabel({ cancelEvidence: { state: 'aborted', source: 'node' } }), '已取消（节点确认）')
  assert.equal(tasksCancelEvidenceLabel({ cancelEvidence: { state: 'aborted', source: 'node', abortedBeforeStart: true } }), '已取消（未开始，节点确认）')
  for (const st of ['completed', 'failed', 'interrupted', 'rejected']) {
    const t = { status: st, cancelEvidence: { state: 'terminal', source: 'node' } }
    assert.equal(tasksCancelEvidenceLabel(t), '')
    assert.doesNotMatch(rowText(t), /已取消/)
  }
  assert.doesNotMatch(rowText({ status: 'failed', exit: { timedOut: true }, cancelEvidence: { state: 'terminal', source: 'node' } }), /已取消/)
  const unknown = rowText({ status: 'aborted', cancelEvidence: { state: 'unknown', source: 'none' } })
  assert.ok(unknown.length > 0)
  assert.doesNotMatch(unknown, /已取消（/)
  assert.match(rowText({ status: 'aborted', cancelEvidence: { state: 'aborted', source: 'node' } }), /已取消（节点确认）/)
  assert.equal(tasksCancelEvidenceLabel(null), '')
  assert.equal(tasksCancelEvidenceLabel({}), '')
  const t = Object.assign({}, base, { status: 'aborted', cancelEvidence: { state: 'aborted', source: 'node' } })
  assert.match(detailText(t), /取消证据.*已取消（节点确认）/)
})

test('cancel receipt: three kinds, the pre-click state wins, no forbidden claims', () => {
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
    const r = tasksCancelReceipt(args)
    assert.equal(r.kind, kind)
    assert.equal(r.text, copy)
    assert.doesNotMatch(r.text, /已送达|已发送|离线|已取消|marked/)
  }
  // 「已提交」不等于已取消：刷新后仍在跑的任务不显示已取消
  assert.doesNotMatch(rowText({ status: 'running', cancelEvidence: { state: 'unknown', source: 'none' } }), /已取消/)
})

test('no "marked" wording anywhere in the row or detail rendering', () => {
  for (const status of ['running', 'queued', 'aborted', 'rejected', 'completed']) {
    const t = Object.assign({}, base, { status, cancelEvidence: { state: 'unknown', source: 'none' }, stallHint: { stalled: true, idleMs: 300000 } })
    assert.doesNotMatch(rowText(t), /marked/i)
    assert.doesNotMatch(detailText(t), /marked/i)
  }
})

test('stall hint only for non-terminal tasks, in the row and as 停滞提示 in the detail', () => {
  const sh = { stalled: true, idleMs: 300000 }
  assert.equal(tasksStallLabel({ status: 'running', stallHint: sh }), '已 5 分钟无更新（仅提示）')
  assert.equal(tasksStallLabel({ status: 'queued', stallHint: sh }), '已 5 分钟无更新（仅提示）')
  assert.equal(tasksStallLabel({ status: 'completed', stallHint: sh }), '')
  assert.equal(tasksStallLabel({ status: 'running', stallHint: { stalled: false, idleMs: 0 } }), '')
  assert.equal(tasksStallLabel({ status: 'running' }), '')
  assert.match(rowText({ status: 'running', stallHint: sh }), /已 5 分钟无更新（仅提示）/)
  assert.doesNotMatch(rowText({ status: 'completed', stallHint: sh }), /无更新/)
  assert.match(detailText(Object.assign({}, base, { status: 'running', stallHint: { stalled: true, idleMs: 130000 }, exit: { code: 1 } })), /停滞提示.*已 2 分钟无更新/)
})

test('rendering deep-frozen tasks neither throws nor mutates them', () => {
  const tasks = deepFreeze([
    Object.assign({}, base, { status: 'running', cancelEvidence: { state: 'unknown', source: 'none' }, stallHint: { stalled: true, idleMs: 130000 }, exit: { code: 1 }, progressTail: [{ detail: 'x' }] }),
    Object.assign({}, base, { taskId: 't2', status: 'aborted', cancelEvidence: { state: 'aborted', source: 'node' } }),
  ])
  const snap = JSON.stringify(tasks)
  const handoff = deepFreeze({ summaryText: 's', artifacts: { final: [{ path: 'a', bytes: 1 }], counts: { total: 1, final: 1, intermediate: 0, other: 0 } }, diffs: [] })
  for (const t of tasks) { rowText(t); detailText(t, handoff) }
  textOf(view({ hub: deepFreeze({ tasks, tickets: [{ ticketId: 'tk', state: 'open', hasExecutor: false }] }) }))
  assert.equal(JSON.stringify(tasks), snap)
})

test('cancel click: exactly one POST /cancel and one refresh, the receipt comes from the response, a double click does not post twice', async () => {
  const posts = []
  const notes = []
  const h = live()
  const core = Object.assign({}, makeCore(), { React: h.React })
  core.api = { get: () => Promise.resolve({ templates: [] }), post: (p, b) => { posts.push([p, b]); return Promise.resolve({ ok: true, requested: true }) } }
  const mod = createTasks(core)
  let refreshed = 0
  const hub = Object.assign({}, dataEmptyHub, { loading: false, nodes: [{ nodeId: 'node-1', online: true }], tasks: [Object.assign({}, base, { status: 'running' })] })
  h.begin()
  const props = mod.Screen({ hub, ui: {}, role: 'hub', go: noop, refresh: () => { refreshed += 1 } }).props
  props.onAct(base.taskId, 'cancel')
  props.onAct(base.taskId, 'cancel')
  await tick()
  assert.deepEqual(posts, [['/cancel', { taskId: base.taskId }]])
  assert.equal(refreshed, 1)
  h.begin()
  const after = mod.Screen({ hub, ui: {}, role: 'hub', go: noop, refresh: noop }).props
  notes.push(after.note)
  assert.deepEqual(notes[0], { text: '已提交取消请求，等待任务状态更新', tone: 'ok' })
  assert.deepEqual(after.busyKeys, {})
})

/* ── 工单 ── */

const open = { ticketId: 'tk_open', state: 'open', hasExecutor: true }
const ended = { ticketId: 'tk_ended', state: 'ended', hasExecutor: false }
const interrupted = { ticketId: 'tk_interrupted', state: 'interrupted', hasExecutor: true }

test('ticket stages map fixture states (live /tickets carries no executorState)', () => {
  for (const kind of ['answer', 'review', 'blocked', 'failed']) {
    assert.deepEqual(tasksTicketStage(open, { attention: { kind }, running: true }), { stage: 'person', reason: kind })
  }
  assert.deepEqual(tasksTicketStage(open, { running: true }), { stage: 'working' })
  for (const malformed of [null, undefined, false, 7, 'open', { state: 'other' }]) {
    assert.deepEqual(tasksTicketStage(malformed, { running: true }), { stage: 'idle' })
  }
  assert.deepEqual(tasksTicketStage(open, { attention: { kind: 'unknown' } }), { stage: 'idle' })
  assert.deepEqual(tasksTicketStage(open), { stage: 'idle' })
  for (const t of [ended, interrupted]) assert.deepEqual(tasksTicketStage(t, { attention: { kind: 'answer' }, running: true }), { stage: 'ended' })
})

test('attention tickets sort before working before idle, without reordering the input', () => {
  const rows = [{ running: true }, { attention: { kind: 'review' } }, undefined].map((s) => tasksTicketStage(open, s))
  assert.deepEqual(tasksSortAttention(rows).map((r) => r.stage), ['person', 'working', 'idle'])
  assert.deepEqual(rows.map((r) => r.stage), ['working', 'person', 'idle'])
  assert.deepEqual(tasksAttentionRows([open, { ticketId: 'x', state: 'open', executorState: { attention: { kind: 'review' } } }]).map((r) => r.ticket.ticketId), ['x', 'tk_open'])
})

const folds = (el) => findAll(expand(el), (n) => n.type === 'details' && /待你处理的工单/.test(texts(n).join('')))

test('ticket fold: ended tickets never show, absent/null/empty props render no fold', () => {
  const task = Object.assign({}, base, { status: 'running' })
  const [fold] = folds(view({ hub: { tasks: [task], tickets: [ended, open, interrupted] } }))
  assert.ok(fold)
  assert.doesNotMatch(texts(fold).join(''), /tk_ended|tk_interrupted/)
  assert.match(texts(fold).join(''), /tk_open/)
  assert.equal(folds(view({ hub: { tasks: [task], tickets: [ended] } })).length, 0)
  for (const tickets of [undefined, null, [], {}, 'x']) assert.equal(folds(view({ hub: { tasks: [task], tickets } })).length, 0)
})

test('ticket fold is one closed details with a summary and no controls when nothing needs a person', () => {
  const [fold] = folds(view({ hub: { tickets: [open] } }))
  assert.ok(fold)
  assert.equal(fold.props.open, undefined)
  const all = findAll(fold, () => true)
  assert.equal(all.filter((n) => n.type === 'details').length, 1)
  assert.equal(all.filter((n) => n.type === 'summary').length, 1)
  assert.equal(all.some((n) => n.type === 'button' || Object.keys(n.props || {}).some((k) => /^on[A-Z]/.test(k))), false)
  assert.match(texts(fold).join(''), /未结束.*已关联执行器/)
  const [person] = folds(view({ hub: { tickets: [Object.assign({}, open, { executorState: { attention: { kind: 'answer' } } })] } }))
  assert.equal(person.props.open, true)
  assert.match(texts(person).join(''), /需要你回答/)
})

test('hub snapshot tolerates /tickets failure and malformed replies (tickets become undefined, no error banner)', async () => {
  const broken = new Error('ticket fetch failed')
  let reply = { tickets: [open] }
  const h = live()
  const core = Object.assign({}, makeCore(), { React: h.React })
  core.api = {
    get: (p) => {
      if (p === '/overview') return Promise.resolve({ nodes: [] })
      if (p === '/tasks') return Promise.resolve({ tasks: [] })
      if (p === '/tickets') return reply === broken ? Promise.reject(broken) : Promise.resolve(reply)
      return Promise.resolve({})
    },
  }
  const data = createData(core)
  const render = () => { h.begin(); return data.useHub(true, false) }
  render()
  await tick()
  let r = render()
  assert.deepEqual(r.hub.tickets, [open])
  for (const absent of [broken, null, {}, { tickets: null }, { tickets: {} }]) {
    reply = absent
    await r.refresh()
    render()
    await tick()
    r = render()
    assert.equal(r.hub.error, '')
    assert.equal(r.hub.tickets, undefined)
    assert.equal(folds(view({ hub: { tickets: r.hub.tickets } })).length, 0)
  }
  reply = { tickets: [] }
  await r.refresh()
  render()
  await tick()
  r = render()
  assert.deepEqual(r.hub.tickets, [])
})

/* ── 模板接线 ── */

test('template dropdown applies on selection; applying a template clears optional fields of the previous one', () => {
  const picked = []
  const list = [{ id: 't1', name: 'A', goal: 'ga', mode: 'agent' }]
  const v = view({ tpl: Object.assign({}, tplEmpty, { list }), onTplApply: (id) => picked.push(id) })
  const select = findAll(expand(v), (n) => n.type === 'select' && n.props.title !== undefined)[0]
  select.props.onChange({ target: { value: 't1' } })
  assert.deepEqual(picked, ['t1'])
  assert.ok(findButtons(v, '存为模板').length === 1 && findButtons(v, '删除模板').length === 1)
  // 从带目录/产出/超时的状态切到什么都不带的模板：旧值不能留下
  const dirty = Object.assign(tasksNewForm(), { goal: 'old', mode: 'exec', workspace: '/dir/of/A', outputs: 'a, b', timeoutMs: '5000', model: 'p/m', node: 'n1', needApproval: true })
  const f = tasksFormFromTemplate({ id: 't2', name: 'B', goal: 'gb' }, dirty)
  assert.deepEqual(f, { goal: 'gb', node: 'n1', mode: 'agent', workspace: '', model: '', outputs: '', timeoutMs: '', needApproval: true, templateId: 't2' })
  assert.equal(tasksFormFromTemplate({ id: 't3', name: 'C', goal: 'g', model: { provider: 'p', model: 'm' } }, dirty).model, 'p/m')
})

/* ── 清理确认 ── */

test('purge: the 清理历史任务 button confirms first; declining sends nothing', async () => {
  const posts = []
  const asked = []
  const h = live()
  const core = Object.assign({}, makeCore(), { React: h.React })
  core.api = { get: () => Promise.resolve({ templates: [] }), post: (p, b) => { posts.push([p, b]); return Promise.resolve({ ok: true, removed: 2 }) } }
  const mod = createTasks(core)
  let answer = false
  const ui = { confirm: (m) => { asked.push(m); return Promise.resolve(answer) } }
  const hub = Object.assign({}, dataEmptyHub, { loading: false, nodes: [], tasks: [Object.assign({}, base, { status: 'completed' })] })
  h.begin()
  const props = mod.Screen({ hub, ui, role: 'hub', go: noop, refresh: noop }).props
  assert.equal(findButtons(view({ hub: { tasks: hub.tasks }, onPurge: props.onPurge }), '清理历史任务')[0].props.onClick, props.onPurge)
  props.onPurge()
  await tick()
  assert.deepEqual(asked, ['清理已结束的历史任务？运行中的任务会保留。'])
  assert.deepEqual(posts, [])
  answer = true
  props.onPurge()
  await tick()
  assert.deepEqual(posts, [['/purge', { includeActive: false }]])
})

/* ── 轮询不重置界面状态 ── */

test('hub polling keeps the form, selection and filter; templates are not refetched; detail refetches once per tick and never stacks', async () => {
  const log = []
  let releaseDetail = null
  const h = live()
  const core = Object.assign({}, makeCore(), { React: h.React })
  core.api = {
    get: (p) => {
      log.push(p)
      if (p === '/templates') return Promise.resolve({ templates: [] })
      return new Promise((resolve) => { releaseDetail = () => resolve({ task: Object.assign({}, base, { status: 'running' }), handoff: null }) })
    },
    post: () => Promise.resolve({}),
  }
  const mod = createTasks(core)
  const mk = (tickN) => Object.assign({}, dataEmptyHub, { loading: false, tick: tickN, nodes: [{ nodeId: 'node-1', online: true }], tasks: [Object.assign({}, base, { status: 'running' })] })
  const render = (hub) => { h.begin(); return mod.Screen({ hub, ui: {}, role: 'hub', go: noop, refresh: noop }).props }
  let p = render(mk(1))
  p.onForm({ goal: 'half typed', workspace: '/w' })
  p.onFilter('failed')
  p.onSelect(base.taskId)
  p = render(mk(1))
  assert.equal(p.selected, base.taskId)
  assert.deepEqual(log, ['/templates', '/task?taskId=' + base.taskId])
  // 详情还在飞，新的一拍到来：不叠第二个请求
  render(mk(2))
  assert.equal(log.length, 2)
  releaseDetail()
  await tick()
  // 上一次读完后，新的一拍重读一次；它又在飞时再来的一拍不叠请求；表单、选中、筛选原样
  render(mk(3))
  assert.equal(log.filter((x) => x.startsWith('/task?')).length, 2)
  p = render(mk(4))
  assert.equal(log.filter((x) => x.startsWith('/task?')).length, 2)
  assert.equal(log.filter((x) => x === '/templates').length, 1)
  assert.equal(p.form.goal, 'half typed')
  assert.equal(p.form.workspace, '/w')
  assert.equal(p.filter, 'failed')
  assert.equal(p.selected, base.taskId)
  releaseDetail()
  await tick()
  p = render(mk(5))
  assert.equal(log.filter((x) => x.startsWith('/task?')).length, 3)
  assert.equal(p.detail.task.taskId, base.taskId)
  assert.equal(p.selected, base.taskId)
})
