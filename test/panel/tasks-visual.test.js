// 任务屏的视觉契约（Aurora Glass，见 src/panel/DESIGN.md）：样式纪律，以及「状态驱动的动效 / 层级」落在了正确的元素上。
import assert from 'node:assert/strict'
import test from 'node:test'
import { expand, findAll, findByClass, makeCore, texts, textOf } from './_fake.js'
import { dataEmptyHub } from '../../src/panel/data.js'
import { createTasks, tasksNewForm, tasksLedgerNew, tasksStatusTone } from '../../src/panel/tasks.js'

const noop = () => {}
const NOW = 1_700_000_000_000
const node = { nodeId: 'n1', hostname: 'mac-mini', online: true, os: 'darwin' }
const task = (id, status, extra) => Object.assign({ taskId: id, nodeId: 'n1', status, goal: 'goal ' + id, mode: 'agent', createdAt: NOW - 9000, updatedAt: NOW - 1000, startedAt: NOW - 8000 }, extra)
const tplEmpty = { loading: false, list: [], max: 0, degraded: false, reason: '', file: '', error: '' }

function view(over, hubOver) {
  const core = makeCore()
  const mod = createTasks(core)
  const hub = Object.assign({}, dataEmptyHub, { loading: false, nodes: [node], tasks: [], caps: { pull: true, pullRoot: '/r' }, tickets: undefined }, hubOver)
  const props = Object.assign({
    hub, now: NOW, go: noop, note: null, onNoteClose: noop, form: tasksNewForm(), onForm: noop, modelCustom: false, onModelCustom: noop, dispatching: false,
    onDispatch: noop, tpl: tplEmpty, tplMsg: '', tplBusy: false, onTplApply: noop, onTplSave: noop, onTplDelete: noop, filter: 'all', onFilter: noop,
    purgeBusy: false, onPurge: noop, selected: '', detail: null, detailRef: { current: null }, busyKeys: {}, onSelect: noop, onClose: noop, onAct: noop,
    ledger: tasksLedgerNew(), ledgerNode: '', onLedgerToggle: noop, onLedgerNode: noop, onLedgerRetry: noop,
  }, over)
  return { mod, el: core.h(mod.parts.TasksView, props) }
}
const classes = (n) => String(n.props.className || '').split(/\s+/)
const rows = (el) => findAll(expand(el), (n) => n.type === 'li' && classes(n).includes('tk-row'))
const rowBtn = (row, label) => findAll(row, (n) => n.type === 'button' && texts(n).join('') === label)[0]

/* ── 样式纪律 ── */

