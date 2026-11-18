import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { topologyView } from '../../lib/hub/views.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../../lib/client.js'), 'utf8')

function loadPlugin() {
  let plugin = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) {
          plugin = mod.factory(function () {
            return {
              createElement(type, props, ...kids) { return { type, props: props || {}, kids: kids.flat(Infinity) } },
              useState(v) { return [v, function () {}] },
              useEffect() {}, useRef(v) { return { current: v } }, useMemo(fn) { return fn() },
            }
          })
        },
      },
    },
    console,
  }
  vm.runInNewContext(src, sandbox, { filename: 'lib/client.js' })
  return plugin
}
const P = loadPlugin()
const plain = (v) => JSON.parse(JSON.stringify(v))
const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze) }
  return v
}
const ids = (n) => Array.from({ length: n }, (_, i) => 'n' + String(i + 1).padStart(2, '0'))
const mk = (list, over = {}) => list.map((id) => ({ nodeId: id, online: true, peerCapable: true, ...(over[id] || {}) }))
const link = (from, to) => ({ from, to })
const topo = (list, links, summary, over) => ({ nodes: mk(list, over), links: [], peerLinks: links, summary })
/** 真实服务端投影：和 /overview 同一函数，含 60 对截断与 summary。 */
const serverTopo = (n) => topologyView(mk(ids(n)))
const permutations = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]))

test('mesh: 无向去重确定且与输入顺序无关', () => {
  const links = [link('b', 'a'), link('a', 'b'), link('c', 'a'), link('b', 'c'), link('a', 'c')]
  const expected = [{ a: 'a', b: 'b' }, { a: 'a', b: 'c' }, { a: 'b', b: 'c' }]
  for (const order of permutations(links)) {
    const m = plain(P.topoMeshModel(topo(['a', 'b', 'c'], order), mk(['a', 'b', 'c'])))
    assert.deepEqual(m.pairs, expected)
    assert.equal(m.aggregate, 3)
    assert.equal(m.received, 5)
  }
})

test('mesh: 度数与汇总只来自唯一有效对', () => {
  const t = deepFreeze(topo(['a', 'b', 'c', 'd'], [link('a', 'b'), link('b', 'a'), link('a', 'c'), link('b', 'c')], { peerCapable: 4 }))
  const m = plain(P.topoMeshModel(t, mk(['a', 'b', 'c', 'd'])))
  // 手算：唯一有效对 ab / ac / bc = 3；d 没有收到任何对，不补全、不假设完全图（4 台完全图会是 6）。
  assert.equal(m.aggregate, 3)
  assert.deepEqual(m.pairs.length, 3)
  assert.deepEqual({ a: m.degree.a, b: m.degree.b, c: m.degree.c, d: m.degree.d || 0 }, { a: 2, b: 2, c: 2, d: 0 })
  // 服务端计数原样透传，不被收到的对数覆盖，也不被用来推 aggregate。
  assert.equal(m.serverPeerCapable, 4)
  const other = plain(P.topoMeshModel(topo(['a', 'b'], [link('a', 'b')], { peerCapable: 9 }), mk(['a', 'b'])))
  assert.equal(other.serverPeerCapable, 9)
  assert.equal(other.aggregate, 1)
  assert.equal(plain(P.topoMeshModel(topo(['a', 'b'], [link('a', 'b')]), mk(['a', 'b']))).serverPeerCapable, null)
  assert.match(m.labels.received, /收到 3 对有效候选/)
})

test('mesh: 端点校验丢弃未知/自环/离线/非对等', () => {
  const list = ['a', 'b', 'c', 'off', 'np']
  const over = { off: { online: false }, np: { peerCapable: false } }
  const links = [
    link('a', 'b'), link('a', 'a'), link('a', 'zz'), link('a', 'off'), link('np', 'b'),
    link('', 'a'), { from: 1, to: 2 }, null, { from: 'a' },
  ]
  const m = plain(P.topoMeshModel(topo(list, links, { peerCapable: 3 }, over), mk(list, over)))
  assert.deepEqual(m.pairs, [{ a: 'a', b: 'b' }])
  assert.equal(m.dropped, 8)
  assert.equal(m.degree.a, 1)
  assert.equal(m.degree.b, 1)
  assert.equal(m.degree.off, undefined)
  assert.equal(m.degree.np, undefined)
  assert.equal(m.badges.off, '—')
  assert.equal(m.badges.np, '—')
  assert.equal(m.badges.c, '对等 0')
})

