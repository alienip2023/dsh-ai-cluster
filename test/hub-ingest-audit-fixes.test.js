/**
 * Hub ingest hardening (audit findings), through the live lib/hub path:
 *   1. a plaintext content frame is refused once an e2e session exists (audit + error frame);
 *   5. the 'roster' event and the stored roster are the same cleaned list;
 *   6. a bot/*-result that fails validation is never silent and settles its requester at once;
 *   9. stop/delete results carry the authenticated nodeId; peerReplyTo is only honoured for registered origins.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ERROR_CODE, HUB_TO_NODE, MEMORY, NODE_TO_HUB, PROTOCOL_VERSION,
} from '../lib/protocol.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { createSession, generateEphemeral } from '../lib/e2e.js'
import { ROSTER_CAP } from '../lib/roster-report.js'

function sessionPair() {
  const n = generateEphemeral()
  const h = generateEphemeral()
  return {
    node: createSession({ role: 'node', ownPrivB64: n.privateKeyB64, peerPubB64: h.publicKeyB64, nodePubB64: n.publicKeyB64, hubPubB64: h.publicKeyB64 }),
    hub: createSession({ role: 'hub', ownPrivB64: h.privateKeyB64, peerPubB64: n.publicKeyB64, nodePubB64: n.publicKeyB64, hubPubB64: h.publicKeyB64 }),
  }
}

function setup({ e2e = false } = {}) {
  const logs = []
  const audits = []
  const sent = []
  const registry = new NodeRegistry({
    log: (level, msg, extra) => logs.push({ level, msg, extra }),
    relay: { ready: true, send: () => true },
    audit: { record: (event, fields) => audits.push({ event, fields }) },
  })
  registry.send = (nodeId, type, data) => { sent.push({ nodeId, type, data }); return true }
  const pair = sessionPair()
  const rec = { nodeId: 'n1', online: true, lastSeen: 0, tasks: new Map(), pendingPulls: new Map(), hello: { nodeId: 'n1' } }
  if (e2e) rec.e2e = pair.hub
  registry.nodes.set('n1', rec)
  const seal = (t, d, id = `m-${t}`) => ({ v: PROTOCOL_VERSION, t, id, d: pair.node.sealFrame(t, id, d) })
  return { registry, rec, logs, audits, sent, seal, pair }
}

/* ───────────────────── 1. uplink E2E gate ───────────────────── */

const CONTENT_FRAMES = [
  [NODE_TO_HUB.ROSTER, { nodeId: 'n1', hostname: 'h', bots: [{ id: 'b1', name: 'B', role: 'r' }] }],
  [NODE_TO_HUB.BOT_TURN_RESULT, { nodeId: 'n1', remoteBotId: 'b', exchangeId: 'x1', text: 'secret answer', seq: 0 }],
  [NODE_TO_HUB.BOT_CREATE_RESULT, { requestId: 'r1', ok: true, remoteBotId: 'b' }],
  [NODE_TO_HUB.BOT_ACTION_RESULT, { requestId: 'r1', ok: true }],
  [NODE_TO_HUB.TASK_END, { taskId: 't1', status: 'completed' }],
  [NODE_TO_HUB.FS_RES, { replyTo: 'q', ok: true, result: { data: 'file body' } }],
  [NODE_TO_HUB.APPROVAL_REQUEST, { approvalId: 'a', nodeId: 'n1', botId: 'b', tool: 't', reason: 'r', detail: {}, at: 1, fingerprint: 'f' }],
  [NODE_TO_HUB.MODEL_SYNC_RESULT, { requestId: 'r', nodeId: 'n1', ok: true, applied: [] }],
  [MEMORY.READ, { requestId: 'r', remoteBotId: 'b', scope: 'bot', query: 'q', nodeId: 'n1' }],
]

test('GATE-1: with an e2e session a plaintext content frame is dropped, audited and answered with e2e-required', () => {
  for (const [type, d] of CONTENT_FRAMES) {
    const w = setup({ e2e: true })
    const events = []
    for (const name of ['roster', 'botTurnResult', 'botCreateResult', 'botActionResult', 'taskEnd', 'approvalRequest', 'memoryRead']) w.registry.on(name, () => events.push(name))
    w.registry.handleFrameFor('n1', { v: PROTOCOL_VERSION, t: type, id: 'm1', d })
    assert.deepEqual(events, [], `${type}: plaintext must not reach any listener`)
    assert.equal(w.rec.tasks.size, 0, `${type}: no task state`)
    assert.equal(w.rec.roster, undefined, `${type}: no roster state`)
    const audit = w.audits.find((a) => a.event === 'ingest.rejected')
    assert.ok(audit, `${type}: audited`)
    assert.deepEqual(audit.fields, { nodeId: 'n1', type, reason: ERROR_CODE.E2E_REQUIRED })
    const reply = w.sent.find((s) => s.type === HUB_TO_NODE.ERROR)
    assert.equal(reply?.nodeId, 'n1', `${type}: error frame to the node`)
    assert.equal(reply.data.code, ERROR_CODE.E2E_REQUIRED)
    assert.ok(w.logs.some((l) => l.level === 'warn' && /plaintext uplink/.test(l.msg)))
  }
})

