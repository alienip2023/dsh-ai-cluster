// SSH onboarding behaviours of the machines screen, ported from the old client tests
// (ssh-fork27, ssh-fix-b123, ssh-relay-precheck, ssh-relay-token, ssh-relay-autoconfig): what the screen does, not how the old source was written.
import assert from 'node:assert/strict'
import test from 'node:test'
import { makeCore, expand, texts, findAll } from './_fake.js'
import { dataEmptyHub } from '../../src/panel/data.js'
import { createFleet, fleetMachFlow, fleetMachInit, fleetMachReduce } from '../../src/panel/fleet.js'

const noop = () => {}

function mkIo(script, opts = {}) {
  const calls = []
  const alerts = []
  const confirms = []
  let state = fleetMachInit
  let clock = 0
  const io = {
    get: async (p) => { calls.push(['GET', p]); const r = script('GET', p); if (r instanceof Error) throw r; return r },
    post: async (p, b) => { calls.push(['POST', p, b]); const r = script('POST', p, b); if (r instanceof Error) throw r; return r },
    dispatch: (e) => { state = fleetMachReduce(state, e) },
    probes: () => state.probe, sleep: async (ms) => { clock += ms }, now: () => clock, port: () => '',
    confirm: async (m) => { confirms.push(m); return opts.confirm !== false }, alert: (m) => alerts.push(m), notify: noop, refresh: noop,
  }
  return { io, calls, alerts, confirms, get state() { return state } }
}
const ready = { ok: true, config: { relayUrl: 'ws://r/relay', relayTokenSet: true } }
const view = (state) => {
  const core = makeCore({ state: [state] })
  const hub = Object.assign({}, dataEmptyHub, { loading: false, nodes: [] })
  const tree = expand(core.h(createFleet(core).Machines, { hub, role: 'hub', go: noop, refresh: noop, ui: { confirm: async () => true, alert: noop, notify: noop, prompt: async () => null } }))
  return { tree, text: texts(tree).join('') }
}
const buttons = (tree, label) => findAll(tree, (n) => n.type === 'button' && texts(n).join('') === label)

test('install-runtime is offered only for a host with missing parts, and shows a busy state while it runs', () => {
  const state = Object.assign({}, fleetMachInit, {
    hosts: [{ alias: 'bare', host: '10.0.0.5', port: 22, user: 'root' }, { alias: 'ready', host: '10.0.0.6', port: 22, user: 'root' }],
    probe: { bare: { ok: true, missing: ['node', 'npm', 'dsh'] }, ready: { ok: true, missing: [] } },
  })
  const idle = view(state)
  assert.equal(buttons(idle.tree, '安装运行环境').length, 1)
  assert.match(idle.text, /缺少：node、npm、dsh/)
  const busy = view(Object.assign({}, state, { installing: { bare: true } }))
  assert.equal(buttons(busy.tree, '安装中…')[0].props.disabled, true)
  assert.equal(buttons(busy.tree, '安装运行环境').length, 0)
  const none = view(Object.assign({}, state, { probe: { bare: { ok: true, missing: [] } } }))
  assert.equal(buttons(none.tree, '安装运行环境').length, 0)
})

test('probe states: unprobed, failed, missing, relay host and ready are all shown, and only a ready host can be bridged', () => {
  const state = Object.assign({}, fleetMachInit, {
    hosts: ['a', 'b', 'c', 'd', 'e'].map((alias) => ({ alias, host: '10.0.0.1', port: 22, user: 'u' })),
    probe: { b: { ok: false, error: 'probe-failed', message: 'ssh timeout' }, c: { ok: true, missing: ['dsh'] }, d: { ok: true, missing: [], isRelay: true }, e: { ok: true, missing: [] } },
  })
  const { tree, text } = view(state)
  for (const label of ['未探测', '探测失败', '缺运行环境', '中继主机', '环境就绪']) assert.ok(text.includes(label), label)
  assert.match(text, /探测失败：ssh timeout/)
  assert.equal(buttons(tree, '上桥').length, 1)
  assert.equal(buttons(tree, '探测').length, 5)
})

