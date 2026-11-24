import assert from 'node:assert/strict'
import test from 'node:test'
import { findAll, findButtons, findByClass, expand, makeCore, texts, textOf } from './_fake.js'
import { dataEmptyHub } from '../../src/panel/data.js'
import {
  createTasks, tasksAttentionRows, tasksCancelEvidenceLabel, tasksCancelReceipt, tasksChangedLine, tasksCounts, tasksDispatchBody,
  tasksDispatchProblem, tasksDuration, tasksErr, tasksFilterMatch, tasksFinalPaths, tasksFormFromTemplate, tasksGroups, tasksModelOptions,
  tasksModelString, tasksNewForm, tasksParseOutputs, tasksParseTimeout, tasksProgressItemLine, tasksProgressLine, tasksPullBody, tasksPullPrompt,
  tasksPullState, tasksPullSummary, tasksQuadLabel, tasksQuadrants, tasksSortAttention, tasksStallLabel, tasksStatusTone, tasksTemplateBody,
  tasksTicketLabel, tasksTicketStage,
} from '../../src/panel/tasks.js'

const NOW = 1_700_000_000_000
const node = (id, extra) => Object.assign({ nodeId: id, online: true, os: 'linux', hostname: 'host-' + id }, extra)
const task = (id, status, extra) => Object.assign({ taskId: id, nodeId: 'n1', status, goal: 'goal ' + id, mode: 'agent', createdAt: NOW - 1000, updatedAt: NOW - 500 }, extra)
const noop = () => {}

/* ── 纯函数 ── */

test('status tone and filters follow the shared status sets', () => {
  assert.equal(tasksStatusTone('completed'), 'ok')
  assert.equal(tasksStatusTone('failed'), 'bad')
  assert.equal(tasksStatusTone('rejected'), 'bad')
  assert.equal(tasksStatusTone('pending_approval'), 'warn')
  assert.equal(tasksStatusTone('interrupted'), 'warn')
  assert.equal(tasksStatusTone('running'), 'acc')
  const all = ['running', 'queued', 'pending_approval', 'completed', 'failed', 'aborted', 'interrupted', 'rejected'].map((s, i) => task('t' + i, s))
  const ids = (f) => all.filter((t) => tasksFilterMatch(t, f)).map((t) => t.status)
  assert.equal(ids('all').length, 8)
  assert.deepEqual(ids('active'), ['running', 'queued', 'pending_approval'])
  assert.deepEqual(ids('done'), ['completed'])
  assert.deepEqual(ids('failed'), ['failed', 'aborted', 'rejected'])
  assert.deepEqual(tasksCounts(all), { all: 8, active: 3, pending: 1, done: 1, failed: 3, interrupted: 1 })
  const g = tasksGroups(all, 'all')
  assert.equal(g.active.length, 3)
  assert.equal(g.history.length, 5)
  assert.equal(g.labelled, true)
  assert.equal(tasksGroups(all, 'failed').labelled, false)
})

test('duration: active runs to now, terminal prefers durationMs, unknown is null', () => {
  assert.equal(tasksDuration(task('a', 'running', { startedAt: NOW - 5000 }), NOW), 5000)
  assert.equal(tasksDuration(task('a', 'queued', { startedAt: 0 }), NOW), null)
  assert.equal(tasksDuration(task('a', 'completed', { durationMs: 1200 }), NOW), 1200)
  assert.equal(tasksDuration(task('a', 'completed', { durationMs: 0, startedAt: 100, endedAt: 700 }), NOW), 600)
  assert.equal(tasksDuration(task('a', 'completed', { durationMs: 0 }), NOW), null)
})

test('progress line: last non-empty tail detail, then first summary line', () => {
  assert.equal(tasksProgressLine({ progressTail: [{ detail: 'one' }, { detail: '  ' }, { detail: ' two ' }, null] }), 'two')
  assert.equal(tasksProgressLine({ progressTail: [], summaryText: '  first\nsecond' }), 'first')
  assert.equal(tasksProgressLine({}), '')
  assert.equal(tasksProgressLine(null), '')
  assert.equal(tasksProgressItemLine({ phase: 'run', detail: 'go' }, 0), '1. [run] go')
  assert.equal(tasksProgressItemLine({ phase: 'progress', detail: 'go' }, 1), '2. go')
  assert.equal(tasksProgressItemLine('plain', 2), '3. plain')
})

test('stall hint only for active tasks; cancel evidence only when the node confirmed', () => {
  assert.equal(tasksStallLabel(task('a', 'running', { stallHint: { stalled: true, idleMs: 5 * 60000 } })), '已 5 分钟无更新（仅提示）')
  assert.equal(tasksStallLabel(task('a', 'running', { stallHint: { stalled: true, idleMs: 100 } })), '已 1 分钟无更新（仅提示）')
  assert.equal(tasksStallLabel(task('a', 'completed', { stallHint: { stalled: true, idleMs: 999999 } })), '')
  assert.equal(tasksStallLabel(task('a', 'running', { stallHint: { stalled: false, idleMs: 0 } })), '')
  assert.equal(tasksCancelEvidenceLabel({ cancelEvidence: { state: 'aborted' } }), '已取消（节点确认）')
  assert.equal(tasksCancelEvidenceLabel({ cancelEvidence: { state: 'aborted', abortedBeforeStart: true } }), '已取消（未开始，节点确认）')
  assert.equal(tasksCancelEvidenceLabel({ cancelEvidence: { state: 'unknown', source: 'none' } }), '')
  assert.equal(tasksCancelEvidenceLabel(null), '')
})

test('cancel receipt describes the click, not the task', () => {
  assert.deepEqual(tasksCancelReceipt({ before: { status: 'completed' }, response: { requested: true } }), { kind: 'terminal', text: '任务已结束，无需取消' })
  assert.deepEqual(tasksCancelReceipt({ before: { status: 'running' }, response: { requested: true } }), { kind: 'requested', text: '已提交取消请求，等待任务状态更新' })
  assert.deepEqual(tasksCancelReceipt({ before: { status: 'running' }, response: { requested: false } }), { kind: 'notDelivered', text: '取消请求未送达' })
  assert.equal(tasksCancelReceipt({}).kind, 'notDelivered')
})

