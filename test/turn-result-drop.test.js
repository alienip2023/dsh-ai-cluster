// 回合结果帧不能再无声消失（REPORT-joined-reply-lost-2026-11-22）：
//   · 主控 ingest 的每条丢弃路径都有审计记录；能判定回合的，回一个明确的失败结果；
//   · 节点发结果帧时链路断着（send === false）要记录并重试，而不是永久丢帧。
import test from 'node:test'
import assert from 'node:assert/strict'
import { withIngest } from '../lib/hub/registry-ingest.js'
import { handleBotTurnFrame } from '../lib/bot-turn.js'
import { NODE_TO_HUB } from '../lib/protocol.js'

const CONN = 'node-a'

function registryFor(nodeId = CONN, { withAudit = true } = {}) {
  const listeners = {}
  class Core {
    constructor() {
      this.nodes = new Map([[nodeId, { nodeId, lastSeen: 0, online: true }]])
      this.tasks = new Map()
      this.logs = []
      this.audits = []
    }
    log(level, event, detail) { this.logs.push({ level, event, detail }) }
    send() {}
    on(name, fn) { (listeners[name] ??= []).push(fn); return () => {} }
    emit(name, payload) { for (const fn of listeners[name] ?? []) fn(payload) }
  }
  if (withAudit) Core.prototype.auditRecord = function auditRecord(event, fields) { this.audits.push({ event, fields }) }
  return new (withIngest(Core))()
}
const frame = (d) => ({ t: NODE_TO_HUB.BOT_TURN_RESULT, d })
const collect = (registry) => { const seen = []; registry.on('botTurnResult', (p) => seen.push(p)); return seen }

test('hub: a valid result is emitted and audited', () => {
  const registry = registryFor()
  const seen = collect(registry)
  registry.handleFrameFor(CONN, frame({ nodeId: CONN, remoteBotId: 'rb', exchangeId: 'ex1', seq: 3, text: 'hi' }))
  assert.equal(seen.length, 1)
  assert.notEqual(seen[0].ok, false)
  assert.equal(seen[0].text, 'hi')
  assert.equal(registry.audits.at(-1).event, 'ingest.turn-result')
  assert.equal(registry.audits.at(-1).fields.exchangeId, 'ex1')
})

test('hub: an invalid result that still names its exchange closes it with an explicit failure and is audited', () => {
  const registry = registryFor()
  const seen = collect(registry)
  // seq 缺失 → 校验不过；过去这里直接 return，页面回合悬到超时。
  registry.handleFrameFor(CONN, frame({ nodeId: CONN, remoteBotId: 'rb', exchangeId: 'ex2', text: 'hi' }))
  assert.equal(seen.length, 1, 'a failure result must reach the waiter')
  assert.equal(seen[0].ok, false)
  assert.equal(seen[0].exchangeId, 'ex2')
  assert.equal(seen[0].nodeId, CONN, 'failure is attributed to the authenticated connection')
  assert.equal(seen[0].error, 'ingest-rejected:invalid:bot-turn-result-seq-missing')
  const audit = registry.audits.find((row) => row.event === 'ingest.rejected')
  assert.equal(audit.fields.reason, 'invalid:bot-turn-result-seq-missing')
  assert.equal(audit.fields.exchangeId, 'ex2')
  assert.ok(registry.logs.some((row) => row.level === 'warn' && row.event === 'bot/turn-result rejected'))
})

test('hub: an invalid result with no exchange id is audited but nothing is emitted', () => {
  const registry = registryFor()
  const seen = collect(registry)
  registry.handleFrameFor(CONN, frame({ nodeId: CONN, text: 'x' }))
  assert.equal(seen.length, 0)
  assert.equal(registry.audits.find((row) => row.event === 'ingest.rejected').fields.exchangeId, '')
})

