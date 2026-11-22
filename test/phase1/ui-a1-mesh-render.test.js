import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { topologyView } from '../../lib/hub/views.js'
import { NodeRegistry } from '../../lib/hub/node-registry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../../lib/client.js'), 'utf8')

/* ───────────── 加载：无状态桩（与既有拓扑测试同一口径）；Panel 用有状态桩 ───────────── */
function load({ react, extra = {} } = {}) {
  let plugin = null
  let Panel = null
  const stub = react || function () {
    return {
      createElement(type, props, ...kids) { return { type, props: props || {}, kids: kids.flat(Infinity) } },
      useState(v) { return [v, function () {}] },
      useEffect() {}, useRef(v) { return { current: v } }, useMemo(fn) { return fn() },
    }
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(mod) { plugin = mod.factory(stub) } } },
    console,
    ...extra,
  }
  vm.runInNewContext(src, sandbox, { filename: 'lib/client.js' })
  plugin.apply({ slots: { inject(_n, reg) { reg() }, register(slot, comp) { if (slot.name === 'main') Panel = comp } } })
  return { P: plugin, Panel }
}
const { P } = load()
const plain = (v) => JSON.parse(JSON.stringify(v))
const cls = (e) => String((e.props || {}).className || '')
const walk = (el, out = []) => {
  if (!el || typeof el !== 'object') return out
  out.push(el)
  for (const k of el.kids || []) walk(k, out)
  return out
}
const text = (el) => walk(el).filter((e) => e.type !== 'title').flatMap((e) => e.kids || []).filter((k) => typeof k === 'string').join('|')
const byClass = (tree, c) => walk(tree).filter((e) => cls(e).split(/\s+/).includes(c))
const byStartClass = (tree, c) => walk(tree).filter((e) => cls(e).split(/\s+/).some((x) => x === c || x.startsWith(c)))

/** 取生产代码里真实的 CSS 数组并解析成规则（不靠源码字符串猜测）。 */
function cssRules() {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const start = code.indexOf('const CSS = [')
  const end = code.indexOf('\n    ]', start)
  assert.ok(start >= 0 && end > start, 'CSS array must exist')
  const css = vm.runInNewContext('(' + code.slice(start + 'const CSS = '.length, end + 6) + ')').join('')
  return [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }))
}
const ids = (n) => Array.from({ length: n }, (_, i) => 'n' + String(i + 1).padStart(2, '0'))
const NOW = 1_800_000_000_000
const fleet = (list, over = {}) => list.map((id) => ({
  nodeId: id, name: id, online: true, peerCapable: true, transportMode: 'direct',
  connectivity: { transportMode: 'direct', tunnelState: 'ready', sampledAt: NOW - 5_000, probes: [{ rttMs: 12, result: 'open' }] },
  ...(over[id] || {}),
}))
const INIT = P.topoPinReducer(undefined, { type: 'init' })
const view = (nodes, extra = {}) => P.renderTopologyBoardView({
  nodes, tasks: [], topology: topologyView(nodes), relayStatus: 'unreported',
  loading: false, error: '', width: 900, height: 560, reduced: true, now: NOW, ui: INIT, dispatch() {},
  ...extra,
})
const ui = (patch) => ({ ...plain(INIT), ...patch })

test('render: 默认零对等边；60 对仍零边', () => {
  for (const n of [2, 5, 12, 13]) {
    const nodes = fleet(ids(n))
    const tree = view(nodes)
    assert.equal(byStartClass(tree, 'dra-mesh-edge').length, 0, n + ' 台默认不画候选边')
    assert.equal(byClass(tree, 'dra-mesh-band').length, 1, '只有一条整圈带')
    // hub 边语义保持：每台一条 hub 边
    assert.equal(byClass(tree, 'dra-tg-edge').length, n)
  }
  const sixty = fleet(ids(12))
  assert.equal(topologyView(sixty).peerLinks.length, 60)
  const tree = view(sixty)
  assert.equal(byStartClass(tree, 'dra-mesh-edge').length, 0)
  assert.match(text(tree), /对等候选组：服务端计数 12 台 · 收到 60 对有效候选 · 已达服务端上限 60，可能不完整/)
  // 徽标含文字，触顶带 +
  assert.ok(text(tree).includes('对等 11+'))
})

