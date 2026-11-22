/**
 * 提案 #27 完整版：副机上报可用模型清单 → hub 摄入 → 节点视图透出 → 面板下拉。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么 v0.7.0 只做了一半
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 当时的判断是"in-process 后端没有稳定的清单 API（DSH 内部的 `model/list`
 * 走 app-server 协议面，fiber 服务摸不到）"。**那个判断已经过时** ——
 * `ctx.llm` 现在直接暴露：
 *
 *     listProviders(): LlmProviderInfo[]                     // {id, name}
 *     async listModels(provider): Promise<LlmModelInfo[]>    // {provider, id, name}
 *
 * 所以面板可以真的渲染下拉，而不是让用户猜 provider/model 名、填错了等任务
 * 跑到副机才失败（浪费一轮往返 + 烧一个 taskId）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 链路（四段，任一断掉面板就退回自由文本）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. 副机 `readAvailableModels(ctx)` —— 探测 + 缓存 + 上限
 *   2. RESOURCE 帧带 `models`（**缓存值**，因为 interval 回调是同步的）
 *   3. hub `registry-ingest` 字段级清洗 → `rec.models`
 *   4. `registry.list()` → `nodeView()` → 面板 `<select>`
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全边界（硬要求，逐段钉住）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **只上报 provider 键名 + model id + 显示名。**
 * 绝不上报 apiKeyEnv 的值、baseURL、任何凭证、未注册的 provider。
 * `listProviders()` 只返回已注册（有 adapter）的 route —— 天然满足"不泄露
 * 这台机器配了哪些渠道"，只有真能用的才会出现。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { NODE_TO_HUB } from '../lib/protocol.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const nodeIndex = read('lib/node/index.js')
const ingest = read('lib/hub/registry-ingest.js')
const registry = read('lib/hub/node-registry.js')
const views = read('lib/hub/views.js')
const tools = read('lib/hub/tools.js')
const client = read('lib/client.js')

/* ═══════════════ 段 1：副机侧探测（探测代码已抽到 lib/node/model-catalog.js，按行为测） ═══════════════ */

import { readAvailableModels, createModelRefresher } from '../lib/node/model-catalog.js'

/** 假的 ctx：只有 llm 服务（以及可选的 settings），和宿主里的取法一致：ctx.get('llm')。 */
function fakeCtx({ providers, models, listModels, extra = {} }) {
  const llm = {
    listProviders: () => providers.map(id => ({ id })),
    listModels: listModels ?? (async (id) => models[id] ?? []),
  }
  return { get: (name) => (name === 'llm' ? llm : extra[name]) }
}

test('#27-1：副机用 ctx.llm 的 listProviders + listModels 探测（不是猜配置结构）', async () => {
  const asked = []
  const ctx = fakeCtx({
    providers: ['p1', 'p2'],
    listModels: async (id) => { asked.push(id); return [{ id: `${id}-m`, name: `${id} model` }] },
  })
  const out = await readAvailableModels(ctx)
  assert.deepEqual(asked, ['p1', 'p2'], '应对每个 provider 调 listModels(provider)')
  assert.deepEqual(out.models.map(m => `${m.provider}/${m.id}`), ['p1/p1-m', 'p2/p2-m'])
  // 没有 llm 服务时不猜别的来源：直接 null
  assert.equal(await readAvailableModels({ get: () => undefined }), null)
})

test('#27-1：只上报 provider/id/name(/efforts) —— 绝不带 apiKeyEnv / baseURL / 凭证', async () => {
  const ctx = fakeCtx({
    providers: ['p'],
    models: { p: [{
      id: 'm', name: 'M', apiKeyEnv: 'SECRET_ENV', baseURL: 'https://x', apiKey: 'sk-1', token: 't', secret: 's',
      reasoningEfforts: [{ id: 'low', name: 'Low', apiKey: 'leak' }],
    }] },
  })
  const { models } = await readAvailableModels(ctx)
  assert.deepEqual(Object.keys(models[0]).sort(), ['efforts', 'id', 'name', 'provider'])
  assert.deepEqual(models[0].efforts, [{ id: 'low', name: 'Low' }], 'effort 也只带 id/name')
  assert.doesNotMatch(JSON.stringify(models), /SECRET_ENV|https:\/\/x|sk-1|leak|"token"|"secret"/, '序列化结果里不得出现任何凭证字段或值')
  // 没有 efforts 的模型不带该键
  const plain = await readAvailableModels(fakeCtx({ providers: ['p'], models: { p: [{ id: 'm' }] } }))
  assert.deepEqual(Object.keys(plain.models[0]).sort(), ['id', 'name', 'provider'])
  assert.equal(plain.models[0].name, 'm', '缺 name 时用 id')
})

