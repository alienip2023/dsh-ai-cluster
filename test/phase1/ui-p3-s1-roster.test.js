// p3-s1：机器人名册真的从 hub 收到的 roster/report 帧到达面板。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { apply } from '../../lib/index.js'
import { PROTOCOL_VERSION } from '../../lib/protocol.js'

const NEW = '/api/ai-cluster/ui'
const OLD = '/api/remote-agent/ui'

function makeCtx() {
  const routes = new Map()
  const services = new Map()
  const dupes = []
  const provided = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    get() { return undefined }, // 与 plugin-ui-registration 一致：热激活时不复用旧服务
    provide(name, value) { services.set(name, value); provided.push([name, value]); return () => { if (services.get(name) === value) services.delete(name) } },
    webServer: {
      register(route) {
        if (routes.has(route.path)) { dupes.push(route.path); throw new Error('duplicate ' + route.path) }
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      registerUpgrade() { return () => {} },
    },
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    subagents: { registerProvider: () => () => {} },
  }
  return { ctx, routes, services, dupes, provided }
}

async function getJson(routes, pathname) {
  const route = routes.get(pathname)
  assert.ok(route, `missing route ${pathname}`)
  const out = {}
  await route.handler({ method: 'GET', url: pathname, headers: {}, async *[Symbol.asyncIterator]() {} },
    { writeHead(s) { out.status = s }, end(p) { out.body = JSON.parse(p) } })
  return out
}

function boot() {
  const f = makeCtx()
  const handles = apply(f.ctx, { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0 })
  const registry = f.services.get('ai-cluster:registry') ?? f.services.get('remote-agent:registry')
  assert.ok(registry, 'registry is exposed')
  return { ...f, handles, registry }
}

function hello(registry, nodeId) {
  registry.ingestHello({
    helloData: { nodeId, protocol: PROTOCOL_VERSION, os: 'linux', hostname: 'host-' + nodeId, nonce: '', time: Date.now() },
    conn: { send() {}, close() {} }, transport: 'direct', pending: undefined,
  })
}
const roster = (registry, nodeId, bots, extra = {}) =>
  registry.handleFrameFor(nodeId, { t: 'roster/report', d: { nodeId, hostname: 'host-' + nodeId, bots, ...extra } })

const clientSrc = fs.readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
function loadClient() {
  let plugin = null
  vm.runInNewContext(clientSrc, {
    console,
    window: { __ModuleLoader__: { load(m) {
      plugin = m.factory(() => ({
        createElement(type, props, ...kids) { return { type, props: props || {}, kids: kids.flat(Infinity) } },
        useState(v) { return [v, () => {}] }, useEffect() {}, useRef(v) { return { current: v } }, useMemo(fn) { return fn() },
      }))
    } } },
  })
  return plugin
}
const texts = (el, out = []) => {
  if (typeof el === 'string') out.push(el)
  else if (el && typeof el === 'object') for (const k of el.kids || []) texts(k, out)
  return out
}

test('one apply: roster frame in -> /bots on both prefixes -> client renders the bot name', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  roster(b.registry, 'n1', [{ id: 'b1', name: 'Alice', role: 'coder', model: 'm-1', secret: 'x' }])
  const bodies = []
  for (const prefix of [NEW, OLD]) {
    const r = await getJson(b.routes, `${prefix}/bots`)
    assert.equal(r.status, 200)
    bodies.push(r.body)
  }
  for (const body of bodies) {
    assert.equal(body.ok, true)
    assert.equal(body.total, 1)
    assert.equal(body.nodes.length, 1)
    assert.deepEqual(body.nodes[0].bots, [{ id: 'b1', name: 'Alice', role: 'coder', model: 'm-1' }])
    assert.equal(body.nodes[0].online, true)
    assert.equal(body.nodes[0].hostname, 'host-n1')
  }
  assert.doesNotMatch(JSON.stringify(bodies[0]), /roster-store-not-built|secret/)
  const P = loadClient()
  const av = P.screenAvailability(bodies[0], 200)
  assert.equal(av.kind, 'data')
  const shown = texts(P.rosterView(av)).join('|')
  assert.match(shown, /Alice · coder · m-1/)
  assert.match(shown, /host-n1 · 在线/)
})

