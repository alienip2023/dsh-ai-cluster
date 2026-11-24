import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTurnSeq } from '../lib/node/turn-seq.js'

describe('turn-seq', () => {
  let tmpDir

  function makeTurnSeq() {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-seq-test-'))
    return createTurnSeq(tmpDir)
  }

  test('S21-seq-monotone: monotone across calls', () => {
    const ts = makeTurnSeq()
    try {
      const s0 = ts.next('bot-a')
      const s1 = ts.next('bot-a')
      const s2 = ts.next('bot-a')
      assert.equal(s0, 0)
      assert.equal(s1, 1)
      assert.equal(s2, 2)
    } finally { rmSync(tmpDir, { recursive: true, force: true }) }
  })

  test('S21-seq-dedup: different botIds get independent counters', () => {
    const ts = makeTurnSeq()
    try {
      assert.equal(ts.next('bot-a'), 0)
      assert.equal(ts.next('bot-b'), 0)
      assert.equal(ts.next('bot-a'), 1)
      assert.equal(ts.next('bot-b'), 1)
    } finally { rmSync(tmpDir, { recursive: true, force: true }) }
  })

  test('cross-restart: second createTurnSeq on same dir does not go back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-seq-restart-'))
    try {
      const ts1 = createTurnSeq(dir)
      ts1.next('bot-r')  // 0
      ts1.next('bot-r')  // 1

      const ts2 = createTurnSeq(dir)
      const s = ts2.next('bot-r')
      assert.ok(s >= 2, `expected seq >= 2 after restart, got ${s}`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('reset (test-only): allows counter to restart', () => {
    const ts = makeTurnSeq()
    try {
      ts.next('bot-x')  // 0
      ts.next('bot-x')  // 1
      ts.reset('bot-x')
      assert.equal(ts.next('bot-x'), 0)
    } finally { rmSync(tmpDir, { recursive: true, force: true }) }
  })
})

// ---- S21-seq-missing-unit: validateBotTurnResult seq validation ----
import { validateBotTurnResult } from '../lib/protocol.js'
import { test as t, describe as d } from 'node:test'
import assert2 from 'node:assert/strict'

d('S21-seq-missing-unit: validateBotTurnResult seq field', () => {
  const base = { nodeId: 'n1', remoteBotId: 'rb1', exchangeId: 'e1', text: 'ok', ok: true }

  t('seq missing -> bot-turn-result-seq-missing', () => {
    const r = validateBotTurnResult({ ...base })
    assert2.equal(r.ok, false)
    assert2.equal(r.error, 'bot-turn-result-seq-missing')
  })

  t('seq is string -> bot-turn-result-seq-missing', () => {
    const r = validateBotTurnResult({ ...base, seq: '7' })
    assert2.equal(r.ok, false)
    assert2.equal(r.error, 'bot-turn-result-seq-missing')
  })

  t('seq is float -> bot-turn-result-seq-missing', () => {
    const r = validateBotTurnResult({ ...base, seq: 3.5 })
    assert2.equal(r.ok, false)
    assert2.equal(r.error, 'bot-turn-result-seq-missing')
  })

  t('seq is negative -> bot-turn-result-seq-invalid', () => {
    const r = validateBotTurnResult({ ...base, seq: -1 })
    assert2.equal(r.ok, false)
    assert2.equal(r.error, 'bot-turn-result-seq-invalid')
  })

  t('seq is 0 -> ok', () => {
    const r = validateBotTurnResult({ ...base, seq: 0 })
    assert2.equal(r.ok, true)
    assert2.equal(r.result.seq, 0)
  })

  t('seq is positive integer -> ok', () => {
    const r = validateBotTurnResult({ ...base, seq: 42 })
    assert2.equal(r.ok, true)
    assert2.equal(r.result.seq, 42)
  })
})

describe('turn-seq robustness (audit)', () => {
  test('an unreadable state file restarts from a time floor (never below earlier seqs), and says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-seq-corrupt-'))
    try {
      const ts1 = createTurnSeq(dir)
      for (let i = 0; i < 5; i++) ts1.next('bot-c')
      writeFileSync(join(dir, 'turn-seq.json'), '{not json')
      const logs = []
      const ts2 = createTurnSeq(dir, { log: (level, msg, extra) => logs.push({ level, msg, extra }), now: () => 1_800_000_000_000 })
      const first = ts2.next('bot-c')
      assert.ok(first >= 1_800_000_000_000, `restarted at ${first}`)
      assert.equal(ts2.next('bot-c'), first + 1, 'still strictly monotone afterwards')
      assert.equal(ts2.next('bot-other') >= 1_800_000_000_000, true, 'every counter gets the floor')
      assert.equal(logs.filter((l) => l.level === 'warn').length, 1)
      assert.match(logs[0].msg, /unreadable/)
      // a third process sees the good file written by the second one
      assert.ok(createTurnSeq(dir).next('bot-c') > first + 1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('an absent file is a fresh install: starts at 0, no warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-seq-fresh-'))
    try {
      const logs = []
      const ts = createTurnSeq(join(dir, 'new'), { log: (...a) => logs.push(a) })
      assert.equal(ts.next('b'), 0)
      assert.deepEqual(logs, [])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a corrupt entry inside a readable file does not reset that counter to 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-seq-entry-'))
    try {
      writeFileSync(join(dir, 'turn-seq.json'), JSON.stringify({ a: 'oops', b: 7 }))
      const ts = createTurnSeq(dir, { now: () => 1_900_000_000_000 })
      assert.ok(ts.next('a') >= 1_900_000_000_000)
      assert.equal(ts.next('b'), 8)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('writes are atomic: no temp file is left, the file is always complete JSON, a failed write warns once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-seq-atomic-'))
    try {
      const ts = createTurnSeq(dir)
      for (let i = 0; i < 20; i++) ts.next('bot-a')
      assert.deepEqual(readdirSync(dir), ['turn-seq.json'])
      assert.equal(JSON.parse(readFileSync(join(dir, 'turn-seq.json'), 'utf8'))['bot-a'], 19)

      // the state dir is a file: nothing can be written, the counter keeps working in memory and the failure is logged once
      const blocked = join(dir, 'blocked')
      writeFileSync(blocked, 'x')
      const logs = []
      const mem = createTurnSeq(blocked, { log: (level, msg) => logs.push({ level, msg }) })
      assert.equal(mem.next('x'), 0)
      assert.equal(mem.next('x'), 1)
      assert.equal(logs.filter((l) => l.level === 'warn' && /not saved/.test(l.msg)).length, 1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
