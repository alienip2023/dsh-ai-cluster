// p3-s1：机器人名册真的从 hub 收到的 roster/report 帧到达面板。
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../lib/index.js'
import { PROTOCOL_VERSION } from '../../lib/protocol.js'
import { createTeam, teamNodeRows, teamRosterProject } from '../../src/panel/team.js'
import { dataEmptyHub } from '../../src/panel/data.js'
import { makeCore, textOf } from '../panel/_fake.js'

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

/** 把 /bots 的真实回包交给新的团队屏（假 React，只渲染一次），返回屏幕上的全部文字。 */
function teamScreenText(body) {
  const r = teamRosterProject(body)
  const core = makeCore({ state: [r.kind === 'data' ? { state: 'ok', nodes: r.nodes, at: 1, error: '' } : { state: 'error', nodes: [], at: 0, error: r.reason }] })
  return textOf(core.h(createTeam(core).Screen, { hub: { ...dataEmptyHub, loading: false }, ui: {}, go() {}, refresh() {} }))
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
  const rows = teamNodeRows(teamRosterProject(bodies[0]).nodes, [])
  assert.deepEqual(rows.map((r) => [r.nodeId, r.hostname, r.online]), [['n1', 'host-n1', true]])
  assert.deepEqual(rows[0].bots.map((x) => [x.id, x.name, x.role, x.model]), [['b1', 'Alice', 'coder', 'm-1']])
  const shown = teamScreenText(bodies[0])
  for (const piece of ['Alice', '角色 coder', '模型 m-1', 'host-n1', '在线']) assert.ok(shown.includes(piece), piece)
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
  assert.equal(teamNodeRows(teamRosterProject(r).nodes, [])[0].online, false)
  const shown = teamScreenText(r)
  assert.match(shown, /离线/)
  assert.match(shown, /最后一次名册/)
  assert.match(shown, /Alice/, 'the offline node keeps its Bots on screen')
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
  assert.equal(teamRosterProject(empty).kind, 'data', 'an empty roster is data (zero machines), not an error')
  assert.deepEqual(teamRosterProject(empty).nodes, [])
  assert.match(teamScreenText(empty), /还没有机器上报 Bot/)
  b.registry.rosterList = () => { throw new Error('boom') }
  const bad = (await getJson(b.routes, `${NEW}/bots`)).body
  assert.equal(bad.ok, false)
  assert.equal(typeof bad.code, 'string')
  assert.notEqual(bad.code, 'not-available')
  assert.deepEqual(teamRosterProject(bad), { kind: 'error', reason: bad.code })
  assert.match(teamScreenText(bad), new RegExp('读不到名册[\\s\\S]*' + bad.code), 'the error is shown with its code, not as an empty list')
  assert.equal(teamRosterProject({ ok: false, error: 'HTTP 500', status: 500 }).kind, 'error')
})