test('mesh: 空/纯空白/非字符串端点整条丢弃，不进计数/度数/汇总，合法 ID 原样保留', () => {
  const ws = ['  ', '\t', '\n ']
  const valid = ['a', ' b ', 'c'] // ' b ' 含首尾空格但 trim 后非空：合法，必须逐字节保留
  // 拓扑节点里也放入空白/非字符串 ID（online && peerCapable），否则它们会成为幻影端点
  const nodes = [
    ...valid.map((id) => ({ nodeId: id, online: true, peerCapable: true })),
    ...ws.map((id) => ({ nodeId: id, online: true, peerCapable: true })),
    { nodeId: '', online: true, peerCapable: true },
    { nodeId: 7, online: true, peerCapable: true },
  ]
  const links = [
    link('a', ' b '),
    link('  ', 'a'), link('a', '\t'), link('\n ', ' b '), link('  ', '\t'),
    link('', 'a'), link('c', ''),
    { from: 7, to: 'a' }, { from: 'c', to: 7 }, { from: null, to: 'a' }, { from: 'a', to: undefined },
    { from: ['a'], to: 'c' }, { from: 'a', to: { id: 'c' } },
  ]
  const t = { nodes, links: [], peerLinks: links, summary: { peerCapable: 3 } }
  const m = plain(P.topoMeshModel(t, mk(valid)))
  assert.deepEqual(m.pairs, [{ a: ' b ', b: 'a' }].map(({ a, b }) => (a < b ? { a, b } : { a: b, b: a })))
  assert.equal(m.aggregate, 1)
  assert.equal(m.dropped, links.length - 1)
  assert.equal(m.received, links.length) // 触顶判断仍基于接收的原始长度
  assert.equal(m.capped, false)
  assert.equal(m.degree.a, 1)
  assert.equal(m.degree[' b '], 1)
  assert.equal(m.degree.c, undefined)
  for (const bad of [...ws, '', '7', 'null', 'undefined']) assert.equal(m.degree[bad], undefined, JSON.stringify(bad))
  assert.deepEqual(Object.keys(m.degree).sort(), [' b ', 'a'])
  assert.match(m.labels.received, /收到 1 对有效候选/)
  // 原始长度触顶不受无效记录影响：59 条无效 + 1 条有效 = 60 → capped，但 aggregate 仍为 1
  const junk = Array.from({ length: 59 }, (_, i) => link(ws[i % 3], 'a'))
  const mc = plain(P.topoMeshModel({ nodes, links: [], peerLinks: [link('a', ' b '), ...junk], summary: { peerCapable: 3 } }, mk(valid)))
  assert.equal(mc.capped, true)
  assert.equal(mc.aggregate, 1)
})

test('mesh: 缺失≠空', () => {
  for (const bad of [null, undefined, 'x', 5, [], {}, { nodes: [] }, { peerLinks: {} }, { peerLinks: 'ab' }]) {
    const m = plain(P.topoMeshModel(bad, mk(['a', 'b'])))
    assert.equal(m.state, 'missing', JSON.stringify(bad))
    assert.equal(m.labels.summary, '对等候选：未上报')
    assert.equal(m.band, false)
  }
  const empty = plain(P.topoMeshModel(topo(['a', 'b'], []), mk(['a', 'b'])))
  assert.equal(empty.state, 'empty')
  assert.equal(empty.labels.summary, '无对等候选')
  assert.equal(empty.reason, '')
  const few = plain(P.topoMeshModel(topo(['a'], [], { peerCapable: 1 }), mk(['a'])))
  assert.equal(few.state, 'empty')
  assert.equal(few.reason, 'insufficient')
  assert.match(few.labels.summary, /可对等节点不足 2 台/)
  assert.equal(plain(P.topoMeshModel(topo(['a'], [], { peerCapable: 0 }), mk(['a']))).reason, 'insufficient')
  assert.doesNotMatch(plain(P.topoMeshModel(topo(['a', 'b', 'c'], [], { peerCapable: 3 }), mk(['a', 'b', 'c']))).labels.summary, /不足/)
})

