// p3-s4：Bot 对话 —— 历史 RPC 与回合作业环用真实帧驱动（经 handleFrameFor，不 mock emit）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { apply } from '../../lib/index.js'
import { PROTOCOL_VERSION } from '../../lib/protocol.js'

const NEW = '/api/ai-cluster/ui'
const OLD = '/api/remote-agent/ui'

function boot() {
  const routes = new Map(); const services = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} }, get() { return undefined },
    provide(name, value) { services.set(name, value); return () => {} },
    webServer: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path) }, registerUpgrade() { return () => {} } },
    tools: { register() { return () => {} } }, systemPrompt: { section() { return () => {} } },
    subagents: { registerProvider: () => () => {} },
  }
  const handles = apply(ctx, { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0 })
  const registry = services.get('ai-cluster:registry') ?? services.get('remote-agent:registry')
  return { routes, handles, registry }
}
function hello(registry, nodeId) {
  const sent = []
  registry.ingestHello({
    helloData: { nodeId, protocol: PROTOCOL_VERSION, os: 'linux', hostname: 'host-' + nodeId, nonce: '', time: Date.now() },
    conn: { send(text) { sent.push(JSON.parse(text)) }, close() {} }, transport: 'direct', pending: undefined,
  })
  return sent
}
async function call(routes, pathname, { method = 'GET', body } = {}) {
  const route = routes.get(pathname.split('?')[0])
  assert.ok(route, `missing route ${pathname}`)
  const out = {}
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  await route.handler({ method, url: pathname, headers: {}, async *[Symbol.asyncIterator]() { yield* raw } },
    { writeHead(s) { out.status = s }, end(p) { out.body = JSON.parse(p) } })
  return out
}
const lastFrame = (sent, t) => [...sent].reverse().find((f) => f.t === t)
const tick = () => new Promise((r) => setImmediate(r))
const reply = (registry, nodeId, t, d) => registry.handleFrameFor(nodeId, { t, d })

test('routes registered under both prefixes', (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  for (const prefix of [NEW, OLD]) for (const p of ['/bots/history', '/bots/turn']) assert.ok(b.routes.get(prefix + p), prefix + p)
})

test('history: frame carries requestId/remoteBotId; node reply returns items; pending cleared', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const sent = hello(b.registry, 'n1')
  const p = call(b.routes, `${NEW}/bots/history?nodeId=n1&botId=b1`)
  await tick()
  const f = lastFrame(sent, 'bot/history')
  assert.ok(f, 'bot/history actually sent')
  assert.equal(f.d.remoteBotId, 'b1')
  assert.equal(b.registry.botRpcPending.size, 1)
  reply(b.registry, 'n1', 'bot/history-result', { requestId: f.d.requestId, ok: true, sessionId: 's1', items: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }], cursor: null })
  const r = await p
  assert.equal(r.body.ok, true)
  assert.equal(r.body.sessionId, 's1')
  assert.equal(r.body.items.length, 2)
  assert.equal(b.registry.botRpcPending.size, 0)
})

test('history: result with a different requestId does not settle', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const sent = hello(b.registry, 'n1')
  const p = b.registry.botHistory('n1', 'b1')
  await tick()
  reply(b.registry, 'n1', 'bot/history-result', { requestId: 'other', ok: true, items: [] })
  assert.equal(b.registry.botRpcPending.size, 1)
  reply(b.registry, 'n1', 'bot/history-result', { requestId: lastFrame(sent, 'bot/history').d.requestId, ok: true, items: [] })
  assert.equal((await p).ok, true)
})

test('history: offline node → node-offline; missing params → 400', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const r = await call(b.routes, `${NEW}/bots/history?nodeId=ghost&botId=b1`)
  assert.deepEqual(r.body, { ok: false, error: 'node-offline' })
  assert.equal((await call(b.routes, `${NEW}/bots/history?nodeId=n1`)).status, 400)
  assert.equal((await call(b.routes, `${NEW}/bots/history`, { method: 'POST', body: {} })).status, 405)
})

test('history: disconnect mid-request resolves node-offline and clears pending', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  const p = b.registry.botHistory('n1', 'b1')
  await tick()
  assert.equal(b.registry.botRpcPending.size, 1)
  b.registry.markOffline('n1', 'test-disconnect') // 真实断连路径
  assert.deepEqual(await p, { ok: false, error: 'node-offline' })
  assert.equal(b.registry.botRpcPending.size, 0)
})

test('history: over the cap → bot-history-busy', async (t) => {
  const b = boot(); t.after(() => { b.registry.botRpcCancelForNode('n1'); b.handles.dispose() })
  hello(b.registry, 'n1')
  b.registry.botRpcMax = 1
  const first = b.registry.botHistory('n1', 'b1')
  assert.deepEqual(await b.registry.botHistory('n1', 'b1'), { ok: false, error: 'bot-history-busy' })
  b.registry.botRpcCancelForNode('n1'); await first
})

