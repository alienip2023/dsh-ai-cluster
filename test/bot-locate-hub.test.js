// bot/locate end to end: node identity book → roster identityId → hub fan-out → node signs →
// hub ingest → locateBot verifies. Hub is the real NodeRegistry, nodes are the real dispatcher.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { BOT_LOCATE_CAP, NODE_TO_HUB, PROTOCOL_VERSION, validateBotLocateResult } from '../lib/protocol.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { verifyLocateAnswer } from '../lib/hub/bot-locate.js'
import { createFrameDispatcher } from '../lib/node/dispatch.js'
import { createBotIdentityBook } from '../lib/node/bot-identities.js'
import { BotIdentity, createBotIdentity, ensureBotIdentityFor, loadBotIdentity } from '../lib/identity/bot-identity.js'
import { bindRosterReport, cleanRosterBots } from '../lib/roster-report.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), p))

/** A hub plus nodes; `behave[nodeId]` can replace a node's answer. */
function cluster(t, nodes) {
  const registry = new NodeRegistry({ log: () => {}, relay: { ready: true, send: () => true }, audit: { record: () => {} } })
  const dirs = []
  const sim = {}
  for (const { nodeId, caps = [BOT_LOCATE_CAP], online = true, bots = [], answer } of nodes) {
    const botsDir = tmp('locate-node-'); dirs.push(botsDir)
    const book = createBotIdentityBook({ homeNodeId: `machine-${nodeId}`, botsDir })
    const reported = book.decorate(bots)
    const toHub = (type, data) => { registry.handleFrameFor(nodeId, { v: PROTOCOL_VERSION, t: type, id: `f-${Math.random()}`, d: data }); return true }
    const ctx = { get: (name) => (name === 'dsh-ai-cluster:bot-identities' ? book.identities : undefined) }
    const stateDir = tmp('locate-state-'); dirs.push(stateDir)
    const dispatch = createFrameDispatcher({ ctx, send: toHub, sendError: () => {}, logger: {}, stateDir })
    registry.nodes.set(nodeId, { nodeId, online, lastSeen: 0, tasks: new Map(), pendingPulls: new Map(), hello: { nodeId, caps } })
    sim[nodeId] = { book, reported, dispatch, toHub, answer, received: [] }
  }
  registry.send = (nodeId, type, data) => {
    const node = sim[nodeId]
    node.received.push({ type, data })
    if (node.answer === 'never') return true
    if (node.answer === 'unsendable') return false
    if (typeof node.answer === 'function') { node.answer({ data, node, sim }); return true }
    node.dispatch({ t: type, d: data })
    return true
  }
  t.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
  return { registry, sim }
}

test('identity book: a reported Bot gets an identity once, keyed by its local id; files are owner-only', (t) => {
  const botsDir = tmp('book-'); t.after(() => rmSync(botsDir, { recursive: true, force: true }))
  const book = createBotIdentityBook({ homeNodeId: 'm1', botsDir })
  const [first] = book.decorate([{ id: 'ada', name: 'Ada', role: 'dev' }])
  assert.match(first.identityId, /^[0-9a-f]{16}$/)
  const [again] = book.decorate([{ id: 'ada', name: 'Ada', role: 'dev' }])
  assert.equal(again.identityId, first.identityId)
  assert.equal(book.identities.size, 1)
  const [shadow] = book.decorate([{ id: 'x', type: 'remote-worker' }])
  assert.equal(shadow.identityId, undefined)
  // A restart finds the same identity on disk.
  const reborn = createBotIdentityBook({ homeNodeId: 'm1', botsDir })
  assert.equal(reborn.load(), 1)
  assert.equal(reborn.decorate([{ id: 'ada' }])[0].identityId, first.identityId)
  const rec = loadBotIdentity(first.identityId, botsDir)
  assert.equal(rec.localBotId, 'ada')
  assert.equal(rec.homeNodeId, 'm1')
  if (process.platform !== 'win32') assert.equal(statSync(join(botsDir, rec.id, 'identity.json')).mode & 0o777, 0o600)
})

