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
              createElement() { return null },
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

test('5. source slice wiring', () => {
  assert.match(src, /next\.discovery = ov && ov\.discovery \? ov\.discovery : null/)
  assert.match(src, /topology: null, discovery: null/)
  for (const s of ['局域网发现', '局域网发现未开启', '未发现未配对的机器', '地址已隐藏']) assert.ok(src.includes(s), s)
  assert.equal(src.includes("apiGet('/discovery')"), false)
  assert.equal(src.includes('/discovery'), false)
  assert.equal(/fetch\([^)]*discovery/i.test(src), false)
})
