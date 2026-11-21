import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../../lib/client.js'), 'utf8')

function loadPlugin(win = {}) {
  let plugin = null
  const windowObj = Object.defineProperties({}, Object.getOwnPropertyDescriptors(win))
  const sandbox = {
    window: Object.assign(windowObj, {
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
    }),
    console,
  }
  vm.runInNewContext(src, sandbox, { filename: 'lib/client.js' })
  return plugin
}
const plain = (v) => JSON.parse(JSON.stringify(v))
const P = loadPlugin()

function walk(el, out = []) {
  if (!el || typeof el !== 'object') return out
  out.push(el)
  for (const k of el.kids || []) walk(k, out)
  return out
}
const text = (el) => walk(el).filter((e) => e.type !== 'title').flatMap((e) => e.kids || []).filter((k) => typeof k === 'string').join('|')

const nodes = () => [
  { nodeId: 'beta', name: 'beta', online: true, probes: [{ rttMs: 12 }] },
  { nodeId: 'alpha', name: 'alpha', online: true },
  { nodeId: 'gamma', name: 'gamma', online: false, probes: [{ rttMs: 40 }] },
]
const tasks = () => [
  { taskId: 't1', nodeId: 'alpha', status: 'running', goal: 'g1' },
  { taskId: 't2', nodeId: 'alpha', status: 'completed', goal: 'g2' },
  { taskId: 't3', nodeId: 'beta', status: 'queued', goal: 'g3' },
  { taskId: 't4', nodeId: 'ghost', status: 'failed', goal: 'g4' },
]
const lay = (extra = {}) => plain(P.topologyLayout({ nodes: nodes(), tasks: tasks(), width: 900, height: 560, ...extra }))

test('layout is deterministic', () => {
  assert.deepEqual(lay(), lay())
})

test('layout does not read window.innerWidth and follows the container width', () => {
  const w = { get innerWidth() { throw new Error('innerWidth read') } }
  const Q = loadPlugin(w)
  assert.equal(Q.topologyLayout({ nodes: nodes(), tasks: [], width: 520, height: 400 }).scale, 'compact')
  assert.equal(Q.topologyLayout({ nodes: nodes(), tasks: [], width: 900, height: 400 }).scale, 'wide')
  assert.deepEqual(plain(Q.topologyFit({ clientWidth: 520, clientHeight: 300 })), { width: 520, height: 300 })
})

test('tasks are a projection on machines, never graph nodes', () => {
  const r = lay()
  assert.deepEqual(Object.keys(r).sort(), ['edges', 'height', 'hub', 'nodes', 'relay', 'scale', 'unattached', 'width'])
  const ids = r.nodes.map((n) => n.id).sort()
  assert.deepEqual(ids, ['alpha', 'beta', 'gamma'])
  assert.ok(!r.edges.some((e) => /^t\d/.test(e.to)))
  const a = r.nodes.find((n) => n.id === 'alpha')
  assert.equal(a.ticks.length, 2)
  assert.equal(a.badge, '1 运行 · 1 完成')
  assert.equal(r.nodes.find((n) => n.id === 'gamma').badge, '无任务')
  // every machine has its own hub edge (peers, not nested)
  assert.equal(r.edges.filter((e) => e.kind === 'hub').length, 3)
})

test('orphan task is surfaced as unattached, not dropped', () => {
  const r = lay()
  assert.deepEqual(r.unattached.map((t) => t.taskId), ['t4'])
  assert.ok(!r.nodes.some((n) => n.ticks.some((t) => t.taskId === 't4')))
})

test('null rttMs never renders a number or 0ms', () => {
  const r = lay()
  const alpha = r.nodes.find((n) => n.id === 'alpha')
  assert.equal(alpha.rttMs, null)
  assert.equal(alpha.rttLabel, '延迟未测')
  const edge = r.edges.find((e) => e.to === 'alpha')
  assert.equal(edge.label, 'rtt —')
  assert.ok(!/0\s*ms/.test(JSON.stringify(r.nodes.filter((n) => n.rttMs === null))))
  assert.equal(r.edges.find((e) => e.to === 'beta').label, 'rtt 12ms')
  assert.equal(r.edges.find((e) => e.to === 'gamma').label, '断')
})

test('task states map to the four motion classes', () => {
  const m = P.topoTaskState
  assert.equal(m('running'), 'running')
  assert.equal(m('queued'), 'queued')
  assert.equal(m('completed'), 'completed')
  assert.equal(m('failed'), 'failed')
  const r = lay()
  const state = (id) => r.edges.find((e) => e.to === id).state
  assert.equal(state('alpha'), 'running')
  assert.equal(state('beta'), 'queued')
  assert.equal(state('gamma'), 'offline')
})

