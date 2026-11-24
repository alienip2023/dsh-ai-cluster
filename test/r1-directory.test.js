// R1（重写 2026-11-24）：全队目录带上 identityId / 机器名 / 在线 / 状态 / 模型，以及整张机器列表；
// 节点发出的 bot/message 由节点身份簿给发送方补上 identityId（不信宿主自报）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOT_DIRECTORY_MAX_MACHINES, BOT_DIRECTORY_STATES, validateBotDirectory, validateBotMessage } from '../lib/protocol.js'
import { createBotNetwork } from '../lib/node/bot-network.js'

const ID = '0123456789abcdef'

test('R1-1 directory keeps identityId, hostname, online, state, model per Bot', () => {
  const out = validateBotDirectory({
    bots: [{ id: 'joined:n1:a', name: 'A', nodeId: 'n1', role: 'dev', identityId: ID, hostname: ' box-1 ', online: false, state: 'working', model: 'deepseek/v4' }],
  })
  assert.deepEqual(out.bots, [{ id: 'joined:n1:a', name: 'A', nodeId: 'n1', role: 'dev', identityId: ID, hostname: 'box-1', online: false, state: 'working', model: 'deepseek/v4' }])
  assert.equal('machines' in out, false, 'no machines key when the sender sent none')
})

test('R1-2 directory drops bad optional Bot fields but keeps the Bot', () => {
  const out = validateBotDirectory({
    bots: [{ id: 'b', name: 'B', nodeId: 'hub', identityId: 'NOT-HEX', hostname: 5, online: 'yes', state: 'sleeping', model: '' }],
  })
  assert.deepEqual(out.bots, [{ id: 'b', name: 'B', nodeId: 'hub', role: '' }])
})

test('R1-3 directory machines: valid ones rebuilt, bad ones dropped, capped', () => {
  const out = validateBotDirectory({
    bots: [],
    machines: [
      { nodeId: 'hub', hostname: 'mac', os: 'darwin', online: true, role: 'hub', acVersion: '0.4.33', lastSeen: 5, rttMs: 3.6, secret: 'x' },
      { nodeId: 'n1', online: 'yes', role: 'king' },
      { hostname: 'no-id' },
      null,
    ],
  })
  assert.deepEqual(out.machines, [
    { nodeId: 'hub', hostname: 'mac', online: true, os: 'darwin', acVersion: '0.4.33', role: 'hub', lastSeen: 5, rttMs: 4 },
    { nodeId: 'n1', hostname: 'n1', online: false },
  ])
  const many = validateBotDirectory({ bots: [], machines: Array.from({ length: 80 }, (_, i) => ({ nodeId: 'n' + i })) })
  assert.equal(many.machines.length, BOT_DIRECTORY_MAX_MACHINES)
  assert.deepEqual([...BOT_DIRECTORY_STATES], ['available', 'working', 'waiting', 'offline'])
})

test('R1-4 bot/message carries a valid identityId on from/to and drops a bad one', () => {
  const msg = validateBotMessage({
    exchangeId: 'x', kind: 'ask', text: 'hi', depth: 0,
    from: { id: 'a', name: 'A', nodeId: 'n1', identityId: ID },
    to: { id: 'b', name: 'B', nodeId: 'n2', identityId: 'zz' },
  })
  assert.equal(msg.from.identityId, ID)
  assert.equal('identityId' in msg.to, false)
})

test('R1-5 node directory event carries the machine list', () => {
  const network = createBotNetwork({ nodeId: 'n1' })
  let got
  network.on('directory', value => { got = value })
  network.receiveDirectory({ bots: [{ id: 'b', name: 'B', nodeId: 'n2', identityId: ID }], rooms: [], machines: [{ nodeId: 'n2', hostname: 'box-2', online: true }] })
  assert.deepEqual(got.machines, [{ nodeId: 'n2', hostname: 'box-2', online: true }])
  assert.deepEqual(network.machines(), got.machines)
  network.dispose()
  assert.deepEqual(network.machines(), [])
})

test('R1-6 node send() stamps the sender identityId from the identity book, not from the host', () => {
  const sent = []
  const network = createBotNetwork({ nodeId: 'n1', send: (type, data) => { sent.push({ type, data }); return true }, identityOf: id => (id === 'a' ? ID : undefined) })
  assert.equal(network.send({ exchangeId: 'x', kind: 'ask', text: 'hi', from: { id: 'a', name: 'A', nodeId: 'n1', identityId: 'ffffffffffffffff' }, to: { id: 'b', name: 'B', nodeId: 'n2' } }), true)
  assert.equal(sent[0].data.from.identityId, ID)
  // A Bot the book does not know gets no identityId, whatever the host claims.
  network.send({ exchangeId: 'y', kind: 'ask', text: 'hi', from: { id: 'c', name: 'C', nodeId: 'n1', identityId: ID }, to: { id: 'b', name: 'B', nodeId: 'n2' } })
  assert.equal('identityId' in sent[1].data.from, false)
  network.dispose()
})