test('#27-1：单个 provider 探测失败不影响其它（尽力而为）', async () => {
  const ctx = fakeCtx({
    providers: ['bad', 'good'],
    listModels: async (id) => { if (id === 'bad') throw new Error('network down'); return [{ id: 'ok', name: 'OK' }] },
  })
  const out = await readAvailableModels(ctx)
  assert.deepEqual(out.models, [{ provider: 'good', id: 'ok', name: 'OK' }], '失败的 provider 被跳过，其它照常上报')
})

test('#27-1：全部失败时返回 null（面板退回自由文本，不是空数组）', async () => {
  assert.equal(await readAvailableModels(fakeCtx({ providers: ['a', 'b'], listModels: async () => { throw new Error('x') } })), null)
  assert.equal(await readAvailableModels(fakeCtx({ providers: ['a'], models: { a: [] } })), null, '探测到 0 个也是 null')
  assert.equal(await readAvailableModels(fakeCtx({ providers: [], models: {} })), null, '没有 provider 也是 null')
})

test('#27-1：有数量上限（不让 RESOURCE 帧膨胀）', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `M${i}` }))
  // 单 provider 上限 24
  const one = await readAvailableModels(fakeCtx({ providers: ['p'], models: { p: many(500) } }))
  assert.equal(one.models.length, 24)
  // provider 数上限 8（每个给 1 个模型 → 最多 8 条）
  const ids = Array.from({ length: 20 }, (_, i) => `p${i}`)
  const wide = await readAvailableModels(fakeCtx({ providers: ids, listModels: async () => many(1) }))
  assert.equal(wide.models.length, 8)
  assert.equal(new Set(wide.models.map(m => m.provider)).size, 8)
  // 总量上限 64：8 个 provider × 24 = 192 → 截到 64
  const total = await readAvailableModels(fakeCtx({ providers: ids, listModels: async () => many(24) }))
  assert.equal(total.models.length, 64)
  // 字段长度上限
  const long = await readAvailableModels(fakeCtx({ providers: ['p'], models: { p: [{ id: 'x'.repeat(500), name: 'y'.repeat(500) }] } }))
  assert.equal(long.models[0].id.length, 128)
  assert.equal(long.models[0].name.length, 128)
})

/* ═══════════════ 段 2：RESOURCE 帧带缓存 ═══════════════ */

test('#27-2：RESOURCE 帧带 models，且来自缓存（同步 interval 不能 await）', () => {
  // 节点侧发 RESOURCE 的位置是同步 setInterval 回调：只能读缓存，不能在里面 await 探测。
  const code = stripComments(nodeIndex)
  const i = code.indexOf('send(NODE_TO_HUB.RESOURCE')
  assert.ok(i >= 0, '应发送 RESOURCE 帧')
  assert.match(code.slice(i, i + 500), /models:\s*getCachedModels\(\)/, '帧里应带缓存的模型清单（不是 await 探测）')
})

test('#27-2：刷新器用串行链 + 排队标志，探测失败保留旧缓存', async () => {
  // 行为：刷新器抽在 model-catalog.js，可以直接测。
  let calls = 0
  let fail = false
  const gate = []
  const ctx = fakeCtx({
    providers: ['p'],
    listModels: () => new Promise((resolve, reject) => { calls += 1; gate.push(() => (fail ? reject(new Error('flap')) : resolve([{ id: 'm', name: 'M' }]))) }),
  })
  const r = createModelRefresher(ctx, { refreshMs: 1e9, retryMs: 1e9 })
  assert.equal(r.getCachedModels(), null, '一开始没有缓存')
  r.refresh(); r.refresh(); r.refresh()          // 连点三次
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1, '探测不堆积：同一时刻只有一个在飞')
  gate.shift()()                                  // 第一次探测完成
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(r.getCachedModels()?.models?.length, 1, '成功后缓存有值')
  const before = r.getCachedModels()
  fail = true
  r.refresh()
  await new Promise(resolve => setTimeout(resolve, 20))
  while (gate.length) gate.shift()()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(r.getCachedModels(), before, '一次网络抖动不该让面板下拉消失：失败保留旧缓存')
})

/* ═══════════════ 段 3：hub 摄入 ═══════════════ */

// 真帧走真 NodeRegistry：不扫源码，断言落在注册表里真实留下的记录上。
function ingestResource(d) {
  const registry = new NodeRegistry({ log() {}, relay: { ready: true, send: () => true } })
  registry.nodes.set('n1', { nodeId: 'n1', online: true, lastSeen: 0 })
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.RESOURCE, d })
  return registry.nodes.get('n1')
}