test('mesh: 触顶 60 标可能不完整且不补对', () => {
  const full = serverTopo(12) // 12 台全可对等：66 对，服务端只回 60
  assert.equal(full.peerLinks.length, 60)
  const m = plain(P.topoMeshModel(full, mk(ids(12))))
  assert.equal(m.capped, true)
  assert.equal(m.aggregate, 60) // 不补成 66
  assert.equal(m.badges.n01, '对等 11+')
  assert.equal(m.badges.n12, '对等 8+') // 靠后节点度数被服务端截断，UI 不纠正
  assert.match(m.labels.capped, /已达服务端上限 60，可能不完整/)
  assert.match(m.labels.received, /收到 60 对有效候选/)
  assert.equal(m.serverPeerCapable, 12)
  // 59 条不触顶
  const t59 = { ...full, peerLinks: full.peerLinks.slice(0, 59) }
  const m59 = plain(P.topoMeshModel(t59, mk(ids(12))))
  assert.equal(m59.capped, false)
  assert.equal(m59.labels.capped, '')
  assert.ok(Object.values(m59.badges).every((b) => !b.endsWith('+')))
  // 触顶看接收的原始长度：59 条有效 + 1 条垃圾 = 60 → 仍然触顶
  const mj = plain(P.topoMeshModel({ ...full, peerLinks: [...full.peerLinks.slice(0, 59), link('n01', 'n01')] }, mk(ids(12))))
  assert.equal(mj.capped, true)
  assert.equal(mj.aggregate, 59)
  // 11 台 = 55 对：不触顶
  assert.equal(plain(P.topoMeshModel(serverTopo(11), mk(ids(11)))).capped, false)
})

test('mesh: 带标签同时写出服务端计数与收到的有效对数；0 对不画带', () => {
  const m = plain(P.topoMeshModel(topo(['a', 'b'], [link('a', 'b')], { peerCapable: 2 }), mk(['a', 'b'])))
  assert.equal(m.band, true)
  assert.equal(m.labels.band, '对等候选组：服务端计数 2 台 · 收到 1 对有效候选')
  const none = plain(P.topoMeshModel(topo(['a', 'b'], [link('a', 'a')], { peerCapable: 2 }), mk(['a', 'b'])))
  assert.equal(none.band, false)
  const noServer = plain(P.topoMeshModel(topo(['a', 'b'], [link('a', 'b')]), mk(['a', 'b'])))
  assert.match(noServer.labels.band, /服务端计数 未上报/)
  const capped = plain(P.topoMeshModel(serverTopo(12), mk(ids(12))))
  assert.match(capped.labels.band, /服务端计数 12 台 · 收到 60 对有效候选/)
  assert.match(capped.labels.band, /已达服务端上限 60，可能不完整/)
})

test('mesh: 邻居视图预览≤cap、按 id 升序、其余计入溢出、完整列表不截断', () => {
  const m = P.topoMeshModel(serverTopo(13), mk(ids(13))) // 13 台：78 对被截断到 60
  const v = plain(P.topoNeighborView(m, 'n01', { cap: 6 }))
  assert.deepEqual(v.preview, ['n02', 'n03', 'n04', 'n05', 'n06', 'n07'])
  assert.equal(v.overflow, 6)
  assert.equal(v.full.length, 12)
  const v3 = plain(P.topoNeighborView(m, 'n01', { cap: 3 }))
  assert.deepEqual(v3.preview, ['n02', 'n03', 'n04'])
  assert.equal(v3.overflow, 9)
  assert.equal(v3.full.length, 12)
  const low = plain(P.topoNeighborView(m, 'n13', { cap: 6 }))
  assert.equal(low.full.length, 6)
  assert.equal(low.preview.length, 6)
  assert.equal(low.overflow, 0)
  assert.deepEqual(plain(P.topoNeighborView(m, 'ghost', { cap: 6 })), { id: 'ghost', preview: [], overflow: 0, full: [], previewable: false })
})

