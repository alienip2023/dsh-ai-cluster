import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { createCore } from '../../src/panel/core.js'
import { createData } from '../../src/panel/data.js'
import { createSettings } from '../../src/panel/settings.js'
import { createShell, shellRolePlan, shellScreenId, shellScreens, shellTabKey, shellTabs } from '../../src/panel/shell.js'
import { stylesBase } from '../../src/panel/styles.js'
import { buildClient } from '../../scripts/build-client.mjs'
import { makeReact } from './_fake.js'

const realSetTimeout = globalThis.setTimeout

/* ── 有状态 React 桩：useState/useRef/useEffect/useCallback 按调用序号保存，effect 按依赖变化执行 ── */
function statefulReact() {
  const slots = []
  let idx = 0
  const pending = []
  const same = (a, b) => a && b && a.length === b.length && a.every((d, k) => Object.is(d, b[k]))
  const R = {
    Fragment: 'fragment',
    createElement(type, props, ...kids) {
      return { type, props: props || {}, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false) }
    },
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
    useCallback(fn, deps) {
      const i = idx++
      if (!slots[i] || !same(deps, slots[i].deps)) slots[i] = { value: fn, deps }
      return slots[i].value
    },
    useMemo(fn, deps) {
      const i = idx++
      if (!slots[i] || !same(deps, slots[i].deps)) slots[i] = { value: fn(), deps }
      return slots[i].value
    },
    useEffect(fn, deps) {
      const i = idx++
      const prev = slots[i]
      if (!prev || !deps || !same(deps, prev.deps)) pending.push({ i, fn, deps })
      if (!prev) slots[i] = { deps: null, cleanup: null }
    },
  }
  return {
    R,
    flush() {
      for (const p of pending.splice(0)) {
        const s = slots[p.i]
        if (typeof s.cleanup === 'function') s.cleanup()
        s.deps = p.deps || []
        try { s.cleanup = p.fn() } catch { s.cleanup = null }
      }
    },
    begin() { idx = 0; pending.length = 0 },
  }
}

const OVERVIEW = {
  nodes: [{ nodeId: 'n1', online: true }, { nodeId: 'n2', online: false }],
  counts: { nodes: 2, online: 1 }, capabilities: null, connection: { everConnected: true }, topology: null,
}
const UI = '/api/ai-cluster/ui'
const HUB_REQUESTS = [
  'GET ' + UI + '/bot-audit', 'GET ' + UI + '/goals', 'GET ' + UI + '/link-status', 'GET ' + UI + '/node-status',
  'GET ' + UI + '/overview', 'GET ' + UI + '/tasks', 'GET ' + UI + '/tickets', 'GET /api/remote-agent/setup/state',
]
const WORKER_STATUS = { nodeId: 'w1', online: true, transportMode: 'relay', tasks: { total: 0 } }

/** 把整个 Panel 在桩里真跑一遍。role: hub | worker | both | setup；fail: { 路径: HTTP 状态 } 让该请求失败。 */
async function withPanel(opts, run) {
  const o = Object.assign({ role: 'hub', fail: {}, bodies: {}, saved: null }, opts)
  const calls = []
  const timers = []
  const stored = {}
  const sets = []
  if (o.saved) stored['dra-theme'] = o.saved
  const bodies = Object.assign({
    '/api/remote-agent/setup/state': o.role === 'setup' ? { configured: false } : { configured: true, effectiveRole: o.role },
    '/api/remote-agent/status': WORKER_STATUS,
    [UI + '/overview']: OVERVIEW,
    [UI + '/tasks']: { tasks: [{ taskId: 't1', status: 'running' }, { taskId: 't2', status: 'completed' }] },
    [UI + '/node-status']: { nodes: [] },
    [UI + '/tickets']: { tickets: [] },
    [UI + '/goals']: { goals: [] },
    [UI + '/bot-audit']: { entries: [] },
    [UI + '/link-status']: { ok: true, available: true, total: 0, nodes: [] },
  }, o.bodies)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const p = String(url).split('?')[0]
    calls.push(((init && init.method) || 'GET') + ' ' + p)
    if (p in o.fail) return { ok: false, status: o.fail[p], json: async () => ({ message: 'boom ' + o.fail[p] }) }
    return { ok: true, status: 200, json: async () => (p in bodies ? bodies[p] : {}) }
  }
  globalThis.localStorage = { getItem: (k) => (k in stored ? stored[k] : null), setItem(k, v) { stored[k] = v; sets.push([k, v]) } }
  const st = statefulReact()
  const core = createCore(st.R)
  const data = createData(core)
  const settings = createSettings(core)
  const Stub = () => null
  const shell = createShell(core, data, { fleet: { Overview: Stub, Machines: Stub }, team: { Screen: Stub }, tasks: { Screen: Stub }, settings }, '/*css*/.dra-root{--dra-accent:red}')
  const act = (fn) => {
    const real = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    globalThis.setTimeout = (f, ms) => { timers.push({ fn: f, ms }); return timers.length }
    globalThis.clearTimeout = () => {}
    try { return fn() } finally { globalThis.setTimeout = real; globalThis.clearTimeout = realClear }
  }
  const render = () => act(() => { st.begin(); const t = shell.Panel(); st.flush(); return t })
  const settle = async () => {
    for (let k = 0; k < 8; k++) { render(); await new Promise((r) => realSetTimeout(r, 5)) }
    return render()
  }
  try {
    await run({ shell, settings, core, calls, timers, sets, stored, act, render, settle, unique: () => [...new Set(calls)].sort() })
  } finally {
    globalThis.fetch = realFetch
    delete globalThis.localStorage
  }
}

