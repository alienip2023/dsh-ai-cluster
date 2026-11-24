import assert from 'node:assert/strict'
import test from 'node:test'
import { makeCore, expand, texts, textOf, findAll, findButtons } from './_fake.js'
import { dataEmptyHub, dataAttachLink } from '../../src/panel/data.js'
import {
  createFleet, fleetActivity, fleetActivityText, fleetAttemptRows, fleetBacklog, fleetBacklogTotals, fleetConnLine, fleetCut,
  fleetDiscoveryRows, fleetErrText, fleetHealth, fleetIsLan, fleetLastSeen, fleetLayout, fleetLinkKind, fleetListenerNotice, fleetLoad, fleetMachFlow,
  fleetMachInit, fleetMachReduce, fleetNodeModel, fleetNotices, fleetPeerModel, fleetProbeRows, fleetQueue,
  fleetRelayStatus, fleetRtt, fleetRttText, fleetSpark, fleetStaleCounts, fleetStaleLabel, fleetStatus, fleetTransport, fleetTransportLine,
  fleetTunnelLine, fleetVersion, fleetVersionText,
} from '../../src/panel/fleet.js'

const NOW = Date.now()

const nodeA = {
  nodeId: 'node-alpha-0001', hostname: 'alpha', online: true, os: 'linux', arch: 'x64', agentMode: true, runnerKind: 'agent', caps: ['exec', 'agent'],
  since: NOW - 3600_000, lastSeen: NOW - 2000, taskCount: 4, repos: ['repo-a'], transportMode: 'direct', confirm: 'confirmed', peerCapable: true,
  frameRttMs: [3, 4, 2, 5],
  connectivity: { transportMode: 'direct', tunnelState: 'ready', tunnel: { kind: 'ssh', server: 'relay.example', localPort: 1, remotePort: 2 }, probes: [{ target: 'hub:19387', result: 'open', rttMs: 7 }, { target: 'hub:8890', result: 'closed', rttMs: null }], sampledAt: NOW - 5000 },
  resource: { cpuPct: 41.6, memUsedMb: 2048, memTotalMb: 4096, at: NOW - 1000 },
  queue: { queued: 2, running: 1, maxConcurrent: 1, oldestQueuedMs: 130000, starved: true },
  silentMs: 2000, stale: false, acVersion: '0.4.36',
  link: { pending: 3, oldestMs: 125000, maxTries: 4, types: { 'work/x': 2, 'bot/y': 1 } },
}
const nodeB = { nodeId: 'node-beta-0002', hostname: 'beta', online: true, os: 'darwin', arch: 'arm64', transportMode: 'relay', peerCapable: true, taskCount: 0, lastSeen: NOW, acVersion: '0.4.30', stale: true, silentMs: 400000, confirm: 'unknown' }
const nodeC = { nodeId: 'node-gamma-0003', hostname: 'gamma', online: false, os: 'win32', arch: 'x64', taskCount: 1, lastSeen: NOW - 7200_000, stale: true, resource: null }

const topo = {
  nodes: [{ nodeId: nodeA.nodeId, online: true, peerCapable: true }, { nodeId: nodeB.nodeId, online: true, peerCapable: true }, { nodeId: nodeC.nodeId, online: false, peerCapable: false }],
  peerLinks: [{ from: nodeA.nodeId, to: nodeB.nodeId }, { from: nodeB.nodeId, to: nodeA.nodeId }, { from: nodeA.nodeId, to: nodeC.nodeId }, { from: 'x', to: 'x' }],
  summary: { total: 3, online: 2, direct: 1, relay: 1, unknown: 1, peerCapable: 2, tunnelReady: 1, tunnelError: 0 },
}

function mkHub(patch = {}) {
  const nodes = patch.nodes || [nodeA, nodeB, nodeC]
  return Object.assign({}, dataEmptyHub, {
    loading: false, at: NOW, tick: 1, nodes,
    tasks: [{ taskId: 't1', nodeId: nodeA.nodeId, status: 'running' }, { taskId: 't2', nodeId: nodeA.nodeId, status: 'queued' }, { taskId: 't3', nodeId: nodeB.nodeId, status: 'failed' }],
    counts: { nodes: nodes.length, online: nodes.filter((n) => n.online).length, tasks: 3, running: 1, active: 2, done: 5, failed: 1 },
    connection: { everConnected: true, byNode: [], recent: [] },
    topology: topo, transportSummary: { mode: 'mixed', label: '混合（直连 1 台 / 中继 1 台）' },
  }, patch)
}

const props = (hub, extra = {}) => Object.assign({ hub, role: 'hub', go() {}, refresh() {}, ui: { confirm: () => Promise.resolve(true), alert() {}, notify() {}, prompt: () => Promise.resolve(null) } }, extra)
const render = (Comp, p, state) => { const core = makeCore({ state }); const f = createFleet(core); return core.h(f[Comp], p) }
/* The fake useState queue is consumed by the first expansion, so a test that injects state expands exactly once and queries that tree. */
const view = (Comp, p, state) => { const tree = expand(render(Comp, p, state)); return { tree, text: texts(tree).join('') } }

