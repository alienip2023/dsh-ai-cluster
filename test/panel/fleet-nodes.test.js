// Node cards, heartbeat/RTT/trust display, LAN discovery card, transport summary and status merge,
// ported from the old client tests (ui-p2-node-card, ui-p3-rtt-trust, ui-p2-discovery, transport-summary, ui-s2-s5, mesh-obs-gap OBS-16).
import assert from 'node:assert/strict'
import test from 'node:test'
import { NodeRegistry } from '../../lib/hub/node-registry.js'
import { generateIdentity } from '../../lib/identity.js'
import { nodeView, summarizeTransportModes } from '../../lib/hub/views.js'
import { makeCore, makeReact, expand, texts, findAll } from './_fake.js'
import { dataEmptyHub, dataMergeNodes } from '../../src/panel/data.js'
import { createFleet, fleetDiscoveryRows, fleetLastSeen, fleetLoad, fleetMachInit, fleetSpark, fleetStatus } from '../../src/panel/fleet.js'

const NOW = Date.now()
const noop = () => {}
const props = (hub, extra = {}) => Object.assign({ hub, role: 'hub', go: noop, refresh: noop, ui: { confirm: async () => true, alert: noop, notify: noop, prompt: async () => null } }, extra)
const mkHub = (nodes, extra = {}) => Object.assign({}, dataEmptyHub, {
  loading: false, at: NOW, tick: 1, nodes, counts: { nodes: nodes.length, online: nodes.filter((n) => n.online).length, tasks: 0, running: 0, active: 0, done: 0, failed: 0 },
  connection: { everConnected: true, byNode: [], recent: [] },
}, extra)
/** One machines-screen render. `card(node)` returns the card's host tree and its flattened text. */
function machines(hub, state) {
  const core = makeCore({ state })
  const tree = expand(core.h(createFleet(core).Machines, props(hub)))
  return { tree, text: texts(tree).join('') }
}
function card(node, extra = {}) {
  const { tree } = machines(mkHub([node], extra))
  const article = findAll(tree, (n) => n.type === 'article')[0]
  return { article, text: texts(article).join('|') }
}
const buttonsOf = (tree, label) => findAll(tree, (n) => n.type === 'button' && texts(n).join('').includes(label))

/* ── 负载与状态 ─────────────────────────────────────────────────── */

test('card: a missing resource reports "负载未上报" and leaks no 0%', () => {
  const l = fleetLoad({ resource: null, silentMs: null })
  assert.equal(l.reported, false)
  const { text } = card({ nodeId: 'pc', online: true, resource: null, silentMs: null })
  assert.match(text, /负载未上报/)
  assert.doesNotMatch(text, /0%|0\/0/)
  assert.deepEqual(fleetLoad({}), { reported: false })
  assert.equal(fleetLoad({ resource: 5 }).reported, false)
})

test('card: a reported resource formats CPU and memory; non-finite values fall back to ?', () => {
  const l = fleetLoad({ resource: { cpuPct: 12.6, memUsedMb: 100, memTotalMb: 400 } })
  assert.deepEqual([l.reported, l.cpuLabel, l.memLabel], [true, '13%', '100/400 MB'])
  const bad = fleetLoad({ resource: { cpuPct: 'x', memUsedMb: NaN, memTotalMb: 400 } })
  assert.deepEqual([bad.cpuLabel, bad.memLabel], ['?', '?/400 MB'])
  const { text } = card({ nodeId: 'pc', online: true, resource: { cpuPct: 12.6, memUsedMb: 100, memTotalMb: 400 } })
  assert.match(text, /CPU\|13%/)
  assert.match(text, /内存\|100\/400 MB/)
})

test('card: offline, offline+stale, online+stale and online each say so; the card class follows the status', () => {
  const status = (c) => texts(findAll(c.article, (n) => n.type === 'span' && /dra-badge/.test(n.props.className))[0]).join('')
  const off = card({ nodeId: 'pc', online: false, stale: true })
  assert.equal(status(off), '离线')
  assert.match(off.text, /心跳超时/) // offline and silent: both are shown
  const stale = card({ nodeId: 'pc', online: true, stale: true })
  assert.equal(status(stale), '在线 · 心跳超时')
  assert.doesNotMatch(stale.text, /离线/)
  const on = card({ nodeId: 'pc', online: true })
  assert.equal(status(on), '在线')
  assert.doesNotMatch(on.text, /离线|心跳超时/)
  assert.equal(on.article.props.className, 'fl-card online')
  assert.equal(stale.article.props.className, 'fl-card stale')
  assert.equal(off.article.props.className, 'fl-card offline')
})

