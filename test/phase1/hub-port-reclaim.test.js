import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { applyHub } from '../../lib/hub/index.js'
import {
  clearLock, decideReclaim, holderResponds, isAlive, listenersOf, lockPath, profileTag, readLock, reclaimPort, terminate, writeLock,
} from '../../lib/hub/instance-lock.js'
import { makeCtx } from './_plugin-ctx.js'

const host = '127.0.0.1'
const selfPid = process.pid
const version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const matchingLock = (pid, port, tag = profileTag()) => ({
  pid, port, host, profileTag: tag, version, startedAt: new Date().toISOString(),
})
const harnessCommand = () => 'DeepSeek Harness'

const OLD = new Date(Date.now() - 3_600_000).toISOString()
const selfStartedAtMs = Date.now() - 1000
const decisionInput = {
  lock: { ...matchingLock(202, 19387), startedAt: OLD },
  port: 19387,
  selfPid: 101,
  selfAncestors: [],
  profileTag: profileTag(),
  isAlive: () => true,
  commandLine: harnessCommand,
  waitedMs: 60_000,
  listeners: () => [202],
  selfStartedAtMs,
  holderResponsive: false,
}

for (const [reason, action, overrides] of [
  ['no-lock', 'wait', { lock: null }],
  ['port-mismatch', 'wait', { port: 19388 }],
  ['self', 'none', { selfPid: 202 }],
  ['ancestor', 'wait', { selfAncestors: [201, 202, 203] }],
  ['stale-lock-dead-pid', 'wait', { isAlive: () => false }],
  ['foreign-profile', 'wait', { profileTag: 'different' }],
  ['foreign-process', 'wait', { commandLine: () => 'node' }],
  // Waiting is the default; anything that is not proof of a stale instance keeps it that way.
  ['grace', 'wait', { waitedMs: 5_000 }],
  ['grace', 'wait', { waitedMs: undefined }],
  ['not-listener', 'wait', { listeners: () => [999] }],
  ['not-listener', 'wait', { listeners: () => undefined }],
  ['not-older', 'wait', { lock: { ...matchingLock(202, 19387), startedAt: new Date(Date.now() + 5000).toISOString() } }],
  ['not-older', 'wait', { selfStartedAtMs: undefined }],
  ['responsive', 'wait', { holderResponsive: true }],
  ['unprobed', 'wait', { holderResponsive: undefined }],
  ['stale-hub-instance', 'reclaim', {}],
]) {
  test(`decideReclaim: ${action} / ${reason}${Object.keys(overrides).length ? ` (${Object.keys(overrides).join(',')})` : ''}`, () => {
    assert.deepEqual(decideReclaim({ ...decisionInput, ...overrides }), { action, reason })
  })
}

function temporaryHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-port-reclaim-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('lock: path, profile tag, mode, parsing and owner-only cleanup', (t) => {
  const dir = temporaryHome(t)
  const file = lockPath(dir)
  const lock = matchingLock(selfPid, 19387, profileTag(dir))
  assert.equal(file, path.join(dir, '.dsh', 'ai-cluster', 'hub.lock.json'))
  assert.equal(lockPath(dir, 19387), path.join(dir, '.dsh', 'ai-cluster', 'hub-19387.lock.json'))
  assert.equal(profileTag('/example', {}), '99d0533064c8')
  assert.notEqual(profileTag('/example', { DSH_PROFILE: 'web' }), profileTag('/example', { DSH_PROFILE: 'desktop' }), 'two profiles of one user are two instances')
  assert.notEqual(profileTag('/example', {}, '/example/.dsh/profiles/desktop'), profileTag('/example', {}, '/example/.dsh/profiles/safe'), 'desktop profiles carry no env: the resolved profile directory tells them apart')
  assert.equal(profileTag('/example', {}, ''), '99d0533064c8', 'no resolvable profile keeps the old tag')
  assert.equal(readLock(file), null)
  assert.equal(writeLock(file, lock), file)
  assert.deepEqual(readLock(file), lock)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['hub.lock.json'])
  assert.equal(clearLock(file, selfPid + 1), false)
  assert.deepEqual(readLock(file), lock)
  assert.equal(clearLock(file, selfPid), true)
  assert.equal(clearLock(file, selfPid), false)
  fs.writeFileSync(file, '{')
  assert.equal(readLock(file), null)
  assert.equal(clearLock(file, undefined), false)
  assert.equal(fs.readFileSync(file, 'utf8'), '{')
  for (const [key, value] of Object.entries({
    pid: '202', port: '19387', host: null, profileTag: 0, version: [], startedAt: {},
  })) {
    fs.writeFileSync(file, JSON.stringify({ ...lock, [key]: value }))
    assert.equal(readLock(file), null, key)
  }
})

test('reclaimPort: pid ≤ 1 waits without probing or signaling', async () => {
  for (const pid of [-1, 0, 1]) {
    const unexpected = () => assert.fail('invalid pid was used')
    assert.deepEqual(await reclaimPort({
      lock: matchingLock(pid, 19387), port: 19387, selfPid, selfAncestors: [],
      isAlive: unexpected, commandLine: unexpected, kill: unexpected,
    }), { killed: false, reason: 'invalid-pid' })
  }
})