test('render: 带只在有效对≥1 时出现；1 台/0 对只有文字说明', () => {
  assert.equal(byClass(view(fleet(['a'])), 'dra-mesh-band').length, 0)
  const noPair = view(fleet(['a', 'b']), { topology: { nodes: [], links: [], peerLinks: [], summary: { peerCapable: 2 } } })
  assert.equal(byClass(noPair, 'dra-mesh-band').length, 0)
  assert.match(text(noPair), /无对等候选/)
  const missing = view(fleet(['a', 'b']), { topology: null })
  assert.match(text(missing), /对等候选：未上报/)
  assert.equal(byClass(missing, 'dra-mesh-band').length, 0)
  assert.equal(byClass(view(fleet(['a', 'b'])), 'dra-mesh-band').length, 1)
  assert.ok(text(view(fleet(['a']))).includes('对等 0'))
})

test('render: 悬停预览≤cap，其余+M，完整列表齐全', () => {
  const nodes = fleet(ids(13)) // 13 台：服务端 78 对截断到 60
  const wide = view(nodes, { ui: ui({ hover: 'n01' }) })
  assert.equal(byStartClass(wide, 'dra-mesh-edge').length, 6)
  assert.ok(text(wide).includes('+6 更多'))
  const li = byClass(wide, 'dra-mesh-neighbor')
  assert.equal(li.length, 12, '完整邻居不受预览上限限制')
  // 紧凑模式上限 3
  const compact = view(nodes, { width: 500, ui: ui({ pinned: 'n01' }) })
  assert.equal(byStartClass(compact, 'dra-mesh-edge').length, 3)
  assert.ok(text(compact).includes('+9 更多'))
  assert.equal(byClass(compact, 'dra-mesh-neighbor').length, 12)
  // 邻居不超过 cap 时没有溢出
  const small = view(nodes, { ui: ui({ hover: 'n13' }) })
  assert.equal(byStartClass(small, 'dra-mesh-edge').length, 6)
  assert.ok(!/\+\d+ 更多/.test(text(small)))
  // 5 台：宽屏 4 条不溢出，紧凑 3 条 +1
  const five = fleet(ids(5))
  assert.equal(byStartClass(view(five, { ui: ui({ hover: 'n01' }) }), 'dra-mesh-edge').length, 4)
  const five3 = view(five, { width: 500, ui: ui({ focus: 'n01' }) })
  assert.equal(byStartClass(five3, 'dra-mesh-edge').length, 3)
  assert.ok(text(five3).includes('+1 更多'))
  // 预览边是细点线、用 mesh token、不是 ok 色
  const e = byStartClass(wide, 'dra-mesh-edge')[0]
  assert.ok(!JSON.stringify(e.props).includes('--dra-ok'))
})

test('stale: 心跳超时不进预览但在列表里', () => {
  const nodes = fleet(['a', 'b', 'c'], { c: { stale: true } })
  const tree = view(nodes, { ui: ui({ hover: 'a' }) })
  assert.equal(byStartClass(tree, 'dra-mesh-edge').length, 1) // 只有 a-b
  const rows = byClass(tree, 'dra-mesh-row')
  assert.equal(rows.length, 3)
  assert.ok(text(rows.find((r) => text(r).includes('c'))).includes('心跳超时'))
  const nb = byClass(tree, 'dra-mesh-neighbor').map((e) => text(e))
  assert.equal(nb.length, 2) // a 的完整邻居含 c
  assert.ok(nb.some((t) => t.includes('c') && t.includes('心跳超时')))
  // 悬停心跳超时节点本身：没有预览
  assert.equal(byStartClass(view(nodes, { ui: ui({ hover: 'c' }) }), 'dra-mesh-edge').length, 0)
})

