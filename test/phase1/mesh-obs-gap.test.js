import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { registerAdvancedTools } from '../../lib/hub/advanced-tools.js'
import { NodeRegistry } from '../../lib/hub/node-registry.js'
import { PullManager } from '../../lib/hub/pull-manager.js'
import * as standalone from '../../lib/hub/ui-routes.js'
import * as pluginRoutes from '../../lib/plugin/http/routes.js'
import { collectConnectivity } from '../../lib/node/connectivity.js'

const readRepo = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

function makeRegistry(t) {
  const registry = new NodeRegistry()
  t.after(() => registry.dispose())
  return registry
}

function addNode(registry, nodeId, hello = {}) {
  registry.nodes.set(nodeId, { nodeId, hello, online: true, transportMode: 'direct', tasks: new Map(), pendingPulls: new Map() })
}

test('OBS-13 counts only successful outbound writes', async (t) => {
  const registry = makeRegistry(t)
  addNode(registry, 'worker')
  const row = () => registry.list().find(({ nodeId }) => nodeId === 'worker')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-obs-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const localPath = path.join(dir, 'source')
  fs.writeFileSync(localPath, '12345678')
  let remoteFile
  let writeAttempts = 0
  let failWrite = true
  registry.fsRequest = async (_nodeId, op, params) => {
    if (op === 'fileBegin') return { transferId: 'send-fixture', expectedOffset: 2 }
    if (op === 'fileWrite') {
      writeAttempts++
      if (failWrite) throw new Error('write rejected')
      if (params.offset === 2) throw Object.assign(new Error('offset conflict'), { code: 'offset-conflict', expectedOffset: 4 })
      assert.equal(params.offset, 4)
      assert.equal(Buffer.from(params.base64, 'base64').length, 4)
    }
    return {}
  }
  registerAdvancedTools({ registry, stateDir: dir, ctx: { tools: { register(definition) {
    if (definition.name === 'remote_file') remoteFile = definition
  } } } })
  const send = () => remoteFile.execute({ action: 'send', node: 'worker', path: '/fixture', localPath, confirm: 'yes' })
  await assert.rejects(send(), /write rejected/)
  assert.equal(Object.hasOwn(row(), 'transferBytesOut'), false)
  failWrite = false
  await send()
  assert.equal(writeAttempts, 3)
  assert.equal(row().transferBytesOut, 4)
  assert.equal(Object.hasOwn(row(), 'transferBytesIn'), false)
})

test('OBS-13 counts only accepted inbound chunks', async (t) => {
  const registry = makeRegistry(t)
  addNode(registry, 'worker')
  addNode(registry, 'idle')
  const row = () => registry.list().find(({ nodeId }) => nodeId === 'worker')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-obs-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  registry.send = () => true
  const pulls = new PullManager({ registry })
  t.after(() => pulls.dispose())
  const pull = pulls.pull({ nodeId: 'worker', taskId: 'task', relPath: 'artifact', dest: dir })
  const rejected = assert.rejects(pull, /out of order/)
  const [pullId] = pulls.sessions.keys()
  assert.ok(pullId)
  pulls.ingestBinary({ pullId, offset: 0 }, Buffer.from('abc'))
  pulls.ingestBinary({ pullId, offset: 3 }, Buffer.from('de'))
  pulls.ingestBinary({ pullId, offset: 3 }, Buffer.from('de'))
  await rejected
  assert.equal(row().transferBytesIn, 5)
  const idle = registry.list().find(({ nodeId }) => nodeId === 'idle')
  assert.equal(Object.hasOwn(idle, 'transferBytesIn'), false)
  assert.equal(Object.hasOwn(idle, 'transferBytesOut'), false)
})

test('OBS-14 keeps the source and runtime collectors byte-identical', () => {
  const source = fs.readFileSync(new URL('../../src/roster/connectivity.js', import.meta.url))
  const runtime = fs.readFileSync(new URL('../../lib/node/connectivity.js', import.meta.url))
  assert.equal(source.equals(runtime), true)
})