/* ── 纯函数 ──────────────────────────────────────────────────────── */

test('version: absent is unknown, older is old', () => {
  assert.deepEqual(fleetVersion({ acVersion: '0.4.36' }), { version: '0.4.36', state: 'ok' })
  assert.equal(fleetVersion({ acVersion: '0.4.33' }).state, 'old')
  assert.equal(fleetVersion({ acVersion: '0.10.0' }).state, 'ok')
  assert.equal(fleetVersion({}).state, 'unknown')
  assert.equal(fleetVersion({ acVersion: 'weird' }).state, 'unknown')
  assert.equal(fleetVersionText({}), '版本未知')
  assert.match(fleetVersionText({ acVersion: '0.4.30' }), /v0\.4\.30 · 低于 0\.4\.34/)
})

test('backlog: only pending>0, sorted types, totals', () => {
  assert.equal(fleetBacklog({}), null)
  assert.equal(fleetBacklog({ link: { pending: 0 } }), null)
  const b = fleetBacklog(nodeA)
  assert.equal(b.pending, 3)
  assert.deepEqual(b.types, [['work/x', 2], ['bot/y', 1]])
  assert.equal(b.text, '3 条待送达，最久等了 2m5s')
  assert.equal(fleetBacklog({ link: { pending: 1, oldestMs: null }, online: false }).text, '1 条待送达')
  const t = fleetBacklogTotals([nodeA, nodeB, Object.assign({}, nodeC, { link: { pending: 2, oldestMs: 1, maxTries: 0, types: {} } })])
  assert.equal(t.total, 5)
  assert.equal(t.rows.length, 2)
  // dataAttachLink output feeds straight in
  const [attached] = dataAttachLink([{ nodeId: 'a', online: false }], { nodes: [{ nodeId: 'a', pending: 7, oldestMs: 61000, maxTries: 2, types: { t: 7 } }] })
  assert.equal(fleetBacklog(attached).pending, 7)
})

test('status / stale / transport / rtt labels', () => {
  assert.equal(fleetStatus(nodeA), 'online')
  assert.equal(fleetStatus(nodeB), 'stale')
  assert.equal(fleetStatus(nodeC), 'offline') // offline wins over stale
  assert.equal(fleetStatus(null), 'offline')
  assert.equal(fleetStaleLabel(nodeB, NOW), '心跳超时')
  assert.equal(fleetStaleLabel(nodeC, NOW), '心跳超时') // offline nodes keep the flag too
  assert.equal(fleetStaleLabel(Object.assign({}, nodeC, { stale: false }), NOW), '')
  assert.equal(fleetStaleLabel(Object.assign({}, nodeA, { connectivity: { sampledAt: NOW - 700_000 } }), NOW), '采样陈旧')
  assert.equal(fleetStaleLabel(nodeA, NOW), '')
  assert.equal(fleetTransport(nodeA), 'direct')
  assert.equal(fleetTransport({ connectivity: { transportMode: 'relay' } }), 'relay')
  assert.equal(fleetTransport({ transportMode: 'bogus' }), 'unknown')
  assert.deepEqual(fleetRtt(nodeA), { kind: 'frame', ms: 5 })
  assert.deepEqual(fleetRtt({ connectivity: { probes: [{ rttMs: 9 }, { rttMs: 4.4 }, { rttMs: null }] } }), { kind: 'probe', ms: 4 })
  assert.equal(fleetRtt({ connectivity: { probes: [{ rttMs: null }] } }), null)
  assert.equal(fleetRttText(nodeA), '帧 RTT 5ms')
  assert.equal(fleetRttText(nodeB), '延迟未测')
  assert.equal(fleetRttText(nodeC), '—')
  assert.equal(fleetLinkKind({ transportMode: 'direct', peerHost: '192.168.1.8' }), '局域网直连')
  assert.equal(fleetLinkKind({ transportMode: 'direct', peerHost: '8.8.8.8' }), '直连')
  assert.equal(fleetLinkKind({ transportMode: 'relay' }), '中继')
  assert.equal(fleetLinkKind({}), '未知')
})

test('LAN rules', () => {
  for (const h of ['10.1.2.3', '172.16.0.1', '172.31.9.9', '192.168.0.5', '169.254.1.1', '127.0.0.1', 'box.local', 'mybox']) assert.equal(fleetIsLan(h), true, h)
  for (const h of ['8.8.8.8', '172.32.0.1', '300.1.1.1', 'example.com', 'fe80::1']) assert.equal(fleetIsLan(h), false, h)
  assert.equal(fleetIsLan('fe80::1', true), true)
  assert.equal(fleetIsLan('[::1]', true), true)
})

