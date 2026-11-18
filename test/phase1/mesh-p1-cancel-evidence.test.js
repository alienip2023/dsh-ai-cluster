/**
 * Mesh P1：取消证据 / 停滞提示（只读投影）测试，ID 前缀 MP1-。
 * 真实 NodeRegistry + 真实 ingest（handleFrameFor）+ 真实 cancelTask + 真实 hub UI 路由；
 * 只有传输层 send 被替换为记帧（不新增任何发送点）。
 * §4.1 结论：共享投影无法区分 task/end aborted 与 sync-only aborted，
 * 故 aborted 一律 fail closed（UNMET-A1.4-ABORTED-PROVEN）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeRegistry } from '../../lib/hub/node-registry.js'
import { registerUiRoutes, UI_API_PREFIX } from '../../lib/hub/ui-routes.js'
import { taskView, STALL_HINT_MS } from '../../lib/hub/views.js'
import { HUB_TO_NODE, NODE_TO_HUB, TASK_STATUS, validateTaskStart } from '../../lib/protocol.js'

const NOW = 5_000_000

function setup(t) {
  const frames = []
  const audits = []
  const registry = new NodeRegistry({ log: () => {}, audit: { record: (e, f) => audits.push({ e, f }) } })
  registry.send = (nodeId, type, data) => { frames.push({ nodeId, type, data }); return registry.__sendOk !== false }
  registry.nodes.set('n1', { nodeId: 'n1', online: true, hello: { agentMode: true, roots: ['/w'] }, resource: null, repos: [], tasks: new Map(), conn: null })
  t.after(() => registry.dispose())
  const captured = []
  const disposers = registerUiRoutes({
    ctx: { webServer: { register: (r) => { captured.push(r); return () => {} } }, connection: undefined },
    registry, pulls: {}, log: () => {}, defaults: {}, config: { role: 'hub' },
  })
  t.after(() => { for (const d of disposers) { try { d() } catch {} } })
  const call = async (route, method, body, query = '') => {
    const handler = captured.find((r) => r.path === `${UI_API_PREFIX}/${route}`)?.handler
    const out = { status: 0, body: null }
    const res = { writeHead(c) { out.status = c }, end(p) { out.body = p ? JSON.parse(p) : null } }
    const req = { method, url: `${UI_API_PREFIX}/${route}${query}`, headers: { 'content-type': 'application/json' },
      *[Symbol.asyncIterator]() { yield Buffer.from(body ? JSON.stringify(body) : '') } }
    await handler(req, res)
    return { status: out.status, json: out.body }
  }
  return { registry, frames, audits, call }
}

const spec = (taskId, approval = 'auto') => validateTaskStart({ taskId, goal: 'g', mode: 'agent', approval, origin: 'hub' }).spec
const mk = (registry, id, approval) => registry.createTask({ nodeId: 'n1', spec: spec(id, approval) })
const frame = (registry, t, d) => registry.handleFrameFor('n1', { t, d })

test('MP1-A1.4 non-terminal and request-only are never aborted', async (t) => {
  const { registry, call } = setup(t)
  mk(registry, 'q1')
  const r = await call('cancel', 'POST', { taskId: 'q1' })
  assert.equal(r.json.requested, true)
  const v = taskView(registry.getTask('q1'), { nowMs: NOW })
  assert.deepEqual(v.cancelEvidence, { state: 'unknown', source: 'none' })
  assert.notEqual(v.status, 'aborted')
})

test('MP1-A1.4 failed send: requested false, evidence unknown', async (t) => {
  const { registry, call } = setup(t)
  mk(registry, 'q1')
  registry.__sendOk = false
  const r = await call('cancel', 'POST', { taskId: 'q1' })
  assert.equal(r.json.requested, false)
  assert.equal(taskView(registry.getTask('q1'), { nowMs: NOW }).cancelEvidence.state, 'unknown')
})

test('MP1-A1.4 pending-approval cancel -> rejected -> terminal/hub, never aborted', async (t) => {
  const { registry, frames, call } = setup(t)
  mk(registry, 'p1', 'manual')
  const r = await call('cancel', 'POST', { taskId: 'p1' })
  assert.equal(r.json.requested, true)
  assert.equal(frames.filter((f) => f.type === HUB_TO_NODE.TASK_CANCEL).length, 0)
  const v = taskView(registry.getTask('p1'), { nowMs: NOW })
  assert.equal(v.status, 'rejected')
  assert.deepEqual(v.cancelEvidence, { state: 'terminal', source: 'hub' })
})

test('MP1-A1.4 interrupted/timeout/exit flags never upgrade to aborted', () => {
  for (const [status, exit] of [['interrupted', { aborted: true }], ['failed', { timedOut: true }], ['completed', { aborted: true }], ['running', { aborted: true }]]) {
    const v = taskView({ taskId: 'x', status, exit, updatedAt: 1 }, { nowMs: NOW })
    assert.notEqual(v.cancelEvidence.state, 'aborted', status)
    if (status === 'running') assert.equal(v.cancelEvidence.state, 'unknown')
    else assert.deepEqual(v.cancelEvidence, { state: 'terminal', source: 'node' })
    assert.equal(v.status, status)
  }
})

test('MP1-A1.4 UNMET-A1.4-ABORTED-PROVEN: real task/end aborted ingest and sync-only aborted both fail closed', (t) => {
  const { registry } = setup(t)
  mk(registry, 'e1'); mk(registry, 's1')
  frame(registry, NODE_TO_HUB.TASK_END, { taskId: 'e1', status: 'aborted' })
  assert.equal(registry.getTask('e1').status, 'aborted')
  frame(registry, NODE_TO_HUB.TASK_SYNC, { tasks: [{ taskId: 's1', status: 'aborted', updatedAt: 10 }] })
  for (const id of ['e1', 's1']) {
    const v = taskView(registry.taskView(registry.getTask(id)), { nowMs: NOW })
    assert.equal(v.status, 'aborted', 'existing status is not negated')
    assert.deepEqual(v.cancelEvidence, { state: 'unknown', source: 'none' }, 'documented gap, not success: ' + id)
    assert.equal('abortedBeforeStart' in v.cancelEvidence, false)
  }
})

test('MP1-A1.2 different terminal task/end does not rewrite a terminal', (t) => {
  const { registry } = setup(t)
  mk(registry, 'a')
  frame(registry, NODE_TO_HUB.TASK_END, { taskId: 'a', status: 'completed' })
  frame(registry, NODE_TO_HUB.TASK_END, { taskId: 'a', status: 'failed' })
  assert.equal(registry.getTask('a').status, 'completed')
  frame(registry, NODE_TO_HUB.TASK_END, { taskId: 'a', status: 'completed' })
  assert.equal(registry.getTask('a').status, 'completed')
})

test('MP1-A1.3 cancel of already-terminal task leaves status/exit and projection unchanged', async (t) => {
  const { registry, call } = setup(t)
  mk(registry, 'a')
  frame(registry, NODE_TO_HUB.TASK_END, { taskId: 'a', status: 'completed' })
  const before = JSON.stringify(taskView(registry.getTask('a'), { nowMs: NOW }))
  await call('cancel', 'POST', { taskId: 'a' })
  assert.equal(JSON.stringify(taskView(registry.getTask('a'), { nowMs: NOW })), before)
})

test('MP1-C-1 stall threshold, terminal, bad timestamps', () => {
  const base = { taskId: 'x', status: 'running' }
  assert.equal(taskView({ ...base, updatedAt: NOW - (STALL_HINT_MS - 1) }, { nowMs: NOW }).stallHint.stalled, false)
  const at = taskView({ ...base, updatedAt: NOW - STALL_HINT_MS }, { nowMs: NOW })
  assert.deepEqual(at.stallHint, { stalled: true, idleMs: STALL_HINT_MS })
  assert.equal(at.status, 'running')
  assert.equal(taskView({ taskId: 'x', status: 'completed', updatedAt: 1 }, { nowMs: NOW }).stallHint.stalled, false)
  for (const bad of [0, NaN, Infinity, -Infinity, -5, '7', null, undefined]) {
    const raw = taskView({ ...base, updatedAt: bad, createdAt: NOW - 200000 }, { nowMs: NOW })
    assert.equal(raw.stallHint.idleMs, 200000, 'falls back to createdAt for ' + String(bad))
    assert.deepEqual(taskView({ ...base, updatedAt: bad, createdAt: bad }, { nowMs: NOW }).stallHint, { stalled: false, idleMs: 0 })
  }
})

test('MP1-C-2 new objects carry only whitelisted keys', () => {
  const v = taskView({ taskId: 'x', status: 'aborted', updatedAt: 1, logTail: ['SECRET'], error: { code: 'c', message: 'SECRET' }, env: { K: 'SECRET' } }, { nowMs: NOW })
  assert.deepEqual(Object.keys(v.cancelEvidence).sort(), ['source', 'state'])
  assert.deepEqual(Object.keys(v.stallHint).sort(), ['idleMs', 'stalled'])
  assert.doesNotMatch(JSON.stringify([v.cancelEvidence, v.stallHint]), /SECRET/)
})

test('MP1-C-4 legacy records without status/exit/updatedAt do not throw', () => {
  for (const r of [{}, { taskId: 'x' }, { taskId: 'x', status: 7 }, { taskId: 'x', exit: 'bad' }]) {
    const v = taskView(r, { nowMs: NOW })
    assert.deepEqual(v.cancelEvidence, { state: 'unknown', source: 'none' })
    assert.deepEqual(v.stallHint, { stalled: false, idleMs: 0 })
  }
})

test('MP1-C-5 idempotent under double projection (raw, bad times, aborted)', (t) => {
  const { registry } = setup(t)
  const o = { nowMs: NOW, tail: 20 }
  const raws = [
    { taskId: 'a', status: 'running', updatedAt: 1000, createdAt: 900 },
    { taskId: 'b', status: 'running', updatedAt: NaN, createdAt: 0 },
    { taskId: 'c', status: 'aborted', updatedAt: Infinity, createdAt: 5, exit: { aborted: true } },
    { taskId: 'd', status: 'rejected' },
    { taskId: 'e', status: 'interrupted', exit: { timedOut: true } },
  ]
  for (const raw of raws) {
    const once = taskView(raw, o)
    assert.deepEqual(taskView(once, o), once, raw.taskId)
    assert.deepEqual(taskView(registry.taskView({ ...raw, nodeId: 'n1' }), o), taskView({ ...raw, nodeId: 'n1', nodeOnline: true }, o), raw.taskId + ' via registry')
  }
})

test('MP1-C-3/A1.5 GET list and detail are read-only and agree on the new fields', async (t) => {
  const { registry, frames, audits, call } = setup(t)
  mk(registry, 'a'); mk(registry, 'b')
  frame(registry, NODE_TO_HUB.TASK_END, { taskId: 'b', status: 'failed' })
  const f0 = frames.length, a0 = audits.length
  const list = await call('tasks', 'GET')
  const detail = await call('task', 'GET', null, '?taskId=a')
  assert.equal(list.status, 200)
  assert.equal(frames.length, f0, 'no frame sent by reads')
  assert.equal(audits.length, a0, 'no audit written by reads')
  const la = list.json.tasks.find((x) => x.taskId === 'a')
  assert.deepEqual(detail.json.task.cancelEvidence, la.cancelEvidence)
  assert.deepEqual(list.json.tasks.find((x) => x.taskId === 'b').cancelEvidence, { state: 'terminal', source: 'node' })
})

test('MP1-AC-2 cancel route sends exactly one TASK_CANCEL and nothing else new', async (t) => {
  const { registry, frames, call } = setup(t)
  mk(registry, 'q'); const n = frames.length
  await call('cancel', 'POST', { taskId: 'q' })
  assert.equal(frames.length - n, 1)
  assert.equal(frames.at(-1).type, HUB_TO_NODE.TASK_CANCEL)
})

/* ───── 真实 TaskEngine（只替换 runner）+ 真实 hub ingest ───── */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TaskEngine } from '../../lib/node/task-engine.js'
import { TaskStore } from '../../lib/node/task-store.js'
import { ArtifactService } from '../../lib/node/artifact-service.js'
import { reconcileOnStartup } from '../../lib/node/startup-reconcile.js'
import { registerUiRoutes as registerPluginRoutes } from '../../lib/plugin/http/routes.js'