test('css: tokens only, radius hierarchy, no hover movement, no !important, no viewport media queries, every rule namespaced', () => {
  const { mod } = view()
  const css = mod.css.join('\n')
  assert.ok(mod.css.every((r) => typeof r === 'string' && /^\.tk/.test(r)), 'every rule starts with .tk (comments are not in the array)')
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'no hex colours')
  assert.doesNotMatch(css, /\brgba?\(|\bhsla?\(/, 'no rgb/hsl colour constants')
  assert.doesNotMatch(css, /!important/)
  assert.doesNotMatch(css, /translateY|translate\(|scale\(/, 'no movement on hover or elsewhere; press feedback lives in .dra-btn')
  assert.doesNotMatch(css, /@media|@keyframes|@property/, 'no viewport media queries; motion comes from the shared utilities')
  assert.doesNotMatch(css, /animation\s*:/, 'no own animation loops; use .dra-live / .dra-shimmer / .dra-pop')
  assert.doesNotMatch(css, /border-radius:\s*\d/, 'radii come from --dra-r-* tokens')
  assert.doesNotMatch(css, /var\(--dra-text-faint\)/, 'text-faint must not carry text')
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
  const allowed = /^--(dra-[a-z0-9-]+|tk-tone)$/
  for (const t of used) assert.match(t, allowed, t)
})

/* ── 运行中：极光描边 + 进度槽 ── */

test('running rows get the aurora outline and a shimmering progress groove; other statuses do not', () => {
  const running = task('r1', 'running', { progressTail: [{ detail: 'compiling' }] })
  const { el } = view({}, { tasks: [running, task('c1', 'completed'), task('q1', 'queued'), task('f1', 'failed')] })
  const byId = Object.fromEntries(rows(el).map((r) => [texts(r).join('').includes('goal r1') ? 'r1' : texts(r).join('').includes('goal c1') ? 'c1' : texts(r).join('').includes('goal q1') ? 'q1' : 'f1', r]))
  assert.ok(classes(byId.r1).includes('dra-live'))
  assert.ok(!classes(byId.r1).includes('tk-calm'))
  for (const id of ['c1', 'q1', 'f1']) {
    assert.ok(!classes(byId[id]).includes('dra-live'), id)
    assert.ok(classes(byId[id]).includes('tk-calm'), id)
    assert.equal(findByClass(byId[id], 'tk-track').length, 0, id)
  }
  const track = findByClass(byId.r1, 'tk-track')[0]
  assert.equal(track.props.role, 'progressbar')
  assert.match(track.props['aria-label'], /不确定/)
  assert.equal(track.props['aria-valuetext'], 'compiling')
  assert.equal(track.props['aria-valuenow'], undefined, 'indeterminate: never claims a percentage')
  const fill = findByClass(byId.r1, 'tk-track-fill')[0]
  assert.ok(classes(fill).includes('dra-shimmer'))
})

test('a stalled running task keeps its groove but stops shimmering and spinning, and says so in text', () => {
  const t = task('s1', 'running', { stallHint: { stalled: true, idleMs: 240000 } })
  const { el } = view({}, { tasks: [t] })
  const row = rows(el)[0]
  const track = findByClass(row, 'tk-track')[0]
  assert.ok(classes(track).includes('stalled'))
  assert.ok(!classes(row).includes('dra-live') && classes(row).includes('tk-calm'), 'no spinning outline on a task that has gone quiet')
  assert.ok(!classes(findByClass(row, 'tk-track-fill')[0]).includes('dra-shimmer'))
  assert.match(texts(row).join(''), /已 4 分钟无更新（仅提示）/)
  assert.ok(findByClass(row, 'tk-stall').length === 1)
  assert.match(track.props['aria-valuetext'], /暂无更新/)
})

test('detail of a running task shows the same groove; a finished one does not', () => {
  const t = task('r1', 'running')
  const open = view({ selected: 'r1', detail: { id: 'r1', task: t, handoff: null, error: '' } }, { tasks: [t] })
  const section = findAll(expand(open.el), (n) => n.type === 'section' && n.props['aria-label'] === '任务详情')[0]
  assert.equal(findByClass(section, 'tk-track').length, 1)
  const done = task('c1', 'completed')
  const closed = view({ selected: 'c1', detail: { id: 'c1', task: done, handoff: null, error: '' } }, { tasks: [done] })
  assert.equal(findByClass(findAll(expand(closed.el), (n) => n.type === 'section' && n.props['aria-label'] === '任务详情')[0], 'tk-track').length, 0)
})

/* ── 待批准：抬高 + 主/危险按钮对 ── */

test('pending approval rows are raised, with a tinted approve and a danger reject (glyph via CSS, text in the label)', () => {
  const { el, mod } = view({}, { tasks: [task('p1', 'pending_approval', { approval: 'manual' }), task('c1', 'completed')] })
  const [pending, completed] = rows(el)
  assert.ok(classes(pending).includes('tk-raised'))
  assert.ok(!classes(completed).includes('tk-raised'))
  const approve = rowBtn(pending, '批准')
  const reject = rowBtn(pending, '拒绝')
  assert.ok(classes(approve).includes('tk-approve'))
  assert.ok(classes(reject).includes('danger') && classes(reject).includes('tk-reject'))
  assert.ok(!classes(approve).includes('primary'), 'the dispatch button stays the only gradient')
  const css = mod.css.join('\n')
  assert.match(css, /\.tk-approve::before\{content:"✓"\}/)
  assert.match(css, /\.tk-reject::before\{content:"✕"\}/)
  assert.match(css, /\.tk-row\.tk-raised\{[^}]*elev-2/)
  assert.match(texts(pending).join(''), /待批准/)
})

test('the dispatch button is the only .primary on the screen, even with a detail open and approvals pending', () => {
  const t = task('p1', 'pending_approval', { approval: 'manual' })
  const { el } = view({ selected: 'p1', detail: { id: 'p1', task: t, handoff: null, error: '' } }, { tasks: [t] })
  const primaries = findAll(expand(el), (n) => n.type === 'button' && classes(n).includes('primary'))
  assert.equal(primaries.length, 1)
  assert.equal(texts(primaries[0]).join(''), '派发任务')
  assert.ok(classes(primaries[0]).includes('tk-submit'))
  const detail = findAll(expand(el), (n) => n.type === 'section' && n.props['aria-label'] === '任务详情')[0]
  assert.ok(classes(rowBtn(detail, '批准')).includes('tk-approve'))
  assert.ok(classes(rowBtn(detail, '拒绝')).includes('tk-reject'))
})

test('dispatching: the primary button shimmers while the request is in flight and is disabled', () => {
  const { el } = view({ dispatching: true, form: Object.assign(tasksNewForm(), { goal: 'x' }) })
  const btn = findAll(expand(el), (n) => n.type === 'button' && texts(n).join('') === '派发中…')[0]
  assert.ok(classes(btn).includes('dra-shimmer'))
  assert.equal(btn.props.disabled, true)
})

/* ── 象限 ── */

test('quadrants: four glass blocks with a glyph, a big count and the names; zero blocks are marked quiet; needs-you rises only when it has items', () => {
  const { el, mod } = view({}, { tasks: [task('p1', 'pending_approval'), task('r1', 'running'), task('r2', 'running')] })
  const quads = findByClass(el, 'tk-quad')
  assert.deepEqual(quads.map((q) => classes(q)[1]), ['needs', 'working', 'blocked', 'done'])
  assert.ok(classes(quads[0]).includes('hot'))
  assert.ok(classes(quads[2]).includes('zero') && classes(quads[3]).includes('zero'))
  assert.ok(!classes(quads[1]).includes('zero') && !classes(quads[1]).includes('hot'))
  assert.deepEqual(quads.map((q) => texts(findByClass(q, 'tk-quad-count')[0]).join('')), ['1', '2', '0', '0'])
  for (const q of quads) {
    assert.equal(findByClass(q, 'tk-quad-glyph')[0].props['aria-hidden'], 'true')
    assert.ok(q.props['aria-label'].length > 0)
    assert.ok(findAll(q, (n) => n.type === 'h4').length === 1, 'the title is real text, the glyph is decoration')
  }
  const css = mod.css.join('\n')
  for (const glyph of ['▲', '●', '✕', '✓']) assert.ok(css.includes('content:"' + glyph + '"'), glyph)
  assert.match(css, /\.tk-quad-count\{[^}]*tabular-nums/)
})

/* ── 状态徽章 / 时长 ── */

test('status badges keep the tone vocabulary (glyph comes from .dra-badge) and always carry the status text; durations use the mono class', () => {
  assert.equal(tasksStatusTone('unknown'), '')
  assert.equal(tasksStatusTone(''), '')
  assert.equal(tasksStatusTone('mystery'), '', 'a status we do not know is neutral, never painted as running')
  assert.equal(tasksStatusTone('queued'), 'acc')
  const { el } = view({}, { tasks: [task('r1', 'running', { startedAt: NOW - 65000 }), task('f1', 'failed', { durationMs: 4000 })] })
  const badges = findByClass(el, 'dra-badge').filter((b) => b.props.className.includes('tk') === false)
  const texts_ = badges.map((b) => texts(b).join(''))
  assert.ok(texts_.includes('运行中') && texts_.includes('失败'))
  assert.ok(badges.find((b) => texts(b).join('') === '失败').props.className.includes('bad'))
  const durs = findByClass(el, 'tk-dur').map((n) => texts(n).join(''))
  assert.ok(durs.includes('已跑 1m5s') && durs.includes('耗时 4s'))
})

/* ── 工单：分组列表 ── */

test('ticket attention fold is an iOS-style grouped list: one rounded group, one row per open ticket, ended ones absent', () => {
  const tickets = [{ ticketId: 'tk_1', state: 'open', hasExecutor: true }, { ticketId: 'tk_2', state: 'open', hasExecutor: false }, { ticketId: 'tk_3', state: 'ended' }]
  const { el } = view({}, { tasks: [task('r1', 'running')], tickets })
  const groups = findByClass(el, 'tk-ios')
  assert.equal(groups.length, 1)
  const items = findByClass(groups[0], 'tk-ios-row')
  assert.equal(items.length, 2)
  assert.match(texts(items[0]).join(''), /tk_1.*未结束.*已关联执行器/)
  assert.doesNotMatch(textOf(el), /tk_3/)
  assert.ok(classes(findAll(expand(el), (n) => n.props && String(n.props.className || '').includes('tk-attn'))[0]).includes('tk-attn'))
})

/* ── 派发表单 ── */

test('dispatch card is elevated, the template bar is a pill group, inputs use the shared inset controls', () => {
  const { el } = view({ tpl: Object.assign({}, tplEmpty, { degraded: true, reason: 'bad-json' }), tplMsg: '已填充模板「A」' })
  const card = findAll(expand(el), (n) => n.type === 'section' && classes(n).includes('tk-dispatch'))[0]
  assert.ok(card, 'dispatch card carries tk-dispatch')
  const bar = findByClass(card, 'tk-tplbar')[0]
  const pill = findByClass(bar, 'tk-tpl')[0]
  assert.ok(findAll(pill, (n) => n.type === 'select').length === 1)
  assert.deepEqual(findAll(pill, (n) => n.type === 'button').map((b) => texts(b).join('')), ['存为模板', '删除模板'])
  assert.equal(findByClass(pill, 'tk-tpl-msg').length, 0, 'messages sit under the pill, not inside it')
  assert.match(texts(findByClass(bar, 'tk-tpl-msg')[0]).join(''), /模板文件读不出来（bad-json）.*已填充模板「A」/)
  const fields = findAll(card, (n) => n.type === 'select' || n.type === 'textarea' || (n.type === 'input' && n.props.type !== 'checkbox'))
  assert.ok(fields.every((n) => /dra-(select|textarea|input)/.test(n.props.className)))
})

/* ── 详情 ── */

test('task detail is an elevated glass panel that pops in, keyed by the task so switching replays it', () => {
  const t = task('d1', 'completed', { durationMs: 8000, endedAt: NOW - 1000 })
  const { el } = view({ selected: 'd1', detail: { id: 'd1', task: t, handoff: null, error: '' } }, { tasks: [t] })
  const col = findAll(expand(el), (n) => classes(n).includes('tk-detail-col'))[0]
  assert.equal(col.props.key, 'd1')
  const section = findAll(col, (n) => n.type === 'section')[0]
  for (const c of ['dra-card', 'tk-detail', 'dra-pop']) assert.ok(classes(section).includes(c), c)
  assert.equal(section.props['aria-label'], '任务详情')
  assert.equal(section.props.tabIndex, -1)
  const times = findAll(section, (n) => n.type === 'dd' && classes(n).includes('tk-dur')).map((d) => texts(d).join(''))
  assert.ok(times.includes('8s'))
})

/* ── 台账时间线 ── */

test('ledger is a timeline: one node dot per entry, coloured and glyphed by final status, newest first; the badge still carries the text', () => {
  const items = [
    { taskId: 'a', nodeId: 'n1', status: 'failed', startedAt: 1, endedAt: 9, at: 30 },
    { taskId: 'b', nodeId: 'n1', status: 'completed', startedAt: 1, endedAt: 9, at: 20 },
    { taskId: 'c', nodeId: 'n1', status: 'interrupted', startedAt: 1, endedAt: 9, at: 10 },
    { taskId: 'd', nodeId: 'n1', status: 'mystery', startedAt: 1, endedAt: 9, at: 5 },
  ]
  const { el, mod } = view({ ledger: Object.assign(tasksLedgerNew(), { open: true, loaded: true, items }) })
  const list = findByClass(el, 'tk-led-list')[0]
  const entries = findAll(list, (n) => n.type === 'li')
  assert.equal(entries.length, 4)
  const dots = entries.map((e) => findByClass(e, 'tk-led-dot')[0])
  assert.deepEqual(dots.map((d) => classes(d).slice(1).join('')), ['bad', 'ok', 'warn', ''])
  assert.ok(dots.every((d) => d.props['aria-hidden'] === 'true'))
  assert.deepEqual(entries.map((e) => texts(findByClass(e, 'dra-badge')[0]).join('')), ['失败', '已完成', '已中断', 'mystery'])
  const css = mod.css.join('\n')
  assert.match(css, /\.tk-led-list::before\{[^}]*linear-gradient/)
  for (const glyph of ['✓', '✕', '▲', '●', '?']) assert.ok(css.includes('content:"' + glyph + '"'), glyph)
  // 未知状态是中性点（没有色调类），不会被画成「运行中」的强调色
  assert.equal(classes(dots[3]).filter(Boolean).length, 1)
})

test('ledger entries keep the read-only contract after the restyle: copy, details-or-purged note, nothing that mutates', () => {
  const items = [{ taskId: 'live-task-1', nodeId: 'n1', status: 'completed', startedAt: 1, endedAt: 9, at: 2 }, { taskId: 'gone-task-1', nodeId: 'n1', status: 'completed', startedAt: 1, endedAt: 9, at: 1 }]
  const { el } = view({ ledger: Object.assign(tasksLedgerNew(), { open: true, loaded: true, items }) }, { tasks: [task('live-task-1', 'completed')] })
  const list = findByClass(el, 'tk-led-list')[0]
  const labels = findAll(list, (n) => n.type === 'button').map((b) => texts(b).join(''))
  assert.ok(labels.every((l) => ['看详情', '复制'].includes(l)), labels.join(','))
  assert.match(texts(list).join(''), /任务记录已清理，台账保留/)
})