test('quadrants: newest completed four, failed lands with interrupted/aborted', () => {
  const list = [
    task('p', 'pending_approval'), task('r', 'running'), task('q', 'queued'), task('f', 'failed'), task('i', 'interrupted'), task('x', 'aborted'), task('rej', 'rejected'),
    ...[1, 2, 3, 4, 5].map((n) => task('c' + n, 'completed', { updatedAt: NOW + n })),
  ]
  const q = tasksQuadrants(list)
  assert.deepEqual(q.needsYou.map((t) => t.taskId), ['p'])
  assert.deepEqual(q.working.map((t) => t.taskId), ['r', 'q'])
  assert.deepEqual(q.blocked.map((t) => t.taskId), ['f', 'i', 'x'])
  assert.deepEqual(q.done.map((t) => t.taskId), ['c5', 'c4', 'c3', 'c2'])
  assert.equal(tasksQuadLabel(task('t', 'running', { goal: 'x'.repeat(40) }), [node('n1')]), 'x'.repeat(36) + '… @host-n1')
  assert.equal(tasksQuadLabel({ taskId: 'abcdefghijklmnop', nodeId: 'zz' }, []), 'abcdefghij @zz')
})

test('tickets: stage, ordering and ended filtering', () => {
  assert.deepEqual(tasksTicketStage({ state: 'ended' }), { stage: 'ended' })
  assert.deepEqual(tasksTicketStage({ state: 'interrupted' }), { stage: 'ended' })
  assert.deepEqual(tasksTicketStage({ state: 'open' }), { stage: 'idle' })
  assert.deepEqual(tasksTicketStage({ state: 'open' }, { attention: { kind: 'review' } }), { stage: 'person', reason: 'review' })
  assert.deepEqual(tasksTicketStage({ state: 'open' }, { attention: { kind: 'weird' }, running: true }), { stage: 'working' })
  assert.deepEqual(tasksTicketStage({ state: 'open' }, { running: false }), { stage: 'idle' })
  const rows = tasksAttentionRows([
    { ticketId: 'a', state: 'open', hasExecutor: false },
    { ticketId: 'b', state: 'ended' },
    { ticketId: 'c', state: 'open', hasExecutor: true, executorState: { running: true } },
    { ticketId: 'd', state: 'open', executorState: { attention: { kind: 'answer' } } },
    { state: 'open' },
  ])
  assert.deepEqual(rows.map((r) => [r.ticket.ticketId, r.stage]), [['d', 'person'], ['c', 'working'], ['a', 'idle']])
  assert.equal(tasksTicketLabel(rows[0]), '需要你回答')
  assert.equal(tasksTicketLabel(rows[1]), '执行中')
  assert.equal(tasksTicketLabel(rows[2]), '未结束')
  assert.deepEqual(tasksAttentionRows(undefined), [])
  assert.deepEqual(tasksSortAttention([{ stage: 'ended' }]), [])
})

test('dispatch body: trimmed goal, optional fields omitted, timeout and approval', () => {
  assert.equal(tasksDispatchBody(tasksNewForm()).ok, false)
  assert.equal(tasksDispatchBody(tasksNewForm()).error, '先填写任务目标')
  const minimal = tasksDispatchBody(Object.assign(tasksNewForm(), { goal: '  do it  ' }))
  assert.deepEqual(minimal, { ok: true, body: { goal: 'do it', mode: 'agent' } })
  assert.equal(JSON.stringify(minimal.body), '{"goal":"do it","mode":"agent"}')
  const full = tasksDispatchBody({
    goal: 'g', node: 'n1', mode: 'exec', workspace: ' /w ', model: ' p/m ', outputs: 'dist/**, *.md\nx', timeoutMs: ' 60000 ', needApproval: true,
  })
  assert.deepEqual(full.body, { goal: 'g', mode: 'exec', node: 'n1', workspace: '/w', model: 'p/m', outputs: ['dist/**', '*.md', 'x'], timeoutMs: 60000, approval: 'manual' })
  assert.equal(tasksDispatchBody(Object.assign(tasksNewForm(), { goal: 'g', timeoutMs: '' })).body.timeoutMs, undefined)
  assert.equal(tasksDispatchBody(Object.assign(tasksNewForm(), { goal: 'g', timeoutMs: 'abc' })).ok, false)
  assert.equal(tasksDispatchBody(Object.assign(tasksNewForm(), { goal: 'g', timeoutMs: '0' })).ok, false)
  assert.equal(tasksDispatchBody(Object.assign(tasksNewForm(), { goal: 'g', mode: 'weird' })).body.mode, 'agent')
  assert.deepEqual(tasksParseOutputs(' a, b ,,\n c '), ['a', 'b', 'c'])
  assert.deepEqual(tasksParseTimeout('1500.4'), { value: 1500, error: '' })
})

test('dispatch problem mirrors the server node rules', () => {
  assert.match(tasksDispatchProblem({ node: '' }, []), /还没有接入/)
  assert.match(tasksDispatchProblem({ node: '' }, [node('a', { online: false })]), /所有机器都离线/)
  assert.equal(tasksDispatchProblem({ node: '' }, [node('a')]), '')
  assert.match(tasksDispatchProblem({ node: '' }, [node('a'), node('b')]), /多台机器/)
  assert.equal(tasksDispatchProblem({ node: 'b' }, [node('a'), node('b')]), '')
  assert.match(tasksDispatchProblem({ node: 'b' }, [node('a'), node('b', { online: false })]), /已离线/)
  assert.match(tasksDispatchProblem({ node: 'zz' }, [node('a')]), /不存在/)
})

test('model options are node-dependent and fall back to free text', () => {
  const a = node('a', { models: [{ provider: 'p', id: 'm1', name: 'M1' }, { provider: '', id: 'raw', name: 'raw' }], defaultModel: { provider: 'p', model: 'm1' } })
  const b = node('b', { models: [{ provider: 'p', id: 'm1', name: 'M1' }, { provider: 'q', id: 'm2', name: 'M2' }] })
  const c = node('c', { models: null })
  const all = tasksModelOptions([a, b, c], '')
  assert.deepEqual(all.options.map((o) => o.key), ['p/m1', 'raw', 'q/m2'])
  assert.match(all.options[0].label, /M1 · host-a/)
  const one = tasksModelOptions([a, b, c], 'a')
  assert.deepEqual(one.options.map((o) => o.label), ['M1', 'raw'])
  assert.equal(one.defaultLabel, 'p/m1')
  assert.deepEqual(tasksModelOptions([a, b, c], 'c'), { options: [], reported: false, defaultLabel: '' })
  assert.deepEqual(tasksModelOptions([node('d', { models: [] })], 'd'), { options: [], reported: true, defaultLabel: '' })
})

