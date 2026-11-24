/**
 * The "must be encrypted" lists. Three copies exist (lib/node/transport.js is the live one;
 * src/wire/session-framing.js and src/link/transport.js are the parallel source copies) and they
 * drifted before: node/model-sync, hub/approval-answer, node/approval-* and the bot/*-result
 * receipts were missing from the live list, so a plaintext copy of them was accepted.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import * as live from '../lib/node/transport.js'
import * as wire from '../src/wire/session-framing.js'
import * as link from '../src/link/transport.js'
import { HUB_TO_NODE, NODE_TO_HUB } from '../lib/protocol.js'

const impls = { 'lib/node/transport.js': live, 'src/wire/session-framing.js': wire, 'src/link/transport.js': link }

/** Every constant in `frames.js`-style source whose doc comment says it MUST be encrypted. */
function constantsMarkedMustEncrypt(file) {
  const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const out = []
  // a block comment immediately followed by `KEY: 'value'`
  for (const m of src.matchAll(/\/\*\*([\s\S]*?)\*\/\s*([A-Z_]+):\s*'([^']+)'/g)) {
    if (m[1].includes('必须加密')) out.push({ key: m[2], value: m[3] })
  }
  return out
}

for (const file of ['src/wire/frames.js', 'lib/protocol.js']) {
  test(`every frame constant marked "必须加密" in ${file} is in each E2E_REQUIRED list`, () => {
    const marked = constantsMarkedMustEncrypt(file)
    assert.ok(marked.length >= 6, `parsed the comments (${marked.length} constants)`)
    for (const [name, impl] of Object.entries(impls)) {
      for (const { key, value } of marked) {
        assert.equal(impl.isE2ERequired(value), true, `${name}: ${key} (${value}) is documented as must-encrypt`)
      }
    }
  })
}

test('the frames the audit found missing are required in every copy', () => {
  const must = [
    HUB_TO_NODE.MODEL_SYNC, NODE_TO_HUB.MODEL_SYNC_RESULT, HUB_TO_NODE.APPROVAL_ANSWER,
    NODE_TO_HUB.APPROVAL_REQUEST, NODE_TO_HUB.APPROVAL_SETTLED, HUB_TO_NODE.BOT_DELETE,
    NODE_TO_HUB.BOT_CREATE_RESULT, NODE_TO_HUB.BOT_HISTORY_RESULT, NODE_TO_HUB.BOT_UPDATE_RESULT,
    NODE_TO_HUB.BOT_DELETE_RESULT, NODE_TO_HUB.BOT_STOP_RESULT, NODE_TO_HUB.BOT_ACTION_RESULT,
    NODE_TO_HUB.NODE_CONFIG_RESULT,
  ]
  for (const [name, impl] of Object.entries(impls)) for (const t of must) assert.equal(impl.isE2ERequired(t), true, `${name}: ${t}`)
})

test('the three copies agree on every known frame type (downlink and uplink)', () => {
  const all = new Set([...Object.values(HUB_TO_NODE), ...Object.values(NODE_TO_HUB)])
  for (const t of all) {
    const down = new Set(Object.values(impls).map((i) => i.isE2ERequired(t)))
    const up = new Set(Object.values(impls).map((i) => i.isE2ERequiredUplink(t)))
    assert.equal(down.size, 1, `downlink list drifted for ${t}`)
    assert.equal(up.size, 1, `uplink list drifted for ${t}`)
  }
})

test('the handshake and liveness frames are never required (they must work before a session exists)', () => {
  for (const impl of Object.values(impls)) {
    for (const t of ['hello', 'hello/node', 'ping', 'pong', 'error', 'welcome', 'hub/identity', 'hub/e2e', NODE_TO_HUB.E2E_OFFER]) {
      assert.equal(impl.isE2ERequired(t), false, `${t} downlink`)
      assert.equal(impl.isE2ERequiredUplink(t), false, `${t} uplink`)
    }
  }
})

test('every node->hub bot/* result is required on the uplink too', () => {
  for (const impl of Object.values(impls)) {
    for (const [key, t] of Object.entries(NODE_TO_HUB)) {
      if (key.startsWith('BOT_')) assert.equal(impl.isE2ERequiredUplink(t), true, `${t}`)
    }
    const gate = impl.checkUplinkE2EGate({ t: NODE_TO_HUB.ROSTER }, { e2e: true, wasEncrypted: false })
    assert.equal(gate.rejected, true)
    assert.equal(impl.checkUplinkE2EGate({ t: NODE_TO_HUB.ROSTER }, { e2e: true, wasEncrypted: true }).rejected, false)
    assert.equal(impl.checkUplinkE2EGate({ t: NODE_TO_HUB.ROSTER }, { e2e: false, wasEncrypted: false }).rejected, false)
  }
})