test('hub: a result claiming another node is audited and never turned into a failure for that node', () => {
  const registry = registryFor()
  const seen = collect(registry)
  registry.handleFrameFor(CONN, frame({ nodeId: 'node-b', remoteBotId: 'rb', exchangeId: 'ex3', seq: 0, text: 'forged' }))
  assert.equal(seen.length, 0, "a node must not be able to settle another node's turn, not even as a failure")
  const audit = registry.audits.find((row) => row.event === 'ingest.rejected')
  assert.equal(audit.fields.reason, 'node-mismatch')
  assert.equal(audit.fields.claimed, 'node-b')
})

test('hub: ingest works when the registry has no audit log at all', () => {
  const registry = registryFor(CONN, { withAudit: false })
  const seen = collect(registry)
  registry.handleFrameFor(CONN, frame({ nodeId: CONN, remoteBotId: 'rb', exchangeId: 'ex4', seq: 1, text: 'ok' }))
  registry.handleFrameFor(CONN, frame({ nodeId: CONN, exchangeId: 'ex5', text: 'bad' }))
  assert.equal(seen.length, 2)
})

/* ── 节点侧：结果帧发送失败要重试 ─────────────────────────────── */

const turn = { nodeId: CONN, remoteBotId: 'rb', exchangeId: 'exN', text: 'go' }
const ctxWith = (receiver) => ({ get: (name) => (name === 'remote-agent:bot-turn' ? receiver : undefined) })
const logger = () => { const rows = []; return { rows, info: (m, x) => rows.push(['info', m, x]), warn: (m, x) => rows.push(['warn', m, x]) } }

test('node: a result sent while the link is down is retried until it goes out, and logged', async () => {
  const calls = []
  const log = logger()
  // 前两次链路断着（false），第三次恢复。
  const send = (type, data) => { calls.push({ type, data }); return calls.length >= 3 }
  await handleBotTurnFrame({
    frame: { id: 'f1' }, data: turn, ctx: ctxWith(async () => ({ ok: true, text: 'done' })),
    send, sendError() {}, turnSeq: { next: () => 7 }, logger: log, retryDelaysMs: [0, 0, 0, 0],
  })
  assert.equal(calls.length, 3)
  assert.ok(calls.every((c) => c.type === NODE_TO_HUB.BOT_TURN_RESULT && c.data.exchangeId === 'exN' && c.data.seq === 7), 'same frame, same seq on every attempt')
  assert.equal(log.rows.filter((r) => r[0] === 'warn' && /will retry/.test(r[1])).length, 2)
  const sent = log.rows.find((r) => r[1] === 'bot/turn-result sent')
  assert.equal(sent[2].attempt, 2)
})

test('node: it gives up after the retry budget and says so', async () => {
  const log = logger()
  let n = 0
  await handleBotTurnFrame({
    frame: { id: 'f2' }, data: turn, ctx: ctxWith(async () => ({ ok: true, text: 'x' })),
    send: () => { n += 1; return false }, sendError() {}, turnSeq: { next: () => 1 }, logger: log, retryDelaysMs: [0, 0],
  })
  assert.equal(n, 3, 'first try + two retries')
  assert.ok(log.rows.some((r) => r[0] === 'warn' && /NOT delivered/.test(r[1])))
})

test('node: a collecting send that returns undefined is not retried', async () => {
  let n = 0
  await handleBotTurnFrame({
    frame: { id: 'f3' }, data: turn, ctx: ctxWith(async () => ({ ok: true, text: 'x' })),
    send: () => { n += 1 }, sendError() {}, turnSeq: { next: () => 1 }, retryDelaysMs: [0, 0, 0],
  })
  assert.equal(n, 1)
})

test('node: the no-receiver failure is retried the same way', async () => {
  let n = 0
  await handleBotTurnFrame({
    frame: { id: 'f4' }, data: turn, ctx: ctxWith(undefined),
    send: () => { n += 1; return n >= 2 }, sendError() {}, turnSeq: { next: () => 1 }, retryDelaysMs: [0, 0],
  })
  assert.equal(n, 2)
})