test('load / queue / connectivity lines / spark / last seen', () => {
  assert.deepEqual(fleetLoad({}), { reported: false })
  const l = fleetLoad(nodeA)
  assert.equal(l.cpuLabel, '42%')
  assert.equal(l.memLabel, '2048/4096 MB')
  assert.equal(l.memPct, 50)
  assert.equal(fleetLoad({ resource: { cpuPct: null, memUsedMb: null, memTotalMb: null } }).cpuLabel, '?')
  assert.equal(fleetQueue({}), null)
  const q = fleetQueue(nodeA)
  assert.equal(q.starved, true)
  assert.equal(q.text, '排队 2 · 运行 1/1')
  assert.match(q.warn, /2m10s/)
  assert.equal(fleetConnLine({}, NOW), '链路详情未上报')
  assert.equal(fleetConnLine(nodeA, NOW), '隧道 就绪 · 探测 1/2 可达 · 采样 5s前')
  assert.match(fleetConnLine({ connectivity: { tunnelState: 'error', probes: [], sampledAt: NOW - 700_000 } }, NOW), /隧道 异常.*陈旧/)
  assert.deepEqual(fleetProbeRows(nodeA).map((r) => [r.target, r.text, r.ok]), [['hub:19387', '可达', true], ['hub:8890', '拒绝', false]])
  assert.equal(fleetTunnelLine(nodeA, true), 'ssh · relay.example · 1→2')
  assert.equal(fleetTunnelLine(nodeA), 'ssh · relay.••• · 1→2') // public tunnel servers are masked by default
  assert.equal(fleetTunnelLine({}), '')
  assert.equal(fleetSpark([5], 90, 18), null)
  assert.equal(fleetSpark([1, 2, 4], 90, 18).split(' ').length, 3)
  assert.equal(fleetLastSeen(nodeA, NOW), '静默 2 秒')
  assert.match(fleetLastSeen(nodeC, NOW), /最后在线 .*（2h0m前）/)
  assert.equal(fleetCut('abcdefghij', 5), 'abcd…')
})

test('stale hysteresis counts and health label', () => {
  let c = fleetStaleCounts({}, [{ nodeId: 'a', stale: true }, { nodeId: 'b', stale: false }, { nodeId: 'c', stale: null }])
  assert.deepEqual(c, { a: 1, b: 0 })
  c = fleetStaleCounts(c, [{ nodeId: 'a', stale: true }, { nodeId: 'b', stale: true }, { nodeId: 'c', stale: null }])
  assert.deepEqual(c, { a: 2, b: 1 })
  c = fleetStaleCounts(c, [{ nodeId: 'a', stale: false }])
  assert.deepEqual(c, { a: 0 })
  assert.equal(fleetHealth({ stale: false }, 0), '健康：稳定')
  assert.equal(fleetHealth({ stale: true }, 1), '健康：探测失败 1/2')
  assert.equal(fleetHealth({ stale: true }, 2), '健康：连续失败')
  assert.equal(fleetHealth({}, 0), '健康：未知')
})

test('activity per node', () => {
  const a = fleetActivity(mkHub().tasks)
  assert.deepEqual(a[nodeA.nodeId], { running: 1, queued: 1, done: 0, failed: 0, total: 2 })
  assert.equal(fleetActivityText(a[nodeA.nodeId]), '1 运行 · 1 排队')
  assert.equal(fleetActivityText(a[nodeB.nodeId]), '1 失败')
  assert.equal(fleetActivityText(undefined), '无任务')
  assert.equal(fleetActivity([{ taskId: 'x', nodeId: 'n', status: 'interrupted' }]).n.failed, 1)
})

test('relay status is three-state and listener notices say what is wrong', () => {
  assert.equal(fleetRelayStatus(null, null), 'unreported')
  assert.equal(fleetRelayStatus(null, { reachable: true }), 'reachable')
  assert.equal(fleetRelayStatus({ relayReachable: false }, { reachable: true }), 'unreachable')
  assert.equal(fleetListenerNotice(null, NOW), null)
  assert.equal(fleetListenerNotice({ ok: true, state: 'listening' }, NOW), null)
  assert.match(fleetListenerNotice({ ok: false, state: 'waiting-port', waitingSince: NOW - 12000 }, NOW).body, /等待释放（已等待 12 秒）/)
  assert.match(fleetListenerNotice({ ok: false, disabled: 'config' }, NOW).body, /已关闭（config）/)
  assert.match(fleetListenerNotice({ ok: false, error: 'EADDRINUSE' }, NOW).body, /启动失败：EADDRINUSE/)
  assert.match(fleetListenerNotice({ ok: false }, NOW).body, /尚未就绪/)
})

