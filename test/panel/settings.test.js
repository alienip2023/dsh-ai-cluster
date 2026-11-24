import assert from 'node:assert/strict'
import test from 'node:test'
import { createCore } from '../../src/panel/core.js'
import {
  createSettings, settingsApplyPath, settingsApplyPayload, settingsApplyToCurrent, settingsConfigPayload, settingsConfigTemplate,
  settingsEmptyForm, settingsEnvItems, settingsEnvSummary, settingsErrText, settingsFixConfirm, settingsFixPreview, settingsFixResult,
  settingsFormFromCurrent, settingsLinkRows, settingsLinkSummary, settingsListenerView, settingsNextFocus, settingsParsePair,
  settingsParseRoots, settingsPlatform, settingsReviewRows, settingsRolePlan, settingsRoleName, settingsRootProblem, settingsRootsExample,
  settingsSaveConfirm, settingsTaskLine, settingsTokenState, settingsTransportLabel, settingsUrlProblem, settingsValidate,
  settingsWorkerError, settingsWorkerFacts,
} from '../../src/panel/settings.js'
import { expand, findAll, findButtons, findByClass, makeReact, textOf, texts } from './_fake.js'

/* 假 React：useState 按「状态形状」认领测试给的覆盖值，不依赖渲染顺序（CopyBtn 之类也有 useState）。 */
function mount(over = {}, effects = null) {
  const R = makeReact()
  if (effects) R.useEffect = (fn) => { effects.push(fn) }
  R.useState = (v) => {
    const init = typeof v === 'function' ? v() : v
    let key = ''
    if (init && typeof init === 'object') {
      if ('step' in init && 'pairNote' in init) key = 'setup'
      else if ('wroteToken' in init) key = 'editor'
      else if ('fixBusy' in init && 'preview' in init) key = 'env'
    }
    return [key && over[key] ? Object.assign({}, init, over[key]) : init, () => {}]
  }
  const core = createCore(R)
  return createSettings(core)
}

const noop = () => {}
const ui = () => ({ confirm: async () => true, alert: noop, prompt: async () => null, notify: noop })
const hubSetup = {
  configured: true, effectiveRole: 'hub', patchFile: '/p/cordis.patch.yml',
  current: { role: 'hub', transportMode: 'relay', relayUrl: 'ws://10.0.0.5:8890/relay', hubUrl: '', listenHost: '', listenPort: 19387, roots: ['/data/work'], nodeId: 'hubA', tokenSet: true },
}

