// The topology as a living constellation: layers, link colours, bezier links, flowing light, flying / parked packets, focus dimming,
// the pinned reticle, density tiers and the element budget. Everything animated is a CSS class; the tests check the classes and geometry.
import assert from 'node:assert/strict'
import test from 'node:test'
import { topologyView } from '../../lib/hub/views.js'
import { makeCore, expand, texts, findAll } from './_fake.js'
import { dataEmptyHub } from '../../src/panel/data.js'
import {
  createFleet, fleetCapsuleWidth, fleetCss, fleetDensity, fleetFlyCap, fleetLayout, fleetLinkClass, fleetNodeModel, fleetPointOn, fleetStars,
} from '../../src/panel/fleet.js'

const NOW = Date.now()
const props = (hub) => ({ hub, role: 'hub', go() {}, refresh() {}, ui: { confirm: async () => true, alert() {}, notify() {}, prompt: async () => null } })
const mkHub = (nodes, extra = {}) => Object.assign({}, dataEmptyHub, {
  loading: false, at: NOW, tick: 1, nodes, tasks: [], counts: { nodes: nodes.length, online: nodes.filter((n) => n.online).length, tasks: 0, running: 0, active: 0, done: 0, failed: 0 },
  connection: { everConnected: true, byNode: [], recent: [] }, topology: topologyView(nodes),
}, extra)
const render = (hub, state) => { const core = makeCore({ state }); return expand(core.h(createFleet(core).Overview, props(hub))) }
const cls = (n) => String((n.props && n.props.className) || '')
const has = (n, c) => cls(n).split(/\s+/).includes(c)
const byClass = (tree, c) => findAll(tree, (n) => has(n, c))
const svgOf = (tree) => findAll(tree, (n) => n.type === 'svg')[0]
const count = (n) => 1 + (n.kids || []).reduce((a, k) => a + count(k), 0)

const mk = (id, over = {}) => ({
  nodeId: id, hostname: id, online: true, transportMode: 'direct', peerHost: '192.168.1.9', peerCapable: true,
  connectivity: { transportMode: 'direct', tunnelState: 'none', probes: [{ target: 'hub:1', result: 'open', rttMs: 5 }], sampledAt: NOW }, ...over,
})
const fleetOf = (n, over = {}) => Array.from({ length: n }, (_, i) => mk('n' + String(i + 1).padStart(2, '0'), over[i] || {}))
const running = (ids) => ids.map((id, i) => ({ taskId: 't' + i, nodeId: id, status: 'running' }))

test('link colour class: lan / direct / relay / tunnel / unknown, and offline machines have no live link', () => {
  assert.equal(fleetLinkClass(mk('a')), 'lan')
  assert.equal(fleetLinkClass(mk('a', { peerHost: '203.0.113.9', hostname: 'h.example.com' })), 'direct')
  assert.equal(fleetLinkClass(mk('a', { transportMode: 'relay' })), 'relay')
  assert.equal(fleetLinkClass(mk('a', { peerHost: '203.0.113.9', hostname: 'h.example.com', connectivity: { tunnelState: 'ready', tunnel: { kind: 'ssh', server: 'x.example', localPort: 1, remotePort: 2 } } })), 'tunnel')
  assert.equal(fleetLinkClass(mk('a', { peerHost: '203.0.113.9', hostname: 'h.example.com', connectivity: { tunnelState: 'configured', tunnel: { kind: 'ssh' } } })), 'direct') // not ready: not a tunnel yet
  assert.equal(fleetLinkClass(mk('a', { transportMode: null, connectivity: null })), 'unknown')
  assert.equal(fleetLinkClass(mk('a', { online: false })), 'off')
  assert.equal(fleetNodeModel(mk('a', { transportMode: 'relay' }), null, 0).link, 'relay')
})

