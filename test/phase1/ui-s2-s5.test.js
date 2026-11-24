import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')

function sliceFn(src, name, next) {
  const start = src.indexOf(`function ${name}`)
  assert.ok(start >= 0, `缺少 function ${name}`)
  const end = src.indexOf(`function ${next}`, start + 1)
  assert.ok(end > start, `${name} 后面应该是 ${next}`)
  return src.slice(start, end)
}

const dispatch = sliceFn(CLIENT, 'DispatchForm', 'PairPanel')
const loadHub = sliceFn(CLIENT, 'loadHub', 'load(')
const nodeCard = sliceFn(CLIENT, 'NodeCard', 'NodeCardGrid')
// The card's load/status lines moved into nodeCardView (merged design): the text checks cover both functions.
const nodeCardView = sliceFn(CLIENT, 'nodeCardView', 'NodeCard')

test('S2 keeps node dispatch and explains 机器人级交办本期不可用', () => {
  assert.ok(dispatch.includes('目标节点'))
  assert.ok(dispatch.includes('机器人级交办本期不可用'), 'DispatchForm must show 机器人级交办本期不可用')
  assert.doesNotMatch(dispatch, /remoteBotId|\/bots\/turn/)
})

test('S5 loads node status through the existing API fallback', () => {
  assert.ok(loadHub.includes("apiGet('/node-status')"))
})

test('S5 node cards retain resource fallback and show heartbeat details', () => {
  for (const text of ['静默', '心跳超时', '负载未上报']) assert.ok((nodeCardView + nodeCard).includes(text), text)
})

test('worker and setup paths stay unchanged', () => {
  for (const declaration of [
    "const STATUS_PATH = '/api/remote-agent/status'",
    "const SETUP_STATE_PATH = '/api/remote-agent/setup/state'",
    "const SETUP_APPLY_PATH = '/api/remote-agent/setup/apply'",
  ]) assert.ok(CLIENT.includes(declaration), declaration)
})

test('SharePanel and doPlan remain available', () => {
  assert.ok(CLIENT.includes('function SharePanel'))
  assert.ok(CLIENT.includes('function doPlan'))
})

async function runLoadHub(overview, status, role = 'hub') {
  const calls = []
  const tasks = { tasks: [{ taskId: 'task-1', status: 'completed' }] }
  const localStatus = { nodeId: 'local-worker' }
  let state = { error: '' }
  let hubResult
  const sandbox = {
    apiGet(path) {
      // Side requests of the merged hub screen (tickets, goals, bot audit): each is optional in loadHub
      // (a failure becomes null), they are not part of what these tests pin.
      if (path === '/tickets') return Promise.resolve({ tickets: null })
      if (path === '/goals') return Promise.resolve({ goals: null })
      if (path === '/bot-audit') return Promise.resolve({ entries: null })
      calls.push(path)
      if (path === '/overview') return Promise.resolve(overview)
      if (path === '/tasks') return Promise.resolve(tasks)
      if (path === '/node-status') return status instanceof Error ? Promise.reject(status) : Promise.resolve(status)
      throw new Error(`Unexpected request: ${path}`)
    },
    apiGetPath(path) {
      calls.push(path)
      assert.equal(path, '/api/remote-agent/status')
      return Promise.resolve(localStatus)
    },
    STATUS_PATH: '/api/remote-agent/status',
    afterHub(ov, tk) { hubResult = { overview: ov, tasks: tk } },
    setState(update) { state = update(state) },
    selectRuntimeView() { throw new Error('Node status failure must not reach the hub error handler') },
  }
  const load = vm.runInNewContext(`(${loadHub.trim()})`, sandbox)
  await load(role)
  return { calls, state, hubResult, tasks, localStatus }
}

