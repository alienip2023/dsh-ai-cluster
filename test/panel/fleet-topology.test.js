// Behaviour of the topology / mesh / link-health parts of the fleet overview, ported from the old client tests
// (ui-p2-topology, ui-a1-mesh-model, ui-a1-mesh-render, ui-p3-mesh-health, panel-perf topology runtime).
import assert from 'node:assert/strict'
import test from 'node:test'
import { topologyView } from '../../lib/hub/views.js'
import { makeCore, expand, texts, textOf, findAll } from './_fake.js'
import { dataEmptyHub } from '../../src/panel/data.js'
import {
  createFleet, fleetActivity, fleetActivityText, fleetCss, fleetLayout, fleetLinkKind, fleetNodeModel, fleetOrphans, fleetPeerModel, fleetPinState,
  fleetRelayStatus, fleetStaleLabel, fleetTaskState,
} from '../../src/panel/fleet.js'

const NOW = Date.now()
const props = (hub) => ({ hub, role: 'hub', go() {}, refresh() {}, ui: { confirm: async () => true, alert() {}, notify() {}, prompt: async () => null } })
const mkHub = (nodes, extra = {}) => Object.assign({}, dataEmptyHub, {
  loading: false, at: NOW, tick: 1, nodes, tasks: [], counts: { nodes: nodes.length, online: nodes.filter((n) => n.online).length, tasks: 0, running: 0, active: 0, done: 0, failed: 0 },
  connection: { everConnected: true, byNode: [], recent: [] }, topology: topologyView(nodes),
}, extra)
const render = (hub, state) => { const core = makeCore({ state }); const f = createFleet(core); return expand(core.h(f.Overview, props(hub))) }
const edges = (tree) => findAll(tree, (n) => n.type === 'path' && /^fl-edge /.test(n.props.className))
const plain = (v) => JSON.parse(JSON.stringify(v))

/* ── 布局与任务投影 ───────────────────────────────────────────────── */

const models = (list, tasks = []) => {
  const act = fleetActivity(tasks)
  return list.map((n) => fleetNodeModel(n, act[n.nodeId], 0))
}
const base = () => [
  { nodeId: 'beta', hostname: 'beta', online: true, connectivity: { probes: [{ rttMs: 12 }] } },
  { nodeId: 'alpha', hostname: 'alpha', online: true },
  { nodeId: 'gamma', hostname: 'gamma', online: false, connectivity: { probes: [{ rttMs: 40 }] } },
]
const tasks = () => [
  { taskId: 't1', nodeId: 'alpha', status: 'running' },
  { taskId: 't2', nodeId: 'alpha', status: 'completed' },
  { taskId: 't3', nodeId: 'beta', status: 'queued' },
  { taskId: 't4', nodeId: 'ghost', status: 'failed' },
]

test('tasks are a projection on machines, never graph nodes; orphan tasks are counted, not dropped', () => {
  const m = models(base(), tasks())
  const lay = fleetLayout({ models: m })
  assert.deepEqual(lay.nodes.map((n) => n.id), ['alpha', 'beta', 'gamma'])
  assert.equal(lay.edges.length, 3) // one hub edge per machine
  assert.ok(!lay.edges.some((e) => /^t\d/.test(e.to)))
  assert.equal(fleetActivityText(fleetActivity(tasks()).alpha), '1 运行 · 1 完成')
  assert.equal(m.find((x) => x.id === 'gamma').actText, '无任务')
  assert.equal(fleetOrphans(tasks(), base()), 1)
  assert.equal(fleetOrphans([], base()), 0)
  const text = textOf(core0(mkHub(base(), { tasks: tasks() })))
  assert.match(text, /4 个任务（1 个不属于列表里的机器）/)
})
const core0 = (hub) => { const core = makeCore(); return core.h(createFleet(core).Overview, props(hub)) }

