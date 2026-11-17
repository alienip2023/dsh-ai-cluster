import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MEMORY } from '../../src/wire/index.js'
import { MEMORY_CAPS } from '../../src/caps/index.js'
import { SCOPE_KINDS, createMemoryLink, isScopeKind } from '../../src/sync/memory.js'

function onlineLink(sent) {
  const link = createMemoryLink({
    nodeId: 'n1',
    send: (type, data) => { sent.push({ type, data }); return true },
    hubCaps: () => [MEMORY_CAPS],
    e2eReady: () => true,
  })
  link.online()
  sent.length = 0
  return link
}

test('clusterBot is reserved: read and write throw E_SCOPE_RESERVED, nothing sent, nothing on disk', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-reserved-'))
  try {
    const sent = []
    const link = onlineLink(sent)
    const before = link.stats
    const base = { requestId: 'r1', remoteBotId: 'b1', scope: 'clusterBot' }
    assert.throws(() => link.read(base), { code: 'E_SCOPE_RESERVED' })
    assert.throws(() => link.write({ ...base, op: 'add', text: 't' }), { code: 'E_SCOPE_RESERVED' })
    assert.throws(() => link.send(MEMORY.READ, base), { code: 'E_SCOPE_RESERVED' })
    assert.throws(() => link.send(MEMORY.WRITE, { ...base, op: 'add', text: 't' }), { code: 'E_SCOPE_RESERVED' })
    assert.equal(sent.length, 0)
    assert.deepEqual(link.stats, before)
    assert.deepEqual(fs.readdirSync(state), [], 'no directory or file created under the temp state dir')
  } finally {
    fs.rmSync(state, { recursive: true, force: true })
  }
})

test('the four existing kinds still pass validation and are sent', () => {
  assert.deepEqual([...SCOPE_KINDS], ['team', 'node', 'bot', 'own', 'clusterBot'])
  for (const kind of ['team', 'node', 'bot', 'own', 'clusterBot']) assert.equal(isScopeKind(kind), true, kind)
  assert.equal(isScopeKind('nope'), false)
  for (const scope of ['team', 'node', 'bot', 'own']) {
    const sent = []
    const link = onlineLink(sent)
    assert.equal(link.read({ requestId: 'r', remoteBotId: 'b', scope }), true, scope)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].data.scope, scope)
  }
})