test('GATE-2: the same frames sealed with the session are handled normally', () => {
  const w = setup({ e2e: true })
  const results = []
  w.registry.on('botTurnResult', (r) => results.push(r))
  w.registry.handleFrameFor('n1', w.seal(NODE_TO_HUB.BOT_TURN_RESULT, CONTENT_FRAMES[1][1]))
  assert.equal(results.length, 1)
  assert.equal(results[0].text, 'secret answer')
  assert.equal(w.audits.filter((a) => a.event === 'ingest.rejected').length, 0)
})

test('GATE-3: hello, pong, error, the e2e offer and config-sync-request stay plaintext even with a session', () => {
  const w = setup({ e2e: true })
  const sync = []
  w.registry.on('configSyncRequest', (e) => sync.push(e))
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.PONG, d: {} })
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.ERROR, d: { code: 'x' } })
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.CONFIG_SYNC_REQUEST, d: { appliedRevision: 3 } })
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.E2E_OFFER, d: {} })
  assert.equal(sync.length, 1)
  assert.equal(w.audits.filter((a) => a.event === 'ingest.rejected').length, 0)
  assert.equal(w.sent.filter((s) => s.data?.code === ERROR_CODE.E2E_REQUIRED).length, 0)
})

test('GATE-4: no session yet (old node, e2e off, handshake pending) -> plaintext is accepted', () => {
  const w = setup({ e2e: false })
  const results = []
  w.registry.on('botTurnResult', (r) => results.push(r))
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.BOT_TURN_RESULT, d: CONTENT_FRAMES[1][1] })
  assert.equal(results.length, 1)
  assert.equal(w.audits.some((a) => a.event === 'ingest.rejected'), false)
})

test('GATE-5: a session left over from the previous connection does not gate the new link until it re-keys', () => {
  const w = setup({ e2e: true })
  w.rec.e2eStale = true // set by ingestHello when a known node connects again
  const results = []
  w.registry.on('botTurnResult', (r) => results.push(r))
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.BOT_TURN_RESULT, d: CONTENT_FRAMES[1][1] })
  assert.equal(results.length, 1)
})

test('GATE-6: frames from the authenticated peer link are not gated by the hub session', () => {
  const w = setup({ e2e: true })
  const results = []
  w.registry.on('botTurnResult', (r) => results.push(r))
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.BOT_TURN_RESULT, d: CONTENT_FRAMES[1][1] }, { peer: true })
  assert.equal(results.length, 1)
})

/* ───────────────────── 5. cleaned roster ───────────────────── */

test('ROSTER-1: the roster event carries the same cleaned list as the stored roster, and says what was cleaned', () => {
  const w = setup()
  const events = []
  w.registry.on('roster', (r) => events.push(r))
  const long = 'x'.repeat(100)
  const raw = [
    { id: 'b1', name: long, role: 'dev', model: 'p/m', clusterBotId: 'cb-1', tasks: [], cards: [], internalToken: 'secret', home: '/Users/x' },
    { id: 'b2', name: 'Two', role: 'ops', type: 'remote-worker' }, // shadow of a hub Bot: skipped
    { name: 'no id' },
    ...Array.from({ length: ROSTER_CAP + 5 }, (_, i) => ({ id: `extra${i}`, name: 'e', role: 'r' })),
  ]
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.ROSTER, d: { nodeId: 'n1', hostname: 'host', bots: raw } })
  assert.equal(events.length, 1)
  assert.deepEqual(events[0].bots, w.rec.roster.bots, 'event and store agree')
  assert.equal(events[0].bots.length, ROSTER_CAP, 'cap applied to the event too')
  assert.equal(events[0].bots[0].name.length, 40, 'truncation applied to the event too')
  assert.equal(JSON.stringify(events[0]).includes('secret'), false)
  const warn = w.logs.find((l) => l.msg === 'roster entries were cleaned')
  assert.ok(warn, 'a warn says entries were cleaned')
  assert.deepEqual(warn.extra.droppedKeys, ['home', 'internalToken'])
  assert.ok(warn.extra.skippedEntries >= 7)

  // the same report again inside the minute: no second warn (ds-bot republishes every 5 s)
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.ROSTER, d: { nodeId: 'n1', hostname: 'host', bots: raw } })
  assert.equal(w.logs.filter((l) => l.msg === 'roster entries were cleaned').length, 1)
})

