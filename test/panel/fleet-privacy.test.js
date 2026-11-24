// Public-address privacy of the fleet screens: LAN addresses and a machine's own name stay visible, any other IP / domain / URL host /
// relay or tunnel server is masked to a stable short form unless the panel-wide "显示公网地址" switch is on. Masking is display only:
// copy buttons still copy the real value, and no attribute (title, aria-label ...) may say anything the visible text does not.
import assert from 'node:assert/strict'
import test from 'node:test'
import { makeCore, expand, texts, findAll } from './_fake.js'
import { dataEmptyHub } from '../../src/panel/data.js'
import {
  createFleet, fleetDiscoveryRows, fleetHostOf, fleetListenerNotice, fleetMachInit, fleetMask, fleetMaskHost, fleetMaskText,
  fleetNotices, fleetPrefKey, fleetProbeRows, fleetPublicHost, fleetShowAddr, fleetTunnelLine,
} from '../../src/panel/fleet.js'

const NOW = Date.now()
const noop = () => {}
const props = (hub) => ({ hub, role: 'hub', go: noop, refresh: noop, ui: { confirm: async () => true, alert: noop, notify: noop, prompt: async () => null } })

/* ── 遮罩函数 ───────────────────────────────────────────────────── */

test('mask: IPv4 keeps the first octet, IPv6 the first group, domains the first label; always ending in •••', () => {
  assert.equal(fleetMaskHost('203.0.113.9'), '203.•••')
  assert.equal(fleetMaskHost('2001:db8::1'), '2001:•••')
  assert.equal(fleetMaskHost('[2001:db8::1]'), '[2001:•••]')
  assert.equal(fleetMaskHost('relay.example.com'), 'relay.•••')
  // stable: the same input always gives the same short form, and different hosts of one domain share it
  assert.equal(fleetMaskHost('203.0.113.9'), fleetMaskHost('203.0.113.9'))
  assert.equal(fleetMask('a.example.com'), fleetMask('a.other.org'))
})

test('mask: IPv4 / IPv6 / domain / host:port / [v6]:port / URL', () => {
  assert.equal(fleetMask('203.0.113.9'), '203.•••')
  assert.equal(fleetMask('203.0.113.9:8890'), '203.•••:8890')
  assert.equal(fleetMask('2001:db8::1'), '2001:•••')
  assert.equal(fleetMask('[2001:db8::1]:8890'), '[2001:•••]:8890')
  assert.equal(fleetMask('relay.example.com'), 'relay.•••')
  assert.equal(fleetMask('relay.example.com:8890'), 'relay.•••:8890')
  assert.equal(fleetMask('wss://relay.example.com:8890/relay'), 'wss://relay.•••:8890')
  assert.equal(fleetMask('https://203.0.113.9/api/x'), 'https://203.•••')
  assert.equal(fleetMask('ws://[2001:db8::1]:8890/relay'), 'ws://[2001:•••]:8890')
})

test('mask: a URL loses its path, query and credentials, so no token can ride along', () => {
  const m = fleetMask('wss://user:p4ss@relay.example.com:8890/relay?token=SECRET#frag')
  assert.equal(m, 'wss://relay.•••:8890')
  assert.doesNotMatch(m, /SECRET|p4ss|user|relay\?/)
})

test('mask: LAN addresses, machine names, loopback and 0.0.0.0 stay as they are', () => {
  for (const v of ['10.1.2.3', '172.16.0.9', '192.168.1.20', '169.254.1.1', '127.0.0.1', '192.168.1.20:19387', 'nas.local', 'build01', 'build01:8890', 'fd00::8', '[fd00::8]:9000', 'fe80::1', '::1', '0.0.0.0', '::',
    'ws://192.168.1.5:19387/relay', 'ws://hub:19387', 'http://nas.local:8080/x']) assert.equal(fleetMask(v), v, v)
  assert.equal(fleetMask(''), '')
  assert.equal(fleetMask(null), '')
  assert.equal(fleetMask(undefined), '')
  assert.equal(fleetMask(12), '12')
  assert.equal(fleetPublicHost('203.0.113.9'), true)
  assert.equal(fleetPublicHost('192.168.1.1'), false)
  assert.equal(fleetPublicHost('172.32.0.1'), true) // just outside 172.16/12
  assert.equal(fleetPublicHost('[fd00::8]'), false)
})