test('task states map to the four edge classes; only online machines animate', () => {
  assert.equal(fleetTaskState('running'), 'running')
  assert.equal(fleetTaskState('queued'), 'queued')
  assert.equal(fleetTaskState('pending_approval'), 'queued')
  assert.equal(fleetTaskState('completed'), 'done')
  for (const s of ['failed', 'aborted', 'interrupted', 'rejected']) assert.equal(fleetTaskState(s), 'failed', s)
  assert.equal(fleetTaskState('weird'), 'other')
  const lay = fleetLayout({ models: models(base(), tasks()) })
  const st = (id) => lay.edges.find((e) => e.to === id).state
  assert.deepEqual([st('alpha'), st('beta'), st('gamma')], ['running', 'queued', 'offline'])
  // a running task on an offline machine does not animate its edge
  const off = fleetLayout({ models: models([{ nodeId: 'x', online: false }], [{ taskId: 't', nodeId: 'x', status: 'running' }]) })
  assert.equal(off.edges[0].state, 'offline')
})

test('idle fleet draws no flowing edge; a running task flows only on its own machine', () => {
  const hub = (tk) => mkHub(base().map((n) => Object.assign({ transportMode: 'direct' }, n)), { tasks: tk })
  for (const tk of [[], [{ taskId: 'a', nodeId: 'alpha', status: 'completed' }]]) {
    assert.ok(edges(render(hub(tk))).every((e) => !/st-running/.test(e.props.className)))
  }
  const running = edges(render(hub([{ taskId: 'a', nodeId: 'beta', status: 'running' }])))
  assert.deepEqual(running.map((e) => /st-running/.test(e.props.className)), [false, true, false]) // alpha, beta, gamma
})

test('motion is CSS only: every animation names a real keyframe, nothing overrides reduced motion, and no <animate*> is rendered', () => {
  const css = fleetCss.join('')
  const keyframes = [...css.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1])
  const used = [...css.matchAll(/animation:([\w-]+)/g)].map((m) => m[1])
  assert.ok(used.length >= 12, 'a lively scene has many animated layers')
  for (const name of used) assert.ok(keyframes.includes(name) || name.startsWith('dra-'), 'missing @keyframes ' + name)
  assert.doesNotMatch(css, /!important/) // styles.js owns the reduced-motion switch; modules must not fight it
  const tree = render(mkHub(fleet(['a', 'b'])))
  assert.equal(findAll(tree, (n) => /^animate/.test(String(n.type))).length, 0)
  // a flying packet that cannot move is parked mid-path so the still picture keeps its meaning
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.fl-fly\{offset-distance:58%\}/)
  // narrow containers hide the picture and keep the table
  assert.match(css, /@container \(max-width:520px\)\{\.fl-stage/)
})