test('card: odd input degrades instead of throwing', () => {
  assert.equal(fleetStatus({ online: 'yes', stale: 1 }), 'offline')
  assert.equal(fleetStatus(undefined), 'offline')
  assert.doesNotThrow(() => card({}))
  assert.doesNotThrow(() => card({ nodeId: 'pc', online: 'yes', resource: 5, silentMs: '15000', stale: 'true' }))
})

test('card: the heartbeat line rounds seconds, accepts zero, and only an explicit stale === true is a timeout', () => {
  const a = card({ nodeId: 'pc-a', online: true, silentMs: 15500, stale: true })
  assert.match(a.text, /静默 16 秒/)
  assert.match(a.text, /心跳超时/)
  assert.match(a.text, /负载未上报/)
  assert.match(a.text, /在线 · 心跳超时/)
  assert.match(card({ nodeId: 'z', online: true, silentMs: 0 }).text, /静默 0 秒/)
  for (const silentMs of [undefined, null, '15000']) {
    const t = card({ nodeId: 'z', online: true, silentMs, stale: 'true' }).text
    assert.doesNotMatch(t, /静默/, String(silentMs))
    assert.doesNotMatch(t, /心跳超时/, String(silentMs))
  }
  assert.equal(fleetLastSeen({ online: true, silentMs: 15500 }, NOW), '静默 16 秒')
})

test('card: transport badge distinguishes direct, relay, unknown and offline', () => {
  for (const [transportMode, label] of [['direct', '直连'], ['relay', '中继'], [null, '连接方式未知'], [undefined, '连接方式未知'], ['other', '连接方式未知']]) {
    const { article } = card({ nodeId: 'node001', online: true, transportMode })
    const badges = findAll(article, (n) => n.props.className && /dra-badge/.test(n.props.className)).map((n) => texts(n).join(''))
    assert.ok(badges.includes(label), `${transportMode} -> ${label}: ${badges}`)
    assert.match(texts(article).join('|'), /在线/)
  }
  const offline = card({ nodeId: 'node001', online: false, transportMode: 'relay' })
  assert.match(offline.text, /离线/)
  const badges = findAll(offline.article, (n) => n.props.className && /dra-badge/.test(n.props.className)).map((n) => texts(n).join(''))
  assert.ok(badges.includes('—'), 'an offline machine has no live transport to claim')
})

/* ── RTT 折线与身份确认 ───────────────────────────────────────── */

test('RTT: a relay machine draws no latency line, even if samples were sent', () => {
  const registry = new NodeRegistry()
  try {
    registry.adoptRelaySummary({ nodeId: 'pc-relay', os: 'linux', transportMode: 'relay' })
    registry.tick()
    assert.equal(registry.peerRouter, undefined)
    const row = registry.list()[0]
    for (const node of [row, nodeView(row), { ...row, frameRttMs: [3, 4, 5] }]) {
      assert.ok(node.frameRttMs === undefined || Array.isArray(node.frameRttMs))
      const { article } = card({ ...node, online: true })
      assert.equal(findAll(article, (n) => n.type === 'polyline').length, 0)
      assert.equal(findAll(article, (n) => n.type === 'svg').length, 0)
    }
  } finally { registry.dispose() }
})

test('RTT: a direct machine draws its samples; one sample is a dot; [0, 12] maps to the full height', () => {
  assert.equal(fleetSpark([0, 12], 90, 18), '1,17 89,1')
  assert.equal(fleetSpark([5], 90, 18), null)
  const { article } = card({ nodeId: 'pc-direct', online: true, transportMode: 'direct', confirm: 'confirmed', frameRttMs: [0, 12] })
  assert.equal(findAll(article, (n) => n.type === 'polyline')[0].props.points, '1,17 89,1')
  const one = card({ nodeId: 'pc', online: true, transportMode: 'direct', frameRttMs: [7] }).article
  assert.equal(findAll(one, (n) => n.type === 'circle').length, 1)
})