function b64url(obj) { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url') }

/* ── 纯函数 ── */

test('role plans: which fields each role needs', () => {
  assert.deepEqual(settingsRolePlan('worker'), {
    role: 'worker', valid: true, hub: false, worker: true, pair: true, rootsPrimary: true, requireRelayUrl: true, requireHubUrl: true,
    relayUrlLabel: '中继地址（relayUrl）', hubUrlLabel: '主机地址（hubUrl）', tokenLabel: '接入口令（enrollToken）',
  })
  const hub = settingsRolePlan(' HUB ')
  assert.equal(hub.role, 'hub')
  assert.equal(hub.pair, false)
  assert.equal(hub.requireRelayUrl, false)
  assert.equal(hub.tokenLabel, '中继口令（hubToken）')
  const both = settingsRolePlan('both')
  assert.equal(both.hub && both.worker, true)
  assert.equal(both.rootsPrimary, true)
  assert.equal(settingsRolePlan('x').valid, false)
  assert.equal(settingsRoleName('both'), '同机')
  assert.equal(settingsRoleName(''), '未配置')
})

test('validation: required fields, url rules, port, node id, roots', () => {
  const ok = Object.assign(settingsEmptyForm(), { relayUrl: 'ws://192.168.1.10:8890/relay' })
  assert.deepEqual(settingsValidate('worker', ok), {})
  assert.deepEqual(settingsValidate('hub', settingsEmptyForm()), {}, 'hub 中继地址可选')
  assert.match(settingsValidate('worker', settingsEmptyForm()).relayUrl, /必须填中继地址/)
  assert.match(settingsValidate('worker', { transportMode: 'direct' }).hubUrl, /直连模式必须填主机地址/)
  assert.deepEqual(settingsValidate('hub', { transportMode: 'direct' }), {}, 'hub 直连的本机对外地址可留空')
  assert.match(settingsValidate('worker', { relayUrl: 'ws://0.0.0.0:8890/relay' }).relayUrl, /0\.0\.0\.0/)
  assert.match(settingsValidate('worker', { relayUrl: 'ws://localhost:8890/relay' }).relayUrl, /localhost/)
  assert.deepEqual(settingsValidate('both', { relayUrl: 'ws://127.0.0.1:8890/relay' }), {}, '同机自测可以连回环')
  assert.match(settingsValidate('worker', { relayUrl: '192.168.1.10:8890' }).relayUrl, /ws:\/\//)
  assert.match(settingsValidate('worker', { relayUrl: 'ws://a b' }).relayUrl, /空格/)
  assert.match(settingsValidate('hub', { hubUrl: 'ftp://x' }).hubUrl, /开头/)
  assert.match(settingsValidate('hub', { listenPort: '70000' }).listenPort, /0–65535/)
  assert.match(settingsValidate('hub', { listenPort: 'abc' }).listenPort, /整数/)
  assert.deepEqual(settingsValidate('hub', { listenPort: '0' }), {})
  assert.match(settingsValidate('hub', { nodeId: '-bad' }).nodeId, /节点 ID/)
  assert.match(settingsValidate('hub', { token: 'a b' }).token, /空格/)
  assert.match(settingsValidate('', settingsEmptyForm()).role, /选择角色/)
  assert.equal(settingsUrlProblem('wss://relay.example.com/relay'), '')
  assert.equal(settingsUrlProblem(''), '')
})

test('roots: absolute only, never a whole disk or home directory', () => {
  assert.deepEqual(settingsParseRoots('/a/b\n D:\\work ,\n\n/c'), ['/a/b', 'D:\\work', '/c'])
  assert.equal(settingsRootProblem('/Users/me/work'), '')
  assert.equal(settingsRootProblem('D:\\work'), '')
  assert.equal(settingsRootProblem('\\\\nas\\share\\w'), '')
  assert.match(settingsRootProblem('~/work'), /~/)
  assert.match(settingsRootProblem('work'), /绝对路径/)
  assert.match(settingsRootProblem('/'), /整个磁盘/)
  assert.match(settingsRootProblem('C:\\'), /整个磁盘/)
  assert.match(settingsRootProblem('/Users/me'), /家目录/)
  assert.match(settingsRootProblem('C:\\Users\\me\\'), /家目录/)
  assert.match(settingsValidate('worker', { relayUrl: 'ws://10.0.0.1:8890/relay', roots: '/ok\nrel' }).roots, /rel：必须是绝对路径/)
  assert.equal(settingsPlatform('Mozilla/5.0 (Windows NT 10.0)'), 'windows')
  assert.equal(settingsPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)'), 'mac')
  assert.equal(settingsPlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'linux')
  assert.equal(settingsRootsExample('windows'), 'D:\\work')
  assert.match(settingsRootsExample('mac'), /^\/Users\//)
  assert.match(settingsRootsExample(''), /^\/home\//)
})

test('form seeding never carries a token; port 0 survives', () => {
  const f = settingsFormFromCurrent({ transportMode: 'direct', hubUrl: 'ws://h', hubToken: 'SECRET', listenPort: 0, roots: ['/a', '/b'], nodeId: 'n1' })
  assert.deepEqual(f, { transportMode: 'direct', relayUrl: '', hubUrl: 'ws://h', token: '', nodeId: 'n1', roots: '/a\n/b', listenHost: '', listenPort: '0' })
  assert.deepEqual(settingsFormFromCurrent(null), settingsEmptyForm())
})

test('wizard payload: relay and direct, tokens only when typed, listen keys always sent', () => {
  const relay = settingsApplyPayload('hub', Object.assign(settingsEmptyForm(), { relayUrl: ' ws://10.0.0.5:8890/relay ', hubUrl: 'http://10.0.0.5:19387', token: ' rt_x ', roots: '/data/work', nodeId: 'hubA', listenPort: '19387' }))
  assert.deepEqual(relay, {
    role: 'hub', transportMode: 'relay', relayUrl: 'ws://10.0.0.5:8890/relay', hubUrl: 'http://10.0.0.5:19387', hubToken: 'rt_x',
    listenHost: '', listenPort: '19387', nodeId: 'hubA', roots: ['/data/work'],
  })
  const workerRelay = settingsApplyPayload('worker', Object.assign(settingsEmptyForm(), { relayUrl: 'ws://r/relay', hubUrl: 'ws://ignored' }))
  assert.equal('hubUrl' in workerRelay, false, '副机中继模式不发 hubUrl')
  assert.equal('hubToken' in workerRelay, false, '没填口令就不发')
  assert.equal('roots' in workerRelay, false)
  assert.equal(workerRelay.listenHost, '')
  const direct = settingsApplyPayload('worker', { transportMode: 'direct', hubUrl: 'ws://10.0.0.5:19387/api/remote-agent/node', relayUrl: 'ws://ignored', token: 'ignored' }, { force: true })
  assert.deepEqual(direct, { role: 'worker', force: true, transportMode: 'direct', hubUrl: 'ws://10.0.0.5:19387/api/remote-agent/node', listenHost: '', listenPort: '' })
})

test('config payload sends only what changed; token only when typed', () => {
  const base = hubSetup.current
  const same = settingsConfigPayload('hub', base, settingsFormFromCurrent(base))
  assert.deepEqual(same.changed, [])
  assert.deepEqual(same.payload, { role: 'hub' })
  const form = Object.assign(settingsFormFromCurrent(base), { relayUrl: 'ws://10.0.0.9:8890/relay', listenPort: '', token: 'rt_new' })
  const r = settingsConfigPayload('hub', base, form)
  assert.deepEqual(r.changed, ['relayUrl', 'listenPort', 'token'])
  assert.deepEqual(r.payload, { role: 'hub', relayUrl: 'ws://10.0.0.9:8890/relay', listenPort: '', hubToken: 'rt_new' })
  assert.deepEqual(r.errors, {})
  const bad = settingsConfigPayload('worker', { transportMode: 'relay' }, { transportMode: 'direct' })
  assert.match(bad.errors.hubUrl, /必须填主机地址/)
  assert.match(settingsSaveConfirm(['relayUrl', 'token'], '/p/x.yml'), /中继地址、口令/)
  assert.doesNotMatch(settingsSaveConfirm(['token'], ''), /rt_/)
})

test('written values merge into current without keeping the token', () => {
  const next = settingsApplyToCurrent(hubSetup.current, { role: 'hub', relayUrl: 'ws://n', listenPort: '', hubToken: 'rt_secret' })
  assert.equal(next.relayUrl, 'ws://n')
  assert.equal(next.listenPort, null)
  assert.equal(next.tokenSet, true)
  assert.equal(JSON.stringify(next).includes('rt_secret'), false)
  assert.equal(settingsApplyToCurrent({ listenPort: 5 }, { listenPort: '0' }).listenPort, 0)
})

test('review rows and token states never expose a token', () => {
  const rows = settingsReviewRows('worker', Object.assign(settingsEmptyForm(), { relayUrl: 'ws://r/relay', token: 'en_secret', roots: '/w' }), { tokenSet: false })
  const flat = JSON.stringify(rows)
  assert.equal(flat.includes('en_secret'), false)
  assert.ok(flat.includes('已填写'))
  assert.deepEqual(settingsReviewRows('hub', settingsEmptyForm(), { tokenSet: true }).find((r) => r[0] === '口令'), ['口令', '沿用已设置的口令'])
  assert.deepEqual(settingsTokenState('hub', {}, { relayTokenSet: true, nodeTokenSet: false }, false), { relay: true, node: false, role: 'hub' })
  assert.deepEqual(settingsTokenState('worker', { tokenSet: true }, null, false), { relay: true, node: null, role: 'worker' })
  assert.equal(settingsTokenState('worker', {}, null, true).relay, true)
  assert.equal(settingsTokenState('worker', {}, null, false).relay, null)
})

test('config template matches the keys /setup/apply writes and keeps placeholders for tokens', () => {
  const t = settingsConfigTemplate('worker', Object.assign(settingsEmptyForm(), { relayUrl: 'ws://r/relay' }))
  assert.match(t, /role: worker/)
  assert.match(t, /relayUrl: 'ws:\/\/r\/relay'/)
  assert.match(t, /token: '<接入口令>'/)
  const d = settingsConfigTemplate('worker', { transportMode: 'direct', hubUrl: '' })
  assert.match(d, /hubUrl: '<主机地址:端口>'/)
  assert.match(d, /nodeToken: '<入网口令>'/)
  assert.match(settingsConfigTemplate('hub', { relayUrl: 'ws://r', hubUrl: 'http://me', token: 'rt_1' }), /hubUrl: 'http:\/\/me'/)
})

test('pair code: base64url dshra1 / cluster1 parse, errors are human', () => {
  const code = 'dshra1://' + b64url({ v: 1, hubUrl: 'ws://10.0.0.5:19387/api/remote-agent/node', token: 'tok', nodeId: 'box-1' })
  const r = settingsParsePair('  ' + code.slice(0, 20) + '\n' + code.slice(20) + '  ')
  assert.equal(r.ok, true)
  assert.deepEqual(r.fill, { transportMode: 'direct', hubUrl: 'ws://10.0.0.5:19387/api/remote-agent/node', nodeId: 'box-1' })
  assert.equal(r.hasToken, true)
  assert.equal(JSON.stringify(r).includes('"tok"'), false, '口令不进 fill')
  const relay = settingsParsePair('cluster1://' + b64url({ v: 1, transportMode: 'relay', relayUrl: 'ws://r:8890/relay' }))
  assert.equal(relay.ok, true)
  assert.equal(relay.fill.transportMode, 'relay')
  assert.equal(relay.hasToken, false)
  assert.equal(settingsParsePair('"' + code + '"').ok, true)
  assert.match(settingsParsePair('').error, /为空/)
  assert.match(settingsParsePair('http://x').error, /dshra1/)
  assert.match(settingsParsePair('dshbot1://a#b').error, /暂不支持/)
  assert.match(settingsParsePair('dshra1://@@@').error, /不完整/)
  assert.match(settingsParsePair('dshra1://' + Buffer.from('not json').toString('base64url')).error, /解析不了/)
  assert.match(settingsParsePair('dshra1://' + b64url({ v: 1 })).error, /没有地址/)
})

test('worker status facts, counters and error normalisation', () => {
  const s = {
    nodeId: 'w1', online: true, transportMode: 'relay', url: 'ws://r/…', runner: 'agent', agentMode: true, roots: ['/a', '/b'], caps: ['fs', 'exec'],
    tasks: { total: 5, running: 1, queued: 2, active: 3 }, dshVersion: '0.4.36', stateDir: '/s', updatedAt: 0,
  }
  const rows = Object.fromEntries(settingsWorkerFacts(s))
  assert.equal(rows['连接'], '在线 · 中继')
  assert.equal(rows['执行后端'], 'agent（agent 模式）')
  assert.equal(rows['工作区'], '/a\n/b')
  assert.equal(rows['能力'], 'fs · exec')
  assert.equal(rows['任务'], '总数 5 · 运行 1 · 排队 2 · 活动 3')
  assert.equal(rows['工作目录'], '/s')
  const empty = Object.fromEntries(settingsWorkerFacts(null))
  assert.equal(empty['节点 ID'], '—')
  assert.equal(empty['连接'], '离线 · 未知')
  assert.equal(settingsTransportLabel('direct'), '直连')
  assert.equal(settingsTaskLine(undefined), '总数 0 · 运行 0 · 排队 0 · 活动 0')
  assert.equal(settingsWorkerError({}), null)
  assert.deepEqual(settingsWorkerError({ lastError: 'ECONNREFUSED', lastErrorDetail: { title: '连不上主机', detail: '端口没人听', hint: '检查主机', raw: 'connect ECONNREFUSED', code: 'ECONNREFUSED', at: 5 } }),
    { text: 'ECONNREFUSED', title: '连不上主机', detail: '端口没人听', hint: '检查主机', raw: 'connect ECONNREFUSED', code: 'ECONNREFUSED', at: 5 })
  assert.equal(settingsWorkerError({ lastError: 'boom', lastErrorDetail: '旧版详情' }).detail, '旧版详情')
  assert.equal(settingsWorkerError({ lastError: 'boom' }).text, 'boom')
})

test('env check summary, items, fix preview/confirm/result', () => {
  assert.deepEqual(settingsEnvSummary(null, ''), { tone: '', text: '尚未体检', failed: 0 })
  assert.equal(settingsEnvSummary(null, 'HTTP 500').text, '体检失败')
  const data = { ok: false, failed: 2, items: [{ id: 'a', label: 'A', ok: true, detail: 'fine' }, { id: 'b', label: 'B', ok: false, detail: 'd', fix: 'do x', autoFix: true, severity: 'error' }, { id: 'c', label: 'C', ok: false, severity: 'warn' }] }
  assert.deepEqual(settingsEnvSummary(data, ''), { tone: 'bad', text: '2 项需要处理', failed: 2 })
  assert.deepEqual(settingsEnvSummary({ items: [{ ok: true }] }, ''), { tone: 'ok', text: '全部通过', failed: 0 })
  assert.deepEqual(settingsEnvItems(data).map((i) => [i.id, i.tone, i.state, i.autoFix]), [['a', 'ok', '通过', false], ['b', 'bad', '未通过', true], ['c', 'warn', '注意', false]])
  const pv = settingsFixPreview({ ok: true, plan: { fixable: [{ id: 'role', label: 'role', change: '补上 role', note: 'n' }], skipped: [{ id: 'port', label: '端口', reason: '需人判断' }], host: '10.0.0.5', file: '/p/f.yml', backups: [{ name: 'b1', at: 1 }] } })
  assert.equal(pv.ok, true)
  assert.equal(pv.fixable[0].change, '补上 role')
  assert.equal(pv.skipped[0].reason, '需人判断')
  assert.match(settingsFixConfirm(pv), /\/p\/f\.yml[\s\S]*补上 role[\s\S]*重启 DSH/)
  assert.deepEqual(settingsFixPreview({ ok: false, error: 'boom' }).error, 'boom')
  assert.equal(settingsFixPreview(null).ok, false)
  assert.deepEqual(settingsFixResult({ ok: true, applied: ['role'], backup: '/b' }), { tone: 'ok', text: '已应用修复（role），重启 DSH 生效。备份：/b' })
  assert.deepEqual(settingsFixResult({ ok: false, error: '没有可自动修的项' }), { tone: 'err', text: '修复失败：没有可自动修的项' })
  assert.equal(settingsErrText({ body: { message: 'm' }, message: 'x' }), 'm')
})

test('link backlog: summary and per-node rows', () => {
  assert.equal(settingsLinkSummary(undefined).available, false)
  assert.equal(settingsLinkSummary({ available: true, total: 0, nodes: [] }).text, '没有等待送达的消息')
  const link = {
    available: true, total: 5,
    nodes: [
      { nodeId: 'n2', pending: 1, oldestMs: 5000, maxTries: 0, types: { 'work/a': 1 }, online: true },
      { nodeId: 'n1', pending: 4, oldestMs: 125000, maxTries: 3, types: { 'work/x': 1, 'team/y': 3 }, online: false },
    ],
  }
  assert.equal(settingsLinkSummary(link).text, '5 条消息等待送达（2 台）')
  const rows = settingsLinkRows(link, [{ nodeId: 'n1', hostname: 'box' }])
  assert.deepEqual(rows.map((r) => r.nodeId), ['n1', 'n2'], '积压多的排前')
  assert.equal(rows[0].name, 'box')
  assert.equal(rows[0].oldestText, '2m5s')
  assert.deepEqual(rows[0].types, [{ type: 'team/y', count: 3 }, { type: 'work/x', count: 1 }])
  assert.equal(rows[1].name, '')
  assert.equal(settingsLinkRows({ nodes: [{ nodeId: 'z', pending: 1, oldestMs: null }] })[0].oldestText, '—')
})

test('listener and reachability states', () => {
  assert.deepEqual(settingsListenerView(null), { listener: null, reach: null })
  assert.deepEqual(settingsListenerView({ pull: true }), { listener: null, reach: null })
  const on = settingsListenerView({ listener: { ok: true, host: '10.0.0.5', port: 19387, source: 'config', disabled: '' }, reachability: { loopback: false, bound: '10.0.0.5', origin: 'ws://10.0.0.5', port: 19387, via: 'listener', hint: '' } })
  assert.equal(on.listener.tone, 'ok')
  assert.match(on.listener.detail, /10\.0\.0\.5:19387/)
  assert.equal(on.reach.tone, 'ok')
  assert.match(on.reach.where, /19387/)
  assert.equal(settingsListenerView({ listener: { ok: false, disabled: 'listenPort=0' } }).listener.label, '独立监听已关闭')
  assert.equal(settingsListenerView({ listener: { ok: false, error: 'EADDRINUSE' } }).listener.tone, 'bad')
  const wait = settingsListenerView({ listener: { ok: false, state: 'waiting-port', waitingSince: 1000 } }, 66000).listener
  assert.equal(wait.label, '等待端口释放')
  assert.match(wait.detail, /1m5s/)
  assert.equal(settingsListenerView({ listener: { ok: null } }).listener.label, '独立监听尚未就绪')
  const loop = settingsListenerView({ reachability: { loopback: true, bound: '127.0.0.1', hint: '改 listenHost' } }).reach
  assert.equal(loop.tone, 'bad')
  assert.equal(loop.detail, '改 listenHost')
})

test('focus ring helper wraps both ways', () => {
  assert.equal(settingsNextFocus(0, 3, false), 1)
  assert.equal(settingsNextFocus(2, 3, false), 0)
  assert.equal(settingsNextFocus(0, 3, true), 2)
  assert.equal(settingsNextFocus(-1, 3, true), 2)
  assert.equal(settingsNextFocus(-1, 3, false), 0)
  assert.equal(settingsNextFocus(0, 0, false), -1)
})

/* ── 组件 ── */

test('module contract: css array and the three components', () => {
  const s = mount()
  assert.deepEqual(Object.keys(s).sort(), ['Drawer', 'Setup', 'WorkerView', 'css'])
  assert.ok(Array.isArray(s.css) && s.css.length > 0 && s.css.every((c) => typeof c === 'string'))
  // 命名空间：每条规则的每个选择器都带 st- 类；@keyframes 名带 st- 前缀（要么是自己的，要么显式复用 base 的 dra- 关键帧而不重定义）
  for (const c of s.css) {
    if (/^@keyframes /.test(c)) { assert.match(c, /^@keyframes st-/, '关键帧要带模块前缀：' + c.slice(0, 40)); continue }
    const inner = /^@(media|supports)[^{]*\{([\s\S]*)\}$/.exec(c)
    const rules = (inner ? inner[2] : c).match(/[^{}]+\{[^{}]*\}/g) || []
    assert.ok(rules.length > 0, '解析不出规则：' + c.slice(0, 40))
    for (const r of rules) for (const sel of r.slice(0, r.indexOf('{')).split(',')) assert.match(sel, /\.st-/, '选择器必须带 st- 类：' + sel.trim())
  }
  const all = s.css.join('')
  assert.ok(!all.includes('#'), '只用 token 变量，没有硬编码颜色')
  assert.ok(!/rgba?\(/.test(all), '半透明用 color-mix，不写 rgba 常量')
  assert.ok(!/!important/.test(all), '不用 !important 去覆盖减少动效的全局规则')
  assert.ok(!/:hover[^{]*\{[^}]*translate/.test(all), '悬停不位移')
  assert.ok(!/@media[^{]*width/.test(all), '不用视口宽度断点')
})

test('Setup first run: role step has no cancel, next is disabled until a role is picked', () => {
  const s = mount()
  const el = s.Setup({ switching: false, setup: { configured: false, current: {} }, ui: ui(), onDone: noop, onCancel: noop })
  const text = textOf(el)
  assert.match(text, /首次配置/)
  assert.match(text, /我是主机（Hub）/)
  assert.match(text, /我是副机（Worker）/)
  assert.match(text, /同机自测（both）/)
  assert.match(text, /步骤 1：选角色/)
  assert.equal(findButtons(el, '取消').length, 0)
  const radios = findAll(expand(el), (n) => n.type === 'input' && n.props.type === 'radio')
  assert.equal(radios.length, 3)
  assert.equal(radios.some((r) => r.props.checked), false)
  assert.equal(findButtons(el, '下一步')[0].props.disabled, true)
  const step = findAll(expand(el), (n) => n.props && n.props['aria-current'] === 'step')
  assert.equal(step.length, 1)
})

test('Setup switching: current role preselected and flagged, cancel calls onCancel', () => {
  let cancelled = 0
  const s = mount()
  const el = s.Setup({ switching: true, setup: hubSetup, ui: ui(), onDone: noop, onCancel: () => { cancelled += 1 } })
  const text = textOf(el)
  assert.match(text, /切换角色 \/ 重新配置/)
  assert.match(text, /当前：主机/)
  assert.match(text, /当前角色/)
  const radios = findAll(expand(el), (n) => n.type === 'input' && n.props.type === 'radio')
  assert.deepEqual(radios.map((r) => r.props.checked), [true, false, false])
  assert.equal(findButtons(el, '下一步')[0].props.disabled, false)
  findButtons(el, '取消')[0].props.onClick()
  assert.equal(cancelled, 1)
})

test('Setup connect step (worker): pair box, relay fields, required marks, inline errors only after trying', () => {
  const s = mount({ setup: { step: 'connect', role: 'worker' } })
  const quiet = s.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })
  const text = textOf(quiet)
  assert.match(text, /配对码/)
  assert.match(text, /中继地址（relayUrl） · 必填/)
  assert.match(text, /接入口令（enrollToken）/)
  assert.match(text, /工作区 roots/)
  assert.doesNotMatch(text, /✕/)
  const withControl = findByClass(quiet, 'dra-field').filter((f) => findAll(f, (n) => n.type === 'input' || n.type === 'textarea').length > 0)
  assert.ok(withControl.length >= 6)
  assert.ok(withControl.every((l) => l.type === 'label'), '每个输入框都包在真 <label> 里')
  const pwd = findAll(expand(quiet), (n) => n.type === 'input' && n.props.type === 'password')
  assert.equal(pwd.length, 1)
  assert.equal(pwd[0].props.value, '')

  const s2 = mount({ setup: { step: 'connect', role: 'worker', showErrors: true } })
  const loud = s2.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })
  assert.match(textOf(loud), /✕ 中继模式必须填中继地址/)
  assert.match(textOf(loud), /有 1 处需要先改好/)
  assert.equal(findAll(expand(loud), (n) => n.props && n.props['aria-invalid'] === 'true').length, 1)
})

test('Setup connect step (worker, direct) asks for the hub address and explains the token', () => {
  const s = mount({ setup: { step: 'connect', role: 'worker', form: Object.assign(settingsEmptyForm(), { transportMode: 'direct' }), showErrors: true } })
  const text = textOf(s.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop }))
  assert.match(text, /主机地址（hubUrl） · 必填/)
  assert.match(text, /✕ 直连模式必须填主机地址/)
  assert.match(text, /pair 字段/)
  assert.doesNotMatch(text, /接入口令/)
})

test('Setup connect step (hub): no pair box, roots live under the advanced fold', () => {
  const s = mount({ setup: { step: 'connect', role: 'hub' } })
  const el = s.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })
  const text = textOf(el)
  assert.doesNotMatch(text, /解析填入/)
  assert.match(text, /中继口令（hubToken）/)
  assert.match(text, /本机对外地址（hubUrl）/)
  const fold = findByClass(el, 'dra-fold')[0]
  assert.match(texts(fold).join(''), /工作区 roots/)
})