test('links are bezier curves from the hub, bending to alternate sides, with the control point off the straight line', () => {
  const lay = fleetLayout({ models: fleetOf(4).map((n) => fleetNodeModel(n, null, 0)) })
  for (const e of lay.edges) {
    assert.match(e.d, /^M[\d. ]+Q[\d. ]+$/)
    const cross = (e.cx - e.x1) * (e.y2 - e.y1) - (e.cy - e.y1) * (e.x2 - e.x1)
    assert.ok(Math.abs(cross) > 100, e.id + ' is curved')
  }
  const sign = (e) => Math.sign((e.cx - e.x1) * (e.y2 - e.y1) - (e.cy - e.y1) * (e.x2 - e.x1))
  assert.deepEqual(lay.edges.map(sign), [-1, 1, -1, 1])
  const mid = fleetPointOn(lay.edges[0], 0.5)
  assert.deepEqual([lay.edges[0].lx, lay.edges[0].ly], [mid.x, mid.y]) // the label sits on the curve
  assert.deepEqual(fleetPointOn(lay.edges[0], 0), { x: lay.edges[0].x1, y: lay.edges[0].y1 })
  assert.deepEqual(fleetPointOn(lay.edges[0], 1), { x: lay.edges[0].x2, y: lay.edges[0].y2 })
  assert.deepEqual(fleetLayout({ models: fleetOf(4).map((n) => fleetNodeModel(n, null, 0)) }), lay) // deterministic
})

test('stage: a deterministic starfield (about 60 stars, a few twinkle) and a stage wrapper for the dark and light themes', () => {
  const a = fleetStars(640, 320, 60)
  assert.deepEqual(a, fleetStars(640, 320, 60))
  assert.equal((a.dots.match(/M/g) || []).length + a.twinkle.length, 60)
  assert.ok(a.twinkle.length >= 5 && a.twinkle.length <= 10)
  const tree = render(mkHub(fleetOf(3)))
  assert.equal(byClass(tree, 'fl-stage').length, 1)
  assert.equal(findAll(svgOf(tree), (n) => n.type === 'path' && has(n, 'fl-stars')).length, 1) // all static stars in a single path
  assert.equal(byClass(tree, 'fl-twinkle').length, a.twinkle.length)
  assert.match(fleetCss.join(''), /\.dra-light \.fl-stage\{/)
})

test('hub: luminous core with a halo, three orbit rings turning different ways, a radar sweep and a sphere highlight', () => {
  const svg = svgOf(render(mkHub(fleetOf(3))))
  assert.equal(byClass(svg, 'fl-halo').length, 1)
  assert.deepEqual(byClass(svg, 'fl-orbit').map((o) => cls(o).replace('fl-orbit ', '')), ['o1', 'o2', 'o3'])
  assert.equal(byClass(svg, 'fl-sweep').length, 1)
  assert.equal(byClass(svg, 'fl-hub').length, 1)
  assert.equal(findAll(svg, (n) => n.type === 'circle' && has(n, 'fl-shine')).length >= 1, true)
  const css = fleetCss.join('')
  assert.match(css, /\.fl-orbit\.o1\{[^}]*animation:fl-spin /)
  assert.match(css, /\.fl-orbit\.o2\{[^}]*animation:fl-spin-r /) // the middle ring turns the other way and is dashed
  assert.match(css, /\.fl-orbit\.o2\{[^}]*stroke-dasharray/)
  assert.match(css, /\.fl-sweep\{animation:fl-spin 9s linear infinite/)
  assert.match(texts(svg).join(''), /主控/)
  // every rotating thing turns around the hub, not around the corner of the picture
  for (const el of [...byClass(svg, 'fl-orbit'), ...byClass(svg, 'fl-sweep'), ...byClass(svg, 'fl-halo')]) assert.match(el.props.style.transformOrigin, /^320px 160px$/)
})

test('online machines: glass orb with highlight, orbit ring, pulse and a floating layer; offline ones are dim, dashed and still', () => {
  const nodes = [mk('on'), mk('off', { online: false }), mk('st', { stale: true })]
  const svg = svgOf(render(mkHub(nodes)))
  const node = (id) => findAll(svg, (n) => n.type === 'g' && n.props.role === 'button' && n.props['aria-label'].startsWith(id))[0]
  const on = node('on')
  assert.equal(findAll(on, (n) => has(n, 'fl-pulse')).length, 1)
  assert.equal(findAll(on, (n) => has(n, 'bob')).length, 1)
  assert.equal(findAll(on, (n) => has(n, 'fl-shine')).length, 1)
  assert.equal(findAll(on, (n) => has(n, 'fl-ring')).length, 1)
  assert.ok(has(on, 'online'))
  const off = node('off')
  assert.equal(findAll(off, (n) => has(n, 'fl-pulse') || has(n, 'bob')).length, 0)
  assert.ok(has(off, 'offline'))
  const st = node('st')
  assert.ok(has(st, 'stale'))
  assert.equal(findAll(st, (n) => has(n, 'fl-pulse') || has(n, 'bob')).length, 0) // a stale heartbeat does not look alive
  const css = fleetCss.join('')
  assert.match(css, /\.fl-node\.offline \.fl-dot\{[^}]*stroke-dasharray/)
  assert.match(css, /\.fl-node\.stale \.fl-ring\{[^}]*stroke-dasharray[^}]*animation:fl-flicker 1\.4s steps\(1\) 1\}/) // the broken ring flickers once
  // status glyphs stay: nothing relies on colour alone
  assert.deepEqual(findAll(svg, (n) => has(n, 'fl-glyph')).map((n) => texts(n).join('')), ['✕', '✓', '!']) // off, on, st (sorted by id)
})