test('notices: loopback, listener, never connected, old version, backlog', () => {
  assert.deepEqual(fleetNotices(mkHub(), NOW).map((n) => n.key), ['old', 'backlog'])
  const hub = mkHub({
    caps: { reachability: { loopback: true, hint: '改监听地址', bound: '127.0.0.1', port: 19387 }, listener: { ok: false, error: 'EADDRINUSE' } },
    connection: { everConnected: false, byNode: [], recent: [], reachability: { hint: '防火墙拦了' } },
  })
  const n = fleetNotices(hub, NOW)
  assert.deepEqual(n.map((x) => x.key), ['loopback', 'listener', 'never', 'old', 'backlog'])
  assert.equal(n[0].tone, 'err')
  assert.match(n[0].body, /改监听地址 当前绑定 127\.0\.0\.1:19387/)
  assert.match(n.find((x) => x.key === 'never').body, /有 3 个节点登记过.*0\.0\.0\.0.*诊断：防火墙拦了/)
  assert.match(n.find((x) => x.key === 'backlog').body, /没有超时.*alpha（在线，补发中）：3 条待送达/)
  assert.match(n.find((x) => x.key === 'old').title, /1 台机器的 AC 版本低于 0\.4\.34/)
  // fleet never connected and nothing registered: no noise
  assert.deepEqual(fleetNotices(mkHub({ nodes: [], connection: { everConnected: false, recent: [] } }), NOW), [])
  // unknown version alone raises no banner
  assert.deepEqual(fleetNotices(mkHub({ nodes: [nodeC] }), NOW), [])
  // loopback hint is not repeated as a diagnosis
  const dup = fleetNotices(mkHub({ nodes: [], caps: { reachability: { loopback: true, hint: 'H' } }, connection: { everConnected: false, recent: [{ at: 1, result: 'fail' }] } }), NOW)
  assert.equal(dup.find((x) => x.key === 'never').body.includes('诊断'), false)
})

test('connection attempts and transport line', () => {
  const rows = fleetAttemptRows({ recent: [{ at: 5, result: 'fail', code: 'E1', title: '握手超时', remote: '10.0.0.2', nodeId: 'n', detail: 'd', hint: 'h' }, { at: 4, result: 'ok' }] })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].title, '握手超时')
  assert.equal(rows[1].title, '连接成功')
  assert.deepEqual(fleetAttemptRows(null), [])
  assert.equal(fleetTransportLine(mkHub()), '连接方式：混合（直连 1 台 / 中继 1 台）　直连 1 · 中继 1 · 未知 1　隧道就绪 1')
  assert.equal(fleetTransportLine({}), '')
})

test('peer candidates: dedupe, drop invalid, cap, neighbors', () => {
  const m = fleetPeerModel(topo, [nodeA, nodeB, nodeC])
  assert.deepEqual(m.pairs, [[nodeA.nodeId, nodeB.nodeId]])
  assert.equal(m.dropped, 2) // x>x and the offline gamma endpoint
  assert.deepEqual(m.neighbors[nodeA.nodeId], [nodeB.nodeId])
  assert.match(m.label, /服务端计数 2 台 · 收到 1 对有效候选 · 2 条被丢弃/)
  assert.equal(m.badge(nodeA.nodeId), '对等 1')
  assert.equal(m.badge(nodeC.nodeId), '—')
  assert.equal(fleetPeerModel(null, []).state, 'missing')
  assert.equal(fleetPeerModel(null, []).badge('x'), '')
  assert.match(fleetPeerModel({ peerLinks: [], summary: { peerCapable: 1 } }, []).label, /不足 2 台/)
  const many = Array.from({ length: 60 }, (_, i) => ({ from: 'a' + i, to: 'b' + i }))
  const capped = fleetPeerModel({ peerLinks: many, nodes: [], summary: {} }, [])
  assert.equal(capped.capped, true)
  assert.match(capped.label, /已达服务端上限 60/)
})

test('discovery rows: LAN names only, paired machines removed', () => {
  assert.deepEqual(fleetDiscoveryRows(null, []), { enabled: false, rows: [] })
  assert.deepEqual(fleetDiscoveryRows({ enabled: false, peers: [{ hostname: 'x' }] }, []), { enabled: false, rows: [] })
  const d = fleetDiscoveryRows({
    enabled: true,
    peers: [
      { node: nodeA.nodeId, hostname: '10.0.0.1', role: 'node', port: 1 }, // paired by node id
      { node: 'p2', hostname: 'beta', role: 'node', port: 2 }, // paired by hostname
      { node: 'p3', hostname: '192.168.1.20', role: 'node', port: 19387, pluginVersion: '0.4.36' },
      { node: 'p4', hostname: '203.0.113.9', role: 'hub', port: 3 },
      { node: 'p5', hostname: '', role: 'node', port: 4 },
      null,
    ],
  }, [nodeA, nodeB])
  assert.deepEqual(d.rows.map((r) => [r.node, r.addressLabel, r.version]), [['p3', '192.168.1.20', '0.4.36'], ['p4', '地址已隐藏（203.•••）', ''], ['p5', '地址未上报', '']])
})

