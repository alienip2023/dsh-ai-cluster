/**
 * The roster frame must always fit the ws frame limit (4 MiB in lib/ws.js; a bigger frame closes the link and
 * every reply riding it is lost). Worst case of the old caps was ~5 MB. Budget: 512 KiB, trimmed in a fixed order:
 * card bodies, skill content, oldest tasks, cards. A Bot is never dropped.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ROSTER_CAP, ROSTER_FRAME_BUDGET_BYTES, ROSTER_RESEND_MS, bindRosterReport, fitRosterFrame, rosterFrame,
} from '../lib/roster-report.js'
import { NODE_TO_HUB } from '../lib/protocol.js'

const bytes = (frame) => Buffer.byteLength(JSON.stringify(frame), 'utf8')

function worstCaseBots() {
  return Array.from({ length: 100 }, (_, b) => ({
    id: `bot-${b}`.padEnd(80, 'i'), name: 'n'.repeat(60), role: 'r'.repeat(40), model: 'm'.repeat(200), clusterBotId: `cb-${b}`,
    tasks: Array.from({ length: 20 }, (__, i) => ({ id: `t${i}`.padEnd(100, 'x'), title: 't'.repeat(200), status: 'running', startedAt: b * 100 + i })),
    cards: Array.from({ length: 40 }, (__, i) => ({
      id: `card-${i}`.padEnd(300, 'c'), kind: 'approval', title: 'T'.repeat(500), body: 'B'.repeat(9000), input: true, at: i,
      options: Array.from({ length: 20 }, (___, k) => ({ id: `o${k}`.padEnd(100, 'o'), label: 'L'.repeat(100) })),
    })),
  }))
}
const worstSkills = () => ({ version: 1, items: Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, name: `skill ${i}`, description: 'd', content: 'x'.repeat(16000) })) })

test('BUDGET-1: the worst-case input is far below the ws limit and keeps every Bot (up to the Bot cap)', () => {
  const frame = rosterFrame({ nodeId: 'n1', hostname: 'h', bots: worstCaseBots(), skills: worstSkills() })
  assert.ok(bytes(frame) <= ROSTER_FRAME_BUDGET_BYTES, `frame is ${bytes(frame)} bytes`)
  assert.ok(ROSTER_FRAME_BUDGET_BYTES <= 512 * 1024)
  assert.equal(frame.bots.length, ROSTER_CAP, 'no Bot dropped by the budget')
  assert.ok(frame.bots.every((b) => b.id !== ''), 'every Bot still has its identity')
  assert.ok(Array.isArray(frame.trimmed) && frame.trimmed.length > 0, 'the trim is announced in the frame')
})

test('BUDGET-2: caps per card (2000 chars) and per Bot (8 cards) hold even when the frame is small', () => {
  const frame = rosterFrame({ nodeId: 'n1', hostname: 'h', bots: [{ id: 'b', name: 'B', role: 'r',
    cards: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, body: 'x'.repeat(5000), at: i })) }] })
  assert.equal(frame.bots[0].cards.length, 8)
  assert.equal(frame.bots[0].cards[0].body.length, 2000)
  assert.equal(frame.trimmed, undefined, 'under budget: nothing trimmed, no marker')
})

function sample() {
  return {
    nodeId: 'n', hostname: 'h',
    bots: [
      { id: 'a', name: 'A', role: 'r', tasks: [{ id: 't-old', title: '', status: 'running', startedAt: 1 }, { id: 't-new', title: '', status: 'running', startedAt: 9 }],
        cards: [{ id: 'c1', kind: 'skill', title: 'x', body: 'b'.repeat(1500), options: [], input: false, at: 1 }] },
      { id: 'b', name: 'B', role: 'r', tasks: [{ id: 't-mid', title: '', status: 'running', startedAt: 5 }], cards: [] },
    ],
    skills: { version: 1, items: [{ id: 's', name: 'S', description: 'd', content: 'c'.repeat(3000) }] },
  }
}

test('BUDGET-3: trim order is card bodies, then skill content, then oldest tasks, then cards', () => {
  const full = bytes(sample())
  // 1. dropping the card body is enough
  let f = sample()
  assert.deepEqual(fitRosterFrame(f, full - 100), ['card-bodies'])
  assert.equal(f.bots[0].cards[0].body, '')
  assert.equal(f.skills.items[0].content.length, 3000, 'skill content untouched while a cheaper step fits')
  assert.equal(f.bots[0].tasks.length, 2)
  // 2. bodies are not enough: skill content goes too, names stay
  f = sample()
  const noBody = bytes({ ...sample(), bots: sample().bots.map((b) => ({ ...b, cards: b.cards.map((c) => ({ ...c, body: '' })) })) })
  assert.deepEqual(fitRosterFrame(f, noBody - 100), ['card-bodies', 'skill-content'])
  assert.equal(f.skills.items[0].content, '')
  assert.equal(f.skills.items[0].name, 'S')
  assert.equal(f.bots[0].tasks.length, 2, 'tasks untouched')
  // 3. then the OLDEST tasks, across Bots
  f = sample()
  const steps = fitRosterFrame(f, bytes({ nodeId: 'n', hostname: 'h', bots: [
    { id: 'a', name: 'A', role: 'r', tasks: [{ id: 't-new', title: '', status: 'running', startedAt: 9 }], cards: [{ id: 'c1', kind: 'skill', title: 'x', body: '', options: [], input: false, at: 1 }] },
    { id: 'b', name: 'B', role: 'r', tasks: [], cards: [] }], skills: { version: 1, items: [{ id: 's', name: 'S', description: 'd', content: '' }] } }))
  assert.deepEqual(steps, ['card-bodies', 'skill-content', 'oldest-tasks'])
  assert.deepEqual(f.bots[0].tasks.map((t) => t.id), ['t-new'], 'the newest task survives')
  assert.equal(f.bots[1].tasks.length, 0)
  // 4. last resort: cards, never Bots
  f = sample()
  fitRosterFrame(f, 200)
  assert.equal(f.bots.length, 2, 'a Bot is never dropped')
  assert.equal(f.bots[0].cards.length, 0)
})

test('BUDGET-4: a frame that already fits is untouched', () => {
  const f = sample()
  const before = JSON.stringify(f)
  assert.deepEqual(fitRosterFrame(f), [])
  assert.equal(JSON.stringify(f), before)
})

/* ───────────────────── resend suppression ───────────────────── */

