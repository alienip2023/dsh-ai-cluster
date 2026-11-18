// review-fix A / item 2: a node disconnect fails that node's in-flight bot turns with
// 'node-offline' so they stop holding one of the botTurnMax slots until the 10 minute TTL.
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../lib/index.js'
import { PROTOCOL_VERSION } from '../../lib/protocol.js'

function boot() {
  const services = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    get() { return undefined },
    provide(name, value) { services.set(name, value); return () => {} },
    webServer: { register() { return () => {} }, registerUpgrade() { return () => {} } },
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    subagents: { registerProvider: () => () => {} },
  }
  const handles = apply(ctx, { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0 })
  return { handles, registry: services.get('ai-cluster:registry') ?? services.get('remote-agent:registry') }
}

function hello(registry, nodeId) {
  registry.ingestHello({
    helloData: { nodeId, protocol: PROTOCOL_VERSION, os: 'linux', hostname: 'h-' + nodeId, nonce: '', time: Date.now() },
    conn: { send() {}, close() {} }, transport: 'direct', pending: undefined,
  })
}

test('node offline: its running turns fail with node-offline, free their slots, new turn accepted; other nodes untouched', (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const reg = b.registry
  hello(reg, 'n1'); hello(reg, 'n2')
  reg.botTurnMax = 3

  const a1 = reg.startBotTurn('n1', 'b', 'x')
  const a2 = reg.startBotTurn('n1', 'b', 'x')
  const other = reg.startBotTurn('n2', 'b', 'x')
  assert.ok(a1.ok && a2.ok && other.ok)
  // the ring is full of running turns, so the next one is refused
  assert.deepEqual(reg.startBotTurn('n1', 'b', 'x'), { ok: false, error: 'bot-turn-busy' })

  reg.markOffline('n1', 'test')

  for (const id of [a1.exchangeId, a2.exchangeId]) {
    assert.deepEqual(reg.botTurnStatus(id), { state: 'failed', error: 'node-offline', text: '' })
  }
  assert.deepEqual(reg.botTurnStatus(other.exchangeId), { state: 'running' }, 'other node untouched')

  // two slots are free again: a new turn on the still-online node is accepted, the admission rule is unchanged
  const n1 = reg.startBotTurn('n2', 'b', 'y')
  const n2 = reg.startBotTurn('n2', 'b', 'y')
  assert.ok(n1.ok && n2.ok)
  assert.deepEqual(reg.startBotTurn('n2', 'b', 'y'), { ok: false, error: 'bot-turn-busy' }, 'botTurnMax still enforced')
  assert.equal(reg.botTurnMax, 3)
})

test('node offline: an already settled turn keeps its result', (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const reg = b.registry
  hello(reg, 'n1')
  const a = reg.startBotTurn('n1', 'b', 'x')
  reg.settleBotTurn({ exchangeId: a.exchangeId, nodeId: 'n1', ok: true, text: 'answer' })
  reg.markOffline('n1', 'test')
  assert.deepEqual(reg.botTurnStatus(a.exchangeId), { state: 'done', text: 'answer' })
})

test('node offline with a full ring of its own turns: the 33rd turn is no longer bot-turn-busy for everyone', (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const reg = b.registry
  hello(reg, 'n1'); hello(reg, 'n2')
  for (let i = 0; i < 32; i++) assert.ok(reg.startBotTurn('n1', 'b', 'x').ok)
  assert.deepEqual(reg.startBotTurn('n2', 'b', 'x'), { ok: false, error: 'bot-turn-busy' })
  reg.markOffline('n1', 'test')
  assert.ok(reg.startBotTurn('n2', 'b', 'x').ok)
})
