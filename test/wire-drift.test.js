/**
 * lib/protocol.js is the live wire module; src/wire/* is the source copy the plugin graph is built from
 * (lib/plugin/wire is generated from it). They must stay identical in behaviour. This test compares the exported
 * names, the frame/error constants and the source text of every same-named function, so a change made in one
 * place only fails here instead of showing up as a protocol mismatch between two roles.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as lib from '../lib/protocol.js'
import * as wire from '../src/wire/index.js'
import * as transport from '../lib/node/transport.js'
import * as libWs from '../lib/ws.js'

/** Names that exist on one side only on purpose, with the reason and where the other side keeps them. */
const ONLY_IN_LIB = {
  BOT_ACTION_CAP: 'capability flags live in src/caps (the plugin graph) and in lib/protocol.js for the lib roles',
  BOT_MEMORY_UPDATE_CAP: 'capability flags: see BOT_ACTION_CAP',
  BOT_PROFILE_UPDATE_CAP: 'capability flags: see BOT_ACTION_CAP',
  BOT_TURN_MODE_CAP: 'capability flags: see BOT_ACTION_CAP',
  HUB_CAPS: 'capability flags: see BOT_ACTION_CAP',
  MEMORY_CAPS: 'capability flags: see BOT_ACTION_CAP',
  ROSTER_CARDS_CAP: 'capability flags: see BOT_ACTION_CAP',
  BOT_TRACE_CAP: 'capability flags: see BOT_ACTION_CAP',
  BOT_ATTACH_CAP: 'capability flags: see BOT_ACTION_CAP',
  CONFIG_MODELS_CAP: 'capability flags: see BOT_ACTION_CAP',
  nodeCaps: 'capability flags: see BOT_ACTION_CAP',
}
/** src/wire/index.js re-exports session-framing and ws; lib keeps those in lib/node/transport.js and lib/ws.js. */
const ONLY_IN_WIRE_LIVE_ELSEWHERE = {
  DUPLICATE_RETRY_DEFAULTS: transport, IDENTITY_GRACE_MS: transport, IDENTITY_MAX_SKEW_MS: transport,
  TRANSPORT_MODE: transport, checkE2EGate: transport, checkUplinkE2EGate: transport, duplicateBackoffMs: transport,
  isE2ERequired: transport, isE2ERequiredUplink: transport, normalizeWsUrl: transport, resolveDuplicateRetry: transport,
  WSConnection: libWs, acceptKey: libWs, acceptUpgrade: libWs, connect: libWs,
}

/**
 * Same-named exports that differ on purpose. test/phase1/wire-golden-vocab.test.js pins this: src/wire adds
 * ACL_DENIED (used by src/caps, which only the plugin graph loads); lib/protocol.js and lib/explain-error.js
 * do not know it. The test below still requires every OTHER code to agree.
 */
const DIFFERENT_ON_PURPOSE = { ERROR_CODE: { onlyInWire: ['ACL_DENIED'] } }

const same = (a, b) => (typeof a === 'function' ? a.toString() === b.toString() : JSON.stringify(a) === JSON.stringify(b))

test('DRIFT-1: every name exported by lib/protocol.js exists in src/wire, except the documented ones', () => {
  const missing = Object.keys(lib).filter((k) => !(k in wire) && !(k in ONLY_IN_LIB))
  assert.deepEqual(missing, [], 'exported by lib/protocol.js but not by src/wire')
  for (const k of Object.keys(ONLY_IN_LIB)) assert.ok(k in lib && !(k in wire), `allow-list entry ${k} is stale`)
})

test('DRIFT-2: every name exported by src/wire exists in lib/protocol.js or in its documented live home', () => {
  for (const k of Object.keys(wire)) {
    if (k in lib) continue
    const home = ONLY_IN_WIRE_LIVE_ELSEWHERE[k]
    assert.ok(home, `${k} is exported by src/wire only; add it to lib/protocol.js (or document where it lives)`)
    assert.ok(k in home, `${k}: documented home does not export it`)
    assert.ok(same(home[k], wire[k]), `${k}: the live copy differs from src/wire`)
  }
})

test('DRIFT-3: same-named constants and validators are identical (frame types, error codes, limits, every validate*)', () => {
  const different = []
  for (const k of Object.keys(lib)) {
    if (!(k in wire)) continue
    if (k in DIFFERENT_ON_PURPOSE) continue
    if (!same(lib[k], wire[k])) different.push(k)
  }
  assert.deepEqual(different, [], 'differs between lib/protocol.js and src/wire (fix the one that is wrong; both must agree)')
})

test('DRIFT-4: bot/directory keeps rooms on both sides', () => {
  const d = { bots: [{ id: 'b', name: 'B', nodeId: 'n' }], rooms: [{ id: 'r1', name: ' Room ', members: 3 }, { id: '' }], at: 5 }
  for (const impl of [lib, wire]) {
    assert.deepEqual(impl.validateBotDirectory(d), { bots: [{ id: 'b', name: 'B', nodeId: 'n', role: '' }], rooms: [{ id: 'r1', name: 'Room', members: 3 }], at: 5 })
  }
})

test('DRIFT-5: the intentional differences are exactly the documented ones', () => {
  const { onlyInWire } = DIFFERENT_ON_PURPOSE.ERROR_CODE
  const rest = { ...wire.ERROR_CODE }
  for (const k of onlyInWire) { assert.ok(k in rest, `${k} left src/wire: drop it from the allow-list`); delete rest[k] }
  assert.deepEqual(rest, { ...lib.ERROR_CODE })
  for (const k of onlyInWire) assert.equal(k in lib.ERROR_CODE, false)
})