test('mask: the switch decides; showing returns the original text byte for byte', () => {
  assert.equal(fleetShowAddr('wss://relay.example.com:8890/relay?t=1', true), 'wss://relay.example.com:8890/relay?t=1')
  assert.equal(fleetShowAddr('wss://relay.example.com:8890/relay?t=1', false), 'wss://relay.•••:8890')
  assert.equal(fleetShowAddr('wss://relay.example.com:8890/relay?t=1'), 'wss://relay.•••:8890') // hidden unless explicitly true
  assert.equal(fleetShowAddr('wss://relay.example.com:8890/relay?t=1', 'yes'), 'wss://relay.•••:8890')
  assert.equal(fleetHostOf('wss://u@relay.example.com:8890/x'), 'relay.example.com')
  assert.equal(fleetHostOf('[2001:db8::1]:80'), '[2001:db8::1]')
  assert.equal(fleetHostOf('203.0.113.9:80'), '203.0.113.9')
  assert.equal(fleetHostOf('nas.local'), 'nas.local')
})

test('mask text: addresses inside free text are masked, everything else is left alone', () => {
  const t = '连接 203.0.113.9:8890 失败，回退 relay.example.com，LAN 192.168.1.5 与 nas.local 正常；见 wss://relay.example.com:8890/relay?token=abc。版本 0.4.36，时间 12:30:45，文件 settings.json，地址不能是 0.0.0.0，主机 hub:19387'
  const m = fleetMaskText(t, false)
  for (const gone of ['203.0.113.9', 'example.com', 'token=abc', '/relay?']) assert.ok(!m.includes(gone), gone)
  for (const kept of ['203.•••:8890', 'relay.•••', '192.168.1.5', 'nas.local', 'wss://relay.•••:8890', '0.4.36', '12:30:45', 'settings.json', '0.0.0.0', 'hub:19387']) assert.ok(m.includes(kept), kept)
  assert.equal(fleetMaskText(t, true), t)
  assert.equal(fleetMaskText(null, false), '')
  assert.equal(fleetMaskText('绑定 2001:db8::1 失败', false), '绑定 2001:••• 失败')
})

/* ── 各处显示 ───────────────────────────────────────────────────── */

const PUB_IP = '203.0.113.8'
const PUB_HOST = 'relay.example.com'
const PUB_URL = 'wss://relay.example.com:8890/relay'
const PUB_REMOTE = '198.51.100.7:51234'
const SECRETS = [PUB_IP, PUB_HOST, 'example.com', '198.51.100.7', '203.0.113.9', '198.51.100.9']