test('S5 merges only status fields by nodeId and preserves overview data', async () => {
  const node = {
    nodeId: 'pc-a', online: true, roots: ['/work'], caps: ['exec'],
    models: [{ id: 'model-a' }], taskCount: 3, transportMode: 'direct',
  }
  const unmatched = { nodeId: 'pc-b', online: false }
  const overview = { nodes: [node, unmatched], counts: { nodes: 2 }, topology: { nodes: [] } }
  const row = {
    nodeId: 'pc-a', resource: { cpuPct: 12 }, connectivity: { transportMode: 'direct' },
    queue: { running: 1 }, silentMs: 15500, stale: true, thresholdMs: 15000,
    online: false, roots: [], caps: [], models: [], taskCount: 99, transportMode: 'relay',
  }
  const result = await runLoadHub(overview, { nodes: [{ nodeId: 'status-only' }, row] })
  const merged = result.hubResult.overview
  assert.deepEqual(result.calls, ['/overview', '/tasks', '/node-status'])
  assert.equal(merged.nodes.length, 2)
  assert.deepEqual(Object.keys(merged.nodes[0]).sort(), [...Object.keys(node),
    'resource', 'connectivity', 'queue', 'silentMs', 'stale', 'thresholdMs'].sort())
  for (const key of Object.keys(node)) assert.equal(merged.nodes[0][key], node[key], key)
  for (const key of ['resource', 'connectivity', 'queue', 'silentMs', 'stale', 'thresholdMs']) {
    assert.equal(merged.nodes[0][key], row[key], key)
  }
  assert.equal(merged.nodes[1], unmatched)
  assert.equal(merged.counts, overview.counts)
  assert.equal(merged.topology, overview.topology)
  assert.equal(result.hubResult.tasks, result.tasks)
  assert.equal(Object.hasOwn(node, 'resource'), false)
  assert.equal(result.state.error, '')
})

test('S5 status failure keeps overview nodes, tasks and an empty error', async () => {
  const overview = { nodes: [{ nodeId: 'pc-a', online: true }] }
  const result = await runLoadHub(overview, new Error('Both status prefixes failed'))
  assert.equal(result.hubResult.overview, overview)
  assert.equal(result.hubResult.tasks, result.tasks)
  assert.equal(Object.hasOwn(overview.nodes[0], 'resource'), false)
  assert.equal(result.state.error, '')
  assert.equal(result.state.mode, 'hub')
})

test('S5 absent status fields do not add resource data', async () => {
  const overview = { nodes: [{ nodeId: 'pc-a', online: true }] }
  const result = await runLoadHub(overview, { nodes: [{ nodeId: 'pc-a', silentMs: null }] })
  assert.equal(Object.hasOwn(result.hubResult.overview.nodes[0], 'resource'), false)
  assert.equal(result.hubResult.overview.nodes[0].silentMs, null)
})

test('both role still reads local worker status through STATUS_PATH', async () => {
  const result = await runLoadHub({ nodes: [] }, { nodes: [] }, 'both')
  assert.equal(result.calls.at(-1), '/api/remote-agent/status')
  assert.equal(result.state.worker, result.localStatus)
  assert.equal(result.state.mode, 'both')
})

function renderNode(node) {
  const render = vm.runInNewContext(`${nodeCardView}\n(${nodeCard.trim()})`, {
    h(type, props, ...children) { return { type, props, children } },
    Dot() {}, Badge() {}, pct(value) { return value }, shortId(id) { return id },
    connectivityLine() { return '链路详情未上报' },
    frameRttLine() { return null }, topoHealthOverlay() { return null }, topoNodeId(n) { return n.nodeId },
  })
  return render({ node })
}

test('S5 heartbeat rounds seconds, accepts zero and leaves online badge intact', () => {
  const tree = renderNode({ nodeId: 'pc-a', online: true, silentMs: 15500, stale: true })
  const text = JSON.stringify(tree)
  assert.ok(text.includes('静默 16 秒'))
  assert.ok(text.includes('心跳超时'))
  assert.ok(text.includes('负载未上报'))
  assert.ok(text.includes('在线（未知）'))
  assert.equal(tree.props.className, 'dra-node-card online')
  assert.ok(JSON.stringify(renderNode({ silentMs: 0 })).includes('静默 0 秒'))
})

test('S5 omits unknown silence and requires stale === true for timeout', () => {
  for (const silentMs of [undefined, null, '15000']) {
    const text = JSON.stringify(renderNode({ silentMs, stale: 'true' }))
    assert.ok(!text.includes('静默'))
    assert.ok(!text.includes('心跳超时'))
  }
})