test('templates map to the form and back', () => {
  const t = { id: 't1', name: 'Build', goal: 'npm run build', mode: 'exec', workspace: '/w', model: { provider: 'p', model: 'm' }, outputs: ['dist/**', '*.md'], timeoutMs: 90000 }
  const f = tasksFormFromTemplate(t, Object.assign(tasksNewForm(), { node: 'n1', needApproval: true, goal: 'old' }))
  assert.deepEqual(f, { goal: 'npm run build', node: 'n1', mode: 'exec', workspace: '/w', model: 'p/m', outputs: 'dist/**, *.md', timeoutMs: '90000', needApproval: true, templateId: 't1' })
  const bare = tasksFormFromTemplate({ id: 't2', name: 'x', goal: 'g', mode: 'whatever' }, tasksNewForm())
  assert.equal(bare.mode, 'agent')
  assert.equal(bare.timeoutMs, '')
  assert.equal(bare.outputs, '')
  assert.equal(tasksModelString({ model: 'only' }), 'only')
  assert.equal(tasksModelString(null), '')
  const body = tasksTemplateBody(f, '  Build  ')
  assert.deepEqual(body, { ok: true, body: { name: 'Build', goal: 'npm run build', mode: 'exec', workspace: '/w', model: 'p/m', outputs: ['dist/**', '*.md'], timeoutMs: 90000, id: 't1' } })
  const fresh = tasksTemplateBody(Object.assign(tasksNewForm(), { goal: 'g' }), 'n')
  assert.deepEqual(fresh.body, { name: 'n', goal: 'g', mode: 'agent' })
  assert.equal(tasksTemplateBody(Object.assign(tasksNewForm(), { goal: 'g', timeoutMs: 'x' }), 'n').ok, false)
})

test('handoff finals, pull state, prompt, body and summary', () => {
  const handoff = { artifacts: { final: [{ path: 'a.txt', bytes: 3 }, { path: '' }, null, { path: 'b/c.md', bytes: 5 }] } }
  assert.deepEqual(tasksFinalPaths(handoff), ['a.txt', 'b/c.md'])
  assert.deepEqual(tasksFinalPaths(null), [])
  assert.deepEqual(tasksFinalPaths({ manifest: [{ role: 'final', path: 'old' }] }), [])
  assert.equal(tasksPullState({ pull: false, pullRoot: null }).enabled, false)
  assert.match(tasksPullState({ pull: false }).reason, /uiPullRoot/)
  assert.deepEqual(tasksPullState({ pull: true, pullRoot: '/srv/pull' }), { enabled: true, reason: '', root: '/srv/pull' })
  assert.equal(tasksPullState(null).enabled, true)
  assert.match(tasksPullPrompt('/srv/pull'), /\/srv\/pull/)
  assert.deepEqual(tasksPullBody('t', ['a'], '  sub  '), { taskId: 't', paths: ['a'], dest: 'sub' })
  assert.deepEqual(tasksPullBody('t', ['a'], ''), { taskId: 't', paths: ['a'] })
  assert.deepEqual(tasksPullSummary({ dest: '/d', results: [{ ok: true }, { ok: true }] }, ['a', 'b']), { text: '拉取 2/2 个文件到 /d', tone: 'ok' })
  const part = tasksPullSummary({ dest: '/d', results: [{ path: 'a', ok: true }, { path: 'b', ok: false, message: 'gone' }] }, ['a', 'b'])
  assert.equal(part.text, '拉取 1/2 个文件到 /d；失败：b（gone）')
  assert.equal(part.tone, '')
  assert.equal(tasksPullSummary({ dest: '/d', results: [{ path: 'a', ok: false, error: 'x' }] }, ['a']).tone, 'err')
  assert.equal(tasksChangedLine({ op: 'modify', path: 'a.js', deltaBytes: 12 }), 'modify a.js（+12 B）')
  assert.equal(tasksChangedLine({ op: 'add', path: 'b.js', deltaBytes: 0 }), 'add b.js')
})

test('error text keeps the server wording and the stable code', () => {
  const e = Object.assign(new Error('目标目录不合法'), { status: 403, body: { error: 'pull-dest-invalid', message: '目标目录不合法' } })
  assert.equal(tasksErr(e), '目标目录不合法（pull-dest-invalid）')
  assert.equal(tasksErr(Object.assign(new Error('goal-required'), { body: { error: 'goal-required' } })), 'goal-required')
  assert.equal(tasksErr(new Error('node-offline')), '这台机器当前不在线（node-offline）')
  assert.equal(tasksErr(new Error('boom')), 'boom')
})

/* ── 组件 ── */

function view(overrides) {
  const core = makeCore()
  const parts = createTasks(core).parts
  const props = Object.assign({
    hub: Object.assign({}, dataEmptyHub, { loading: false, nodes: [node('n1')], tasks: [], caps: { pull: true, pullRoot: '/srv/pull' }, tickets: undefined }),
    now: NOW, go: noop, note: null, onNoteClose: noop,
    form: tasksNewForm(), onForm: noop, modelCustom: false, onModelCustom: noop, dispatching: false, onDispatch: noop,
    tpl: { loading: false, list: [], max: 0, degraded: false, reason: '', file: '', error: '' }, tplMsg: '', tplBusy: false, onTplApply: noop, onTplSave: noop, onTplDelete: noop,
    filter: 'all', onFilter: noop, purgeBusy: false, onPurge: noop,
    selected: '', detail: null, detailRef: { current: null }, busyKeys: {}, onSelect: noop, onClose: noop, onAct: noop,
  }, overrides)
  return { core, el: core.h(parts.TasksView, props) }
}
const withHub = (extra) => ({ hub: Object.assign({}, dataEmptyHub, { loading: false, nodes: [node('n1')], tasks: [], caps: { pull: true, pullRoot: '/srv/pull' }, tickets: undefined }, extra) })

