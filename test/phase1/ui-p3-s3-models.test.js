// p3-s3：模型屏显示节点真实上报的模型（node/resource 帧里的 models / defaultModel）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../../lib/index.js'
import { PROTOCOL_VERSION } from '../../lib/protocol.js'
import { createTeam, teamModelsProject } from '../../src/panel/team.js'
import { dataEmptyHub } from '../../src/panel/data.js'
import { makeCore, textOf } from '../panel/_fake.js'

const NEW = '/api/ai-cluster/ui'
const OLD = '/api/remote-agent/ui'

function makeCtx() {
  const routes = new Map()
  const services = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    get() { return undefined },
    provide(name, value) { services.set(name, value); return () => { if (services.get(name) === value) services.delete(name) } },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error('duplicate ' + route.path)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      registerUpgrade() { return () => {} },
    },
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    subagents: { registerProvider: () => () => {} },
  }
  return { ctx, routes, services }
}

async function call(routes, pathname, method = 'GET') {
  const route = routes.get(pathname)
  assert.ok(route, `missing route ${pathname}`)
  const out = {}
  await route.handler({ method, url: pathname, headers: {}, async *[Symbol.asyncIterator]() {} },
    { writeHead(s) { out.status = s }, end(p) { out.body = JSON.parse(p) } })
  return out
}

function boot() {
  const f = makeCtx()
  // 空的临时 stateDir：registry 构造时会从 stateDir 读 node-jobs.json，不隔离就会混入宿主机上的旧节点。
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3s3-'))
  const handles = apply(f.ctx, { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0, stateDir })
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
// 模型清单随 node/resource 帧过界（registry-ingest 的 RESOURCE 分支）。
const resource = (registry, nodeId, extra) =>
  registry.handleFrameFor(nodeId, { t: 'node/resource', d: { cpuPct: 1, ...extra } })

/** 把 /models 的真实回包交给新的团队屏（假 React，只渲染一次），返回屏幕上的全部文字。 */
function teamModelsText(body) {
  const r = teamModelsProject(body)
  const models = r.kind === 'error' ? { state: 'error', nodes: [], error: r.reason } : { state: 'ok', nodes: r.nodes, error: '' }
  const core = makeCore({ state: [{ state: 'ok', nodes: [], at: 1, error: '' }, models] })
  return textOf(core.h(createTeam(core).Screen, { hub: { ...dataEmptyHub, loading: false }, ui: {}, go() {}, refresh() {} }))
}

const MODELS = {
  models: [
    { id: 'm-1', name: 'Model One', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], secret: 'x' },
    { id: 'm-2' },
  ],
}

test('real frames in -> /models on both prefixes: shape, null row, empty array, total', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1'); hello(b.registry, 'n2'); hello(b.registry, 'n3')
  resource(b.registry, 'n1', { models: MODELS, defaultModel: { provider: 'p', model: 'm-1' } })
  resource(b.registry, 'n2', { models: { models: [] } })
  // n3 never reported models -> null
  const bodies = []
  for (const prefix of [NEW, OLD]) {
    const r = await call(b.routes, `${prefix}/models`)
    assert.equal(r.status, 200)
    bodies.push(r.body)
  }
  assert.deepEqual(bodies[0].nodes, bodies[1].nodes)
  const body = bodies[0]
  assert.equal(body.ok, true)
  assert.equal(typeof body.at, 'number')
  assert.equal(body.total, 2)
  assert.deepEqual(body.nodes.map((n) => n.nodeId).sort(), ['n1', 'n2', 'n3'])
  const by = Object.fromEntries(body.nodes.map((n) => [n.nodeId, n]))
  assert.equal(by.n1.hostname, 'host-n1')
  assert.equal(by.n1.online, true)
  assert.equal(by.n1.defaultModel, 'm-1')
  assert.deepEqual(by.n1.models, [
    { id: 'm-1', name: 'Model One', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    { id: 'm-2', name: 'm-2', efforts: [] },
  ])
  assert.deepEqual(by.n2.models, [])
  assert.equal(by.n3.models, null, 'never-probed node still appears with models:null')
  assert.equal(by.n3.defaultModel, null)
  assert.doesNotMatch(JSON.stringify(body), /secret|ack-store-not-built/)
})

test('POST is 405 on both prefixes', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  for (const prefix of [NEW, OLD]) {
    const r = await call(b.routes, `${prefix}/models`, 'POST')
    assert.equal(r.status, 405)
    assert.deepEqual(r.body, { error: 'method' })
  }
})

test('models:null in a later frame keeps the old list; offline node flips online:false', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  resource(b.registry, 'n1', { models: MODELS })
  resource(b.registry, 'n1', { models: null })
  b.registry.markOffline('n1', 'test')
  const r = (await call(b.routes, `${NEW}/models`)).body
  assert.equal(r.nodes[0].online, false)
  assert.equal(r.total, 2)
})

test('missing store is not-available, not an empty list', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  b.registry.modelList = () => { throw new Error('boom') }
  const r = (await call(b.routes, `${NEW}/models`)).body
  assert.equal(r.ok, false)
  assert.equal(r.code, 'not-available')
})

test('client: grouped rows, 默认 marker, efforts line, null / empty / global-empty / error states', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1'); hello(b.registry, 'n2'); hello(b.registry, 'n3')
  resource(b.registry, 'n1', { models: MODELS, defaultModel: { provider: 'p', model: 'm-1' } })
  resource(b.registry, 'n2', { models: { models: [] } })
  const body = (await call(b.routes, `${NEW}/models`)).body
  const shown = teamModelsText(body)
  for (const piece of ['host-n1', '在线', 'Model One (m-1)', '默认', '思考等级：low / high', '没有可用模型', '尚未上报模型']) assert.ok(shown.includes(piece), piece)
  assert.doesNotMatch(shown, /所有机器都没有可用模型/)

  const allNone = { ok: true, total: 0, nodes: [{ nodeId: 'a', hostname: 'a', online: true, defaultModel: null, models: [] }, { nodeId: 'b', hostname: 'b', online: true, defaultModel: null, models: null }] }
  const none = teamModelsText(allNone)
  assert.match(none, /所有机器都没有可用模型/)
  assert.match(none, /尚未上报模型/)
  assert.match(teamModelsText({ ok: true, total: 0, nodes: [] }), /还没有机器上报模型/)
  const err = teamModelsProject({ ok: false, code: 'not-available' })
  assert.equal(err.kind, 'error')
  assert.match(teamModelsText({ ok: false, code: 'not-available' }), /读模型列表失败：not-available/)
  assert.equal(teamModelsProject({ ok: false, error: 'HTTP 500', status: 500 }).kind, 'error')
  assert.equal(teamModelsProject(null).kind, 'error')
})