test('second apply on the same host stays duplicate-free and does not double the roster', async (t) => {
  const f = makeCtx()
  const cfg = { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0 }
  const h1 = apply(f.ctx, cfg)
  const first = new Set(f.provided.filter(([n]) => /:registry$/.test(n)).map(([, v]) => v))
  assert.equal(first.size, 1, 'exactly one registry instance per apply')
  const h2 = apply(f.ctx, cfg)
  t.after(() => { h2.dispose(); h1.dispose() })
  assert.deepEqual(f.dupes, [])
  const registry = f.services.get('ai-cluster:registry') ?? f.services.get('remote-agent:registry')
  hello(registry, 'n1')
  roster(registry, 'n1', [{ id: 'b1', name: 'Alice', role: 'coder' }])
  roster(registry, 'n1', [{ id: 'b1', name: 'Alice', role: 'coder' }])
  const r = await getJson(f.routes, `${NEW}/bots`)
  assert.equal(r.body.total, 1)
  assert.equal(r.body.nodes.length, 1)
})

test('offline node keeps its bots and flips online:false; unknown nodes never appear', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  roster(b.registry, 'n1', [{ id: 'b1', name: 'Alice', role: 'coder' }])
  roster(b.registry, 'ghost', [{ id: 'g1', name: 'Ghost', role: 'x' }])
  b.registry.markOffline('n1', 'test')
  const r = (await getJson(b.routes, `${NEW}/bots`)).body
  assert.equal(r.ok, true)
  assert.deepEqual(r.nodes.map((n) => n.nodeId), ['n1'])
  assert.equal(r.nodes[0].online, false)
  assert.equal(r.total, 1)
  assert.equal(r.nodes[0].bots[0].name, 'Alice')
  const shown = texts(loadClient().rosterView(loadClient().screenAvailability(r, 200))).join('|')
  assert.match(shown, /离线/)
})

test('mismatched nodeId in the frame is dropped', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1'); hello(b.registry, 'n2')
  b.registry.handleFrameFor('n2', { t: 'roster/report', d: { nodeId: 'n1', bots: [{ id: 'x', name: 'Fake', role: 'r' }] } })
  assert.equal((await getJson(b.routes, `${NEW}/bots`)).body.total, 0)
})

test('empty store is ok:true,total:0; unreachable store is ok:false with a code; client keeps them apart', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  const empty = (await getJson(b.routes, `${NEW}/bots`)).body
  assert.deepEqual({ ok: empty.ok, total: empty.total, nodes: empty.nodes }, { ok: true, total: 0, nodes: [] })
  const P = loadClient()
  assert.equal(P.screenAvailability(empty, 200).kind, 'empty')
  b.registry.rosterList = () => { throw new Error('boom') }
  const bad = (await getJson(b.routes, `${NEW}/bots`)).body
  assert.equal(bad.ok, false)
  assert.equal(typeof bad.code, 'string')
  assert.notEqual(bad.code, 'not-available')
  assert.equal(P.screenAvailability(bad, 200).kind, 'error')
  assert.equal(P.screenAvailability(bad, 500).kind, 'error')
})

test('source (p3-s1a): bots fetch is not once-only and its effect depends on the poll tick', () => {
  const clientSrc = fs.readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  const start = clientSrc.indexOf('React.useEffect(function () {\n        function store(')
  assert.ok(start >= 0, 'screen fetch effect must exist')
  const end = clientSrc.indexOf('\n      }, [', start)
  const slice = clientSrc.slice(start, end)
  const deps = clientSrc.slice(end, clientSrc.indexOf(')', end + 8) + 1)
  const botsBranch = slice.slice(slice.indexOf("activeScreen === 'bots'"), slice.indexOf("activeScreen === 'memory'"))
  assert.match(botsBranch, /apiGet\('\/bots'\)/)
  assert.doesNotMatch(botsBranch, /screenFetched/)
  assert.doesNotMatch(clientSrc, /screenFetched\s*=\s*React\.useRef\(\{\s*bots/)
  assert.match(deps, /\bpollTick\b/)
  assert.match(deps, /\btick\b/)
  // the existing poll interval drives pollTick; no second setInterval
  assert.match(clientSrc, /load\(\)\n\s*setPollTick\(/)
  // memory stays once-only; models went to the poll loop in p3-s3
  assert.match(slice, /screenFetched\.current\.memory\s*=\s*true/)
  assert.doesNotMatch(slice, /screenFetched\.current\.models/)
})