const nodePub = {
  nodeId: 'node-alpha-0001', hostname: 'alpha', peerHost: PUB_IP, online: true, os: 'linux', arch: 'x64', transportMode: 'direct', taskCount: 1,
  connectivity: { transportMode: 'direct', tunnelState: 'ready', tunnel: { kind: 'ssh', server: PUB_HOST, localPort: 1, remotePort: 2 },
    probes: [{ target: PUB_HOST + ':8890', result: 'open', rttMs: 5 }, { target: 'hub:19387', result: 'open', rttMs: 2 }, { target: '192.168.1.5:19387', result: 'closed', rttMs: null }], sampledAt: NOW },
  peerCapable: true, confirm: 'confirmed',
}
const nodeLan = { nodeId: 'node-beta-0002', hostname: 'beta', peerHost: '192.168.1.20', online: true, os: 'darwin', arch: 'arm64', transportMode: 'direct', taskCount: 0, peerCapable: true }
const mkHub = (extra = {}) => Object.assign({}, dataEmptyHub, {
  loading: false, at: NOW, tick: 1, nodes: [nodePub, nodeLan], tasks: [],
  counts: { nodes: 2, online: 2, tasks: 0, running: 0, active: 0, done: 0, failed: 0 },
  connection: { everConnected: false, byNode: [], recent: [
    { at: NOW, result: 'fail', code: 'HS', title: '握手超时 ' + PUB_IP, remote: PUB_REMOTE, nodeId: 'node-alpha-0001', detail: '连接 ' + PUB_URL + ' 无响应', hint: '检查 ' + PUB_HOST + ' 的防火墙' },
    { at: NOW - 1000, result: 'fail', code: 'HS', title: '握手超时', remote: '192.168.1.20:5000', detail: '', hint: '' },
  ], reachability: { hint: '外网 ' + PUB_IP + ' 不通' } },
  caps: { reachability: { loopback: true, hint: '绑定了 ' + PUB_IP, bound: PUB_IP, port: 19387 }, listener: { ok: false, error: 'bind ' + PUB_IP + ' failed' } },
  discovery: { enabled: true, configured: true, peers: [{ node: 'p1', hostname: '203.0.113.9', role: 'node', port: 19387 }, { node: 'p2', hostname: '192.168.1.30', role: 'node', port: 19387 }, { node: 'p3', hostname: 'lab.example.com', role: 'node', port: 1 }] },
  topology: { nodes: [], peerLinks: [], summary: { peerCapable: 2 } },
}, extra)

/** Every string that ends up on screen or in an attribute (title, aria-label, ...), so a leak anywhere is caught. */
function surface(tree) {
  const out = []
  const walk = (n) => {
    if (typeof n === 'string') { out.push(n); return }
    if (!n || typeof n !== 'object') return
    for (const [k, v] of Object.entries(n.props || {})) if (typeof v === 'string' && k !== 'key') out.push(v) // `key` never reaches the DOM
    for (const k of n.kids || []) walk(k)
  }
  walk(tree)
  return out.join('\n')
}
const leaked = (tree) => SECRETS.filter((x) => surface(tree).includes(x))
const rig = () => { const core = makeCore(); return { core, f: createFleet(core) } }
const render = ({ core, f }, name, hub) => expand(core.h(f[name], props(hub)))
const withState = (name, hub, state) => { const core = makeCore({ state }); return expand(core.h(createFleet(core)[name], props(hub))) }
const toggleOf = (tree) => findAll(tree, (n) => n.type === 'input' && n.props.type === 'checkbox')[0]

test('toggle: hidden by default on the machines screen (cards, probes, tunnel, discovery) and on the overview (attempts, banners)', () => {
  const r = rig()
  const machines = render(r, 'Machines', mkHub())
  assert.deepEqual(leaked(machines), [])
  const text = surface(machines)
  assert.match(text, /relay\.•••/) // tunnel server and probe target
  assert.match(text, /203\.•••/) // peerHost
  assert.match(text, /地址已隐藏（203\.•••）/) // discovery peer
  assert.match(text, /地址已隐藏（lab\.•••）/)
  assert.ok(text.includes('hub:19387') && text.includes('192.168.1.5:19387')) // LAN / single-label probe targets stay
  assert.ok(text.includes('192.168.1.30')) // LAN discovery peer stays
  assert.ok(text.includes('alpha') && text.includes('beta') && text.includes('node-alpha-0001')) // names and ids always visible
  assert.equal(toggleOf(machines).props.checked, false)

  const overview = render(r, 'Overview', mkHub())
  assert.deepEqual(leaked(overview), [])
  const o = surface(overview)
  assert.match(o, /公网地址：已隐藏/)
  assert.match(o, /198\.•••:51234/) // attempt remote
  assert.match(o, /192\.168\.1\.20:5000/) // LAN remote stays
  assert.match(o, /当前绑定 203\.•••:19387/)
  assert.match(o, /诊断：外网 203\.••• 不通/)
  assert.match(o, /bind 203\.••• failed/)
})