test('ROSTER-2: everything ds-bot applies (id,name,role,model,clusterBotId,tasks,cards) survives cleaning', () => {
  const w = setup()
  const events = []
  w.registry.on('roster', (r) => events.push(r))
  const bot = {
    id: 'b1', name: 'Name', role: 'role', model: 'prov/model', clusterBotId: 'cb-1',
    tasks: [{ id: 't1', title: 'T', status: 'running', startedAt: 5 }],
    cards: [{ id: 'c1', kind: 'approval', title: 'ti', body: 'bo', options: [{ id: 'o', label: 'L' }], input: true, at: 3 }],
  }
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.ROSTER, d: { nodeId: 'n1', hostname: 'host', bots: [bot] } })
  assert.deepEqual(events[0].bots, [bot])
  assert.equal(w.logs.some((l) => l.msg === 'roster entries were cleaned'), false, 'nothing dropped, nothing warned')
})

test('ROSTER-3: a trimmed frame is announced, not silent', () => {
  const w = setup()
  const events = []
  w.registry.on('roster', (r) => events.push(r))
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.ROSTER, d: { nodeId: 'n1', hostname: 'h', bots: [{ id: 'b', name: 'B', role: 'r' }], trimmed: ['card-bodies'] } })
  assert.deepEqual(events[0].trimmed, ['card-bodies'])
  assert.ok(w.logs.some((l) => l.level === 'warn' && /trimmed/.test(l.msg)))
})

/* ───────────────────── 6. results that fail validation ───────────────────── */

const RESULTS = [
  [NODE_TO_HUB.BOT_CREATE_RESULT, 'botCreateResult', { requestId: 'rq-1' }],
  [NODE_TO_HUB.BOT_UPDATE_RESULT, 'botUpdateResult', { requestId: 'rq-1' }],
  [NODE_TO_HUB.BOT_DELETE_RESULT, 'botDeleteResult', { requestId: 'rq-1' }],
  [NODE_TO_HUB.BOT_STOP_RESULT, 'botStopResult', { requestId: 'rq-1' }],
  [NODE_TO_HUB.BOT_ACTION_RESULT, 'botActionResult', { requestId: 'rq-1' }],
]

test('RESULT-1: an invalid result is a warn + audit record and settles a parseable requestId with ok:false', () => {
  for (const [type, eventName, d] of RESULTS) {
    const w = setup()
    const events = []
    w.registry.on(eventName, (e) => events.push(e))
    w.registry.handleFrameFor('n1', { t: type, d })
    assert.equal(events.length, 1, `${type}: requester settled at once`)
    assert.equal(events[0].requestId, 'rq-1')
    assert.equal(events[0].ok, false)
    assert.equal(events[0].nodeId, 'n1')
    assert.match(events[0].error, /^ingest-rejected:/)
    const audit = w.audits.find((a) => a.event === 'ingest.rejected')
    assert.equal(audit.fields.nodeId, 'n1')
    assert.equal(audit.fields.type, type)
    assert.match(audit.fields.error, /requestId|ok-missing|remoteBotId/)
    assert.ok(w.logs.some((l) => l.level === 'warn' && l.msg.includes(type)), `${type}: warn`)
  }
})

test('RESULT-2: no parseable requestId -> still warn + audit, no event to settle', () => {
  for (const [type, eventName] of [...RESULTS, [NODE_TO_HUB.BOT_HISTORY_RESULT, 'botHistoryResult']]) {
    const w = setup()
    const events = []
    w.registry.on(eventName, (e) => events.push(e))
    w.registry.handleFrameFor('n1', { t: type, d: { ok: true } })
    assert.equal(events.length, 0)
    assert.ok(w.audits.some((a) => a.event === 'ingest.rejected' && a.fields.type === type))
    assert.ok(w.logs.some((l) => l.level === 'warn' && l.msg.includes(type)))
  }
})

test('RESULT-3: a rejected stop result keeps the stop shape (stopped:false)', () => {
  const w = setup()
  const events = []
  w.registry.on('botStopResult', (e) => events.push(e))
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.BOT_STOP_RESULT, d: { requestId: 'rq-9' } })
  assert.equal(events[0].stopped, false)
})