const walk = (el, out = []) => {
  if (!el || typeof el !== 'object') return out
  out.push(el)
  for (const k of el.kids || []) walk(k, out)
  return out
}
const textOf = (el) => walk(el).flatMap((e) => e.kids || []).filter((k) => typeof k === 'string' || typeof k === 'number').join('|')
const cls = (e) => String((e.props || {}).className || '').split(/\s+/)
const button = (tree, label) => walk(tree).find((e) => e.type === 'button' && (e.kids || []).join('') === label)
const tablist = (tree) => walk(tree).find((e) => e.props && e.props.role === 'tablist')
const tabsOf = (tree) => walk(tablist(tree)).filter((e) => e.props && e.props.role === 'tab')

/* ── 纯函数接缝 ── */

test('shell screens: four tabs in order, unknown ids fall back to overview', () => {
  assert.deepEqual(shellScreens.map((s) => s[0]), ['overview', 'machines', 'team', 'tasks'])
  assert.equal(shellScreenId('nope'), 'overview')
  assert.equal(shellScreenId(undefined), 'overview')
  for (const [id] of shellScreens) assert.equal(shellScreenId(id), id)
})

test('tab model carries ids that match the tabpanel wiring, counts only when known', () => {
  const model = shellTabs('team', { nodes: 4, online: 3, active: 0 })
  assert.deepEqual(model.map((t) => [t.id, t.tabId, t.panelId, t.selected, t.count]), [
    ['overview', 'dra-tab-overview', 'dra-panel-overview', false, null],
    ['machines', 'dra-tab-machines', 'dra-panel-machines', false, '3/4'],
    ['team', 'dra-tab-team', 'dra-panel-team', true, null],
    ['tasks', 'dra-tab-tasks', 'dra-panel-tasks', false, 0],
  ])
  assert.equal(shellTabs('nope', null).filter((t) => t.selected)[0].id, 'overview')
  assert.deepEqual(shellTabs('overview', { nodes: 4 }).find((t) => t.id === 'machines').count, 4)
  assert.equal(shellTabKey('overview', 'End'), 'tasks')
  assert.equal(shellTabKey('tasks', 'Home'), 'overview')
  assert.equal(shellTabKey('tasks', 'Enter'), null)
})

test('role plan: a hub whose reads fail is still a hub; a worker never gets hub screens or data', () => {
  assert.deepEqual(shellRolePlan('hub'), { hub: true, worker: false, both: false, view: 'hub' })
  assert.deepEqual(shellRolePlan('worker'), { hub: false, worker: true, both: false, view: 'worker' })
  assert.deepEqual(shellRolePlan(' Both '), { hub: true, worker: true, both: true, view: 'hub' })
  assert.deepEqual(shellRolePlan('bogus'), { hub: false, worker: false, both: false, view: 'none' })
})

/* ── Panel 真渲染：读写契约 ── */

test('hub: mount reads exactly the hub set, screens and polling add nothing', async () => {
  await withPanel({ role: 'hub' }, async (m) => {
    await m.settle()
    assert.deepEqual(m.unique(), HUB_REQUESTS)
    assert.ok(!m.calls.some((c) => c.includes('/status')), '主机不读副机状态')
    assert.ok(m.timers.some((t) => t.ms === 8000), '空闲轮询 8s')
    for (const [id] of shellScreens) {
      const tree = m.render()
      m.act(() => tabsOf(tree).find((t) => t.props.id === 'dra-tab-' + id).props.onClick())
      await m.settle()
    }
    assert.deepEqual(m.unique(), HUB_REQUESTS, '切屏不新增请求')
    const before = m.calls.length
    m.act(() => m.timers[m.timers.length - 1].fn())
    await m.settle()
    const polled = [...new Set(m.calls.slice(before))]
    assert.ok(polled.length > 0, '轮询一拍会重读')
    assert.ok(polled.every((c) => HUB_REQUESTS.includes(c)), '轮询只读同一批：' + polled.join(', '))
  })
})

test('hub with active tasks polls every 3s; worker mount reads only the status path', async () => {
  await withPanel({ role: 'hub' }, async (m) => {
    await m.settle()
    assert.ok(m.timers.some((t) => t.ms === 3000), '有运行中任务时 3s 轮询')
  })
  await withPanel({ role: 'worker' }, async (m) => {
    await m.settle()
    assert.deepEqual(m.unique(), ['GET /api/remote-agent/setup/state', 'GET /api/remote-agent/status'])
  })
  await withPanel({ role: 'both' }, async (m) => {
    await m.settle()
    assert.deepEqual(m.unique(), HUB_REQUESTS.concat(['GET /api/remote-agent/status']).sort())
  })
  await withPanel({ role: 'setup' }, async (m) => {
    await m.settle()
    assert.deepEqual(m.unique(), ['GET /api/remote-agent/setup/state'], '未配置只读角色，不碰主机/副机端点')
  })
})

