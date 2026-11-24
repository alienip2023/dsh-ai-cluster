// 分配台账（只读）：行构建、状态、节点筛选、懒加载与打开期间的刷新、清理后仍可查阅的说明。
import assert from 'node:assert/strict'
import test from 'node:test'
import { expand, findAll, findByClass, makeCore, texts, textOf } from './_fake.js'
import { dataEmptyHub } from '../../src/panel/data.js'
import {
  createTasks, tasksLedgerFilter, tasksLedgerNew, tasksLedgerNodes, tasksLedgerRows, tasksLedgerStage, tasksLedgerText,
} from '../../src/panel/tasks.js'

const noop = () => {}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
const T0 = 1_700_000_000_000
const rec = (taskId, extra) => Object.assign({ taskId, nodeId: 'n1', status: 'completed', startedAt: T0 - 5000, endedAt: T0, at: T0 + 10 }, extra)
const nodes = [{ nodeId: 'n1', hostname: 'mac-mini', online: true }, { nodeId: 'n2', hostname: 'win-box', online: false }]
const hubTask = (taskId, extra) => Object.assign({ taskId, nodeId: 'n1', status: 'completed', goal: 'goal of ' + taskId }, extra)

/* ── 行构建 ── */

test('rows: newest first, one row per task with the count of older records', () => {
  const rows = tasksLedgerRows([
    rec('a', { at: T0 + 1 }), rec('b', { at: T0 + 3 }), rec('a', { status: 'failed', at: T0 + 2 }), rec('c', { at: T0 + 2 }),
  ], [], nodes)
  assert.deepEqual(rows.map((r) => r.taskId), ['b', 'a', 'c'].sort((x, y) => ({ b: 3, a: 2, c: 2 })[y] - ({ b: 3, a: 2, c: 2 })[x] || 0))
  assert.deepEqual(rows.map((r) => [r.taskId, r.status, r.older]), [['b', 'completed', 0], ['a', 'failed', 1], ['c', 'completed', 0]])
})

test('rows: unknown and missing fields never throw and degrade to honest text', () => {
  const rows = tasksLedgerRows([
    null, 7, 'x', {}, { taskId: '' }, { taskId: 5 },
    { taskId: 'weird', status: 42, nodeId: null, startedAt: 'x', endedAt: NaN, at: undefined },
    { taskId: 'novel', nodeId: 'zz', status: 'brand_new_status', at: T0 },
  ], undefined, undefined)
  assert.deepEqual(rows.map((r) => r.taskId), ['novel', 'weird'])
  const weird = rows[1]
  assert.equal(weird.status, 'unknown')
  assert.equal(weird.statusText, '未知')
  assert.equal(weird.nodeName, '未知机器')
  assert.equal(weird.nodeId, '')
  assert.equal(weird.at, 0)
  assert.equal(weird.durationMs, null)
  assert.equal(weird.goal, '')
  assert.equal(weird.exists, false)
  assert.equal(rows[0].statusText, 'brand_new_status')
  assert.equal(rows[0].nodeName, 'zz')
  for (const bad of [undefined, null, {}, 'x', 5]) assert.deepEqual(tasksLedgerRows(bad, bad, bad), [])
})

test('rows: time falls back to endedAt, duration only when derivable, goal sources in priority order', () => {
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.taskId, r]))
  const { a, b, c, d } = byId(tasksLedgerRows([
    rec('a', { at: 0, endedAt: T0 + 7, startedAt: T0 + 2 }),
    rec('b', { startedAt: 0 }),
    rec('c', { startedAt: T0, endedAt: T0 - 1 }),
    rec('d', { goal: 'from record', summary: 'sum' }),
  ], [hubTask('d'), hubTask('b')], nodes))
  assert.equal(tasksLedgerRows([rec('a', { at: 0, endedAt: T0 + 7 })], [], nodes)[0].at, T0 + 7)
  assert.equal(a.durationMs, 5)
  assert.equal(b.durationMs, null)
  assert.equal(c.durationMs, null)
  assert.equal(d.goal, 'from record')
  assert.equal(b.goal, 'goal of b')
  assert.equal(tasksLedgerRows([rec('s', { summary: ' sum text ' })], [hubTask('s')], nodes)[0].goal, 'sum text')
  assert.equal(tasksLedgerRows([rec('s')], [], nodes)[0].goal, '')
})

