/**
 * Stress round 3, D5: the workspace snapshot taken around every task used to be synchronous, so a workspace
 * with a lot of history held the node's event loop for seconds on each task end. It is asynchronous now:
 * the event loop keeps turning while it walks, and what it returns is unchanged.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TaskEngine } from '../lib/node/task-engine.js'

const fakeEngine = () => ({ denyPaths: [], caseInsensitive: false, store: { list: () => [] } })

test('SA-1: the snapshot returns a promise, walks nested files, and captures text content only when asked', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'top.txt'), 'hello')
  fs.writeFileSync(path.join(dir, 'a/b/deep.txt'), 'deep')
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 3]))
  const call = TaskEngine.prototype.snapshotWorkspace
  const pending = call.call(fakeEngine(), dir, { withContent: true })
  assert.equal(typeof pending.then, 'function', 'a promise, not a map')
  const map = await pending
  assert.deepEqual([...map.keys()].sort(), ['a/b/deep.txt', 'bin.dat', 'top.txt'])
  assert.equal(map.get('top.txt').content, 'hello')
  assert.equal(map.get('bin.dat').content, undefined, 'binary is not captured')
  const bare = await call.call(fakeEngine(), dir)
  assert.equal(bare.get('top.txt').content, undefined, 'no content unless asked')
  assert.equal(bare.get('top.txt').bytes, 5)
})

test('SA-2: the event loop keeps running while a large workspace is walked', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-big-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (let d = 0; d < 20; d += 1) {
    fs.mkdirSync(path.join(dir, `d${d}`))
    for (let f = 0; f < 25; f += 1) fs.writeFileSync(path.join(dir, `d${d}`, `f${f}.txt`), 'x'.repeat(200))
  }
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 1)
  const map = await TaskEngine.prototype.snapshotWorkspace.call(fakeEngine(), dir, { withContent: true })
  clearInterval(timer)
  assert.equal(map.size, 500)
  assert.ok(ticks > 0, 'timers fired during the walk: it did not hold the event loop')
})