test('trust: unknown identity is never shown as confirmed, and the badge is not an action', () => {
  const registry = new NodeRegistry({ identity: { ...generateIdentity(), privateKeyB64: 'invalid' } })
  try {
    registry.adoptRelaySummary({ nodeId: 'pc-invalid-signature', os: 'linux', transportMode: 'relay' })
    assert.equal(registry.list()[0].confirm, 'unknown')
    registry.identity = null
    registry.adoptRelaySummary({ nodeId: 'pc-no-identity', os: 'linux', transportMode: 'relay' })
    const row = nodeView(registry.list().find((n) => n.nodeId === 'pc-no-identity'))
    assert.equal(row.confirm, 'unknown')
    const { text } = card({ ...row, online: true })
    assert.match(text, /身份未确认/)
    assert.doesNotMatch(text, /已确认/)
  } finally { registry.dispose() }
  const { article } = card({ nodeId: 'pc-direct', online: true, transportMode: 'direct', confirm: 'confirmed', frameRttMs: [0, 12] })
  const badge = findAll(article, (n) => n.type === 'span' && texts(n).join('') === '身份已确认')[0]
  assert.ok(badge)
  assert.equal(Object.keys(badge.props).some((k) => k.startsWith('on')), false)
})

/* ── 采样时间每秒走字 ─────────────────────────────────────────── */

test('sample age ticks once a second, pauses when the page is hidden, and the timer is cleared on unmount', () => {
  const realNow = Date.now
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const realFetch = globalThis.fetch
  const hadDoc = Object.hasOwn(globalThis, 'document')
  let now = 10_000
  let timer
  const cleared = []
  const effects = []
  let bumps = 0
  Date.now = () => now
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  globalThis.setInterval = (fn, ms) => { assert.equal(ms, 1000); timer = fn; return 7 }
  globalThis.clearInterval = (id) => { cleared.push(id) }
  try {
    const R = makeReact()
    R.useEffect = (fn) => { effects.push(fn) }
    const origState = R.useState
    R.useState = (v) => { const [val] = origState(v); return [val, () => { bumps += 1 }] }
    const core = makeCore()
    core.React.useEffect = R.useEffect
    core.React.useState = R.useState
    const f = createFleet(core)
    const node = { nodeId: 'worker', online: true, connectivity: { sampledAt: 8_000 } }
    const show = () => texts(expand(core.h(f.Machines, props(mkHub([node]))))).join('')
    assert.match(show(), /采样 2s前/)
    const cleanups = effects.map((fn) => fn()).filter((x) => typeof x === 'function')
    assert.equal(typeof timer, 'function')
    now += 1000
    const before = bumps
    timer()
    assert.equal(bumps, before + 1)
    assert.match(show(), /采样 3s前/)
    globalThis.document = { hidden: true }
    timer()
    assert.equal(bumps, before + 1, 'a hidden page does not redraw')
    cleanups.forEach((c) => c())
    assert.ok(cleared.includes(7))
    assert.equal(node.connectivity.sampledAt, 8_000)
  } finally {
    Date.now = realNow
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
    globalThis.fetch = realFetch
    if (!hadDoc) delete globalThis.document
  }
})

/* ── 局域网发现 ───────────────────────────────────────────────── */

const peer = (o) => ({ node: 'n', hostname: 'x', role: 'worker', port: 1, pluginVersion: '1', at: 1, ...o })
const rowsOf = (peers, nodes = []) => fleetDiscoveryRows({ enabled: true, peers }, nodes).rows

test('discovery: disabled means no rows', () => {
  const r = fleetDiscoveryRows({ enabled: false, peers: [peer({})] }, [])
  assert.deepEqual([r.enabled, r.rows.length], [false, 0])
})