test('refresh button re-reads; turning auto refresh off stops scheduling polls', async () => {
  await withPanel({ role: 'worker' }, async (m) => {
    let tree = await m.settle()
    const n = m.calls.filter((c) => c.endsWith('/status')).length
    m.act(() => button(tree, '刷新').props.onClick())
    await m.settle()
    assert.equal(m.calls.filter((c) => c.endsWith('/status')).length, n + 1)
    const box = walk(tree).find((e) => e.type === 'input' && e.props.type === 'checkbox')
    assert.equal(box.props.checked, true)
    const scheduled = m.timers.length
    m.act(() => box.props.onChange({ target: { checked: false } }))
    tree = await m.settle()
    assert.equal(walk(tree).find((e) => e.type === 'input' && e.props.type === 'checkbox').props.checked, false)
    assert.equal(m.timers.length, scheduled, '关掉自动刷新后不再排下一次轮询')
  })
})

/* ── Panel 真渲染：标签页语义 ── */

test('hub shell: tablist semantics, roving tabindex, tabpanel wiring, keyboard', async () => {
  await withPanel({ role: 'hub' }, async (m) => {
    let tree = await m.settle()
    assert.equal(tree.type, m.shell.Root)
    assert.deepEqual(tree.kids.filter((k) => typeof k.type === 'string').map((k) => k.type).filter((t) => ['header', 'nav', 'div'].includes(t)), ['header', 'nav', 'div'])
    assert.ok(cls(tree.kids.filter((k) => k.type === 'div')[0]).includes('dra-screens'))
    const nav = walk(tree).find((e) => e.type === 'nav')
    assert.equal(nav.props['aria-label'], '主要屏幕')
    for (const [id] of shellScreens) {
      m.act(() => tabsOf(tree).find((t) => t.props.id === 'dra-tab-' + id).props.onClick())
      tree = await m.settle()
      const tabs = tabsOf(tree)
      assert.equal(tabs.length, 4)
      assert.ok(tabs.every((t) => t.type === 'button' && t.props.type === 'button'))
      const sel = tabs.filter((t) => t.props['aria-selected'] === 'true')
      assert.equal(sel.length, 1)
      assert.ok(tabs.every((t) => t.props['aria-selected'] === 'true' || t.props['aria-selected'] === 'false'), 'aria-selected 显式 true/false')
      assert.equal(sel[0].props.id, 'dra-tab-' + id)
      assert.ok(tabs.every((t) => t.props['aria-controls'] === 'dra-panel-' + t.props.id.slice('dra-tab-'.length)))
      assert.deepEqual(tabs.map((t) => t.props.tabIndex), tabs.map((t) => (t === sel[0] ? 0 : -1)), 'roving tabindex')
      const main = walk(tree).filter((e) => e.type === 'main')
      const mine = main.find((e) => e.props.id === 'dra-panel-' + id)
      assert.ok(mine, '当前屏的 tabpanel')
      assert.equal(mine.props.role, 'tabpanel')
      assert.equal(mine.props.hidden, false)
      assert.equal(mine.props['aria-labelledby'], 'dra-tab-' + id)
      assert.deepEqual(main.filter((e) => e.props.hidden === false).map((e) => e.props.id), ['dra-panel-' + id], '同一时刻只有一屏可见')
    }
    // 访问过的屏保持挂载（只隐藏），切标签不丢草稿；每屏都收到 active 标志
    const mains = walk(tree).filter((e) => e.type === 'main')
    assert.equal(mains.length, 4)
    assert.deepEqual(mains.map((e) => e.props.hidden), [true, true, true, false])
    const screenProps = mains.map((e) => e.kids[0].props)
    assert.deepEqual(screenProps.map((p) => p.active), [false, false, false, true])
    assert.deepEqual(Object.keys(screenProps[0]).sort(), ['active', 'go', 'hub', 'refresh', 'role', 'ui'])
    // 键盘：循环、Home/End，其它键不处理
    m.act(() => tabsOf(tree).find((t) => t.props.id === 'dra-tab-overview').props.onClick())
    tree = await m.settle()
    const press = (key) => {
      let prevented = false
      m.act(() => tablist(tree).props.onKeyDown({ key, preventDefault() { prevented = true } }))
      return prevented
    }
    const selected = () => tabsOf(tree).find((t) => t.props['aria-selected'] === 'true').props.id.slice('dra-tab-'.length)
    for (const [key, want] of [['ArrowRight', 'machines'], ['ArrowRight', 'team'], ['End', 'tasks'], ['ArrowRight', 'overview'], ['ArrowLeft', 'tasks'], ['Home', 'overview']]) {
      assert.equal(press(key), true, key + ' 应 preventDefault')
      tree = await m.settle()
      assert.equal(selected(), want, key)
    }
    assert.equal(press('a'), false, '其他键不处理')
    tree = await m.settle()
    assert.equal(selected(), 'overview')
  })
})

