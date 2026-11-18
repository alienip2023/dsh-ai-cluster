// p3-s2：面板创建 / 编辑 Bot —— 路由与注册表用真实帧驱动（不 mock emit）。
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

function boot() {
  const f = makeCtx()
  const handles = apply(f.ctx, { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0 })
  const registry = f.services.get('ai-cluster:registry') ?? f.services.get('remote-agent:registry')
  return { ...f, handles, registry }
}

/** 接入一个节点，conn.send 把真实发出的帧收进 sent。 */
function hello(registry, nodeId) {
  const sent = []
  registry.ingestHello({
    helloData: { nodeId, protocol: PROTOCOL_VERSION, os: 'linux', hostname: 'host-' + nodeId, nonce: '', time: Date.now() },
    conn: { send(text) { sent.push(JSON.parse(text)) }, close() {} }, transport: 'direct', pending: undefined,
  })
  return sent
}

async function post(routes, pathname, body, method = 'POST') {
  const route = routes.get(pathname)
  assert.ok(route, `missing route ${pathname}`)
  const out = {}
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  await route.handler({ method, url: pathname, headers: {}, async *[Symbol.asyncIterator]() { yield* raw } },
    { writeHead(s) { out.status = s }, end(p) { out.body = JSON.parse(p) } })
  return out
}

const lastFrame = (sent, t) => [...sent].reverse().find((f) => f.t === t)
const tick = () => new Promise((r) => setImmediate(r))
// 节点回执：走真实 ingest 路径（handleFrameFor），不直接 emit。
const reply = (registry, nodeId, t, d) => registry.handleFrameFor(nodeId, { t, d })

test('create + update routes are registered under both prefixes', (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  for (const prefix of [NEW, OLD]) for (const p of ['/bots/create', '/bots/update']) {
    assert.ok(b.routes.get(prefix + p), prefix + p)
  }
})

test('create: frame carries requestId/nodeId/name; node reply resolves with remoteBotId; pending cleared', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const sent = hello(b.registry, 'n1')
  const p = post(b.routes, `${NEW}/bots/create`, { nodeId: 'n1', name: ' Alice ', role: 'coder', modelRef: 'p/m', instructions: 'SECRET-TEXT' })
  await tick()
  const frame = lastFrame(sent, 'bot/create')
  assert.ok(frame, 'bot/create actually sent')
  assert.equal(frame.d.nodeId, 'n1')
  assert.equal(frame.d.name, 'Alice')
  assert.equal(frame.d.role, 'coder')
  assert.equal(frame.d.modelRef, 'p/m')
  assert.match(frame.d.requestId, /^br-[0-9a-f]{24}$/)
  assert.equal(b.registry.botRpcPending.size, 1)
  reply(b.registry, 'n1', 'bot/create-result', { requestId: frame.d.requestId, ok: true, remoteBotId: 'rb-9', name: 'Alice', role: 'coder' })
  const r = await p
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, nodeId: 'n1', remoteBotId: 'rb-9' })
  assert.equal(b.registry.botRpcPending.size, 0)
})

test('create: node ok:false surfaces its error code', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const sent = hello(b.registry, 'n1')
  const p = post(b.routes, `${OLD}/bots/create`, { nodeId: 'n1', name: 'A' })
  await tick()
  reply(b.registry, 'n1', 'bot/create-result', { requestId: lastFrame(sent, 'bot/create').d.requestId, ok: false, error: 'bot-create-no-receiver' })
  const r = await p
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: false, error: 'bot-create-no-receiver' })
  assert.equal(b.registry.botRpcPending.size, 0)
})

test('create: timeout returns bot-create-timeout and clears the pending entry', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  b.registry.botRpcTimeoutMs = 30
  const r = await post(b.routes, `${NEW}/bots/create`, { nodeId: 'n1', name: 'A' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: false, error: 'bot-create-timeout' })
  assert.equal(b.registry.botRpcPending.size, 0)
})

test('create: offline or unknown node -> node-offline, nothing left pending', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  b.registry.markOffline('n1', 'test')
  for (const nodeId of ['n1', 'ghost']) {
    const r = await post(b.routes, `${NEW}/bots/create`, { nodeId, name: 'A' })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { ok: false, error: 'node-offline' })
  }
  assert.equal(b.registry.botRpcPending.size, 0)
})