test('layout is deterministic, bounded, two rings past 8 nodes, relay box only when down', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => fleetNodeModel({ nodeId: 'n' + String(i).padStart(2, '0'), online: i % 2 === 0, transportMode: 'direct' }, null, 0))
  const a = fleetLayout({ models: mk(5) })
  assert.deepEqual(a, fleetLayout({ models: mk(5).reverse() })) // order of input does not matter
  assert.equal(a.height, 320)
  assert.equal(a.relay, null)
  for (const p of a.nodes) assert.ok(p.x > 40 && p.x < a.width - 40 && p.y > 20 && p.y < a.height - 20)
  const b = fleetLayout({ models: mk(12), relayDown: true })
  assert.equal(b.height, 440)
  assert.equal(b.nodes.length, 12)
  for (const p of b.nodes) assert.ok(p.x > 56 && p.x < b.width - 56 && p.y > 20 && p.y + 42 < b.height, 'label stays inside the viewBox')
  for (let n = 9; n <= 40; n += 1) for (const p of fleetLayout({ models: mk(n) }).nodes) assert.ok(p.y + 42 < 440 && p.x > 56 && p.x < 584)
  assert.ok(b.relay)
  assert.equal(new Set(b.nodes.map((p) => p.x + ',' + p.y)).size, 12) // no two nodes on the same spot
  assert.equal(b.edges.length, 12)
  assert.deepEqual(fleetLayout({}).nodes, [])
  const m = fleetNodeModel(nodeC, null, 0)
  assert.equal(m.edgeState, 'offline')
  assert.equal(m.edgeLabel, '离线')
  assert.equal(fleetNodeModel(nodeA, { running: 1, queued: 0, done: 0, failed: 0, total: 1 }, 0).edgeState, 'running')
  assert.equal(fleetNodeModel(nodeA, { running: 0, queued: 1, done: 0, failed: 0, total: 1 }, 0).edgeLabel, '直连 5ms')
})

/* ── 接入流程（配对码 / 入网口令） ──────────────────────────────────────────────── */

test('reducer transitions', () => {
  let s = fleetMachInit
  s = fleetMachReduce(s, { type: 'show', value: true })
  assert.equal(s.showPublic, true)
  s = fleetMachReduce(s, { type: 'show', value: 'yes' })
  assert.equal(s.showPublic, false) // only an explicit true turns it on
  s = fleetMachReduce(s, { type: 'patch', key: 'enroll', value: { loading: true } })
  assert.equal(s.enroll.loading, true)
  assert.equal(fleetMachReduce(s, { type: 'nope' }), s)
  assert.equal(fleetMachInit.enroll.loading, false) // initial state never mutated
  assert.deepEqual(Object.keys(fleetMachInit).sort(), ['enroll', 'pair', 'showPublic'])
})

function mkIo(script) {
  const calls = []
  let state = fleetMachInit
  const handler = async (method, path, body) => {
    calls.push([method, path, body])
    const r = script(method, path, body, calls)
    if (r instanceof Error) throw r
    return r
  }
  const io = {
    get: (p) => handler('GET', p), post: (p, b) => handler('POST', p, b),
    dispatch: (e) => { state = fleetMachReduce(state, e) }, now: () => 0, port: () => '8080',
  }
  return { io, calls, get state() { return state } }
}
const httpErr = (status, body) => Object.assign(new Error(body.message || body.error), { status, body })

test('flow: pair info and enrollment token', async () => {
  const t = mkIo((m, p) => {
    if (p.startsWith('/pair-info')) { assert.equal(p, '/pair-info?port=8080'); return { ok: true, codes: [{ address: '1', pairCode: 'abc', usable: true }], listener: { host: '10.0.0.1', port: 19387 } } }
    return { token: 'TOK123', expiresInMs: 900000 }
  })
  const f = fleetMachFlow(t.io)
  await f.loadPair()
  assert.equal(t.state.pair.data.codes.length, 1)
  await f.mint()
  assert.deepEqual(t.state.enroll.data, { token: 'TOK123', expiresAt: 900000, expiresInMs: 900000 })
  const bad = mkIo(() => httpErr(400, { error: 'not-relay', message: '未配置中继地址和口令' }))
  await fleetMachFlow(bad.io).mint()
  assert.equal(bad.state.enroll.error, '铸造失败：未配置中继地址和口令（not-relay）')
  const empty = mkIo(() => ({ ok: true }))
  await fleetMachFlow(empty.io).mint()
  assert.match(empty.state.enroll.error, /没有返回口令/)
  const noExp = mkIo(() => ({ token: 'T' }))
  await fleetMachFlow(noExp.io).mint()
  assert.equal(noExp.state.enroll.data.expiresAt, null)
  const pairBad = mkIo(() => httpErr(500, { error: 'x' }))
  await fleetMachFlow(pairBad.io).loadPair()
  assert.equal(pairBad.state.pair.note, '配对码读取失败：x')
})

test('fleetErrText keeps both the readable message and the stable code', () => {
  assert.equal(fleetErrText(new Error('plain')), 'plain')
  assert.equal(fleetErrText(httpErr(400, { error: 'c', message: 'm' })), 'm（c）')
  assert.equal(fleetErrText(httpErr(400, { error: 'same', message: 'same' })), 'same')
})

/* ── 组件 ───────────────────────────────────────────────────────── */

test('overview: empty, loading and error states', () => {
  const empty = textOf(render('Overview', props(mkHub({ nodes: [], tasks: [], counts: dataEmptyHub.counts }))))
  assert.match(empty, /还没有任何机器接入/)
  assert.match(empty, /去「机器」添加/)
  const loading = textOf(render('Overview', props(dataEmptyHub)))
  assert.match(loading, /读取中…/)
  const err = textOf(render('Overview', props(mkHub({ error: 'HTTP 500' }))))
  assert.match(err, /数据陈旧：刷新失败，显示最后一次成功的数据/)
})