test('ensureBotIdentityFor recovers when the cache points at a deleted identity', (t) => {
  const botsDir = tmp('ensure-'); t.after(() => rmSync(botsDir, { recursive: true, force: true }))
  const cache = new Map([['ada', '0123456789abcdef']])
  const rec = ensureBotIdentityFor({ localBotId: 'ada', botsDir, cache })
  assert.notEqual(rec.id, '0123456789abcdef')
  assert.equal(cache.get('ada'), rec.id)
})

test('loadBotIdentity refuses a file whose id is not derived from its key', (t) => {
  const botsDir = tmp('forge-'); t.after(() => rmSync(botsDir, { recursive: true, force: true }))
  const a = createBotIdentity({ name: 'A', role: '', homeNodeId: '', botsDir })
  const b = createBotIdentity({ name: 'B', role: '', homeNodeId: '', botsDir })
  // Swap B's key into A's file: same directory name, wrong key.
  writeFileSync(join(botsDir, a.id, 'identity.json'), JSON.stringify({ ...a, publicKeyB64: b.publicKeyB64, privateKeyB64: b.privateKeyB64 }))
  assert.equal(loadBotIdentity(a.id, botsDir), undefined)
})

test('roster: identityId rides the frame; a bad one is dropped; decorateBots failures leave the list', () => {
  assert.deepEqual(cleanRosterBots([{ id: 'a', identityId: '0123456789abcdef' }, { id: 'b', identityId: 'NOPE' }]).map(b => b.identityId), ['0123456789abcdef', undefined])
  const frames = []
  const report = bindRosterReport(undefined, { send: (_t, f) => { frames.push(f); return true }, nodeId: 'n', hostname: 'h', decorateBots: bots => bots.map(b => ({ ...b, identityId: 'fedcba9876543210' })) })
  report({ bots: [{ id: 'a', name: 'A' }] })
  assert.equal(frames[0].bots[0].identityId, 'fedcba9876543210')
  const broken = bindRosterReport(undefined, { send: (_t, f) => { frames.push(f); return true }, nodeId: 'n', hostname: 'h', decorateBots: () => { throw new Error('disk') } })
  broken({ bots: [{ id: 'b', name: 'B' }] })
  assert.equal(frames[1].bots[0].id, 'b')
})

test('validateBotLocateResult: found needs proof; not found needs none', () => {
  assert.deepEqual(validateBotLocateResult({ requestId: 'r', botId: 'b', found: false }), { ok: true, result: { requestId: 'r', botId: 'b', found: false } })
  assert.equal(validateBotLocateResult({ requestId: 'r', botId: 'b', found: true }).error, 'bot-locate-result-proof-missing')
  assert.equal(validateBotLocateResult({ requestId: 'r', botId: 'b' }).error, 'bot-locate-result-found-missing')
  assert.equal(validateBotLocateResult({ botId: 'b', found: false }).error, 'bot-locate-result-requestId-missing')
})

test('locateBot finds the Bot on its node, proven by its key; others report not-here / unsupported / silent', async (t) => {
  const { registry, sim } = cluster(t, [
    { nodeId: 'n1', bots: [{ id: 'ada', name: 'Ada' }] },
    { nodeId: 'n2', bots: [{ id: 'bob', name: 'Bob' }] },
    { nodeId: 'old', caps: [] },
    { nodeId: 'slow', answer: 'never' },
    { nodeId: 'off', online: false, bots: [{ id: 'ada' }] },
  ])
  const adaId = sim.n1.reported[0].identityId
  const result = await registry.locateBot(adaId, { timeoutMs: 50 })
  assert.deepEqual(result.locations, [{ nodeId: 'n1', machineId: 'machine-n1' }])
  assert.deepEqual(result.notHere, ['n2'])
  assert.deepEqual(result.unsupported, ['old'])
  assert.deepEqual(result.silent, ['slow'])
  assert.deepEqual(result.rejected, [])
  // Each node got its own requestId.
  assert.notEqual(sim.n1.received[0].data.requestId, sim.n2.received[0].data.requestId)
  assert.equal(sim.off.received.length, 0)
  assert.equal(sim.old.received.length, 0)
})