test('Setup review: summary hides the token, shows the target file, conflict offers replacement through a confirm', async () => {
  const form = Object.assign(settingsEmptyForm(), { relayUrl: 'ws://10.0.0.5:8890/relay', token: 'en_topsecret', roots: '/data/work' })
  const confirms = []
  const u = Object.assign(ui(), { confirm: async (m) => { confirms.push(m); return false } })
  const s = mount({ setup: { step: 'review', role: 'worker', form, error: { text: '检测到手写的 remote-agent 条目', code: 'handwritten-conflict' }, conflict: '检测到手写的 remote-agent 条目' } })
  const el = s.Setup({ switching: false, setup: hubSetup, ui: u, onDone: noop, onCancel: noop })
  const text = textOf(el)
  assert.doesNotMatch(text, /en_topsecret/)
  assert.match(text, /已填写（写入后不再显示）/)
  assert.match(text, /\/p\/cordis\.patch\.yml/)
  assert.match(text, /重启 DSH 后生效/)
  assert.match(text, /检测到手写的 remote-agent 条目/)
  assert.match(text, /错误码：handwritten-conflict/)
  await findButtons(el, '替换手写配置')[0].props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.equal(confirms.length, 1)
  assert.match(confirms[0], /手写/)
})

test('Setup review submit posts the wizard payload to /setup/apply', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, role: 'hub' }) } }
  try {
    const form = Object.assign(settingsEmptyForm(), { relayUrl: 'ws://10.0.0.5:8890/relay', token: 'rt_1', listenPort: '19387' })
    const s = mount({ setup: { step: 'review', role: 'hub', form } })
    const el = s.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })
    findButtons(el, '写入配置')[0].props.onClick()
    await new Promise((r) => setImmediate(r))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, settingsApplyPath)
    assert.deepEqual(calls[0].body, { role: 'hub', transportMode: 'relay', relayUrl: 'ws://10.0.0.5:8890/relay', hubToken: 'rt_1', listenHost: '', listenPort: '19387' })
  } finally {
    globalThis.fetch = realFetch
  }
})