test('OBS-14 shares in-flight probes and reuses a fresh sample', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 })
  let reads = 0
  let connects = 0
  const options = {
    config: { probeHosts: ['127.0.0.1:12345'] },
    readdir: async () => { reads++; return [] },
    net: { connect() {
      connects++
      const socket = new EventEmitter()
      socket.destroy = () => {}
      queueMicrotask(() => socket.emit('connect'))
      return socket
    } },
  }
  const [first, concurrent] = await Promise.all([collectConnectivity(options), collectConnectivity({ ...options })])
  assert.deepEqual([reads, connects], [1, 1])
  assert.deepEqual(concurrent, first)
  assert.equal(first.sampledAt, 10_000)
  assert.deepEqual(await collectConnectivity(options), first)
  assert.deepEqual([reads, connects], [1, 1])
  t.mock.timers.tick(60_000)
  const refreshed = await collectConnectivity(options)
  assert.equal(refreshed.sampledAt, 70_000)
  assert.deepEqual([reads, connects], [2, 2])
  await collectConnectivity({ ...options, config: { probeHosts: ['127.0.0.1:23456'] } })
  assert.deepEqual([reads, connects], [3, 3])
})

function loadClient(react, globals = {}) {
  let client
  const source = readRepo('lib/client.js').replace('nodeCardView: nodeCardView,', 'NodeCard: NodeCard, nodeCardView: nodeCardView,')
  vm.runInNewContext(source, {
    ...globals,
    window: { __ModuleLoader__: { load(mod) { client = mod.factory(() => react) } } },
  }, { filename: 'lib/client.js' })
  return client
}

test('OBS-16 ticks sample age locally and clears the display timer', () => {
  let now = 10_000
  let displayNow
  let mounted = false
  let timer
  let cleanup
  const react = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...props, children })
      return children.flat(Infinity).join(' ')
    },
    useState(initial) {
      displayNow ??= initial()
      return [displayNow, value => { displayNow = value; rendered = render() }]
    },
    useEffect(effect) {
      if (mounted) return
      mounted = true
      cleanup = effect()
    },
  }
  const client = loadClient(react, {
    Date: { now: () => now },
    fetch: () => assert.fail('display timer fetched network data'),
    setInterval(fn, ms) { assert.equal(ms, 1000); timer = fn; return 7 },
    clearInterval(id) { assert.equal(id, 7); timer = undefined },
  })
  const node = { nodeId: 'worker', connectivity: { sampledAt: 8_000 } }
  const render = () => client.NodeCard({ node })
  let rendered = render()
  assert.match(rendered, /2 秒前/)
  assert.equal(typeof timer, 'function')
  now += 1000
  timer()
  assert.match(rendered, /3 秒前/)
  cleanup()
  assert.equal(timer, undefined)
  assert.equal(node.connectivity.sampledAt, 8_000)
})

async function routeNodes(t, routesModule, registry, suffix) {
  const routes = new Map()
  const dispose = routesModule.registerUiRoutes({
    ctx: { webServer: { register(route) { routes.set(route.path, route); return () => {} } } },
    config: { role: 'hub' }, registry, pulls: {}, log() {},
  })
  t.after(() => { for (const d of dispose) d() })
  const url = routesModule.UI_API_PREFIX + suffix
  let body
  await routes.get(url).handler({ method: 'GET', url, headers: {} }, {
    writeHead(status) { assert.equal(status, 200) },
    end(raw) { body = JSON.parse(raw) },
  })
  return body.nodes
}

test('OBS-19 projects addresses and chooses LAN independently for each node id', async (t) => {
  const registry = makeRegistry(t)
  addNode(registry, 'first', { hostname: 'public.example', peerUrl: 'wss://192.168.1.8:9000/ws' })
  addNode(registry, 'second', { hostname: '192.168.1.8', peerUrl: 'wss://other.example:9000/ws' })
  addNode(registry, 'third', { hostname: 'fallback.example', peerUrl: 'invalid-url' })
  addNode(registry, 'ipv6', { hostname: 'public.example', peerUrl: 'wss://[fd00::8]:9000/ws' })
  const client = loadClient({})
  for (const routesModule of [pluginRoutes, standalone]) {
    const nodes = await routeNodes(t, routesModule, registry, '/overview')
    assert.deepEqual(nodes.map(n => [n.nodeId, n.hostname, n.peerHost]), [
      ['first', 'public.example', '192.168.1.8'],
      ['second', '192.168.1.8', 'other.example'],
      ['third', 'fallback.example', undefined],
      ['ipv6', 'public.example', '[fd00::8]'],
    ])
    const layout = client.topologyLayout({ width: 900, height: 560, nodes })
    assert.deepEqual(Array.from(layout.nodes, n => [n.id, n.address]), [
      ['first', '192.168.1.8'], ['ipv6', '[fd00::8]'], ['second', '192.168.1.8'], ['third', 'fallback.example'],
    ])
  }
  const status = await routeNodes(t, pluginRoutes, registry, '/node-status')
  assert.ok(status.every(n => !Object.hasOwn(n, 'hostname') && !Object.hasOwn(n, 'peerHost')))
})