function makeEngine(t, { hold = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp1-eng-'))
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  const workspace = path.join(root, 'ws'); fs.mkdirSync(workspace, { recursive: true })
  const frames = []; let runs = 0; let release
  const gate = new Promise((r) => { release = r })
  const runner = {
    kind: 'fake',
    async run() { runs += 1; if (hold) await gate; return { ok: true, exitCode: 0, final: 'done', toolCalls: [], durationMs: 1, sessionId: null } },
    async cancel() { release?.(); return true }, killAll() {}, async disposeAll() {},
  }
  const store = new TaskStore(path.join(root, 'state'))
  const engine = new TaskEngine({ store, artifacts: new ArtifactService({ nodeId: 'n1', caseInsensitive: true }), runner, nodeId: 'n1',
    roots: [workspace], denyPaths: [], defaultWorkspace: workspace, caseInsensitive: true, send: (type, data) => frames.push({ type, data }), maxConcurrent: 1 })
  return { engine, store, frames, workspace, runs: () => runs, release: () => release() }
}
const wait = async (cond) => { for (let i = 0; i < 200; i += 1) { if (cond()) return; await new Promise((r) => setTimeout(r, 10)) } throw new Error('timeout') }
const eSpec = (id, workspace) => validateTaskStart({ taskId: id, goal: 'g', mode: 'agent', workspace }).spec

test('MP1-A1.1 duplicate task/start: accept{duplicate:true}, store 1, runner 1', async (t) => {
  const { engine, store, frames, workspace, runs } = makeEngine(t)
  engine.accept(eSpec('d1', workspace))
  await wait(() => frames.some((f) => f.type === 'task/end'))
  const before = frames.length
  engine.accept(eSpec('d1', workspace))
  const dup = frames.slice(before).find((f) => f.type === 'task/accept')
  assert.equal(dup.data.duplicate, true)
  assert.equal(store.list().filter((r) => r.taskId === 'd1').length, 1)
  assert.equal(runs(), 1)
})

test('MP1-A1.3(a) real engine: cancel of stored terminal task returns false, emits 0 frames, changes nothing', async (t) => {
  const { engine, store, frames, workspace } = makeEngine(t)
  engine.accept(eSpec('c1', workspace))
  await wait(() => frames.some((f) => f.type === 'task/end'))
  const snap = JSON.stringify(store.get('c1')); const n = frames.length
  assert.equal(await engine.cancel('c1'), false)
  assert.equal(frames.length, n)
  assert.equal(JSON.stringify(store.get('c1')), snap)
})

test('MP1-A1.4 real engine queued cancel -> real task/end aborted ingested by hub -> fails closed (UNMET-A1.4-ABORTED-PROVEN)', async (t) => {
  const { engine, frames, workspace, release } = makeEngine(t, { hold: true })
  const { registry } = setup(t)
  engine.accept(eSpec('r1', workspace)); engine.accept(eSpec('q1', workspace))
  await wait(() => engine.running.has('r1'))
  mk(registry, 'q1')
  assert.equal(await engine.cancel('q1'), true)
  const end = frames.find((f) => f.type === 'task/end' && f.data.taskId === 'q1')
  assert.equal(end.data.status, 'aborted')
  frame(registry, NODE_TO_HUB.TASK_END, end.data)
  const v = taskView(registry.taskView(registry.getTask('q1')), { nowMs: NOW })
  assert.equal(v.status, 'aborted')
  assert.deepEqual(v.cancelEvidence, { state: 'unknown', source: 'none' })
  release(); await wait(() => frames.some((f) => f.type === 'task/end' && f.data.taskId === 'r1'))
})

test('MP1-A1.6 restart reconcile: foreign RUNNING -> interrupted (never aborted), QUEUED requeued', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp1-rec-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new TaskStore(path.join(root, 'state'))
  store.create(eSpec('run', root), { nodeId: 'n1', workspace: root })
  store.update('run', { status: 'running', ownerPid: 1, ownerStartedAt: 1 })
  const tally = reconcileOnStartup(store, { self: { pid: 999999, startedAt: 5 }, resumeQueued: false })
  assert.equal(tally.interrupted, 1)
  assert.equal(store.get('run').status, 'interrupted')
  assert.equal(store.get('run').error.code, 'node-restart')
  const v = taskView({ ...store.get('run') }, { nowMs: NOW })
  assert.deepEqual(v.cancelEvidence, { state: 'terminal', source: 'node' })
})