test('Setup review refuses to post an invalid form', async () => {
  let posted = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { posted += 1; return { ok: true, status: 200, json: async () => ({}) } }
  try {
    const s = mount({ setup: { step: 'review', role: 'worker', form: settingsEmptyForm() } })
    findButtons(s.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop }), '写入配置')[0].props.onClick()
    await new Promise((r) => setImmediate(r))
    assert.equal(posted, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('Setup done: restart notice, written files, warnings, and onDone gets what was written', () => {
  const written = { ok: true, role: 'worker', file: '/p/cordis.patch.yml', backup: '/p/cordis.patch.yml.bak-1', instanceFile: '/s/instance.json', warnings: ['已自动创建目录：/data/work'] }
  let got = null
  const s = mount({ setup: { step: 'done', role: 'worker', written } })
  const el = s.Setup({ switching: false, setup: null, ui: ui(), onDone: (w) => { got = w }, onCancel: noop })
  const text = textOf(el)
  assert.match(text, /写入完成/)
  assert.match(text, /重启 DSH 生效/)
  assert.match(text, /\/p\/cordis\.patch\.yml\.bak-1/)
  assert.match(text, /已自动创建目录：\/data\/work/)
  assert.match(text, /角色：副机/)
  findButtons(el, '知道了')[0].props.onClick()
  assert.equal(got.role, 'worker')
})

test('WorkerView online: counters, facts, switch role, no raw object text', () => {
  let switched = 0
  const status = {
    nodeId: 'w1', online: true, transportMode: 'direct', url: 'ws://10.0.0.5:19387/…', runner: 'agent', agentMode: true, roots: ['/data/work'], caps: ['fs'],
    tasks: { total: 7, running: 1, queued: 2, active: 3 }, dshVersion: '0.4.36', stateDir: '/state', lastError: null, lastErrorDetail: null,
  }
  const s = mount()
  const el = s.WorkerView({ ui: ui(), worker: { loading: false, error: '', status }, onSwitchRole: () => { switched += 1 }, refresh: noop })
  const text = textOf(el)
  assert.match(text, /在线连接状态/)
  assert.match(text, /0\.4\.36DSH 版本/)
  assert.match(text, /在线 · 直连/)
  assert.match(text, /总数 7 · 运行 1 · 排队 2 · 活动 3/)
  assert.match(text, /\/data\/work/)
  assert.match(text, /\/state/)
  assert.match(text, /连接配置/)
  assert.doesNotMatch(text, /最近错误/)
  assert.doesNotMatch(text, /\[object Object\]/)
  findButtons(el, '切换角色')[0].props.onClick()
  assert.equal(switched, 1)
})

test('WorkerView offline with last error detail and a status read error shows the original text', () => {
  const status = {
    nodeId: 'w1', online: false, transportMode: 'relay', tasks: {},
    lastError: 'connect ECONNREFUSED 10.0.0.5:19387', lastErrorDetail: { title: '连不上主机', detail: '那个端口没人听', hint: '确认主机已启动', raw: 'connect ECONNREFUSED 10.0.0.5:19387', code: 'ECONNREFUSED', at: 1700000000000 },
  }
  let refreshed = 0
  const s = mount()
  const el = s.WorkerView({ ui: ui(), worker: { loading: false, error: 'HTTP 500 boom', status }, onSwitchRole: noop, refresh: () => { refreshed += 1 } })
  const text = textOf(el)
  assert.match(text, /读不到副机状态/)
  assert.match(text, /HTTP 500 boom/)
  assert.match(text, /离线连接状态/)
  assert.match(text, /连不上主机/)
  assert.match(text, /那个端口没人听/)
  assert.match(text, /下一步：确认主机已启动/)
  assert.match(text, /错误码 ECONNREFUSED/)
  assert.doesNotMatch(text, /\[object Object\]/)
  findButtons(el, '重试')[0].props.onClick()
  assert.equal(refreshed, 1)
})

test('WorkerView while loading: no stats yet, but the switch button and config are reachable', () => {
  const s = mount()
  const el = s.WorkerView({ ui: ui(), worker: { loading: true, error: '', status: null }, onSwitchRole: noop, refresh: noop })
  const text = textOf(el)
  assert.match(text, /读取副机状态/)
  assert.equal(findButtons(el, '切换角色').length, 1)
  assert.match(text, /连接配置/)
})

test('WorkerView config card: ready state shows token status as words, edits stay in the draft, save disabled until changed', () => {
  const cur = { role: 'worker', transportMode: 'relay', relayUrl: 'ws://10.0.0.5:8890/relay', hubUrl: '', tokenSet: true }
  const base = { current: cur, patchFile: '/p/cordis.patch.yml', persist: { instanceFile: true, instanceRole: 'worker' } }
  const s = mount({ editor: { phase: 'ready', base, form: settingsFormFromCurrent(cur) } })
  const el = s.WorkerView({ ui: ui(), worker: { loading: false, error: '', status: { online: true, tasks: {} } }, onSwitchRole: noop, refresh: noop })
  const text = textOf(el)
  assert.match(text, /接入口令：已设置/)
  assert.match(text, /没有未保存的修改/)
  assert.match(text, /\/p\/cordis\.patch\.yml/)
  const save = findButtons(el, '保存并写入')[0]
  assert.equal(save.props.disabled, true)
  const pwd = findAll(expand(el), (n) => n.type === 'input' && n.props.type === 'password')[0]
  assert.equal(pwd.props.value, '')
  assert.match(pwd.props.placeholder, /已设置/)

  const dirty = mount({ editor: { phase: 'ready', base, form: Object.assign(settingsFormFromCurrent(cur), { relayUrl: 'ws://10.0.0.9:8890/relay' }) } })
  const el2 = dirty.WorkerView({ ui: ui(), worker: { loading: false, error: '', status: { online: true, tasks: {} } }, onSwitchRole: noop, refresh: noop })
  assert.equal(findButtons(el2, '保存并写入')[0].props.disabled, false)
  assert.match(textOf(el2), /待保存的修改：中继地址/)
})

test('Config save sends only changed fields after a confirm, then reports the restart notice', async () => {
  const calls = []
  const notes = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, role: 'worker', file: '/p/f.yml' }) } }
  try {
    const cur = { role: 'worker', transportMode: 'relay', relayUrl: 'ws://10.0.0.5:8890/relay', tokenSet: false }
    const asked = []
    const u = Object.assign(ui(), { confirm: async (m) => { asked.push(m); return true }, notify: (t, tone) => notes.push([t, tone]) })
    const s = mount({ editor: { phase: 'ready', base: { current: cur, patchFile: '/p/f.yml' }, form: Object.assign(settingsFormFromCurrent(cur), { token: 'en_new' }) } })
    const el = s.WorkerView({ ui: u, worker: { loading: false, error: '', status: null }, onSwitchRole: noop, refresh: noop })
    findButtons(el, '保存并写入')[0].props.onClick()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.equal(asked.length, 1)
    assert.doesNotMatch(asked[0], /en_new/)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body, { role: 'worker', hubToken: 'en_new' })
    assert.deepEqual(notes, [['配置已写入，重启 DSH 生效', 'ok']])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('Drawer (hub): dialog semantics, sections, closing', () => {
  let closed = 0
  let switched = 0
  const hub = {
    loading: false, at: 1000000, nodes: [{ nodeId: 'n1', hostname: 'box' }], transportSummary: { mode: 'relay', label: '中继' },
    caps: { listener: { ok: true, host: '10.0.0.5', port: 19387, source: 'config', disabled: '' }, reachability: { loopback: false, bound: '10.0.0.5', hint: '', port: 19387 } },
    link: { available: true, total: 2, nodes: [{ nodeId: 'n1', pending: 2, oldestMs: 61000, maxTries: 1, types: { 'work/x': 2 }, online: false }] },
  }
  const s = mount({ editor: { phase: 'ready', base: { current: hubSetup.current, patchFile: '/p/f.yml' }, cfg: { relayTokenSet: true, nodeTokenSet: false, uiPullRoot: '/pull', uiEnabled: true, sessionGate: false, nodeId: 'hubA', roots: ['/r'], stateDir: '/s' }, form: settingsFormFromCurrent(hubSetup.current) }, env: { phase: 'done', data: { failed: 1, items: [{ id: 'listener', label: '独立监听', ok: false, detail: '绑在回环', fix: '生成口令', autoFix: true }, { id: 'role', label: '角色', ok: true }] } } })
  const el = s.Drawer({ role: 'hub', hub, worker: { loading: false, error: '', status: null }, ui: ui(), refresh: noop, plan: { hub: true, worker: false, both: false, view: 'hub' }, onClose: () => { closed += 1 }, onSwitchRole: () => { switched += 1 } })
  const tree = expand(el)
  assert.equal(tree.props.className, 'dra-drawer-wrap')
  const dlg = findAll(tree, (n) => n.props && n.props.role === 'dialog')[0]
  assert.equal(dlg.props['aria-modal'], 'true')
  assert.equal(dlg.props.className, 'dra-drawer')
  assert.equal(dlg.props['aria-labelledby'], 'st-drawer-title')
  assert.equal(dlg.props.tabIndex, -1)
  const text = textOf(el)
  assert.match(text, /角色/)
  assert.match(text, /连接配置/)
  assert.match(text, /环境体检/)
  assert.match(text, /1 项需要处理/)
  assert.match(text, /独立监听/)
  assert.match(text, /通道与审计/)
  assert.match(text, /没有超时/)
  assert.match(text, /box · n1/)
  assert.match(text, /待送达 2 条 · 最久等了 1m1s · 已重试 1 次/)
  assert.match(text, /work\/x ×2/)
  assert.match(text, /独立监听在听/)
  assert.match(text, /副机可以连进来/)
  assert.match(text, /在线节点上报的连接方式：中继/)
  assert.match(text, /中继口令：已设置/)
  assert.match(text, /入网口令（副机直连用）：未设置/)
  assert.match(text, /未设置入网口令：独立监听只能绑回环/)
  assert.match(text, /拉取落地目录 uiPullRoot/)
  // 点遮罩关闭，点抽屉内部不关
  tree.props.onClick({ target: 'x', currentTarget: 'y' })
  assert.equal(closed, 0)
  tree.props.onClick({ target: 'y', currentTarget: 'y' })
  assert.equal(closed, 1)
  findButtons(el, '关闭')[0].props.onClick()
  assert.equal(closed, 2)
  findButtons(el, '切换角色')[0].props.onClick()
  assert.equal(switched, 1)
  assert.ok(texts(tree).join('').includes('复制修法'))
})