test('rows: exists reflects whether the task is still in hub.tasks (purged tasks keep their ledger row)', () => {
  const before = tasksLedgerRows([rec('t1')], [hubTask('t1')], nodes)
  const after = tasksLedgerRows([rec('t1')], [], nodes)
  assert.equal(before[0].exists, true)
  assert.equal(after[0].exists, false)
  assert.equal(after[0].taskId, 't1')
  assert.equal(after[0].status, 'completed')
})

/* ── 节点筛选 / 状态机 ── */

test('node filter: hub nodes plus nodes only the ledger remembers; filtering keeps order', () => {
  const rows = tasksLedgerRows([rec('a', { nodeId: 'n2', at: 3 }), rec('b', { nodeId: 'gone', at: 2 }), rec('c', { nodeId: 'n1', at: 1 })], [], nodes)
  assert.deepEqual(tasksLedgerNodes(rows, nodes), [{ id: 'n1', label: 'mac-mini' }, { id: 'n2', label: 'win-box' }, { id: 'gone', label: 'gone' }])
  assert.deepEqual(tasksLedgerFilter(rows, 'n2').map((r) => r.taskId), ['a'])
  assert.deepEqual(tasksLedgerFilter(rows, '').map((r) => r.taskId), ['a', 'b', 'c'])
  assert.deepEqual(tasksLedgerFilter(rows, 'nobody'), [])
  assert.deepEqual(tasksLedgerNodes([], undefined), [])
})

test('stage: loading until first answer, error only without rows, unavailable, empty, rows', () => {
  const L = (o) => Object.assign(tasksLedgerNew(), o)
  const row = tasksLedgerRows([rec('a')], [], nodes)
  assert.equal(tasksLedgerStage(L({}), [], []), 'loading')
  assert.equal(tasksLedgerStage(L({ loading: true }), [], []), 'loading')
  assert.equal(tasksLedgerStage(L({ error: 'boom' }), [], []), 'error')
  assert.equal(tasksLedgerStage(L({ loaded: true, error: 'boom' }), row, row), 'rows')
  assert.equal(tasksLedgerStage(L({ loaded: true, unavailable: true }), [], []), 'unavailable')
  assert.equal(tasksLedgerStage(L({ loaded: true }), [], []), 'empty')
  assert.equal(tasksLedgerStage(L({ loaded: true }), row, []), 'empty')
  assert.equal(tasksLedgerStage(L({ loaded: true }), row, row), 'rows')
})

/* ── 渲染 ── */

function ledgerEl(over) {
  const core = makeCore()
  const { Ledger } = createTasks(core).parts
  const props = Object.assign({ ledger: Object.assign(tasksLedgerNew(), { open: true, loaded: true }), node: '', tasks: [], nodes, onToggle: noop, onNode: noop, onRetry: noop, onSelect: noop }, over)
  return core.h(Ledger, props)
}
const open = (o) => Object.assign(tasksLedgerNew(), { open: true, loaded: true }, o)

test('closed: a details with the title and no body content, no badge before the first load', () => {
  const el = ledgerEl({ ledger: tasksLedgerNew() })
  const d = expand(el)
  assert.equal(d.type, 'details')
  assert.equal(d.props.open, false)
  assert.match(textOf(el), /分配台账/)
  assert.doesNotMatch(textOf(el), /读取台账|还没有记录|按机器筛选/)
  assert.equal(findByClass(el, 'dra-fold-badge').length, 0)
})

