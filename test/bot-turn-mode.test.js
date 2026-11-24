// bot/turn may say how a busy Bot should take it: 'steer' joins the turn in flight, 'queue' waits.
// The receiver (ds-bot on the node) gets it; anything else reads as not given.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateBotTurn } from '../lib/protocol.js'
import { handleBotTurnFrame } from '../lib/bot-turn.js'

const base = { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'e1', text: 'hi' }

test('mode steer and queue are kept; anything else is dropped, never refused', () => {
  assert.equal(validateBotTurn({ ...base, mode: 'steer' }).turn.mode, 'steer')
  assert.equal(validateBotTurn({ ...base, mode: 'queue' }).turn.mode, 'queue')
  for (const mode of ['agent', '', 1, null, undefined]) {
    const checked = validateBotTurn({ ...base, mode })
    assert.equal(checked.ok, true)
    assert.equal('mode' in checked.turn, false)
  }
})

test('the node receiver is handed the mode', async () => {
  const seen = []
  const ctx = { get: name => (name === 'remote-agent:bot-turn' ? async turn => { seen.push(turn); return { ok: true, text: 'done' } } : undefined) }
  const sent = []
  await handleBotTurnFrame({ frame: { id: 'f1' }, data: { ...base, mode: 'steer' }, ctx, send: (type, frame) => { sent.push({ type, frame }); return true }, sendError() {}, engine: {}, turnSeq: { next: () => 1 } })
  assert.equal(seen[0].mode, 'steer')
  assert.equal(sent[0].frame.exchangeId, 'e1')
})

import { RESULT_RETRY_DELAYS_MS } from '../lib/bot-turn.js'

test('the node keeps retrying a turn\'s answer for about half an hour, so a link that is down for a while still gets it', () => {
  const totalMs = RESULT_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)
  assert.ok(totalMs >= 30 * 60_000, `retries cover ${Math.round(totalMs / 60_000)} minutes`)
  assert.ok(totalMs <= 40 * 60_000, 'and are bounded')
  assert.equal(RESULT_RETRY_DELAYS_MS[0], 500, 'the first retry is quick: a flap of a second is not a wait of a minute')
})

test('an answer that cannot be sent while the link is down goes out as soon as it is back', async () => {
  let attempts = 0
  const ctx = { get: name => (name === 'remote-agent:bot-turn' ? async () => ({ ok: true, text: 'done' }) : undefined) }
  const sent = []
  await handleBotTurnFrame({
    frame: { id: 'f1' }, data: base, ctx, sendError() {}, engine: {}, turnSeq: { next: () => 1 }, retryDelaysMs: [1, 1, 1, 1, 1, 1],
    send: (type, frame) => { attempts += 1; if (attempts <= 4) return false; sent.push({ type, frame }); return true },
  })
  assert.equal(attempts, 5)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].frame.text, 'done')
})