test('node disconnect mid-request ends it with node-offline', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  const p = post(b.routes, `${NEW}/bots/create`, { nodeId: 'n1', name: 'A' })
  await tick()
  assert.equal(b.registry.botRpcPending.size, 1)
  b.registry.markOffline('n1', 'test')
  assert.deepEqual((await p).body, { ok: false, error: 'node-offline' })
  assert.equal(b.registry.botRpcPending.size, 0)
})

test('validation: missing name/nodeId -> 400, bad method -> 405, no frame sent', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const sent = hello(b.registry, 'n1')
  const before = sent.length
  let r = await post(b.routes, `${NEW}/bots/create`, { nodeId: 'n1' })
  assert.equal(r.status, 400); assert.equal(r.body.ok, false); assert.match(r.body.error, /name/)
  r = await post(b.routes, `${NEW}/bots/create`, { name: 'A' })
  assert.equal(r.status, 400); assert.match(r.body.error, /nodeId/)
  r = await post(b.routes, `${NEW}/bots/update`, { nodeId: 'n1', name: 'A' })
  assert.equal(r.status, 400); assert.match(r.body.error, /remoteBotId/)
  r = await post(b.routes, `${NEW}/bots/update`, { nodeId: 'n1', botId: 'b1' })
  assert.equal(r.status, 400); assert.match(r.body.error, /all-null/)
  r = await post(b.routes, `${NEW}/bots/create`, undefined, 'GET')
  assert.equal(r.status, 405)
  assert.equal(sent.length, before)
})

test('update mirrors create: frame fields, success, node refusal, timeout', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const sent = hello(b.registry, 'n1')
  let p = post(b.routes, `${NEW}/bots/update`, { nodeId: 'n1', botId: 'b1', name: 'New', modelRef: 'p/m2', instructions: 'X' })
  await tick()
  const f = lastFrame(sent, 'bot/update')
  assert.ok(f)
  assert.equal(f.d.nodeId, 'n1'); assert.equal(f.d.remoteBotId, 'b1'); assert.equal(f.d.name, 'New'); assert.equal(f.d.model, 'p/m2')
  assert.match(f.d.requestId, /^br-/)
  reply(b.registry, 'n1', 'bot/update-result', { requestId: f.d.requestId, ok: true })
  assert.deepEqual((await p).body, { ok: true, nodeId: 'n1' })

  p = post(b.routes, `${OLD}/bots/update`, { nodeId: 'n1', botId: 'b1', role: 'r' })
  await tick()
  reply(b.registry, 'n1', 'bot/update-result', { requestId: lastFrame(sent, 'bot/update').d.requestId, ok: false, error: 'bot-update-not-found' })
  assert.deepEqual((await p).body, { ok: false, error: 'bot-update-not-found' })

  b.registry.botRpcTimeoutMs = 30
  const r = await post(b.routes, `${NEW}/bots/update`, { nodeId: 'n1', botId: 'b1', role: 'r' })
  assert.deepEqual(r.body, { ok: false, error: 'bot-update-timeout' })
  assert.equal(b.registry.botRpcPending.size, 0)
})

test('update: blank fields mean "no change" and are not sent as clears', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const sent = hello(b.registry, 'n1')
  b.registry.botRpcTimeoutMs = 20
  await post(b.routes, `${NEW}/bots/update`, { nodeId: 'n1', botId: 'b1', name: 'New', role: '', modelRef: '', workDir: '  ', instructions: '' })
  const f = lastFrame(sent, 'bot/update')
  assert.equal(f.d.name, 'New')
  for (const k of ['role', 'model', 'workDir', 'instructions']) assert.ok(f.d[k] === undefined || f.d[k] === null, k)
})

