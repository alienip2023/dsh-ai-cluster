/** invariant W1：新 wire 与旧 lib/protocol.js 的词表、错误码、常量逐项相等。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as oldP from '../../lib/protocol.js'
import * as newW from '../../src/wire/index.js'

test('HUB_TO_NODE / NODE_TO_HUB 序列化后与旧表逐字节相同', () => {
  assert.equal(JSON.stringify(newW.HUB_TO_NODE), JSON.stringify(oldP.HUB_TO_NODE))
  assert.equal(JSON.stringify(newW.NODE_TO_HUB), JSON.stringify(oldP.NODE_TO_HUB))
})

test('ERROR_CODE 与旧表相同，仅多 ACL_DENIED', () => {
  const { ACL_DENIED, ...rest } = newW.ERROR_CODE
  assert.equal(ACL_DENIED, 'acl-denied')
  assert.deepEqual(rest, { ...oldP.ERROR_CODE })
  assert.equal(Object.keys(newW.ERROR_CODE).length, Object.keys(oldP.ERROR_CODE).length + 1)
})

test('PROTOCOL_VERSION 与块大小/上限常量不变', () => {
  assert.equal(newW.PROTOCOL_VERSION, 1)
  assert.equal(newW.PROTOCOL_VERSION, oldP.PROTOCOL_VERSION)
  assert.equal(newW.ARTIFACT_CHUNK_BYTES, 256 * 1024)
  for (const k of ['ARTIFACT_CHUNK_BYTES', 'MAX_CONTROL_FRAME_BYTES', 'MAX_ARTIFACT_FRAME_BYTES', 'DEFAULT_HEARTBEAT_MS',
    'DEFAULT_ACK_TIMEOUT_MS', 'DEFAULT_PULL_TIMEOUT_MS', 'MAX_MEMORY_FRAME_BYTES']) {
    assert.equal(newW[k], oldP[k], k)
  }
  for (const k of ['PEER', 'RELAY_FRAME', 'TASK_STATUS', 'TASK_MODE', 'ARTIFACT_ROLE', 'ARTIFACT_KIND', 'MEMORY']) {
    assert.deepEqual({ ...newW[k] }, { ...oldP[k] }, k)
  }
})

test('除 caps 常量（归 slice 2）外，旧 protocol 的导出在新 wire 里都有', () => {
  const caps = new Set(['nodeCaps', 'MEMORY_CAPS', 'HUB_CAPS', 'BOT_MEMORY_UPDATE_CAP', 'BOT_PROFILE_UPDATE_CAP', 'BOT_TURN_MODE_CAP', 'BOT_ACTION_CAP', 'ROSTER_CARDS_CAP', 'BOT_TRACE_CAP', 'BOT_STREAM_CAP', 'BOT_ATTACH_CAP', 'CONFIG_MODELS_CAP'])
  const missing = Object.keys(oldP).filter((k) => !caps.has(k) && !(k in newW))
  assert.deepEqual(missing, [])
  for (const k of caps) assert.equal(k in newW, false, `${k} 不得出现在 wire`)
})

test('normalizePeerUrl 只认新对端路径', () => {
  assert.equal(newW.normalizePeerUrl('wss://h.example/api/remote-agent/peer'), 'wss://h.example/api/remote-agent/peer')
  assert.equal(newW.normalizePeerUrl('wss://h.example/api/ai-cluster/peer'), '')
})