test('Drawer (both) shows the local worker card; (worker) skips hub-only sections', () => {
  const worker = { loading: false, error: '', status: { nodeId: 'w1', online: true, transportMode: 'relay', tasks: { total: 1 } } }
  const s = mount({ editor: { phase: 'ready', base: { current: { role: 'both', transportMode: 'relay' } }, form: settingsEmptyForm() } })
  const both = textOf(s.Drawer({ role: 'both', hub: { loading: false, link: { available: false, total: 0, nodes: [] } }, worker, ui: ui(), refresh: noop, plan: { hub: true, worker: true, both: true, view: 'hub' }, onClose: noop, onSwitchRole: noop }))
  assert.match(both, /本机副机/)
  assert.match(both, /w1/)
  assert.match(both, /环境体检/)
  assert.match(both, /可靠通道未启用或暂时读不到/)
  const only = textOf(mount({ editor: { phase: 'ready', base: { current: { role: 'worker' } }, form: settingsEmptyForm() } }).Drawer({ role: 'worker', hub: undefined, worker, ui: ui(), refresh: noop, plan: { hub: false, worker: true, both: false, view: 'worker' }, onClose: noop, onSwitchRole: noop }))
  assert.match(only, /连接配置/)
  assert.doesNotMatch(only, /环境体检/)
  assert.doesNotMatch(only, /通道与审计/)
  assert.doesNotMatch(only, /本机副机/)
})