test('the tab count badges come from the hub snapshot', async () => {
  await withPanel({ role: 'hub' }, async (m) => {
    const tree = await m.settle()
    const tabs = tabsOf(tree)
    assert.match(textOf(tabs.find((t) => t.props.id === 'dra-tab-machines')), /1\/2/)
    assert.match(textOf(tabs.find((t) => t.props.id === 'dra-tab-tasks')), /1/)
  })
})

/* ── Panel 真渲染：按角色选视图 ── */

test('worker role: WorkerView with the exact props, no screen tabs', async () => {
  await withPanel({ role: 'worker' }, async (m) => {
    const tree = await m.settle()
    assert.equal(tablist(tree), undefined)
    const view = walk(tree).find((e) => e.type === m.settings.WorkerView)
    assert.ok(view, '副机视图')
    assert.deepEqual(Object.keys(view.props).sort(), ['onSwitchRole', 'refresh', 'ui', 'worker'])
    assert.deepEqual(view.props.worker, { loading: false, error: '', status: WORKER_STATUS })
    assert.equal(walk(tree).some((e) => e.type === m.settings.Setup), false)
    assert.ok(button(tree, '设置'), '副机也有设置入口')
  })
})

test('worker status read failure reaches the view with the original text, role stays worker', async () => {
  await withPanel({ role: 'worker', fail: { '/api/remote-agent/status': 500 } }, async (m) => {
    const tree = await m.settle()
    const view = walk(tree).find((e) => e.type === m.settings.WorkerView)
    assert.ok(view)
    assert.equal(view.props.worker.error, 'boom 500')
    assert.equal(view.props.worker.status, null)
    assert.equal(tablist(tree), undefined)
  })
})

test('hub overview failure: still the hub view with an error banner (original text, retry), never the worker view', async () => {
  await withPanel({ role: 'hub', fail: { [UI + '/overview']: 500 } }, async (m) => {
    const tree = await m.settle()
    assert.ok(tablist(tree), '仍是主机视图')
    assert.equal(walk(tree).some((e) => e.type === m.settings.WorkerView), false)
    const banner = walk(tree).find((e) => e.type === m.core.Banner && e.props.title === '连接异常')
    assert.ok(banner)
    assert.equal(banner.props.tone, 'err')
    assert.match(textOf(banner), /boom 500/)
    assert.ok(banner.props.actions.props.onClick)
  })
})

test('both role: hub screens and the drawer asks for the worker card', async () => {
  await withPanel({ role: 'both' }, async (m) => {
    let tree = await m.settle()
    assert.equal(tabsOf(tree).length, 4)
    assert.match(textOf(tree), /同机/)
    m.act(() => button(tree, '设置').props.onClick())
    tree = await m.settle()
    const drawer = walk(tree).find((e) => e.type === m.settings.Drawer)
    assert.equal(drawer.props.role, 'both')
    assert.deepEqual(drawer.props.plan, { hub: true, worker: true, both: true, view: 'hub' })
    assert.deepEqual(drawer.props.worker, { loading: false, error: '', status: WORKER_STATUS })
  })
})

test('unconfigured: setup wizard with the banner, no refresh/settings buttons, no screens', async () => {
  await withPanel({ role: 'setup' }, async (m) => {
    const tree = await m.settle()
    const setup = walk(tree).find((e) => e.type === m.settings.Setup)
    assert.ok(setup)
    assert.equal(setup.props.switching, false)
    assert.deepEqual(setup.props.setup, { configured: false })
    const banner = walk(tree).find((e) => e.type === m.core.Banner)
    assert.equal(banner.props.title, '本机还没有配置 AI 集群控制')
    assert.match(textOf(banner), /重启 DSH 生效/)
    assert.equal(tablist(tree), undefined)
    assert.equal(button(tree, '设置'), undefined)
    assert.equal(button(tree, '刷新'), undefined)
  })
})

test('boot read failure: error banner with the original text and a working retry', async () => {
  await withPanel({ role: 'hub', fail: { '/api/remote-agent/setup/state': 500 } }, async (m) => {
    const tree = await m.settle()
    const banner = walk(tree).find((e) => e.type === m.core.Banner && e.props.title === '读不到本机角色')
    assert.ok(banner)
    assert.match(textOf(banner), /boom 500/)
    assert.equal(button(tree, '设置'), undefined)
    const n = m.calls.filter((c) => c.endsWith('/setup/state')).length
    m.act(() => banner.props.actions.props.onClick())
    await m.settle()
    assert.equal(m.calls.filter((c) => c.endsWith('/setup/state')).length, n + 1)
  })
})