test('toggle: switching it on reveals everything everywhere, switching it off hides it again, with no leak in either direction', () => {
  const r = rig()
  const hub = mkHub()
  const set = (on) => toggleOf(render(r, 'Machines', hub)).props.onChange({ target: { checked: on } })
  set(true)
  const machines = render(r, 'Machines', hub)
  assert.equal(toggleOf(machines).props.checked, true)
  const mt = surface(machines)
  for (const shown of [PUB_IP, PUB_HOST + ':8890', 'ssh · ' + PUB_HOST, '203.0.113.9', 'lab.example.com']) assert.ok(mt.includes(shown), shown)
  assert.ok(!mt.includes('•••'))
  const overview = render(r, 'Overview', hub)
  const ot = surface(overview)
  assert.match(ot, /公网地址：已显示/)
  for (const shown of [PUB_REMOTE, PUB_URL, '当前绑定 ' + PUB_IP + ':19387', '诊断：外网 ' + PUB_IP + ' 不通']) assert.ok(ot.includes(shown), shown)
  set(false)
  assert.deepEqual(leaked(render(r, 'Machines', hub)), [])
  assert.deepEqual(leaked(render(r, 'Overview', hub)), [])
  assert.match(surface(render(r, 'Overview', hub)), /公网地址：已隐藏/)
})

test('toggle: it is a real labelled checkbox on the machines screen, and only a read-only hint on the overview', () => {
  const r = rig()
  const machines = render(r, 'Machines', mkHub())
  const label = findAll(machines, (n) => n.type === 'label' && n.kids.some((k) => k.type === 'input' && k.props.type === 'checkbox'))[0]
  assert.ok(label)
  assert.match(texts(label).join(''), /显示公网地址/)
  const overview = render(r, 'Overview', mkHub())
  assert.equal(toggleOf(overview), undefined)
  assert.equal(findAll(overview, (n) => n.type === 'input').length, 0)
  assert.equal(findAll(overview, (n) => n.props && n.props.role === 'note').length, 1)
})

test('topology: the table, SVG labels and tooltips only ever carry names, so nothing public can leak from them', () => {
  const r = rig()
  const overview = render(r, 'Overview', mkHub({ nodes: [nodePub, nodeLan] }))
  const svg = findAll(overview, (n) => n.type === 'svg')[0]
  const table = findAll(overview, (n) => n.type === 'table')[0]
  assert.deepEqual(SECRETS.filter((x) => surface(svg).includes(x) || surface(table).includes(x)), [])
  // a pinned machine's detail panel shows no address either
  const pinned = withState('Overview', mkHub(), ['node-alpha-0001'])
  assert.deepEqual(leaked(pinned), [])
})

test('no attribute says more than the visible text: titles and aria-labels never carry a public address while hidden', () => {
  const r = rig()
  for (const name of ['Machines', 'Overview']) {
    const tree = render(r, name, mkHub())
    const attrs = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      for (const [k, v] of Object.entries(n.props || {})) if (typeof v === 'string' && k !== 'className' && k !== 'key') attrs.push(v)
      for (const kid of n.kids || []) walk(kid)
    }
    walk(tree)
    for (const a of attrs) for (const secret of SECRETS) assert.ok(!a.includes(secret), name + ': ' + secret + ' in attribute ' + a)
  }
})

test('probes and tunnel helpers mask by default and reveal with the switch', () => {
  assert.deepEqual(fleetProbeRows(nodePub).map((p) => p.target), ['relay.•••:8890', 'hub:19387', '192.168.1.5:19387'])
  assert.deepEqual(fleetProbeRows(nodePub, true).map((p) => p.target), [PUB_HOST + ':8890', 'hub:19387', '192.168.1.5:19387'])
  assert.equal(fleetTunnelLine(nodePub), 'ssh · relay.••• · 1→2')
  assert.equal(fleetTunnelLine(nodePub, true), 'ssh · relay.example.com · 1→2')
  assert.deepEqual(fleetDiscoveryRows(mkHub().discovery, []).rows.map((r) => r.addressLabel), ['地址已隐藏（203.•••）', '192.168.1.30', '地址已隐藏（lab.•••）'])
  assert.deepEqual(fleetDiscoveryRows(mkHub().discovery, [], true).rows.map((r) => r.addressLabel), ['203.0.113.9', '192.168.1.30', 'lab.example.com'])
})

