// bot/trace（能力 bot-trace/1）：节点 Bot 的思考过程与工具步骤送到主控页面。
// 覆盖 AC 这一侧的每一跳：校验与上限（两份校验器一致）、必须加密的两张表、能力在 hello / welcome 里、
// 节点 dispatch（live 帧 + final 帧先于结果、旧 hub 一帧不发、对等节点回合不发）、hub ingest 发出 botTrace 事件。
// ds-bot 一侧的端到端（用真实的 AC 函数）在 ds-bot/test/node-trace-e2e.test.js。
import assert from 'node:assert/strict'
import test from 'node:test'
import { withIngest } from '../lib/hub/registry-ingest.js'
import { createFrameDispatcher } from '../lib/node/dispatch.js'
import { createFrameDispatcher as createSrcDispatcher } from '../src/task-run/dispatch.js'
import * as live from '../lib/node/transport.js'
import * as wireFraming from '../src/wire/session-framing.js'
import * as linkTransport from '../src/link/transport.js'
import * as lib from '../lib/protocol.js'
import * as wire from '../src/wire/index.js'
import { nodeCaps as srcNodeCaps, HUB_CAPS as srcHubCaps } from '../src/caps/node-caps.js'

const { NODE_TO_HUB, HUB_TO_NODE, BOT_TRACE_CAP, BOT_TRACE_LIMITS } = lib
const both = { 'lib/protocol.js': lib, 'src/wire': wire }
const base = { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex-1', seq: 1 }
const think = text => ({ t: 'a', think: text })

for (const [where, impl] of Object.entries(both)) {
  test(`validateBotTrace (${where}): identity, seq and items are required; every refusal has its own code`, () => {
    const v = impl.validateBotTrace
    assert.equal(v(undefined).error, 'bot-trace-missing')
    assert.equal(v({ ...base, nodeId: '', items: [] }).error, 'bot-trace-nodeId-missing')
    assert.equal(v({ ...base, remoteBotId: ' ', items: [] }).error, 'bot-trace-remoteBotId-missing')
    assert.equal(v({ ...base, exchangeId: undefined, items: [] }).error, 'bot-trace-exchangeId-missing')
    assert.equal(v({ ...base, seq: undefined, items: [] }).error, 'bot-trace-seq-missing')
    assert.equal(v({ ...base, seq: 1.5, items: [] }).error, 'bot-trace-seq-missing')
    assert.equal(v({ ...base, seq: 0, items: [] }).error, 'bot-trace-seq-invalid')
    assert.equal(v({ ...base }).error, 'bot-trace-items-missing')
    assert.equal(v({ ...base, items: {} }).error, 'bot-trace-items-missing')
    assert.equal(v({ ...base, items: [], roomId: '' }).error, 'bot-trace-room-invalid')
    assert.equal(v({ ...base, items: [] }).ok, true, 'an empty final frame is legal: nothing to show is still an answer')
  })

  test(`validateBotTrace (${where}): only the whitelisted fields survive, in order, deduplicated by i`, () => {
    const checked = impl.validateBotTrace({
      ...base, seq: 7, final: true, omitted: 3, roomId: ' room-1 ', secret: 'x', extra: { a: 1 },
      items: [
        { i: 3, t: 'r', id: 'c1', ok: false, out: 'boom', stack: 'no' },
        { i: 1, t: 'a', think: 'hmm', say: 'not part of the schema', calls: [{ id: 'c1', name: 'read', args: '{"p":1}', secret: 1 }], end: false, junk: 1 },
        { i: 2, t: 'a', end: true },
        { i: 1, t: 'a', think: 'duplicate of 1' },
        { i: 0, t: 'a' }, { t: 'a' }, { i: 4, t: 'zzz' }, null, 'x',
        { i: 5, t: 'r', ok: true },
      ],
    })
    assert.equal(checked.ok, true)
    assert.deepEqual(checked.trace, {
      nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex-1', seq: 7, final: true,
      items: [
        { i: 1, t: 'a', think: 'hmm', calls: [{ id: 'c1', name: 'read', args: '{"p":1}' }] },
        { i: 2, t: 'a', end: true },
        { i: 3, t: 'r', id: 'c1', ok: false, out: 'boom' },
      ],
      omitted: 3,
      clipped: 7,
      roomId: 'room-1',
    })
  })

  test(`validateBotTrace (${where}): long text is cut with a visible marker, never dropped silently`, () => {
    const L = BOT_TRACE_LIMITS
    const checked = impl.validateBotTrace({
      ...base,
      items: [
        { i: 1, t: 'a', think: 'T'.repeat(L.think + 50), calls: [{ id: 'c', name: 'N'.repeat(L.name + 20), args: JSON.stringify({ content: 'A'.repeat(L.args + 500) }) }] },
        { i: 2, t: 'r', id: 'c', ok: true, out: 'O'.repeat(L.out + 1) },
      ],
    })
    const [a, r] = checked.trace.items
    assert.equal(a.think, `${'T'.repeat(L.think)}…[已截断 50 字]`)
    assert.equal(a.calls[0].name.length, L.name)
    assert.doesNotThrow(() => JSON.parse(a.calls[0].args), 'an over-long argument string is replaced by valid JSON')
    assert.match(JSON.parse(a.calls[0].args)._truncated, /…\[已截断 \d+ 字\]$/)
    assert.equal(r.out, `${'O'.repeat(L.out)}…[已截断 1 字]`)
    assert.equal(checked.trace.clipped, 3, 'think, args and out were cut: counted, not hidden')
  })

  test(`validateBotTrace (${where}): a live frame takes maxBatchItems, the final frame maxItems, the rest is counted`, () => {
    const L = BOT_TRACE_LIMITS
    const items = Array.from({ length: L.maxItems + 25 }, (_, n) => think(`t${n}`)).map((item, n) => ({ ...item, i: n + 1 }))
    const liveFrame = impl.validateBotTrace({ ...base, items }).trace
    assert.equal(liveFrame.items.length, L.maxBatchItems)
    assert.equal(liveFrame.clipped, items.length - L.maxBatchItems)
    const finalFrame = impl.validateBotTrace({ ...base, final: true, items }).trace
    assert.equal(finalFrame.items.length, L.maxItems)
    assert.equal(finalFrame.clipped, 25)
    assert.deepEqual(finalFrame.items.map(item => item.i), Array.from({ length: L.maxItems }, (_, n) => n + 1), 'the kept steps are the first ones, in order, with no gap')
  })

  test(`validateBotTrace (${where}): a frame over the byte budget drops whole steps from the end and counts them`, () => {
    const L = BOT_TRACE_LIMITS
    const items = Array.from({ length: 60 }, (_, n) => ({ i: n + 1, t: 'a', think: 'x'.repeat(L.think), calls: [{ id: 'c', name: 'bash', args: 'a'.repeat(L.args) }] }))
    const trace = impl.validateBotTrace({ ...base, final: true, items }).trace
    const bytes = trace.items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0)
    assert.ok(bytes <= L.frameBytes)
    assert.ok(trace.items.length < 60 && trace.items.length > 20)
    assert.equal(trace.clipped, 60 - trace.items.length)
  })
}