test('overview: stat bar, topology, table fallback with every node', () => {
  const el = render('Overview', props(mkHub()))
  const text = textOf(el)
  assert.match(text, /3节点总数2在线2任务中5已完成1失败3待送达消息1版本过旧/)
  assert.match(text, /3 台机器 · 3 个任务 · 中继：未上报/)
  assert.match(text, /连接方式：混合/)
  assert.match(text, /对等候选：服务端计数 2 台/)
  const tree = expand(el)
  assert.equal(findAll(tree, (n) => n.type === 'svg').length, 1)
  const rows = findAll(tree, (n) => n.type === 'tr' && n.kids.some((k) => k.type === 'th' && k.props.scope === 'row'))
  assert.equal(rows.length, 3)
  const rowText = rows.map((r) => textOf(r.kids.map((k) => k)))
  assert.ok(rowText[0].includes('alpha') && rowText[0].includes('在线') && rowText[0].includes('直连') && rowText[0].includes('帧 RTT 5ms') && rowText[0].includes('1 运行 · 1 排队') && rowText[0].includes('v0.4.36') && rowText[0].includes('3 条待送达'))
  assert.ok(rowText[1].includes('心跳超时') && rowText[1].includes('中继') && rowText[1].includes('低于 0.4.34'))
  assert.ok(rowText[2].includes('离线') && rowText[2].includes('版本未知'))
  // nodes are keyboard reachable and carry a full text label
  const groups = findAll(tree, (n) => n.type === 'g' && n.props.role === 'button')
  assert.equal(groups.length, 3)
  for (const g of groups) { assert.equal(g.props.tabIndex, 0); assert.match(g.props['aria-label'], /，/); assert.equal(g.props['aria-pressed'], 'false') }
})

test('overview: banners for old version and backlog (with explanation) and the go button', () => {
  const calls = []
  const el = render('Overview', props(mkHub(), { go: (s) => calls.push(s) }))
  const text = textOf(el)
  assert.match(text, /1 台机器的 AC 版本低于 0\.4\.34/)
  assert.match(text, /1 台机器有消息还没送达（共 3 条）/)
  assert.match(text, /消息会一直保留，没有超时/)
  assert.match(text, /1版本过旧/)
  assert.match(text, /3待送达消息/)
  const btns = findButtons(el, '查看机器')
  assert.equal(btns.length, 2)
  btns[0].props.onClick()
  assert.deepEqual(calls, ['machines'])
})

test('overview: never-connected banner lists the recent attempts', () => {
  const hub = mkHub({
    nodes: [nodeC],
    connection: { everConnected: false, byNode: [], recent: [{ at: NOW, result: 'fail', code: 'HS', title: '握手超时', remote: '10.0.0.9', nodeId: 'node-gamma-0003', detail: '3 次无响应', hint: '检查口令' }], reachability: { hint: '防火墙未放行 19387' } },
    caps: { reachability: { loopback: true, hint: '只绑定了 127.0.0.1', bound: '127.0.0.1' }, listener: { ok: false, state: 'waiting-port', waitingSince: Date.now() - 3000 } },
  })
  const text = textOf(render('Overview', props(hub)))
  assert.match(text, /还没有连上过/)
  assert.match(text, /诊断：防火墙未放行 19387/)
  assert.match(text, /主机只监听本机回环地址/)
  assert.match(text, /端口被占用，正在等待释放/)
  assert.match(text, /最近连接尝试.*失败.*握手超时.*10\.0\.0\.9.*3 次无响应.*建议：检查口令/)
})

test('overview: a pinned node shows its detail, aria-pressed and peer candidates', () => {
  const { tree, text } = view('Overview', props(mkHub()), [nodeA.nodeId])
  const pressed = findAll(tree, (n) => n.type === 'g' && n.props['aria-pressed'] === 'true')
  assert.equal(pressed.length, 1)
  assert.match(pressed[0].props['aria-label'], /alpha.*（已固定）/)
  assert.match(text, /alpha 详情|在「机器」里看全部/)
  assert.match(text, /对等候选beta（在线 · 心跳超时）/)
  assert.match(text, /取消固定/)
  assert.match(text, /已固定：alpha/)
  // beta has a stale heartbeat, so it is listed but not drawn as a preview edge
  assert.equal(findAll(tree, (n) => n.type === 'line' && n.props.className === 'fl-peer').length, 0)
  // a pinned id that vanished from the list is reported, not shown as pinned
  const lost = view('Overview', props(mkHub()), ['gone']).text
  assert.match(lost, /已固定的机器不在最新列表中/)
  assert.doesNotMatch(lost, /在「机器」里看全部/)
})

test('overview: relay unreachable draws the relay box', () => {
  const hub = mkHub({ relay: { reachable: false } })
  const el = render('Overview', props(hub))
  assert.match(textOf(el), /中继：不可达/)
  assert.match(textOf(el), /中继 ✕/)
})