test('MP1-C-6/A1.5 plugin route and public hub route agree (list/detail/cancel receipt), incl. sync snapshot', async (t) => {
  const { registry, call } = setup(t)
  mk(registry, 'a'); mk(registry, 'b'); mk(registry, 'c'); mk(registry, 'd'); mk(registry, 'e'); mk(registry, 'f')
  frame(registry, NODE_TO_HUB.TASK_END, { taskId: 'b', status: 'failed' })
  frame(registry, NODE_TO_HUB.TASK_END, { taskId: 'c', status: 'interrupted' })
  frame(registry, NODE_TO_HUB.TASK_SYNC, { tasks: [{ taskId: 'd', status: 'aborted', updatedAt: 10 }] })
  const captured = []
  const disposers = registerPluginRoutes({ ctx: { webServer: { register: (r) => { captured.push(r); return () => {} } }, connection: undefined },
    registry, pulls: {}, log: () => {}, defaults: {}, config: { role: 'hub' } })
  t.after(() => { for (const d of disposers ?? []) { try { d() } catch {} } })
  const pcall = async (prefix, route, method, body, query = '') => {
    const handler = captured.find((r) => r.path === `${prefix}/${route}`)?.handler
    assert.ok(handler, `plugin route ${prefix}/${route}`)
    const out = { status: 0, body: null }
    const res = { writeHead(c) { out.status = c }, setHeader() {}, end(p) { out.body = p ? JSON.parse(p) : null } }
    await handler({ method, url: `${prefix}/${route}${query}`, headers: { 'content-type': 'application/json' },
      *[Symbol.asyncIterator]() { yield Buffer.from(body ? JSON.stringify(body) : '') } }, res)
    return out.body
  }
  const pre = [...new Set(captured.map((r) => r.path.slice(0, r.path.lastIndexOf('/tasks') >= 0 ? r.path.lastIndexOf('/tasks') : 0)))].filter(Boolean)
  assert.ok(pre.length >= 1)
  const hubList = (await call('tasks', 'GET')).json
  const strip = (l) => l.tasks.map((x) => ({ id: x.taskId, s: x.status, ce: x.cancelEvidence, sh: { stalled: x.stallHint?.stalled } })).sort((x, y) => x.id.localeCompare(y.id))
  assert.equal(strip(hubList).length, 6)
  for (const prefix of pre) {
    const pl = await pcall(prefix, 'tasks', 'GET')
    assert.deepEqual(strip(pl), strip(hubList), 'list parity ' + prefix)
    const pd = await pcall(prefix, 'task', 'GET', null, '?taskId=c')
    assert.deepEqual(pd.task.cancelEvidence, { state: 'terminal', source: 'node' })
    assert.deepEqual(strip(pl).find((x) => x.id === 'd').ce, { state: 'unknown', source: 'none' })
  }
  assert.deepEqual(await pcall(pre[0], 'tasks', 'GET', null, '?node=nope').then((x) => x.tasks), [])
  const emptyReg = setup(t); assert.deepEqual((await emptyReg.call('tasks', 'GET')).json.tasks, [])
})

test('MP1-A1.3(a) plugin cancel route: terminal task unchanged, single cancel frame at most', async (t) => {
  const { registry, frames } = setup(t)
  mk(registry, 'a'); frame(registry, NODE_TO_HUB.TASK_END, { taskId: 'a', status: 'completed' })
  const captured = []
  registerPluginRoutes({ ctx: { webServer: { register: (r) => { captured.push(r); return () => {} } }, connection: undefined },
    registry, pulls: {}, log: () => {}, defaults: {}, config: { role: 'hub' } })
  const h = captured.find((r) => r.path.endsWith('/cancel')).handler
  const before = JSON.stringify(taskView(registry.getTask('a'), { nowMs: NOW })); const n = frames.length
  await h({ method: 'POST', url: '/x/cancel', headers: { 'content-type': 'application/json' }, *[Symbol.asyncIterator]() { yield Buffer.from('{"taskId":"a"}') } }, { writeHead() {}, setHeader() {}, end() {} })
  assert.ok(frames.length - n <= 1)
  assert.equal(JSON.stringify(taskView(registry.getTask('a'), { nowMs: NOW })), before)
})
