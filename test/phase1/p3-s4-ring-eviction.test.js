// The bot-turn ring must never evict a turn that is still running while settled entries exist.
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
  const registry = services.get('ai-cluster:registry') ?? services.get('remote-agent:registry')
  registry.ingestHello({
    helloData: { nodeId: 'n1', protocol: PROTOCOL_VERSION, os: 'linux', hostname: 'h-n1', nonce: '', time: Date.now() },
    conn: { send() {}, close() {} }, transport: 'direct', pending: undefined,
  })
  registry.botTurnMax = 3
  return { handles, registry }
}

const settle = (reg, id) => reg.settleBotTurn({ exchangeId: id, nodeId: 'n1', ok: true, text: 'done' })

test('ring full of settled entries: the new turn survives', (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const reg = b.registry
  const old = []
  for (let i = 0; i < 3; i++) { const r = reg.startBotTurn('n1', 'b', 'x'); assert.ok(r.ok); settle(reg, r.exchangeId); old.push(r.exchangeId) }
  const fresh = reg.startBotTurn('n1', 'b', 'x')
  assert.ok(fresh.ok)
  assert.deepEqual(reg.botTurnStatus(fresh.exchangeId), { state: 'running' })
  assert.equal(reg.botTurns.size, 3)
  assert.equal(reg.botTurnStatus(old[0]).state, 'unknown', 'oldest settled entry is the one dropped')
})

test('oldest is running, rest settled: adding one more drops a settled entry, not the running one', (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const reg = b.registry
  const running = reg.startBotTurn('n1', 'b', 'x')
  const s1 = reg.startBotTurn('n1', 'b', 'x'); const s2 = reg.startBotTurn('n1', 'b', 'x')
  settle(reg, s1.exchangeId); settle(reg, s2.exchangeId)
  const extra = reg.startBotTurn('n1', 'b', 'x')
  assert.ok(extra.ok)
  assert.deepEqual(reg.botTurnStatus(running.exchangeId), { state: 'running' })
  assert.equal(reg.botTurnStatus(s1.exchangeId).state, 'unknown')
  assert.equal(reg.botTurnStatus(s2.exchangeId).state, 'done')
  assert.deepEqual(reg.botTurnStatus(extra.exchangeId), { state: 'running' })
  // a late result for the running turn is still accepted
  settle(reg, running.exchangeId)
  assert.deepEqual(reg.botTurnStatus(running.exchangeId), { state: 'done', text: 'done' })
})

test('all entries running: one more is bot-turn-busy and nothing is deleted', (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const reg = b.registry
  const ids = [0, 1, 2].map(() => reg.startBotTurn('n1', 'b', 'x').exchangeId)
  assert.deepEqual(reg.startBotTurn('n1', 'b', 'x'), { ok: false, error: 'bot-turn-busy' })
  assert.equal(reg.botTurns.size, 3)
  for (const id of ids) assert.deepEqual(reg.botTurnStatus(id), { state: 'running' })
})

test('unknown exchangeId result logs bot-turn-result-unknown at debug and returns undefined', (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const reg = b.registry
  const calls = []
  reg.log = (...a) => calls.push(a)
  assert.equal(reg.settleBotTurn({ exchangeId: 'bx-nope', ok: true, text: 'x' }), undefined)
  assert.deepEqual(calls, [['debug', 'bot-turn-result-unknown', { exchangeId: 'bx-nope' }]])
})

test('running entries at oldest and middle, settled newest: every shrink drops the settled one, both running survive', (t) => {
  const b = boot(); t.after(() => b.handles.dispose())
  const reg = b.registry
  const r1 = reg.startBotTurn('n1', 'b', 'x')
  const r2 = reg.startBotTurn('n1', 'b', 'x')
  const s = reg.startBotTurn('n1', 'b', 'x')
  settle(reg, s.exchangeId)
  const extra = reg.startBotTurn('n1', 'b', 'x')
  assert.ok(extra.ok)
  assert.equal(reg.botTurnStatus(s.exchangeId).state, 'unknown')
  for (const id of [r1.exchangeId, r2.exchangeId, extra.exchangeId]) assert.deepEqual(reg.botTurnStatus(id), { state: 'running' })
  assert.equal(reg.botTurns.size, 3)
})