test('no hard-coded colours: the scene styles use tokens and color-mix only', () => {
  const css = fleetCss.join('')
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  assert.match(css, /var\(--dra-link-lan\)/)
  for (const t of ['--dra-link-direct', '--dra-link-relay', '--dra-link-tunnel', '--dra-accent-2', '--dra-accent-3', '--dra-glass', '--dra-r-lg']) assert.ok(css.includes(t), t)
  assert.doesNotMatch(css, /translateY/) // cards do not hop on hover
  assert.match(css, /\.dra-light \.fl-stage\{/) // a dedicated light stage
})

test('null rtt never renders a number or 0ms; a real 0 is still a value', () => {
  const list = [
    { nodeId: 'zero', hostname: 'zero', online: true, transportMode: 'direct', connectivity: { probes: [{ rttMs: 0 }] } },
    { nodeId: 'none', hostname: 'none', online: true, transportMode: 'direct', connectivity: { probes: [{ rttMs: null }] } },
    { nodeId: 'neg', hostname: 'neg', online: true, transportMode: 'relay', connectivity: { probes: [{ rttMs: -1 }] } },
    { nodeId: 'off', hostname: 'off', online: false, connectivity: { probes: [{ rttMs: 40 }] } },
  ]
  const tree = render(mkHub(list))
  const row = (id) => texts(findAll(tree, (n) => n.type === 'tr' && n.kids.some((k) => k.type === 'th' && k.props.title === id))[0]).join('|')
  assert.match(row('zero'), /探测 0ms/)
  assert.match(row('none'), /延迟未测/)
  assert.doesNotMatch(row('none'), /\d+ms/)
  assert.match(row('neg'), /延迟未测/)
  assert.match(row('off'), /\|—\|/) // offline machines show no latency at all
  const label = (id) => findAll(tree, (n) => n.type === 'g' && n.props.role === 'button').find((g) => g.props['aria-label'].startsWith(id)).props['aria-label']
  assert.match(label('zero'), /探测 0ms/)
  assert.match(label('none'), /延迟未测/)
  const m = Object.fromEntries(models(list).map((x) => [x.id, x]))
  assert.equal(m.zero.edgeLabel, '直连 0ms')
  assert.equal(m.none.edgeLabel, '直连')
  assert.equal(m.off.edgeLabel, '离线')
})

test('relay box only when the relay is reported unreachable', () => {
  const list = base()
  assert.equal(fleetRelayStatus(null, null), 'unreported')
  assert.equal(fleetRelayStatus({ relay: { reachable: false } }, null), 'unreachable')
  assert.equal(fleetRelayStatus({ relayReachable: false }, null), 'unreachable')
  assert.equal(fleetRelayStatus(null, { reachable: true }), 'reachable')
  for (const v of [undefined, null, 0, '', 'false', 'no']) assert.equal(fleetRelayStatus(null, { reachable: v }), 'unreported', String(v))
  const hasRelay = (tree) => findAll(tree, (n) => n.type === 'rect' && n.props.className === 'fl-relaybox').length
  const none = render(mkHub(list))
  assert.equal(hasRelay(none), 0)
  assert.match(texts(none).join(''), /中继：未上报/)
  const down = render(mkHub(list, { relay: { reachable: false } }))
  assert.equal(hasRelay(down), 1)
  assert.match(texts(down).join(''), /中继：不可达/)
  assert.ok(findAll(down, (n) => n.type === 'path' && /fl-edge down/.test(n.props.className)).length === 1)
  const up = render(mkHub(list, { relay: { reachable: true } }))
  assert.equal(hasRelay(up), 0)
  assert.match(texts(up).join(''), /中继：上报可达/)
})

/* ── 对等候选模型 ─────────────────────────────────────────────────── */

const ids = (n) => Array.from({ length: n }, (_, i) => 'n' + String(i + 1).padStart(2, '0'))
const mk = (list, over = {}) => list.map((id) => ({ nodeId: id, online: true, peerCapable: true, ...(over[id] || {}) }))
const link = (from, to) => ({ from, to })
const topo = (list, links, summary, over) => ({ nodes: mk(list, over), links: [], peerLinks: links, summary })
const serverTopo = (n) => topologyView(mk(ids(n)))
const permutations = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])))
const deg = (m, id) => (m.neighbors[id] || []).length

test('mesh: undirected de-duplication is deterministic and independent of input order', () => {
  const links = [link('b', 'a'), link('a', 'b'), link('c', 'a'), link('b', 'c'), link('a', 'c')]
  for (const order of permutations(links)) {
    const m = fleetPeerModel(topo(['a', 'b', 'c'], order), mk(['a', 'b', 'c']))
    assert.deepEqual(m.pairs, [['a', 'b'], ['a', 'c'], ['b', 'c']])
    assert.match(m.label, /收到 3 对有效候选/)
  }
})

test('mesh: degree and summary come only from the unique valid pairs; the server count is passed through, not inferred', () => {
  const t = topo(['a', 'b', 'c', 'd'], [link('a', 'b'), link('b', 'a'), link('a', 'c'), link('b', 'c')], { peerCapable: 4 })
  const m = fleetPeerModel(t, mk(['a', 'b', 'c', 'd']))
  // by hand: unique valid pairs ab / ac / bc = 3; d received none, and a full graph (6) is never assumed
  assert.equal(m.pairs.length, 3)
  assert.deepEqual([deg(m, 'a'), deg(m, 'b'), deg(m, 'c'), deg(m, 'd')], [2, 2, 2, 0])
  assert.match(m.label, /服务端计数 4 台 · 收到 3 对有效候选/)
  const other = fleetPeerModel(topo(['a', 'b'], [link('a', 'b')], { peerCapable: 9 }), mk(['a', 'b']))
  assert.match(other.label, /服务端计数 9 台 · 收到 1 对有效候选/)
  assert.match(fleetPeerModel(topo(['a', 'b'], [link('a', 'b')]), mk(['a', 'b'])).label, /服务端计数 未上报/)
})