test('reclaimPort: EPERM waits without sending any signal', async (t) => {
  const probe = t.mock.method(process, 'kill', (_pid, signal) => {
    assert.equal(signal, 0)
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
  })
  assert.equal(isAlive(202), true)
  assert.deepEqual(await reclaimPort({
    lock: matchingLock(202, 19387), port: 19387, selfPid, selfAncestors: [],
    commandLine: harnessCommand, kill: () => assert.fail('signal after EPERM'),
  }), { killed: false, reason: 'permission-denied' })
  assert.equal(probe.mock.callCount(), 2)
})

test('reclaimPort: unavailable command line waits without sending any signal', async () => {
  assert.deepEqual(await reclaimPort({
    lock: matchingLock(202, 19387), port: 19387, selfPid, selfAncestors: [],
    isAlive: () => true, commandLine: () => '', kill: () => assert.fail('SIGKILL without command line'),
  }), { killed: false, reason: 'foreign-process' })
})

async function occupyPort(t) {
  const child = spawn(process.execPath, ['-e', `
    const server = require('net').createServer()
    server.listen(0, ${JSON.stringify(host)}, () => console.log(server.address().port))
  `, 'DeepSeek Harness'], { stdio: ['ignore', 'pipe', 'inherit'] })
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  const [port] = await Promise.race([
    once(child.stdout, 'data').then(([data]) => [Number(String(data).trim())]),
    closed.then(([code, signal]) => assert.fail(`listener exited before binding: ${code} ${signal}`)),
  ])
  assert.ok(Number.isInteger(port) && port > 0)
  return { child, port, closed }
}

async function bindAgain(port) {
  const deadline = Date.now() + 3000
  for (;;) {
    const server = net.createServer()
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
      return
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || Date.now() >= deadline) throw err
      await delay(25)
    }
  }
}

// A process that only holds the port (no HTTP): what a hung instance looks like from outside.
const reclaimInput = (child, port, extra = {}) => ({
  lock: { ...matchingLock(child.pid, port), startedAt: OLD }, port, selfPid, selfAncestors: [], commandLine: harnessCommand,
  waitedMs: 60_000, selfStartedAtMs, holderResponsive: false, termWaitMs: 800, ...extra,
})

test('integration: a matching, silent, older listener is terminated and its port is released within 3 seconds', { timeout: 7000 }, async (t) => {
  const { child, port, closed } = await occupyPort(t)
  assert.deepEqual(await listenersOf(port) ?? [child.pid], [child.pid], 'lsof names the child as the listener')
  assert.deepEqual(await reclaimPort(reclaimInput(child, port)), { killed: true, reason: 'stale-hub-instance', signal: 'SIGTERM' })
  await bindAgain(port)
  assert.deepEqual(await closed, [null, 'SIGTERM'])
})

