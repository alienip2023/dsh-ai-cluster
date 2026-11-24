import assert from 'node:assert/strict'
import test from 'node:test'
import { makeCore, makeReact, expand, texts, textOf, findAll, findButtons } from './_fake.js'
import {
  createTeam, teamApplyTalent, teamApplyTemplate, teamAuditRow, teamBotBlockers, teamBotOutcome, teamCreateBody, teamEditBody,
  teamEnterSends, teamExplain, teamFindBot, teamFormAfterSave, teamFormCheck, teamFormDirty, teamFormFromBot, teamFormInit,
  teamGoalGroups, teamHistInit, teamHistReduce, teamHistoryRows, teamLimits, teamLocateView, teamMemEntryRows, teamMemFail,
  teamMemScopeObj, teamMemScopeOptions, teamModelOptions, teamModelsNodeView, teamModelsProject, teamNameMap, teamNodeRows,
  teamRosterProject, teamTemplateGroups, teamTurnCheck, teamTurnFromPoll, teamTurnInit, teamTurnReduce, teamUtf8Bytes,
  teamVersionNote, teamTeamScope, teamCleanModels, teamModelsTotal,
} from '../../src/panel/team.js'
import { dataEmptyHub } from '../../src/panel/data.js'

const ui = { confirm: () => Promise.resolve(true), alert() {}, prompt: () => Promise.resolve(null), notify() {} }
const roster = [
  { nodeId: 'n1', hostname: 'mac-a', online: true, lastSeen: 5, acVersion: '0.4.36', bots: [
    { id: 'b1', name: '小研', role: '研究', model: 'ds/pro', identityId: '0123456789abcdef' },
    { id: 'b2', name: '无身份', role: '', model: '' },
  ] },
  { nodeId: 'n2', hostname: 'win-b', online: false, lastSeen: 1700000000000, acVersion: '0.4.30', bots: [{ id: 'b3', name: '旧机器 Bot', role: 'x', model: 'm', identityId: 'fedcba9876543210' }] },
  { nodeId: 'n3', hostname: 'old-c', online: true, bots: [] },
]
// 左栏每个有身份 id 的 Bot 渲染一个 CopyBtn，它的 useState 排在详情面板之前。
const copyStates = (nodes) => nodes.flatMap((n) => n.bots).filter((b) => b.identityId).map(() => false)
function screenText(state, hub, opts = {}) {
  const core = makeCore({ state })
  const { Screen } = createTeam(core)
  // 每次 expand 都会消耗假 useState 的队列，所以只展开一次，之后在展开的树上查询。
  return expand(core.h(Screen, { hub: Object.assign({}, dataEmptyHub, { loading: false }, hub), ui, role: 'hub', go() {}, refresh() {}, ...opts }))
}

test('errors: stable codes get a plain sentence, unknown codes stay verbatim', () => {
  assert.equal(teamExplain('bot-name-too-long'), '名称超过 40 个字符（bot-name-too-long）')
  assert.equal(teamExplain('node-offline'), '这台机器当前不在线（node-offline）')
  assert.equal(teamExplain('weird-new-code'), 'weird-new-code')
  assert.equal(teamExplain(''), 'unknown')
})

test('node rows: roster first, hub-only online nodes appended, versions classified', () => {
  const rows = teamNodeRows(roster, [{ nodeId: 'n1', hostname: 'ignored', online: false }, { nodeId: 'n9', hostname: 'fresh', online: true }, { nodeId: 'n8', online: false }])
  assert.deepEqual(rows.map((r) => r.nodeId), ['n9', 'n1', 'n3', 'n2'], 'online first, by hostname; offline last')
  const by = Object.fromEntries(rows.map((r) => [r.nodeId, r]))
  assert.equal(by.n1.online, true, 'roster decides online, hub snapshot only fills gaps')
  assert.equal(by.n1.versionState, 'ok')
  assert.equal(by.n2.versionState, 'old')
  assert.equal(by.n3.versionState, 'unknown')
  assert.equal(by.n9.hasRoster, false)
  assert.equal(by.n8, undefined)
  assert.equal(by.n1.bots[0].shortId, '01234567')
  assert.equal(by.n1.bots[1].identityId, '')
  assert.equal(rows[rows.length - 1].online, false, 'offline machines sort last')
  assert.deepEqual(teamNodeRows(null, null), [])
  assert.equal(teamFindBot(rows, 'n1', 'b2').bot.name, '无身份')
  assert.equal(teamFindBot(rows, 'n1', 'nope'), null)
  assert.equal(teamNameMap(rows, [{ nodeId: 'zz', hostname: 'z' }]).zz, 'z')
})

test('version notes and action blockers', () => {
  assert.match(teamVersionNote({ versionState: 'old', acVersion: '0.4.30' }).hint, /0\.4\.34/)
  assert.equal(teamVersionNote({ versionState: 'unknown', acVersion: '' }).badge, '版本未知')
  assert.equal(teamVersionNote({ versionState: 'ok', acVersion: '0.4.36' }).badge, 'AC 0.4.36')
  const off = teamBotBlockers({ online: false }, { identityId: 'x' })
  assert.match(off.chat, /离线/)
  assert.match(off.stop, /离线/)
  assert.equal(off.locate, '', 'locate does not need the Bot machine online')
  assert.match(teamBotBlockers({ online: true }, { identityId: '' }).locate, /身份 id/)
  assert.equal(teamBotBlockers({ online: true }, { identityId: 'x' }).chat, '')
})

test('response projections keep errors apart from empty', () => {
  assert.equal(teamRosterProject({ ok: true, nodes: [] }).kind, 'data')
  assert.deepEqual(teamRosterProject({ ok: false, code: 'roster-unavailable' }), { kind: 'error', reason: 'roster-unavailable' })
  assert.equal(teamRosterProject({ ok: false, error: 'boom', status: 500 }).reason, 'boom')
  assert.equal(teamRosterProject(null).reason, 'unexpected-shape')
  assert.equal(teamModelsProject({ ok: true, nodes: [] }).kind, 'empty')
  assert.equal(teamModelsProject({ ok: true, nodes: [{ nodeId: 'x' }] }).kind, 'data')
  assert.equal(teamModelsProject({ ok: false, code: 'not-available', reason: 'model-store-missing' }).reason, 'not-available / model-store-missing')
})