test('banners: reachability, listener and diagnosis text follow the switch', () => {
  const hub = mkHub()
  const hidden = fleetNotices(hub, NOW, false).map((n) => n.body).join('\n')
  const shown = fleetNotices(hub, NOW, true).map((n) => n.body).join('\n')
  assert.ok(!hidden.includes(PUB_IP) && hidden.includes('203.•••'))
  assert.ok(shown.includes(PUB_IP) && !shown.includes('•••'))
  assert.ok(!fleetListenerNotice({ ok: false, error: 'bind ' + PUB_IP }, NOW).body.includes(PUB_IP))
  assert.ok(fleetListenerNotice({ ok: false, error: 'bind ' + PUB_IP }, NOW, true).body.includes(PUB_IP))
})

/* ── 添加机器 ──────────────────────────────────────────────────────── */

const pairState = (showPublic, hubUrl, code) => Object.assign({}, fleetMachInit, {
  showPublic,
  pair: { loading: false, note: '', data: { ok: true, listener: { host: PUB_IP, port: 19387, hint: '独立监听绑定在 ' + PUB_IP }, note: '', codes: [{ address: PUB_IP, name: 'en0', usable: true, pairCode: code, hubUrl }] } },
})

test('add machine: a public hub URL and pair line are masked while hidden; LAN ones are not', () => {
  const code = 'ABCDEF123456SECRETTAIL'
  const off = withState('Machines', mkHub({ nodes: [] }), [pairState(false, 'ws://203.0.113.8:19387', code)])
  const t = surface(off)
  assert.ok(t.includes('ws://203.•••:19387'))
  assert.ok(t.includes('监听 203.•••:19387'))
  assert.ok(t.includes('pair: ABCDEF•••'))
  assert.ok(!t.includes('SECRETTAIL') && !t.includes(PUB_IP))
  const on = surface(withState('Machines', mkHub({ nodes: [] }), [pairState(true, 'ws://203.0.113.8:19387', code)]))
  assert.ok(on.includes('ws://203.0.113.8:19387') && on.includes('pair: ' + code))
  const lan = surface(withState('Machines', mkHub({ nodes: [] }), [pairState(false, 'ws://192.168.1.5:19387', code)]))
  assert.ok(lan.includes('ws://192.168.1.5:19387') && lan.includes('pair: ' + code)) // LAN: visible even with the switch off
})

test('copy: masking is display only, every copy button copies the real value and says so', async () => {
  const copied = []
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (x) => { copied.push(x) } } } })
  try {
    const code = 'ABCDEF123456SECRETTAIL'
    const tree = withState('Machines', mkHub({ nodes: [] }), [pairState(false, 'ws://203.0.113.8:19387', code)])
    const btn = (label) => findAll(tree, (n) => n.type === 'button' && texts(n).join('') === label)
    const addr = btn('复制完整地址')
    const line = btn('复制完整配置行')
    assert.equal(addr.length, 1)
    assert.equal(line.length, 1)
    addr[0].props.onClick()
    line[0].props.onClick()
    await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(copied, ['ws://203.0.113.8:19387', 'pair: ' + code])
    // the buttons carry no address in their own attributes
    assert.deepEqual(SECRETS.filter((x) => [addr[0], line[0]].some((b) => JSON.stringify(Object.entries(b.props).filter(([k, v]) => typeof v === 'string' && k !== 'onClick')).includes(x))), [])
    // a visible (LAN) address keeps the same honest label
    const lanTree = withState('Machines', mkHub({ nodes: [] }), [pairState(false, 'ws://192.168.1.5:19387', code)])
    assert.equal(findAll(lanTree, (n) => n.type === 'button' && texts(n).join('') === '复制完整地址').length, 1)
    assert.equal(findAll(lanTree, (n) => n.type === 'button' && texts(n).join('') === '复制 pair 配置行').length, 1)
  } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator
  }
})

