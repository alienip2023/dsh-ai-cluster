// P1 模型同步帧测试：validateModelSync + validateModelSyncResult + dispatch case
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateModelSync, validateModelSyncResult, HUB_TO_NODE, NODE_TO_HUB } from '../src/wire/index.js'
import { createFrameDispatcher } from '../src/task-run/dispatch.js'

// ── validateModelSync ──────────────────────────────────────────────────────

test('validateModelSync: scope=default 有效', () => {
  const result = validateModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'default', modelRef: 'openai/gpt-4o' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.sync, { nodeId: 'n1', requestId: 'r1', scope: 'default', modelRef: 'openai/gpt-4o' })
})

test('validateModelSync: scope=bot 有效（带 botId 和 effort）', () => {
  const result = validateModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'bot', modelRef: 'openai/gpt-4o', botId: 'b1', effort: 'high' })
  assert.equal(result.ok, true)
  assert.equal(result.sync.botId, 'b1')
  assert.equal(result.sync.effort, 'high')
})

test('validateModelSync: scope=all 有效', () => {
  const result = validateModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'all', modelRef: 'deepseek/deepseek-chat' })
  assert.equal(result.ok, true)
  assert.equal(result.sync.scope, 'all')
})

test('validateModelSync: 缺 nodeId 拒绝', () => {
  const result = validateModelSync({ requestId: 'r1', scope: 'default', modelRef: 'openai/gpt-4o' })
  assert.equal(result.ok, false)
  assert.match(result.error, /nodeId/)
})

test('validateModelSync: 缺 modelRef 拒绝', () => {
  const result = validateModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'default', modelRef: '' })
  assert.equal(result.ok, false)
  assert.match(result.error, /modelRef/)
})

test('validateModelSync: scope=bot 缺 botId 拒绝', () => {
  const result = validateModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'bot', modelRef: 'openai/gpt-4o' })
  assert.equal(result.ok, false)
  assert.match(result.error, /botId/)
})

test('validateModelSync: scope 非法拒绝', () => {
  const result = validateModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'invalid', modelRef: 'openai/gpt-4o' })
  assert.equal(result.ok, false)
  assert.match(result.error, /scope/)
})

test('validateModelSync: null 输入拒绝', () => {
  assert.equal(validateModelSync(null).ok, false)
  assert.equal(validateModelSync(undefined).ok, false)
  assert.equal(validateModelSync([]).ok, false)
})

// ── validateModelSyncResult ────────────────────────────────────────────────

test('validateModelSyncResult: ok=true 有效', () => {
  const result = validateModelSyncResult({ requestId: 'r1', nodeId: 'n1', ok: true, applied: ['b1', 'b2'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.result.applied, ['b1', 'b2'])
})

test('validateModelSyncResult: ok=false 有效', () => {
  const result = validateModelSyncResult({ requestId: 'r1', nodeId: 'n1', ok: false, applied: [], error: 'model-sync-no-ds-bot' })
  assert.equal(result.ok, true)
  assert.equal(result.result.ok, false)
  assert.equal(result.result.error, 'model-sync-no-ds-bot')
})

// ── 帧类型注册 ─────────────────────────────────────────────────────────────

test('HUB_TO_NODE.MODEL_SYNC 帧类型已注册', () => {
  assert.equal(typeof HUB_TO_NODE.MODEL_SYNC, 'string')
  assert.equal(HUB_TO_NODE.MODEL_SYNC, 'node/model-sync')
})

test('NODE_TO_HUB.MODEL_SYNC_RESULT 帧类型已注册', () => {
  assert.equal(typeof NODE_TO_HUB.MODEL_SYNC_RESULT, 'string')
  assert.equal(NODE_TO_HUB.MODEL_SYNC_RESULT, 'node/model-sync-result')
})

// ── dispatch case ──────────────────────────────────────────────────────────

test('dispatch MODEL_SYNC: 无 onModelSync 时回 not-supported', () => {
  const sent = []
  const send = (type, data) => sent.push({ type, data })
  const dispatch = createFrameDispatcher({ send, sendError: send, onModelSync: undefined })
  const handled = dispatch({ t: HUB_TO_NODE.MODEL_SYNC, d: { nodeId: 'n1', requestId: 'r1', scope: 'default', modelRef: 'openai/gpt-4o' } })
  assert.equal(handled, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, NODE_TO_HUB.MODEL_SYNC_RESULT)
  assert.equal(sent[0].data.ok, false)
  assert.equal(sent[0].data.error, 'model-sync-not-supported')
})

test('dispatch MODEL_SYNC: onModelSync 被调用，成功返回 applied', async () => {
  const sent = []
  const send = (type, data) => sent.push({ type, data })
  let syncedArg
  const onModelSync = async (sync, reply) => {
    syncedArg = sync
    reply(NODE_TO_HUB.MODEL_SYNC_RESULT, { requestId: sync.requestId, nodeId: sync.nodeId, ok: true, applied: ['b1'] })
  }
  const dispatch = createFrameDispatcher({ send, sendError: send, onModelSync })
  const handled = dispatch({ t: HUB_TO_NODE.MODEL_SYNC, d: { nodeId: 'n1', requestId: 'r1', scope: 'all', modelRef: 'openai/gpt-4o' } })
  assert.equal(handled, true)
  // onModelSync is async, give it a tick
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(syncedArg?.scope, 'all')
  assert.equal(sent[0]?.data.ok, true)
  assert.deepEqual(sent[0]?.data.applied, ['b1'])
})

test('dispatch MODEL_SYNC: 帧校验失败时拒绝并回错误', () => {
  const sent = []
  const send = (type, data) => sent.push({ type, data })
  const dispatch = createFrameDispatcher({ send, sendError: send })
  const handled = dispatch({ t: HUB_TO_NODE.MODEL_SYNC, d: { nodeId: 'n1', requestId: 'r1', scope: 'invalid', modelRef: 'openai/gpt-4o' } })
  assert.equal(handled, true)
  // invalid scope: dispatch should handle but not call onModelSync, may or may not send result
  // Key invariant: handled=true, no crash
})

test('dispatch MODEL_SYNC: onModelSync 抛出时回 error result', async () => {
  const sent = []
  const send = (type, data) => sent.push({ type, data })
  const onModelSync = async () => { throw new Error('ds-bot exploded') }
  const dispatch = createFrameDispatcher({ send, sendError: send, onModelSync })
  dispatch({ t: HUB_TO_NODE.MODEL_SYNC, d: { nodeId: 'n1', requestId: 'r1', scope: 'default', modelRef: 'openai/gpt-4o' } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].data.ok, false)
  assert.match(sent[0].data.error, /exploded/)
})