test('machines: node cards carry every required field', () => {
  const el = render('Machines', props(mkHub()))
  const text = textOf(el)
  for (const s of ['alpha', 'node-alpha-00', '复制 ID', 'linux/x64', '任务 4', 'agent', '直连', '局域网直连', 'v0.4.36', '3 条待送达，最久等了 2m5s', '身份已确认',
    '隧道 就绪 · 探测 1/2 可达', '静默 2 秒', '帧 RTT 5ms', '42%', '2048/4096 MB', '排队 2 · 运行 1/1', '排队被占满', 'work/x×2', '没有超时', 'exec · agent', 'repo-a', 'ssh · relay.••• · 1→2', 'hub:19387 · 可达', '清理历史']) {
    assert.ok(text.includes(s), 'missing: ' + s)
  }
  assert.match(text, /beta/)
  assert.match(text, /v0\.4\.30 · 低于 0\.4\.34/)
  assert.match(text, /心跳超时/)
  assert.match(text, /gamma/)
  assert.match(text, /最后在线 .*2h0m前/)
  assert.match(text, /负载未上报/)
  assert.match(text, /版本未知/)
  assert.match(text, /2\/3 在线/)
  const articles = findAll(expand(el), (n) => n.type === 'article')
  assert.equal(articles.length, 3)
  assert.equal(findAll(expand(el), (n) => n.type === 'svg' && n.props.role === 'img').length, 1) // only alpha has frame RTT samples
})

test('machines: purge is per node, asks first, never includes active tasks', async () => {
  const fetched = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (url, init) => { fetched.push([url, init && init.body]); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, removed: 4, kept: 1 }) }) }
  try {
    const notes = []
    let refreshed = 0
    const asked = []
    const ui = { confirm: (m) => { asked.push(m); return Promise.resolve(true) }, alert() {}, notify: (t, tone) => notes.push([t, tone]), prompt: () => Promise.resolve(null) }
    const el = render('Machines', props(mkHub(), { ui, refresh: () => { refreshed += 1 } }))
    const btn = findButtons(el, '清理历史')[0]
    btn.props.onClick()
    await new Promise((r) => setTimeout(r, 20))
    assert.match(asked[0], /「alpha」/)
    assert.deepEqual(fetched.map((f) => [f[0], JSON.parse(f[1])]), [['/api/ai-cluster/ui/purge', { node: nodeA.nodeId, includeActive: false }]])
    assert.match(notes[0][0], /已清理 node-alpha-0 的 4 条历史/)
    assert.equal(notes[0][1], 'ok')
    assert.equal(refreshed, 1)
    // a declined confirm does nothing
    fetched.length = 0
    const ui2 = Object.assign({}, ui, { confirm: () => Promise.resolve(false) })
    findButtons(render('Machines', props(mkHub(), { ui: ui2 })), '清理历史')[0].props.onClick()
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(fetched.length, 0)
    // a failure shows the original error text
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'task-unknown', node: 'x' }) })
    notes.length = 0
    findButtons(render('Machines', props(mkHub(), { ui })), '清理历史')[0].props.onClick()
    await new Promise((r) => setTimeout(r, 20))
    assert.match(notes[0][0], /清理失败：task-unknown/)
    assert.equal(notes[0][1], 'err')
  } finally { globalThis.fetch = realFetch }
})

test('machines: empty fleet points at the add-machine guide and keeps it open', () => {
  const el = render('Machines', props(mkHub({ nodes: [], counts: dataEmptyHub.counts, tasks: [] })))
  const text = textOf(el)
  assert.match(text, /还没有副机/)
  assert.match(text, /先接一台/)
  assert.match(text, /重启 DSH.*生成配对码.*在副机上粘贴.*等它连上/)
  assert.match(text, /生成一次性接入口令/)
  assert.match(text, /还没有可用配对码/)
  const folds = findAll(expand(el), (n) => n.type === 'details' && n.props.className === 'dra-fold')
  assert.equal(folds.find((f) => textOf(f.kids).includes('先接一台')).props.open, true)
  // while still loading it must not claim "no machines"
  assert.doesNotMatch(textOf(render('Machines', props(dataEmptyHub))), /还没有副机/)
})

test('machines: discovery card toggles, scans and filters', () => {
  const hub = mkHub({ discovery: { enabled: true, configured: true, peers: [{ node: 'p3', hostname: '192.168.1.20', role: 'node', port: 19387 }, { node: nodeA.nodeId, hostname: '10.0.0.1', role: 'node', port: 1 }] } })
  const el = render('Machines', props(hub))
  const text = textOf(el)
  assert.match(text, /局域网发现1 台未配对/)
  assert.match(text, /192\.168\.1\.20/)
  assert.doesNotMatch(text, /10\.0\.0\.1/)
  const sw = findAll(expand(el), (n) => n.type === 'button' && n.props.role === 'switch')[0]
  assert.equal(sw.props['aria-checked'], 'true')
  assert.match(textOf(render('Machines', props(mkHub({ discovery: { enabled: false, configured: false, peers: [] } })))), /局域网发现未开启/)
  assert.match(textOf(render('Machines', props(mkHub({ discovery: { enabled: false, configured: true, peers: [] } })))), /发现监听未启动/)
})

