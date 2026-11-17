import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractFinalFromNdjson, extractSessionId } from '../../lib/node/runner.js'

// The reported usage placeholder is represented as a valid JSON object.
const currentCliOutput = `{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"text","text":"ARGV95 OK"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","sessionId":"session-…","reason":{"kind":"completed"},"text":"ARGV95 OK"}`

const ndjson = (events) => events.map((ev) => JSON.stringify(ev)).join('\n')

test('current CLI six-event output extracts the final reply', () => {
  assert.deepEqual(extractFinalFromNdjson(currentCliOutput), {
    final: 'ARGV95 OK', toolCalls: [], eventCount: 6,
  })
})

test('text-only stream concatenates chunks and preserves existing newlines', () => {
  const output = ndjson([
    { type: 'text', text: 'ARGV' },
    { type: 'text', text: '95 OK\n' },
    { type: 'status', phase: 'step_end' },
    { type: 'text', text: 'second ' },
    { type: 'text', text: 'line' },
  ])
  assert.equal(extractFinalFromNdjson(output).final, 'ARGV95 OK\nsecond line')
})

for (const reply of ['authoritative reply', '']) {
  test(`final text overrides streamed chunks, including ${JSON.stringify(reply)}`, () => {
    const output = ndjson([
      { type: 'text', text: 'partial' },
      { type: 'final', text: reply, final: 'legacy fallback' },
      { type: 'text', text: 'late chunk' },
    ])
    assert.equal(extractFinalFromNdjson(output).final, reply)
  })
}

test('later final event wins', () => {
  const output = ndjson([
    { type: 'final', text: 'earlier' },
    { type: 'text', text: 'partial' },
    { type: 'final', text: 'latest' },
  ])
  assert.equal(extractFinalFromNdjson(output).final, 'latest')
})

test('legacy final string remains supported', () => {
  assert.equal(extractFinalFromNdjson('{"type":"final","final":"x"}').final, 'x')
  const output = ndjson([
    { type: 'text', text: 'partial' },
    { type: 'final', text: null, final: 'x' },
  ])
  assert.equal(extractFinalFromNdjson(output).final, 'x')
})

for (const type of ['assistant/message', 'assistant.message', 'message']) {
  for (const field of ['message', 'content', 'blocks']) {
    test(`${type} supports ${field} text blocks`, () => {
      const blocks = [null, { type: 'text', text: 'hello ' }, { type: 'tool_use' }, { type: 'text', text: 'world' }]
      const ev = { type, [field]: field === 'message' ? { content: blocks } : blocks }
      assert.equal(extractFinalFromNdjson(ndjson([ev])).final, 'hello world')
    })
  }
  test(`${type} supports plain text`, () => {
    assert.equal(extractFinalFromNdjson(ndjson([{ type, text: 'plain' }])).final, 'plain')
  })
}

test('malformed lines and non-object JSON are skipped', () => {
  const output = '\nnot JSON\r\nnull\n42\n{"type":\n{"type":"text","text":"OK"}\n'
  assert.deepEqual(extractFinalFromNdjson(output), {
    final: 'OK', toolCalls: [], eventCount: 5,
  })
})

test('non-string text fields are ignored', () => {
  const output = ndjson([
    { type: 'text', text: 'OK' },
    { type: 'text', text: 42 },
    { type: 'final', text: {} },
  ])
  assert.equal(extractFinalFromNdjson(output).final, 'OK')
})

test('empty input returns an empty reply', () => {
  assert.deepEqual(extractFinalFromNdjson(''), { final: '', toolCalls: [], eventCount: 0 })
  assert.equal(extractFinalFromNdjson(' \r\n\n').final, '')
})

test('sessionId is extracted from the current CLI final event', () => {
  assert.equal(extractSessionId(currentCliOutput), 'session-…')
  assert.equal(extractSessionId(''), null)
})

test('tool call aliases and kind fallback remain supported', () => {
  const output = ndjson([
    { type: 'tool/call', name: 'first' },
    { type: 'tool.call', toolName: 'second' },
    { kind: 'tool/call' },
    { kind: 'message', text: 'done' },
  ])
  const result = extractFinalFromNdjson(output)
  assert.equal(result.final, 'done')
  assert.deepEqual(result.toolCalls.map((call) => call.name), ['first', 'second', 'unknown'])
  assert.ok(result.toolCalls.every((call) => Number.isFinite(call.at)))
})
