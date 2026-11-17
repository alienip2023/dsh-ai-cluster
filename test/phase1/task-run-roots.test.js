/** 红刀 1：roots 边界。越界必须判 denied / 任务必须 failed 且不落文件。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TaskEngine, TaskStore, isDenied, resolveWorkspace } from '../../src/task-run/index.js'
import { TASK_MODE, TASK_STATUS, ERROR_CODE } from '../../src/wire/index.js'

function tmp(label) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `p1-roots-${label}-`)))
}

test('isDenied: 越界 / 被禁路径返回 true，界内返回 false', () => {
  const root = tmp('deny')
  const outside = path.join(tmp('out'), 'x.txt')
  // 绝对条目：前缀命中
  assert.equal(isDenied(path.join(root, 'secret', 'a.txt'), [path.join(root, 'secret')]), true)
  assert.equal(isDenied(outside, [path.dirname(outside)]), true)
  // 根 '/' 拒绝一切
  assert.equal(isDenied(outside, ['/']), true)
  // 界内、无命中
  assert.equal(isDenied(path.join(root, 'ok.txt'), [path.join(root, 'secret')]), false)
})

test('resolveWorkspace: 根外工作区抛 WORKSPACE_DENIED', () => {
  const root = tmp('rw')
  const outside = tmp('rw-out')
  assert.throws(
    () => resolveWorkspace(outside, { roots: [root], caseInsensitive: false, defaultDir: root }),
    (e) => e.code === ERROR_CODE.WORKSPACE_DENIED,
  )
})

test('TaskEngine: 工作区在 roots 外 → failed，且没有文件被写', async () => {
  const root = tmp('eng')
  const outside = path.join(tmp('eng-out'), 'escape')
  const stateDir = tmp('state')
  const sent = []
  const engine = new TaskEngine({
    store: new TaskStore(stateDir),
    artifacts: { build: async () => { throw new Error('must not build') } },
    runner: { kind: 'test', run: async () => { throw new Error('must not run') } },
    nodeId: 'n1',
    roots: [root],
    defaultWorkspace: root,
    caseInsensitive: false,
    send: (type, data) => sent.push({ type, data }),
  })
  const marker = path.join(outside, 'pwned.txt')
  const res = engine.accept({
    taskId: 't-escape',
    mode: TASK_MODE.EXEC,
    goal: `echo pwned > "${marker}"`,
    workspace: outside,
  })
  assert.equal(res.rejected, true)
  const end = sent.find((s) => s.type === 'task/end')
  assert.ok(end, '应上报 task/end')
  assert.equal(end.data.status, TASK_STATUS.FAILED)
  assert.equal(end.data.error.code, ERROR_CODE.WORKSPACE_DENIED)
  assert.equal(sent.some((s) => s.type === 'task/accept'), false)
  assert.equal(fs.existsSync(outside), false, '越界目录不得被创建')
  assert.equal(fs.existsSync(marker), false, '不得写出文件')
  assert.equal(engine.store.get('t-escape'), undefined, '不得落任务记录')
})

test('TaskEngine: 前缀同级目录 root-evil/ 不在 root/ 内 → failed，且 root-evil 内无文件', async () => {
  const parent = tmp('prefix')
  const root = path.join(parent, 'root')
  const evil = path.join(parent, 'root-evil')
  fs.mkdirSync(root)
  fs.mkdirSync(evil)
  const stateDir = tmp('state-prefix')
  const sent = []
  const engine = new TaskEngine({
    store: new TaskStore(stateDir),
    artifacts: { build: async () => { throw new Error('must not build') } },
    runner: { kind: 'test', run: async () => { throw new Error('must not run') } },
    nodeId: 'n1',
    roots: [root],
    defaultWorkspace: root,
    caseInsensitive: false,
    send: (type, data) => sent.push({ type, data }),
  })
  // 直接调用：必须抛 WORKSPACE_DENIED
  assert.throws(
    () => resolveWorkspace(evil, { roots: [root], caseInsensitive: false, defaultDir: root }),
    (e) => e.code === ERROR_CODE.WORKSPACE_DENIED,
    'prefix sibling must be denied',
  )
  const marker = path.join(evil, 'pwned.txt')
  const res = engine.accept({
    taskId: 't-prefix',
    mode: TASK_MODE.EXEC,
    goal: `echo pwned > "${marker}"`,
    workspace: evil,
  })
  assert.equal(res.rejected, true)
  const end = sent.find((s) => s.type === 'task/end')
  assert.ok(end, '应上报 task/end')
  assert.equal(end.data.status, TASK_STATUS.FAILED)
  assert.equal(end.data.error.code, ERROR_CODE.WORKSPACE_DENIED)
  assert.equal(fs.existsSync(marker), false, 'root-evil 内不得写出文件')
  assert.deepEqual(fs.readdirSync(evil), [], 'root-evil 必须保持为空')
  assert.equal(engine.store.get('t-prefix'), undefined, '不得落任务记录')
})