test('glass capsules carry the name; an old AC version gets its own warning capsule', () => {
  const nodes = [mk('old', { acVersion: '0.4.30' }), mk('new', { acVersion: '0.4.36' }), mk('unk')]
  const svg = svgOf(render(mkHub(nodes)))
  const caps = byClass(svg, 'fl-cap')
  assert.equal(caps.filter((c) => !has(c, 'old')).length, 3)
  assert.equal(caps.filter((c) => has(c, 'old')).length, 1)
  assert.ok(texts(svg).join('').includes('v0.4.30'))
  assert.ok(!texts(svg).join('').includes('v0.4.36')) // only the problem is called out in the picture; the table has every version
  assert.ok(fleetCapsuleWidth('版本') > fleetCapsuleWidth('ab') && fleetCapsuleWidth('') === 14)
})

test('flowing light: online links carry a flow layer in their category colour, offline ones do not, running ones flow faster', () => {
  const nodes = [mk('a'), mk('b', { transportMode: 'relay' }), mk('c', { online: false }), mk('d')]
  const svg = svgOf(render(mkHub(nodes, { tasks: running(['d']) })))
  const flows = byClass(svg, 'fl-flow')
  assert.deepEqual(flows.map((f) => cls(f).replace('fl-flow ', '')), ['lk-lan', 'lk-relay', 'lk-lan fast'])
  const links = byClass(svg, 'fl-link')
  assert.equal(links.length, 4)
  assert.equal(findAll(links[2], (n) => has(n, 'fl-flow')).length, 0) // c is offline
  assert.deepEqual(byClass(svg, 'fl-edge').map((e) => (cls(e).match(/lk-\w+/) || [])[0]), ['lk-lan', 'lk-relay', 'lk-off', 'lk-lan'])
  const css = fleetCss.join('')
  assert.match(css, /@keyframes fl-flow\{to\{stroke-dashoffset:-37\}\}/) // negative offset: the light runs hub -> node along the path
  assert.match(css, /\.lk-lan\{--fl-lk:var\(--dra-link-lan\)\}/)
  assert.match(css, /\.lk-tunnel\{--fl-lk:var\(--dra-link-tunnel\)\}/)
})