test('form validation mirrors the server limits (chars trimmed, instructions in UTF-8 bytes)', () => {
  const codes = (f) => teamFormCheck(f).map((e) => e.code)
  assert.deepEqual(codes(teamFormInit()), ['bot-nodeId-missing', 'bot-create-name-missing'])
  assert.deepEqual(codes(teamFormInit({ nodeId: 'n1', name: ' x ' })), [])
  assert.deepEqual(codes(teamFormInit({ nodeId: 'n1', name: 'a'.repeat(40) })), [])
  assert.deepEqual(codes(teamFormInit({ nodeId: 'n1', name: 'a'.repeat(41) })), ['bot-name-too-long'])
  assert.deepEqual(codes(teamFormInit({ nodeId: 'n1', name: ' ' + 'a'.repeat(40) + ' ' })), [], 'surrounding spaces do not count')
  assert.deepEqual(codes(teamFormInit({ nodeId: 'n1', name: 'a', role: 'r'.repeat(25), modelRef: 'm'.repeat(129), workDir: 'w'.repeat(1025) })),
    ['bot-role-too-long', 'bot-modelRef-too-long', 'bot-workDir-too-long'])
  assert.equal(teamUtf8Bytes('指令'), 6)
  assert.deepEqual(codes(teamFormInit({ nodeId: 'n1', name: 'a', instructions: '指'.repeat(2667) })), ['bot-instructions-too-long'])
  assert.deepEqual(codes(teamFormInit({ nodeId: 'n1', name: 'a', instructions: '指'.repeat(2666) })), [])
  assert.deepEqual(codes(teamFormInit({ mode: 'edit' })), ['bot-update-remoteBotId-missing'])
  assert.equal(teamLimits.instructionsBytes, 8000)
})

test('edit sends only changed fields; nothing changed is reported locally', () => {
  const f = teamFormFromBot({ nodeId: 'n1' }, { id: 'b1', name: '小研', role: '研究', model: 'ds/pro' })
  assert.equal(teamEditBody(f), null)
  assert.equal(teamFormDirty(f), false)
  const g = Object.assign({}, f, { role: '审稿', instructions: '  新指令  ', workDir: '' })
  assert.deepEqual(teamEditBody(g), { nodeId: 'n1', botId: 'b1', role: '审稿', instructions: '新指令' })
  assert.equal(teamFormDirty(g), true)
  assert.equal(teamEditBody(Object.assign({}, f, { name: '   ' })), null, 'blank = leave unchanged')
  const saved = teamFormAfterSave(g)
  assert.equal(saved.instructions, '')
  assert.equal(saved.base.role, '审稿')
  assert.equal(teamEditBody(saved), null)
})

test('create body is trimmed and form reset keeps the machine', () => {
  const f = teamFormInit({ nodeId: ' n1 ', name: ' 新 ', role: ' r ', modelRef: ' m ', workDir: ' /w ', instructions: ' i ' })
  assert.deepEqual(teamCreateBody(f), { nodeId: 'n1', name: '新', role: 'r', modelRef: 'm', workDir: '/w', instructions: 'i' })
  assert.equal(teamFormDirty(f), true)
  assert.equal(teamFormDirty(teamFormInit({ nodeId: 'n1' })), false, 'a chosen machine alone is not a draft')
  const after = teamFormAfterSave(f)
  assert.equal(after.nodeId, ' n1 ')
  assert.equal(after.name, '')
})

test('templates and talents fill the form', () => {
  const t = { id: 't1', name: '审稿人', role: 'r'.repeat(30), description: ' 描述 ', model: 'p/m', category: '写作' }
  const f = teamApplyTemplate(teamFormInit({ nodeId: 'n1' }), t)
  assert.deepEqual([f.name, f.role.length, f.instructions, f.modelRef, f.nodeId], ['审稿人', 24, '描述', 'p/m', 'n1'])
  assert.match(f.applied, /审稿人/)
  const g = teamApplyTalent(teamFormInit(), { name: '分析师', role: '', duty: '做分析', category: 'x' })
  assert.deepEqual([g.name, g.role, g.instructions], ['分析师', '做分析', '做分析'])
  const groups = teamTemplateGroups([t, { id: 't2', name: 'x' }, { id: 't3', name: 'y', category: '写作' }, null])
  assert.deepEqual(groups.map((x) => [x.category, x.items.length]), [['其他', 1], ['写作', 2]])
})

test('model picker options and directory view states', () => {
  const nodes = [
    { nodeId: 'n1', hostname: 'a', online: true, defaultModel: 'p/m1', models: [{ id: 'p/m1', name: 'M1', efforts: [{ id: 'low' }, { id: 'high' }] }, { id: 'p/m2', name: 'p/m2', efforts: [] }] },
    { nodeId: 'n2', hostname: 'b', online: false, defaultModel: null, models: null },
    { nodeId: 'n3', hostname: 'c', online: true, defaultModel: null, models: [] },
  ]
  assert.deepEqual(teamModelOptions(nodes, 'n1').map((o) => o.label), ['M1 (p/m1) · 默认', 'p/m2'])
  assert.deepEqual(teamModelOptions(nodes, 'n2'), [])
  assert.deepEqual(teamModelOptions(nodes, 'zz'), [])
  const v = nodes.map(teamModelsNodeView)
  assert.deepEqual(v.map((x) => x.state), ['list', 'unreported', 'none'])
  assert.equal(v[0].rows[0].isDefault, true)
  assert.deepEqual(v[0].rows[0].efforts, ['low', 'high'])
})

test('history reducer keeps old items while refreshing and drops them on failure', () => {
  let s = teamHistReduce(teamHistInit, { type: 'ok', items: [{ kind: 'user', text: 'a' }] })
  assert.equal(s.state, 'ready')
  s = teamHistReduce(s, { type: 'load' })
  assert.deepEqual([s.state, s.items.length], ['loading', 1])
  s = teamHistReduce(s, { type: 'fail', error: 'node-offline' })
  assert.deepEqual([s.state, s.items.length, s.error], ['error', 0, 'node-offline'])
  assert.equal(teamHistReduce(s, { type: 'zzz' }), s)
})