test('locateBot settles at once when every asked node has answered', async (t) => {
  const { registry, sim } = cluster(t, [{ nodeId: 'n1', bots: [{ id: 'ada' }] }, { nodeId: 'n2' }])
  const started = Date.now()
  const result = await registry.locateBot(sim.n1.reported[0].identityId, { timeoutMs: 10_000 })
  assert.ok(Date.now() - started < 2_000)
  assert.equal(result.locations.length, 1)
})

test('a node claiming the Bot with its own key is rejected, not located', async (t) => {
  const forgerDir = tmp('forger-'); t.after(() => rmSync(forgerDir, { recursive: true, force: true }))
  const own = new BotIdentity(createBotIdentity({ name: 'X', role: '', homeNodeId: '', botsDir: forgerDir }))
  const { registry, sim } = cluster(t, [
    { nodeId: 'n1', bots: [{ id: 'ada' }] },
    { nodeId: 'evil', answer: ({ data, node }) => node.toHub(NODE_TO_HUB.BOT_LOCATE_RESULT, { requestId: data.requestId, botId: data.botId, found: true, pubKeyB64: own.publicKeyB64, sig: own.sign(data.requestId) }) },
  ])
  const result = await registry.locateBot(sim.n1.reported[0].identityId, { timeoutMs: 50 })
  assert.deepEqual(result.locations.map(l => l.nodeId), ['n1'])
  assert.deepEqual(result.rejected, [{ nodeId: 'evil', reason: 'key-does-not-match-bot' }])
})

test('a node replaying another node\'s signed answer is rejected; the real node still counts', async (t) => {
  const { registry, sim } = cluster(t, [{ nodeId: 'n1', bots: [{ id: 'ada' }] }, { nodeId: 'evil', answer: 'never' }])
  // n1's signed answer reaches the hub twice: replayed over evil's connection, then over n1's own.
  const stateDir = tmp('replay-state-'); t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const deliver = (from, d) => registry.handleFrameFor(from, { v: PROTOCOL_VERSION, t: NODE_TO_HUB.BOT_LOCATE_RESULT, id: `r-${from}`, d })
  sim.n1.dispatch = createFrameDispatcher({
    ctx: { get: () => sim.n1.book.identities },
    send: (_type, d) => { deliver('evil', d); deliver('n1', d); return true },
    sendError: () => {}, logger: {}, stateDir,
  })
  const result = await registry.locateBot(sim.n1.reported[0].identityId, { timeoutMs: 50 })
  assert.deepEqual(result.locations.map(l => l.nodeId), ['n1'])
  assert.deepEqual(result.rejected, [{ nodeId: 'evil', reason: 'wrong-node' }])
  assert.deepEqual(result.silent, ['evil'])
})

test('verifyLocateAnswer rejects a bad signature from the right key', (t) => {
  const dir = tmp('sig-'); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bot = new BotIdentity(createBotIdentity({ name: 'A', role: '', homeNodeId: '', botsDir: dir }))
  assert.deepEqual(verifyLocateAnswer({ botId: bot.id, requestId: 'r1', answer: { found: true, pubKeyB64: bot.publicKeyB64, sig: bot.sign('r2') } }), { rejected: 'bad-signature' })
  assert.deepEqual(verifyLocateAnswer({ botId: bot.id, requestId: 'r1', answer: { found: true, pubKeyB64: bot.publicKeyB64, sig: bot.sign('r1'), machineId: 'm' } }), { found: true, machineId: 'm' })
})

test('locateBot: bad id, no registry, unsendable node', async (t) => {
  const { registry } = cluster(t, [{ nodeId: 'n1', answer: 'unsendable' }])
  assert.equal((await registry.locateBot('not-an-id')).error, 'bad-bot-id')
  const r = await registry.locateBot('0123456789abcdef', { timeoutMs: 50 })
  assert.deepEqual(r.unsent, ['n1'])
  assert.deepEqual(r.silent, [])
})
