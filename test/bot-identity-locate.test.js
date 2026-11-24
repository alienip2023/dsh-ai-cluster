// Bot identity + bot/locate: the portable Bot keypair is found on disk, and a node
// answers bot/locate with a signature the hub can verify against the Bot's public key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BotIdentity, createBotIdentity, listBotIds, loadBotIdentity } from '../lib/identity/bot-identity.js'
import { botsRoot } from '../lib/persist/bots-root.js'
import { HUB_TO_NODE, NODE_TO_HUB, validateBotLocate } from '../lib/protocol.js'
import { createFrameDispatcher } from '../lib/node/dispatch.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'bot-id-'))

test('botsRoot honours DSH_BOTS_DIR, resolved per call', () => {
  const before = process.env.DSH_BOTS_DIR
  try {
    process.env.DSH_BOTS_DIR = '/tmp/some-override'
    assert.equal(botsRoot(), '/tmp/some-override')
    delete process.env.DSH_BOTS_DIR
    assert.match(botsRoot(), /\.dsh[\\/]bots$/)
  } finally {
    if (before === undefined) delete process.env.DSH_BOTS_DIR
    else process.env.DSH_BOTS_DIR = before
  }
})

test('npm test never points Bot state at the real home', () => {
  assert.ok(process.env.DSH_BOTS_DIR, 'test/_env.js must set DSH_BOTS_DIR')
  assert.ok(botsRoot().startsWith(tmpdir()) || botsRoot().includes('dsh-bots-test-'))
})

test('createBotIdentity → loadBotIdentity round-trips; listBotIds finds it', () => {
  const dir = tempDir()
  try {
    const rec = createBotIdentity({ name: 'Ada', role: 'dev', homeNodeId: 'm1', botsDir: dir })
    assert.match(rec.id, /^[0-9a-f]{16}$/)
    assert.deepEqual(loadBotIdentity(rec.id, dir), rec)
    // A directory without identity.json (e.g. a journal-only dir) is not a Bot.
    mkdirSync(join(dir, 'journal-only'))
    writeFileSync(join(dir, 'journal-only', 'journal.jsonl'), '')
    assert.deepEqual(listBotIds(dir), [rec.id])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('listBotIds on a missing dir is empty, not a throw', () => {
  assert.deepEqual(listBotIds(join(tmpdir(), 'definitely-missing-' + Date.now())), [])
})

test('loadBotIdentity rejects a file whose id does not match its directory', () => {
  const dir = tempDir()
  try {
    const rec = createBotIdentity({ name: 'A', role: 'r', homeNodeId: 'm', botsDir: dir })
    mkdirSync(join(dir, 'impostor'))
    writeFileSync(join(dir, 'impostor', 'identity.json'), JSON.stringify(rec))
    assert.equal(loadBotIdentity('impostor', dir), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('BotIdentity signs; verify accepts its own key and rejects tampering', () => {
  const dir = tempDir()
  try {
    const bot = new BotIdentity(createBotIdentity({ name: 'A', role: 'r', homeNodeId: 'm', botsDir: dir }))
    const sig = bot.sign('req-1')
    assert.equal(BotIdentity.verify(bot.publicKeyB64, 'req-1', sig), true)
    assert.equal(BotIdentity.verify(bot.publicKeyB64, 'req-2', sig), false)
    assert.equal(BotIdentity.verify(bot.publicKeyB64, 'req-1', 'not-a-sig'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('validateBotLocate requires botId and requestId', () => {
  assert.deepEqual(validateBotLocate({ botId: ' b ', requestId: 'r' }), { ok: true, locate: { botId: 'b', requestId: 'r' } })
  assert.equal(validateBotLocate(null).error, 'bot-locate-missing')
  assert.equal(validateBotLocate({ requestId: 'r' }).error, 'bot-locate-botId-missing')
  assert.equal(validateBotLocate({ botId: 'b' }).error, 'bot-locate-requestId-missing')
})

function dispatcherWith(identities) {
  const sent = []
  const ctx = { get: (name) => (name === 'dsh-ai-cluster:bot-identities' ? identities : undefined) }
  const stateDir = tempDir()
  const dispatch = createFrameDispatcher({ ctx, send: (t, d) => { sent.push({ t, d }); return true }, sendError: () => {}, logger: {}, stateDir })
  return { dispatch, sent, stateDir }
}

test('bot/locate for a Bot on this node → found:true with a verifiable signature', () => {
  const dir = tempDir()
  const bot = new BotIdentity(createBotIdentity({ name: 'A', role: 'r', homeNodeId: 'machine-9', botsDir: dir }))
  const { dispatch, sent, stateDir } = dispatcherWith(new Map([[bot.id, bot]]))
  try {
    assert.equal(dispatch({ t: HUB_TO_NODE.BOT_LOCATE, d: { botId: bot.id, requestId: 'req-42', nodeId: 'n1' } }), true)
    assert.equal(sent.length, 1)
    const { t, d } = sent[0]
    assert.equal(t, NODE_TO_HUB.BOT_LOCATE_RESULT)
    assert.equal(d.found, true)
    assert.equal(d.requestId, 'req-42')
    assert.equal(d.machineId, 'machine-9')
    assert.equal(BotIdentity.verify(d.pubKeyB64, 'req-42', d.sig), true)
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }) }
})

test('bot/locate for an unknown Bot → found:false, no signature', () => {
  const { dispatch, sent, stateDir } = dispatcherWith(new Map())
  try {
    dispatch({ t: HUB_TO_NODE.BOT_LOCATE, d: { botId: 'nope', requestId: 'r1' } })
    assert.deepEqual(sent.map(s => [s.t, s.d.found, 'sig' in s.d]), [[NODE_TO_HUB.BOT_LOCATE_RESULT, false, false]])
  } finally { rmSync(stateDir, { recursive: true, force: true }) }
})

test('bot/locate with no identity service registered → found:false (old node / scan failed)', () => {
  const { dispatch, sent, stateDir } = dispatcherWith(undefined)
  try {
    dispatch({ t: HUB_TO_NODE.BOT_LOCATE, d: { botId: 'b', requestId: 'r1' } })
    assert.equal(sent[0].d.found, false)
  } finally { rmSync(stateDir, { recursive: true, force: true }) }
})

test('invalid bot/locate is dropped without a reply', () => {
  const { dispatch, sent, stateDir } = dispatcherWith(new Map())
  try {
    assert.equal(dispatch({ t: HUB_TO_NODE.BOT_LOCATE, d: { requestId: 'r1' } }), true)
    assert.equal(sent.length, 0)
  } finally { rmSync(stateDir, { recursive: true, force: true }) }
})