test('RESEND-1: an unchanged roster is not resent within 30 s, a changed one is, and so is any after the window', () => {
  let now = 1_000_000
  const sent = []
  const report = bindRosterReport(undefined, { send: (type, frame) => { sent.push({ type, frame }); return true }, nodeId: 'n', hostname: 'h', now: () => now })
  const payload = { bots: [{ id: 'a', name: 'A', role: 'r' }] }
  assert.equal(report(payload), true)
  now += 5_000
  assert.equal(report(payload), true, 'reported as delivered')
  now += 5_000
  report(payload)
  assert.equal(sent.length, 1, 'ten seconds of identical republishing sends one frame')
  assert.equal(sent[0].type, NODE_TO_HUB.ROSTER)

  now += 5_000
  report({ bots: [{ id: 'a', name: 'A renamed', role: 'r' }] })
  assert.equal(sent.length, 2, 'a change goes out at once')

  now += ROSTER_RESEND_MS
  report({ bots: [{ id: 'a', name: 'A renamed', role: 'r' }] })
  assert.equal(sent.length, 3, 'after 30 s the unchanged roster is refreshed')
})

test('RESEND-2: a failed send is not remembered, the next identical report tries again', () => {
  let ok = false
  let calls = 0
  const report = bindRosterReport(undefined, { send: () => { calls += 1; return ok }, nodeId: 'n', now: () => 5 })
  assert.equal(report({ bots: [] }), false)
  ok = true
  assert.equal(report({ bots: [] }), true)
  assert.equal(calls, 2)
})

test('a card keeps an opaque data string up to its cap; a larger one is dropped whole, and a tight budget drops it with the body', async () => {
  const { cleanRosterCards, ROSTER_CARD_DATA_CAP, fitRosterFrame } = await import('../lib/roster-report.js')
  const small = JSON.stringify({ view: { type: 'options' } })
  const [kept] = cleanRosterCards([{ id: 'view:1', kind: 'view', title: 't', data: small }])
  assert.equal(kept.data, small)
  const [dropped] = cleanRosterCards([{ id: 'view:2', kind: 'view', title: 't', data: 'x'.repeat(ROSTER_CARD_DATA_CAP + 1) }])
  assert.equal('data' in dropped, false)
  assert.equal('data' in cleanRosterCards([{ id: 'c', kind: 'view', data: 5 }])[0], false, 'not a string: not carried')
  const frame = { bots: [{ cards: [{ id: 'view:1', body: 'b', data: small, at: 1 }] }] }
  assert.deepEqual(fitRosterFrame(frame, 10), ['card-bodies', 'cards'])
})