test('Drawer env card: not run yet, request failure keeps the original error, fix preview then confirm-gated apply', async () => {
  const hubProps = { loading: false, nodes: [], caps: null, link: { available: false, total: 0, nodes: [] } }
  const common = { role: 'hub', hub: hubProps, worker: { loading: false, error: '', status: null }, refresh: noop, plan: { hub: true, worker: false, both: false, view: 'hub' }, onClose: noop, onSwitchRole: noop }
  const editor = { phase: 'ready', base: { current: hubSetup.current }, form: settingsFormFromCurrent(hubSetup.current) }
  const idle = textOf(mount({ editor }).Drawer(Object.assign({ ui: ui() }, common)))
  assert.match(idle, /尚未体检/)
  const failed = textOf(mount({ editor, env: { phase: 'error', error: 'HTTP 502 bad gateway' } }).Drawer(Object.assign({ ui: ui() }, common)))
  assert.match(failed, /体检请求失败/)
  assert.match(failed, /HTTP 502 bad gateway/)

  const calls = []
  const asked = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, status404: false, json: async () => ({ ok: true, applied: ['role'] }) } }
  try {
    const preview = settingsFixPreview({ ok: true, plan: { fixable: [{ id: 'role', label: 'role', change: '补上 role', note: '' }], skipped: [], file: '/p/f.yml', backups: [] } })
    const u = Object.assign(ui(), { confirm: async (m) => { asked.push(m); return true } })
    const el = mount({ editor, env: { phase: 'done', data: { failed: 1, items: [{ id: 'role', label: '角色', ok: false }] }, preview } }).Drawer(Object.assign({ ui: u }, common))
    assert.match(textOf(el), /修复预览：将修改 \/p\/f\.yml/)
    const apply = findButtons(el, '应用修复')[0]
    assert.ok(apply, '有预览且有可修项才出现「应用修复」')
    apply.props.onClick()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.equal(asked.length, 1)
    assert.match(asked[0], /补上 role/)
    const fix = calls.find((c) => c.url.endsWith('/fix'))
    assert.deepEqual(fix.body, { action: 'apply', confirm: 'yes' })
    const noPlan = mount({ editor, env: { phase: 'done', data: { failed: 0, items: [] } } }).Drawer(Object.assign({ ui: ui() }, common))
    assert.equal(findButtons(noPlan, '应用修复').length, 0, '没预览不能直接应用')
  } finally {
    globalThis.fetch = realFetch
  }
})

/* ── 从旧版测试迁移来的行为 ── */

test('wizard: listen fields are trimmed, live in the advanced fold, and so does the node id', () => {
  const body = settingsApplyPayload('hub', Object.assign(settingsEmptyForm(), { listenHost: ' 10.0.0.5 ', listenPort: ' 19400 ', nodeId: ' hubA ' }))
  assert.equal(body.listenHost, '10.0.0.5')
  assert.equal(body.listenPort, '19400')
  assert.equal(body.nodeId, 'hubA')
  const s = mount({ setup: { step: 'connect', role: 'worker' } })
  const el = s.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })
  const fold = findByClass(el, 'dra-fold')[0]
  const foldText = texts(fold).join('')
  assert.match(foldText, /监听地址 listenHost/)
  assert.match(foldText, /监听端口 listenPort/)
  assert.match(foldText, /节点 ID（空 = 自动用本机主机名）/)
  const nodeInput = findAll(fold, (n) => n.type === 'input' && n.props.placeholder === '留空 = 自动用本机主机名')
  assert.equal(nodeInput.length, 1, '节点 ID 输入框折叠在「高级」里，默认不占首屏')
  assert.equal(nodeInput[0].props.value, '')
  assert.equal(findAll(expand(el), (n) => n.type === 'input' && n.props.placeholder === '19387').length, 1)
})

test('wizard: workspace gets a per-platform example (a concrete sub directory) instead of a prefilled value', () => {
  for (const platform of ['windows', 'mac', 'linux', '']) {
    const ex = settingsRootsExample(platform)
    assert.equal(settingsRootProblem(ex.replace('你的用户名', 'me')), '', platform + ' 的示例路径自己必须合法')
  }
  const s = mount({ setup: { step: 'connect', role: 'worker' } })
  const area = findAll(expand(s.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })), (n) => n.type === 'textarea')[0]
  assert.equal(area.props.value, '', '不预填 roots：它是安全边界，由用户自己决定')
  assert.match(area.props.placeholder, /work$/)
})

test('wizard switching: the form is seeded from the current configuration (but never the token)', () => {
  const s = mount({ setup: { step: 'connect', role: 'hub' } })
  const el = s.Setup({ switching: true, setup: hubSetup, ui: ui(), onDone: noop, onCancel: noop })
  const values = findAll(expand(el), (n) => n.type === 'input' || n.type === 'textarea').map((n) => n.props.value)
  assert.ok(values.includes('ws://10.0.0.5:8890/relay'), '回填当前 relayUrl')
  assert.ok(values.includes('19387'), '回填当前监听端口')
  assert.ok(values.includes('hubA'), '回填当前节点 ID')
  assert.ok(values.includes('/data/work'), '回填当前 roots')
  const pwd = findAll(expand(el), (n) => n.type === 'input' && n.props.type === 'password')[0]
  assert.equal(pwd.props.value, '')
  assert.match(pwd.props.placeholder, /已设置/)
})

test('wizard review: the failure notice and the conflict button sit above the write button, where the user is looking', () => {
  const form = Object.assign(settingsEmptyForm(), { relayUrl: 'ws://10.0.0.5:8890/relay' })
  const s = mount({ setup: { step: 'review', role: 'worker', form, error: { text: '检测到手写的 remote-agent 条目', code: 'handwritten-conflict' }, conflict: 'x' } })
  const tree = expand(s.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop }))
  const nodes = []
  const walkAll = (n) => { nodes.push(n); for (const k of n.kids || []) if (typeof k === 'object') walkAll(k) }
  walkAll(tree)
  const idx = (pred) => nodes.findIndex(pred)
  const banner = idx((n) => n.props && n.props.className === 'dra-banner err')
  const replace = idx((n) => n.type === 'button' && texts(n).join('') === '替换手写配置')
  const write = idx((n) => n.type === 'button' && texts(n).join('') === '写入配置')
  assert.ok(banner >= 0 && replace >= 0 && write >= 0)
  assert.ok(banner < write, '错误提示在写入按钮之前')
  assert.ok(replace < write, '「替换手写配置」在写入按钮之前')
  assert.equal(findButtons(expand(mount({ setup: { step: 'review', role: 'worker', form, error: { text: 'HTTP 500', code: '' } } }).Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })), '替换手写配置').length, 0, '不是冲突就不提供替换')
})