test('mesh: endpoints that are unknown, self-links, offline or not peer-capable are dropped', () => {
  const list = ['a', 'b', 'c', 'off', 'np']
  const over = { off: { online: false }, np: { peerCapable: false } }
  const links = [link('a', 'b'), link('a', 'a'), link('a', 'zz'), link('a', 'off'), link('np', 'b'), link('', 'a'), { from: 1, to: 2 }, null, { from: 'a' }]
  const m = fleetPeerModel(topo(list, links, { peerCapable: 3 }, over), mk(list, over))
  assert.deepEqual(m.pairs, [['a', 'b']])
  assert.equal(m.dropped, 8)
  assert.deepEqual([deg(m, 'a'), deg(m, 'b')], [1, 1])
  assert.equal(m.neighbors.off, undefined)
  assert.equal(m.neighbors.np, undefined)
  assert.equal(m.badge('off'), '—')
  assert.equal(m.badge('np'), '—')
  assert.equal(m.badge('c'), '对等 0')
  assert.match(m.label, /8 条被丢弃/)
})

test('mesh: blank or non-string endpoints are dropped whole; valid ids are kept byte for byte', () => {
  const ws = ['  ', '\t', '\n ']
  const valid = ['a', ' b ', 'c'] // ' b ' has surrounding spaces but is not blank: legal, must be kept as is
  const nodes = [...valid.map((id) => ({ nodeId: id, online: true, peerCapable: true })), ...ws.map((id) => ({ nodeId: id, online: true, peerCapable: true })),
    { nodeId: '', online: true, peerCapable: true }, { nodeId: 7, online: true, peerCapable: true }]
  const links = [link('a', ' b '), link('  ', 'a'), link('a', '\t'), link('\n ', ' b '), link('  ', '\t'), link('', 'a'), link('c', ''),
    { from: 7, to: 'a' }, { from: 'c', to: 7 }, { from: null, to: 'a' }, { from: 'a', to: undefined }, { from: ['a'], to: 'c' }, { from: 'a', to: { id: 'c' } }]
  const m = fleetPeerModel({ nodes, links: [], peerLinks: links, summary: { peerCapable: 3 } }, mk(valid))
  assert.deepEqual(m.pairs, [[' b ', 'a']])
  assert.equal(m.dropped, links.length - 1)
  assert.equal(m.capped, false)
  assert.deepEqual([deg(m, 'a'), deg(m, ' b ')], [1, 1])
  assert.deepEqual(Object.keys(m.neighbors).sort(), [' b ', 'a'])
  assert.match(m.label, /收到 1 对有效候选/)
  // reaching the cap is judged on the raw length: 59 junk + 1 valid = 60 -> capped, but still one pair
  const junk = Array.from({ length: 59 }, (_, i) => link(ws[i % 3], 'a'))
  const mc = fleetPeerModel({ nodes, links: [], peerLinks: [link('a', ' b '), ...junk], summary: { peerCapable: 3 } }, mk(valid))
  assert.equal(mc.capped, true)
  assert.equal(mc.pairs.length, 1)
})

test('mesh: missing is not empty', () => {
  for (const bad of [null, undefined, 'x', 5, [], {}, { nodes: [] }, { peerLinks: {} }, { peerLinks: 'ab' }]) {
    const m = fleetPeerModel(bad, mk(['a', 'b']))
    assert.equal(m.state, 'missing', JSON.stringify(bad))
    assert.equal(m.label, '对等候选：未上报')
    assert.equal(m.badge('a'), '')
  }
  const empty = fleetPeerModel(topo(['a', 'b'], []), mk(['a', 'b']))
  assert.equal(empty.state, 'empty')
  assert.equal(empty.label, '无对等候选')
  assert.match(fleetPeerModel(topo(['a'], [], { peerCapable: 1 }), mk(['a'])).label, /可对等的机器不足 2 台/)
  assert.match(fleetPeerModel(topo(['a'], [], { peerCapable: 0 }), mk(['a'])).label, /不足 2 台/)
  assert.doesNotMatch(fleetPeerModel(topo(['a', 'b', 'c'], [], { peerCapable: 3 }), mk(['a', 'b', 'c'])).label, /不足/)
})