test('toggling the details reports the new open state', () => {
  const calls = []
  const d = expand(ledgerEl({ ledger: tasksLedgerNew(), onToggle: (v) => calls.push(v) }))
  d.props.onToggle({ target: { open: true } })
  d.props.onToggle({ target: { open: false } })
  assert.deepEqual(calls, [true, false])
})

test('states: loading, empty (with the purge-survival wording), unavailable (no data-loss claim), error with the original text and retry', () => {
  assert.match(textOf(ledgerEl({ ledger: Object.assign(tasksLedgerNew(), { open: true }) })), /读取台账…/)
  const empty = textOf(ledgerEl({ ledger: open({ items: [] }) }))
  assert.match(empty, /还没有记录；任务结束后会记在这里，清理历史任务不会删除它/)
  assert.equal(tasksLedgerText.empty, '还没有记录；任务结束后会记在这里，清理历史任务不会删除它')
  const un = textOf(ledgerEl({ ledger: open({ unavailable: true }) }))
  assert.match(un, /主机没有返回台账/)
  assert.doesNotMatch(un, /已丢失|数据丢失|被清除|已被删除/)
  assert.match(un, /不代表记录丢失/)
  const retries = []
  const el = ledgerEl({ ledger: Object.assign(tasksLedgerNew(), { open: true, error: 'HTTP 502 bad gateway（x）' }), onRetry: () => retries.push(1) })
  assert.match(textOf(el), /读不到台账.*HTTP 502 bad gateway（x）/)
  findAll(expand(el), (n) => n.type === 'button' && texts(n).join('') === '重试')[0].props.onClick()
  assert.deepEqual(retries, [1])
  assert.match(textOf(ledgerEl({ ledger: open({ items: [rec('a', { nodeId: 'n1' })] }), node: 'n2' })), /这台机器还没有记录/)
})

test('rows render: glyph-bearing status badge with text, time, node, short id, copy, duration; details only for live tasks', () => {
  const picks = []
  const items = [
    rec('abcdefghijklmnop', { status: 'failed', at: T0 + 5, startedAt: T0 - 65000, endedAt: T0 }),
    rec('gone-task-1', { status: 'completed', at: T0 + 1, nodeId: 'n2' }),
  ]
  const el = ledgerEl({ ledger: open({ items }), tasks: [hubTask('abcdefghijklmnop')], onSelect: (id) => picks.push(id) })
  const out = textOf(el)
  assert.match(out, /失败/)
  assert.match(out, /已完成/)
  assert.match(out, /mac-mini/)
  assert.match(out, /win-box/)
  assert.match(out, /abcdefghij/)
  assert.deepEqual(findByClass(el, 'dra-mono').map((n) => texts(n).join('')), ['abcdefghij', 'gone-task-'])
  assert.match(out, /耗时 1m5s/)
  assert.match(out, /goal of abcdefghijklmnop/)
  assert.match(out, /任务记录已清理，台账保留/)
  assert.equal(findByClass(el, 'dra-fold-badge').length, 1)
  assert.equal(texts(findByClass(el, 'dra-fold-badge')[0]).join(''), '2')
  const badges = findByClass(el, 'dra-badge')
  assert.ok(badges.some((b) => texts(b).join('') === '失败' && b.props.className.includes('bad')))
  assert.ok(badges.some((b) => texts(b).join('') === '已完成' && b.props.className.includes('ok')))
  const details = findAll(expand(el), (n) => n.type === 'button' && texts(n).join('') === '看详情')
  assert.equal(details.length, 1)
  details[0].props.onClick()
  assert.deepEqual(picks, ['abcdefghijklmnop'])
  const copies = findAll(expand(el), (n) => n.type === 'button' && n.props.title === '复制任务 ID')
  assert.equal(copies.length, 2)
  // 只读：除了「看详情」「复制」，没有任何会改动数据的按钮
  const labels = findAll(expand(el), (n) => n.type === 'button').map((b) => texts(b).join(''))
  assert.ok(labels.every((l) => ['看详情', '复制'].includes(l)), labels.join(','))
})