test('discovery: LAN names are kept, public and domain names hidden, order preserved', () => {
  const hosts = ['10.0.0.7', '192.168.1.20', 'nas.local', 'build01', '203.0.113.9', 'evil.example.com']
  const rows = rowsOf(hosts.map((h, i) => peer({ node: 'p' + i, hostname: h })))
  assert.deepEqual(rows.map((r) => r.node), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'])
  assert.deepEqual(rows.map((r) => r.addressLabel), ['10.0.0.7', '192.168.1.20', 'nas.local', 'build01', '地址已隐藏（203.•••）', '地址已隐藏（evil.•••）'])
  assert.deepEqual(Object.keys(rows[0]).sort(), ['addressLabel', 'node', 'port', 'role', 'version'])
})

test('discovery: range edges and IPv6', () => {
  const hosts = ['172.16.0.1', '172.31.9.9', '172.32.0.1', '127.0.0.1', '169.254.1.1', '8.8.8.8', '::1', 'fe80::1', '192.169.0.1']
  assert.deepEqual(rowsOf(hosts.map((h, i) => peer({ node: 'q' + i, hostname: h }))).map((r) => r.addressLabel),
    ['172.16.0.1', '172.31.9.9', '地址已隐藏（172.•••）', '127.0.0.1', '169.254.1.1', '地址已隐藏（8.•••）', '地址已隐藏（:•••）', '地址已隐藏（fe80:•••）', '地址已隐藏（192.•••）'])
})

test('discovery: peers that are already paired are excluded', () => {
  assert.equal(rowsOf([peer({ node: 'node009' })], [{ nodeId: 'node009' }]).length, 0)
  assert.equal(rowsOf([peer({ node: 'other', hostname: '10.0.0.9' })], [{ nodeId: '10.0.0.9' }]).length, 0)
  assert.equal(rowsOf([peer({ node: 'other', hostname: 'box' })], [{ nodeId: 'z', hostname: 'box' }]).length, 0)
  assert.equal(rowsOf([peer({ node: 'other', hostname: 'box' })], [{ nodeId: 'z', peerHost: 'box' }]).length, 0)
  assert.equal(rowsOf([peer({ node: 'other', hostname: 'box2' })], [{ nodeId: 'z', hostname: 'box' }]).length, 1)
})

test('discovery: a missing hostname is reported as not reported', () => {
  assert.deepEqual(rowsOf([peer({ hostname: undefined }), peer({ node: 'm', hostname: '' })]).map((r) => r.addressLabel), ['地址未上报', '地址未上报'])
})

test('discovery card: a switch and a scan button, nothing to act on the peers, and the toggle posts the opposite state', async () => {
  const posts = []
  const real = globalThis.fetch
  globalThis.fetch = (url, init) => {
    posts.push([url, JSON.parse(init.body)])
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, discovery: { enabled: true, configured: true, peers: [] } }) })
  }
  try {
    const off = machines(mkHub([], { discovery: { enabled: false, peers: [] } }))
    const sw = buttonsOf(off.tree, '点此开启')[0]
    assert.equal(sw.props.role, 'switch')
    assert.equal(sw.props['aria-checked'], 'false')
    const scanOff = buttonsOf(off.tree, '扫描')[0]
    assert.equal(scanOff.props.disabled, true)
    sw.props.onClick()
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(posts, [['/api/ai-cluster/ui/discovery/toggle', { enabled: true }]])

    const on = machines(mkHub([], { discovery: { enabled: true, peers: [peer({ node: 'private-name', hostname: '10.0.0.10', role: 'node', port: 19387 })] } }))
    const sw2 = buttonsOf(on.tree, '点此关闭')[0]
    assert.equal(sw2.props['aria-checked'], 'true')
    const scan = buttonsOf(on.tree, '扫描')[0]
    assert.equal(scan.props.disabled, false)
    sw2.props.onClick()
    scan.props.onClick()
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(posts.slice(1).map((p) => p[0]), ['/api/ai-cluster/ui/discovery/toggle', '/api/ai-cluster/ui/discovery/scan'])
    assert.deepEqual(posts[1][1], { enabled: false })
    assert.match(on.text, /局域网发现/)
    assert.match(on.text, /10\.0\.0\.10 · node · 端口 19387/)
    assert.doesNotMatch(on.text, /private-name|连接/)
    const card = findAll(on.tree, (n) => n.type === 'section' && n.props['aria-label'] === '局域网发现')[0]
    assert.deepEqual(findAll(card, (n) => n.type === 'button').map((b) => texts(b).join('')), ['已开启 · 点此关闭', '扫描'])
  } finally { globalThis.fetch = real }
})

test('discovery card: a failed action shows its error and a pending one disables both buttons', () => {
  // Machines hooks with no machines: the store state first, then the discovery card's busy / error / override
  const shown = machines(mkHub([], { discovery: { enabled: true, configured: true, peers: [] } }), [fleetMachInit, false, '局域网发现操作失败：discovery-inactive', null])
  const alert = findAll(shown.tree, (n) => n.type === 'p' && n.props.role === 'alert')[0]
  assert.equal(texts(alert).join(''), '局域网发现操作失败：discovery-inactive')
  const busy = machines(mkHub([], { discovery: { enabled: true, configured: true, peers: [] } }), [fleetMachInit, true, '', null])
  assert.ok(['点此关闭', '扫描'].every((l) => buttonsOf(busy.tree, l)[0].props.disabled === true))
})

/* ── 连接方式汇总：真实路由 → 总览 ─────────────────────────────── */

