// bot/attach (capability bot-attach/1): the hub puts the images and files of a message to a node Bot on the link
// as base64 chunks, then sends the bot/turn that names them in its `attachments` manifest. Everything here runs the
// real AC functions: both validators, both dispatchers, the real handler, the real E2E session and the real transport.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as lib from '../lib/protocol.js'
import * as wire from '../src/wire/index.js'
import * as srcNodeCaps from '../src/caps/node-caps.js'
import * as live from '../lib/node/transport.js'
import { NodeTransport } from '../lib/node/transport.js'
import * as wireFraming from '../src/wire/session-framing.js'
import * as linkTransport from '../src/link/transport.js'
import { createFrameDispatcher } from '../lib/node/dispatch.js'
import { createFrameDispatcher as createSrcDispatcher } from '../src/task-run/dispatch.js'
import { handleBotAttachFrame, BOT_ATTACH_RECEIVER } from '../lib/bot-attach.js'
import { handleBotTurnFrame } from '../lib/bot-turn.js'
import { createSession, generateEphemeral } from '../lib/e2e.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { applyWorker } from '../lib/node/index.js'
import { generateIdentity } from '../lib/identity.js'
import { startListenServer } from '../lib/listen-server.js'

const { HUB_TO_NODE, NODE_TO_HUB, BOT_ATTACH_LIMITS } = lib
const ids = { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex-1' }
const chunk = (over = {}) => ({ ...ids, index: 0, chunk: 0, chunks: 1, data: 'aGVsbG8=', ...over })
const sha = (text) => createHash('sha256').update(text).digest('hex')
const entry = (over = {}) => ({ index: 0, name: 'cat.png', kind: 'image', mediaType: 'image/png', bytes: 5, sha256: sha('hello'), chunks: 1, ...over })
const turn = (over = {}) => ({ ...ids, text: 'look', ...over })
const impls = { lib, wire }

// ── the frame type and the limits ───────────────────────────────────────────────────────────────

test('the frame type, the limits and the capability are the same in lib and in the plugin wire source', () => {
  assert.equal(HUB_TO_NODE.BOT_ATTACH, 'bot/attach')
  assert.equal(wire.HUB_TO_NODE.BOT_ATTACH, 'bot/attach')
  assert.deepEqual({ ...BOT_ATTACH_LIMITS }, {
    maxAttachments: 8, maxChunks: 40, maxChunkChars: 1_100_000, maxNameChars: 200, maxMediaTypeChars: 64, maxBytes: 20 * 1024 * 1024,
  })
  assert.deepEqual({ ...wire.BOT_ATTACH_LIMITS }, { ...BOT_ATTACH_LIMITS })
  assert.equal(lib.BOT_ATTACH_CAP, 'bot-attach/1')
  assert.equal(srcNodeCaps.BOT_ATTACH_CAP, 'bot-attach/1')
  assert.equal(String(lib.validateBotAttach), String(wire.validateBotAttach))
})

test('capability: the node says bot-attach/1 in its hello from both module graphs; the hub welcome does not carry it', () => {
  assert.ok(lib.nodeCaps([]).includes('bot-attach/1'))
  assert.ok(srcNodeCaps.nodeCaps([]).includes('bot-attach/1'))
  assert.deepEqual(srcNodeCaps.nodeCaps(['fs'], 'linux'), lib.nodeCaps(['fs'], 'linux'))
  assert.equal(lib.HUB_CAPS.includes('bot-attach/1'), false, 'a node-side receiver capability, like bot-action/1')
})

// ── bot/attach validator ────────────────────────────────────────────────────────────────────────

for (const [name, impl] of Object.entries(impls)) {
  test(`validateBotAttach (${name}): a good chunk keeps exactly the contract fields, ids trimmed`, () => {
    const checked = impl.validateBotAttach({ ...chunk({ nodeId: ' n1 ', index: 7, chunk: 39, chunks: 40 }), evil: 1, id: 'x' })
    assert.deepEqual(checked, { ok: true, attach: { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex-1', index: 7, chunk: 39, chunks: 40, data: 'aGVsbG8=' } })
  })

  test(`validateBotAttach (${name}): rejections carry bot-attach-* names`, () => {
    const err = (d) => impl.validateBotAttach(d).error
    assert.equal(err(undefined), 'bot-attach-missing')
    assert.equal(err([]), 'bot-attach-missing')
    assert.equal(err(chunk({ nodeId: ' ' })), 'bot-attach-nodeId-missing')
    assert.equal(err(chunk({ remoteBotId: undefined })), 'bot-attach-remoteBotId-missing')
    assert.equal(err(chunk({ exchangeId: 5 })), 'bot-attach-exchangeId-missing')
    for (const index of [-1, 8, 1.5, '1', null, undefined, NaN]) assert.equal(err(chunk({ index })), 'bot-attach-index-invalid', `index ${String(index)}`)
    for (const chunks of [0, 41, 2.5, '2', undefined]) assert.equal(err(chunk({ chunks })), 'bot-attach-chunks-invalid', `chunks ${String(chunks)}`)
    for (const bad of [-1, 2, 1.5, '0', undefined]) assert.equal(err(chunk({ chunks: 2, chunk: bad })), 'bot-attach-chunk-invalid', `chunk ${String(bad)}`)
    assert.equal(err(chunk({ chunks: 1, chunk: 1 })), 'bot-attach-chunk-invalid', 'chunk must be below chunks')
    assert.equal(err(chunk({ data: '' })), 'bot-attach-data-missing')
    assert.equal(err(chunk({ data: 12 })), 'bot-attach-data-missing')
    assert.equal(err(chunk({ data: 'A'.repeat(1_100_001) })), 'bot-attach-data-too-large')
    for (const data of ['not base64!', 'aGVs bG8=', 'aGVsbG8=\n', 'a=b', '=aGVs', 'aGVs===', 'aGVsbG8-', 'aGVsbG8_']) assert.equal(err(chunk({ data })), 'bot-attach-data-invalid', JSON.stringify(data))
  })

  test(`validateBotAttach (${name}): edges that are allowed`, () => {
    assert.equal(impl.validateBotAttach(chunk({ data: 'A'.repeat(1_100_000) })).ok, true, 'the largest chunk')
    assert.equal(impl.validateBotAttach(chunk({ data: 'AAAA' })).ok, true)
    for (const data of ['QQ==', 'QUI=', 'QUJD', 'a+/z']) assert.equal(impl.validateBotAttach(chunk({ data })).ok, true, data)
    assert.equal(impl.validateBotAttach(chunk({ index: 0, chunk: 0, chunks: 40 })).ok, true)
  })
}

// ── bot/turn attachments manifest ───────────────────────────────────────────────────────────────

for (const [name, impl] of Object.entries(impls)) {
  test(`validateBotTurn (${name}): a good manifest comes out whole, trimmed, with unknown fields dropped`, () => {
    const checked = impl.validateBotTurn(turn({
      attachments: [entry({ name: '  cat.png  ', evil: 1 }), entry({ index: 7, name: 'a.pdf', kind: 'file', mediaType: undefined, bytes: 20 * 1024 * 1024, chunks: 40 })],
    }))
    assert.equal(checked.ok, true)
    assert.deepEqual(checked.turn.attachments, [
      { index: 0, name: 'cat.png', kind: 'image', mediaType: 'image/png', bytes: 5, sha256: sha('hello'), chunks: 1 },
      { index: 7, name: 'a.pdf', kind: 'file', bytes: 20971520, sha256: sha('hello'), chunks: 40 },
    ])
    assert.equal(Object.hasOwn(checked.turn.attachments[1], 'mediaType'), false)
    // the existing fields are untouched by the new one
    assert.deepEqual(Object.keys(checked.turn).sort(), ['attachments', 'exchangeId', 'nodeId', 'remoteBotId', 'text'])
  })

  test(`validateBotTurn (${name}): no attachments (absent, null, empty) leaves the turn exactly as before`, () => {
    const before = { ok: true, turn: { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex-1', text: 'look' } }
    assert.deepEqual(impl.validateBotTurn(turn()), before)
    assert.deepEqual(impl.validateBotTurn(turn({ attachments: [] })), before)
    assert.deepEqual(impl.validateBotTurn(turn({ attachments: null })), before)
    assert.equal(Object.hasOwn(impl.validateBotTurn(turn({ attachments: [] })).turn, 'attachments'), false)
  })

  test(`validateBotTurn (${name}): a bad manifest rejects the whole turn, never drops an entry`, () => {
    const bad = (attachments) => impl.validateBotTurn(turn({ attachments }))
    const rejected = (attachments, label) => assert.deepEqual(bad(attachments), { ok: false, error: 'bot-turn-attachments-invalid' }, label)
    rejected('x', 'not an array')
    rejected({}, 'an object')
    rejected(Array.from({ length: 9 }, (_, i) => entry({ index: i % 8 })), 'more than 8')
    rejected([entry(), null], 'a null entry beside a good one')
    rejected([entry(), 'x'], 'a string entry')
    rejected([entry(), entry()], 'the same index twice')
    for (const index of [-1, 8, 1.5, '0', undefined]) rejected([entry({ index })], `index ${String(index)}`)
    for (const name of ['', '   ', 'x'.repeat(201), 5, undefined]) rejected([entry({ name })], `name ${JSON.stringify(name)}`)
    assert.equal(bad([entry({ name: ` ${'x'.repeat(200)} ` })]).ok, true, 'the limit applies to the trimmed name')
    for (const kind of ['video', 'Image', '', undefined]) rejected([entry({ kind })], `kind ${String(kind)}`)
    rejected([entry({ mediaType: 5 })], 'mediaType not a string')
    rejected([entry({ mediaType: 'x'.repeat(65) })], 'mediaType too long')
    assert.equal(bad([entry({ mediaType: 'x'.repeat(64) })]).ok, true)
    for (const bytes of [0, -1, 20971521, 1.5, '5', undefined]) rejected([entry({ bytes })], `bytes ${String(bytes)}`)
    for (const sha256 of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), undefined, 5]) rejected([entry({ sha256 })], `sha256 ${String(sha256)}`)
    for (const chunks of [0, 41, 1.5, '1', undefined]) rejected([entry({ chunks })], `chunks ${String(chunks)}`)
  })
}

// ── the handler ─────────────────────────────────────────────────────────────────────────────────

function ctxWith(receiver) { return { get: (name) => (name === BOT_ATTACH_RECEIVER ? receiver : undefined) } }
const logger = () => { const lines = []; return { lines, warn: (m, x) => lines.push([m, x]), info() {}, debug() {}, error() {} } }

test('the receiver name is the one ds-bot provides', () => assert.equal(BOT_ATTACH_RECEIVER, 'remote-agent:bot-attach'))

test('handleBotAttachFrame calls the receiver in the same tick with exactly the contract fields, and sends no result frame', () => {
  const calls = []
  const sent = []
  const result = handleBotAttachFrame({
    frame: { id: 'f1' }, data: { ...chunk({ index: 2, chunk: 1, chunks: 3, data: 'QUJD' }), evil: 1 },
    ctx: ctxWith((arg) => { calls.push(arg) }), send: (...a) => sent.push(a), sendError: () => assert.fail('no error expected'),
  })
  assert.deepEqual(calls, [{ remoteBotId: 'b1', exchangeId: 'ex-1', index: 2, chunk: 1, chunks: 3, data: 'QUJD' }], 'already called when the function returns')
  assert.deepEqual(sent, [])
  assert.deepEqual(result, { accepted: true })
})

test('handleBotAttachFrame: an invalid frame answers with an error frame and never reaches the receiver', () => {
  const calls = []
  const errors = []
  const result = handleBotAttachFrame({ frame: { id: 'f9' }, data: chunk({ index: 9 }), ctx: ctxWith((a) => calls.push(a)), send: () => {}, sendError: (...a) => errors.push(a) })
  assert.deepEqual(calls, [])
  assert.equal(errors.length, 1)
  assert.equal(errors[0][0], 'f9')
  assert.equal(errors[0][1], 'bot-attach-index-invalid')
  assert.deepEqual(result, { accepted: false, error: 'bot-attach-index-invalid' })
})

test('handleBotAttachFrame: no receiver, a throwing receiver and a rejecting receiver never throw and leave no unhandled rejection', async () => {
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const log = logger()
    const base = { frame: { id: 'f1' }, data: chunk(), send: () => assert.fail('no result frame'), sendError: () => assert.fail('valid frame'), logger: log }
    assert.deepEqual(handleBotAttachFrame({ ...base, ctx: ctxWith(undefined) }), { accepted: false, error: 'bot-attach-no-receiver' })
    assert.deepEqual(handleBotAttachFrame({ ...base, ctx: undefined }), { accepted: false, error: 'bot-attach-no-receiver' })
    assert.deepEqual(handleBotAttachFrame({ ...base, ctx: { get: () => { throw new Error('registry down') } } }), { accepted: false, error: 'bot-attach-no-receiver' })
    assert.deepEqual(handleBotAttachFrame({ ...base, ctx: ctxWith(() => { throw new Error('boom') }) }), { accepted: false, error: 'bot-attach-receiver-failed' })
    assert.deepEqual(handleBotAttachFrame({ ...base, ctx: ctxWith(() => Promise.reject(new Error('later'))) }), { accepted: true })
    assert.deepEqual(handleBotAttachFrame({ ...base, ctx: ctxWith(() => ({ then() { throw new Error('thenable') } })) }), { accepted: true })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
    assert.ok(log.lines.some(([m]) => m.includes('no receiver')))
    assert.ok(log.lines.some(([m, x]) => m.includes('threw') && x.error === 'boom'))
    assert.ok(log.lines.some(([m, x]) => m.includes('rejected') && x.error === 'later'))
    // a logger that throws changes nothing
    const noisy = { warn() { throw new Error('log failed') } }
    assert.doesNotThrow(() => handleBotAttachFrame({ ...base, logger: noisy, ctx: ctxWith(() => { throw new Error('x') }) }))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

// ── the dispatcher: order against the bot/turn that follows ─────────────────────────────────────

for (const [name, makeDispatcher] of [['lib/node/dispatch.js', createFrameDispatcher], ['src/task-run/dispatch.js', createSrcDispatcher]]) {
  for (const peerDirect of [false, true]) {
    test(`dispatch (${name}, peerDirect=${peerDirect}): every bot/attach chunk reaches the receiver before the bot/turn that names them, in frame order`, async () => {
      const order = []
      const turns = []
      const services = {
        'remote-agent:bot-attach': (c) => { order.push(`attach:${c.index}:${c.chunk}`) },
        'remote-agent:bot-turn': async (t) => { order.push('turn'); turns.push(t); return { text: 'ok' } },
      }
      const sent = []
      const ctx = { get: (key) => services[key], logger: logger() }
      const dispatch = makeDispatcher({ ctx, send: (type, data) => { sent.push({ type, data }); return true }, sendError: () => assert.fail('no error'), engine: {}, logger: ctx.logger, peerDirect })
      const manifest = [entry({ index: 0, chunks: 2 }), entry({ index: 1, name: 'b.txt', kind: 'file', chunks: 1 })]
      const frames = [
        { id: 'a1', t: HUB_TO_NODE.BOT_ATTACH, d: chunk({ index: 0, chunk: 0, chunks: 2 }) },
        { id: 'a2', t: HUB_TO_NODE.BOT_ATTACH, d: chunk({ index: 0, chunk: 1, chunks: 2 }) },
        { id: 'a3', t: HUB_TO_NODE.BOT_ATTACH, d: chunk({ index: 1, chunk: 0, chunks: 1 }) },
        { id: 't1', t: HUB_TO_NODE.BOT_TURN, d: turn({ attachments: manifest }) },
      ]
      for (const frame of frames) assert.equal(dispatch(frame), true)
      // The attach receiver calls all happened inside dispatch(); with peerDirect the turn is one microtask later.
      assert.deepEqual(order.filter((x) => x.startsWith('attach')), ['attach:0:0', 'attach:0:1', 'attach:1:0'], 'attach calls are synchronous with dispatch')
      for (let i = 0; i < 50 && !sent.some((s) => s.type === NODE_TO_HUB.BOT_TURN_RESULT); i += 1) await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(order, ['attach:0:0', 'attach:0:1', 'attach:1:0', 'turn'])
      assert.equal(turns.length, 1)
      assert.deepEqual(turns[0].attachments, manifest.map((m) => ({ ...m })), 'the receiver gets turn.attachments untouched')
      assert.equal(sent.at(-1).type, NODE_TO_HUB.BOT_TURN_RESULT)
      assert.equal(sent.at(-1).data.ok, true)
    })
  }

  test(`dispatch (${name}): a bad bot/attach frame gets an error frame, an unregistered receiver is ignored, the next frame still runs`, async () => {
    const errors = []
    const services = {}
    const ctx = { get: (key) => services[key], logger: logger() }
    const dispatch = makeDispatcher({ ctx, send: () => true, sendError: (...a) => errors.push(a), engine: {}, logger: ctx.logger })
    assert.equal(dispatch({ id: 'bad', t: HUB_TO_NODE.BOT_ATTACH, d: chunk({ data: '***' }) }), true)
    assert.equal(errors[0][0], 'bad')
    assert.equal(errors[0][1], 'bot-attach-data-invalid')
    assert.equal(dispatch({ id: 'noreceiver', t: HUB_TO_NODE.BOT_ATTACH, d: chunk() }), true)
    const seen = []
    services['remote-agent:bot-attach'] = (c) => { seen.push(c.chunk); throw new Error('boom') }
    assert.doesNotThrow(() => dispatch({ id: 'throws', t: HUB_TO_NODE.BOT_ATTACH, d: chunk() }))
    services['remote-agent:bot-attach'] = (c) => { seen.push(c.chunk) }
    dispatch({ id: 'fine', t: HUB_TO_NODE.BOT_ATTACH, d: chunk({ chunks: 2, chunk: 1 }) })
    assert.deepEqual(seen, [0, 1])
  })
}

test('bot/turn: handleBotTurnFrame hands the manifest to the receiver untouched; a bad manifest is refused before the receiver and answers an error frame', async () => {
  const received = []
  const errors = []
  const results = []
  const ctx = { get: (key) => (key === 'remote-agent:bot-turn' ? async (t) => { received.push(t); return { text: 'ok' } } : key === 'remote-agent:bot-attach' ? () => {} : undefined) }
  const manifest = [entry({ name: ' cat.png ' })]
  await handleBotTurnFrame({ frame: { id: 'f1' }, data: turn({ attachments: manifest }), ctx, send: (t, d) => { results.push({ t, d }) }, sendError: (...a) => errors.push(a), engine: {}, retryDelaysMs: [] })
  assert.deepEqual(received[0].attachments, [{ ...manifest[0], name: 'cat.png' }])
  assert.equal(results.at(-1).d.ok, true)
  const answers = []
  await handleBotTurnFrame({ frame: { id: 'f2' }, data: turn({ attachments: [entry({ bytes: 0 })] }), ctx, send: (t, d) => { answers.push({ t, d }) }, sendError: (...a) => errors.push(a), engine: {}, retryDelaysMs: [] })
  assert.equal(received.length, 1, 'the receiver never saw the bad turn')
  assert.deepEqual([answers[0].t, answers[0].d.ok, answers[0].d.error], ['bot/turn-result', false, 'bot-turn-attachments-invalid'], 'and the hub is told, not left waiting')
  assert.equal(errors.length, 1)
  assert.equal(errors[0][1], 'bot-turn-attachments-invalid')
})

// ── encryption ──────────────────────────────────────────────────────────────────────────────────

test('bot/attach is must-encrypt in all three copies of the downlink list, and a plaintext copy is refused once an E2E session exists', () => {
  for (const [name, impl] of Object.entries({ 'lib/node/transport.js': live, 'src/wire/session-framing.js': wireFraming, 'src/link/transport.js': linkTransport })) {
    assert.equal(impl.isE2ERequired(HUB_TO_NODE.BOT_ATTACH), true, `${name}: same as bot/turn`)
    assert.equal(impl.isE2ERequired(HUB_TO_NODE.BOT_TURN), true)
    assert.equal(impl.checkE2EGate({ t: HUB_TO_NODE.BOT_ATTACH }, { e2e: true, wasEncrypted: false }).rejected, true, `${name}: a plaintext bot/attach is a forgery or a downgrade`)
    assert.equal(impl.checkE2EGate({ t: HUB_TO_NODE.BOT_ATTACH }, { e2e: true, wasEncrypted: true }).rejected, false)
    assert.equal(impl.checkE2EGate({ t: HUB_TO_NODE.BOT_ATTACH }, { e2e: false, wasEncrypted: false }).rejected, false, 'no session yet: an old or e2e-off link still works')
    // it is hub -> node only, like bot/turn is for the node: the uplink list does not need it
    assert.equal(impl.isE2ERequiredUplink(HUB_TO_NODE.BOT_ATTACH), false)
  }
})

function sessionPair() {
  const n = generateEphemeral()
  const h = generateEphemeral()
  const sNode = createSession({ role: 'node', ownPrivB64: n.privateKeyB64, peerPubB64: h.publicKeyB64, nodePubB64: n.publicKeyB64, hubPubB64: h.publicKeyB64 })
  const sHub = createSession({ role: 'hub', ownPrivB64: h.privateKeyB64, peerPubB64: n.publicKeyB64, nodePubB64: n.publicKeyB64, hubPubB64: h.publicKeyB64 })
  return { sNode, sHub }
}

test('the real node transport: a plaintext bot/attach is refused (error frame, no frame event) once the session exists; sealed chunks and the turn come out in order', () => {
  const { sNode, sHub } = sessionPair()
  const transport = new NodeTransport({ url: 'ws://127.0.0.1:1/', hello: { nodeId: 'n1' } })
  transport.e2e = sNode
  const raw = []
  transport.sendRaw = (type, d) => { raw.push({ type, d }) }
  const frames = []
  const errors = []
  transport.on('frame', (f) => frames.push(f))
  transport.on('error', (e) => errors.push(String(e.message)))

  transport.handleFrame(lib.envelope(HUB_TO_NODE.BOT_ATTACH, chunk()))
  assert.equal(frames.length, 0, 'plaintext is not executed')
  assert.equal(errors.length, 1)
  assert.equal(raw[0].type, NODE_TO_HUB.ERROR)
  assert.equal(raw[0].d.code, lib.ERROR_CODE.E2E_REQUIRED)

  const sealed = (type, d, id) => { const env = lib.envelope(type, d); env.id = id; env.d = sHub.sealFrame(type, id, d); return env }
  const wireOrder = [
    sealed(HUB_TO_NODE.BOT_ATTACH, chunk({ index: 0, chunk: 0, chunks: 2 }), 'a1'),
    sealed(HUB_TO_NODE.BOT_ATTACH, chunk({ index: 0, chunk: 1, chunks: 2 }), 'a2'),
    sealed(HUB_TO_NODE.BOT_TURN, turn({ attachments: [entry({ chunks: 2 })] }), 't1'),
  ]
  for (const env of wireOrder) {
    // what crosses the link has no readable payload
    assert.equal(JSON.stringify(env.d).includes('aGVsbG8='), false)
    transport.handleFrame(JSON.parse(lib.encodeFrame(env)))
  }
  assert.deepEqual(frames.map((f) => [f.t, f.id]), [[HUB_TO_NODE.BOT_ATTACH, 'a1'], [HUB_TO_NODE.BOT_ATTACH, 'a2'], [HUB_TO_NODE.BOT_TURN, 't1']])
  assert.equal(frames[0].d.data, 'aGVsbG8=')
  assert.equal(frames[2].d.attachments[0].chunks, 2)
})

test('a maximum-size chunk, sealed by the real E2E session and encoded as a frame, stays well under the control frame limit and decodes back', () => {
  const { sNode, sHub } = sessionPair()
  const data = Buffer.alloc(825_000, 7).toString('base64').padEnd(1_100_000, 'A').slice(0, 1_100_000)
  assert.equal(data.length, BOT_ATTACH_LIMITS.maxChunkChars)
  const payload = { ...chunk({ index: 7, chunk: 39, chunks: 40 }), data }
  assert.equal(lib.validateBotAttach(payload).ok, true)
  const env = lib.envelope(HUB_TO_NODE.BOT_ATTACH, payload, {})
  env.d = sHub.sealFrame(HUB_TO_NODE.BOT_ATTACH, env.id, payload)
  const text = lib.encodeFrame({ ...env, to: 'n1' })
  const bytes = Buffer.byteLength(text)
  assert.ok(bytes < lib.MAX_CONTROL_FRAME_BYTES / 2, `${bytes} bytes should be under half of ${lib.MAX_CONTROL_FRAME_BYTES}`)
  assert.ok(bytes < 1_600_000, `${bytes}`)
  const decoded = lib.decodeFrame(text)
  assert.equal(decoded.ok, true)
  const opened = sNode.openFrame(decoded.frame.t, decoded.frame.id, decoded.frame.d)
  assert.deepEqual(opened, payload)
  assert.equal(lib.validateBotAttach(opened).ok, true)
  // the same size also passes a 40-chunk, 8-attachment turn's worth of frames one after another (seq keeps counting)
  for (let i = 0; i < 3; i += 1) {
    const e = lib.envelope(HUB_TO_NODE.BOT_ATTACH, payload)
    e.d = sHub.sealFrame(HUB_TO_NODE.BOT_ATTACH, e.id, payload)
    assert.deepEqual(sNode.openFrame(e.t, e.id, e.d), payload)
  }
})

// ── the hub send path, over a real hub, real E2E and two real workers with peer-direct on ───────

async function until(predicate, message, timeoutMs = 8000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('hub -> node over a real link: bot/attach is sealed, and a turn that names attachments takes the hub link behind its chunks even when peer-direct is on', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-attach-'))
  const logs = []
  const registry = new NodeRegistry({ identity: generateIdentity(), log: (...a) => logs.push(a) })
  const hubFrames = []
  const originalHubSend = registry.sendViaHub.bind(registry)
  registry.sendViaHub = (nodeId, type, ...args) => { hubFrames.push({ nodeId, type }); return originalHubSend(nodeId, type, ...args) }
  const hub = await startListenServer({ host: '127.0.0.1', port: 0, path: '/api/remote-agent/node', onUpgrade: (conn) => registry.attachDirect(conn) })
  const quiet = { info() {}, debug() {}, warn: (...a) => logs.push(a), error: (...a) => logs.push(a) }
  const disposers = []
  const contexts = new Map()
  const order = new Map()
  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose()
    registry.dispose()
    await hub.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const received = { turns: [] }
  for (const nodeId of ['a', 'b']) {
    const services = new Map()
    const routes = new Map()
    services.set('webServer', { register: (route) => { routes.set(route.path, route.handler) } })
    services.set('test:routes', routes)
    order.set(nodeId, [])
    services.set('remote-agent:bot-attach', (c) => { order.get(nodeId).push(`attach:${c.index}:${c.chunk}/${c.chunks}`) })
    services.set('remote-agent:bot-turn', async (turnData) => { order.get(nodeId).push(`turn:${turnData.exchangeId}`); received.turns.push(turnData); return { text: 'turn answer' } })
    const ctx = { logger: quiet, get: (key) => services.get(key), provide: (key, value) => services.set(key, value), set: (key, value) => services.set(key, value) }
    contexts.set(nodeId, ctx)
    disposers.push(applyWorker(ctx, {
      nodeId, transportMode: 'direct', hubUrl: `ws://127.0.0.1:${hub.port}/api/remote-agent/node`, stateDir: path.join(root, nodeId), roots: [root],
      peerDirect: true, peerListenHost: '127.0.0.1', peerListenPort: 0, resourceIntervalMs: 0, reposIntervalMs: 0,
    }))
  }
  await until(() => ['a', 'b'].every((id) => registry.nodes.get(id)?.e2e && registry.nodes.get(id)?.online), 'both nodes online with E2E')
  await until(() => contexts.get('a').get('remote-agent:peer-direct').snapshot().peers.length === 1, 'peer directory')
  assert.ok(registry.nodes.get('b').hello.caps.includes('bot-attach/1'), 'the node announced bot-attach/1 in its hello')

  // what actually goes on the wire to node b: the text frames, as the hub wrote them
  const wireTexts = []
  const conn = registry.nodes.get('b').conn
  const originalSend = conn.send.bind(conn)
  conn.send = (text, ...rest) => { wireTexts.push(String(text)); return originalSend(text, ...rest) }

  const secretData = Buffer.from('PRIVATE-IMAGE-BYTES-0123456789').toString('base64')
  const before = hubFrames.length
  assert.equal(registry.send('b', 'bot/attach', { nodeId: 'b', remoteBotId: 'beta', exchangeId: 'x1', index: 0, chunk: 0, chunks: 2, data: secretData }), true)
  assert.equal(registry.send('b', 'bot/attach', { nodeId: 'b', remoteBotId: 'beta', exchangeId: 'x1', index: 0, chunk: 1, chunks: 2, data: secretData }), true)
  const manifest = [{ index: 0, name: 'cat.png', kind: 'image', mediaType: 'image/png', bytes: 30, sha256: sha('x'), chunks: 2 }]
  assert.equal(registry.send('b', 'bot/turn', { nodeId: 'b', remoteBotId: 'beta', exchangeId: 'x1', text: 'look', attachments: manifest }), true)
  await until(() => received.turns.length === 1, 'the turn reached the node Bot')

  assert.deepEqual(order.get('b'), ['attach:0:0/2', 'attach:0:1/2', 'turn:x1'], 'chunks registered before the turn is dispatched')
  assert.deepEqual(received.turns[0].attachments, manifest)
  assert.deepEqual(hubFrames.slice(before).map((f) => f.type), ['bot/attach', 'bot/attach', 'bot/turn'], 'all three took the hub link, in this order')
  assert.equal(wireTexts.length >= 3, true)
  const attachWire = wireTexts.filter((x) => x.includes('"bot/attach"'))
  assert.equal(attachWire.length, 2)
  for (const text of attachWire) {
    const frame = JSON.parse(text)
    assert.equal(frame.d.e2e, 1, 'sealed')
    assert.equal(text.includes(secretData), false, 'the chunk is not readable on the link')
    assert.equal(text.includes('PRIVATE'), false)
  }

  // The turn right behind an attachment turn stays on the hub link too (it must not overtake it on the peer link).
  const beforePlain = hubFrames.length
  assert.equal(registry.send('b', 'bot/turn', { nodeId: 'b', remoteBotId: 'beta', exchangeId: 'plain', text: 'hi' }), true)
  await until(() => received.turns.length === 2, 'plain turn')
  assert.equal(hubFrames.slice(beforePlain).some((f) => f.type === 'bot/turn'), true, 'behind an attachment turn: hub link, in order')
  // Two minutes later the peer-direct path is back.
  registry.hubOnlyUntil.set('b', Date.now() - 1)
  const beforeLater = hubFrames.length
  assert.equal(registry.send('b', 'bot/turn', { nodeId: 'b', remoteBotId: 'beta', exchangeId: 'later', text: 'hi' }), true)
  await until(() => received.turns.length === 3, 'later plain turn')
  assert.equal(hubFrames.slice(beforeLater).some((f) => f.type === 'bot/turn'), false, 'later: peer-direct as before')
  // An empty manifest is no manifest.
  assert.equal(registry.send('b', 'bot/turn', { nodeId: 'b', remoteBotId: 'beta', exchangeId: 'empty', text: 'hi', attachments: [] }), true)
  await until(() => received.turns.length === 4, 'empty manifest turn')
  assert.equal(Object.hasOwn(received.turns[3], 'attachments'), false)
})

// ── audit round: a turn behind an attachment turn must not overtake it; chunks never leave in plaintext ───────

test('BA-audit-1: while an attachment turn is in flight, the turns behind it stay on the hub link (no peer-direct overtaking)', async () => {
  const { NodeRegistry } = await import('../lib/hub/node-registry.js')
  const registry = new NodeRegistry({ log: () => {} })
  const wire = []
  const viaPeer = []
  const conn = { closed: false, send: (text) => { wire.push(JSON.parse(text).t); return true }, ping() {}, destroy() {} }
  registry.nodes.set('n1', { nodeId: 'n1', online: true, conn, tasks: new Map(), hello: { nodeId: 'n1' } })
  registry.peerRouter = { send: (_nodeId, type) => { viaPeer.push(type); return true } }
  const plain = { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'e', text: 'x' }
  assert.equal(registry.send('n1', 'bot/turn', plain), true)
  assert.deepEqual(viaPeer, ['bot/turn'], 'before any attachment: peer-direct as always')
  registry.send('n1', 'bot/turn', { ...plain, attachments: [{ index: 0 }] })
  registry.send('n1', 'bot/turn', plain)
  assert.deepEqual(viaPeer, ['bot/turn'], 'the attachment turn and the one behind it went on the hub link')
  assert.deepEqual(wire, ['bot/turn', 'bot/turn'])
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 121_000
    registry.send('n1', 'bot/turn', plain)
  } finally { Date.now = realNow }
  assert.deepEqual(viaPeer, ['bot/turn', 'bot/turn'], 'after two minutes the peer-direct path is back')
})

test('BA-audit-2: bot/attach is not sent to a node without an e2e session (the user\'s image would be readable on the wire)', async () => {
  const { NodeRegistry } = await import('../lib/hub/node-registry.js')
  const registry = new NodeRegistry({ log: () => {} })
  const wire = []
  const conn = { closed: false, send: (text) => { wire.push(text); return true }, ping() {}, destroy() {} }
  const chunk = { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'e', index: 0, chunk: 0, chunks: 1, data: 'QUJD' }
  registry.nodes.set('n1', { nodeId: 'n1', online: true, conn, tasks: new Map(), hello: { nodeId: 'n1' } })
  assert.equal(registry.send('n1', 'bot/attach', chunk), false)
  assert.deepEqual(wire, [], 'nothing was written')
  // with a session the frame is sealed, not plain
  registry.nodes.get('n1').e2e = { sealFrame: () => ({ sealed: true }) }
  assert.equal(registry.send('n1', 'bot/attach', chunk), true)
  assert.equal(wire.length, 1)
  assert.equal(wire[0].includes('QUJD'), false, 'the payload is sealed')
})

// ── audit round: never silent ─────────────────────────────────────────────────────────────────

test('BA-audit-3: a turn with attachments on a node whose ds-bot has no chunk receiver is refused with the reason, not run as plain text', async () => {
  const { handleBotTurnFrame } = await import('../lib/bot-turn.js')
  const sent = []
  let ran = 0
  const ctx = { get: (name) => (name === 'remote-agent:bot-turn' ? async () => { ran += 1; return { ok: true, text: 'x' } } : undefined) }
  const turn = { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'e1', text: 'look', attachments: [{ index: 0, name: 'a.png', kind: 'image', bytes: 5, sha256: 'a'.repeat(64), chunks: 1 }] }
  const out = await handleBotTurnFrame({ frame: { id: 'f' }, data: turn, ctx, send: (type, frame) => { sent.push({ type, frame }); return true }, sendError() {}, turnSeq: { next: () => 1 }, retryDelaysMs: [] })
  assert.equal(out.accepted, false)
  assert.equal(ran, 0, 'the Bot was not run on the words alone')
  assert.equal(sent[0].type, 'bot/turn-result')
  assert.deepEqual([sent[0].frame.ok, sent[0].frame.error, sent[0].frame.exchangeId], [false, 'bot-attach-no-receiver', 'e1'])
})

test('BA-audit-4: an invalid turn that names its exchange is answered with a failed result, so the hub does not wait out the timeout', async () => {
  const { handleBotTurnFrame } = await import('../lib/bot-turn.js')
  const sent = []
  const errors = []
  const turn = { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'e2', text: 'x', attachments: [{ index: 0, name: 'a', kind: 'file', bytes: 5, sha256: 'bad', chunks: 1 }] }
  const out = await handleBotTurnFrame({ frame: { id: 'f' }, data: turn, ctx: { get: () => undefined }, send: (type, frame) => { sent.push({ type, frame }); return true }, sendError: (...args) => errors.push(args), retryDelaysMs: [] })
  assert.equal(out.error, 'bot-turn-attachments-invalid')
  assert.equal(errors.length, 1, 'the error frame still goes out')
  assert.deepEqual([sent[0].type, sent[0].frame.ok, sent[0].frame.error], ['bot/turn-result', false, 'bot-turn-attachments-invalid'])
  // a frame that names nothing is only an error frame
  sent.length = 0
  await handleBotTurnFrame({ frame: { id: 'f' }, data: { text: 'x' }, ctx: { get: () => undefined }, send: (type) => { sent.push(type); return true }, sendError() {}, retryDelaysMs: [] })
  assert.deepEqual(sent, [])
})