test('purge survival: a ledger row stays and says so after the task left hub.tasks', () => {
  const items = [rec('t1')]
  const live = textOf(ledgerEl({ ledger: open({ items }), tasks: [hubTask('t1')] }))
  assert.match(live, /看详情/)
  assert.doesNotMatch(live, /任务记录已清理/)
  const purged = textOf(ledgerEl({ ledger: open({ items }), tasks: [] }))
  assert.match(purged, /任务记录已清理，台账保留/)
  assert.doesNotMatch(purged, /看详情/)
  assert.match(purged, /已完成/)
  assert.match(purged, /清理历史任务和重启都不会删除台账/)
})

test('node filter select lists all + each node, keeps the chosen value, reports changes', () => {
  const picked = []
  const el = ledgerEl({ ledger: open({ items: [rec('a', { nodeId: 'zz' })] }), node: 'n2', onNode: (v) => picked.push(v) })
  const select = findAll(expand(el), (n) => n.type === 'select')[0]
  assert.equal(select.props.value, 'n2')
  assert.deepEqual(findAll(select, (n) => n.type === 'option').map((o) => [o.props.value, texts(o).join('')]), [['', '全部机器'], ['n1', 'mac-mini'], ['n2', 'win-box'], ['zz', 'zz']])
  select.props.onChange({ target: { value: 'n1' } })
  assert.deepEqual(picked, ['n1'])
  assert.ok(findAll(expand(el), (n) => n.type === 'label' && /按机器筛选/.test(texts(n).join(''))).length === 1)
})

/* ── 懒加载与刷新（Screen 上的真实 effect）── */

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

function mount(replyFor) {
  const log = []
  const h = live()
  const core = Object.assign({}, makeCore(), { React: h.React })
  core.api = {
    get: (p) => { log.push(p); return p === '/templates' ? Promise.resolve({ templates: [] }) : replyFor(p, log.filter((x) => x.startsWith('/assignments')).length) },
    post: () => Promise.resolve({}),
  }
  const mod = createTasks(core)
  const hubAt = (t, tasks) => Object.assign({}, dataEmptyHub, { loading: false, tick: t, nodes, tasks: tasks || [] })
  const render = (hub) => { h.begin(); return mod.Screen({ hub, ui: {}, role: 'hub', go: noop, refresh: noop }).props }
  const ledgerCalls = () => log.filter((x) => x.startsWith('/assignments'))
  return { render, hubAt, log, ledgerCalls }
}

test('lazy: nothing is fetched while the section is closed, however many ticks pass', async () => {
  const m = mount(() => Promise.resolve({ assignments: [] }))
  m.render(m.hubAt(1))
  m.render(m.hubAt(2))
  m.render(m.hubAt(3))
  await tick()
  assert.deepEqual(m.ledgerCalls(), [])
  assert.deepEqual(m.log, ['/templates'])
})