test('#27-3：真 RESOURCE 帧 → 字段级清洗 + 独立封顶，efforts 一路保留', () => {
  const rec = ingestResource({
    models: {
      models: [
        { provider: 'ccmax', id: 'sonnet', name: 'Sonnet', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        { provider: 'piion', id: 'm1', name: 'M1' },
        { provider: 'bad', id: '   ', name: 'blank id' },
        { nope: true },
      ],
    },
  })
  // 缺 id / 非对象被丢弃；带 efforts 的条目原样（深等）保留；无 efforts 的条目不带该键。
  assert.deepEqual(rec.models, [
    { provider: 'ccmax', id: 'sonnet', name: 'Sonnet', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    { provider: 'piion', id: 'm1', name: 'M1' },
  ])
})

test('#27-3 边界：id ≤64、name ≤128，空 id 与非对象丢弃', () => {
  const longId = 'x'.repeat(100)
  const longName = 'y'.repeat(200)
  const rec = ingestResource({
    models: {
      models: [{
        provider: 'p', id: 'm', name: 'M',
        efforts: [
          { id: longId, name: longName },
          { id: '', name: 'no id' },
          { id: '   ', name: 'blank id' },
          null,
          'low',
          { id: 'ok' },
        ],
      }],
    },
  })
  assert.deepEqual(rec.models[0].efforts, [
    { id: longId.slice(0, 64), name: longName.slice(0, 128) },
    { id: 'ok', name: 'ok' },
  ])
})

test('#27-3 边界：efforts 条数独立封顶（16）', () => {
  const rec = ingestResource({
    models: { models: [{ provider: 'p', id: 'm', name: 'M', efforts: Array.from({ length: 40 }, (_, i) => ({ id: 'e' + i, name: 'E' + i })) }] },
  })
  const got = rec.models[0].efforts
  assert.equal(got.length, 16, 'hub 自己封顶，不信任对端')
  assert.equal(got[15].id, 'e15')
})

test('#27-3 R3：空 effort id（含纯空白）必须被过滤', () => {
  const rec = ingestResource({ models: { models: [{ provider: 'p', id: 'm', name: 'M', efforts: [{ id: '', name: 'x' }, { id: '  ', name: 'y' }, { id: 'ok' }] }] } })
  assert.deepEqual(rec.models[0].efforts, [{ id: 'ok', name: 'ok' }], '只剩有效等级，name 回退到 id')
})

test('#27-3：models 为 null 时**保留旧值**（一次抖动不清空面板下拉）', () => {
  const code = stripComments(ingest)
  const i = code.indexOf('const rawModels')
  const seg = code.slice(i, i + 1400)
  // 只有 rawModels 为对象时才替换 —— null/缺失走不到赋值
  assert.match(seg, /if\s*\(rawModels\)\s*\{/, '只有对象才替换（null 保留旧值）')
  // 对比：defaultModel 的 null 是"清空"语义，两者刻意不同
  assert.match(code, /if \(d\.defaultModel === null\) rec\.defaultModel = null/, 'defaultModel 的 null 是清空语义（与 models 不同）')
})

/* ═══════════════ 段 4：投影与面板 ═══════════════ */

test('#27-4：registry.list() 透出 models（null 与 [] 语义不同）', () => {
  // 行为断言（原先截 200 字符源码窗口，投影加了 efforts 后窗口失效）：
  // 从未上报 → null（消费方退回自由文本）；上报了空数组 → [] 是"确实一个都没有"，不能被抹成 null。
  const reg = new NodeRegistry({ log() {}, relay: { ready: true, send: () => true } })
  for (const [nodeId, models] of [['never', undefined], ['bad', 'oops'], ['empty', []], ['some', [{ id: 'm', name: 'M' }]]]) {
    reg.nodes.set(nodeId, { nodeId, online: true, lastSeen: 0, tasks: new Map(), hello: {}, ...(models === undefined ? {} : { models }) })
  }
  const byId = Object.fromEntries(reg.list().map((n) => [n.nodeId, n.models]))
  assert.equal(byId.never, null, '从未上报 → null')
  assert.equal(byId.bad, null, '非数组 → null（不是 []）')
  assert.deepEqual(byId.empty, [], '空数组是权威事实，保持 []')
  assert.deepEqual(byId.some, [{ id: 'm', name: 'M' }])
  // modelList() 同一语义
  const viaList = Object.fromEntries(reg.modelList().map((n) => [n.nodeId, n.models]))
  assert.equal(viaList.never, null)
  assert.deepEqual(viaList.empty, [])
})

test('#27-4：nodeView 逐条投影 models（不 spread）', () => {
  const code = stripComments(views)
  const i = code.indexOf('models: Array.isArray(n.models)')
  assert.ok(i >= 0, 'nodeView 应投影 models')
  const seg = code.slice(i, i + 800)
  assert.match(seg, /\.map\(\(m\) => \(\{/, '应逐条构造')
  assert.match(seg, /provider:/, '应有 provider 字段')
  assert.match(seg, /id:/, '应有 id 字段')
  assert.match(seg, /name:/, '应有 name 字段')
  assert.match(seg, /filter\(\(m\) => m\.id !== ''\)/, '应过滤掉空 id')
})

test('#27-4：remote_nodes 的 output schema 声明了 models', () => {
  const i = tools.indexOf("name: 'remote_nodes'")
  assert.ok(i >= 0)
  const seg = tools.slice(i, i + 4000)
  assert.match(seg, /models:\s*\{/, 'schema 应声明 models')
  assert.match(seg, /required: \['id'\]/, 'models 的 items 应 required id')
})

test('#27-4：面板渲染 <select>，含"跟随副机默认"与"自定义"回退', () => {
  const i = client.indexOf('提案 #27')
  assert.ok(i >= 0, '面板应有 #27 的注释块')
  // ⚠ 窗口从 4200 放宽到 8000：加了 modelCustom 开关（v0.9.0 审查 M2 修复）
  // 后这段代码变长了，原窗口会把后面几行的断言取样截断 —— 断言本身没失效，
  // 是取样范围不够（这类"窗口取样"断言很容易在改动后假失败，记一笔）。
  const seg = client.slice(i, i + 8000)

  assert.match(seg, /h\('select'/, '应有 <select>')
  assert.match(seg, /跟随副机默认/, '第一项应是"跟随副机默认"')
  assert.match(seg, /__custom__/, '应有"自定义"选项')
  assert.match(seg, /hasList/, '应区分"有清单"与"没清单"')
  // 没清单时退回文本框
  assert.match(seg, /没有清单|hasList\s*\n?\s*\?/, '没清单应退回文本框（向后兼容旧副机）')
  // 多节点时带节点名后缀
  assert.match(seg, /· ' \+ o\.nodeId|' · ' \+ o\.nodeId/, '多节点时选项应带节点名')
})

test('#27-4：选「自定义…」必须真的展开文本框（v0.9.0 审查 M2）', () => {
  // 原实现靠 `fv.model === '__custom__'` 判定，但表单里存的是**真实模型名**
  // （或空串），从来不是字面量 '__custom__' —— 于是选「自定义…」后
  // select 的 value 弹回原选项，文本框永远不出现（先有鸡才能进自定义态）。
  //
  // 修法：独立布尔 state `modelCustom` 表达"用户主动选了自定义"，
  // isCustom = modelCustom || (model 非空且不在清单里)。
  const i = client.indexOf('提案 #27')
  const seg = client.slice(i, i + 8000)

  assert.match(seg, /modelCustom/, '应有独立的 modelCustom 开关')
  assert.match(seg, /isCustom = modelCustom \|\|/, 'isCustom 必须把 modelCustom 算进去')
  assert.match(seg, /if \(v === '__custom__'\)[\s\S]{0,300}?setModelCustom\(true\)/, '选自定义应置开关')
  assert.match(seg, /setModelCustom\(false\)/, '选具体值应关闭开关')
})

/* ═══════════════ 安全：不得泄露凭证 ═══════════════ */

test('#27 安全：全链路不得出现 apiKeyEnv / baseURL 的上报', () => {
  // 副机侧
  const ni = stripComments(nodeIndex)
  const ri = ni.indexOf('export async function readAvailableModels')
  const rseg = ni.slice(ri, ri + 2600)
  assert.ok(!/apiKeyEnv/.test(rseg), '副机侧不得读 apiKeyEnv')
  assert.ok(!/baseURL/.test(rseg), '副机侧不得读 baseURL')

  // hub 摄入侧
  const ig = stripComments(ingest)
  const ii = ig.indexOf('const rawModels')
  const iseg = ig.slice(ii, ii + 1400)
  assert.ok(!/apiKeyEnv/.test(iseg), 'hub 侧不得接收 apiKeyEnv')
  assert.ok(!/baseURL/.test(iseg), 'hub 侧不得接收 baseURL')
})