test('packets: running tasks fly along the link path, queued ones park before the node, backlog parks amber beside it with its count', () => {
  const nodes = [
    mk('a'), mk('b'),
    mk('c', { link: { pending: 5, oldestMs: 1000, maxTries: 1, types: { x: 5 } } }),
    mk('d', { online: false, link: { pending: 2, oldestMs: 1, maxTries: 0, types: {} } }),
  ]
  const tasks = [{ taskId: '1', nodeId: 'a', status: 'running' }, { taskId: '2', nodeId: 'b', status: 'queued' }, { taskId: '3', nodeId: 'b', status: 'queued' }, { taskId: '4', nodeId: 'b', status: 'queued' }]
  const svg = svgOf(render(mkHub(nodes, { tasks })))
  const fly = byClass(svg, 'fl-fly')
  assert.equal(fly.length, 2) // two lights on the one running machine
  const lay = fleetLayout({ models: nodes.map((n) => fleetNodeModel(n, null, 0)) })
  assert.equal(fly[0].props.style.offsetPath, "path('" + lay.edges[0].d + "')") // the packet follows exactly the drawn curve
  assert.equal(fly[0].props.r > 0 && fly[0].props.cx === undefined, true) // drawn at the origin and moved by offset-distance
  assert.ok(has(fly[1], 'b'))
  assert.equal(byClass(svg, 'q').length, 2) // at most two parked queued lights per machine
  assert.equal(findAll(svg, (n) => has(n, 'bl')).length, 3 + 2) // c: min(5,3) dots, d: 2 dots (an offline machine keeps its backlog on show)
  assert.deepEqual(byClass(svg, 'fl-blcount').map((t) => texts(t).join('')), ['5', '2'])
  // the same facts stay in the aria label and the table
  const label = findAll(svg, (n) => n.props && n.props.role === 'button').map((g) => g.props['aria-label'])
  assert.ok(label.find((l) => l.startsWith('c')).includes('待送达 5 条'))
  assert.ok(label.find((l) => l.startsWith('d')).includes('待送达 2 条'))
  // a packet never rides an offline or stale link
  const dead = svgOf(render(mkHub([mk('x', { online: false }), mk('y', { stale: true })], { tasks: running(['x', 'y']) })))
  assert.equal(byClass(dead, 'fl-fly').length, 0)
})

test('flying packets are capped at the first twelve online machines', () => {
  const nodes = fleetOf(20)
  const svg = svgOf(render(mkHub(nodes, { tasks: running(nodes.map((n) => n.nodeId)) })))
  assert.equal(fleetFlyCap, 12)
  assert.equal(byClass(svg, 'fl-fly').length, 24)
  const svg2 = svgOf(render(mkHub(fleetOf(20, { 0: { online: false }, 1: { online: false } }), { tasks: running(fleetOf(20).map((n) => n.nodeId)) })))
  assert.equal(byClass(svg2, 'fl-fly').length, 24) // offline machines do not use up the budget
})

test('relay down: a red broken line and a relay box, and no flying packet pretends to use it', () => {
  const svg = svgOf(render(mkHub(fleetOf(3), { relay: { reachable: false } })))
  assert.equal(byClass(svg, 'fl-relaybox').length, 1)
  assert.equal(findAll(svg, (n) => n.type === 'path' && /fl-edge down/.test(cls(n))).length, 1)
  assert.match(fleetCss.join(''), /\.fl-edge\.down\{[^}]*stroke:var\(--dra-danger\)/)
  assert.match(texts(svg).join(''), /中继 ✕/)
})

