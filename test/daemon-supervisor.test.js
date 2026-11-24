import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { BACKOFF_DELAYS, backoffDelay, createSupervisor } from '../lib/daemon/supervisor.js'

function harness({ throwOnSpawn = false } = {}) {
  let clock = 0
  const timers = []
  const children = []
  const spawn = (command, args) => {
    if (throwOnSpawn) throw new Error('ENOENT')
    const child = new EventEmitter()
    child.pid = 1000 + children.length
    child.kill = (signal) => setImmediate(() => child.emit('exit', null, signal))
    children.push({ child, command, args })
    return child
  }
  const setTimer = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t }
  const clearTimer = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) }
  const fire = () => { const t = timers.shift(); t.fn(); return t.ms }
  const advance = (ms) => { clock += ms }
  return { spawn, setTimer, clearTimer, now: () => clock, fire, advance, timers, children }
}

test('backoff grows to a 60 s cap', () => {
  assert.equal(backoffDelay(0), 1000)
  assert.equal(backoffDelay(3), 8000)
  assert.equal(backoffDelay(99), 60000)
  assert.equal(BACKOFF_DELAYS.at(-1), 60000)
})

test('a crashing child is restarted with growing delays; the timer is not unref\'d', () => {
  const h = harness()
  const sup = createSupervisor({ command: 'dsh', args: ['serve'], ...h })
  sup.start()
  assert.equal(h.children.length, 1)
  h.children[0].child.emit('exit', 1, null)
  assert.equal(h.fire(), 1000)
  h.children[1].child.emit('exit', 1, null)
  assert.equal(h.fire(), 2000)
  assert.equal(h.children.length, 3)
  assert.equal(sup.status().restarts, 2)
})

test('a child that stayed up past stableMs resets the backoff', () => {
  const h = harness()
  const sup = createSupervisor({ command: 'dsh', ...h, stableMs: 60_000 })
  sup.start()
  h.children[0].child.emit('exit', 1, null)
  h.fire()
  h.children[1].child.emit('exit', 1, null)
  assert.equal(h.fire(), 2000)
  h.advance(120_000)
  h.children[2].child.emit('exit', 1, null)
  assert.equal(h.fire(), 1000)
})

test('exit and error from one child schedule only one restart', () => {
  const h = harness()
  createSupervisor({ command: 'dsh', ...h }).start()
  h.children[0].child.emit('error', new Error('boom'))
  h.children[0].child.emit('exit', 1, null)
  assert.equal(h.timers.length, 1)
})

test('a command that cannot start is retried, not thrown', () => {
  const h = harness({ throwOnSpawn: true })
  const sup = createSupervisor({ command: 'missing', ...h })
  sup.start()
  assert.equal(h.timers.length, 1)
  assert.equal(sup.status().running, false)
})

test('stop ends the child and no restart follows', async () => {
  const h = harness()
  const sup = createSupervisor({ command: 'dsh', ...h })
  sup.start()
  await sup.stop()
  assert.equal(h.timers.length, 0)
  assert.equal(sup.status().running, false)
  assert.equal(h.children.length, 1)
})

test('stop during a pending restart cancels it', async () => {
  const h = harness()
  const sup = createSupervisor({ command: 'dsh', ...h })
  sup.start()
  h.children[0].child.emit('exit', 1, null)
  assert.equal(h.timers.length, 1)
  await sup.stop()
  assert.equal(h.timers.length, 0)
})

test('no command is a clear error', () => {
  assert.throws(() => createSupervisor({}), /no command/)
})