test('history rows read ds-bot items (kind/text/time) and the legacy role/content shape', () => {
  const rows = teamHistoryRows([
    { kind: 'user', text: '你好', time: 1700000000000 }, { kind: 'bot', text: '嗨' }, { kind: 'divider' }, { kind: 'view' },
    { role: 'assistant', content: 'old' }, { kind: 'post', texts: ['a', 'b'] }, null,
  ])
  assert.deepEqual(rows.map((r) => [r.side, r.who]), [['user', '我'], ['bot', 'Bot'], ['sys', ''], ['sys', 'view'], ['bot', 'Bot'], ['bot', 'Bot'], ['sys', '?']])
  assert.equal(rows[0].text, '你好')
  assert.match(rows[0].time, /\d\d-\d\d/)
  assert.equal(rows[3].text, '[view]')
  assert.equal(rows[4].text, 'old')
  assert.equal(rows[5].text, 'a\nb')
  assert.deepEqual(teamHistoryRows(null), [])
})

test('turn state machine: start, poll running/linkLost, done, failed, unknown, timeout, transport warnings', () => {
  let s = teamTurnReduce(teamTurnInit, { type: 'start', sent: 'hi' })
  assert.deepEqual([s.state, s.sent], ['running', 'hi'])
  s = teamTurnReduce(s, teamTurnFromPoll({ ok: true, state: 'running', linkLost: true }))
  assert.deepEqual([s.state, s.linkLost], ['running', true])
  s = teamTurnReduce(s, teamTurnFromPoll({ ok: true, state: 'running' }))
  assert.equal(s.linkLost, false)
  s = teamTurnReduce(s, teamTurnFromPoll({ ok: false, error: 'Failed to fetch', status: 0 }))
  assert.deepEqual([s.state, s.warn], ['running', 'Failed to fetch'])
  s = teamTurnReduce(s, teamTurnFromPoll({ ok: true, state: 'running' }))
  assert.equal(s.warn, '', 'a good poll clears the warning')
  assert.deepEqual(teamTurnReduce(s, teamTurnFromPoll({ ok: true, state: 'done', text: '答' })).text, '答')
  const f = teamTurnReduce(s, teamTurnFromPoll({ ok: true, state: 'failed', error: 'bot-turn-failed', text: '半' }))
  assert.deepEqual([f.state, f.error, f.text], ['failed', 'bot-turn-failed', '半'])
  assert.deepEqual(teamTurnFromPoll({ ok: true, state: 'unknown' }), { type: 'failed', error: 'turn-unknown' })
  assert.equal(teamTurnReduce(s, { type: 'timeout' }).state, 'timeout')
  assert.equal(teamTurnReduce(s, { type: 'reset' }), teamTurnInit)
  assert.equal(teamTurnFromPoll(null).type, 'warn')
  assert.equal(teamTurnFromPoll({ ok: true, state: 'odd' }).type, 'warn')
})

test('send checks and Enter handling', () => {
  assert.equal(teamTurnCheck('  '), 'bot-turn-text-empty')
  assert.equal(teamTurnCheck('a'.repeat(8001)), 'bot-turn-text-too-long')
  assert.equal(teamTurnCheck('a'.repeat(8000)), '')
  assert.equal(teamEnterSends({ key: 'Enter' }), true)
  assert.equal(teamEnterSends({ key: 'Enter', shiftKey: true }), false)
  assert.equal(teamEnterSends({ key: 'Enter', isComposing: true }), false)
  assert.equal(teamEnterSends({ key: 'Enter', nativeEvent: { isComposing: true } }), false)
  assert.equal(teamEnterSends({ key: 'a' }), false)
  assert.equal(teamEnterSends(null), false)
})

test('locate view says where it is and who did not answer, in plain words', () => {
  const nameOf = (id) => ({ n1: 'mac-a', n2: 'win-b' })[id] || id
  const v = teamLocateView({
    ok: true, locations: [{ nodeId: 'n1', machineId: 'm-1' }], notHere: ['n2'], silent: ['n9'], unsupported: ['n3'], unsent: [],
    rejected: [{ nodeId: 'n4', reason: 'bad-signature' }, { nodeId: 'n5', reason: 'novel' }],
  }, nameOf)
  assert.equal(v.nobody, false)
  assert.equal(v.found[0].label, 'mac-a（n1）')
  assert.deepEqual(v.groups.map((g) => g.id), ['notHere', 'silent', 'unsupported', 'rejected'])
  assert.deepEqual(v.groups[3].items, ['n4：签名核验没通过', 'n5：novel'])
  assert.equal(v.groups[0].items[0], 'win-b（n2）')
  assert.equal(teamLocateView({ ok: true, locations: [] }, nameOf).nobody, true)
})

test('memory: ds-bot outcome classes, scope options, entry rows, failures', () => {
  assert.equal(teamBotOutcome(404, '').kind, 'missing')
  assert.equal(teamBotOutcome(200, '<html>').kind, 'missing')
  assert.equal(teamBotOutcome(200, '{"x":1}').kind, 'missing')
  assert.equal(teamBotOutcome(200, '{"ok":false,"error":{"code":"bot/not-found"}}').kind, 'missing')
  assert.deepEqual(teamBotOutcome(200, '{"ok":false,"error":{"code":"c","message":"坏了"}}'), { kind: 'error', reason: '坏了', status: 200 })
  assert.deepEqual(teamBotOutcome(200, '{"ok":true,"value":{"a":1}}'), { kind: 'ok', value: { a: 1 } })
  const opts = teamMemScopeOptions({
    team: { entries: 2 },
    nodes: [{ nodeId: 'n1', hostname: 'mac-a', online: true, entries: 1, bots: [{ remoteBotId: 'b1', name: '小研', entries: 0 }] }, { nodeId: 'n2', online: false, entries: null, bots: [] }],
  })
  assert.deepEqual(opts.map((o) => [o.group, o.label, o.entries]), [['team', '团队', 2], ['node', 'mac-a', 1], ['node', 'n2（离线）', null], ['bot', '小研 @ mac-a', 0]])
  assert.equal(opts[0].value, teamTeamScope)
  assert.deepEqual(teamMemScopeObj(opts[3].value), { kind: 'bot', nodeId: 'n1', remoteBotId: 'b1' })
  assert.deepEqual(teamMemScopeObj('not json'), { kind: 'team' })
  assert.deepEqual(teamMemScopeOptions(null), [])
  const rows = teamMemEntryRows({ entries: [{ id: 'e1', text: 'x', topic: 't', pinned: true }, { text: 'y', expired: true, until: '2026-01-01' }] })
  assert.deepEqual(rows.map((r) => [r.key, r.topic, r.pinned, r.expired]), [['e1', 't', true, false], ['i1', '', false, true]])
  assert.equal(teamMemFail(Object.assign(new Error('x'), { missing: true, status: 404 })).state, 'missing')
  assert.equal(teamMemFail(Object.assign(new Error('x'), { reason: '真原因' })).reason, '真原因')
})

