/**
 * A2 统一外壳验收（BOOK-ui-redesign §4.1、§4.5、§4.7 #1 #2 #8 #9 #10 #11）。
 *
 * Panel 用有状态 React 桩真实渲染（useState/useRef/useEffect 按调用序号保存，effect 按依赖变化执行），
 * fetch 是记录型桩：不联网，只记录 方法 + URL + 请求体。
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../../lib/client.js'), 'utf8')
const SCREENS = ['computers', 'tasks', 'bots', 'models', 'memory']

/* ───────────── 有状态桩 ───────────── */
function reactStub() {
  const slots = []
  let idx = 0
  const pending = []
  const react = {
    createElement(type, props, ...kids) { return { type, props: props || {}, kids: kids.flat(Infinity) } },
    useState(v) {
      const i = idx++
      if (!(i in slots)) {
        const s = { value: typeof v === 'function' ? v() : v }
        s.set = (n) => { s.value = typeof n === 'function' ? n(s.value) : n }
        slots[i] = s
      }
      return [slots[i].value, slots[i].set]
    },
    useRef(v) { const i = idx++; if (!(i in slots)) slots[i] = { value: { current: v } }; return slots[i].value },
    useEffect(fn, deps) {
      const i = idx++
      const prev = slots[i]
      if (!prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]))) pending.push({ i, fn, deps })
      if (!prev) slots[i] = { deps: null, cleanup: null }
    },
    useMemo(fn) { return fn() },
  }
  return {
    react, slots,
    render(Panel) {
      idx = 0
      pending.length = 0
      const t = Panel()
      for (const p of pending.splice(0)) {
        const s = slots[p.i]
        if (typeof s.cleanup === 'function') s.cleanup()
        s.deps = p.deps || []
        try { s.cleanup = p.fn() } catch { s.cleanup = null }
      }
      return t
    },
  }
}

const OVERVIEW = {
  nodes: [{ nodeId: 'n1', name: 'n1', online: true }, { nodeId: 'n2', name: 'n2', online: false }],
  counts: { nodes: 2, online: 1 }, topology: null, connection: { everConnected: true },
}
function mount({ role = 'hub', bodies = {}, saved } = {}) {
  const calls = []
  const timers = []
  const base = {
    '/api/remote-agent/setup/state': role === 'setup' ? { configured: false } : { configured: true, effectiveRole: role },
    '/api/remote-agent/status': { nodeId: 'w1', online: true, tasks: { total: 0 } },
    '/api/ai-cluster/ui/overview': OVERVIEW,
    '/api/ai-cluster/ui/tasks': { tasks: [{ taskId: 't1', status: 'running', goal: 'g' }, { taskId: 't2', status: 'completed', goal: 'g2' }] },
    '/api/ai-cluster/ui/node-status': { nodes: [] },
    '/api/ai-cluster/ui/config': { config: {} },
    '/api/ai-cluster/ui/env-check': { failed: 0, items: [] },
    '/api/ai-cluster/ui/ssh-hosts': { hosts: [] },
    '/api/ai-cluster/ui/templates': { templates: [] },
    '/api/ai-cluster/ui/bots': { ok: true, total: 1, nodes: [{ nodeId: 'n1', hostname: 'n1', online: true, bots: [{ id: 'b1', name: 'b1' }] }] },
    '/api/ai-cluster/ui/models': { ok: true, nodes: [{ nodeId: 'n1', online: true, models: [{ id: 'm1' }] }, { nodeId: 'n2', online: false, models: null }] },
    '/api/bot': { ok: true, value: { team: { entries: 1 }, nodes: [], entries: [{ id: 'e1', text: 'x' }] } },
    ...bodies,
  }
  const st = reactStub()
  let Panel = null
  let plugin = null
  const sandbox = {
    window: { __ModuleLoader__: { load(mod) { plugin = mod.factory(() => st.react) } } },
    console,
    ...(saved ? { localStorage: { getItem: (k) => (k === 'dra-theme' ? saved : null), setItem() {} } } : {}),
    fetch(url, opts) {
      const u = String(url)
      const p = u.split('?')[0]
      calls.push(((opts && opts.method) || 'GET') + ' ' + u + (opts && opts.body ? ' ' + opts.body : ''))
      const body = p in base ? base[p] : {}
      return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
    },
    setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length },
    clearInterval() {},
    setTimeout(fn, ms) { return setTimeout(fn, Math.min(ms || 0, 5)) },
    clearTimeout,
  }
  vm.runInNewContext(src, sandbox, { filename: 'lib/client.js' })
  plugin.apply({ slots: { inject(_n, reg) { reg() }, register(slot, comp) { if (slot.name === 'main') Panel = comp } } })
  const settle = async () => {
    for (let k = 0; k < 6; k++) { st.render(Panel); await new Promise((r) => setTimeout(r, 15)) }
    return st.render(Panel)
  }
  return {
    plugin, st, calls, timers, settle,
    state: () => st.slots[0].value,
    setScreen(s) { st.slots[0].set((p) => Object.assign({}, p, { screen: s })) },
  }
}