test('legend: 不含「已连接」，候选色不是 --dra-ok', () => {
  const tree = view(fleet(ids(5)))
  const legend = text(byClass(tree, 'dra-mesh-legend')[0])
  assert.ok(legend.length > 0, '图例始终可见')
  for (const w of ['已连接', '已建立', '在线链路', '网状已建立', '中继正常']) assert.ok(!text(tree).includes(w), w)
  assert.match(legend, /对等候选：服务端列出，未验证/)
  assert.match(legend, /对等候选组/)
  assert.match(legend, /实线.*主控直连/)
  // CSS：.dra-mesh-* 规则不得引用 --dra-ok，且必须引用 --dra-mesh；token 在暗/亮两套都有
  const rules = cssRules().filter((r) => r.selector.split(',').some((x) => x.trim().startsWith('.dra-mesh-')))
  assert.ok(rules.length >= 4, '应有 .dra-mesh-* 规则')
  assert.ok(rules.every((r) => !r.body.includes('--dra-ok')))
  assert.ok(rules.some((r) => r.body.includes('var(--dra-mesh)')))
  const token = (sel) => cssRules().find((r) => r.selector.trim() === sel)
  assert.match(token('.dra-root').body, /--dra-mesh:#[0-9a-f]{6}/i)
  assert.match(token('.dra-light').body, /--dra-mesh:#[0-9a-f]{6}/i)
  // 旧 TopologyMap 的图例同样如此
  const legacy = P.TopologyMap({ topology: topologyView(fleet(ids(3))), nodes: fleet(ids(3)), tasks: [] })
  assert.ok(!/已连接|已建立|绿色/.test(text(legacy)))
  assert.match(text(legacy), /对等候选/)
})

test('relay: 未上报≠不可达≠可达', () => {
  const nodes = fleet(['a', 'b'])
  const none = view(nodes)
  assert.ok(text(none).includes('中继：未上报'))
  assert.equal(byClass(none, 'dra-tg-relay').length, 0)
  assert.equal(byClass(none, 'dra-tg-edge').filter((e) => cls(e).includes('st-down')).length, 0)
  const down = view(nodes, { relayStatus: 'unreachable' })
  assert.ok(text(down).includes('中继：不可达'))
  assert.equal(byClass(down, 'dra-tg-relay').length, 1)
  const up = view(nodes, { relayStatus: 'reachable' })
  assert.ok(text(up).includes('中继：上报可达'))
  assert.equal(byClass(up, 'dra-tg-relay').length, 0)
  // 缺省/非法值＝未上报
  assert.ok(text(view(nodes, { relayStatus: undefined })).includes('中继：未上报'))
  assert.ok(text(view(nodes, { relayStatus: 'bogus' })).includes('中继：未上报'))
})

test('rtt: 有效 0 与未测不混淆；null 不显示 0（图与列表）', () => {
  const nodes = fleet(['zero', 'none', 'neg'], {
    zero: { connectivity: { transportMode: 'direct', probes: [{ rttMs: 0 }] } },
    none: { connectivity: { transportMode: 'direct', probes: [{ rttMs: null }] } },
    neg: { connectivity: { transportMode: 'relay', probes: [{ rttMs: -1 }] } },
  })
  const tree = view(nodes)
  const rows = byClass(tree, 'dra-mesh-row')
  const row = (id) => text(rows.find((r) => text(r).startsWith(id) || text(r).includes(id)))
  assert.ok(row('zero').includes('rtt 0ms'))
  assert.ok(row('none').includes('延迟未测') && !/rtt \d/.test(row('none')))
  assert.ok(row('neg').includes('延迟未测'))
  const labels = byClass(tree, 'dra-tg-node').map((g) => g.props['aria-label'])
  assert.ok(labels.find((l) => l.includes('zero')).includes('rtt 0ms'))
  assert.ok(labels.find((l) => l.includes('none')).includes('延迟未测'))
})

test('a11y: 每个节点有 aria-label/可聚焦，列表含全部节点，reduced 无 packets', () => {
  const nodes = fleet(['a', 'b', 'c', 'd'], {
    b: { online: false, peerCapable: false, transportMode: null, connectivity: null },
    c: { stale: true, transportMode: 'relay', connectivity: { transportMode: 'relay', probes: [] } },
  })
  const tasks = [{ taskId: 't1', nodeId: 'a', status: 'running' }, { taskId: 't2', nodeId: 'a', status: 'queued' }]
  const tree = view(nodes, { tasks, ui: ui({ pinned: 'a' }) })
  const svg = byClass(tree, 'dra-tg-svg')[0]
  assert.equal(svg.props.role, 'group')
  assert.ok(String(svg.props['aria-label']).length > 0)
  const g = byClass(tree, 'dra-tg-node')
  assert.equal(g.length, 4)
  for (const n of g) {
    assert.equal(n.props.tabIndex, 0)
    assert.equal(n.props.role, 'button')
    assert.ok(String(n.props['aria-label']).length > 0)
    assert.equal(typeof n.props['aria-pressed'], 'boolean')
  }
  const lab = (id) => g.find((n) => n.props['aria-label'].startsWith(id)).props['aria-label']
  assert.match(lab('a'), /在线/); assert.match(lab('a'), /直连/); assert.match(lab('a'), /rtt 12ms/); assert.match(lab('a'), /1 运行 · 1 排队/); assert.match(lab('a'), /对等 /)
  assert.match(lab('b'), /离线/); assert.match(lab('b'), /传输未知/); assert.match(lab('b'), /延迟未测/)
  assert.match(lab('c'), /心跳超时/); assert.match(lab('c'), /中继/)
  assert.equal(g.find((n) => n.props['aria-label'].startsWith('a')).props['aria-pressed'], true)
  assert.equal(g.find((n) => n.props['aria-label'].startsWith('b')).props['aria-pressed'], false)
  // 状态不只靠颜色：card 的 class 区分在线/离线/心跳超时
  const cards = byClass(tree, 'dra-tg-card')
  assert.ok(cards.some((c) => cls(c).includes('stale')))
  // 可见的列表：含全部节点（含离线与心跳超时）
  const section = walk(tree).find((e) => e.type === 'section' && e.props['aria-label'] === '电脑列表')
  assert.ok(section, '应有 aria-label="电脑列表" 的 section')
  const rows = byClass(section, 'dra-mesh-row')
  assert.equal(rows.length, 4)
  assert.ok(rows.every((r) => r.type === 'li'))
  const rt = rows.map(text)
  assert.ok(rt.some((t) => t.includes('b') && t.includes('离线')))
  assert.ok(rt.some((t) => t.includes('c') && t.includes('心跳超时')))
  // 每行有固定按钮，状态用 aria-pressed
  const pins = walk(section).filter((e) => e.type === 'button' && cls(e).includes('dra-mesh-pin'))
  assert.equal(pins.length, 4)
  // 减少动效：无 packets / is-flow，且 running 任务环仍在
  assert.equal(byClass(tree, 'dra-tg-packet').length, 0)
  assert.ok(!walk(tree).some((e) => /is-flow/.test(cls(e))))
  assert.equal(byClass(tree, 'dra-tg-tick').length, 2)
  // 非 reduced：running 边有 packets
  const moving = view(nodes, { tasks, reduced: false, t: 1.3 })
  assert.ok(byClass(moving, 'dra-tg-packet').length > 0)
})

test('keyboard: 点击/Enter/Space 派发固定，Escape 走 reducer，焦点与悬停派发预览', () => {
  const events = []
  const nodes = fleet(['a', 'b'])
  const tree = view(nodes, { dispatch: (e) => events.push(plain(e)) })
  const g = byClass(tree, 'dra-tg-node')[0]
  g.props.onClick()
  let prevented = 0
  g.props.onKeyDown({ key: 'Enter', preventDefault() { prevented += 1 } })
  g.props.onKeyDown({ key: ' ', preventDefault() { prevented += 1 } })
  g.props.onKeyDown({ key: 'Tab', preventDefault() { prevented += 1 } })
  g.props.onFocus(); g.props.onBlur(); g.props.onMouseEnter(); g.props.onMouseLeave()
  const pin = walk(tree).find((e) => e.type === 'button' && cls(e).includes('dra-mesh-pin'))
  pin.props.onClick()
  assert.deepEqual(events.map((e) => e.type), ['click', 'key', 'key', 'focus', 'blur', 'hover', 'hover', 'click'])
  assert.deepEqual(events.filter((e) => e.type === 'key').map((e) => e.key), ['Enter', ' '])
  assert.equal(prevented, 2, 'Space/Enter 阻止默认滚动；Tab 不拦截')
  assert.ok(events.every((e) => e.type === 'blur' || e.type === 'hover' || e.id === 'a'))
})

test('announce: 播报区稳定且只含固定/陈旧信息，不随刷新变化', () => {
  const nodes = fleet(['a', 'b'])
  const live = (t) => walk(t).filter((e) => (e.props || {})['aria-live'] === 'polite')
  const a = view(nodes, { ui: ui({ pinned: 'a', announce: '已固定：a' }) })
  assert.equal(live(a).length, 1)
  assert.equal(text(live(a)[0]), '已固定：a')
  // 数据刷新（新对象、新 RTT）但 announce 不变 → 播报区文本不变
  const refreshed = view(fleet(['a', 'b'], { a: { connectivity: { transportMode: 'direct', probes: [{ rttMs: 77 }] } } }), { ui: ui({ pinned: 'a', announce: '已固定：a' }) })
  assert.equal(text(live(refreshed)[0]), '已固定：a')
  assert.equal(text(live(view(nodes))[0]), '')
  assert.ok(!walk(view(nodes)).some((e) => e.type === 'ul' && (e.props || {})['aria-live']))
})

test('loading/empty/error/stale: 保留最后一次成功数据；不暗示已验证', () => {
  // 加载：无节点 + loading → 骨架 aria-busy
  const loading = view([], { loading: true, topology: null })
  assert.ok(walk(loading).some((e) => (e.props || {})['aria-busy'] === true))
  assert.ok(!text(loading).includes('还没有任何电脑接入'))
  // 空：保留既有文案
  const empty = view([], { topology: null })
  assert.ok(text(empty).includes('还没有任何电脑接入'))
  // 错误且无数据：只有错误条
  const errOnly = view([], { topology: null, error: 'HTTP 500' })
  assert.equal(walk(errOnly).filter((e) => (e.props || {}).role === 'alert').length, 1)
  assert.ok(text(errOnly).includes('HTTP 500'))
  assert.ok(!text(errOnly).includes('还没有任何电脑接入'))
  // 错误且有数据：保留节点、band、固定；标「数据陈旧」与「预览基于旧数据」
  const nodes = fleet(ids(4))
  const stale = view(nodes, { error: 'HTTP 502', ui: ui({ pinned: 'n01', stale: true, announce: '数据陈旧：刷新失败，显示最后一次成功的数据' }) })
  assert.equal(byClass(stale, 'dra-tg-node').length, 4)
  assert.equal(byClass(stale, 'dra-mesh-band').length, 1)
  assert.ok(byStartClass(stale, 'dra-mesh-edge').length > 0)
  assert.ok(text(stale).includes('HTTP 502'))
  assert.ok(text(stale).includes('数据陈旧'))
  assert.ok(text(stale).includes('预览基于旧数据'))
  assert.equal(walk(stale).filter((e) => (e.props || {}).role === 'alert').length, 1)
  // 非陈旧时不出现这两句
  const fresh = view(nodes, { ui: ui({ hover: 'n01' }) })
  assert.ok(!text(fresh).includes('数据陈旧') && !text(fresh).includes('预览基于旧数据'))
  // 固定的电脑消失：列表头提示
  const lost = view(nodes, { ui: ui({ lost: true, announce: '已固定的电脑不在最新列表中' }) })
  assert.ok(text(byClass(lost, 'dra-mesh-lost')[0]).includes('已固定的电脑不在最新列表中'))
  assert.equal(byClass(fresh, 'dra-mesh-lost').length, 0)
  // 三类文案互不相同
  const capped = view(fleet(ids(12)), { error: 'x', ui: ui({ stale: true }) })
  const t = text(capped)
  assert.ok(t.includes('收到 60 对有效候选') && t.includes('预览基于旧数据') && t.includes('已达服务端上限 60，可能不完整'))
})

test('legacy TopologyMap: 与新模型一致，不再画绿色对等线', () => {
  const nodes = fleet(ids(12))
  const topology = topologyView(nodes)
  const tree = P.TopologyMap({ topology, nodes, tasks: [] })
  // 不再有任何对等线：既没有 dra-mesh-edge，也没有 stroke 为 --dra-ok 的 line
  assert.equal(byStartClass(tree, 'dra-mesh-edge').length, 0)
  assert.equal(walk(tree).filter((e) => e.type === 'line' && /--dra-ok/.test(JSON.stringify((e.props || {}).style || {}))).length, 0)
  assert.equal(walk(tree).filter((e) => e.type === 'line' && !cls(e).includes('dra-topo-line')).length, 0)
  // hub 线保持：每台一条
  assert.equal(byClass(tree, 'dra-topo-line').length, 12)
  // 带 + 两个计数 + 触顶措辞 + 徽标
  assert.equal(byClass(tree, 'dra-mesh-band').length, 1)
  assert.match(text(tree), /对等候选组：服务端计数 12 台 · 收到 60 对有效候选 · 已达服务端上限 60，可能不完整/)
  assert.ok(text(tree).includes('对等 11+'))
  // 缺失与 1 台
  const miss = text(P.TopologyMap({ topology: { nodes: topology.nodes, links: topology.links, summary: topology.summary }, nodes, tasks: [] }))
  assert.ok(miss.includes('对等候选：未上报'))
  assert.equal(byClass(P.TopologyMap({ topology: topologyView(fleet(['a'])), nodes: fleet(['a']), tasks: [] }), 'dra-mesh-band').length, 0)
  // summary 缺失时保留既有提示
  assert.equal(P.TopologyMap({ topology: null, nodes: fleet(['a', 'b']), tasks: [] }).props.sub, '链路汇总未上报')
  assert.match(P.TopologyMap({ topology, nodes, tasks: [] }).props.sub, /服务端对等计数 12/)
})

/* ───────── 接线：真实 /overview（本进程内 registry + registerUiRoutes，无网络）→ Panel 加载器 → 拓扑板入参 ───────── */
function statefulReact() {
  const slots = []
  const effects = []
  let idx = 0
  let first = true
  const react = {
    createElement(type, props, ...kids) { return { type, props: props || {}, kids: kids.flat(Infinity) } },
    useState(v) {
      const i = idx++
      if (first) slots[i] = { value: typeof v === 'function' ? v() : v }
      const slot = slots[i]
      return [slot.value, (n) => { slot.value = typeof n === 'function' ? n(slot.value) : n }]
    },
    useRef(v) { const i = idx++; if (first) slots[i] = { value: { current: v } }; return slots[i].value },
    useEffect(fn) { idx += 0; if (first) effects.push(fn) },
    useMemo(fn) { return fn() },
  }
  return { react, slots, effects, begin() { idx = 0 }, end() { first = false } }
}

test('wiring: 真实 overview → loader → Panel → 拓扑板入参；刷新失败保留最后成功快照并标陈旧', async () => {
  const { registerUiRoutes } = await import('../../src/http/index.js')
  const registry = new NodeRegistry({ log() {} })
  const routes = new Map()
  const disposers = registerUiRoutes({
    ctx: { webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => {} } } },
    registry, pulls: { activeCount: 0 }, log() {},
    config: { role: 'hub', transportMode: 'direct' },
  })
  try {
    const now = Date.now()
    ids(4).forEach((id, i) => registry.nodes.set(id, {
      nodeId: id, online: true, lastSeen: now, tasks: new Map(),
      hello: { transportMode: 'direct', peerUrl: i === 3 ? '' : 'peer-fixture-' + id },
      connectivity: { transportMode: 'direct', tunnelState: 'ready', sampledAt: now, probes: [{ target: 'probe-fixture', rttMs: 0, result: 'open' }] },
    }))
    const call = async (p) => {
      let status; let body
      await routes.get('/api/ai-cluster/ui' + p)({ method: 'GET', headers: {}, url: p, socket: { remoteAddress: '127.0.0.1' } },
        { writeHead(c) { status = c }, end(b) { body = JSON.parse(b) } })
      return { status, body }
    }
    const overview = (await call('/overview')).body
    assert.equal(overview.topology.peerLinks.length, 3) // n01,n02,n03 可对等 → 3 对；n04 无地址
    assert.equal(overview.relay, undefined) // 真实响应没有 relay 字段
    const bodies = {
      '/api/remote-agent/setup/state': { configured: true, effectiveRole: 'hub' },
      '/api/ai-cluster/ui/overview': overview,
      '/api/ai-cluster/ui/tasks': (await call('/tasks')).body,
      '/api/ai-cluster/ui/node-status': (await call('/node-status')).body,
    }
    let failOverview = false
    const timers = []
    const sr = statefulReact()
    const { P: Q, Panel } = load({
      react: () => sr.react,
      extra: {
        fetch(url) {
          const u = String(url).split('?')[0]
          if (failOverview && u.endsWith('/ui/overview')) return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'overview-failed' }) })
          return Promise.resolve({ ok: true, status: 200, json: async () => (u in bodies ? bodies[u] : {}) })
        },
        // The hub poll is a self-rescheduling setTimeout now (3 s while tasks are active, 8 s idle, re-armed
        // whenever `tick` or the active count changes), not a setInterval: capture timeouts and pick the idle one.
        setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length },
        clearTimeout() {},
      },
    })
    const render = () => { sr.begin(); const t = Panel(); sr.end(); return t }
    render()
    sr.effects.forEach((fn) => { try { fn() } catch { /* 与本断言无关的副作用 */ } })
    await new Promise((r) => setTimeout(r, 60))
    sr.slots[0].value = { ...sr.slots[0].value, computersMode: 'topo' }
    let board = walk(render()).find((e) => e.type === Q.TopologyBoard)
    assert.ok(board, '拓扑模式应渲染 TopologyBoard')
    assert.deepEqual(plain(board.props.topology), plain(overview.topology), '拓扑原样传入')
    assert.equal(board.props.nodes.length, 4)
    assert.equal(board.props.relayStatus, 'unreported')
    assert.equal(board.props.error, '')
    assert.equal(board.props.loading, false)
    const ok = Q.renderTopologyBoardView({ ...board.props, width: 900, height: 560, reduced: true, now, ui: Q.topoPinReducer(undefined, { type: 'init' }), dispatch() {} })
    assert.match(text(ok), /对等候选组：服务端计数 3 台 · 收到 3 对有效候选/)
    assert.ok(text(ok).includes('rtt 0ms'), '真实上报的 0 仍是有效值')
    assert.equal(byStartClass(ok, 'dra-mesh-edge').length, 0)
    // 卡片模式：旧 TopologyMap 收到同一份 topology
    sr.slots[0].value = { ...sr.slots[0].value, computersMode: 'cards' }
    assert.equal(walk(render()).find((e) => e.type === Q.TopologyMap).props.topology, sr.slots[0].value.topology)
    sr.slots[0].value = { ...sr.slots[0].value, computersMode: 'topo' }

    // 8 秒轮询：overview 失败 → 保留最后成功的数据 + 错误
    const poll = timers.find((t) => t.ms === 8000)
    assert.ok(poll, 'an idle hub arms an 8 s poll timeout')
    failOverview = true
    poll.fn()
    await new Promise((r) => setTimeout(r, 60))
    const st = sr.slots[0].value
    assert.ok(st.error, '失败应记录错误')
    assert.equal(st.nodes.length, 4)
    assert.deepEqual(plain(st.topology), plain(overview.topology))
    board = walk(render()).find((e) => e.type === Q.TopologyBoard)
    assert.ok(board.props.error)
    assert.equal(board.props.nodes.length, 4)
    const stale = Q.renderTopologyBoardView({ ...board.props, width: 900, height: 560, reduced: true, now, ui: Q.topoPinReducer(Q.topoPinReducer(undefined, { type: 'click', id: 'n01', label: 'n01' }), { type: 'error' }), dispatch() {} })
    assert.ok(text(stale).includes('数据陈旧'))
    assert.equal(byClass(stale, 'dra-tg-node').length, 4)
    assert.equal(byClass(stale, 'dra-mesh-band').length, 1)
    assert.ok(byStartClass(stale, 'dra-mesh-edge').length > 0, '固定的节点在陈旧数据上仍显示预览')
    // 恢复：下一轮成功，错误清除
    failOverview = false
    poll.fn()
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(sr.slots[0].value.error, '')
  } finally {
    for (const d of disposers) d()
  }
})