test('the enrollment token stays fully visible and copyable (it is a secret to paste, not an address)', () => {
  const state = Object.assign({}, fleetMachInit, { enroll: { loading: false, error: '', data: { token: 'TOK-XYZ-123', expiresAt: NOW + 600000, expiresInMs: 900000 } } })
  const tree = withState('Machines', mkHub({ nodes: [] }), [state])
  assert.ok(surface(tree).includes('TOK-XYZ-123'))
  assert.equal(findAll(tree, (n) => n.type === 'button' && texts(n).join('') === '复制').length >= 1, true)
})

test('connection attempts: the remote is masked, the node id and LAN remotes are not', () => {
  const { f, core } = rig()
  const t = surface(expand(core.h(f.Overview, props(mkHub()))))
  assert.ok(t.includes('198.•••:51234'))
  assert.ok(t.includes('node-alpha-'))
  assert.ok(t.includes('192.168.1.20:5000'))
})

test('pair-info and enrollment failures: addresses inside the error text follow the switch', () => {
  const failing = (showPublic) => Object.assign({}, fleetMachInit, {
    showPublic,
    pair: { loading: false, data: null, note: '配对码读取失败：连不上 ' + PUB_IP + ':19387' },
    enroll: { loading: false, data: null, error: '铸造失败：中继 ' + PUB_URL + ' 不可达' },
  })
  const off = surface(withState('Machines', mkHub({ nodes: [] }), [failing(false)]))
  assert.deepEqual(SECRETS.filter((x) => off.includes(x)), [])
  assert.ok(off.includes('连不上 203.•••:19387') && off.includes('wss://relay.•••:8890'))
  const on = surface(withState('Machines', mkHub({ nodes: [] }), [failing(true)]))
  assert.ok(on.includes(PUB_IP + ':19387') && on.includes(PUB_URL))
})

/* ── 记住开关 ────────────────────────────────────────────────────── */

function withStorage(storage, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  try { return fn() } finally { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage }
}

test('persistence: the choice is read from and written to localStorage dra-show-public; a broken or missing storage never throws', () => {
  assert.equal(fleetPrefKey, 'dra-show-public')
  const mem = {}
  const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v } }
  withStorage(storage, () => {
    const a = rig()
    assert.equal(toggleOf(render(a, 'Machines', mkHub())).props.checked, false)
    toggleOf(render(a, 'Machines', mkHub())).props.onChange({ target: { checked: true } })
    assert.equal(mem['dra-show-public'], '1')
    const b = rig() // a fresh panel load picks the saved choice up
    assert.equal(toggleOf(render(b, 'Machines', mkHub())).props.checked, true)
    assert.match(surface(render(b, 'Overview', mkHub())), /公网地址：已显示/)
    toggleOf(render(b, 'Machines', mkHub())).props.onChange({ target: { checked: false } })
    assert.equal(mem['dra-show-public'], '0')
    assert.equal(toggleOf(render(rig(), 'Machines', mkHub())).props.checked, false)
  })
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  withStorage(broken, () => {
    const c = rig()
    assert.equal(toggleOf(render(c, 'Machines', mkHub())).props.checked, false)
    assert.doesNotThrow(() => toggleOf(render(c, 'Machines', mkHub())).props.onChange({ target: { checked: true } }))
    assert.equal(toggleOf(render(c, 'Machines', mkHub())).props.checked, true) // still works for this session
  })
  assert.equal(typeof globalThis.localStorage, 'undefined')
  assert.equal(toggleOf(render(rig(), 'Machines', mkHub())).props.checked, false)
})

test('default is hidden, so a hub with only public addresses shows no raw address before anyone touches the switch', () => {
  const r = rig()
  const hub = mkHub({ discovery: null, caps: null, connection: null })
  for (const name of ['Overview', 'Machines']) assert.deepEqual(leaked(render(r, name, hub)), [], name)
})