test('config card: a handwritten-config conflict offers a confirmed replacement that resends with force', async () => {
  const calls = []
  const asked = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true, role: 'worker' }) } }
  try {
    const cur = { role: 'worker', transportMode: 'relay', relayUrl: 'ws://10.0.0.5:8890/relay' }
    const u = Object.assign(ui(), { confirm: async (m) => { asked.push(m); return true } })
    const s = mount({ editor: { phase: 'ready', base: { current: cur }, form: Object.assign(settingsFormFromCurrent(cur), { relayUrl: 'ws://10.0.0.9:8890/relay' }), conflict: '检测到手写的 remote-agent 条目', msg: { tone: 'err', text: '写入失败：检测到手写的 remote-agent 条目' } } })
    const el = s.WorkerView({ ui: u, worker: { loading: false, error: '', status: null }, onSwitchRole: noop, refresh: noop })
    assert.match(textOf(el), /写入失败：检测到手写的 remote-agent 条目/)
    findButtons(el, '替换手写配置')[0].props.onClick()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.equal(asked.length, 1)
    assert.match(asked[0], /手写/)
    assert.deepEqual(calls, [{ role: 'worker', relayUrl: 'ws://10.0.0.9:8890/relay', force: true }])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('worker view shows every worker fact, a pointer to the hub for tasks, and none of the hub-only controls', () => {
  const status = {
    nodeId: 'w1', online: true, transportMode: 'relay', url: 'ws://r/…', runner: 'agent', roots: ['/data/work'], caps: ['fs'],
    tasks: { total: 1, running: 0, queued: 0, active: 0 }, dshVersion: '0.4.36', stateDir: '/state',
  }
  const el = mount().WorkerView({ ui: ui(), worker: { loading: false, error: '', status }, onSwitchRole: noop, refresh: noop })
  const labels = findAll(expand(el), (n) => n.type === 'dt').map((n) => texts(n).join(''))
  for (const l of ['节点 ID', '连接', '主机地址', '执行后端', '工作区', '能力', '任务', 'DSH 版本', '工作目录']) assert.ok(labels.includes(l), '应显示「' + l + '」')
  const text = textOf(el)
  assert.match(text, /任务在主机的面板上看/)
  for (const hubOnly of ['派发', '配对码', '拉取', '生成一次性接入口令', '一键修复']) assert.equal(text.includes(hubOnly), false, '副机视图不该出现「' + hubOnly + '」')
})

/* ── 带 effect 的挂载：抽屉打开时的读取、焦点与 Esc ── */

async function runDrawer(plan, over, run) {
  const effects = []
  const calls = []
  const realFetch = globalThis.fetch
  const realDoc = globalThis.document
  const listeners = {}
  const doc = { activeElement: { focus() { doc.restored = true } }, addEventListener(t, f) { listeners[t] = f }, removeEventListener(t) { delete listeners[t] }, restored: false }
  globalThis.fetch = async (url, init) => { calls.push(((init && init.method) || 'GET') + ' ' + url); return { ok: true, status: 200, json: async () => ({}) } }
  globalThis.document = doc
  try {
    const s = mount(over, effects)
    let closed = 0
    const asked = []
    const u = Object.assign(ui(), { confirm: (m) => new Promise((resolve) => asked.push({ m, resolve })) })
    const el = s.Drawer({ role: plan.both ? 'both' : plan.hub ? 'hub' : 'worker', hub: { loading: false, nodes: [], caps: null, link: { available: false, total: 0, nodes: [] } }, worker: { loading: false, error: '', status: null }, ui: u, refresh: noop, plan, onClose: () => { closed += 1 }, onSwitchRole: noop })
    const tree = expand(el)
    const dlg = findAll(tree, (n) => n.props && n.props.role === 'dialog')[0]
    const focusLog = []
    const focusables = ['a', 'b', 'c'].map((id) => ({ id, focus() { focusLog.push(id); doc.activeElement = this } }))
    dlg.props.ref.current = { focus() { focusLog.push('drawer') }, querySelectorAll: () => focusables }
    for (const fn of effects) { const cleanup = fn(); if (typeof cleanup === 'function') s.cleanups = (s.cleanups || []).concat(cleanup) }
    await new Promise((r) => setImmediate(r))
    await run({ calls, doc, listeners, focusLog, focusables, dlg, tree, effects, asked, closed: () => closed, cleanups: s.cleanups || [] })
  } finally {
    globalThis.fetch = realFetch
    if (realDoc === undefined) delete globalThis.document
    else globalThis.document = realDoc
  }
}

test('drawer opening: reads the setup state and config once, and auto-runs the environment check once (hub only)', async () => {
  const plan = { hub: true, worker: false, both: false, view: 'hub' }
  await runDrawer(plan, {}, async (c) => {
    assert.deepEqual(c.calls.filter((x) => x.endsWith('/env-check')), ['GET /api/ai-cluster/ui/env-check'], '自动体检恰好一次')
    assert.equal(c.calls.filter((x) => x.endsWith('/api/remote-agent/setup/state')).length, 1)
    assert.equal(c.calls.filter((x) => x.endsWith('/api/ai-cluster/ui/config')).length, 1)
    assert.ok(c.calls.every((x) => x.startsWith('GET ')), '打开抽屉只读不写')
  })
  await runDrawer({ hub: false, worker: true, both: false, view: 'worker' }, {}, async (c) => {
    assert.equal(c.calls.some((x) => x.includes('/env-check') || x.includes('/ui/config')), false, '副机没有主机路由，不去读')
    assert.equal(c.calls.filter((x) => x.endsWith('/api/remote-agent/setup/state')).length, 1)
  })
})

test('drawer focus: moves into the drawer, Tab wraps inside it, focus returns on close', async () => {
  await runDrawer({ hub: true, worker: false, both: false, view: 'hub' }, {}, async (c) => {
    assert.deepEqual(c.focusLog, ['drawer'], '打开后焦点进抽屉')
    const tab = (shiftKey, active) => {
      c.doc.activeElement = active
      let prevented = false
      c.dlg.props.onKeyDown({ key: 'Tab', shiftKey, preventDefault() { prevented = true } })
      return prevented
    }
    c.focusLog.length = 0
    assert.equal(tab(false, c.focusables[2]), true)
    assert.equal(tab(true, c.focusables[0]), true)
    assert.deepEqual(c.focusLog, ['a', 'c'], '末尾 Tab 回到开头，开头 Shift+Tab 到末尾')
    let prevented = false
    c.dlg.props.onKeyDown({ key: 'Enter', preventDefault() { prevented = true } })
    assert.equal(prevented, false)
    for (const cleanup of c.cleanups) cleanup()
    assert.equal(c.doc.restored, true, '关闭后焦点还给打开前的元素')
    assert.equal(c.listeners.keydown, undefined, '关闭后摘掉 Esc 监听')
  })
})

test('drawer Esc closes it, but not while a confirmation dialog is open', async () => {
  const preview = settingsFixPreview({ ok: true, plan: { fixable: [{ id: 'role', label: 'role', change: '补上 role', note: '' }], skipped: [], file: '/p/f.yml', backups: [] } })
  const over = { env: { phase: 'done', data: { failed: 1, items: [{ id: 'role', label: '角色', ok: false }] }, preview } }
  await runDrawer({ hub: true, worker: false, both: false, view: 'hub' }, over, async (c) => {
    c.listeners.keydown({ key: 'a' })
    assert.equal(c.closed(), 0)
    findButtons(c.tree, '应用修复')[0].props.onClick()
    assert.equal(c.asked.length, 1, '应用修复先弹确认框')
    c.listeners.keydown({ key: 'Escape' })
    assert.equal(c.closed(), 0, '确认框开着时 Esc 只关确认框')
    c.asked[0].resolve(false)
    await new Promise((r) => setImmediate(r))
    c.listeners.keydown({ key: 'Escape' })
    assert.equal(c.closed(), 1, '确认框关掉后 Esc 关抽屉')
  })
})

/* ── 视觉改版：结构与无障碍（动画本身是纯 CSS，这里只钉结构、字形与类名） ── */

const hasClass = (n, c) => typeof n.props?.className === 'string' && n.props.className.split(/\s+/).includes(c)

test('step bar: a pill track, the current step is lit and announced, finished steps carry a check glyph in text', () => {
  const s = mount({ setup: { step: 'connect', role: 'hub' } })
  const el = s.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })
  const track = findByClass(el, 'st-steps')[0]
  assert.equal(track.type, 'ol')
  assert.equal(track.props['aria-label'], '配置步骤')
  const steps = findByClass(el, 'st-step')
  assert.equal(steps.length, 3)
  assert.deepEqual(steps.map((n) => [hasClass(n, 'on'), hasClass(n, 'done'), n.props['aria-current']]), [[false, true, undefined], [true, false, 'step'], [false, false, undefined]])
  assert.equal(texts(steps[0]).join(''), '✓步骤 1：选角色', '走过的步骤：对勾 + 文字，不只靠颜色')
  assert.equal(texts(steps[1]).join(''), '2步骤 2：填连接信息')
  const done = mount({ setup: { step: 'done', role: 'hub', written: { role: 'hub' } } }).Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })
  assert.deepEqual(findByClass(done, 'st-step').map((n) => hasClass(n, 'done')), [true, true, true])
  assert.equal(findAll(expand(done), (n) => n.props && n.props['aria-current'] === 'step').length, 0)
})

