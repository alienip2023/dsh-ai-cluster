// Phase 7: Sentinel out-of-process health check tests.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runSentinel } from '../lib/daemon/sentinel.js'

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-'))
  mkdirSync(join(dir, 'ac-state'), { recursive: true })
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('sentinel: all ok when state file is fresh', () => {
  const { dir, cleanup } = fresh()
  try {
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, '{}')
    const result = runSentinel({ dshHome: dir, now: Date.now })
    const check = result.checks.find(c => c.name === 'dsh-state-file')
    assert.ok(check, 'check exists')
    assert.equal(check.ok, true)
    assert.ok(result.ok)
  } finally { cleanup() }
})

test('sentinel: stale state file fails', () => {
  const { dir, cleanup } = fresh()
  try {
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, '{}')
    // Use a future clock so the file looks old.
    const result = runSentinel({ dshHome: dir, now: () => Date.now() + 10 * 60 * 1000 })
    const check = result.checks.find(c => c.name === 'dsh-state-file')
    assert.ok(check)
    assert.equal(check.ok, false)
  } finally { cleanup() }
})

test('sentinel: missing state file fails', () => {
  const { dir, cleanup } = fresh()
  try {
    const result = runSentinel({ dshHome: dir, now: Date.now })
    const check = result.checks.find(c => c.name === 'dsh-state-file')
    assert.ok(check)
    assert.equal(check.ok, false)
    assert.match(check.detail, /not found/)
  } finally { cleanup() }
})

test('sentinel: node heartbeat check passes when node is fresh', () => {
  const { dir, cleanup } = fresh()
  try {
    const connLog = join(dir, 'ac-state', 'connectivity.json')
    writeFileSync(connLog, JSON.stringify({ nodes: [{ nodeId: 'n1', lastSeen: Date.now() }] }))
    const result = runSentinel({ dshHome: dir, now: Date.now })
    const check = result.checks.find(c => c.name === 'node-heartbeats')
    assert.ok(check)
    assert.equal(check.ok, true)
    assert.match(check.detail, /1\/1/)
  } finally { cleanup() }
})

test('sentinel: node heartbeat check fails when all nodes are stale', () => {
  const { dir, cleanup } = fresh()
  try {
    const connLog = join(dir, 'ac-state', 'connectivity.json')
    const staleTs = Date.now() - 10 * 60 * 1000
    writeFileSync(connLog, JSON.stringify({ nodes: [{ nodeId: 'n1', lastSeen: staleTs }] }))
    const result = runSentinel({ dshHome: dir, now: Date.now })
    const check = result.checks.find(c => c.name === 'node-heartbeats')
    assert.ok(check)
    assert.equal(check.ok, false)
    assert.match(check.detail, /0\/1/)
  } finally { cleanup() }
})

test('sentinel: crash-loop check passes with few restarts', () => {
  const { dir, cleanup } = fresh()
  try {
    const restartLog = join(dir, 'ac-state', 'daemon-restarts.json')
    writeFileSync(restartLog, JSON.stringify({ restarts: [{ at: Date.now() }, { at: Date.now() }] }))
    const result = runSentinel({ dshHome: dir, now: Date.now })
    const check = result.checks.find(c => c.name === 'daemon-crash-loop')
    assert.ok(check)
    assert.equal(check.ok, true)
  } finally { cleanup() }
})

test('sentinel: crash-loop check fails with too many restarts', () => {
  const { dir, cleanup } = fresh()
  try {
    const restartLog = join(dir, 'ac-state', 'daemon-restarts.json')
    const restarts = Array.from({ length: 8 }, () => ({ at: Date.now() }))
    writeFileSync(restartLog, JSON.stringify({ restarts }))
    const result = runSentinel({ dshHome: dir, now: Date.now })
    const check = result.checks.find(c => c.name === 'daemon-crash-loop')
    assert.ok(check)
    assert.equal(check.ok, false)
    assert.match(check.detail, /8 restarts/)
  } finally { cleanup() }
})

test('sentinel: summary says all pass when everything is ok', () => {
  const { dir, cleanup } = fresh()
  try {
    writeFileSync(join(dir, 'state.json'), '{}')
    const result = runSentinel({ dshHome: dir, now: Date.now })
    assert.ok(result.ok)
    assert.match(result.summary, /pass/)
  } finally { cleanup() }
})