test('opening fetches once (limit 200, all machines); ticks while open refresh; in flight never stacks; filter survives; closing stops refreshing', async () => {
  let release = null
  const answers = [{ assignments: [rec('a'), rec('b', { nodeId: 'n2' })] }, { assignments: [rec('a'), rec('b', { nodeId: 'n2' }), rec('c')] }]
  const m = mount((p, n) => (n === 1 ? new Promise((resolve) => { release = () => resolve(answers[0]) }) : Promise.resolve(answers[1])))
  let p = m.render(m.hubAt(1))
  p.onLedgerToggle(true)
  p.onLedgerNode('n2')
  m.render(m.hubAt(1))
  assert.deepEqual(m.ledgerCalls(), ['/assignments?limit=200'])
  p = m.render(m.hubAt(1))
  assert.equal(p.ledger.open, true)
  assert.equal(p.ledger.loading, true)
  assert.equal(p.ledger.loaded, false)
  // 第一次还在飞：新的 tick 不叠请求
  m.render(m.hubAt(2))
  assert.equal(m.ledgerCalls().length, 1)
  release()
  await tick()
  p = m.render(m.hubAt(2))
  assert.equal(p.ledger.loaded, true)
  assert.equal(p.ledger.items.length, 2)
  assert.equal(p.ledgerNode, 'n2')
  // 打开期间随 tick 刷新；节点筛选不被重置
  m.render(m.hubAt(3))
  await tick()
  p = m.render(m.hubAt(3))
  assert.equal(m.ledgerCalls().length, 2)
  assert.equal(p.ledger.items.length, 3)
  assert.equal(p.ledgerNode, 'n2')
  // 同一 tick 重绘不重复请求
  m.render(m.hubAt(3))
  assert.equal(m.ledgerCalls().length, 2)
  // 收起后不再请求，再打开才再请求
  p.onLedgerToggle(false)
  m.render(m.hubAt(3))
  m.render(m.hubAt(4))
  m.render(m.hubAt(5))
  await tick()
  assert.equal(m.ledgerCalls().length, 2)
  p = m.render(m.hubAt(5))
  p.onLedgerToggle(true)
  m.render(m.hubAt(5))
  await tick()
  assert.equal(m.ledgerCalls().length, 3)
  assert.equal(m.render(m.hubAt(5)).ledgerNode, 'n2')
})

test('errors keep the original text and the last good rows; a later success clears the error; no ledger body means unavailable', async () => {
  let mode = 'ok'
  const m = mount(() => {
    if (mode === 'ok') return Promise.resolve({ assignments: [rec('a')] })
    if (mode === 'fail') return Promise.reject(Object.assign(new Error('HTTP 503'), { status: 503 }))
    return Promise.resolve({ ok: false, code: 'not-available' })
  })
  let p = m.render(m.hubAt(1))
  p.onLedgerToggle(true)
  m.render(m.hubAt(1))
  await tick()
  p = m.render(m.hubAt(1))
  assert.equal(p.ledger.items.length, 1)
  mode = 'fail'
  m.render(m.hubAt(2))
  await tick()
  p = m.render(m.hubAt(2))
  assert.equal(p.ledger.error, 'HTTP 503')
  assert.equal(p.ledger.items.length, 1)
  assert.equal(p.ledger.loaded, true)
  mode = 'ok'
  m.render(m.hubAt(3))
  await tick()
  p = m.render(m.hubAt(3))
  assert.equal(p.ledger.error, '')
  mode = 'none'
  m.render(m.hubAt(4))
  await tick()
  p = m.render(m.hubAt(4))
  assert.equal(p.ledger.unavailable, true)
  assert.deepEqual(p.ledger.items, [])
  assert.equal(p.ledger.error, '')
})

test('Screen renders the ledger below the task list and the retry handler refetches', async () => {
  let fails = true
  const m = mount(() => (fails ? Promise.reject(new Error('down')) : Promise.resolve({ assignments: [rec('a')] })))
  let p = m.render(m.hubAt(1))
  p.onLedgerToggle(true)
  m.render(m.hubAt(1))
  await tick()
  p = m.render(m.hubAt(1))
  assert.equal(p.ledger.error, 'down')
  fails = false
  p.onLedgerRetry()
  await tick()
  p = m.render(m.hubAt(1))
  assert.equal(p.ledger.error, '')
  assert.equal(p.ledger.items.length, 1)
  // 视图里台账折叠区在任务列表之后
  const core = makeCore()
  const { TasksView } = createTasks(core).parts
  const tree = expand(core.h(TasksView, Object.assign({}, p, { hub: m.hubAt(1, [hubTask('a')]), now: T0, detailRef: { current: null } })))
  const order = findAll(tree, (n) => n.type === 'details' || (n.type === 'section' && /任务/.test(n.props['aria-label'] || ''))).map((n) => n.props['aria-label'] || texts(n)[0])
  assert.ok(order.indexOf('任务') >= 0)
  assert.equal(order[order.length - 1], '分配台账')
})
