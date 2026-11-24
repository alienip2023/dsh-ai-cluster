// bot/action: the hub does something to a node Bot's interface state on the user's behalf (answer a
// card, stop or follow up a background task). A node has no screen, so this is how it gets answered.
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { HUB_TO_NODE, NODE_TO_HUB, validateBotAction, validateBotActionResult } from '../lib/protocol.js'
import { handleBotActionFrame, forgetBotActions } from '../lib/bot-action.js'

beforeEach(() => forgetBotActions())
import * as wire from '../src/wire/index.js'

const base = { nodeId: 'n1', remoteBotId: 'b1', requestId: 'r1' }

test('card-answer needs a card and an answer; params are cut to four plain strings', () => {
  const ok = validateBotAction({ ...base, action: 'card-answer', params: { cardId: 'c1', choice: 'allow', evil: { x: 1 }, text: 'because' } })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.action.params, { cardId: 'c1', choice: 'allow', text: 'because' })
  assert.equal(validateBotAction({ ...base, action: 'card-answer', params: { cardId: 'c1' } }).ok, false, 'no answer')
  assert.equal(validateBotAction({ ...base, action: 'card-answer', params: { choice: 'allow' } }).ok, false, 'no card')
})

test('task-stop and task-send need a task; task-send needs text; an unknown action is refused', () => {
  assert.equal(validateBotAction({ ...base, action: 'task-stop', params: { taskId: 't1' } }).ok, true)
  assert.equal(validateBotAction({ ...base, action: 'task-stop', params: {} }).ok, false)
  assert.equal(validateBotAction({ ...base, action: 'task-send', params: { taskId: 't1' } }).ok, false)
  assert.equal(validateBotAction({ ...base, action: 'task-send', params: { taskId: 't1', text: 'also x' } }).ok, true)
  assert.equal(validateBotAction({ ...base, action: 'task-start', params: {} }).ok, false)
  assert.deepEqual(validateBotAction({ ...base, action: 'task-start', params: { text: 'do x', relation: 'independent', evil: 1 } }).action.params, { text: 'do x', relation: 'independent' })
  assert.equal(validateBotAction({ ...base, action: 'rm-rf', params: {} }).ok, false)
  assert.equal(validateBotAction({ ...base, requestId: '', action: 'task-stop', params: { taskId: 't' } }).ok, false)
})

test('the result keeps a boolean ok and short strings', () => {
  assert.deepEqual(validateBotActionResult({ requestId: 'r1', ok: true }).result, { requestId: 'r1', ok: true, error: null, detail: null })
  assert.equal(validateBotActionResult({ requestId: 'r1', ok: 'yes' }).ok, false)
  assert.equal(validateBotActionResult({ requestId: 'r1', ok: false, error: 'x'.repeat(500) }).result.error.length, 200)
})

test('the frame types are the same in lib and in the plugin wire source', () => {
  assert.equal(HUB_TO_NODE.BOT_ACTION, 'bot/action')
  assert.equal(NODE_TO_HUB.BOT_ACTION_RESULT, 'bot/action-result')
  assert.equal(wire.HUB_TO_NODE.BOT_ACTION, HUB_TO_NODE.BOT_ACTION)
  assert.equal(wire.NODE_TO_HUB.BOT_ACTION_RESULT, NODE_TO_HUB.BOT_ACTION_RESULT)
  assert.equal(wire.validateBotAction({ ...base, action: 'task-stop', params: { taskId: 't' } }).ok, true)
})

function run(data, receiver) {
  const sent = []
  const errors = []
  const ctx = { get: name => (name === 'remote-agent:bot-action' ? receiver : undefined) }
  return handleBotActionFrame({ frame: { id: 'f1' }, data, ctx, send: (type, payload, opts) => { sent.push({ type, payload, opts }) }, sendError: (...args) => errors.push(args) })
    .then(() => ({ sent, errors }))
}

test('the node receiver gets the action and its result goes back as a bot/action-result', async () => {
  const seen = []
  const { sent } = await run({ ...base, action: 'card-answer', params: { cardId: 'c1', choice: 'ok' } }, async request => { seen.push(request); return { ok: true, detail: 'applied' } })
  assert.deepEqual(seen, [{ remoteBotId: 'b1', action: 'card-answer', params: { cardId: 'c1', choice: 'ok' }, requestId: 'r1' }])
  assert.equal(sent[0].type, NODE_TO_HUB.BOT_ACTION_RESULT)
  assert.deepEqual(sent[0].payload, { requestId: 'r1', ok: true, error: null, detail: 'applied' })
  assert.deepEqual(sent[0].opts, { replyTo: 'f1' })
})

test('no receiver (an older ds-bot), a refusal and a throw each answer, never hang', async () => {
  assert.equal((await run({ ...base, requestId: 'q1', action: 'task-stop', params: { taskId: 't' } }, undefined)).sent[0].payload.error, 'bot-action-no-receiver')
  assert.deepEqual((await run({ ...base, requestId: 'q2', action: 'task-stop', params: { taskId: 't' } }, async () => ({ ok: false, error: 'no-such-task' }))).sent[0].payload.error, 'no-such-task')
  assert.match((await run({ ...base, requestId: 'q3', action: 'task-stop', params: { taskId: 't' } }, async () => { throw new Error('boom') })).sent[0].payload.error, /boom/)
})

test('an invalid frame that names its request is still answered', async () => {
  const { sent, errors } = await run({ ...base, action: 'rm-rf', params: {} }, async () => ({ ok: true }))
  assert.equal(errors.length, 1)
  assert.equal(sent[0].payload.ok, false)
  assert.equal(sent[0].payload.requestId, 'r1')
})

test('the same requestId arriving twice is acted on once and answered twice', async () => {
  const { forgetBotActions } = await import('../lib/bot-action.js')
  forgetBotActions()
  const sent = []
  let calls = 0
  const ctx = { get: () => async () => { calls += 1; return { ok: true, detail: 'task-1' } } }
  const run = () => handleBotActionFrame({
    frame: { id: 'f1' }, data: { ...base, action: 'task-start', params: { text: 'do x' } }, ctx,
    send: (type, payload) => sent.push({ type, payload }), sendError: () => {},
  })
  await run()
  await run()
  assert.equal(calls, 1, 'the receiver ran once')
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1].payload, sent[0].payload, 'the repeat got the first answer')
})

test('a failed attempt is not remembered, so a retry runs for real', async () => {
  const { forgetBotActions } = await import('../lib/bot-action.js')
  forgetBotActions()
  let calls = 0
  const ctx = { get: () => async () => { calls += 1; if (calls === 1) throw new Error('boom'); return { ok: true } } }
  const sent = []
  const run = () => handleBotActionFrame({
    frame: { id: 'f' }, data: { ...base, requestId: 'r-retry', action: 'task-stop', params: { taskId: 't' } }, ctx,
    send: (type, payload) => sent.push(payload), sendError: () => {},
  })
  await run(); await run()
  assert.equal(calls, 2)
  assert.equal(sent[0].ok, false)
  assert.equal(sent[1].ok, true)
})
