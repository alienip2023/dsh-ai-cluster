// P2 Webhook store 测试
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWebhookStore, generateWebhookToken } from '../src/http/webhook-store.js'

function fakeRegistry(online = true) {
  const turns = []
  return {
    turns,
    getNode: (nodeId) => online ? { nodeId } : undefined,
    startBotTurn: (nodeId, botId, text) => {
      const exchangeId = `ex_${turns.length}`
      turns.push({ nodeId, botId, text, exchangeId })
      return { ok: true, exchangeId }
    },
  }
}

function store(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-webhook-'))
  const registry = opts.registry ?? fakeRegistry()
  const s = createWebhookStore({ stateDir: dir, registry, log: () => {} })
  return { s, dir, registry }
}

test('generateWebhookToken: 生成 url-safe base64 字符串', () => {
  const t = generateWebhookToken()
  assert.equal(typeof t, 'string')
  assert.ok(t.length >= 30)
  assert.match(t, /^[A-Za-z0-9_-]+$/)
})

test('create: 返回明文 token 和 id，list 不暴露 token', () => {
  const { s } = store()
  const result = s.create({ nodeId: 'n1', botId: 'b1', name: '测试' })
  assert.ok(result.id.startsWith('wh_'))
  assert.ok(typeof result.token === 'string' && result.token.length > 20)
  const listed = s.list()
  assert.equal(listed.length, 1)
  assert.ok(!('token' in listed[0]))
  assert.ok(!('tokenHash' in listed[0]))
  assert.equal(listed[0].nodeId, 'n1')
  assert.equal(listed[0].botId, 'b1')
  assert.equal(listed[0].name, '测试')
})

test('create: nodeId 缺失返回 error', () => {
  const { s } = store()
  assert.equal(s.create({ botId: 'b1' }).error, 'webhook-nodeId-missing')
})

test('fire: 正确 token 派发成功并更新计数', () => {
  const { s, registry } = store()
  const { token } = s.create({ nodeId: 'n1', botId: 'b1' })
  const result = s.fire(token, 'hello from webhook')
  assert.equal(result.ok, true)
  assert.ok(typeof result.exchangeId === 'string')
  assert.equal(registry.turns.length, 1)
  assert.equal(registry.turns[0].text, 'hello from webhook')
  assert.equal(s.list()[0].fireCount, 1)
  assert.ok(s.list()[0].lastFiredAt !== null)
})

test('fire: 错误 token 拒绝', () => {
  const { s } = store()
  s.create({ nodeId: 'n1', botId: 'b1' })
  const result = s.fire('wrong-token', 'hi')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'webhook-token-invalid')
})

test('fire: 空 text 拒绝', () => {
  const { s } = store()
  const { token } = s.create({ nodeId: 'n1', botId: 'b1' })
  assert.equal(s.fire(token, '').ok, false)
  assert.equal(s.fire(token, '   ').ok, false)
})

test('fire: node 离线返回 node-offline', () => {
  const registry = fakeRegistry(false)
  const { s } = store({ registry })
  const { token } = s.create({ nodeId: 'n1', botId: 'b1' })
  const result = s.fire(token, 'hello')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'webhook-node-offline')
})

test('remove: 删除后 token 失效', () => {
  const { s } = store()
  const { id, token } = s.create({ nodeId: 'n1', botId: 'b1' })
  assert.equal(s.remove(id), true)
  assert.equal(s.list().length, 0)
  assert.equal(s.fire(token, 'hi').ok, false)
})

test('remove: 不存在的 id 返回 false', () => {
  const { s } = store()
  assert.equal(s.remove('wh_nonexistent'), false)
})

test('持久化：重新加载后 webhook 仍在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-webhook-persist-'))
  const registry = fakeRegistry()
  const s1 = createWebhookStore({ stateDir: dir, registry, log: () => {} })
  const { token } = s1.create({ nodeId: 'n1', botId: 'b1', name: '持久' })
  // 重新加载同一目录
  const s2 = createWebhookStore({ stateDir: dir, registry, log: () => {} })
  assert.equal(s2.list().length, 1)
  assert.equal(s2.list()[0].name, '持久')
  // token 仍然有效
  assert.equal(s2.fire(token, 'hi').ok, true)
  rmSync(dir, { recursive: true, force: true })
})

test('常量时间比较：不同长度 token 不崩溃', () => {
  const { s } = store()
  s.create({ nodeId: 'n1', botId: 'b1' })
  assert.equal(s.fire('', 'hi').ok, false)
  assert.equal(s.fire('a'.repeat(1000), 'hi').ok, false)
})