/* ───────────────────── 9. identity ───────────────────── */

test('IDENT-1: stop and delete results carry the authenticated nodeId; a claimed one is not trusted', () => {
  const w = setup()
  const stop = []
  const del = []
  w.registry.on('botStopResult', (e) => stop.push(e))
  w.registry.on('botDeleteResult', (e) => del.push(e))
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.BOT_STOP_RESULT, d: { requestId: 'a', ok: true, stopped: true, nodeId: 'victim' } })
  w.registry.handleFrameFor('n1', { t: NODE_TO_HUB.BOT_DELETE_RESULT, d: { requestId: 'b', ok: true, nodeId: 'victim' } })
  assert.equal(stop[0].nodeId, 'n1')
  assert.equal(del[0].nodeId, 'n1')
})

function peerSetup() {
  const w = setup()
  for (const id of ['a', 'b', 'victim']) {
    w.registry.nodes.set(id, { nodeId: id, online: true, lastSeen: 0, tasks: new Map(), pendingPulls: new Map(), hello: { nodeId: id, peerUrl: `wss://${id}.example/api/remote-agent/peer` } })
  }
  // 'a' originated the turn that 'b' executes; the hub registered it when it routed the turn
  w.registry.peerTurnOrigins = new Map([[JSON.stringify(['b', 'ex1']), { nodeId: 'a', at: Date.now() }]])
  const local = []
  w.registry.on('botTurnResult', (r) => local.push(r))
  const result = (extra = {}) => ({ nodeId: 'b', remoteBotId: 'bot', exchangeId: 'ex1', text: 'answer', seq: 0, ...extra })
  return { ...w, local, result }
}

test('IDENT-2: peerReplyTo naming an unregistered node is ignored; the result goes to the registered origin', () => {
  const w = peerSetup()
  w.registry.handleFrameFor('b', { t: NODE_TO_HUB.BOT_TURN_RESULT, d: w.result({ peerReplyTo: 'victim' }) })
  const forwards = w.sent.filter((s) => s.type === NODE_TO_HUB.BOT_TURN_RESULT)
  assert.deepEqual(forwards.map((f) => f.nodeId), ['a'], 'forwarded to the registered origin only')
  assert.equal(w.sent.some((s) => s.nodeId === 'victim'), false)
  assert.ok(w.audits.some((a) => a.event === 'ingest.rejected' && a.fields.error === 'peer-reply-to-unregistered' && a.fields.claimed === 'victim'))
})

test('IDENT-3: with no registered origin a peerReplyTo is not a route at all; the result is delivered locally', () => {
  const w = peerSetup()
  w.registry.peerTurnOrigins.clear()
  w.registry.handleFrameFor('b', { t: NODE_TO_HUB.BOT_TURN_RESULT, d: w.result({ peerReplyTo: 'victim' }) })
  assert.equal(w.sent.some((s) => s.type === NODE_TO_HUB.BOT_TURN_RESULT), false)
  assert.equal(w.local.length, 1)
})

test('IDENT-4: a peerReplyTo that matches the registered origin works as before', () => {
  const w = peerSetup()
  w.registry.handleFrameFor('b', { t: NODE_TO_HUB.BOT_TURN_RESULT, d: w.result({ peerReplyTo: 'a' }) })
  assert.deepEqual(w.sent.filter((s) => s.type === NODE_TO_HUB.BOT_TURN_RESULT).map((f) => f.nodeId), ['a'])
  assert.equal(w.audits.some((a) => a.event === 'ingest.rejected'), false)
})

/* ───────────────────── 11. node.offline audit ───────────────────── */

test('AUDIT-1: node.offline counts the node running bot turns, not its tasks', () => {
  const w = setup()
  w.rec.tasks.set('t1', { taskId: 't1' })
  w.rec.tasks.set('t2', { taskId: 't2' })
  w.registry.botTurns.set('e1', { nodeId: 'n1', state: 'running', at: Date.now() })
  w.registry.botTurns.set('e2', { nodeId: 'n1', state: 'running', at: Date.now() })
  w.registry.botTurns.set('e3', { nodeId: 'n1', state: 'done', at: Date.now() })
  w.registry.botTurns.set('e4', { nodeId: 'other', state: 'running', at: Date.now() })
  w.registry.markOffline('n1', 'test')
  const audit = w.audits.find((a) => a.event === 'node.offline')
  assert.equal(audit.fields.inFlightTurns, 2)
})