test('machines: component state from the store drives the pair and enrollment views', () => {
  const state = Object.assign({}, fleetMachInit, {
    pair: { loading: false, note: '', data: { ok: true, listener: { host: '10.0.0.1', port: 19387, hint: '独立监听尚未就绪' }, note: '配对码不含 token', codes: [{ address: '10.0.0.1', name: 'en0', private: true, usable: true, pairCode: 'PAIRCODE', hubUrl: 'ws://10.0.0.1:19387' }] } },
    enroll: { loading: false, error: '', data: { token: 'TOKEN-XYZ', expiresAt: Date.now() + 600000, expiresInMs: 900000 } },
  })
  // useMach's useState is the first hook in Machines
  const { tree, text } = view('Machines', props(mkHub()), [state])
  assert.match(text, /监听 10\.0\.0\.1:19387/)
  assert.match(text, /独立监听尚未就绪/)
  assert.match(text, /配对码不含 token/)
  assert.match(text, /pair: PAIRCODE/)
  assert.match(text, /内网/)
  assert.match(text, /TOKEN-XYZ/)
  assert.match(text, /有效至 .*（约 15 分钟），仅显示这一次/)
  assert.equal(findAll(tree, (n) => n.props && n.props.className === 'fl-token').length, 1)
  const expired = view('Machines', props(mkHub()), [Object.assign({}, state, { enroll: { loading: false, error: '', data: { token: 'T', expiresAt: 1, expiresInMs: 1000 } } })]).text
  assert.match(expired, /已过期，请重新生成/)
  const errState = view('Machines', props(mkHub()), [Object.assign({}, state, { enroll: { loading: false, data: null, error: '铸造失败：未配置中继（not-relay）' } })]).text
  assert.match(errState, /铸造失败：未配置中继（not-relay）/)
})

test('machines: the screen has no SSH one-click section, whatever state it is in', () => {
  const text = textOf(render('Machines', props(mkHub())))
  assert.doesNotMatch(text, /SSH|上桥|安装运行环境/)
})

test('reducer: refreshing the pair info keeps the codes already on screen', () => {
  let s = fleetMachReduce(fleetMachInit, { type: 'patch', key: 'pair', value: { loading: false, data: { codes: [1] }, note: 'old' } })
  s = fleetMachReduce(s, { type: 'pair-start' })
  assert.deepEqual(s.pair, { loading: true, data: { codes: [1] }, note: '' })
})

/* Records what the topology's two setters (pinned id, previewed id: hover/focus) are called with. */
function pinSession(initial) {
  const picked = []
  const peeked = []
  const core = makeCore({ state: initial })
  const orig = core.React.useState
  let calls = 0
  core.React.useState = (v) => { const [val] = orig(v); const mine = calls === 0 ? picked : calls === 1 ? peeked : null; calls += 1; return [val, (x) => { if (mine) mine.push(x) }] }
  const f = createFleet(core)
  const tree = expand(core.h(f.Overview, props(mkHub())))
  return { picked, peeked, tree }
}

test('overview: topology nodes toggle the pin from the keyboard and Escape releases it', () => {
  const { picked, peeked, tree } = pinSession(['', ''])
  const g = findAll(tree, (n) => n.type === 'g' && n.props.role === 'button')[0]
  let prevented = 0
  g.props.onKeyDown({ key: 'Enter', preventDefault() { prevented += 1 } })
  g.props.onKeyDown({ key: ' ', preventDefault() { prevented += 1 } })
  g.props.onKeyDown({ key: 'Tab', preventDefault() { prevented += 1 } })
  g.props.onClick()
  assert.equal(prevented, 2)
  assert.deepEqual(picked, [nodeA.nodeId, nodeA.nodeId, nodeA.nodeId])
  // hover and focus preview the peers, leaving and blurring clear it
  g.props.onMouseEnter(); g.props.onMouseLeave(); g.props.onFocus(); g.props.onBlur()
  assert.deepEqual(peeked, [nodeA.nodeId, '', nodeA.nodeId, ''])
  const wrap = (t) => findAll(t, (n) => n.props.className === 'fl-topo')[0]
  wrap(tree).props.onKeyDown({ key: 'Escape' }) // nothing pinned or previewed: no-op
  assert.equal(picked.length, 3)

  const held = pinSession([nodeA.nodeId, ''])
  const gHeld = findAll(held.tree, (n) => n.type === 'g' && n.props.role === 'button')[0]
  gHeld.props.onClick() // clicking the pinned node releases it
  assert.deepEqual(held.picked, [''])
  wrap(held.tree).props.onKeyDown({ key: 'Escape' })
  wrap(held.tree).props.onKeyDown({ key: 'a' })
  assert.deepEqual(held.picked, ['', ''])
  assert.deepEqual(held.peeked, [''])
  const btn = findAll(held.tree, (n) => n.type === 'button' && texts(n).join('') === '取消固定')[0]
  btn.props.onClick()
  assert.equal(held.picked.length, 3)
})
