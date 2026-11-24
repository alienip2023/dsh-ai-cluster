// UI 重写 P1：面板新增的后端数据面——/bots 透传身份与版本、/bots/stop、/bots/locate、/link-status。
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { apply } from '../../lib/index.js'
import { PROTOCOL_VERSION } from '../../lib/protocol.js'

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
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
      registerUpgrade() { return () => {} },
    },
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    subagents: { registerProvider: () => () => {} },
  }
  return { ctx, routes, services }
}

async function call(routes, method, pathname, body) {
  const route = routes.get(pathname.split('?')[0])
  assert.ok(route, `missing route ${pathname}`)
  const out = {}
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  await route.handler(
    { method, url: pathname, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield* chunks } },
    { writeHead(s) { out.status = s }, setHeader() {}, end(p) { out.body = JSON.parse(p) } },
  )
  return out
}

function boot() {
  const f = makeCtx()
  const handles = apply(f.ctx, { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0 })
  const registry = f.services.get('ai-cluster:registry') ?? f.services.get('remote-agent:registry')
  return { ...f, handles, registry }
}

function hello(registry, nodeId, extra = {}) {
  registry.ingestHello({
    helloData: { nodeId, protocol: PROTOCOL_VERSION, os: 'linux', hostname: 'host-' + nodeId, nonce: '', time: Date.now(), ...extra },
    conn: { send() {}, close() {} }, transport: 'direct', pending: undefined,
  })
}
const roster = (registry, nodeId, bots) =>
  registry.handleFrameFor(nodeId, { t: 'roster/report', d: { nodeId, hostname: 'host-' + nodeId, bots } })

test('/bots carries identityId per Bot and acVersion per node, nothing else from the roster', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1', { acVersion: '0.4.36' })
  hello(b.registry, 'n2')
  roster(b.registry, 'n1', [{ id: 'b1', name: 'Alice', role: 'coder', model: 'm', identityId: '0123456789abcdef', secret: 'x' }])
  roster(b.registry, 'n2', [{ id: 'b2', name: 'Bob', role: 'qa', model: 'm' }])
  for (const prefix of [NEW, OLD]) {
    const r = await call(b.routes, 'GET', `${prefix}/bots`)
    const n1 = r.body.nodes.find((n) => n.nodeId === 'n1')
    const n2 = r.body.nodes.find((n) => n.nodeId === 'n2')
    assert.equal(n1.acVersion, '0.4.36')
    assert.deepEqual(n1.bots, [{ id: 'b1', name: 'Alice', role: 'coder', model: 'm', identityId: '0123456789abcdef' }])
    assert.equal('acVersion' in n2, false, 'an old node reports no version, so the field is absent')
    assert.equal('identityId' in n2.bots[0], false)
    assert.doesNotMatch(JSON.stringify(r.body), /secret/)
  }
})

test('/bots/stop: validates, refuses offline, and returns the node receipt', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  assert.equal((await call(b.routes, 'POST', `${NEW}/bots/stop`, { botId: 'b1' })).status, 400)
  assert.equal((await call(b.routes, 'POST', `${NEW}/bots/stop`, { nodeId: 'n1' })).body.error, 'bot-botId-invalid')
  assert.deepEqual((await call(b.routes, 'POST', `${NEW}/bots/stop`, { nodeId: 'ghost', botId: 'b1' })).body, { ok: false, error: 'node-offline' })

  hello(b.registry, 'n1')
  const sent = []
  b.registry.send = (nodeId, type, data) => { sent.push({ nodeId, type, data }); return true }
  const pending = call(b.routes, 'POST', `${NEW}/bots/stop`, { nodeId: 'n1', botId: 'b1' })
  await new Promise((r) => setImmediate(r))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'bot/stop')
  assert.equal(sent[0].data.remoteBotId, 'b1')
  b.registry.handleFrameFor('n1', { t: 'bot/stop-result', d: { requestId: sent[0].data.requestId, ok: true, stopped: true } })
  assert.deepEqual((await pending).body, { ok: true, stopped: true })
})

test('/bots/stop: a receipt from another node does not settle the request', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1'); hello(b.registry, 'n2')
  const sent = []
  b.registry.send = (nodeId, type, data) => { sent.push(data); return true }
  b.registry.botRpcTimeoutMs = 30
  const pending = call(b.routes, 'POST', `${NEW}/bots/stop`, { nodeId: 'n1', botId: 'b1' })
  await new Promise((r) => setImmediate(r))
  b.registry.handleFrameFor('n2', { t: 'bot/stop-result', d: { requestId: sent[0].requestId, ok: true, stopped: true } })
  assert.deepEqual((await pending).body, { ok: false, error: 'bot-stop-timeout' })
})

test('/bots/locate answers from registry.locateBot and flattens the verdict lists', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  assert.equal((await call(b.routes, 'GET', `${NEW}/bots/locate`)).status, 400)
  b.registry.locateBot = async (id) => ({ botId: id, locations: [{ nodeId: 'n1', machineId: 'm1' }], notHere: ['n2'], silent: ['n3'], unsupported: [], unsent: [], rejected: [{ nodeId: 'n4', reason: 'wrong-bot' }] })
  const r = await call(b.routes, 'GET', `${NEW}/bots/locate?identityId=0123456789abcdef`)
  assert.deepEqual(r.body, {
    ok: true, identityId: '0123456789abcdef', locations: [{ nodeId: 'n1', machineId: 'm1' }],
    notHere: ['n2'], silent: ['n3'], unsupported: [], unsent: [], rejected: [{ nodeId: 'n4', reason: 'wrong-bot' }],
  })
  b.registry.locateBot = async () => ({ error: 'bad-bot-id' })
  assert.deepEqual((await call(b.routes, 'GET', `${NEW}/bots/locate?identityId=x`)).body, { ok: false, error: 'bad-bot-id' })
})

test('/link-status groups the reliable queue per node and never leaks rid or payload', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const none = await call(b.routes, 'GET', `${NEW}/link-status`)
  assert.equal(none.body.ok, true)
  hello(b.registry, 'n1')
  const now = Date.now()
  b.registry.reliable = { pending: () => [
    { rid: 'r1', peer: 'n1', type: 'work/handoff', tries: 2, at: now - 5000 },
    { rid: 'r2', peer: 'n1', type: 'work/result', tries: 0, at: now - 1000 },
    { rid: 'r3', peer: 'n9', type: 'team/conv', tries: 1, at: now - 100 },
  ] }
  const r = await call(b.routes, 'GET', `${NEW}/link-status`)
  assert.equal(r.body.available, true)
  assert.equal(r.body.total, 3)
  const n1 = r.body.nodes.find((n) => n.nodeId === 'n1')
  assert.equal(n1.pending, 2)
  assert.equal(n1.maxTries, 2)
  assert.ok(n1.oldestMs >= 5000 && n1.oldestMs < 8000)
  assert.deepEqual(n1.types, { 'work/handoff': 1, 'work/result': 1 })
  assert.equal(n1.online, true)
  assert.equal(r.body.nodes.find((n) => n.nodeId === 'n9').online, false)
  assert.doesNotMatch(JSON.stringify(r.body), /"r1"|rid/)
})

test('/overview nodes carry acVersion when the node said it, and omit it otherwise', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1', { acVersion: '0.4.36' })
  hello(b.registry, 'n2')
  const r = await call(b.routes, 'GET', `${NEW}/overview`)
  assert.equal(r.body.nodes.find((n) => n.nodeId === 'n1').acVersion, '0.4.36')
  assert.equal('acVersion' in r.body.nodes.find((n) => n.nodeId === 'n2'), false)
})
