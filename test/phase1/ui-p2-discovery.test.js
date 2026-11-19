import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../../lib/client.js'), 'utf8')

function loadView() {
  let plugin = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) {
          plugin = mod.factory(function (id) {
            if (id !== 'react') throw new Error('unexpected require ' + id)
            return {
              createElement(type, props, ...children) {
                const attrs = { ...props, children }
                delete attrs.key
                return typeof type === 'function' ? type(attrs) : { type, props: attrs, children }
              },
              useState(v) { return [v, function () {}] },
              useEffect() {},
              useRef(v) { return { current: v } },
              useMemo(fn) { return fn() },
            }
          })
        },
      },
    },
    console,
  }
  vm.runInNewContext(src, sandbox, { filename: 'lib/client.js' })
  assert.equal(typeof plugin.discoveryRows, 'function')
  return plugin
}

// vm 沙箱数组原型不同，先经 JSON 归一再比较
const eq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b)
const peer = (o) => ({ node: 'n', hostname: 'x', role: 'worker', port: 1, pluginVersion: '1', at: 1, ...o })

test('1. disabled discovery yields no rows', () => {
  const r = loadView().discoveryRows({ enabled: false, peers: [peer({})] }, [])
  assert.equal(r.enabled, false)
  assert.equal(r.rows.length, 0)
})

test('2. LAN addresses kept, public/domain hidden, order preserved', () => {
  const hosts = ['10.0.0.7', '192.168.1.20', 'nas.local', 'build01', '203.0.113.9', 'evil.example.com']
  const r = loadView().discoveryRows({ enabled: true, peers: hosts.map((h, i) => peer({ node: 'p' + i, hostname: h })) }, [])
  eq(r.rows.map((x) => x.node), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'])
  eq(r.rows.map((x) => x.addressLabel),
    ['10.0.0.7', '192.168.1.20', 'nas.local', 'build01', '地址已隐藏', '地址已隐藏'])
  eq(Object.keys(r.rows[0]).sort(), ['addressLabel', 'node', 'port', 'role'])
})

test('2b. range edges and IPv6', () => {
  const hosts = ['172.16.0.1', '172.31.9.9', '172.32.0.1', '127.0.0.1', '169.254.1.1', '8.8.8.8', '::1', 'fe80::1', '192.169.0.1']
  const r = loadView().discoveryRows({ enabled: true, peers: hosts.map((h, i) => peer({ node: 'q' + i, hostname: h })) }, [])
  eq(r.rows.map((x) => x.addressLabel),
    ['172.16.0.1', '172.31.9.9', '地址已隐藏', '127.0.0.1', '169.254.1.1', '地址已隐藏', '地址已隐藏', '地址已隐藏', '地址已隐藏'])
})

test('3. paired peers are excluded', () => {
  const v = loadView()
  const a = v.discoveryRows({ enabled: true, peers: [peer({ node: 'node009' })] }, [{ nodeId: 'node009' }])
  assert.equal(a.rows.length, 0)
  const b = v.discoveryRows({ enabled: true, peers: [peer({ node: 'other', hostname: '10.0.0.9' })] }, [{ nodeId: '10.0.0.9' }])
  assert.equal(b.rows.length, 0)
  const c = v.discoveryRows({ enabled: true, peers: [peer({ node: 'other', hostname: 'box' })] }, [{ nodeId: 'z', name: 'box' }])
  assert.equal(c.rows.length, 0)
  const d = v.discoveryRows({ enabled: true, peers: [peer({ node: 'other', hostname: 'box' })] }, [{ nodeId: 'z', host: 'box' }])
  assert.equal(d.rows.length, 0)
  const e = v.discoveryRows({ enabled: true, peers: [peer({ node: 'other', hostname: 'box2' })] }, [{ nodeId: 'z', name: 'box' }])
  assert.equal(e.rows.length, 1)
})

test('4. missing hostname is reported as not reported', () => {
  const v = loadView()
  const r = v.discoveryRows({ enabled: true, peers: [peer({ hostname: undefined }), peer({ node: 'm', hostname: '' })] }, [])
  eq(r.rows.map((x) => x.addressLabel), ['地址未上报', '地址未上报'])
})

test('5. rendered discovery card has a switch and scan, with no peer actions or names', () => {
  const { DiscoveryCard } = loadView()
  const onToggle = (...args) => calls.push(['toggle', ...args])
  const onScan = (...args) => calls.push(['scan', ...args])
  const calls = []
  const elements = (tree) => Array.isArray(tree) ? tree.flatMap(elements)
    : tree && typeof tree === 'object' ? [tree, ...elements(tree.children)] : []
  const props = { nodes: [], onToggle, onScan }
  const off = DiscoveryCard({ ...props, discovery: { enabled: false, peers: [] } })
  const [onSwitch, offScan] = elements(off).filter((e) => e.type === 'button')
  eq(onSwitch.children, ['开启'])
  assert.equal(onSwitch.props.role, 'switch')
  assert.equal(onSwitch.props['aria-checked'], false)
  eq(offScan.children, ['扫描'])
  assert.equal(offScan.props.disabled, true)
  onSwitch.props.onClick()

  const on = DiscoveryCard({ ...props, discovery: { enabled: true, peers: [peer({
    node: 'private-name', hostname: '10.0.0.10', role: 'node', port: 19387,
  })] } })
  const [offSwitch, scan, extra] = elements(on).filter((e) => e.type === 'button' || e.type === 'a')
  assert.equal(extra, undefined)
  eq(offSwitch.children, ['关闭'])
  assert.equal(offSwitch.props['aria-checked'], true)
  eq(scan.children, ['扫描'])
  assert.equal(scan.props.disabled, false)
  offSwitch.props.onClick()
  scan.props.onClick()
  assert.deepEqual(calls, [['toggle', true], ['toggle', false], ['scan']])
  const rendered = JSON.stringify(on)
  assert.match(rendered, /局域网发现/)
  assert.match(rendered, /10\.0\.0\.10/)
  assert.match(rendered, /node · 19387/)
  assert.doesNotMatch(rendered, /private-name|connect|连接/)
  assert.match(src, /h\(DiscoveryCard, \{\s+discovery: state\.discovery/)
})