const walk = (el, out = []) => {
  if (!el || typeof el !== 'object') return out
  out.push(el)
  for (const k of el.kids || []) walk(k, out)
  return out
}
const cls = (e) => String((e.props || {}).className || '').split(/\s+/)
const text = (el) => walk(el).flatMap((e) => e.kids || []).filter((k) => typeof k === 'string').join('|')
const fnName = (e) => (typeof e.type === 'function' ? e.type.name : '')
/** 找到 pred 命中的元素及其祖先链。 */
function pathTo(tree, pred, trail = []) {
  if (!tree || typeof tree !== 'object') return null
  const here = trail.concat([tree])
  if (pred(tree)) return here
  for (const k of tree.kids || []) { const r = pathTo(k, pred, here); if (r) return r }
  return null
}

/* ───────────── #1 ───────────── */
test('shell: 五屏 id 与默认不变', async () => {
  const m = mount()
  assert.deepEqual(Array.from(m.plugin.P2_SCREENS, (e) => e[0]), SCREENS)
  assert.deepEqual(Array.from(m.plugin.P2_SCREENS, (e) => e[1]), ['电脑', '交办', '机器人', '模型', '记忆'])
  assert.equal(m.plugin.selectHubScreen({}), 'computers')
  assert.equal(m.plugin.selectHubScreen({ screen: 'nope' }), 'computers')
  const tree = await m.settle()
  const tabs = walk(tree).filter((e) => e.props.role === 'tab')
  assert.deepEqual(tabs.map((t) => t.props.id), SCREENS.map((s) => 'tab-' + s), '标签顺序与 P2_SCREENS 一致')
})