test('goals and audit rows, including old assign entries and unknown kinds', () => {
  const g = teamGoalGroups([{ goal: 'a', idle: false }, { goal: 'b', idle: true }, null])
  assert.deepEqual([g.active.length, g.idle.length], [1, 1])
  const nameOf = (id) => ({ n1: 'mac-a' })[id]
  const ask = teamAuditRow({ kind: 'ask', at: 1700000000000, from: { name: 'A', nodeId: 'n1' }, to: { name: 'B', nodeId: 'n2' }, depth: 1, text: 'x'.repeat(300) }, 0, nameOf)
  assert.equal(ask.label, 'Bot 提问')
  assert.equal(ask.text.startsWith('A@mac-a → B@n2：'), true)
  assert.equal(ask.text.length < 160, true)
  assert.match(ask.text, /第 1 层/)
  assert.equal(teamAuditRow({ kind: 'reply', from: {}, to: {} }, 1, nameOf).label, 'Bot 回复')
  const req = teamAuditRow({ kind: 'approval-request', nodeId: 'n1', botId: 'b', tool: 'bash', reason: 'r' }, 2, nameOf)
  assert.deepEqual([req.label, req.tone, req.text], ['待批', 'warn', 'b@mac-a 申请 bash：r'])
  assert.equal(teamAuditRow({ kind: 'approval-settled', approvalId: 'ap', outcome: 'approved', nodeId: 'n1' }, 3, nameOf).text, 'ap → approved（mac-a）')
  const assign = teamAuditRow({ kind: 'bot.assign', op: 'deliver', outcome: 'forwarded', from: 'n1/A', to: 'n2/B', chars: 9 }, 4, nameOf)
  assert.deepEqual([assign.label, assign.history, assign.text], ['派活（历史）', true, 'n1/A → n2/B · deliver · forwarded · 9 字'])
  const odd = teamAuditRow({ kind: 'mystery', at: 1, foo: 'bar', nested: { a: 1 } }, 5, nameOf)
  assert.deepEqual([odd.label, odd.text], ['mystery', 'foo=bar · nested={"a":1}'])
  assert.equal(teamAuditRow(null, 6, nameOf).label, '未知')
})

/* ── 组件输出 ───────────────────────────────────────────────────────────── */