test('hover, focus and pin: the machine is zoomed and lit, the rest dim; a pin adds the rotating reticle; a plain picture has no dimming', () => {
  const nodes = fleetOf(4)
  assert.ok(!/fl-focus/.test(cls(svgOf(render(mkHub(nodes))))))
  const pinned = svgOf(render(mkHub(nodes), ['n02', '']))
  assert.ok(/fl-focus/.test(cls(pinned)))
  const hot = byClass(pinned, 'hot')
  assert.equal(hot.filter((n) => has(n, 'fl-node')).length, 1)
  assert.equal(hot.filter((n) => has(n, 'fl-link')).length, 1)
  assert.equal(byClass(pinned, 'fl-reticle').length, 1)
  assert.ok(has(findAll(pinned, (n) => n.props && n.props.role === 'button' && n.props['aria-pressed'] === 'true')[0], 'pinned'))
  const peeked = svgOf(render(mkHub(nodes), ['', 'n03']))
  assert.ok(/fl-focus/.test(cls(peeked)))
  assert.equal(byClass(peeked, 'fl-reticle').length, 0) // hover lights the machine but only a pin gets the reticle
  assert.equal(byClass(peeked, 'hot').filter((n) => has(n, 'fl-node')).length, 1)
  const css = fleetCss.join('')
  assert.match(css, /\.fl-node\.hot\{transform:scale\(1\.14\)\}/)
  assert.match(css, /\.fl-focus \.fl-node:not\(\.hot\)[^{]*\{opacity:\.45\}/)
  assert.match(css, /\.fl-reticle\{[^}]*animation:fl-spin 8s linear infinite/)
})

test('density tiers: full up to 8 machines, lite to 16 (no floating), dense beyond (no labels); packets and pulses degrade first', () => {
  assert.deepEqual(fleetDensity(3), { tier: 'full', float: true, pulse: true, labels: true, edgeLabels: true })
  assert.deepEqual(fleetDensity(8).tier, 'full')
  assert.deepEqual(fleetDensity(9), { tier: 'lite', float: false, pulse: true, labels: true, edgeLabels: false })
  assert.deepEqual(fleetDensity(13), { tier: 'lite', float: false, pulse: false, labels: true, edgeLabels: false })
  assert.deepEqual(fleetDensity(17), { tier: 'dense', float: false, pulse: false, labels: false, edgeLabels: false })
  for (const [n, tier] of [[3, 'fl-full'], [12, 'fl-lite'], [30, 'fl-dense']]) assert.ok(cls(svgOf(render(mkHub(fleetOf(n))))).includes(tier), tier)
  const dense = svgOf(render(mkHub(fleetOf(30))))
  assert.equal(byClass(dense, 'bob').length, 0)
  assert.equal(byClass(dense, 'fl-pulse').length, 0)
  assert.equal(byClass(dense, 'fl-cap').length, 0)
  assert.equal(findAll(dense, (n) => n.props && n.props.role === 'button').length, 30) // still every machine, still keyboard reachable
})

test('element budget: the picture stays small at 3 / 8 / 30 machines and animation never scales with the fleet beyond the caps', () => {
  const stat = (n, withTasks) => {
    const nodes = fleetOf(n)
    const svg = svgOf(render(mkHub(nodes, withTasks ? { tasks: running(nodes.map((x) => x.nodeId)) } : {})))
    const total = count(svg)
    const animated = findAll(svg, (e) => /\b(bob|fl-pulse|fl-flow|fl-fly|fl-twinkle|fl-halo|fl-orbit|fl-sweep|fl-park)\b/.test(cls(e))).length
    return { total, animated }
  }
  const idle = [3, 8, 30].map((n) => stat(n, false))
  const busy = [3, 8, 30].map((n) => stat(n, true))
  process.stdout.write('\n# scene budget (elements / animated): idle ' + [3, 8, 30].map((n, i) => n + ':' + idle[i].total + '/' + idle[i].animated).join(' ') + '  busy ' + [3, 8, 30].map((n, i) => n + ':' + busy[i].total + '/' + busy[i].animated).join(' ') + '\n')
  assert.ok(idle[0].total < 120 && idle[1].total < 230 && idle[2].total < 480, JSON.stringify(idle))
  assert.ok(busy[2].animated - idle[2].animated <= 2 * fleetFlyCap, 'flying packets are capped')
  assert.ok(busy[2].animated < busy[1].animated * 3, 'thirty machines do not animate three times as much as eight')
  assert.ok(idle[2].animated < 90)
})