test('screen module contract: css with tk- prefix and a Screen component', () => {
  const m = createTasks(makeCore())
  assert.equal(typeof m.Screen, 'function')
  assert.ok(Array.isArray(m.css) && m.css.length > 0)
  assert.ok(m.css.every((rule) => typeof rule === 'string' && /^(@media[^{]*\{)?\.tk/.test(rule)))
  // 用 dataEmptyHub 跑一遍整个 Screen（hook 顺序、首屏不抛）
  const out = textOf(makeCore().h(createTasks(makeCore()).Screen, { hub: dataEmptyHub, ui: { confirm: noop, alert: noop, prompt: noop, notify: noop }, role: 'hub', go: noop, refresh: noop }))
  assert.match(out, /派发任务/)
})

test('empty states: nothing online, no nodes, no tasks', () => {
  const none = textOf(view(withHub({ nodes: [] })).el)
  assert.match(none, /还没有机器接入，现在无法派发任务/)
  assert.match(none, /还没有任务/)
  const clicked = []
  const v = view(Object.assign(withHub({ nodes: [] }), { go: (s) => clicked.push(s) }))
  findButtons(v.el, '去「机器」')[0].props.onClick()
  assert.deepEqual(clicked, ['machines'])
  const submit = findButtons(v.el, '派发任务').filter((b) => b.props.className.includes('primary'))[0]
  assert.equal(submit.props.disabled, true)
  const offline = textOf(view(withHub({ nodes: [node('n1', { online: false })] })).el)
  assert.match(offline, /所有机器都离线/)
  const ok = textOf(view().el)
  assert.doesNotMatch(ok, /无法派发任务/)
})

test('loading state hides the no-machine banner and says it is reading', () => {
  const out = textOf(view(withHub({ loading: true, nodes: [] })).el)
  assert.doesNotMatch(out, /无法派发任务/)
  assert.match(out, /读取任务…/)
})

test('running task row: status text, id, node, elapsed, progress, stall hint, cancel button', () => {
  const t = task('abcdefghijkl', 'running', {
    startedAt: NOW - 65000, progressTail: [{ detail: 'compiling' }], stallHint: { stalled: true, idleMs: 180000 }, changedCount: 2,
  })
  const acts = []
  const v = view(Object.assign(withHub({ tasks: [t] }), { onAct: (...a) => acts.push(a) }))
  const out = textOf(v.el)
  assert.match(out, /运行中/)
  assert.match(out, /abcdefghij/)
  assert.match(out, /host-n1/)
  assert.match(out, /已跑 1m5s/)
  assert.match(out, /最近：compiling/)
  assert.match(out, /已 3 分钟无更新（仅提示）/)
  assert.match(out, /改动 2/)
  const rowBtns = findAll(expand(v.el), (n) => n.type === 'li' && n.props.className.includes('tk-row'))[0]
  const cancel = findAll(rowBtns, (n) => n.type === 'button' && texts(n).join('') === '取消')[0]
  cancel.props.onClick()
  assert.deepEqual(acts, [['abcdefghijkl', 'cancel']])
  assert.equal(findAll(rowBtns, (n) => n.type === 'button' && /批准|拒绝|拉取/.test(texts(n).join(''))).length, 0)
  assert.match(out, /进行中（1）/)
})

test('failed task: badge text carries the status (not only colour) and no action buttons', () => {
  const t = task('f1', 'failed', { durationMs: 4000, updatedAt: NOW })
  const v = view(withHub({ tasks: [t] }))
  const out = textOf(v.el)
  assert.match(out, /失败/)
  assert.match(out, /耗时 4s/)
  assert.match(out, /历史（1）/)
  const badges = findByClass(v.el, 'dra-badge').filter((b) => texts(b).join('') === '失败')
  assert.ok(badges.some((b) => b.props.className.includes('bad')))
  const row = findAll(expand(v.el), (n) => n.type === 'li' && n.props.className.includes('tk-row'))[0]
  assert.equal(findAll(row, (n) => n.type === 'button' && /取消|批准|拒绝|拉取/.test(texts(n).join(''))).length, 0)
  // 失败任务在「中断 · 失败」象限里
  const quads = findByClass(v.el, 'tk-quad')
  assert.match(texts(quads[2]).join(''), /中断 · 失败.*goal f1/)
})

test('pending approval task: approve and reject on the row, needs-you quadrant, stat tone', () => {
  const t = task('p1', 'pending_approval', { approval: 'manual' })
  const acts = []
  const v = view(Object.assign(withHub({ tasks: [t] }), { onAct: (...a) => acts.push(a) }))
  const out = textOf(v.el)
  assert.match(out, /待批准/)
  assert.match(texts(findByClass(v.el, 'tk-quad')[0]).join(''), /需要你（待批准）1goal p1/)
  const row = findAll(expand(v.el), (n) => n.type === 'li' && n.props.className.includes('tk-row'))[0]
  findAll(row, (n) => n.type === 'button' && texts(n).join('') === '批准')[0].props.onClick()
  findAll(row, (n) => n.type === 'button' && texts(n).join('') === '拒绝')[0].props.onClick()
  findAll(row, (n) => n.type === 'button' && texts(n).join('') === '取消')[0].props.onClick()
  assert.deepEqual(acts, [['p1', 'approve'], ['p1', 'reject'], ['p1', 'cancel']])
  const busy = view(Object.assign(withHub({ tasks: [t] }), { busyKeys: { 'approve:p1': true } }))
  const approve = findAll(expand(busy.el), (n) => n.type === 'button' && texts(n).join('') === '批准中…')[0]
  assert.equal(approve.props.disabled, true)
})

test('completed row offers pull; selecting rows and filter buttons call back', () => {
  const t = task('c1', 'completed')
  const picks = []
  const filters = []
  const v = view(Object.assign(withHub({ tasks: [t] }), { onSelect: (id) => picks.push(id), onFilter: (f) => filters.push(f) }))
  assert.equal(findButtons(v.el, '拉取').length, 1)
  const main = findAll(expand(v.el), (n) => n.type === 'button' && n.props.className === 'tk-row-main')[0]
  main.props.onClick()
  assert.deepEqual(picks, ['c1'])
  const seg = findButtons(v.el, '已完成 1').filter((b) => b.props['aria-pressed'] !== undefined)[0]
  seg.props.onClick()
  assert.deepEqual(filters, ['done'])
  const filtered = textOf(view(Object.assign(withHub({ tasks: [t, task('r1', 'running')] }), { filter: 'failed' })).el)
  assert.match(filtered, /没有匹配的任务/)
})

test('purge button confirms through the screen handler and is disabled with only active tasks', () => {
  const calls = []
  const v = view(Object.assign(withHub({ tasks: [task('c1', 'completed')] }), { onPurge: () => calls.push('purge') }))
  const btn = findButtons(v.el, '清理历史任务')[0]
  assert.equal(btn.props.disabled, false)
  btn.props.onClick()
  assert.deepEqual(calls, ['purge'])
  const onlyActive = view(withHub({ tasks: [task('r1', 'running')] }))
  assert.equal(findButtons(onlyActive.el, '清理历史任务')[0].props.disabled, true)
  assert.equal(findButtons(view(Object.assign(withHub({ tasks: [task('c1', 'completed')] }), { purgeBusy: true })).el, '清理中…')[0].props.disabled, true)
})

test('tickets fold lists open tickets with executor flags; ended ones are hidden', () => {
  const tickets = [{ ticketId: 'tk_1', state: 'open', hasExecutor: true }, { ticketId: 'tk_2', state: 'ended' }]
  const out = textOf(view(withHub({ tasks: [task('r1', 'running')], tickets })).el)
  assert.match(out, /待你处理的工单/)
  assert.match(out, /tk_1/)
  assert.match(out, /已关联执行器/)
  assert.doesNotMatch(out, /tk_2/)
  assert.doesNotMatch(textOf(view(withHub({ tasks: [task('r1', 'running')], tickets: [] })).el), /待你处理的工单/)
})

function detailProps(over) {
  const t = task('d1', 'completed', {
    startedAt: NOW - 9000, endedAt: NOW - 1000, durationMs: 8000, exit: { code: 0 }, summaryText: 'all good', changedCount: 1,
    changed: [{ op: 'add', path: 'out/a.txt', deltaBytes: 4 }], progressTail: [{ phase: 'run', detail: 'step one' }], logTail: ['line 1'],
  })
  const handoff = {
    summaryText: 'handoff summary', artifacts: { counts: { total: 3, final: 2, intermediate: 1, other: 0 }, bytesFinal: 2048, final: [{ path: 'out/a.txt', bytes: 4 }, { path: 'out/b.md', bytes: 2044 }] },
    diffs: [{ path: 'out/a.txt', diff: '+x', truncated: true }],
  }
  return Object.assign(withHub({ tasks: [t] }), { selected: 'd1', detail: { id: 'd1', task: t, handoff, error: '' } }, over)
}

test('detail card: goal, timing, handoff summary, finals with sizes, artifacts, changed, progress, logs', () => {
  const out = textOf(view(detailProps()).el)
  assert.match(out, /任务详情/)
  assert.match(out, /goal d1/)
  assert.match(out, /handoff summary/)
  assert.match(out, /成品（2） · 2\.0 KB/)
  assert.match(out, /out\/b\.md/)
  assert.match(out, /共 3（成品 2，中间 1）/)
  assert.match(out, /add out\/a\.txt（\+4 B）/)
  assert.match(out, /1\. \[run\] step one/)
  assert.match(out, /line 1/)
  assert.match(out, /耗时8s/)
  assert.match(out, /0（成功）/)
  assert.match(out, /差异 out\/a\.txt/)
})

test('detail pull buttons send paths (one file) or undefined (all) to the handler', () => {
  const calls = []
  const v = view(detailProps({ onAct: (...a) => calls.push(a) }))
  const all = findButtons(v.el, '拉取全部成品（2）')[0]
  assert.equal(all.props.disabled, false)
  all.props.onClick()
  const detailEl = findAll(expand(v.el), (n) => n.type === 'section' && n.props['aria-label'] === '任务详情')[0]
  const one = findAll(detailEl, (n) => n.type === 'button' && texts(n).join('') === '拉取')[1]
  one.props.onClick()
  assert.deepEqual(calls, [['d1', 'pull', undefined], ['d1', 'pull', ['out/b.md']]])
})

test('no pull root: pull buttons are disabled and the reason is shown', () => {
  const props = detailProps()
  props.hub = Object.assign({}, props.hub, { caps: { pull: false, pullRoot: null } })
  const v = view(props)
  const detailEl = findAll(expand(v.el), (n) => n.type === 'section' && n.props['aria-label'] === '任务详情')[0]
  const pulls = findAll(detailEl, (n) => n.type === 'button' && /拉取/.test(texts(n).join('')))
  assert.equal(pulls.length, 3)
  assert.ok(pulls.every((b) => b.props.disabled === true && /uiPullRoot/.test(b.props.title)))
  assert.match(textOf(v.el), /主机没有配置 uiPullRoot/)
})

test('detail states: loading, error without content, stale refresh error keeps content, running actions', () => {
  assert.match(textOf(view(Object.assign(detailProps(), { detail: null })).el), /读取任务详情…/)
  assert.match(textOf(view(Object.assign(detailProps(), { detail: { id: 'other', task: null, handoff: null, error: '' } })).el), /读取任务详情…/)
  assert.match(textOf(view(Object.assign(detailProps(), { detail: { id: 'd1', task: null, handoff: null, error: 'task-unknown' } })).el), /读不到这条任务.*task-unknown/)
  const stale = detailProps()
  stale.detail = Object.assign({}, stale.detail, { error: 'HTTP 502' })
  const out = textOf(view(stale).el)
  assert.match(out, /刷新失败：HTTP 502（下面是上一次读到的内容）/)
  assert.match(out, /handoff summary/)
  const running = task('r1', 'running', { startedAt: NOW - 3000, nodeOnline: false })
  const rp = Object.assign(withHub({ tasks: [running] }), { selected: 'r1', detail: { id: 'r1', task: running, handoff: null, error: '' } })
  const rout = textOf(view(rp).el)
  assert.match(rout, /取消任务/)
  assert.match(rout, /当前离线/)
  assert.match(rout, /已跑3s/)
  const noHand = task('c2', 'completed')
  const np = Object.assign(withHub({ tasks: [noHand] }), { selected: 'c2', detail: { id: 'c2', task: noHand, handoff: null, error: '' } })
  assert.match(textOf(view(np).el), /节点没有回传交接卡/)
})

test('dispatch form: fields, node choices, model picker with custom escape, note, no reset on re-render', () => {
  const a = node('a', { models: [{ provider: 'p', id: 'm1', name: 'M1' }], defaultModel: { provider: 'p', model: 'm1' } })
  const b = node('b', { online: false })
  const form = Object.assign(tasksNewForm(), { goal: 'keep me', node: 'a', model: 'zz/unlisted' })
  const v = view(Object.assign(withHub({ nodes: [a, b] }), { form }))
  const out = textOf(v.el)
  assert.match(out, /目标机器/)
  assert.match(out, /host-a · linux/)
  assert.doesNotMatch(out, /host-b/)
  assert.match(out, /跟随副机默认（p\/m1）/)
  assert.match(out, /自定义模型…/)
  const goal = findAll(expand(v.el), (n) => n.type === 'textarea')[0]
  assert.equal(goal.props.value, 'keep me')
  const custom = findAll(expand(v.el), (n) => n.type === 'input' && n.props['aria-label'] === '自定义模型')[0]
  assert.equal(custom.props.value, 'zz/unlisted')
  const labels = findAll(expand(v.el), (n) => n.type === 'label')
  assert.ok(labels.length >= 8)
  assert.ok(labels.some((l) => /任务目标/.test(texts(l).join(''))))
  assert.ok(labels.some((l) => /需要先审批/.test(texts(l).join(''))))
  const submit = findButtons(v.el, '派发任务').filter((x) => x.props.className.includes('primary'))[0]
  assert.equal(submit.props.disabled, false)
  const busy = view(Object.assign(withHub({ nodes: [a] }), { form, dispatching: true }))
  assert.equal(findButtons(busy.el, '派发中…')[0].props.disabled, true)
  const note = textOf(view(Object.assign(withHub({ nodes: [a] }), { note: { text: '已派发给 host-a（abc）', tone: 'ok' } })).el)
  assert.match(note, /已派发给 host-a（abc）/)
  const list = findAll(expand(view(Object.assign(withHub({ nodes: [a] }), { form: Object.assign(tasksNewForm(), { node: 'a' }) })).el), (n) => n.type === 'select')
  assert.ok(list.some((s) => s.props.value === 'a'))
})

test('dispatch form without a model list falls back to a free-text model input; multi-node needs a choice', () => {
  const v = view(withHub({ nodes: [node('a', { models: null }), node('b', { models: null })] }))
  const out = textOf(v.el)
  assert.match(out, /请选择一台在线的机器/)
  assert.match(out, /有多台机器，请先选一台目标机器/)
  assert.match(out, /没有上报模型清单/)
  const submit = findButtons(v.el, '派发任务').filter((x) => x.props.className.includes('primary'))[0]
  assert.equal(submit.props.disabled, true)
  const modelInput = findAll(expand(v.el), (n) => n.type === 'input' && n.props.placeholder === 'provider/model 或 model')[0]
  assert.ok(modelInput)
})

test('template row: options, update vs save label, delete gating, limits and degraded notes', () => {
  const list = [{ id: 't1', name: 'Build', mode: 'exec', workspace: '/w', goal: 'g' }, { id: 't2', name: 'Plain', mode: 'agent', goal: 'h' }]
  const tpl = { loading: false, list, max: 2, degraded: true, reason: 'bad-json', file: '/f.json', error: '' }
  const fresh = view(Object.assign(withHub({}), { tpl, form: Object.assign(tasksNewForm(), { goal: 'g' }) }))
  const out = textOf(fresh.el)
  assert.match(out, /Build（exec） · \/w/)
  assert.match(out, /模板已达上限 2 条/)
  assert.match(out, /模板文件读不出来（bad-json）/)
  assert.equal(findButtons(fresh.el, '存为模板')[0].props.disabled, true)
  assert.equal(findButtons(fresh.el, '删除模板')[0].props.disabled, true)
  const selected = view(Object.assign(withHub({}), { tpl, form: Object.assign(tasksNewForm(), { goal: 'g', templateId: 't1' }), tplMsg: '已填充模板「Build」' }))
  assert.equal(findButtons(selected.el, '更新模板')[0].props.disabled, false)
  assert.equal(findButtons(selected.el, '删除模板')[0].props.disabled, false)
  assert.match(textOf(selected.el), /已填充模板「Build」/)
  const broken = view(Object.assign(withHub({}), { tpl: Object.assign({}, tpl, { error: 'HTTP 500', max: 50 }), form: Object.assign(tasksNewForm(), { goal: 'g' }) }))
  assert.match(textOf(broken.el), /模板库不可用：HTTP 500/)
  assert.equal(findButtons(broken.el, '存为模板')[0].props.disabled, true)
  const loading = textOf(view(Object.assign(withHub({}), { tpl: { loading: true, list: [], max: 0, degraded: false, reason: '', file: '', error: '' } })).el)
  assert.match(loading, /读取中…/)
})

/* ── 整屏：用 fetch 桩验证动作的请求体和提示 ── */

test('Screen actions drive the right requests (dispatch body, purge, cancel receipt, pull with prompt)', async () => {
  // 假 React 的 useState 不更新：用「按调用顺序塞初值 + 记录 setter 收到的提示」的桩，直接调用 Screen 传给 TasksView 的处理函数。
  const log = []
  const notes = []
  const seeds = [Object.assign(tasksNewForm(), { goal: ' ship it ', node: 'n1', needApproval: true, timeoutMs: '60000', outputs: 'a, b' })]
  const baseReact = makeCore().React
  const React = Object.assign({}, baseReact, {
    useState(v) {
      const init = seeds.length ? seeds.shift() : (typeof v === 'function' ? v() : v)
      return [init, (n) => { const val = typeof n === 'function' ? n(init) : n; if (val && val.text !== undefined) notes.push(val) }]
    },
  })
  const core = Object.assign({}, makeCore(), { React })
  core.api = {
    get: (p) => { log.push(['GET', p]); return Promise.resolve(p.startsWith('/task?') ? { task: task('c1', 'completed'), handoff: { artifacts: { final: [{ path: 'o/a.txt', bytes: 1 }, { path: 'o/b.txt', bytes: 2 }] } } } : { templates: [] }) },
    post: (p, b) => {
      log.push(['POST', p, b])
      if (p === '/dispatch') return Promise.resolve({ ok: true, taskId: 'ui-abcdefghijkl', nodeId: 'n1', approval: 'manual' })
      if (p === '/purge') return Promise.resolve({ ok: true, removed: 3, kept: 1 })
      if (p === '/cancel') return Promise.resolve({ ok: true, requested: true })
      if (p === '/pull') return Promise.resolve({ ok: true, dest: '/srv/pull/sub', results: [{ path: 'o/a.txt', ok: true }, { path: 'o/b.txt', ok: false, message: 'gone' }] })
      return Promise.resolve({ ok: true })
    },
  }
  const mod = createTasks(core)
  const hub = Object.assign({}, dataEmptyHub, { loading: false, nodes: [node('n1')], tasks: [task('r1', 'running'), task('c1', 'completed')], caps: { pull: true, pullRoot: '/srv/pull' } })
  const prompts = []
  const ui = { confirm: (m) => { prompts.push(m); return Promise.resolve(true) }, alert: noop, prompt: (m, d) => { prompts.push([m, d]); return Promise.resolve('sub') }, notify: noop }
  let refreshed = 0
  const tree = core.h(mod.Screen, { hub, ui, role: 'hub', go: noop, refresh: () => { refreshed += 1 } })
  // 把 Screen 渲染到只剩 TasksView 元素：取其 props
  const comp = tree.type
  const root = comp(tree.props)
  const captured = root.props
  assert.equal(root.type.name, 'TasksView')

  captured.onDispatch()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(log.filter((l) => l[1] === '/dispatch')[0], ['POST', '/dispatch', { goal: 'ship it', mode: 'agent', node: 'n1', outputs: ['a', 'b'], timeoutMs: 60000, approval: 'manual' }])
  assert.ok(notes.some((n) => /已派发给 host-n1（ui-abcdefg），已挂起，等你批准后才会开始/.test(n.text)))
  assert.equal(refreshed, 1)

  await captured.onPurge()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(log.filter((l) => l[1] === '/purge')[0], ['POST', '/purge', { includeActive: false }])
  assert.equal(prompts[0], '清理已结束的历史任务？运行中的任务会保留。')
  assert.equal(refreshed, 2)

  captured.onAct('r1', 'cancel')
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(log.filter((l) => l[1] === '/cancel')[0], ['POST', '/cancel', { taskId: 'r1' }])
  assert.equal(refreshed, 3)

  captured.onAct('c1', 'pull')
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(log.some((l) => l[1] === '/task?taskId=c1'))
  assert.match(prompts[1][0], /\/srv\/pull/)
  assert.deepEqual(log.filter((l) => l[1] === '/pull')[0], ['POST', '/pull', { taskId: 'c1', paths: ['o/a.txt', 'o/b.txt'], dest: 'sub' }])
  assert.ok(notes.some((n) => n && /拉取 1\/2 个文件到 \/srv\/pull\/sub；失败：o\/b\.txt（gone）/.test(n.text)))
  assert.ok(notes.some((n) => n && n.text === '已提交取消请求，等待任务状态更新'))
  assert.ok(notes.some((n) => n && /已清理 3 条历史任务/.test(n.text)))
})

test('Screen: pull is refused up front when the hub has no pull root', async () => {
  const log = []
  const notes = []
  const baseReact = makeCore().React
  const React = Object.assign({}, baseReact, {
    useState(v) { const init = typeof v === 'function' ? v() : v; return [init, (n) => { const val = typeof n === 'function' ? n(init) : n; if (val && val.text !== undefined) notes.push(val) }] },
  })
  const core = Object.assign({}, makeCore(), { React })
  core.api = { get: () => Promise.resolve({ templates: [] }), post: (p) => { log.push(p); return Promise.resolve({}) } }
  const mod = createTasks(core)
  const hub = Object.assign({}, dataEmptyHub, { loading: false, nodes: [node('n1')], tasks: [task('c1', 'completed')], caps: { pull: false, pullRoot: null } })
  const tree = core.h(mod.Screen, { hub, ui: { confirm: noop, alert: noop, prompt: () => { throw new Error('must not prompt') }, notify: noop }, role: 'hub', go: noop, refresh: noop })
  const root = tree.type(tree.props)
  root.props.onAct('c1', 'pull')
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(log, [])
  assert.match(notes[0].text, /uiPullRoot/)
})

/** 带「立刻执行 effect、记录 setter」的 React 桩：seeds 按 useState 调用顺序给初值。 */
function stubScreen({ seeds, api, ui, hub }) {
  const sets = []
  const queue = [...seeds]
  const base = makeCore().React
  const React = Object.assign({}, base, {
    useState(v) {
      const init = queue.length ? queue.shift() : (typeof v === 'function' ? v() : v)
      const idx = sets.length
      sets.push([])
      return [init, (n) => { sets[idx].push(typeof n === 'function' ? n(init) : n) }]
    },
    useEffect(fn) { fn() },
  })
  const core = Object.assign({}, makeCore(), { React })
  core.api = api
  const mod = createTasks(core)
  const tree = core.h(mod.Screen, { hub, ui, role: 'hub', go: noop, refresh: noop })
  return { props: tree.type(tree.props).props, sets }
}
// useState 调用顺序（见 Screen）：0 form, 1 modelCustom, 2 dispatching, 3 note, 4 tpl, 5 tplMsg, 6 tplBusy, 7 filter, 8 selected, 9 detail, 10 purgeBusy, 11 busyKeys
const S = { form: 0, note: 3, tpl: 4, tplMsg: 5, selected: 8, detail: 9 }
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

test('Screen effects: templates load on mount; detail loads for the selection and keeps old content when a refresh fails', async () => {
  const log = []
  let failTask = false
  const api = {
    get: (p) => {
      log.push(p)
      if (p === '/templates') return Promise.resolve({ templates: [{ id: 't1', name: 'T', goal: 'g', mode: 'agent' }], max: 50, degraded: false, reason: '', file: '/f' })
      if (failTask) return Promise.reject(Object.assign(new Error('HTTP 502'), { status: 502 }))
      return Promise.resolve({ task: task('c1', 'completed'), handoff: { artifacts: { final: [] } } })
    },
    post: () => Promise.resolve({}),
  }
  const hub = Object.assign({}, dataEmptyHub, { loading: false, nodes: [node('n1')], tasks: [task('c1', 'completed')], tick: 4 })
  const seeds = [tasksNewForm(), false, false, null, { loading: true, list: [], max: 0, degraded: false, reason: '', file: '', error: '' }, '', false, 'all', 'c1', null]
  const s = stubScreen({ seeds, api, ui: {}, hub })
  await tick()
  assert.deepEqual(log, ['/templates', '/task?taskId=c1'])
  assert.equal(s.sets[S.tpl][0].list[0].id, 't1')
  assert.equal(s.sets[S.tpl][0].file, '/f')
  assert.equal(s.sets[S.detail][0].id, 'c1')
  assert.equal(s.sets[S.detail][0].task.taskId, 'c1')
  // 刷新失败：上一次的内容还在，只多一条错误
  failTask = true
  const prev = { id: 'c1', task: task('c1', 'completed'), handoff: null, error: '' }
  const s2 = stubScreen({ seeds: [tasksNewForm(), false, false, null, { loading: false, list: [], max: 0, degraded: false, reason: '', file: '', error: '' }, '', false, 'all', 'c1', prev], api, ui: {}, hub })
  await tick()
  const after = s2.sets[S.detail][0]
  assert.equal(after.task.taskId, 'c1')
  assert.equal(after.error, 'HTTP 502')
  // 没选中时不请求详情，并清空
  log.length = 0
  const s3 = stubScreen({ seeds: [tasksNewForm(), false, false, null, { loading: false, list: [], max: 0, degraded: false, reason: '', file: '', error: '' }, '', false, 'all', '', prev], api, ui: {}, hub })
  await tick()
  assert.deepEqual(log, ['/templates'])
  assert.equal(s3.sets[S.detail][0], null)
})

test('Screen effects: a task that disappeared (404) shows the server text without throwing', async () => {
  const api = {
    get: (p) => (p === '/templates' ? Promise.resolve({ templates: [] }) : Promise.reject(Object.assign(new Error('task-unknown'), { status: 404, body: { error: 'task-unknown', taskId: 'gone' } }))),
    post: () => Promise.resolve({}),
  }
  const hub = Object.assign({}, dataEmptyHub, { loading: false, nodes: [node('n1')], tasks: [], tick: 1 })
  const s = stubScreen({ seeds: [tasksNewForm(), false, false, null, { loading: false, list: [], max: 0, degraded: false, reason: '', file: '', error: '' }, '', false, 'all', 'gone', null], api, ui: {}, hub })
  await tick()
  assert.deepEqual(s.sets[S.detail][0], { id: 'gone', task: null, handoff: null, error: 'task-unknown' })
})

test('Screen templates: save posts the form (id when updating) and reloads; delete confirms first', async () => {
  const log = []
  const api = {
    get: (p) => { log.push(['GET', p]); return Promise.resolve({ templates: [{ id: 't1', name: 'Saved', goal: 'g', mode: 'agent' }], max: 50 }) },
    post: (p, b) => {
      log.push(['POST', p, b])
      return Promise.resolve(p === '/templates/save' ? { ok: true, updated: true, template: { id: 't1', name: 'Saved' } } : { ok: true, removed: true })
    },
  }
  const prompts = []
  const asked = []
  const ui = {
    prompt: (m, d) => { prompts.push([m, d]); return Promise.resolve('Saved') },
    confirm: (m) => { asked.push(m); return Promise.resolve(true) },
  }
  const hub = Object.assign({}, dataEmptyHub, { loading: false, nodes: [node('n1')], tasks: [] })
  const form = Object.assign(tasksNewForm(), { goal: 'first line\nsecond', mode: 'exec', model: 'p/m', outputs: 'a, b', timeoutMs: '5000', templateId: 't1', needApproval: true, node: 'n1' })
  const tpl = { loading: false, list: [{ id: 't1', name: 'Saved', goal: 'g', mode: 'agent' }], max: 50, degraded: false, reason: '', file: '', error: '' }
  const s = stubScreen({ seeds: [form, false, false, null, tpl], api, ui, hub })
  await tick()
  log.length = 0
  s.props.onTplSave()
  await tick()
  assert.deepEqual(prompts[0], ['模板名（之后在下拉框里选它）', 'first line'])
  assert.deepEqual(log.filter((l) => l[0] === 'POST')[0], ['POST', '/templates/save', { name: 'Saved', goal: 'first line\nsecond', mode: 'exec', model: 'p/m', outputs: ['a', 'b'], timeoutMs: 5000, id: 't1' }])
  assert.ok(log.some((l) => l[1] === '/templates'))
  assert.ok(s.sets[S.tplMsg].includes('已更新模板「Saved」'))
  log.length = 0
  s.props.onTplDelete()
  await tick()
  assert.equal(asked[0], '删除模板「Saved」？只删这条预设，不影响已派出的任务。')
  assert.deepEqual(log.filter((l) => l[0] === 'POST')[0], ['POST', '/templates/delete', { id: 't1' }])
  assert.ok(s.sets[S.tplMsg].includes('已删除模板'))
  // 套用模板：保留目标机器与审批选择
  s.sets[S.form].length = 0
  s.props.onTplApply('t1')
  const applied = s.sets[S.form][0]
  assert.equal(applied.node, 'n1')
  assert.equal(applied.needApproval, true)
  assert.equal(applied.mode, 'agent')
})

test('Screen: dispatch failure keeps the form and shows the server text; cancel of an already ended task says so', async () => {
  const api = {
    get: () => Promise.resolve({ templates: [] }),
    post: (p) => (p === '/dispatch'
      ? Promise.reject(Object.assign(new Error('多个节点时必须在 body.node 指定'), { status: 400, body: { error: 'node-required', message: '多个节点时必须在 body.node 指定' } }))
      : Promise.resolve({ ok: true, requested: false })),
  }
  const hub = Object.assign({}, dataEmptyHub, { loading: false, nodes: [node('n1')], tasks: [task('c1', 'completed')] })
  const form = Object.assign(tasksNewForm(), { goal: 'x', node: 'n1' })
  const s = stubScreen({ seeds: [form], api, ui: {}, hub })
  await tick()
  s.props.onDispatch()
  await tick()
  const notes = s.sets[S.note].filter(Boolean)
  assert.ok(notes.some((n) => n.tone === 'err' && n.text === '派发失败：多个节点时必须在 body.node 指定（node-required）'))
  assert.equal(s.sets[S.form].length, 0)
  s.props.onAct('c1', 'cancel')
  await tick()
  assert.ok(s.sets[S.note].filter(Boolean).some((n) => n.text === '任务已结束，无需取消'))
})
