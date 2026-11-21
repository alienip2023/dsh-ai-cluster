import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')

function loadPanel(globals = {}) {
  let plugin
  let Panel
  let state
  const setPanelState = () => {}
  const react = {
    createElement(type, props, ...kids) { return { type, props: props || {}, kids: kids.flat(Infinity) } },
    useState(initial) {
      if (initial && Array.isArray(initial.nodes) && Array.isArray(initial.tasks)) return [state, setPanelState]
      if (initial && initial.width === 0 && initial.height === 0) return [{ width: 900, height: 560 }, () => {}]
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useRef(initial) { return { current: initial } },
    useEffect() {},
    useMemo(fn) { return fn() },
  }
  const window = {
    ...globals,
    matchMedia() { return { matches: true } },
    __ModuleLoader__: { load(mod) { plugin = mod.factory(() => react) } },
  }
  vm.runInNewContext(source, { window, console, ...globals }, { filename: 'lib/client.js' })
  plugin.apply({ slots: {
    inject(_slot, register) { register() },
    register(slot, component) { if (slot.name === 'main') Panel = component },
  } })
  function expand(tree) {
    if (tree == null || typeof tree !== 'object') return tree
    if (typeof tree.type === 'function') return expand(tree.type({ ...tree.props, children: tree.kids }))
    return { ...tree, kids: tree.kids.map(expand) }
  }
  return {
    plugin,
    render(patch = {}) {
      state = { screen: 'computers', computersMode: 'topo', mode: 'hub', role: 'hub', nodes: [], tasks: [], ...patch }
      return expand(Panel())
    },
  }
}

function byClass(tree, name) {
  if (!tree || typeof tree !== 'object') return []
  const own = String(tree.props.className || '').split(/\s+/).includes(name) ? [tree] : []
  return own.concat(tree.kids.flatMap((kid) => byClass(kid, name)))
}

const labels = (tree, className) => byClass(tree, className).map((el) => el.kids.join(''))

const H4 = 'P3-H4: missing evidence must be unknown'
test('P3-H4 link category falls back to unknown', () => {
  const { render } = loadPanel()
  const cases = [
    [{ transport: 'direct', connectivity: { transportMode: 'relay' }, address: 'pc.local' }, '未知'],
    [{ transportMode: 'relay', address: '' }, '中继'],
    [{ transportMode: 'direct', address: '192.168.1.20' }, '局域网直连'],
    [{ transportMode: 'direct', address: '203.0.113.8' }, '直连'],
    [{ transportMode: 'direct', address: '' }, '直连'],
    [{ transportMode: 'direct' }, '直连'],
    [{ transportMode: '', address: 'pc.local' }, '未知'],
    [{ transportMode: 'weird', address: 'pc.local' }, '未知'],
    [{ transportMode: { mode: 'direct' }, address: 'pc.local' }, '未知'],
  ]
  for (const computersMode of ['topo', 'cards']) {
    for (const [fields, expected] of cases) {
      const [cat] = labels(render({ computersMode, nodes: [{ nodeId: 'pc', online: false, ...fields }] }), 'dra-link-category')
      if (!fields.transportMode) assert.equal(cat, '未知', 'P3-H4: missing evidence must be unknown')
      assert.equal(cat, expected, H4)
    }
  }
})

test('P3-H6 screens unchanged', () => {
  const { plugin } = loadPanel()
  const ids = Array.from(plugin.P2_SCREENS, (entry) => entry[0])
  assert.deepEqual(ids, ['nodes','tasks','team'], 'P3-H6: three screen ids must be unchanged')
  assert.equal(plugin.selectHubScreen({ screen: 'no-such-screen' }), 'nodes', 'P3-H6: unknown screen defaults to nodes')
})

test('P3-H7 empty states do not throw', () => {
  const { render } = loadPanel()
  for (const computersMode of ['topo', 'cards']) {
    assert.doesNotThrow(() => render({ computersMode }))
    assert.doesNotThrow(() => render({ computersMode, nodes: [{ nodeId: 'pc', online: false }] }))
    assert.doesNotThrow(() => render({ computersMode, nodes: [{ nodeId: 'pc', online: true }], topology: null }))
  }
})

const H10 = 'P3-H10: hysteresis must be display-only'
test('P3-H10 hysteresis N=2 display only', () => {
  const { plugin, render } = loadPanel()
  const node = { nodeId: 'pc', online: true, transportMode: 'direct', probes: [{ rttMs: 31 }] }
  const staleNode = Object.freeze({ ...node, stale: true, silentMs: 90_000, thresholdMs: 60_000 })
  const layoutBefore = plugin.topologyLayout({ nodes: [staleNode] })
  const show = (n, computersMode = 'topo') => render({ computersMode, nodes: [n] })
  const chip = (tree) => labels(tree, 'dra-link-health')

  const first = show(staleNode)
  assert.deepEqual(chip(first), ['健康: 探测失败 1/2'], H10)
  assert.deepEqual(chip(show(staleNode, 'cards')), ['健康: 连续失败'], H10)
  assert.deepEqual(chip(show({ ...node, stale: false })), ['健康: 稳定'], H10)
  assert.deepEqual(chip(show(staleNode)), ['健康: 探测失败 1/2'], H10)
  assert.deepEqual(chip(show({ ...node, stale: null })), ['健康: 未知'], H10)
  const second = show(staleNode)
  assert.deepEqual(chip(second), ['健康: 连续失败'], H10)
  for (const tree of [first, second]) {
    assert.deepEqual(labels(tree, 'dra-mesh-status'), ['心跳超时'], H10)
    assert.deepEqual(labels(tree, 'dra-tg-elabel'), ['断'], H10)
  }
  const layoutAfter = plugin.topologyLayout({ nodes: [staleNode] })
  assert.deepEqual(layoutAfter, layoutBefore, H10)
  assert.equal(layoutAfter.nodes[0].status, 'stale', H10)
  assert.equal(layoutAfter.nodes[0].online, false, H10)
  assert.equal(layoutAfter.nodes[0].rttLabel, 'rtt 31ms', H10)
  assert.equal(layoutAfter.edges[0].label, '断', H10)
  assert.equal(staleNode.online, true, H10)
  assert.equal(staleNode.stale, true, H10)
})

test('P3-H12 no probe from render', () => {
  const message = 'P3-H12: render must not probe or schedule'
  function forbidden() { throw new Error(message) }
  const { render } = loadPanel({ fetch: forbidden, XMLHttpRequest: forbidden, WebSocket: forbidden, setTimeout: forbidden, setInterval: forbidden })
  const nodes = [{ nodeId: 'pc', online: true, stale: true, transportMode: 'direct', address: 'pc.local' }]
  assert.doesNotThrow(() => render({ nodes }), message)
  assert.doesNotThrow(() => render({ nodes, computersMode: 'cards' }), message)
})