test('stale: 心跳超时不进预览但在列表里', () => {
  const list = ['a', 'b', 'c']
  const t = topo(list, [link('a', 'b'), link('a', 'c'), link('b', 'c')], { peerCapable: 3 })
  const m = P.topoMeshModel(t, mk(list, { c: { stale: true } }))
  const a = plain(P.topoNeighborView(m, 'a', { cap: 6 }))
  assert.deepEqual(a.preview, ['b'])
  assert.deepEqual(a.full, ['b', 'c']) // 完整邻居仍含心跳超时的 c
  const c = plain(P.topoNeighborView(m, 'c', { cap: 6 }))
  assert.deepEqual(c.preview, [])
  assert.deepEqual(c.full, ['a', 'b'])
  assert.equal(plain(m).badges.c, '—') // 按绘制状态当作离线：无徽标
  assert.equal(plain(m).aggregate, 3) // 候选对本身仍是收到的事实
  // 标签：心跳超时优先；采样超过 600 s 才算陈旧，600 s 整不算；缺失不推断
  const now = 1_000_000_000
  assert.equal(P.topoStaleLabel({ stale: true }, now), '心跳超时')
  assert.equal(P.topoStaleLabel({ stale: true, connectivity: { sampledAt: now - 700_000 } }, now), '心跳超时')
  assert.equal(P.topoStaleLabel({ connectivity: { sampledAt: now - 601_000 } }, now), '采样陈旧')
  assert.equal(P.topoStaleLabel({ connectivity: { sampledAt: now - 600_000 } }, now), '')
  assert.equal(P.topoStaleLabel({ sampledAt: now - 601_000 }, now), '采样陈旧')
  assert.equal(P.topoStaleLabel({ connectivity: { sampledAt: null } }, now), '')
  assert.equal(P.topoStaleLabel({}, now), '')
  assert.equal(P.topoStaleLabel(null, now), '')
})

test('pin: 点击/Enter/Space 固定，Escape 取消，刷新保留，消失则清除，错误保留', () => {
  const R = (s, e) => plain(P.topoPinReducer(s, e))
  const s0 = R(undefined, { type: 'init' })
  assert.deepEqual({ p: s0.pinned, h: s0.hover, f: s0.focus, st: s0.stale, l: s0.lost }, { p: '', h: '', f: '', st: false, l: false })
  // 点击固定 / 再次点击取消
  const s1 = R(s0, { type: 'click', id: 'a', label: 'Alpha' })
  assert.equal(s1.pinned, 'a')
  assert.equal(s1.announce, '已固定：Alpha')
  const s2 = R(s1, { type: 'click', id: 'a', label: 'Alpha' })
  assert.equal(s2.pinned, '')
  assert.equal(s2.announce, '已取消固定：Alpha')
  // Enter / Space 固定（含 Spacebar 旧值），其它键无效
  assert.equal(R(s0, { type: 'key', key: 'Enter', id: 'b' }).pinned, 'b')
  assert.equal(R(s0, { type: 'key', key: ' ', id: 'b' }).pinned, 'b')
  assert.equal(R(s0, { type: 'key', key: 'Spacebar', id: 'b' }).pinned, 'b')
  assert.equal(R(s0, { type: 'key', key: 'a', id: 'b' }).pinned, '')
  assert.equal(R(R(s0, { type: 'key', key: 'Enter', id: 'b' }), { type: 'key', key: 'Enter', id: 'b' }).pinned, '')
  // 固定另一台：替换而不是叠加
  assert.equal(R(s1, { type: 'click', id: 'b' }).pinned, 'b')
  // hover / focus 预览，blur 清除
  const hv = R(R(s1, { type: 'hover', id: 'b' }), { type: 'focus', id: 'c' })
  assert.equal(hv.hover, 'b'); assert.equal(hv.focus, 'c'); assert.equal(hv.pinned, 'a')
  assert.equal(R(hv, { type: 'hover', id: '' }).hover, '')
  assert.equal(R(hv, { type: 'blur', id: 'c' }).focus, '')
  // Escape：先清除固定与预览，不退出全屏；已空时才请求退出全屏
  const e1 = R(hv, { type: 'escape' })
  assert.deepEqual({ p: e1.pinned, h: e1.hover, f: e1.focus, x: e1.exitFullscreen }, { p: '', h: '', f: '', x: false })
  const e2 = R(e1, { type: 'escape' })
  assert.equal(e2.exitFullscreen, true)
  assert.equal(R(R(s1, { type: 'escape' }), { type: 'key', key: 'Escape' }).exitFullscreen, true)
  assert.equal(R(s1, { type: 'key', key: 'Escape' }).pinned, '')
  // 刷新：节点仍在则保持，且不产生新的播报
  const keep = R(s1, { type: 'refresh', ids: ['a', 'b'] })
  assert.equal(keep.pinned, 'a'); assert.equal(keep.lost, false); assert.equal(keep.announce, s1.announce)
  // 节点消失：取消固定并提示
  const gone = R(R(s1, { type: 'hover', id: 'a' }), { type: 'refresh', ids: ['b'] })
  assert.equal(gone.pinned, ''); assert.equal(gone.hover, ''); assert.equal(gone.lost, true)
  assert.equal(gone.announce, '已固定的电脑不在最新列表中')
  assert.equal(R(gone, { type: 'refresh', ids: ['b'] }).lost, true) // 提示保持到用户操作
  assert.equal(R(gone, { type: 'click', id: 'b' }).lost, false)
  // 请求失败：保留固定，标陈旧并播报一次；重复失败不重复播报；恢复后清除
  const err = R(s1, { type: 'error' })
  assert.equal(err.pinned, 'a'); assert.equal(err.stale, true)
  assert.equal(err.announce, '数据陈旧：刷新失败，显示最后一次成功的数据')
  assert.deepEqual(R(err, { type: 'error' }), err)
  const back = R(err, { type: 'refresh', ids: ['a'] })
  assert.equal(back.pinned, 'a'); assert.equal(back.stale, false); assert.equal(back.announce, '')
  // 纯函数：不改入参
  const frozen = deepFreeze({ ...s1 })
  assert.doesNotThrow(() => P.topoPinReducer(frozen, { type: 'escape' }))
})