test('role tiles: three big selectable tiles; the selected one has the ring class AND a check glyph, others have neither', () => {
  const s = mount({ setup: { step: 'role', role: 'worker' } })
  const el = s.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })
  const tiles = findByClass(el, 'st-role')
  assert.equal(tiles.length, 3)
  assert.ok(tiles.every((t) => t.type === 'label'), '整块可点，且是真 <label>')
  assert.deepEqual(tiles.map((t) => hasClass(t, 'on')), [false, true, false])
  assert.deepEqual(tiles.map((t) => findByClass(t, 'st-check').length), [0, 1, 0], '选中态有对勾字形')
  assert.equal(texts(findByClass(tiles[1], 'st-check')[0]).join(''), '✓')
  assert.ok(findByClass(tiles[1], 'st-check')[0].props.className.includes('dra-pop'), '对勾弹出')
  assert.deepEqual(tiles.map((t) => findAll(t, (n) => n.type === 'input')[0].props.checked), [false, true, false], '语义上仍是单选按钮')
  assert.equal(findByClass(el, 'st-role-glyph').length, 3)
  assert.ok(findByClass(el, 'st-role-glyph').every((g) => g.props['aria-hidden'] === 'true'))
})

test('connection fields are grouped into rounded sections, and the pair box is its own inset group', () => {
  const s = mount({ setup: { step: 'connect', role: 'worker' } })
  const el = s.Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })
  const groups = findByClass(el, 'st-group')
  assert.ok(groups.length >= 3, '配对盒 + 连接方式 + 地址/口令，各是一个分组')
  assert.ok(findByClass(el, 'st-pair').every((g) => hasClass(g, 'st-group')))
  assert.ok(groups.some((g) => /连接方式/.test(texts(g).join(''))))
  assert.ok(groups.some((g) => findAll(g, (n) => n.type === 'input' && n.props.type === 'password').length === 1))
})

test('review and worker facts are iOS-style grouped lists: label left (dt), value right (dd), one row per fact', () => {
  const form = Object.assign(settingsEmptyForm(), { relayUrl: 'ws://10.0.0.5:8890/relay', roots: '/a\n/b' })
  const rv = mount({ setup: { step: 'review', role: 'worker', form } }).Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })
  const list = findByClass(rv, 'st-list')[0]
  assert.equal(list.type, 'dl')
  assert.ok(hasClass(list, 'st-group'))
  const rows = findByClass(list, 'st-row')
  assert.equal(rows.length, settingsReviewRows('worker', form, {}).length)
  assert.ok(rows.every((r) => r.kids.length === 2 && r.kids[0].type === 'dt' && r.kids[1].type === 'dd'))
  assert.ok(hasClass(findByClass(rv, 'st-summary')[0], 'st-summary'), '确认页是抬高的玻璃摘要')
  const w = mount().WorkerView({ ui: ui(), worker: { loading: false, error: '', status: { nodeId: 'w1', online: true, tasks: { total: 7, running: 1, queued: 2 } } }, onSwitchRole: noop, refresh: noop })
  assert.equal(findByClass(w, 'st-counters').length, 1, '大号数字计数器')
  assert.ok(findByClass(w, 'st-counters')[0].props.className.includes('dra-statbar'))
  assert.ok(findByClass(w, 'st-sec').length >= 1)
})

test('done step: a one-time seal with a check, hidden from assistive tech (the heading and banner say it in words)', () => {
  const el = mount({ setup: { step: 'done', role: 'hub', written: { role: 'hub', file: '/p/f.yml' } } }).Setup({ switching: false, setup: null, ui: ui(), onDone: noop, onCancel: noop })
  const seal = findByClass(el, 'st-seal')[0]
  assert.equal(seal.props['aria-hidden'], 'true')
  assert.equal(texts(seal).join(''), '✓')
  assert.match(textOf(el), /配置已写入/)
  assert.match(textOf(el), /重启 DSH 生效/)
})

test('environment results: one list, each row has a glyph AND a word (never colour alone), rows animate in via CSS only', () => {
  const data = { failed: 2, items: [{ id: 'a', label: 'A', ok: true }, { id: 'b', label: 'B', ok: false, severity: 'error', fix: 'do x' }, { id: 'c', label: 'C', ok: false, severity: 'warn' }] }
  const el = mount({ env: { phase: 'done', data } }).Drawer({ role: 'hub', hub: { loading: false, nodes: [], caps: null, link: { available: false, total: 0, nodes: [] } }, worker: { loading: false, error: '', status: null }, ui: ui(), refresh: noop, plan: { hub: true, worker: false, both: false, view: 'hub' }, onClose: noop, onSwitchRole: noop })
  const list = findAll(expand(el), (n) => n.type === 'ul' && hasClass(n, 'st-stagger') && findByClass(n, 'st-state').length > 0)[0]
  assert.ok(list && hasClass(list, 'st-group'))
  const states = findByClass(list, 'st-state')
  assert.deepEqual(states.map((n) => texts(n).join('')), ['✓通过', '✕未通过', '▲注意'])
  assert.deepEqual(states.map((n) => findByClass(n, 'st-glyph')[0].props['aria-hidden']), ['true', 'true', 'true'], '字形是装饰，词本身可读')
  assert.ok(states.every((n) => findByClass(n, 'st-glyph')[0].props.className.includes('dra-pop')))
  assert.ok(findAll(list, (n) => n.props && n.props.style).length === 0, '错峰进入是纯 CSS（nth-child + animation-delay），不在 JS 里算延迟')
})

test('fix preview is a distinct inset panel that pops in; no preview, no panel', () => {
  const preview = settingsFixPreview({ ok: true, plan: { fixable: [{ id: 'role', label: 'role', change: '补上 role', note: '' }], skipped: [{ id: 'port', label: '端口', reason: '需人判断' }], file: '/p/f.yml', backups: [] } })
  const mk = (env) => mount({ env }).Drawer({ role: 'hub', hub: { loading: false, nodes: [], caps: null, link: { available: false, total: 0, nodes: [] } }, worker: { loading: false, error: '', status: null }, ui: ui(), refresh: noop, plan: { hub: true, worker: false, both: false, view: 'hub' }, onClose: noop, onSwitchRole: noop })
  const panel = findByClass(mk({ phase: 'done', data: { failed: 1, items: [] }, preview }), 'st-preview')[0]
  assert.ok(panel && panel.props.className.includes('dra-pop'))
  assert.match(texts(panel).join(''), /修复预览：将修改 \/p\/f\.yml/)
  assert.equal(findByClass(mk({ phase: 'done', data: { failed: 0, items: [] } }), 'st-preview').length, 0)
})

test('reliable-link backlog: one row per node with an amber parked dot (labelled), the wait time in words, and a count chip', () => {
  const link = { available: true, total: 3, nodes: [{ nodeId: 'n1', pending: 3, oldestMs: 61000, maxTries: 2, types: { 'work/x': 3 }, online: false }] }
  const el = mount({ editor: { phase: 'ready', base: { current: {} }, form: settingsEmptyForm() } }).Drawer({ role: 'hub', hub: { loading: false, nodes: [{ nodeId: 'n1', hostname: 'box' }], caps: null, link }, worker: { loading: false, error: '', status: null }, ui: ui(), refresh: noop, plan: { hub: true, worker: false, both: false, view: 'hub' }, onClose: noop, onSwitchRole: noop })
  const rows = findByClass(el, 'st-node')
  assert.equal(rows.length, 1)
  const dot = findByClass(rows[0], 'st-park')[0]
  assert.ok(hasClass(dot, 'dra-dot') && hasClass(dot, 'warn'))
  assert.equal(dot.props.role, 'img')
  assert.equal(dot.props['aria-label'], '消息在等对方就绪')
  assert.match(texts(rows[0]).join(''), /待送达 3 条 · 最久等了 1m1s · 已重试 2 次/)
  const chip = findByClass(rows[0], 'st-count')[0]
  assert.equal(texts(chip).join(''), '3')
  assert.equal(chip.props['aria-hidden'], 'true', '数字已经在文字里，芯片只是视觉强调')
})

test('drawer: header is the sticky glass title bar and every section is an inset-group section', () => {
  const el = mount({ editor: { phase: 'ready', base: { current: hubSetup.current }, form: settingsFormFromCurrent(hubSetup.current) } }).Drawer({ role: 'hub', hub: { loading: false, nodes: [], caps: null, link: { available: false, total: 0, nodes: [] } }, worker: { loading: false, error: '', status: null }, ui: ui(), refresh: noop, plan: { hub: true, worker: false, both: false, view: 'hub' }, onClose: noop, onSwitchRole: noop })
  assert.equal(findByClass(el, 'st-drawer-head')[0].type, 'header')
  const secs = findByClass(el, 'st-sec')
  assert.deepEqual(secs.map((n) => n.props['aria-label']), ['角色', '连接配置', '环境体检', '通道与审计'])
})