test('switching role: Setup in switching mode, cancel returns, a written role takes effect at once', async () => {
  await withPanel({ role: 'worker' }, async (m) => {
    let tree = await m.settle()
    m.act(() => walk(tree).find((e) => e.type === m.settings.WorkerView).props.onSwitchRole())
    tree = await m.settle()
    const setup = walk(tree).find((e) => e.type === m.settings.Setup)
    assert.equal(setup.props.switching, true)
    assert.equal(setup.props.setup.effectiveRole, 'worker')
    assert.equal(walk(tree).some((e) => e.type === m.settings.WorkerView), false)
    assert.equal(walk(tree).some((e) => e.type === m.core.Banner && /还没有配置/.test(e.props.title || '')), false, '换角色不是首次配置')
    m.act(() => setup.props.onCancel())
    tree = await m.settle()
    assert.ok(walk(tree).some((e) => e.type === m.settings.WorkerView), '取消回到副机视图')
    m.act(() => walk(tree).find((e) => e.type === m.settings.WorkerView).props.onSwitchRole())
    tree = await m.settle()
    // 服务端要重启才生效：写盘成功后面板立刻按新角色画，哪怕服务端还报旧角色
    m.act(() => walk(tree).find((e) => e.type === m.settings.Setup).props.onDone({ ok: true, role: 'hub' }))
    tree = await m.settle()
    assert.ok(tablist(tree), '立即切到主机视图')
    assert.equal(walk(tree).some((e) => e.type === m.settings.Setup), false)
  })
})

test('settings button opens the drawer with the exact props; close and switch-role callbacks work', async () => {
  await withPanel({ role: 'hub' }, async (m) => {
    let tree = await m.settle()
    const open = button(tree, '设置')
    assert.ok(open, '主机工具栏有「设置」')
    assert.equal(walk(tree).some((e) => e.type === m.settings.Drawer), false)
    m.act(() => open.props.onClick())
    tree = await m.settle()
    const drawer = walk(tree).find((e) => e.type === m.settings.Drawer)
    assert.ok(drawer)
    assert.deepEqual(Object.keys(drawer.props).filter((k) => k !== 'key').sort(), ['hub', 'onClose', 'onSwitchRole', 'plan', 'refresh', 'role', 'ui', 'worker'])
    assert.equal(drawer.props.role, 'hub')
    assert.deepEqual(drawer.props.plan, shellRolePlan('hub'))
    assert.equal(drawer.props.hub.counts.nodes, 2)
    assert.deepEqual(Object.keys(drawer.props.ui).sort(), ['alert', 'confirm', 'notify', 'prompt'])
    m.act(() => drawer.props.onClose())
    tree = await m.settle()
    assert.equal(walk(tree).some((e) => e.type === m.settings.Drawer), false)
    m.act(() => button(tree, '设置').props.onClick())
    tree = await m.settle()
    m.act(() => walk(tree).find((e) => e.type === m.settings.Drawer).props.onSwitchRole())
    tree = await m.settle()
    assert.equal(walk(tree).some((e) => e.type === m.settings.Drawer), false, '切换角色会先关抽屉')
    assert.equal(walk(tree).find((e) => e.type === m.settings.Setup).props.switching, true)
  })
})

test('ui.confirm / ui.prompt / ui.alert go through the shell dialog and resolve with the answer', async () => {
  await withPanel({ role: 'hub' }, async (m) => {
    let tree = await m.settle()
    m.act(() => button(tree, '设置').props.onClick())
    tree = await m.settle()
    const ui = walk(tree).find((e) => e.type === m.settings.Drawer).props.ui
    let answer
    const pending = ui.confirm('确定吗？').then((v) => { answer = v })
    tree = m.render()
    const dlg = walk(tree).find((e) => e.type === m.shell.Dialog)
    assert.equal(dlg.props.dialog.kind, 'confirm')
    assert.equal(dlg.props.dialog.msg, '确定吗？')
    m.act(() => dlg.props.onAnswer(true))
    await pending
    assert.equal(answer, true)
    assert.equal(walk(m.render()).find((e) => e.type === m.shell.Dialog).props.dialog, null)
    ui.notify('已写入', 'ok')
    const note = walk(m.render()).find((e) => e.type === m.core.Banner && e.props.tone === 'ok')
    assert.match(textOf(note), /已写入/)
  })
})

/* ── 主题与样式注入 ── */

test('Root: theme prop drives .dra-light and data-theme', () => {
  const { shell } = (() => {
    const core = createCore(makeReact())
    return { shell: createShell(core, createData(core), {}, '') }
  })()
  const dark = shell.Root({ theme: 'dark', children: null })
  assert.ok(cls(dark).includes('dra-root'))
  assert.ok(!cls(dark).includes('dra-light'))
  assert.equal(dark.props['data-theme'], 'dark')
  const light = shell.Root({ theme: 'light', children: null })
  assert.ok(cls(light).includes('dra-root') && cls(light).includes('dra-light'))
  assert.equal(light.props['data-theme'], 'light')
})