test('fallback: 1/2/5/13 台与 60 对的分支', () => {
  const F = (n, p, w) => plain(P.topoFallbackMode(n, p, w))
  // 1 台：无可配对，不画带
  assert.equal(F(1, 0, 900).band, false)
  assert.equal(F(1, 0, 900).overflowPossible, false)
  // 2 台：最多 1 对。有有效对才画带；0 对不画
  assert.equal(F(2, 1, 900).band, true)
  assert.equal(F(2, 1, 900).overflowPossible, false)
  assert.equal(F(2, 0, 900).band, false)
  // 5 台（≤10 对，度数 ≤4）：常规上限 6 不溢出；紧凑上限 3 会溢出
  assert.deepEqual([F(5, 10, 900).previewCap, F(5, 10, 900).overflowPossible], [6, false])
  assert.deepEqual([F(5, 10, 500).previewCap, F(5, 10, 500).overflowPossible], [3, true])
  assert.equal(F(5, 10, 500).scale, 'compact')
  // 13 台（度数最高 12）：触发「+M 更多」；60 对触顶
  assert.equal(F(13, 60, 900).overflowPossible, true)
  assert.equal(F(13, 60, 900).capped, true)
  assert.equal(F(13, 59, 900).capped, false)
  // 60 对仍然只画带，默认零候选边，从不因对数而变
  for (const [n, p] of [[1, 0], [2, 1], [5, 10], [13, 60], [60, 60]]) assert.equal(F(n, p, 900).defaultEdges, 0)
  assert.equal(F(13, 60, 900).band, true)
  // 非法输入不抛错
  assert.equal(F(NaN, -3, undefined).band, false)
})

test('relay: 未上报≠不可达≠可达', () => {
  assert.equal(P.topoRelayStatus(null, null), 'unreported')
  assert.equal(P.topoRelayStatus({ everConnected: true }, {}), 'unreported')
  assert.equal(P.topoRelayStatus(null, { reachable: false }), 'unreachable')
  assert.equal(P.topoRelayStatus({ relay: { reachable: false } }, null), 'unreachable')
  assert.equal(P.topoRelayStatus({ relayReachable: false }, null), 'unreachable')
  assert.equal(P.topoRelayStatus(null, { reachable: true }), 'reachable')
  for (const v of [undefined, null, 0, '', 'false', 'no']) assert.equal(P.topoRelayStatus(null, { reachable: v }), 'unreported', String(v))
})