test('running edge animates, queued/offline stay static', () => {
  const r = P.topologyLayout({ nodes: nodes(), tasks: tasks(), width: 900, height: 560 })
  const mo = plain(P.topologyMotion(r, 1.3, { reduced: false }))
  assert.equal(mo.edges['hub>alpha'].packets.length, 2)
  assert.ok(mo.edges['hub>alpha'].packets.every((p) => p.r >= 3))
  assert.notEqual(mo.edges['hub>alpha'].dashOffset, 0)
  assert.equal(mo.edges['hub>beta'].packets.length, 0)
  assert.equal(mo.edges['hub>gamma'].packets.length, 0)
  assert.equal(mo.nodes.gamma, null)
  assert.ok(mo.nodes.alpha.opacity > 0)
  assert.ok(mo.hub.pulseOpacity > 0)
  assert.deepEqual(plain(P.topologyMotion(r, 1.3, { reduced: false })), mo)
})

test('reduced motion: no animated class, no packets, all nodes still drawn; rAF loop not started', () => {
  const r = P.topologyLayout({ nodes: nodes(), tasks: tasks(), width: 900, height: 560 })
  const mo = plain(P.topologyMotion(r, 2, { reduced: true }))
  assert.ok(Object.values(mo.edges).every((e) => e.packets.length === 0 && e.dashOffset === 0))
  const svg = P.renderTopologyScene(r, tasks(), { t: 2, reduced: true })
  const els = walk(svg)
  assert.ok(!els.some((e) => /is-flow/.test(String((e.props || {}).className || ''))))
  assert.ok(!els.some((e) => /dra-tg-packet/.test(String((e.props || {}).className || ''))))
  assert.equal(els.filter((e) => /dra-tg-card/.test(String((e.props || {}).className || ''))).length, 3)
  assert.equal(els.filter((e) => /dra-tg-tick/.test(String((e.props || {}).className || ''))).length, 3)
  let called = 0
  P.startTopologyLoop({ reduced: true, raf() { called += 1 }, onTick() {} })
  assert.equal(called, 0)
  P.startTopologyLoop({ reduced: false, raf() { called += 1 }, onTick() {} })
  assert.equal(called, 1)
})

test('relay node only when unreachable, with red dashed edge and 中继不可达', () => {
  assert.equal(lay().relay, null)
  assert.ok(!lay().edges.some((e) => e.kind === 'relay'))
  const down = lay({ relayUnreachable: true })
  assert.ok(down.relay)
  const edge = down.edges.find((e) => e.kind === 'relay')
  assert.equal(edge.label, '中继不可达')
  const r = P.topologyLayout({ nodes: nodes(), tasks: [], relayUnreachable: true, width: 900, height: 560 })
  const mo = plain(P.topologyMotion(r, 1, { reduced: false }))
  assert.equal(mo.edges['hub>relay'].packets.length, 0)
  assert.equal(!!P.topologyRelayDown(null, null), false)
  assert.equal(!!P.topologyRelayDown({ relay: { reachable: false } }, null), true)
  assert.equal(!!P.topologyRelayDown({}, { reachable: true }), false)
})

test('compact keeps label and badge but drops address/rtt sub-line, still a graph', () => {
  const r = P.topologyLayout({ nodes: nodes(), tasks: tasks(), width: 520, height: 420 })
  const t = text(P.renderTopologyScene(r, tasks(), { t: 0, reduced: true }))
  assert.match(t, /alpha/)
  assert.match(t, /1运行·1完成/)
  assert.ok(!t.includes('延迟未测'))
  assert.equal(r.nodes.length, 3)
  assert.ok(r.nodes.every((n) => n.x >= 0 && n.x <= 520 && n.y >= 0 && n.y <= 420))
})

test('empty states', () => {
  assert.equal(P.topologyLayout({ nodes: [], tasks: [] }).nodes.length, 0)
  const el = P.TopologyBoard({ nodes: [], tasks: [] })
  assert.equal(text(el), '还没有任何电脑接入')
  const el2 = P.TopologyBoard({ nodes: nodes(), tasks: [] })
  assert.match(text(el2), /暂无任务/)
})

test('P2_SCREENS still has exactly the three existing ids', () => {
  assert.deepEqual(Array.from(P.P2_SCREENS, (e) => e[0]), ['nodes', 'tasks', 'team'])
})

test('TOPO-RAF-1: startTopologyLoop binds raf/cancel to the host global', () => {
  // loadPlugin runs client.js in a separate VM realm.
  const hostGlobal = P.startTopologyLoop.constructor('return globalThis')()
  const seen = []
  let frame
  const raf = function (cb) {
    if (this !== hostGlobal) throw new TypeError('Illegal invocation')
    frame = cb
    seen.push('raf')
    return 10 + seen.length
  }
  const cancel = function (id) {
    if (this !== hostGlobal) throw new TypeError('Illegal invocation')
    seen.push('cancel:' + id)
  }
  let ticks = 0
  const stop = P.startTopologyLoop({ reduced: false, raf, cancel, onTick() { ticks += 1 } })
  frame(0)
  assert.equal(ticks, 1)
  stop()
  assert.deepEqual(seen, ['raf', 'raf', 'cancel:12'])
})