test('theme: saved choice is applied on start, the toggle flips it and persists to localStorage', async () => {
  await withPanel({ role: 'hub', saved: 'light' }, async (m) => {
    let tree = await m.settle()
    assert.equal(tree.props.theme, 'light')
    const toggle = walk(tree).find((e) => e.type === 'button' && e.props['aria-label'] === '切换明暗主题')
    assert.equal((toggle.kids || []).join(''), '深色', '浅色下按钮提示切到深色')
    m.act(() => toggle.props.onClick())
    tree = await m.settle()
    assert.equal(tree.props.theme, 'dark')
    assert.deepEqual(m.sets, [['dra-theme', 'dark']])
    m.act(() => walk(tree).find((e) => e.props['aria-label'] === '切换明暗主题').props.onClick())
    tree = await m.settle()
    assert.equal(tree.props.theme, 'light')
    assert.deepEqual(m.sets, [['dra-theme', 'dark'], ['dra-theme', 'light']])
  })
  await withPanel({ role: 'worker' }, async (m) => {
    const tree = await m.settle()
    assert.equal(tree.props.theme, 'dark', '没有任何偏好时默认深色')
  })
})

test('every top-level view mounts the stylesheet as a <style> element (loading, setup, error, hub, worker)', async () => {
  const css = '/*css*/.dra-root{--dra-accent:red}'
  const hasStyle = (tree) => {
    const s = walk(tree).find((e) => e.type === 'style')
    return s && (s.kids || []).join('') === css
  }
  await withPanel({ role: 'hub' }, async (m) => {
    assert.ok(hasStyle(m.render()), '读取角色时（loading）')
    assert.ok(hasStyle(await m.settle()), '主机')
  })
  await withPanel({ role: 'worker' }, async (m) => { assert.ok(hasStyle(await m.settle()), '副机') })
  await withPanel({ role: 'setup' }, async (m) => { assert.ok(hasStyle(await m.settle()), '未配置') })
  await withPanel({ role: 'hub', fail: { '/api/remote-agent/setup/state': 500 } }, async (m) => { assert.ok(hasStyle(await m.settle()), '读角色失败') })
  await withPanel({ role: 'worker' }, async (m) => {
    let tree = await m.settle()
    m.act(() => walk(tree).find((e) => e.type === m.settings.WorkerView).props.onSwitchRole())
    tree = await m.settle()
    assert.ok(hasStyle(tree), '换角色')
  })
})

test('the built client registers the sidebar icon and the panel, and the panel injects every module\'s css', () => {
  let plugin = null
  vm.runInNewContext(buildClient(), { console, window: { __ModuleLoader__: { load(m) { plugin = m.factory(() => makeReact()) } } } })
  const reg = []
  let Panel = null
  plugin.apply({ slots: { inject(_n, fn) { fn() }, register(meta, comp) { reg.push(meta.name + ':' + (meta.id || meta.key)); if (meta.name === 'main') Panel = comp; return () => {} } } })
  assert.deepEqual(reg, ['sidebar.panellist:dsh-ai-cluster', 'main:dsh-ai-cluster'])
  const tree = Panel()
  const style = walk(tree).find((e) => e.type === 'style')
  assert.ok(style, '面板自己带 <style>，不依赖宿主的 styles 服务')
  const css = (style.kids || []).join('')
  assert.ok(css.includes(stylesBase.join('').slice(0, 200)), '基础样式')
  assert.ok(css.includes('.st-steps'), '设置模块的样式也在里面')
  assert.match(css, /--dra-accent/)
  assert.match(css, /\.dra-root\{/)
})

/* ── CSS：token / 规则 / 无障碍审计（解析真实的 stylesBase + 设置模块 css） ── */

function splitTop(css) {
  const top = []
  const at = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const head = css.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++ }
    const body = css.slice(open + 1, j - 1)
    if (head.startsWith('@')) at.push({ head, body })
    else top.push({ selector: head, body })
    i = j
  }
  return { top, at }
}