/* ───────────── #2 ───────────── */
test('shell: tablist 语义', async () => {
  const m = mount()
  await m.settle()
  for (const s of SCREENS.concat(['nope'])) {
    m.setScreen(s)
    const tree = await m.settle()
    const want = m.plugin.selectHubScreen(m.state())
    const nav = walk(tree).find((e) => e.type === 'nav')
    assert.equal(nav.props['aria-label'], '主要屏幕')
    const lists = walk(nav).filter((e) => e.props.role === 'tablist')
    assert.equal(lists.length, 1)
    const tabs = walk(lists[0]).filter((e) => e.props.role === 'tab')
    assert.equal(tabs.length, 5)
    assert.ok(tabs.every((t) => t.type === 'button' && t.props.type === 'button'))
    const sel = tabs.filter((t) => t.props['aria-selected'] === 'true')
    assert.equal(sel.length, 1, '只有一个 aria-selected=true（' + s + '）')
    assert.ok(tabs.every((t) => t.props['aria-selected'] === 'true' || t.props['aria-selected'] === 'false'), 'aria-selected 必须显式 true/false')
    assert.equal(sel[0].props.id, 'tab-' + want, '与 selectHubScreen 一致')
    assert.ok(tabs.every((t) => t.props['aria-controls'] === 'panel-' + t.props.id.slice(4)))
    assert.deepEqual(tabs.map((t) => t.props.tabIndex), tabs.map((t) => (t === sel[0] ? 0 : -1)), 'roving tabindex')
    assert.ok(tabs.every((t) => !cls(t).includes('dra-btn-primary')), '选中态不再依赖无规则的 dra-btn-primary')
    const main = walk(tree).filter((e) => e.type === 'main')
    assert.equal(main.length, 1)
    assert.equal(main[0].props.id, 'panel-' + want)
    assert.equal(main[0].props.role, 'tabpanel')
    assert.equal(main[0].props['aria-labelledby'], 'tab-' + want)
  }
  // 键盘：左右方向键（循环）、Home/End
  m.setScreen('computers')
  let tree = await m.settle()
  const press = (key) => {
    const list = walk(tree).find((e) => e.props.role === 'tablist')
    let prevented = false
    list.props.onKeyDown({ key, preventDefault() { prevented = true } })
    return prevented
  }
  const seq = [['ArrowRight', 'tasks'], ['ArrowRight', 'bots'], ['End', 'memory'], ['ArrowRight', 'computers'], ['ArrowLeft', 'memory'], ['Home', 'computers']]
  for (const [key, want] of seq) {
    assert.equal(press(key), true, key + ' 应 preventDefault')
    tree = await m.settle()
    assert.equal(m.plugin.selectHubScreen(m.state()), want, key)
  }
  assert.equal(press('a'), false, '其他键不处理')
  assert.equal(m.plugin.selectHubScreen(m.state()), 'computers')
  // 点击标签
  walk(tree).find((e) => e.props.id === 'tab-models').props.onClick()
  await m.settle()
  assert.equal(m.state().screen, 'models')
  // 纯函数接缝
  const model = m.plugin.shellTabModel('bots', { nodes: 4, online: 3, active: 2, bots: 5, models: null, memory: 0 })
  assert.deepEqual(JSON.parse(JSON.stringify(model)), [
    { id: 'computers', label: '电脑', count: '3/4', selected: false, tabId: 'tab-computers', panelId: 'panel-computers' },
    { id: 'tasks', label: '交办', count: '2', selected: false, tabId: 'tab-tasks', panelId: 'panel-tasks' },
    { id: 'bots', label: '机器人', count: '5', selected: true, tabId: 'tab-bots', panelId: 'panel-bots' },
    { id: 'models', label: '模型', count: null, selected: false, tabId: 'tab-models', panelId: 'panel-models' },
    { id: 'memory', label: '记忆', count: '0', selected: false, tabId: 'tab-memory', panelId: 'panel-memory' },
  ])
  assert.equal(m.plugin.shellTabModel('nope', null).filter((t) => t.selected)[0].id, 'computers')
  assert.equal(m.plugin.shellTabKey('computers', 'ArrowLeft'), 'memory')
  assert.equal(m.plugin.shellTabKey('memory', 'ArrowRight'), 'computers')
  assert.equal(m.plugin.shellTabKey('bots', 'Enter'), null)
})