test('integration: a listener that ignores SIGTERM is killed after the grace', { timeout: 9000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {})
    const server = require('net').createServer()
    server.listen(0, ${JSON.stringify(host)}, () => console.log(server.address().port))
    setInterval(() => {}, 1000)
  `, 'DeepSeek Harness'], { stdio: ['ignore', 'pipe', 'inherit'] })
  const closed = once(child, 'close')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed })
  const [data] = await once(child.stdout, 'data')
  const port = Number(String(data).trim())
  const result = await reclaimPort(reclaimInput(child, port, { termWaitMs: 400 }))
  assert.deepEqual(result, { killed: true, reason: 'stale-hub-instance', signal: 'SIGKILL' })
  assert.deepEqual(await closed, [null, 'SIGKILL'])
})

for (const [name, reason, overrides] of [
  ['红刀 A: wrong profile', 'foreign-profile', ({ lock }) => ({ lock: { ...lock, profileTag: 'different' } })],
  ['红刀 B: ancestor PID', 'ancestor', ({ lock }) => ({ selfAncestors: [lock.pid] })],
  ['红刀 C: foreign command', 'foreign-process', () => ({ commandLine: () => 'node' })],
  ['红刀 D: the holder still answers (a healthy instance)', 'responsive', () => ({ holderResponsive: true })],
  ['红刀 E: the port has not been held long enough', 'grace', () => ({ waitedMs: 3_000 })],
  ['红刀 F: the lock names a pid that is not the listener', 'not-listener', () => ({ listeners: () => [1234567] })],
  ['红刀 G: the holder is newer than this process', 'not-older', ({ lock }) => ({ lock: { ...lock, startedAt: new Date(Date.now() + 60_000).toISOString() } })],
]) {
  test(`${name} returns killed:false and the child stays alive`, { timeout: 5000 }, async (t) => {
    const { child, port } = await occupyPort(t)
    const input = reclaimInput(child, port)
    assert.deepEqual(await reclaimPort({ ...input, ...overrides(input), kill: () => assert.fail('a signal was sent') }), { killed: false, reason })
    assert.equal(process.kill(child.pid, 0), true)
    assert.equal(child.signalCode, null)
  })
}

test('holderResponds: a hub-like HTTP server answers, a silent or closed port does not', { timeout: 15000 }, async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('{"ok":true}') })
  await new Promise(resolve => server.listen(0, host, resolve))
  t.after(() => server.close())
  assert.equal(await holderResponds({ host, port: server.address().port, path: '/health', timeoutMs: 1000 }), true)
  const { port: silentPort } = await occupyPort(t)
  assert.equal(await holderResponds({ host, port: silentPort, path: '/health', timeoutMs: 400 }), false)
  const closedPort = await new Promise(resolve => { const s = net.createServer(); s.listen(0, host, () => { const p = s.address().port; s.close(() => resolve(p)) }) })
  assert.equal(await holderResponds({ host, port: closedPort, path: '/health', timeoutMs: 400 }), false)
})

test('terminate: a signal that cannot be sent is not a kill', async () => {
  assert.deepEqual(await terminate(4242, { kill: () => false, isAlive: () => true, termWaitMs: 10 }), { killed: false, signal: 'SIGTERM' })
})

test('hub: waiting-port reclaims a silent stale listener, records the new owner and clears it on dispose', { timeout: 40000 }, async (t) => {
  const { child, port, closed } = await occupyPort(t)
  const dir = temporaryHome(t)
  t.mock.method(os, 'homedir', () => dir)
  const file = lockPath(dir, port)
  const ctx = makeCtx()
  ctx.webServer = { register: () => () => {}, registerUpgrade: () => () => {} }
  ctx.tools = { register: () => () => {} }
  ctx.systemPrompt = { section: () => () => {} }
  t.after(() => ctx.cleanup())
  const warnings = []
  ctx.logger.warn = (message, fields) => warnings.push({ message, fields })
  writeLock(file, { ...matchingLock(child.pid, port), startedAt: OLD })
  const hub = applyHub(ctx, {
    listenPort: port, listenHost: host, nodeToken: 'test-token', audit: false, stateDir: ctx.stateDir,
    listenReclaimWaitMs: 1000,
  })
  t.after(() => hub.disposeAll())
  assert.deepEqual(await closed, [null, 'SIGTERM'])
  // SIGKILL can return before the kernel releases the socket. If the immediate bind
  // races with exit, attempt 5 retains its original 10-second backoff.
  const deadline = Date.now() + 30000
  while (readLock(file)?.pid !== selfPid && Date.now() < deadline) await delay(25)
  assert.deepEqual(warnings.find(({ message }) => message.endsWith('hub: reclaimed listen port from a stale hub instance'))?.fields, {
    pid: child.pid, port, reason: 'stale-hub-instance', signal: 'SIGTERM',
  })
  const lock = readLock(file)
  assert.deepEqual(lock, { ...matchingLock(selfPid, port), startedAt: lock?.startedAt })
  assert.equal(new Date(lock.startedAt).toISOString(), lock.startedAt)
  hub.disposeAll()
  assert.equal(readLock(file), null)
})

test('hub: a port holder that still answers its health check is left alone, however long the wait', { timeout: 40000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', `
    const server = require('http').createServer((req, res) => { res.writeHead(200); res.end('{"ok":true}') })
    server.listen(0, ${JSON.stringify(host)}, () => console.log(server.address().port))
  `, 'DeepSeek Harness'], { stdio: ['ignore', 'pipe', 'inherit'] })
  const closed = once(child, 'close')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed })
  const [data] = await once(child.stdout, 'data')
  const port = Number(String(data).trim())
  const dir = temporaryHome(t)
  t.mock.method(os, 'homedir', () => dir)
  writeLock(lockPath(dir, port), { ...matchingLock(child.pid, port), startedAt: OLD })
  const ctx = makeCtx()
  ctx.webServer = { register: () => () => {}, registerUpgrade: () => () => {} }
  ctx.tools = { register: () => () => {} }
  ctx.systemPrompt = { section: () => () => {} }
  t.after(() => ctx.cleanup())
  const messages = []
  ctx.logger.warn = (message) => messages.push(message)
  ctx.logger.info = (message) => messages.push(message)
  const hub = applyHub(ctx, { listenPort: port, listenHost: host, nodeToken: 'test-token', audit: false, stateDir: ctx.stateDir, listenReclaimWaitMs: 1000 })
  t.after(() => hub.disposeAll())
  const deadline = Date.now() + 18000
  while (!messages.some(message => message.endsWith('the port holder still answers, not reclaiming')) && Date.now() < deadline) await delay(100)
  assert.ok(messages.some(message => message.endsWith('the port holder still answers, not reclaiming')), 'the hub looked at the holder and decided to wait')
  assert.equal(messages.some(message => message.endsWith('reclaimed listen port from a stale hub instance')), false)
  assert.equal(process.kill(child.pid, 0), true)
  assert.equal(child.signalCode, null)
})