const settingsCss = createSettings(createCore(makeReact())).css
const CSS = stylesBase.concat(settingsCss).join('')
const { top, at } = splitTop(CSS)
const allRules = top.concat(at.flatMap((a) => (a.head.startsWith('@keyframes') ? [] : splitTop(a.body).top)))
const ruleBody = (sel) => (top.find((r) => r.selector === sel) || {}).body || ''
const tokensOf = (sel) => {
  const out = {}
  for (const m of ruleBody(sel).matchAll(/(--dra-[a-z0-9-]+)\s*:\s*([^;]+)/g)) out[m[1]] = m[2].trim()
  return out
}
const hex = (v) => {
  const m = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(v || '')
  if (!m) return null
  return '#' + (m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]).toLowerCase()
}
const lum = (h) => {
  const c = [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const dark = tokensOf('.dra-root')
const light = tokensOf('.dra-root.dra-light')

test('css: every dra-/st- class used by core, shell and settings has a rule', async () => {
  const { readFileSync } = await import('node:fs')
  const used = new Set()
  for (const f of ['core', 'shell', 'settings']) {
    const src = readFileSync(new URL('../../src/panel/' + f + '.js', import.meta.url), 'utf8')
    for (const m of src.matchAll(/className:\s*([^\n]*)/g)) {
      const seg = m[1].split(/,\s*(?:[a-zA-Z'"][\w'"-]*\s*:|key\b)/)[0]
      for (const lit of seg.matchAll(/'([^']*)'/g)) for (const t of lit[1].matchAll(/(?:^|\s)((?:dra|st)-[a-z0-9-]+)/g)) used.add(t[1])
    }
  }
  assert.ok(used.has('dra-tab') && used.has('st-steps') && used.has('dra-btn'), '审计确实扫到了类名')
  const hasRule = (c) => allRules.some((r) => new RegExp('\\.' + c + '(?![a-z0-9-])').test(r.selector))
  const missing = [...used].filter((c) => !hasRule(c)).sort()
  assert.deepEqual(missing, [], '用到的类必须有 CSS 规则：' + missing.join(' '))
  const sel = allRules.find((r) => /\.dra-tab\[aria-selected="true"\]/.test(r.selector) && !/:hover|:focus/.test(r.selector))
  assert.ok(sel && /box-shadow:inset 0 -2px 0 var\(--dra-accent\)/.test(sel.body), '选中标签有 2px 底条，不只靠颜色')
})

test('css: no selector is defined twice (base + settings)', () => {
  // 按完整选择器头计数：`.a,.b{…}` 与单独的 `.b{…}` 是合法的分层写法，两条完全相同的规则头才算重复
  const count = {}
  for (const r of top) { const k = r.selector.split(',').map((x) => x.trim()).sort().join(','); count[k] = (count[k] || 0) + 1 }
  const dup = Object.keys(count).filter((s) => count[s] > 1)
  assert.deepEqual(dup, [], '顶层规则头不得重复：' + dup.join(' | '))
})

test('css: complete dark and light token sets with the exact palette and host-variable fallbacks', () => {
  const SEMANTIC = ['--dra-bg', '--dra-surface-1', '--dra-surface-2', '--dra-surface-3', '--dra-border', '--dra-text', '--dra-text-dim', '--dra-text-faint', '--dra-accent', '--dra-ok', '--dra-warn', '--dra-danger', '--dra-mesh']
  for (const t of SEMANTIC) {
    assert.ok(t in dark, '暗色（.dra-root）缺 ' + t)
    assert.ok(t in light, '浅色（.dra-root.dra-light）缺 ' + t)
  }
  const themeless = /^--dra-(r-|mono|sans|shadow$|border-strong$)/
  const missing = Object.keys(dark).filter((k) => !themeless.test(k) && !(k in light))
  assert.deepEqual(missing, [], '浅色缺少：' + missing.join(' '))
  const want = {
    '--dra-bg': ['#05070d', '#eef2f8'], '--dra-surface-1': ['#0b0e18', '#ffffff'], '--dra-surface-2': ['#111523', '#f4f7fc'],
    '--dra-surface-3': ['#171d2e', '#e9eff8'], '--dra-text': ['#e0e6f0', '#17202f'], '--dra-text-dim': ['#8a98b5', '#4a5a73'],
    '--dra-accent': ['#2ee6ff', '#1b6ef3'], '--dra-ok': ['#25e58c', '#1a9e6b'], '--dra-warn': ['#ffb547', '#b87010'],
    '--dra-danger': ['#ff4d6e', '#c92b4a'], '--dra-mesh': ['#a78bfa', '#6d4fd6'],
  }
  for (const [k, [d, l]] of Object.entries(want)) {
    assert.equal(hex(dark[k]), d, k + ' 暗色')
    assert.equal(hex(light[k]), l, k + ' 浅色')
  }
  assert.match(dark['--dra-border'], /rgba\(120,165,255,\.14\)/)
  assert.match(light['--dra-border'], /rgba\(30,60,110,\.16\)/)
  for (const t of ['--dra-bg', '--dra-text', '--dra-accent', '--dra-surface-1']) {
    assert.match(dark[t], /^var\(--dra-host-dark-[a-z0-9-]+,\s*#([0-9a-f]{6}|[0-9a-f]{3})\)$/i, t + ' 暗色先查宿主变量再回退')
    assert.match(light[t], /^var\(--dra-host-light-[a-z0-9-]+,\s*#([0-9a-f]{6}|[0-9a-f]{3})\)$/i, t + ' 浅色先查宿主变量再回退')
  }
  assert.doesNotMatch(CSS, /rgba\(46,\s*230,\s*255/, 'CSS 不得写死青色 rgba')
  // 深色底色只在 token 定义里出现，组件规则里没有裸 #05070d / rgba(5,7,13
  const offenders = stylesBase.concat(settingsCss).filter((l) => !/--dra-bg:/.test(l) && (/#05070d/.test(l) || /rgba\(5,\s*7,\s*13/.test(l)))
  assert.deepEqual(offenders, [])
  assert.ok(!settingsCss.join('').includes('#'), '设置模块的样式不写死颜色')
})

test('css: body and dim text keep >= 4.5:1 on every surface in both themes; faint never carries text', () => {
  const contrast = []
  for (const [name, set] of [['dark', dark], ['light', light]]) {
    for (const fg of ['--dra-text', '--dra-text-dim']) {
      for (const bg of ['--dra-bg', '--dra-surface-1', '--dra-surface-2', '--dra-surface-3']) {
        const f = hex(set[fg])
        const b = hex(set[bg])
        contrast.push({ theme: name, fg, bg, f, b, ratio: f && b ? ratio(f, b) : 0 })
      }
    }
  }
  assert.equal(contrast.length, 16)
  for (const c of contrast) assert.ok(c.ratio >= 4.5, `${c.theme} ${c.fg}(${c.f}) on ${c.bg}(${c.b}) = ${c.ratio.toFixed(2)}:1 < 4.5:1`)
  for (const c of contrast.filter((x) => x.fg === '--dra-text')) assert.ok(c.ratio >= 7, '正文 >= 7:1')
  const bad = allRules.filter((r) => /(^|;)\s*color:var\(--dra-(text-)?faint\)/.test(r.body)).map((r) => r.selector)
  assert.deepEqual(bad, [], 'faint 不得承载文字：' + bad.join(' | '))
})

test('css a11y: focus ring, 32px buttons, disabled look, glyphs for status, reduced motion, no viewport breakpoints, no fixed-descendant traps', () => {
  const focus = top.find((r) => r.selector === '.dra-root :focus-visible')
  assert.ok(focus, '全局 :focus-visible 规则')
  assert.match(focus.body, /outline:2px solid var\(--dra-accent\)/)
  assert.match(focus.body, /outline-offset:2px/)
  assert.match(ruleBody('.dra-btn'), /min-height:32px/)
  assert.match(ruleBody('.dra-btn.sm'), /min-height:(2[4-9]|3\d)px/, '紧凑按钮不小于 24px')
  assert.deepEqual(top.filter((r) => /:hover/.test(r.selector) && /transform:translateY/.test(r.body)).map((r) => r.selector), [], 'hover 不位移')
  const dis = top.find((r) => /\.dra-btn:disabled/.test(r.selector))
  assert.match(dis.body, /opacity:\.45/)
  assert.match(dis.body, /cursor:not-allowed/)
  for (const s of ['.dra-banner-title::before', '.dra-banner.err .dra-banner-title::before', '.dra-banner.ok .dra-banner-title::before', '.dra-badge.ok::before', '.dra-badge.warn::before', '.dra-badge.bad::before']) {
    const r = top.find((x) => x.selector.split(',').map((y) => y.trim()).includes(s))
    assert.ok(r && /content:"[^"]+"/.test(r.body), s + ' 必须带图标字形（状态不只靠颜色）')
  }
  assert.ok(at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a.head) && /animation:none\s*!important/.test(a.body) && /transition:none\s*!important/.test(a.body)))
  assert.ok(!at.some((a) => /@media \([^)]*width/.test(a.head)), '不用视口宽度断点：栅格靠 auto-fit')
  assert.match(ruleBody('.dra-grid-2'), /repeat\(auto-fit,minmax\(min\(100%,360px\),1fr\)\)/)
  assert.match(ruleBody('.dra-statbar'), /repeat\(auto-fit,minmax\(112px,1fr\)\)/)
  assert.match(ruleBody('.dra-tabs'), /overflow-x:auto/)
  // 抽屉与对话框是 position:fixed：外壳根不得建立包含块
  assert.match(ruleBody('.dra-drawer-wrap'), /position:fixed/)
  for (const s of ['.dra-root', '.dra-screen']) assert.doesNotMatch(ruleBody(s), /container|contain:|transform|filter/, s + ' 不得成为 fixed 后代的包含块')
  assert.match(ruleBody('.dra-root'), /font-size:13px/)
  const tiny = []
  for (const r of allRules) for (const m of r.body.matchAll(/font-size:([\d.]+)px/g)) if (Number(m[1]) < 10) tiny.push(r.selector + ' ' + m[1])
  assert.deepEqual(tiny, [], 'CSS 文字不得小于 10px：' + tiny.join(' | '))
})

test('css a11y regressions against the old panel: 40px touch targets on coarse pointers, tab selection by border in forced-colors mode', () => {
  const coarse = at.find((a) => /pointer:\s*coarse/.test(a.head))
  assert.ok(coarse && /min-height:40px/.test(coarse.body), '触屏（pointer:coarse）下按钮/标签最小 40px')
  const forced = at.find((a) => /forced-colors:\s*active/.test(a.head))
  assert.ok(forced && /\.dra-tab\[aria-selected="true"\][^{]*\{[^}]*border/.test(forced.body), '强制颜色模式下选中标签用边框表达')
})

test('css: a hidden screen really is hidden (a display rule on .dra-screen must not defeat the hidden attribute)', () => {
  const hidden = top.find((r) => /\.dra-screen\[hidden\]/.test(r.selector))
  const shows = /display:\s*(flex|grid|block)/.test(ruleBody('.dra-screen'))
  assert.ok(!shows || (hidden && /display:none/.test(hidden.body)), '.dra-screen 设了 display，就必须有 .dra-screen[hidden]{display:none}，否则访问过的屏会一直显示')
})