test('turn: accepted returns exchangeId, sent frame carries it; result frame flips to done with text', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const sent = hello(b.registry, 'n1')
  const r = await call(b.routes, `${NEW}/bots/turn`, { method: 'POST', body: { nodeId: 'n1', botId: 'b1', text: 'hello' } })
  assert.equal(r.body.ok, true)
  const f = lastFrame(sent, 'bot/turn')
  assert.ok(f, 'bot/turn actually sent')
  assert.equal(f.d.exchangeId, r.body.exchangeId)
  assert.equal(f.d.remoteBotId, 'b1')
  assert.equal(f.d.text, 'hello')
  assert.equal((await call(b.routes, `${NEW}/bots/turn?exchangeId=${r.body.exchangeId}`)).body.state, 'running')
  reply(b.registry, 'n1', 'bot/turn-result', { nodeId: 'n1', remoteBotId: 'b1', exchangeId: r.body.exchangeId, text: 'answer', ok: true, seq: 1 })
  const s = await call(b.routes, `${OLD}/bots/turn?exchangeId=${r.body.exchangeId}`)
  assert.deepEqual(s.body, { ok: true, state: 'done', text: 'answer' })
})

test('turn: failed result → failed + error; unknown id → unknown; foreign node result ignored', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1'); hello(b.registry, 'n2')
  const a = b.registry.startBotTurn('n1', 'b1', 'x')
  reply(b.registry, 'n2', 'bot/turn-result', { nodeId: 'n2', remoteBotId: 'b1', exchangeId: a.exchangeId, text: 'spoof', ok: true, seq: 1 })
  assert.equal(b.registry.botTurnStatus(a.exchangeId).state, 'running')
  reply(b.registry, 'n1', 'bot/turn-result', { nodeId: 'n1', remoteBotId: 'b1', exchangeId: a.exchangeId, ok: false, error: 'boom', seq: 1 })
  const s = b.registry.botTurnStatus(a.exchangeId)
  assert.equal(s.state, 'failed'); assert.equal(s.error, 'boom')
  assert.equal(b.registry.botTurnStatus('nope').state, 'unknown')
  reply(b.registry, 'n1', 'bot/turn-result', { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'stranger', text: 't', ok: true, seq: 1 })
  assert.equal(b.registry.botTurns.size, 1, 'unknown result dropped, not stored')
})

test('turn: offline, empty and oversize text are refused', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  const post = (body) => call(b.routes, `${NEW}/bots/turn`, { method: 'POST', body })
  assert.deepEqual((await post({ nodeId: 'ghost', botId: 'b', text: 'x' })).body, { ok: false, error: 'node-offline' })
  assert.equal((await post({ nodeId: 'n1', botId: 'b', text: '   ' })).status, 400)
  assert.equal((await post({ nodeId: 'n1', botId: 'b', text: 'x'.repeat(9000) })).status, 400)
  assert.equal((await call(b.routes, `${NEW}/bots/turn`, { method: 'DELETE' })).status, 405)
})

test('turn ring: evicts oldest beyond cap; TTL expires entries', async (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  const ids = []
  for (let i = 0; i < b.registry.botTurnMax + 5; i++) {
    const r = b.registry.startBotTurn('n1', 'b1', 'x')
    if (!r.ok) { // 全是在途回合时拒绝新回合（不挤掉在跑的）
      assert.equal(r.error, 'bot-turn-busy'); break
    }
    ids.push(r.exchangeId)
    reply(b.registry, 'n1', 'bot/turn-result', { nodeId: 'n1', remoteBotId: 'b1', exchangeId: r.exchangeId, text: 't' + i, ok: true, seq: 1 })
  }
  assert.ok(b.registry.botTurns.size <= b.registry.botTurnMax)
  assert.equal(b.registry.botTurnStatus(ids[0]).state, 'unknown', 'oldest evicted')
  assert.equal(b.registry.botTurnStatus(ids.at(-1)).state, 'done')
  b.registry.botTurnTtlMs = -1
  assert.equal(b.registry.botTurnStatus(ids.at(-1)).state, 'unknown', 'ttl expired')
})

test('turn ring: running turns are never evicted — new turn is busy instead', (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  hello(b.registry, 'n1')
  b.registry.botTurnMax = 2
  const a = b.registry.startBotTurn('n1', 'b', 'x'); b.registry.startBotTurn('n1', 'b', 'x')
  assert.deepEqual(b.registry.startBotTurn('n1', 'b', 'x'), { ok: false, error: 'bot-turn-busy' })
  assert.equal(b.registry.botTurnStatus(a.exchangeId).state, 'running')
})

test('client: detail view, polling, distinct states', () => {
  const src = fs.readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /function botChatView/)
  assert.match(src, /'\/bots\/turn\?exchangeId='/)
  assert.match(src, /'\/bots\/history\?nodeId='/)
  assert.match(src, /setTimeout\(poll, 2000\)/)
  for (const s of ['加载中…', '没有对话', '读取失败', '运行中…', '等待超时', '返回', '编辑', '发送']) assert.ok(src.includes(s), s)
  assert.match(src, /setOpenBot/)
})