test('mesh: the 60-pair cap is shown as possibly incomplete and never filled in', () => {
  const full = serverTopo(12) // 12 peer-capable machines: 66 pairs, the server sends 60
  assert.equal(full.peerLinks.length, 60)
  const m = fleetPeerModel(full, mk(ids(12)))
  assert.equal(m.capped, true)
  assert.equal(m.pairs.length, 60) // not topped up to 66
  assert.equal(m.badge('n01'), '对等 11+')
  assert.equal(m.badge('n12'), '对等 8+') // later machines lose pairs to the cut; the UI does not correct it
  assert.match(m.label, /服务端计数 12 台 · 收到 60 对有效候选 · 已达服务端上限 60，可能不完整/)
  const m59 = fleetPeerModel({ ...full, peerLinks: full.peerLinks.slice(0, 59) }, mk(ids(12)))
  assert.equal(m59.capped, false)
  assert.doesNotMatch(m59.label, /已达服务端上限/)
  assert.ok(ids(12).every((id) => !m59.badge(id).endsWith('+')))
  const mj = fleetPeerModel({ ...full, peerLinks: [...full.peerLinks.slice(0, 59), link('n01', 'n01')] }, mk(ids(12)))
  assert.equal(mj.capped, true)
  assert.equal(mj.pairs.length, 59)
  assert.equal(fleetPeerModel(serverTopo(11), mk(ids(11))).capped, false) // 55 pairs
})

test('mesh: neighbour view previews at most cap ids in ascending order, counts the overflow, and never truncates the full list', () => {
  const m = fleetPeerModel(serverTopo(13), mk(ids(13))) // 78 pairs cut to 60
  const v = m.view('n01', 6)
  assert.deepEqual(v.preview, ['n02', 'n03', 'n04', 'n05', 'n06', 'n07'])
  assert.equal(v.overflow, 6)
  assert.equal(v.full.length, 12)
  const v3 = m.view('n01', 3)
  assert.deepEqual([v3.preview, v3.overflow, v3.full.length], [['n02', 'n03', 'n04'], 9, 12])
  const low = m.view('n13', 6)
  assert.deepEqual([low.full.length, low.preview.length, low.overflow], [6, 6, 0])
  assert.deepEqual(plain(m.view('ghost', 6)), { id: 'ghost', preview: [], overflow: 0, full: [], previewable: false })
})

test('mesh: a stale heartbeat stays in the list but out of the preview; stale labels follow heartbeat > old sample > unknown', () => {
  const list = ['a', 'b', 'c']
  const m = fleetPeerModel(topo(list, [link('a', 'b'), link('a', 'c'), link('b', 'c')], { peerCapable: 3 }), mk(list, { c: { stale: true } }))
  const a = m.view('a', 6)
  assert.deepEqual([a.preview, a.full], [['b'], ['b', 'c']])
  const c = m.view('c', 6)
  assert.deepEqual([c.preview, c.full], [[], ['a', 'b']])
  assert.equal(m.badge('c'), '—') // drawn as not live: no peer badge
  assert.equal(m.pairs.length, 3) // the pairs themselves are still a received fact
  const now = 1_000_000_000
  assert.equal(fleetStaleLabel({ stale: true }, now), '心跳超时')
  assert.equal(fleetStaleLabel({ stale: true, connectivity: { sampledAt: now - 700_000 } }, now), '心跳超时')
  assert.equal(fleetStaleLabel({ connectivity: { sampledAt: now - 601_000 } }, now), '采样陈旧')
  assert.equal(fleetStaleLabel({ connectivity: { sampledAt: now - 600_000 } }, now), '') // exactly 600 s is not stale
  assert.equal(fleetStaleLabel({ connectivity: { sampledAt: null } }, now), '')
  assert.equal(fleetStaleLabel({}, now), '')
  assert.equal(fleetStaleLabel(null, now), '')
})

test('pin: kept while the machine is listed, cleared with a notice when it disappears', () => {
  assert.deepEqual(fleetPinState('a', ['a', 'b']), { pin: 'a', lost: false })
  assert.deepEqual(fleetPinState('a', ['b']), { pin: '', lost: true })
  assert.deepEqual(fleetPinState('', ['b']), { pin: '', lost: false })
  assert.deepEqual(fleetPinState('a', undefined), { pin: '', lost: true })
})