/* ───────────── 补充：外壳 DOM 结构与一句话摘要（§4.1 / §4.5） ───────────── */
test('shell: DOM 结构与一句话摘要', async () => {
  const m = mount()
  await m.settle()
  for (const s of SCREENS) {
    m.setScreen(s)
    const tree = await m.settle()
    assert.equal(fnName(tree), 'Root')
    const kids = tree.kids.filter((k) => k && typeof k === 'object')
    const order = kids.map((k) => fnName(k) || k.type)
    assert.deepEqual(order.filter((x) => ['Toolbar', 'nav', 'main', 'footer'].includes(x)), ['Toolbar', 'nav', 'main', 'footer'])
    assert.ok(kids.some((k) => cls(k).includes('dra-shell-status')), '状态区')
    const main = walk(tree).find((e) => e.type === 'main')
    const summary = walk(main).find((e) => e.type === 'section' && cls(e).includes('dra-screen-summary'))
    assert.ok(summary, '屏幕摘要')
    assert.ok(walk(main).some((e) => cls(e).includes('dra-screen-primary')))
    assert.ok(walk(main).some((e) => e.type === 'aside' && cls(e).includes('dra-screen-secondary')))
    assert.ok(walk(tree).some((e) => e.type === 'footer' && cls(e).includes('dra-shell-foot')))
    const head = Object.assign({}, kids.find((k) => fnName(k) === 'Toolbar'))
    const header = head.type(head.props)
    assert.equal(header.type, 'header')
    assert.ok(cls(header).includes('dra-shell-head'))
  }
  const sum = m.plugin.shellScreenSummary
  const counts = { nodes: 4, online: 3, active: 2, tasks: 9 }
  assert.equal(sum('computers', { counts }), '3/4 台在线 · 2 个任务运行中')
  assert.equal(sum('tasks', { counts }), '2 个任务进行中 · 共 9 个')
  assert.equal(sum('bots', { counts, bots: { kind: 'data', nodes: [{ bots: [1, 2] }, { bots: [3] }] } }), '2 台电脑 · 3 个机器人')
  assert.equal(sum('bots', { counts, bots: { kind: 'empty' } }), '还没有机器人上报')
  assert.equal(sum('bots', { counts, bots: { kind: 'error' } }), '机器人列表读取失败')
  assert.equal(sum('bots', { counts, bots: null }), '读取中…')
  assert.equal(sum('models', { counts, models: { kind: 'data', nodes: [{ models: [1, 2] }, { models: null }] } }), '2 台电脑 · 2 个模型')
  assert.equal(sum('models', { counts, models: { kind: 'error' } }), '模型列表读取失败')
  assert.equal(sum('memory', { counts, memory: { state: 'ok', data: { entries: [1, 2, 3] } } }), '当前范围 3 条记忆')
  assert.equal(sum('memory', { counts, memory: { state: 'missing' } }), '记忆接口不可用')
  assert.equal(sum('memory', { counts, memory: { state: 'error' } }), '记忆读取失败')
  assert.equal(sum('memory', { counts, memory: { state: 'loading' } }), '读取中…')
  assert.equal(sum('computers', {}), '0/0 台在线 · 0 个任务运行中')
  // 渲染出的摘要来自同一纯函数
  m.setScreen('computers')
  const tree = await m.settle()
  assert.ok(text(walk(tree).find((e) => cls(e).includes('dra-screen-summary'))).includes('1/2 台在线 · 1 个任务运行中'))
})