test('deploy progress: every step shows done / failed / pending, the failed one is marked, and the overall error is a separate line', () => {
  const steps = [{ name: 'connect', status: 'done', log: 'ok\n' }, { name: 'probe', status: 'done', log: '' }, { name: 'upload', status: 'failed', log: 'sftp 失败' }, { name: 'install', status: 'pending', log: '' }]
  const { tree, text } = view(Object.assign({}, fleetMachInit, {
    hosts: [{ alias: 'box', host: 'h', port: 22, user: 'u' }], probe: { box: { ok: true, missing: [] } },
    job: { box: { id: 'j', status: 'failed', error: '上传失败', steps } },
  }))
  const rows = findAll(tree, (n) => typeof n.props.className === 'string' && /^fl-step /.test(n.props.className))
  assert.deepEqual(rows.map((r) => r.props.className.replace('fl-step ', '')), ['done', 'done', 'failed', 'pending'])
  assert.deepEqual(rows.map((r) => texts(r)[0]), ['✔', '✔', '✘', '○'])
  assert.match(text, /连接 SSH.*探测环境.*上传文件.*sftp 失败.*校验文件/)
  assert.match(text, /✘ 上传失败/)
})

test('deploy polling reads the job from either shape and stops on done or failed only', async () => {
  for (const wrap of [(j) => ({ ok: true, job: j }), (j) => j]) {
    let n = 0
    const t = mkIo((m, p) => {
      if (p === '/config') return ready
      if (m === 'POST') return { ok: true, jobId: 'j1' }
      n += 1
      return wrap({ id: 'j1', status: n < 3 ? 'running' : 'failed', error: n < 3 ? null : 'boom', steps: [{ name: 'connect', status: 'done', log: '' }] })
    })
    await fleetMachFlow(t.io).deploy('box')
    assert.equal(n, 3)
    assert.equal(t.state.job.box.status, 'failed')
    assert.equal(t.state.job.box.error, 'boom')
    assert.equal(t.state.job.box.steps[0].name, 'connect')
    assert.equal(t.state.deploying.box, false)
  }
})

test('relay pre-check: an unconfigured relay is auto-detected from the probed relay host instead of failing outright', async () => {
  let cfg = 0
  const t = mkIo((m, p, b) => {
    if (p === '/config') { cfg += 1; return { config: cfg === 1 ? { relayUrl: '', relayTokenSet: false } : { relayUrl: 'ws://relayhost:8890/relay', relayTokenSet: true } } }
    if (p === '/relay-autoconfig') return { ok: true, message: '中继配置已写入', relayTokenSet: true, b }
    if (m === 'POST' && p === '/ssh-deploy') return { jobId: 'j' }
    return { job: { status: 'done', steps: [] } }
  })
  t.io.dispatch({ type: 'probe-done', alias: 'relayhost', result: { ok: true, missing: [], isRelay: true, relayUrl: 'ws://relayhost:8890/relay', relayHubToken: 'hub-secret' } })
  await fleetMachFlow(t.io).deploy('box')
  const post = t.calls.find((c) => c[1] === '/relay-autoconfig')
  assert.deepEqual(post[2], { relayUrl: 'ws://relayhost:8890/relay', autoHubToken: 'hub-secret' }) // the probed token is forwarded to the server
  assert.equal(t.calls.some((c) => c[1].includes('/setup/apply')), false) // goes through /relay-autoconfig, never the setup writer
  assert.equal(t.state.job.box.status, 'done')
  assert.ok(t.confirms.length === 1)
})

test('relay pre-check: a configured relay is never rewritten', async () => {
  const t = mkIo((m, p) => (p === '/config' ? ready : m === 'POST' ? { jobId: 'j' } : { job: { status: 'done', steps: [] } }))
  t.io.dispatch({ type: 'probe-done', alias: 'r', result: { ok: true, isRelay: true, relayUrl: 'ws://other/relay', relayHubToken: 'x' } })
  await fleetMachFlow(t.io).deploy('box')
  assert.equal(t.calls.some((c) => c[1] === '/relay-autoconfig'), false)
  assert.equal(t.confirms.length, 0)
})

test('relay pre-check: a probe without a relay host stops with an instruction and deploys nothing', async () => {
  const t = mkIo((m, p) => (p === '/config' ? { config: { relayUrl: '', relayTokenSet: false } } : new Error('unexpected ' + p)))
  t.io.dispatch({ type: 'probe-done', alias: 'plain', result: { ok: true, missing: [], isRelay: false } })
  await fleetMachFlow(t.io).deploy('box')
  assert.equal(t.alerts.length, 1)
  assert.match(t.alerts[0], /探测/)
  assert.deepEqual(t.calls.map((c) => c[1]), ['/config'])
})