/* ── 渲染：预览边、图例、无障碍、陈旧数据 ──────────────────────────── */

const fleet = (list, over = {}) => list.map((id) => ({
  nodeId: id, hostname: id, online: true, peerCapable: true, transportMode: 'direct',
  connectivity: { transportMode: 'direct', tunnelState: 'ready', sampledAt: NOW - 5_000, probes: [{ rttMs: 12, result: 'open' }] },
  ...(over[id] || {}),
}))
const peerLines = (tree) => findAll(tree, (n) => n.type === 'line' && n.props.className === 'fl-peer')

test('render: no peer edge by default, even at 60 pairs; the summary and badges carry the numbers', () => {
  for (const n of [2, 5, 12, 13]) {
    const tree = render(mkHub(fleet(ids(n))))
    assert.equal(peerLines(tree).length, 0, n + ' machines: no candidate edge by default')
    assert.equal(edges(tree).length, n) // one hub edge per machine
  }
  const text = texts(render(mkHub(fleet(ids(12))))).join('')
  assert.match(text, /服务端计数 12 台 · 收到 60 对有效候选 · 已达服务端上限 60，可能不完整/)
  assert.ok(text.includes('对等 11+'))
  assert.match(texts(render(mkHub(fleet(['a'])))).join(''), /对等 0/)
})

test('render: hover/focus/pin preview at most six peers, say how many more, and the detail lists all of them', () => {
  const nodes = fleet(ids(13))
  const pinned = render(mkHub(nodes), ['n01'])
  assert.equal(peerLines(pinned).length, 6)
  const text = texts(pinned).join('')
  assert.ok(text.includes('n01 +6 更多'))
  assert.match(text, /对等候选n02（在线）、n03（在线）.*n13（在线）；图上只画前 6 条在线的，另有 6 条见此列表/)
  assert.equal(peerLines(render(mkHub(nodes), ['', 'n01'])).length, 6) // hover or focus alone previews the same way
  const small = render(mkHub(nodes), ['n13'])
  assert.equal(peerLines(small).length, 6)
  assert.doesNotMatch(texts(small).join(''), /\+\d+ 更多/)
  assert.equal(peerLines(render(mkHub(fleet(ids(5))), ['n01'])).length, 4)
  // the preview edge is a thin dotted line in the mesh token, never the "ok" colour
  const peerRules = fleetCss.filter((r) => r.startsWith('.fl-peer'))
  assert.ok(peerRules.length > 0 && peerRules.every((r) => !r.includes('--dra-ok') && r.includes('var(--dra-mesh)')))
})

test('render: a stale-heartbeat machine is listed with its status but has no preview edge', () => {
  const nodes = fleet(['a', 'b', 'c'], { c: { stale: true } })
  const withA = render(mkHub(nodes), ['a'])
  assert.equal(peerLines(withA).length, 1) // only a-b
  const rowC = findAll(withA, (n) => n.type === 'tr' && n.kids.some((k) => k.type === 'th' && k.props.title === 'c'))[0]
  assert.match(texts(rowC).join(''), /心跳超时/)
  assert.match(texts(withA).join(''), /对等候选b（在线）、c（在线 · 心跳超时）/)
  assert.equal(peerLines(render(mkHub(nodes), ['c'])).length, 0)
})

test('legend never claims "connected"; candidates are labelled unverified', () => {
  const text = texts(render(mkHub(fleet(ids(5))))).join('')
  for (const w of ['已连接', '已建立', '在线链路', '网状已建立', '中继正常']) assert.ok(!text.includes(w), w)
  assert.match(text, /对等候选（服务端列出，未验证，不代表可用链路）/)
  assert.match(text, /颜色＝链路类别：局域网直连中继隧道未知/)
  assert.match(text, /流动的光＝链路在线/)
  assert.ok(fleetCss.some((r) => r.startsWith('.fl-peer')))
})

