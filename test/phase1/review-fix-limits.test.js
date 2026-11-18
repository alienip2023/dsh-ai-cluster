// review-fix A / item 4: /bots/create and /bots/update reject over-limit input with 400 and a
// stable code, accept values exactly at the limit, and never truncate.
//
// Limits (all measured after trim):
//   name 40, role 24, modelRef 128, workDir 1024 — UTF-16 length
//   instructions 8000 UTF-8 bytes (chosen: matches the existing BOT_TURN_TEXT_MAX of 8000 and the
//     "8000 bytes, enforced once on the sending side" contract noted in protocol validateBotCreate)
//   nodeId / botId: non-empty, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ (so at most 128 chars)
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../lib/index.js'
import { PROTOCOL_VERSION } from '../../lib/protocol.js'

const NEW = '/api/ai-cluster/ui'

function boot() {
  const routes = new Map()
  const services = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    get() { return undefined },
    provide(name, value) { services.set(name, value); return () => {} },
    webServer: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path) }, registerUpgrade() { return () => {} } },
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    subagents: { registerProvider: () => () => {} },
  }
  const handles = apply(ctx, { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0 })
  const registry = services.get('ai-cluster:registry') ?? services.get('remote-agent:registry')
  return { routes, handles, registry }
}

function hello(registry, nodeId) {
  const sent = []
  registry.ingestHello({
    helloData: { nodeId, protocol: PROTOCOL_VERSION, os: 'linux', hostname: 'h-' + nodeId, nonce: '', time: Date.now() },
    conn: { send(text) { sent.push(JSON.parse(text)) }, close() {} }, transport: 'direct', pending: undefined,
  })
  return sent
}

async function post(routes, pathname, body) {
  const route = routes.get(pathname)
  assert.ok(route, `missing route ${pathname}`)
  const out = {}
  const raw = [Buffer.from(JSON.stringify(body))]
  await route.handler({ method: 'POST', url: pathname, headers: {}, async *[Symbol.asyncIterator]() { yield* raw } },
    { writeHead(s) { out.status = s }, end(p) { out.body = JSON.parse(p) } })
  return out
}

const lastFrame = (sent, t) => [...sent].reverse().find((f) => f.t === t)
const tick = () => new Promise((r) => setImmediate(r))

const FIELDS = [
  { field: 'name', max: 40, code: 'bot-name-too-long' },
  { field: 'role', max: 24, code: 'bot-role-too-long' },
  { field: 'modelRef', max: 128, code: 'bot-modelRef-too-long' },
  { field: 'workDir', max: 1024, code: 'bot-workDir-too-long' },
  { field: 'instructions', max: 8000, code: 'bot-instructions-too-long' },
]

for (const kind of ['create', 'update']) {
  const base = kind === 'create' ? { nodeId: 'n1', name: 'A' } : { nodeId: 'n1', botId: 'b1', name: 'A' }
  for (const { field, max, code } of FIELDS) {
    test(`${kind}: ${field} over ${max} -> 400 ${code}, no frame sent`, async (t) => {
      const b = boot(); t.after(() => b.handles.dispose())
      const sent = hello(b.registry, 'n1')
      const before = sent.length
      const r = await post(b.routes, `${NEW}/bots/${kind}`, { ...base, [field]: 'x'.repeat(max + 1) })
      assert.equal(r.status, 400)
      assert.deepEqual(r.body, { ok: false, error: code })
      assert.equal(sent.length, before)
    })

    test(`${kind}: ${field} at exactly ${max} is accepted and forwarded untruncated`, async (t) => {
      const b = boot(); t.after(() => b.handles.dispose())
      const sent = hello(b.registry, 'n1')
      b.registry.botRpcTimeoutMs = 20
      const value = 'x'.repeat(max)
      const p = post(b.routes, `${NEW}/bots/${kind}`, { ...base, [field]: value })
      await tick()
      const f = lastFrame(sent, `bot/${kind}`)
      assert.ok(f, 'frame sent: value at the limit is accepted')
      const key = field === 'modelRef' && kind === 'update' ? 'model' : field
      assert.equal(f.d[key], value, `${field} forwarded without truncation`)
      assert.equal(f.d[key].length, max)
      await p
    })
  }

  test(`${kind}: instructions limit counts UTF-8 bytes, not characters`, async (t) => {
    const b = boot(); t.after(() => b.handles.dispose())
    const sent = hello(b.registry, 'n1')
    const before = sent.length
    // 2667 CJK chars = 8001 bytes (3 bytes each) but only 2667 UTF-16 units.
    const r = await post(b.routes, `${NEW}/bots/${kind}`, { ...base, instructions: '中'.repeat(2667) })
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'bot-instructions-too-long')
    assert.equal(sent.length, before)
  })

  test(`${kind}: nodeId and botId are bounded and charset-restricted`, async (t) => {
    const b = boot(); t.after(() => b.handles.dispose())
    const sent = hello(b.registry, 'n1')
    const before = sent.length
    for (const nodeId of ['a'.repeat(129), 'bad id', 'x/../y', '-lead', 'né']) {
      const r = await post(b.routes, `${NEW}/bots/${kind}`, { ...base, nodeId })
      assert.equal(r.status, 400, nodeId)
      assert.deepEqual(r.body, { ok: false, error: 'bot-nodeId-invalid' })
    }
    const missing = await post(b.routes, `${NEW}/bots/${kind}`, { ...base, nodeId: '  ' })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error, 'bot-nodeId-missing')
    if (kind === 'update') {
      for (const botId of ['b'.repeat(129), 'has space', '../b']) {
        const r = await post(b.routes, `${NEW}/bots/update`, { ...base, botId })
        assert.equal(r.status, 400, botId)
        assert.deepEqual(r.body, { ok: false, error: 'bot-botId-invalid' })
      }
    }
    assert.equal(sent.length, before)
  })
}

test('nodeId / botId at exactly 128 chars pass the limit check (then get node-offline, not 400)', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const id = 'a'.repeat(128)
  const r = await post(b.routes, `${NEW}/bots/update`, { nodeId: id, botId: 'b'.repeat(128), name: 'A' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: false, error: 'node-offline' })
})