test('a reply for another node, another kind, or an unknown requestId settles nothing', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const sent = hello(b.registry, 'n1'); hello(b.registry, 'n2')
  const p = b.registry.createBot('n1', { name: 'A' })
  await tick()
  const id = lastFrame(sent, 'bot/create').d.requestId
  reply(b.registry, 'n2', 'bot/create-result', { requestId: id, ok: true, remoteBotId: 'evil' })
  reply(b.registry, 'n1', 'bot/update-result', { requestId: id, ok: true })
  reply(b.registry, 'n1', 'bot/create-result', { requestId: 'nope', ok: true, remoteBotId: 'x' })
  assert.equal(b.registry.botRpcPending.size, 1)
  reply(b.registry, 'n1', 'bot/create-result', { requestId: id, ok: true, remoteBotId: 'good' })
  assert.equal((await p).remoteBotId, 'good')
})

test('pending table is capped: over the cap is refused, not queued', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  b.registry.botRpcTimeoutMs = 5000
  const open = Array.from({ length: 32 }, () => b.registry.createBot('n1', { name: 'A' }))
  assert.equal(b.registry.botRpcPending.size, 32)
  assert.deepEqual(await b.registry.createBot('n1', { name: 'A' }), { ok: false, error: 'bot-create-busy' })
  assert.equal(b.registry.botRpcPending.size, 32)
  b.registry.markOffline('n1', 'test')
  await Promise.all(open)
  assert.equal(b.registry.botRpcPending.size, 0)
})

test('instructions text never reaches the log', async (t) => {
  const f = makeCtx()
  const lines = []
  f.ctx.logger = { info: (...a) => lines.push(a), warn: (...a) => lines.push(a), error: (...a) => lines.push(a), debug: (...a) => lines.push(a) }
  const handles = apply(f.ctx, { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0 })
  t.after(() => handles.dispose())
  const registry = f.services.get('ai-cluster:registry') ?? f.services.get('remote-agent:registry')
  hello(registry, 'n1'); registry.botRpcTimeoutMs = 20
  await post(f.routes, `${NEW}/bots/create`, { nodeId: 'n1', name: 'A', instructions: 'TOPSECRET-INSTR' })
  assert.doesNotMatch(JSON.stringify(lines), /TOPSECRET-INSTR/)
})

// ── 面板（源码 / 渲染级断言）──
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
const walk = (el, fn) => { if (el && typeof el === 'object') { fn(el); for (const k of el.kids || []) walk(k, fn) } }

test('client: form lists only online nodes; edit button prefills; failure text and values are kept', () => {
  const P = loadClient()
  const av = P.screenAvailability({ ok: true, total: 1, nodes: [
    { nodeId: 'n1', hostname: 'H1', online: true, bots: [{ id: 'b1', name: 'Alice', role: 'coder', model: 'm' }] },
    { nodeId: 'n2', hostname: 'H2', online: false, bots: [] },
  ] }, 200)
  let edited = null
  const roster = P.rosterView(av, { onEdit: (n, b) => { edited = [n.nodeId, b.id] } })
  let editBtn = null
  walk(roster, (e) => { if (e.type === 'button' && e.kids.includes('编辑')) editBtn = e })
  assert.ok(editBtn, 'edit button on the bot row')
  editBtn.props.onClick(); assert.deepEqual(edited, ['n1', 'b1'])
  const form = P.botFormView({ form: { nodeId: '', botId: '', name: 'keep-me', role: '', modelRef: '', workDir: '', instructions: '' },
    nodes: av.nodes, busy: false, note: 'bot-create-no-receiver', noteOk: false, onChange() {}, onSubmit() {}, onCancel() {} })
  const opts = []; let nameVal = null; let warn = null
  walk(form, (e) => {
    if (e.type === 'option' && e.props.value) opts.push(e.props.value)
    if (e.type === 'input' && e.props.value === 'keep-me') nameVal = e.props.value
    if (e.props.className === 'dra-warn') warn = e.kids.join('')
  })
  assert.deepEqual(opts, ['n1'])
  assert.equal(nameVal, 'keep-me')
  assert.equal(warn, 'bot-create-no-receiver')
  assert.match(clientSrc, /apiPost\(editing \? '\/bots\/update' : '\/bots\/create'/)
  assert.match(clientSrc, /setPollTick\(function \(x\) \{ return x \+ 1 \}\)/, 'success triggers a /bots refresh')
})