test('the two validators and limits are the same code (lib/protocol.js and src/wire)', () => {
  assert.equal(lib.validateBotTrace.toString(), wire.validateBotTrace.toString())
  assert.deepEqual({ ...lib.BOT_TRACE_LIMITS }, { ...wire.BOT_TRACE_LIMITS })
  assert.equal(lib.NODE_TO_HUB.BOT_TRACE, 'bot/trace')
  assert.equal(wire.NODE_TO_HUB.BOT_TRACE, 'bot/trace')
})

test('bot/trace is a must-encrypt frame in every copy of both lists, and the hub gate rejects it in the clear', () => {
  for (const [name, impl] of Object.entries({ 'lib/node/transport.js': live, 'src/wire/session-framing.js': wireFraming, 'src/link/transport.js': linkTransport })) {
    assert.equal(impl.isE2ERequired(NODE_TO_HUB.BOT_TRACE), true, `${name} downlink table`)
    assert.equal(impl.isE2ERequiredUplink(NODE_TO_HUB.BOT_TRACE), true, `${name} uplink table`)
    assert.equal(impl.checkUplinkE2EGate({ t: NODE_TO_HUB.BOT_TRACE }, { e2e: true, wasEncrypted: false }).rejected, true, `${name}: a plaintext trace is a forgery or a downgrade`)
    assert.equal(impl.checkUplinkE2EGate({ t: NODE_TO_HUB.BOT_TRACE }, { e2e: true, wasEncrypted: true }).rejected, false)
  }
})

