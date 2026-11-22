/**
 * Job ring: a lost link must not throw away the answer. Running turns of an offline node stay running with a
 * linkLost flag, a late real result still settles them, and only a (much longer) hard timeout - audited - ends them.
 * Time is a fake clock (Date.now mocked).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { PROTOCOL_VERSION } from '../lib/protocol.js'

function setup(t) {
  const audits = []
  const logs = []
  const registry = new NodeRegistry({
    log: (level, msg, extra) => logs.push({ level, msg, extra }),
    relay: { ready: true, send: () => true },
    audit: { record: (event, fields) => audits.push({ event, fields }) },
  })
  registry.send = () => true
  const clock = { now: 1_700_000_000_000 }
  t.mock.method(Date, 'now', () => clock.now)
  const online = (nodeId) => registry.ingestHello({
    helloData: { nodeId, protocol: PROTOCOL_VERSION, os: 'linux', hostname: `h-${nodeId}`, nonce: '', time: clock.now },
    conn: { send() {}, close() {} }, transport: 'direct', pending: undefined,
  })
  return { registry, audits, logs, clock, online }
}

test('RING-1: offline -> still running (linkLost); the later real result settles it; the flag is gone', (t) => {
  const { registry, clock, online } = setup(t)
  online('n1')
  const { exchangeId } = registry.startBotTurn('n1', 'bot', 'hi')
  clock.now += 60_000
  registry.markOffline('n1', 'heartbeat timeout')
  assert.deepEqual(registry.botTurnStatus(exchangeId), { state: 'running', linkLost: true })

  // the node comes back and replays the answer it computed while the link was down
  clock.now += 120_000
  online('n1')
  registry.settleBotTurn({ exchangeId, nodeId: 'n1', ok: true, text: 'the real answer' })
  assert.deepEqual(registry.botTurnStatus(exchangeId), { state: 'done', text: 'the real answer' })
})

test('RING-2: a running turn is not evicted by the 10 minute TTL, not even for a long-offline node', (t) => {
  const { registry, clock, online } = setup(t)
  online('n1')
  const { exchangeId } = registry.startBotTurn('n1', 'bot', 'hi')
  registry.markOffline('n1', 'gone')
  clock.now += 30 * 60_000 // three TTLs
  assert.deepEqual(registry.botTurnStatus(exchangeId), { state: 'running', linkLost: true })
  assert.ok(registry.botTurns.has(exchangeId))
  // but a settled entry still expires on the TTL
  const done = registry.startBotTurn('n1', 'bot', 'x')
  registry.settleBotTurn({ exchangeId: done.exchangeId, nodeId: 'n1', ok: true, text: 'a' })
  clock.now += 11 * 60_000
  assert.equal(registry.botTurnStatus(done.exchangeId).state, 'unknown')
})

test('RING-3: the hard timeout fails the turn with a reason, and writes an audit record', (t) => {
  const { registry, audits, clock, online } = setup(t)
  online('n1')
  const { exchangeId } = registry.startBotTurn('n1', 'bot', 'hi')
  registry.markOffline('n1', 'gone')
  clock.now += registry.botTurnHardTimeoutMs + 1000
  const st = registry.botTurnStatus(exchangeId)
  assert.equal(st.state, 'failed')
  assert.equal(st.error, 'bot-turn-hard-timeout')
  const audit = audits.find((a) => a.event === 'botturn.expired')
  assert.equal(audit.fields.exchangeId, exchangeId)
  assert.equal(audit.fields.nodeId, 'n1')
  assert.equal(audit.fields.linkLost, true)
  // and it does not expire twice
  clock.now += 1000
  registry.botTurnStatus(exchangeId)
  assert.equal(audits.filter((a) => a.event === 'botturn.expired').length, 1)
})

test('RING-4: link-lost turns do not hold admission slots; an ordinary running turn of an online node still does', (t) => {
  const { registry, online } = setup(t)
  online('n1'); online('n2')
  registry.botTurnMax = 2
  assert.ok(registry.startBotTurn('n1', 'b', 'x').ok)
  assert.ok(registry.startBotTurn('n1', 'b', 'x').ok)
  assert.deepEqual(registry.startBotTurn('n2', 'b', 'x'), { ok: false, error: 'bot-turn-busy' })
  registry.markOffline('n1', 'gone')
  assert.ok(registry.startBotTurn('n2', 'b', 'x').ok)
  assert.ok(registry.startBotTurn('n2', 'b', 'x').ok)
  assert.deepEqual(registry.startBotTurn('n2', 'b', 'x'), { ok: false, error: 'bot-turn-busy' })
  assert.equal(registry.botTurns.size, 4, 'the link-lost turns are still in the ring')
})

test('RING-5: a result from a different node cannot settle a link-lost turn', (t) => {
  const { registry, online } = setup(t)
  online('n1')
  const { exchangeId } = registry.startBotTurn('n1', 'bot', 'hi')
  registry.markOffline('n1', 'gone')
  registry.settleBotTurn({ exchangeId, nodeId: 'n2', ok: true, text: 'forged' })
  assert.deepEqual(registry.botTurnStatus(exchangeId), { state: 'running', linkLost: true })
})