test('a11y: every machine is a focusable labelled button, the table lists all of them, status never relies on colour', () => {
  const nodes = fleet(['a', 'b', 'c', 'd'], {
    b: { online: false, peerCapable: false, transportMode: null, connectivity: null },
    c: { stale: true, transportMode: 'relay', connectivity: { transportMode: 'relay', probes: [] } },
  })
  const tk = [{ taskId: 't1', nodeId: 'a', status: 'running' }, { taskId: 't2', nodeId: 'a', status: 'queued' }]
  const tree = render(mkHub(nodes, { tasks: tk }), ['a'])
  const svg = findAll(tree, (n) => n.type === 'svg')[0]
  assert.equal(svg.props.role, 'group')
  assert.ok(String(svg.props['aria-label']).length > 0)
  const g = findAll(tree, (n) => n.type === 'g' && n.props.role === 'button')
  assert.equal(g.length, 4)
  for (const n of g) {
    assert.equal(n.props.tabIndex, 0)
    assert.ok(String(n.props['aria-label']).length > 0)
    assert.ok(n.props['aria-pressed'] === 'true' || n.props['aria-pressed'] === 'false')
  }
  const lab = (id) => g.find((n) => n.props['aria-label'].startsWith(id)).props['aria-label']
  assert.match(lab('a'), /在线.*直连.*探测 12ms.*1 运行 · 1 排队/)
  assert.match(lab('b'), /离线.*连接方式未知.*—.*无任务/)
  assert.match(lab('c'), /心跳超时.*中继/)
  assert.equal(g.find((n) => n.props['aria-label'].startsWith('a')).props['aria-pressed'], 'true')
  assert.equal(g.find((n) => n.props['aria-label'].startsWith('b')).props['aria-pressed'], 'false')
  // a glyph in each dot, so online / offline / stale differ without colour
  const glyphs = findAll(tree, (n) => n.type === 'text' && n.props.className === 'fl-glyph').map((n) => texts(n).join(''))
  assert.deepEqual(glyphs, ['✓', '✕', '!', '✓'])
  // the table lists every machine, including offline and stale ones, with a pin button each
  const table = findAll(tree, (n) => n.type === 'table')[0]
  const rows = findAll(table, (n) => n.type === 'tr' && n.kids.some((k) => k.type === 'th' && k.props.scope === 'row'))
  assert.equal(rows.length, 4)
  const rt = rows.map((r) => texts(r).join('|'))
  assert.ok(rt.some((t) => t.includes('b|离线')))
  assert.ok(rt.some((t) => t.includes('c|在线 · 心跳超时')))
  assert.equal(findAll(table, (n) => n.type === 'button').length, 4)
  // the live region only announces pin state and does not change when data refreshes
  const live = (t) => texts(findAll(t, (n) => n.props['aria-live'] === 'polite')[0]).join('')
  assert.equal(live(tree), '已固定：a')
  const refreshed = render(mkHub(fleet(['a', 'b'], { a: { connectivity: { transportMode: 'direct', probes: [{ rttMs: 77 }] } } })), ['a'])
  assert.equal(live(refreshed), '已固定：a')
  assert.equal(live(render(mkHub(nodes))), '')
})

test('stale data: a failed refresh keeps the last machines and pin and says so; a vanished pin is reported', () => {
  const nodes = fleet(ids(4))
  const stale = render(mkHub(nodes, { error: 'HTTP 502' }), ['n01'])
  assert.equal(findAll(stale, (n) => n.type === 'g' && n.props.role === 'button').length, 4)
  assert.ok(peerLines(stale).length > 0, 'a pinned machine still previews its peers on stale data')
  assert.match(texts(stale).join(''), /数据陈旧：刷新失败，显示最后一次成功的数据/)
  assert.doesNotMatch(texts(render(mkHub(nodes))).join(''), /数据陈旧/)
  const lost = texts(render(mkHub(nodes), ['gone'])).join('')
  assert.match(lost, /已固定的机器不在最新列表中/)
  assert.equal(findAll(render(mkHub(nodes), ['gone']), (n) => n.props && n.props['aria-pressed'] === 'true').length, 0)
})

/* ── 链路类别与连续失败（只影响显示） ──────────────────────────────── */