test('screen: createTeam hands the shell exactly css + Screen, css uses only tm- classes and tokens', () => {
  const team = createTeam(makeCore())
  assert.deepEqual(Object.keys(team).sort(), ['Screen', 'css'])
  const css = team.css.join('')
  const classes = css.match(/\.[a-z][\w-]*/g).filter((c) => !/^\.\d/.test(c))
  assert.ok(classes.every((c) => c.startsWith('.tm-')), 'only tm- classes: ' + classes.filter((c) => !c.startsWith('.tm-')).join(','))
  assert.equal(/#[0-9a-f]{3,6}\b|rgba?\(/i.test(css), false, 'colours come from tokens')
})

test('screen: loading state with no data yet', () => {
  const out = textOf(screenText([], {}))
  assert.match(out, /读取名册中/)
  assert.match(out, /0 台机器/)
  assert.match(out, /模型目录/)
  assert.match(out, /团队记忆/)
  assert.match(out, /读取中/)
})

test('screen: roster error is shown with the original text and a retry button', () => {
  const el = screenText([{ state: 'error', nodes: [], at: 0, error: 'HTTP 502 bad gateway' }], {})
  const out = textOf(el)
  assert.match(out, /读不到名册/)
  assert.match(out, /HTTP 502 bad gateway/)
  assert.equal(findButtons(el, '重试').length >= 1, true)
})

test('screen: empty roster offers the way to connect a machine', () => {
  const el = screenText([{ state: 'ok', nodes: [], at: 1, error: '' }], {})
  assert.match(textOf(el), /还没有机器上报 Bot/)
  assert.equal(findButtons(el, '去「机器」接入副机').length, 1)
})

test('screen: stale roster keeps the old data and says the refresh failed', () => {
  const out = textOf(screenText([{ state: 'ok', nodes: roster, at: 1700000000000, error: 'network down' }], {}))
  assert.match(out, /名册刷新失败/)
  assert.match(out, /network down/)
  assert.match(out, /小研/)
})

test('screen: machines, bots, offline greying, old version, unknown version, no identity', () => {
  const el = screenText([{ state: 'ok', nodes: roster, at: 1, error: '' }], {})
  const out = textOf(el)
  for (const s of ['mac-a', 'win-b', 'old-c', '小研', '无身份', '旧机器 Bot', 'AC 0.4.36', 'AC 0.4.30 过旧', '版本未知', '最后一次名册', '这台机器离线', '01234567…', '没有身份 id', '这台机器上还没有 Bot']) {
    assert.ok(out.includes(s), 'missing ' + s)
  }
  assert.match(out, /低于 0\.4\.34/)
  assert.match(out, /3 台机器 · 3 个 Bot/)
  assert.equal(findByDisabled(el, '停止').filter((b) => b.disabled).length, 1, 'only the offline machine Bot cannot be stopped')
})

/** 按钮文字 → { disabled, title }。 */
function findByDisabled(el, label) {
  return findButtons(el, label).map((b) => ({ disabled: b.props.disabled === true, title: b.props.title || '' }))
}

test('screen: offline node disables chat/edit/stop with the reason, locate stays enabled when it has an identity', () => {
  const el = screenText([{ state: 'ok', nodes: [roster[1]], at: 1, error: '' }], {})
  for (const label of ['对话', '编辑', '停止']) {
    const [b] = findByDisabled(el, label)
    assert.equal(b.disabled, true, label)
    assert.match(b.title, /离线/, label)
  }
  assert.equal(findByDisabled(el, '定位')[0].disabled, false)
  assert.equal(findByDisabled(el, '在这台新建')[0].disabled, true)
})

test('screen: online Bot without identity has locate disabled with its reason, no delete button exists', () => {
  const el = screenText([{ state: 'ok', nodes: [roster[0]], at: 1, error: '' }], {})
  const loc = findByDisabled(el, '定位')
  assert.deepEqual(loc.map((b) => b.disabled), [false, true])
  assert.match(loc[1].title, /身份 id/)
  assert.deepEqual(findByDisabled(el, '对话').map((b) => b.disabled), [false, false])
  assert.equal(findButtons(el, '删除').length, 0)
  assert.equal(findAll(expand(el), (n) => n.type === 'button' && /删除/.test(texts(n).join(''))).length, 0)
  const copy = findButtons(el, '复制 id')
  assert.equal(copy.length, 1, 'only the Bot that has an identity gets a copy button')
})

test('screen: hub-only online node appears so its first Bot can be created', () => {
  const out = textOf(screenText([{ state: 'ok', nodes: [], at: 1, error: '' }], { nodes: [{ nodeId: 'z', hostname: 'brand-new', online: true }] }))
  assert.match(out, /brand-new/)
  assert.match(out, /还没有上报名册/)
})

test('screen: create form (detail = form) shows templates, talents, model picker and counters', () => {
  const models = { state: 'ok', nodes: [{ nodeId: 'n1', hostname: 'mac-a', online: true, defaultModel: 'p/m', models: [{ id: 'p/m', name: 'M', efforts: [] }] }], error: '' }
  const catalog = {
    talents: { state: 'ok', list: [{ name: '分析师', role: '分析', category: '通用' }], reason: '' },
    templates: { state: 'ok', list: [{ id: 't1', name: '审稿', role: '编辑', category: '写作' }], reason: '' },
  }
  const form = teamFormInit({ nodeId: 'n1', name: 'a'.repeat(41) })
  const el = screenText([{ state: 'ok', nodes: roster, at: 1, error: '' }, models, catalog, { kind: 'form' }, form], {})
  const out = textOf(el)
  for (const s of ['新建 Bot', '从模板库套用', '从人才库套用', '从这台机器的模型里选', 'M (p/m) · 默认', '41/40', '0/8000 字节', '名称超过 40 个字符']) {
    assert.ok(out.includes(s), 'missing ' + s)
  }
  assert.equal(findButtons(el, '创建').length, 1)
  assert.ok(findAll(expand(el), (n) => n.type === 'label').length >= 6, 'controls are wrapped in real labels')
  const machines = findAll(expand(el), (n) => n.type === 'option' && texts(n).join('') === 'mac-a')
  assert.equal(machines.length, 1)
  assert.equal(findAll(expand(el), (n) => n.type === 'option' && texts(n).join('') === 'win-b').length, 0, 'offline machines are not offered')
})

test('screen: edit form pins the machine, explains blank = unchanged and has no template pickers', () => {
  const f = teamFormFromBot({ nodeId: 'n1' }, { id: 'b1', name: '小研', role: '研究', model: 'ds/pro' })
  const catalog = { talents: { state: 'ok', list: [{ name: 'x' }], reason: '' }, templates: { state: 'ok', list: [{ id: 't', name: 'y' }], reason: '' } }
  const el = screenText([{ state: 'ok', nodes: roster, at: 1, error: '' }, { state: 'ok', nodes: [], error: '' }, catalog, { kind: 'form' }, f], {})
  const out = textOf(el)
  assert.match(out, /编辑 Bot：小研/)
  assert.match(out, /留空 = 不修改/)
  assert.equal(out.includes('从模板库套用'), false)
  assert.equal(findButtons(el, '保存').length, 1)
  const select = findAll(expand(el), (n) => n.type === 'select' && n.props.disabled === true)
  assert.equal(select.length, 1, 'the machine cannot change while editing')
})

test('screen: chat detail renders history rows, the Shift+Enter hint and a disabled send until there is text', () => {
  const okCatalog = { talents: { state: 'ok', list: [], reason: '' }, templates: { state: 'ok', list: [], reason: '' } }
  const screenStates = [{ state: 'ok', nodes: roster, at: 1, error: '' }, { state: 'ok', nodes: [], error: '' }, okCatalog, { kind: 'chat', nodeId: 'n1', botId: 'b1' }, teamFormInit(), { busy: false, ok: false, note: '', tried: false }, {}]
  const chatStates = [{ state: 'ready', items: [{ kind: 'user', text: '问题' }, { kind: 'bot', text: '回答' }], error: '' }, teamTurnInit, '']
  const core = makeCore({ state: [...screenStates, ...copyStates(roster), ...chatStates] })
  const el = expand(core.h(createTeam(core).Screen, { hub: Object.assign({}, dataEmptyHub, { loading: false }), ui, go() {}, refresh() {} }))
  const out = textOf(el)
  for (const s of ['对话：小研', '@ mac-a', 'Shift+Enter 换行', '问题', '回答', '我', 'Bot']) assert.ok(out.includes(s), 'missing ' + s)
  const send = findButtons(el, '发送')
  assert.equal(send.length, 1)
  assert.equal(send[0].props.disabled, true)
  assert.equal(findButtons(el, '刷新对话').length, 1)
  assert.equal(findAll(expand(el), (n) => n.type === 'textarea' && n.props.placeholder === '发给这个 Bot…').length, 1)
  assert.equal(findAll(expand(el), (n) => n.props && n.props.role === 'log').length, 1)
})

test('screen: chat states — running with link lost, failed with the original code, offline machine', () => {
  const okCatalog = { talents: { state: 'ok', list: [], reason: '' }, templates: { state: 'ok', list: [], reason: '' } }
  const screenStates = (nodes) => [{ state: 'ok', nodes, at: 1, error: '' }, { state: 'ok', nodes: [], error: '' }, okCatalog, { kind: 'chat', nodeId: nodes[0].nodeId, botId: nodes[0].bots[0].id }, teamFormInit(), { busy: false, ok: false, note: '', tried: false }, {}]
  const render = (nodes, chat) => {
    const core = makeCore({ state: [...screenStates(nodes), ...copyStates(nodes), ...chat] })
    return expand(core.h(createTeam(core).Screen, { hub: Object.assign({}, dataEmptyHub, { loading: false }), ui, go() {}, refresh() {} }))
  }
  const hist = { state: 'ready', items: [], error: '' }
  const running = render([roster[0]], [hist, Object.assign({}, teamTurnInit, { state: 'running', sent: '在吗', linkLost: true, warn: 'HTTP 500' }), ''])
  const rt = textOf(running)
  assert.match(rt, /运行中…你刚发的是：在吗/)
  assert.match(rt, /连接断了/)
  assert.match(rt, /读取进度失败（会重试）：HTTP 500/)
  assert.equal(findButtons(running, '运行中…')[0].props.disabled, true, 'send is disabled while running')
  const failed = textOf(render([roster[0]], [hist, Object.assign({}, teamTurnInit, { state: 'failed', error: 'bot-turn-busy' }), '']))
  assert.match(failed, /失败：正在跑的对话太多，稍后再试（bot-turn-busy）/)
  const timeout = textOf(render([roster[0]], [hist, Object.assign({}, teamTurnInit, { state: 'timeout' }), '']))
  assert.match(timeout, /等了 5 分钟/)
  const done = textOf(render([roster[0]], [{ state: 'loading', items: [], error: '' }, Object.assign({}, teamTurnInit, { state: 'done', text: '这是回答' }), '']))
  assert.match(done, /Bot 回答：这是回答/)
  const histFail = textOf(render([roster[0]], [{ state: 'error', items: [], error: 'node-offline' }, teamTurnInit, '']))
  assert.match(histFail, /读取对话失败/)
  assert.match(histFail, /这台机器当前不在线（node-offline）/)
  const offline = render([roster[1]], [hist, teamTurnInit, '草稿'])
  assert.match(textOf(offline), /这台机器离线，发不了消息/)
  assert.equal(findButtons(offline, '发送')[0].props.disabled, true)
})

test('screen: locate detail is only offered for a Bot with an identity and shows the waiting state', () => {
  const okCatalog = { talents: { state: 'ok', list: [], reason: '' }, templates: { state: 'ok', list: [], reason: '' } }
  const base = (botId) => [{ state: 'ok', nodes: roster, at: 1, error: '' }, { state: 'ok', nodes: [], error: '' }, okCatalog, { kind: 'locate', nodeId: 'n1', botId }, teamFormInit(), { busy: false, ok: false, note: '', tried: false }, {}]
  const render = (state) => { const core = makeCore({ state: [...state.slice(0, 7), ...copyStates(roster), ...state.slice(7)] }); return expand(core.h(createTeam(core).Screen, { hub: Object.assign({}, dataEmptyHub, { loading: false }), ui, go() {}, refresh() {} })) }
  const waiting = render([...base('b1'), { state: 'loading', data: null, error: '' }])
  assert.match(textOf(waiting), /定位：小研/)
  assert.match(textOf(waiting), /正在问所有在线机器/)
  assert.match(textOf(waiting), /身份 id 0123456789abcdef/)
  const done = textOf(render([...base('b1'), { state: 'ready', data: { ok: true, locations: [{ nodeId: 'n1', machineId: 'machine-xyz' }], notHere: ['n2'], silent: [], unsupported: ['n3'], unsent: [], rejected: [{ nodeId: 'n4', reason: 'wrong-bot' }] }, error: '' }]))
  for (const s of ['Bot 现在在这些机器上', 'mac-a（n1）', '回答「不在我这里」的机器', 'win-b（n2）', '版本太旧、不支持定位', 'old-c（n3）', '回答的不是这个 Bot']) assert.ok(done.includes(s), 'missing ' + s)
  const failed = textOf(render([...base('b1'), { state: 'error', data: null, error: 'bot-locate-unavailable' }]))
  assert.match(failed, /这台主控不支持按身份定位（bot-locate-unavailable）/)
  const nobody = textOf(render([...base('b1'), { state: 'ready', data: { ok: true, locations: [], notHere: [], silent: [], unsupported: [], unsent: [], rejected: [] }, error: '' }]))
  assert.match(nobody, /没有任何机器认领/)
  const noId = textOf(render(base('b2')))
  assert.match(noId, /已经不在名册里/)
})

test('screen: models directory states (unreported / none / default marker / total)', () => {
  const models = { state: 'ok', error: '', nodes: [
    { nodeId: 'n1', hostname: 'mac-a', online: true, defaultModel: 'p/m', models: [{ id: 'p/m', name: 'M', efforts: [{ id: 'low' }, { id: 'high' }] }] },
    { nodeId: 'n2', hostname: 'win-b', online: false, defaultModel: null, models: null },
    { nodeId: 'n3', hostname: 'lin-c', online: true, defaultModel: null, models: [] },
  ] }
  const out = textOf(screenText([{ state: 'ok', nodes: [], at: 1, error: '' }, models], {}))
  for (const s of ['M (p/m)', '默认', '思考等级：low / high', '尚未上报模型', '没有可用模型', '1 个']) assert.ok(out.includes(s), 'missing ' + s)
  const err = textOf(screenText([{ state: 'ok', nodes: [], at: 1, error: '' }, { state: 'error', nodes: [], error: 'not-available / model-store-missing' }], {}))
  assert.match(err, /读模型列表失败：not-available \/ model-store-missing/)
  const empty = textOf(screenText([{ state: 'ok', nodes: [], at: 1, error: '' }, { state: 'ok', nodes: [], error: '' }], {}))
  assert.match(empty, /还没有机器上报模型/)
})

test('screen: goals and audit are read-only lists with history labelling', () => {
  const hub = {
    goals: [{ nodeId: 'n1', botId: 'b1', botName: '小研', goal: '写周报', idle: false, lastAt: 1700000000000 }, { nodeId: 'n2', botId: 'b3', goal: '', idle: true }],
    botAudit: [{ kind: 'ask', at: 1700000000000, from: { name: 'A', nodeId: 'n1' }, to: { name: 'B', nodeId: 'n2' }, text: 'hi' }, { kind: 'bot.assign', at: 1, op: 'deliver', outcome: 'forwarded', from: 'n1/A', to: 'n2/B' }],
  }
  const el = screenText([{ state: 'ok', nodes: roster, at: 1, error: '' }], hub)
  const out = textOf(el)
  for (const s of ['目标追踪', '写周报', '进行中', '空闲', '（无目标）', 'Bot 间通信审计（历史）', '0.4.36 起不再产生新的 assign 记录', 'Bot 提问', '派活（历史）', 'A@mac-a → B@win-b：hi']) assert.ok(out.includes(s), 'missing ' + s)
  assert.equal(findAll(expand(el), (n) => n.type === 'button' && /删除|清除|清空/.test(texts(n).join(''))).length, 0, 'goals and audit have no write actions')
  const missing = textOf(screenText([{ state: 'ok', nodes: roster, at: 1, error: '' }], { goals: undefined, botAudit: undefined }))
  assert.match(missing, /暂时读不到目标列表/)
  assert.match(missing, /暂时读不到审计记录/)
  assert.match(textOf(screenText([{ state: 'ok', nodes: roster, at: 1, error: '' }], { goals: [], botAudit: [] })), /没有 Bot 在追踪目标/)
})

test('screen: memory section — missing endpoint, error, entries with topic and forget, add form', () => {
  const memCore = (state) => {
    const core = makeCore({ state })
    const el = expand(core.h(createTeam(core).Screen, { hub: Object.assign({}, dataEmptyHub, { loading: false }), ui, go() {}, refresh() {} }))
    return el
  }
  const base = [{ state: 'ok', nodes: [], at: 1, error: '' }, { state: 'ok', nodes: [], error: '' }, { talents: { state: 'ok', list: [], reason: '' }, templates: { state: 'ok', list: [], reason: '' } }, null, teamFormInit(), { busy: false, ok: false, note: '', tried: false }, {}]
  const scopes = { state: 'ok', data: { team: { entries: 1 }, nodes: [{ nodeId: 'n1', hostname: 'mac-a', online: true, entries: 0, bots: [] }] }, reason: '', status: 200 }
  const ok = textOf(memCore([...base, teamTeamScope, scopes, { state: 'ok', data: { entries: [{ id: 'e1', text: '记住这个', topic: '偏好', added: '2026-11-01', pinned: true }, { id: 'e2', text: '过期', expired: true }] }, reason: '', status: 200 }, '', '', false, '']))
  for (const s of ['记忆范围', '团队（1）', 'mac-a（0）', '记住这个', '主题 偏好', '添加 2026-11-01', '置顶', '已过期', '遗忘', '记住一件事', '主题（可选）']) assert.ok(ok.includes(s), 'missing ' + s)
  const el = memCore([...base, teamTeamScope, scopes, { state: 'ok', data: { entries: [] }, reason: '', status: 200 }, '', '', false, ''])
  assert.match(textOf(el), /这个范围还没有记忆/)
  assert.equal(findButtons(el, '记住').filter((b) => b.props.type === 'submit')[0].props.disabled, true, 'empty draft cannot be submitted')
  const missing = textOf(memCore([...base, teamTeamScope, { state: 'missing', data: null, reason: 'memory-api-missing', status: 404 }, { state: 'loading', data: null, reason: '', status: 0 }, '', '', false, '']))
  assert.match(missing, /记忆接口不可用（memory-api-missing）/)
  assert.match(missing, /HTTP 404/)
  const failed = textOf(memCore([...base, teamTeamScope, scopes, { state: 'error', data: null, reason: '磁盘坏了', status: 200 }, '', '', false, '']))
  assert.match(failed, /读记忆失败：磁盘坏了/)
  const noted = textOf(memCore([...base, teamTeamScope, scopes, { state: 'ok', data: { entries: [] }, reason: '', status: 200 }, '草稿', '', false, '写记忆失败：memory/refused']))
  assert.match(noted, /写记忆失败：memory\/refused/)
})

test('memory: a scope no longer in the list stays selectable instead of silently switching', () => {
  const core = makeCore({ state: [{ state: 'ok', nodes: [], at: 1, error: '' }, { state: 'ok', nodes: [], error: '' }, { talents: { state: 'ok', list: [], reason: '' }, templates: { state: 'ok', list: [], reason: '' } }, null, teamFormInit(), { busy: false, ok: false, note: '', tried: false }, {},
    JSON.stringify({ kind: 'node', nodeId: 'gone' }), { state: 'ok', data: { team: { entries: 0 }, nodes: [] }, reason: '', status: 200 }, { state: 'ok', data: { entries: [] }, reason: '', status: 200 }, '', '', false, ''] })
  const el = expand(core.h(createTeam(core).Screen, { hub: Object.assign({}, dataEmptyHub, { loading: false }), ui, go() {}, refresh() {} }))
  assert.match(textOf(el), /当前范围（名单里暂时没有）/)
})

test('fetch-backed ds-bot call: reject carries reason / missing, success returns the value', async () => {
  const { teamBotCall } = await import('../../src/panel/team.js')
  const real = globalThis.fetch
  try {
    globalThis.fetch = () => Promise.resolve({ status: 200, text: () => Promise.resolve('{"ok":true,"value":{"talents":[]}}') })
    assert.deepEqual(await teamBotCall('list-talents', {}), { talents: [] })
    globalThis.fetch = () => Promise.resolve({ status: 404, text: () => Promise.resolve('') })
    await assert.rejects(teamBotCall('memory-hub-view', {}), (e) => e.missing === true && e.status === 404 && e.reason === 'memory-api-missing')
    globalThis.fetch = () => Promise.reject(new Error('offline'))
    await assert.rejects(teamBotCall('memory-hub-view', {}), (e) => e.missing === false && e.reason === 'offline')
    let seen = null
    globalThis.fetch = (url, init) => { seen = { url, body: JSON.parse(init.body) }; return Promise.resolve({ status: 200, text: () => Promise.resolve('{"ok":true,"value":1}') }) }
    await teamBotCall('memory-hub-add', { scope: { kind: 'team' }, text: 'x' })
    assert.deepEqual(seen, { url: '/api/bot', body: { endpoint: 'memory-hub-add', payload: { scope: { kind: 'team' }, text: 'x' } } })
  } finally { globalThis.fetch = real }
})

test('react fake sanity: makeReact is usable standalone', () => {
  assert.equal(typeof makeReact().useState, 'function')
})

/* ── 从旧的 ui-p2-models-screen / review-fix-create-nodes / ui-p4-memory-screen 迁来 ── */

test('models: null = unreported, [] = reported empty, invalid entries dropped, order kept', () => {
  const view = (n) => teamModelsNodeView(Object.assign({ nodeId: 'n1' }, n))
  const nul = view({ models: null, defaultModel: '' })
  assert.deepEqual([nul.state, nul.defaultModel], ['unreported', null])
  assert.equal(view({}).state, 'unreported', 'a missing models field is also unreported')
  assert.equal(view({ models: 'oops' }).state, 'unreported', 'a non-array is not an empty list')
  assert.equal(view({ models: [] }).state, 'none')
  const mixed = view({ defaultModel: 'a', models: [{ id: 'a' }, { id: '' }, { id: 42 }, null, 'x', { id: 'b', efforts: [null, { id: 'low' }, { name: 'no id' }] }] })
  assert.deepEqual(mixed.rows.map((r) => r.id), ['a', 'b'])
  assert.deepEqual(mixed.rows[1].efforts, ['low'])
  assert.equal(mixed.rows[0].isDefault, true)
  assert.equal(mixed.defaultModel, 'a')
  assert.deepEqual(teamCleanModels([{ id: 'z' }, { id: 'y' }]).map((m) => m.id), ['z', 'y'])
  assert.equal(teamModelsTotal([{ models: [{ id: 'a' }, { id: '' }] }, { models: null }, null]), 1)
  const projected = teamModelsProject({ ok: true, nodes: [null, 'x', { nodeId: '' }, { nodeId: 7 }, { nodeId: 'n2', models: [] }, { nodeId: 'n1', models: [] }] })
  assert.deepEqual([projected.kind, projected.nodes.map((n) => n.nodeId)], ['data', ['n2', 'n1']])
  assert.equal(teamModelsProject({ ok: true, nodes: [null] }).kind, 'empty')
  assert.deepEqual(teamModelOptions([{ nodeId: 'n1', models: [{ id: '' }, { id: 'ok' }] }], 'n1').map((o) => o.id), ['ok'])
})

test('models screen: a machine is shown online/offline and "all machines have none" is said once', () => {
  const nodes = [{ nodeId: 'a', hostname: 'host-a', online: true, defaultModel: null, models: [] }, { nodeId: 'b', hostname: 'host-b', online: false, defaultModel: null, models: null }]
  const out = textOf(screenText([{ state: 'ok', nodes: [], at: 1, error: '' }, { state: 'ok', nodes, error: '' }], {}))
  for (const s of ['host-a', '在线', 'host-b', '离线', '所有机器都没有可用模型', '没有可用模型', '尚未上报模型']) assert.ok(out.includes(s), 'missing ' + s)
  const some = textOf(screenText([{ state: 'ok', nodes: [], at: 1, error: '' }, { state: 'ok', error: '', nodes: [{ nodeId: 'a', hostname: 'a', online: true, models: [{ id: 'm' }] }] }], {}))
  assert.equal(some.includes('所有机器都没有可用模型'), false)
})

test('create form node list: roster nodes plus online hub nodes the roster lacks; offline never; roster wins', () => {
  const hubNodes = [{ nodeId: 'n-old', hostname: 'OLD', online: true }, { nodeId: 'n-new', hostname: 'NEW', online: true }, { nodeId: 'n-off', hostname: 'OFF', online: false }]
  const online = (rows) => rows.filter((r) => r.online).map((r) => r.nodeId)
  const rosterOne = [{ nodeId: 'n-old', hostname: 'OLD', online: true, bots: [{ id: 'b1' }] }]
  const rows = teamNodeRows(rosterOne, hubNodes)
  assert.deepEqual(rows.map((r) => r.nodeId).sort(), ['n-new', 'n-old'])
  assert.deepEqual(rows.find((r) => r.nodeId === 'n-new').bots, [], 'a machine the roster has not heard of has an empty Bot list')
  assert.equal(rows.some((r) => r.nodeId === 'n-off'), false, 'offline hub nodes are never invented')
  // 名册整体为空（total 0）时，在线的主机节点仍然可选
  assert.deepEqual(online(teamNodeRows([], hubNodes)).sort(), ['n-new', 'n-old'])
  // 名册读失败又没有主机快照：什么也不编
  assert.deepEqual(teamNodeRows([], undefined), [])
  assert.deepEqual(teamNodeRows(null, null), [])
  // 名册里的那条优先（不重复，主机名取名册的）
  const dup = teamNodeRows([{ nodeId: 'n-new', hostname: 'ROSTER', online: true, bots: [{ id: 'b' }] }], hubNodes)
  assert.equal(dup.filter((r) => r.nodeId === 'n-new').length, 1)
  assert.equal(dup.find((r) => r.nodeId === 'n-new').hostname, 'ROSTER')
  // 名册里离线的机器不出现在表单里
  assert.deepEqual(online(teamNodeRows([{ nodeId: 'n-r', hostname: 'R', online: false, bots: [] }], [])), [])
})

test('create form renders exactly the selectable online machines (roster + hub-only), selectable by value', () => {
  const hub = { nodes: [{ nodeId: 'n-old', hostname: 'OLD', online: true }, { nodeId: 'n-new', hostname: 'NEW', online: true }, { nodeId: 'n-off', hostname: 'OFF', online: false }] }
  const bots = { state: 'ok', nodes: [{ nodeId: 'n-old', hostname: 'OLD', online: true, bots: [{ id: 'b1' }] }, { nodeId: 'n-r', hostname: 'R', online: false, bots: [] }], at: 1, error: '' }
  const okCat = { talents: { state: 'ok', list: [], reason: '' }, templates: { state: 'ok', list: [], reason: '' } }
  const el = screenText([bots, { state: 'ok', nodes: [], error: '' }, okCat, { kind: 'form' }, teamFormInit()], hub)
  const select = findAll(expand(el), (n) => n.type === 'select' && n.props.value === '' && findAll(n, (o) => o.type === 'option' && o.props.value === 'n-old').length > 0)
  assert.equal(select.length, 1)
  const opts = findAll(select[0], (o) => o.type === 'option' && o.props.value).map((o) => [o.props.value, texts(o).join('')])
  assert.deepEqual(opts, [['n-new', 'NEW'], ['n-old', 'OLD']])
})

test('memory scope options: only the team when no machine reported; muted flag on expired rows', () => {
  assert.equal(teamMemScopeOptions({}).length, 1)
  assert.equal(teamMemScopeOptions({ nodes: 'x' }).length, 1)
  const rows = teamMemEntryRows({ entries: [{ id: 'e1', text: 'standing rule', pinned: true }, { id: 'e2', topic: 'work', text: 'old plan', expired: true, until: '2026-02-01' }] })
  assert.deepEqual(rows.map((r) => [r.pinned, r.expired, r.until]), [[true, false, ''], [false, true, '2026-02-01']])
  assert.deepEqual(teamMemEntryRows({}), [])
})