/* ───────────── #8 ───────────── */
/** 基线 a8e0bac 上用同一桩实测得到的请求集合（路径 + 方法 + 请求体）。 */
const BASE_MOUNT = [
  'GET /api/ai-cluster/ui/config', 'GET /api/ai-cluster/ui/env-check', 'GET /api/ai-cluster/ui/node-status',
  'GET /api/ai-cluster/ui/overview', 'GET /api/ai-cluster/ui/pair-info?port=', 'GET /api/ai-cluster/ui/ssh-hosts',
  'GET /api/ai-cluster/ui/tasks', 'GET /api/ai-cluster/ui/templates', 'GET /api/remote-agent/setup/state',
]
const BASE_SCREEN = {
  tasks: [], computers: [],
  bots: ['GET /api/ai-cluster/ui/bots'],
  models: ['GET /api/ai-cluster/ui/models'],
  memory: ['POST /api/bot {"endpoint":"memory-hub-scopes","payload":{}}', 'POST /api/bot {"endpoint":"memory-hub-view","payload":{"scope":{"kind":"team"}}}'],
}
const BASE_STATE_KEYS = ['caps', 'connection', 'counts', 'discovery', 'error', 'loading', 'mode', 'nodes', 'relay', 'role', 'setup', 'tasks', 'topology', 'transportSummary', 'worker']
/** 基线 a8e0bac 源码里每个 apiGet/apiPost/apiGetPath/apiPostPath/botApi/fetch 调用点所在行（去注释、去缩进、排序）的 sha256。 */
const BASE_CALLSITES = 54
const BASE_CALLSITE_DIGEST = '9f6455197300e0f26b3fd85a887fd6446b0f311d5ab2fa37ebf080419050ed11'
function callSites(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return code.split('\n').filter((l) => /\b(apiGet|apiPost|apiGetPath|apiPostPath|botApi|fetch)\(/.test(l) && !/function (apiGet|apiPost|apiGetPath|apiPostPath|botApi)\(/.test(l))
    .map((l) => l.trim()).sort()
}
test('screens: 读写契约不变', async () => {
  const m = mount()
  await m.settle()
  assert.deepEqual([...new Set(m.calls)].sort(), BASE_MOUNT, '挂载时的请求集合')
  assert.deepEqual(m.timers.map((t) => t.ms), [8000, 8000], '轮询间隔')
  assert.equal(m.plugin.POLL_MS, 8000)
  assert.deepEqual(Object.keys(m.state()).sort(), BASE_STATE_KEYS, 'setState 数据形状')
  for (const s of ['tasks', 'bots', 'models', 'memory', 'computers']) {
    const n = m.calls.length
    m.setScreen(s)
    await m.settle()
    assert.deepEqual([...new Set(m.calls.slice(n))].sort(), BASE_SCREEN[s], s + ' 屏请求集合')
  }
  assert.deepEqual(Object.keys(m.state()).sort(), BASE_STATE_KEYS.concat(['screen']).sort())
  // 轮询一拍：请求集合仍不新增
  const n = m.calls.length
  m.timers[0].fn()
  await m.settle()
  const polled = [...new Set(m.calls.slice(n).map((c) => c.split(' ').slice(0, 2).join(' ')))]
  assert.ok(polled.every((c) => BASE_MOUNT.includes(c) || BASE_SCREEN.computers.includes(c)), '轮询不新增请求：' + polled.join(', '))
  // 源码级：调用点逐行不变（路径与请求体）
  const sites = callSites(src)
  const digest = crypto.createHash('sha256').update(sites.join('\n')).digest('hex')
  assert.equal(sites.length, BASE_CALLSITES, '调用点行数')
  assert.equal(digest, BASE_CALLSITE_DIGEST, '调用点内容（路径/请求体）与基线一致：\n' + sites.join('\n'))
})

/* ───────────── #9 ───────────── */
test('screens: empty/error/data 三态与回退文案', () => {
  const m = mount()
  const P = m.plugin
  const t = (el) => text(el)
  assert.equal(t(P.rosterView(null)), '读取中…')
  assert.equal(t(P.rosterView(P.screenAvailability({ ok: true, total: 0, nodes: [] }, 200))), '还没有机器人上报')
  assert.match(t(P.rosterView(P.screenAvailability({ ok: false, code: 'boom' }, 200))), /^读机器人列表失败 boom$/)
  assert.match(t(P.rosterView(P.screenAvailability(null, 500))), /^读机器人列表失败 500$/)
  assert.match(t(P.rosterView(P.screenAvailability({ ok: true, total: 1, nodes: [{ nodeId: 'n1', online: true, bots: [{ id: 'b', name: 'b', role: 'r', model: 'm' }] }] }, 200))), /n1 · 在线\|b · r · m/)
  assert.equal(t(P.modelsView(null)), '读取中…')
  assert.equal(t(P.modelsView(P.modelsAvailability({ ok: true, nodes: [] }, 200))), '还没有电脑上报模型')
  assert.match(t(P.modelsView(P.modelsAvailability({ ok: false, reason: 'x' }, 200))), /^读模型列表失败 x$/)
  assert.match(t(P.modelsView(P.modelsAvailability(null, 503))), /^读模型列表失败 503$/)
  const mem = (scopes, view) => t(P.memoryScreenView({ scopes, view, options: [], scope: '', draft: '', topic: '', busy: false, note: '', onScope() {}, onDraft() {}, onTopic() {}, onAdd() {}, onForget() {} }))
  assert.match(mem({ state: 'missing' }, { state: 'loading' }), /记忆接口不可用（memory-api-missing）/)
  assert.match(mem({ state: 'ok' }, { state: 'loading' }), /读取中…/)
  assert.match(mem({ state: 'ok' }, { state: 'error', reason: 'r' }), /读记忆失败：r/)
  assert.match(mem({ state: 'ok' }, { state: 'ok', data: { entries: [] } }), /还没有记忆/)
  // 错误不是空
  assert.notEqual(P.screenAvailability({ ok: false, code: 'x' }, 200).kind, 'empty')
  assert.notEqual(P.modelsAvailability({ ok: false }, 200).kind, 'empty')
})

/* ───────────── #10 ───────────── */
test('role: worker/setup/both 视图仍渲染且含 Root', async () => {
  const w = mount({ role: 'worker' })
  const wt = await w.settle()
  assert.equal(fnName(wt), 'Root')
  assert.equal(w.state().mode, 'worker')
  assert.ok(!walk(wt).some((e) => e.props.role === 'tablist'), 'worker 不含屏幕标签')
  assert.ok(walk(wt).some((e) => fnName(e) === 'ConfigPanel' && e.props.mode === 'worker'))
  const rootOut = wt.type(wt.props)
  assert.ok(cls(rootOut).includes('dra-root'))
  assert.equal(rootOut.props['data-theme'], 'dark')

  const s = mount({ role: 'setup' })
  const sTree = await s.settle()
  assert.equal(fnName(sTree), 'Root')
  assert.ok(walk(sTree).some((e) => fnName(e) === 'SetupView'))
  assert.ok(!walk(sTree).some((e) => e.props.role === 'tablist'))

  const b = mount({ role: 'both' })
  const bTree = await b.settle()
  assert.equal(fnName(bTree), 'Root')
  assert.equal(walk(bTree).filter((e) => e.props.role === 'tab').length, 5)
  assert.ok(text(bTree).includes('副机'))

  const workerStart = src.indexOf('/* ── Worker 视图（副机）')
  const hubStart = src.indexOf('/* ── Hub 视图（主机）')
  assert.ok(workerStart >= 0 && hubStart > workerStart)
  assert.doesNotMatch(src.slice(workerStart, hubStart), /P2_SCREENS|shellTabModel/)
  assert.ok(!cls(rootOut).includes('dra-light'))
  // Root：保存的浅色 → 保留 dra-light 类，新增 data-theme
  const lm = mount({ role: 'worker', saved: 'light' })
  const lt = await lm.settle()
  const light = lt.type(lt.props)
  assert.ok(cls(light).includes('dra-light'))
  assert.equal(light.props['data-theme'], 'light')
  const hm = mount({ saved: 'light' })
  const ht = await hm.settle()
  assert.equal(ht.type(ht.props).props['data-theme'], 'light')
  const tb = ht.kids.find((k) => fnName(k) === 'Toolbar')
  assert.equal(tb.props.theme, 'light', '工具栏显示的主题与 Root 一致')
})

/* ───────────── #11 ───────────── */
test('share: SharePanel 仍挂载且 props 不变', async () => {
  const m = mount()
  await m.settle()
  for (const s of SCREENS) {
    m.setScreen(s)
    const tree = await m.settle()
    const shares = walk(tree).filter((e) => fnName(e) === 'SharePanel')
    assert.equal(shares.length, 1, s + ' 屏挂一份 SharePanel')
    assert.deepEqual(Object.keys(shares[0].props), ['nodes'])
    assert.equal(shares[0].props.nodes, m.state().nodes, 'nodes 入参就是 state.nodes')
    const chain = pathTo(tree, (e) => fnName(e) === 'SharePanel')
    assert.ok(chain.some((e) => e.type === 'footer' && cls(e).includes('dra-shell-foot')), '位于 footer')
    const fold = chain.find((e) => fnName(e) === 'Fold')
    assert.ok(fold && fold.props.title === '工作区共享（SMB）', '仍在 Fold 里')
    assert.ok(!chain.some((e) => e.type === 'aside'), '不再在每屏右栏')
    // ConfigPanel 仍渲染一次，入参不变
    const cfg = walk(tree).filter((e) => fnName(e) === 'ConfigPanel')
    assert.equal(cfg.length, 1)
    assert.deepEqual(Object.keys(cfg[0].props).sort(), ['cfg', 'edit', 'mode', 'onEdit', 'transportSummary'])
    assert.equal(cfg[0].props.mode, 'hub')
  }
})
