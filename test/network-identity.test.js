// test/network-identity.test.js — unit tests for Step 1+2 new modules

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MachineIdentity, deriveMachineId, generateMachineIdentity } from '../lib/identity/machine-identity.js'
import { TrustStore } from '../lib/network/pairing/trust-store.js'
import { AgentJournal } from '../lib/persist/agent-journal.js'
import { Checkpoint } from '../lib/persist/checkpoint.js'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-test-'))
}

describe('machine-identity', () => {
  test('generates stable ID from public key', () => {
    const { id, publicKeyB64 } = generateMachineIdentity()
    assert.equal(id.length, 16)
    assert.equal(id, deriveMachineId(publicKeyB64))
  })

  test('loads existing identity from disk', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'identity.json')
      const a = new MachineIdentity(path)
      const b = new MachineIdentity(path)
      assert.equal(a.id, b.id)
      assert.equal(a.publicKeyB64, b.publicKeyB64)
    } finally { rmSync(dir, { recursive: true }) }
  })

  test('sign and verify roundtrip', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'identity.json')
      const identity = new MachineIdentity(path)
      const data = Buffer.from('hello-dsh-network')
      const sig = identity.sign(data)
      assert.ok(MachineIdentity.verify(identity.publicKeyB64, data, sig))
      // Wrong data should fail
      assert.ok(!MachineIdentity.verify(identity.publicKeyB64, Buffer.from('tampered'), sig))
    } finally { rmSync(dir, { recursive: true }) }
  })

  test('descriptor contains id and publicKeyB64', () => {
    const dir = tmpDir()
    try {
      const identity = new MachineIdentity(join(dir, 'identity.json'))
      const desc = identity.descriptor()
      assert.equal(desc.id, identity.id)
      assert.equal(desc.publicKeyB64, identity.publicKeyB64)
    } finally { rmSync(dir, { recursive: true }) }
  })
})

describe('trust-store', () => {
  test('stores and retrieves a trust record', () => {
    const dir = tmpDir()
    try {
      const store = new TrustStore(join(dir, 'trust.json'))
      store.set({ peerId: 'abc123', peerPubKeyB64: 'pubkey==', secret: 'deadbeef', pairedAt: 1, lastSeen: 1 })
      const rec = store.get('abc123')
      assert.equal(rec.peerId, 'abc123')
      assert.equal(rec.secret, 'deadbeef')
    } finally { rmSync(dir, { recursive: true }) }
  })

  test('persists across instances', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'trust.json')
      const a = new TrustStore(path)
      a.set({ peerId: 'peer1', peerPubKeyB64: 'pub==', secret: 'sec', pairedAt: 1, lastSeen: 1 })
      const b = new TrustStore(path)
      assert.ok(b.has('peer1'))
      assert.equal(b.secretFor('peer1'), 'sec')
    } finally { rmSync(dir, { recursive: true }) }
  })

  test('removes a record', () => {
    const dir = tmpDir()
    try {
      const store = new TrustStore(join(dir, 'trust.json'))
      store.set({ peerId: 'x', peerPubKeyB64: 'p', secret: 's', pairedAt: 1, lastSeen: 1 })
      store.remove('x')
      assert.ok(!store.has('x'))
    } finally { rmSync(dir, { recursive: true }) }
  })
})

describe('agent-journal', () => {
  test('writes and reads back incomplete turn', () => {
    const dir = tmpDir()
    try {
      const journal = new AgentJournal('bot-test-1', dir)
      journal.turnStart({ exchangeId: 'xid-1', text: 'hello' })
      journal.stepModel({ exchangeId: 'xid-1', stepIdx: 1 })
      journal.stepTool({ exchangeId: 'xid-1', stepIdx: 2, name: 'bash', args: 'echo hi' })
      journal.close()

      const j2 = new AgentJournal('bot-test-1', dir)
      const incomplete = j2.findIncomplete()
      assert.ok(incomplete !== null)
      assert.equal(incomplete.exchangeId, 'xid-1')
      assert.equal(incomplete.steps.length, 2)
      j2.close()
    } finally { rmSync(dir, { recursive: true }) }
  })

  test('completed turn is not returned as incomplete', () => {
    const dir = tmpDir()
    try {
      const journal = new AgentJournal('bot-test-2', dir)
      journal.turnStart({ exchangeId: 'xid-2' })
      journal.stepModel({ exchangeId: 'xid-2', stepIdx: 1 })
      journal.turnEnd({ exchangeId: 'xid-2', reason: 'completed' })
      journal.close()

      const j2 = new AgentJournal('bot-test-2', dir)
      const incomplete = j2.findIncomplete()
      assert.equal(incomplete, null)
      j2.close()
    } finally { rmSync(dir, { recursive: true }) }
  })
})

describe('checkpoint', () => {
  test('save and load roundtrip', () => {
    const dir = tmpDir()
    try {
      const cp = new Checkpoint('bot-cp-1', dir)
      cp.save({ journalSeq: 42, state: { foo: 'bar' } })
      const loaded = cp.load()
      assert.equal(loaded.journalSeq, 42)
      assert.deepEqual(loaded.state, { foo: 'bar' })
    } finally { rmSync(dir, { recursive: true }) }
  })

  test('returns null when no checkpoint exists', () => {
    const dir = tmpDir()
    try {
      const cp = new Checkpoint('bot-cp-2', dir)
      assert.equal(cp.load(), null)
    } finally { rmSync(dir, { recursive: true }) }
  })

  test('atomic save: second load returns latest', () => {
    const dir = tmpDir()
    try {
      const cp = new Checkpoint('bot-cp-3', dir)
      cp.save({ journalSeq: 1, state: { v: 1 } })
      cp.save({ journalSeq: 2, state: { v: 2 } })
      const loaded = cp.load()
      assert.equal(loaded.journalSeq, 2)
      assert.equal(loaded.state.v, 2)
    } finally { rmSync(dir, { recursive: true }) }
  })
})