test('link category: only the reported transportMode counts; missing evidence is unknown', () => {
  const cases = [
    [{ transport: 'direct', connectivity: { transportMode: 'relay' }, hostname: 'pc.local' }, '未知'],
    [{ transportMode: 'relay' }, '中继'],
    [{ transportMode: 'direct', peerHost: '192.168.1.20' }, '局域网直连'],
    [{ transportMode: 'direct', peerHost: '203.0.113.8' }, '直连'],
    [{ transportMode: 'direct' }, '直连'],
    [{ transportMode: '', hostname: 'pc.local' }, '未知'],
    [{ transportMode: 'weird', hostname: 'pc.local' }, '未知'],
    [{ transportMode: { mode: 'direct' }, hostname: 'pc.local' }, '未知'],
    [{ transportMode: 'direct', hostname: 'public.example', peerHost: '10.0.0.4' }, '局域网直连'],
  ]
  for (const [fields, expected] of cases) assert.equal(fleetLinkKind({ nodeId: 'pc', online: true, ...fields }), expected, JSON.stringify(fields))
  assert.equal(fleetLinkKind({ nodeId: 'pc' }), '未知')
})

test('link health is display-only: failures count up per refresh, reset on recovery, and never change the status or layout', () => {
  const node = Object.freeze({ nodeId: 'pc', hostname: 'pc', online: true, transportMode: 'direct', connectivity: { probes: [{ rttMs: 31 }] } })
  const staleNode = Object.freeze({ ...node, stale: true, silentMs: 90_000, thresholdMs: 60_000 })
  const core = makeCore()
  const f = createFleet(core) // one instance across refreshes: the counter lives in it
  let tick = 0
  const health = (n) => {
    tick += 1
    const tree = expand(core.h(f.Machines, props(mkHub([n], { tick }))))
    return findAll(tree, (x) => x.type === 'span' && texts(x).join('').startsWith('健康：')).map((x) => texts(x).join(''))[0]
  }
  assert.match(health(staleNode), /^健康：探测失败 1\/2/)
  assert.match(health(staleNode), /^健康：连续失败/)
  assert.match(health({ ...node, stale: false }), /^健康：稳定/)
  assert.match(health(staleNode), /^健康：探测失败 1\/2/)
  assert.match(health({ ...node, stale: null }), /^健康：未知/)
  assert.equal(node.online, true)
  assert.equal(staleNode.stale, true)
  const m = fleetNodeModel(staleNode, null, 2)
  assert.equal(m.status, 'stale')
  assert.equal(m.edgeState, 'offline') // drawn as a broken link ...
  assert.equal(m.edgeLabel, '心跳超时') // ... with the reason in words
  assert.equal(m.rttText, '探测 31ms') // the last latency is still shown
  const geometry = (l) => plain({ nodes: l.nodes.map((q) => [q.id, q.x, q.y]), edges: l.edges, hub: l.hub })
  assert.deepEqual(geometry(fleetLayout({ models: [m] })), geometry(fleetLayout({ models: [fleetNodeModel(staleNode, null, 0)] }))) // the count does not move anything
})

test('rendering never probes the network or the clock', () => {
  const real = globalThis.fetch
  globalThis.fetch = () => { throw new Error('render must not fetch') }
  try {
    const nodes = [{ nodeId: 'pc', hostname: 'pc.local', online: true, stale: true, transportMode: 'direct' }]
    assert.doesNotThrow(() => render(mkHub(nodes)))
    const core = makeCore()
    assert.doesNotThrow(() => expand(core.h(createFleet(core).Machines, props(mkHub(nodes)))))
  } finally { globalThis.fetch = real }
})

test('empty and odd inputs render without throwing, on both screens', () => {
  for (const nodes of [[], [{ nodeId: 'pc', online: false }], [{ nodeId: 'pc', online: true }], [{ nodeId: 'pc' }]]) {
    for (const topology of [null, undefined, 'x', {}, { peerLinks: [] }]) {
      const hub = mkHub(nodes, { topology })
      assert.doesNotThrow(() => render(hub), JSON.stringify(nodes))
      const core = makeCore()
      assert.doesNotThrow(() => expand(core.h(createFleet(core).Machines, props(hub))), JSON.stringify(nodes))
    }
  }
})