test('overview shows the hub transport summary from real reports as machines change state', async () => {
  const { registerUiRoutes } = await import('../../src/http/index.js')
  const registry = new NodeRegistry({ log() {} })
  const routes = new Map()
  const disposers = registerUiRoutes({
    ctx: { webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => {} } } },
    registry, pulls: { activeCount: 0 }, log() {},
    config: { role: 'hub', transportMode: 'relay' },
  })
  try {
    for (const [reports, label] of [
      [Array(8).fill('direct'), '直连'],
      [Array(8).fill('relay'), '中继'],
      [['direct', 'relay', 'direct'], '混合（直连 2 台 / 中继 1 台）'],
      [[undefined], '未知（1 台在线节点未上报有效连接方式）'],
      [[], '未知（暂无在线节点）'],
    ]) {
      registry.nodes.clear()
      reports.forEach((transportMode, i) => registry.nodes.set(`node00${i + 1}`, { nodeId: `node00${i + 1}`, online: true, hello: { transportMode }, tasks: new Map() }))
      registry.nodes.set('offline', { nodeId: 'offline', online: false, hello: { transportMode: 'relay' }, tasks: new Map() }) // history must not count
      let response
      let status
      await routes.get('/api/ai-cluster/ui/overview')({ method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, { writeHead(code) { status = code }, end(body) { response = JSON.parse(body) } })
      assert.equal(status, 200)
      assert.equal(response.transportSummary.label, label)
      const hub = mkHub(response.nodes, { transportSummary: response.transportSummary, topology: response.topology, caps: response.capabilities, connection: response.connection })
      const core = makeCore()
      const text = texts(expand(core.h(createFleet(core).Overview, props(hub)))).join('')
      assert.ok(text.includes('连接方式：' + label), label)
      if (reports.length === 1 && reports[0] === undefined) assert.equal(response.nodes[0].transportMode, null)
    }
  } finally { for (const d of disposers) d() }
})

test('transport summary is computed from reports only (never from local config)', () => {
  const online = (transportMode) => ({ online: true, transportMode })
  assert.equal(summarizeTransportModes([online('direct'), online('relay')]).mode, 'mixed')
  const hub = mkHub([online('relay')], { transportSummary: summarizeTransportModes([online('direct')]) })
  const core = makeCore()
  assert.match(texts(expand(core.h(createFleet(core).Overview, props(hub)))).join(''), /连接方式：直连/)
})

/* ── /node-status 并入 /overview 的节点行 ─────────────────────── */

test('status merge: only the status fields are merged by nodeId and everything else is preserved', () => {
  const node = { nodeId: 'pc-a', online: true, roots: ['/work'], caps: ['exec'], models: [{ id: 'model-a' }], taskCount: 3, transportMode: 'direct' }
  const unmatched = { nodeId: 'pc-b', online: false }
  const overview = { nodes: [node, unmatched], counts: { nodes: 2 }, topology: { nodes: [] } }
  const row = {
    nodeId: 'pc-a', resource: { cpuPct: 12 }, connectivity: { transportMode: 'direct' }, queue: { running: 1 }, silentMs: 15500, stale: true, thresholdMs: 15000,
    online: false, roots: [], caps: [], models: [], taskCount: 99, transportMode: 'relay',
  }
  const merged = dataMergeNodes(overview, { nodes: [{ nodeId: 'status-only' }, row] })
  assert.equal(merged.nodes.length, 2)
  assert.deepEqual(Object.keys(merged.nodes[0]).sort(), [...Object.keys(node), 'resource', 'connectivity', 'queue', 'silentMs', 'stale', 'thresholdMs'].sort())
  for (const key of Object.keys(node)) assert.equal(merged.nodes[0][key], node[key], key)
  for (const key of ['resource', 'connectivity', 'queue', 'silentMs', 'stale', 'thresholdMs']) assert.equal(merged.nodes[0][key], row[key], key)
  assert.equal(merged.nodes[1], unmatched)
  assert.equal(merged.counts, overview.counts)
  assert.equal(merged.topology, overview.topology)
  assert.equal(Object.hasOwn(node, 'resource'), false)
})

test('status merge: a missing or failed node-status keeps the overview untouched; absent fields add no resource', () => {
  const overview = { nodes: [{ nodeId: 'pc-a', online: true }] }
  assert.equal(dataMergeNodes(overview, null), overview)
  assert.equal(dataMergeNodes(overview, { nodes: 'nope' }), overview)
  assert.equal(Object.hasOwn(overview.nodes[0], 'resource'), false)
  const merged = dataMergeNodes(overview, { nodes: [{ nodeId: 'pc-a', silentMs: null }] })
  assert.equal(Object.hasOwn(merged.nodes[0], 'resource'), false)
  assert.equal(merged.nodes[0].silentMs, null)
})