test('capability: the node says bot-trace/1 in its hello, the hub in its welcome (both module graphs)', () => {
  assert.equal(BOT_TRACE_CAP, 'bot-trace/1')
  assert.ok(lib.nodeCaps([]).includes(BOT_TRACE_CAP))
  assert.ok(srcNodeCaps([]).includes(BOT_TRACE_CAP))
  assert.ok(lib.HUB_CAPS.includes(BOT_TRACE_CAP) && lib.HUB_CAPS.includes(lib.MEMORY_CAPS))
  assert.deepEqual([...srcHubCaps], [...lib.HUB_CAPS])
})

// ── node: the real dispatcher + handleBotTurnFrame ───────────────────────────────────────────────

function nodeHarness(opts) {
  const { receiver, dispatcher = createFrameDispatcher } = opts
  const hubCaps = 'hubCaps' in opts ? opts.hubCaps : [BOT_TRACE_CAP]
  const sent = []
  const ctx = { logger: { info() {}, warn() {}, error() {}, debug() {} }, get: name => (name === 'remote-agent:bot-turn' ? receiver : undefined) }
  const send = (type, data) => { sent.push({ type, data: structuredClone(data) }); return true }
  const dispatch = dispatcher({ ctx, send, sendError() {}, engine: {}, logger: ctx.logger, hubCaps: hubCaps === undefined ? undefined : () => hubCaps })
  const settled = async () => { const started = Date.now(); while (!sent.some(s => s.type === NODE_TO_HUB.BOT_TURN_RESULT) && Date.now() - started < 800) await new Promise(r => setImmediate(r)) }
  const turn = { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex-1', text: 'hi' }
  return { sent, dispatch, send, settled, turn }
}

for (const [name, dispatcher] of [['lib/node/dispatch.js', createFrameDispatcher], ['src/task-run/dispatch.js', createSrcDispatcher]]) {
  test(`node (${name}): live batches, then the final list, then the result, in that order; seq only goes up`, async () => {
    const seen = []
    const receiver = async (turn, control) => {
      seen.push(control.enabled)
      assert.equal(control.trace({ items: [{ i: 1, t: 'a', think: 'one' }] }), true)
      assert.equal(control.trace({ items: [{ i: 2, t: 'a', calls: [{ id: 'c', name: 'bash', args: '{}' }] }, { i: 3, t: 'r', id: 'c', ok: true, out: 'done' }] }), true)
      return { ok: true, text: 'answer', trace: { items: [{ i: 1, t: 'a', think: 'one' }, { i: 2, t: 'a', calls: [{ id: 'c', name: 'bash', args: '{}' }] }, { i: 3, t: 'r', id: 'c', ok: true, out: 'done' }, { i: 4, t: 'a', end: true }], omitted: 0 } }
    }
    const h = nodeHarness({ receiver, dispatcher })
    h.dispatch({ id: 'f1', t: HUB_TO_NODE.BOT_TURN, d: h.turn })
    await h.settled()
    assert.deepEqual(seen, [true])
    assert.deepEqual(h.sent.map(s => s.type), [NODE_TO_HUB.BOT_TRACE, NODE_TO_HUB.BOT_TRACE, NODE_TO_HUB.BOT_TRACE, NODE_TO_HUB.BOT_TURN_RESULT])
    assert.deepEqual(h.sent.slice(0, 3).map(s => s.data.seq), [1, 2, 3])
    assert.deepEqual(h.sent.slice(0, 3).map(s => s.data.final ?? false), [false, false, true])
    assert.deepEqual(h.sent[2].data.items.map(item => item.i), [1, 2, 3, 4], 'the final frame carries every step')
    for (const frame of h.sent.slice(0, 3)) assert.deepEqual([frame.data.nodeId, frame.data.remoteBotId, frame.data.exchangeId], ['n1', 'b1', 'ex-1'])
    assert.equal(h.sent[3].data.text, 'answer')
    // what the node sent is exactly what the hub's validator accepts back
    for (const frame of h.sent.slice(0, 3)) assert.equal(lib.validateBotTrace(frame.data).ok, true)
  })

  test(`node (${name}): a hub that did not announce bot-trace/1 gets no bot/trace frame at all (old hub)`, async () => {
    const seen = []
    const receiver = async (turn, control) => {
      seen.push([control.enabled, control.trace({ items: [{ i: 1, t: 'a', think: 'x' }] })])
      return { ok: true, text: 'answer', trace: { items: [{ i: 1, t: 'a', think: 'x' }] } }
    }
    for (const hubCaps of [[], ['memory-sync/1'], undefined]) {
      const h = nodeHarness({ receiver, dispatcher, hubCaps })
      h.dispatch({ id: 'f1', t: HUB_TO_NODE.BOT_TURN, d: h.turn })
      await h.settled()
      assert.deepEqual(h.sent.map(s => s.type), [NODE_TO_HUB.BOT_TURN_RESULT], JSON.stringify(hubCaps))
    }
    assert.deepEqual(seen, [[false, false], [false, false], [false, false]], 'the receiver is told tracing is off')
  })

  test(`node (${name}): a turn that came from a peer is answered to that peer and carries no trace`, async () => {
    const peer = []
    const receiver = async (turn, control) => ({ ok: true, text: 'answer', enabled: control.enabled, trace: { items: [{ i: 1, t: 'a', think: 'x' }] } })
    const h = nodeHarness({ receiver, dispatcher })
    h.dispatch({ id: 'f1', t: HUB_TO_NODE.BOT_TURN, d: h.turn }, undefined, (type, data) => { peer.push({ type, data }); return true })
    const started = Date.now()
    while (peer.length === 0 && Date.now() - started < 800) await new Promise(r => setImmediate(r))
    assert.deepEqual(peer.map(p => p.type), [NODE_TO_HUB.BOT_TURN_RESULT])
    assert.deepEqual(h.sent, [])
  })
}

test('node: a receiver that fails still gets its final steps out before the failure result', async () => {
  const receiver = async () => ({ ok: false, error: 'bot-turn-cancelled', text: '', trace: { items: [{ i: 1, t: 'a', think: 'half way' }] } })
  const h = nodeHarness({ receiver })
  h.dispatch({ id: 'f1', t: HUB_TO_NODE.BOT_TURN, d: h.turn })
  await h.settled()
  assert.deepEqual(h.sent.map(s => [s.type, s.data.final ?? s.data.ok]), [[NODE_TO_HUB.BOT_TRACE, true], [NODE_TO_HUB.BOT_TURN_RESULT, false]])
})

test('node: a final trace that cannot be sent does not hold back the result', async () => {
  const { handleBotTurnFrame } = await import('../lib/bot-turn.js')
  const sent = []
  let traceTries = 0
  const send = (type, data) => {
    if (type === NODE_TO_HUB.BOT_TRACE) { traceTries += 1; return false }
    sent.push({ type, data }); return true
  }
  const ctx = { get: () => async () => ({ ok: true, text: 'answer', trace: { items: [{ i: 1, t: 'a', think: 'x' }] } }) }
  await handleBotTurnFrame({ frame: { id: 'f' }, data: { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex-9', text: 'hi' }, ctx, send, sendError() {}, engine: {}, hubCaps: () => [BOT_TRACE_CAP], retryDelaysMs: [1, 1, 1] })
  assert.equal(traceTries, 4, 'tried, then gave up after its (shortened) retry list')
  assert.deepEqual(sent.map(s => s.type), [NODE_TO_HUB.BOT_TURN_RESULT])
})

test('node: an invalid live batch is refused locally and does not burn the receiver (trace() answers false)', async () => {
  let answer
  const receiver = async (turn, control) => { answer = control.trace({ items: 'not a list' }); return { ok: true, text: 'a' } }
  const h = nodeHarness({ receiver })
  h.dispatch({ id: 'f1', t: HUB_TO_NODE.BOT_TURN, d: h.turn })
  await h.settled()
  assert.equal(answer, false)
  assert.deepEqual(h.sent.map(s => s.type), [NODE_TO_HUB.BOT_TURN_RESULT])
})

// ── hub: the real ingest ─────────────────────────────────────────────────────────────────────────

function hubRegistry(nodeId = 'n1') {
  const listeners = {}
  class Core {
    constructor() { this.nodes = new Map([[nodeId, { nodeId, lastSeen: 0, online: true }]]); this.tasks = new Map(); this.logs = []; this.audits = [] }
    log(level, event, detail) { this.logs.push({ level, event, detail }) }
    send() {}
    on(name, fn) { (listeners[name] ??= []).push(fn); return () => {} }
    emit(name, payload) { for (const fn of listeners[name] ?? []) fn(payload) }
    auditRecord(event, fields) { this.audits.push({ event, fields }) }
  }
  const registry = new (withIngest(Core))()
  const events = []
  registry.on('botTrace', payload => events.push(payload))
  const results = []
  registry.on('botTurnResult', payload => results.push(payload))
  return { registry, events, results }
}
const traceFrame = d => ({ t: NODE_TO_HUB.BOT_TRACE, d })

test('hub: a valid trace is emitted as botTrace under the authenticated node, with the validated shape', () => {
  const { registry, events } = hubRegistry()
  registry.handleFrameFor('n1', traceFrame({ ...base, seq: 2, final: true, items: [{ i: 1, t: 'a', think: 'hm', junk: 1 }], stray: true }))
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex-1', seq: 2, final: true, items: [{ i: 1, t: 'a', think: 'hm' }] })
})

test('hub: a trace claiming another node is dropped and audited; a malformed one is dropped without failing the turn', () => {
  const { registry, events, results } = hubRegistry()
  registry.handleFrameFor('n1', traceFrame({ ...base, nodeId: 'n2', items: [] }))
  assert.deepEqual(events, [])
  assert.equal(registry.audits.at(-1).fields.reason, 'node-mismatch')
  registry.handleFrameFor('n1', traceFrame({ ...base, seq: undefined, items: [] }))
  registry.handleFrameFor('n1', traceFrame({ ...base, items: 'nope' }))
  assert.deepEqual(events, [])
  assert.deepEqual(results, [], 'a bad trace never turns into a failed turn')
  assert.equal(registry.audits.filter(row => row.event === 'ingest.rejected').length, 3)
  assert.ok(registry.logs.some(row => row.level === 'warn' && row.event === 'bot/trace rejected'))
})

test('hub: an exact replay is delivered once; a different frame with the same seq (node restarted) is not mistaken for it', () => {
  const { registry, events } = hubRegistry()
  const frame = traceFrame({ ...base, seq: 1, items: [{ i: 1, t: 'a', think: 'one' }] })
  registry.handleFrameFor('n1', frame)
  registry.handleFrameFor('n1', frame)
  assert.equal(events.length, 1)
  registry.handleFrameFor('n1', traceFrame({ ...base, seq: 1, items: [{ i: 1, t: 'a', think: 'one' }, { i: 2, t: 'a', think: 'two' }] }))
  assert.equal(events.length, 2)
  registry.handleFrameFor('n1', traceFrame({ ...base, seq: 1, final: true, items: [{ i: 1, t: 'a', think: 'one' }] }))
  assert.equal(events.length, 3, 'final is a different frame even at the same seq')
})

test('hub: the replay memory is bounded', () => {
  const { registry } = hubRegistry()
  for (let n = 1; n <= 4200; n += 1) registry.handleFrameFor('n1', traceFrame({ ...base, exchangeId: `ex-${n}`, seq: 1, items: [] }))
  assert.ok(registry.traceSeen.size <= 4096)
})
