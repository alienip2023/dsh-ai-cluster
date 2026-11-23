/**
 * 压测后 B1：hub 推来的模型能力不能在节点上丢。
 *
 * 主控（ds-bot modelV2）发来的 provider.models 带 contextWindow / maxTokens / input / reasoningEfforts；节点以前只落
 * {id,name}，pi-ai 把没声明 input 的模型当「只有文本」，节点上的模型读不了图片。这里用真实 handleConfigPush + 真实文件：
 * 字段落盘；不合格的字段整个丢掉（pi-ai 对写错的字段会拒绝整条路线）；摘要含这些字段，所以改了能力节点会重启。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleConfigPush } from '../lib/node/config-sync.js'
import { cleanPiModel, cleanPiProviderExtras, piModelYaml, validatePatchYaml } from '../lib/node/config-managed.js'
import * as src from '../src/sync/managed.js'

function makeHome() {
  const base = mkdtempSync(join(tmpdir(), 'cfg-models-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  return { base, dshHome, profileDir, patch: join(profileDir, 'cordis.patch.yml'), state: join(dshHome, 'config-sync.json') }
}
const provider = (models, extra = {}) => ({ id: 'vision-co', api: 'openai-completions', baseURL: 'https://example.test/v1', apiKeyEnv: 'VISION_API_KEY', apiKey: 'sk-secret-0123456789', models, ...extra })
const payload = (revision, providers) => ({ schema: 2, revision, providers, plugins: [], cliExpect: [] })
function push(home, data) {
  const acks = []
  const restarts = []
  const result = handleConfigPush({
    data, dshHome: home.dshHome, profileDir: home.profileDir,
    send: (type, d) => acks.push({ type, d }), logger: () => {}, _restartFn: () => restarts.push(1),
  })
  return { result, acks, restarts }
}

const full = {
  id: 'vision-1', name: 'Vision One', contextWindow: 200000, maxTokens: 8192, input: ['text', 'image'],
  reasoningEfforts: { off: null, low: 'low', high: 'high' },
}

describe('model fields reach the node\'s patch', () => {
  let home
  beforeEach(() => { home = makeHome() })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))

  test('MF-1: contextWindow, maxTokens, input and reasoningEfforts are written (input [text, image] is what lets the model read images)', () => {
    const { result } = push(home, payload(1, [provider([full, { id: 'plain', name: 'Plain' }])]))
    assert.equal(result.ok, true, JSON.stringify(result))
    const patch = readFileSync(home.patch, 'utf-8')
    assert.equal(validatePatchYaml(patch), null)
    assert.match(patch, /- id: "vision-1"\n {12}name: "Vision One"\n {12}contextWindow: 200000\n {12}maxTokens: 8192\n {12}input: \["text", "image"\]\n {12}reasoningEfforts:\n {14}off: null\n {14}low: "low"\n {14}high: "high"\n/)
    assert.match(patch, /- id: "plain"\n {12}name: "Plain"\n(?! {12}(contextWindow|input))/, 'a model that declares nothing gets nothing invented')
    assert.equal(patch.includes('sk-secret'), false, 'the key never goes into the patch')
  })

  test('MF-2: the file parses as YAML and has exactly the shape pi-ai\'s profile expects', async () => {
    const yaml = (await import('node:module')).createRequire(import.meta.url)
    let parser
    try { parser = yaml('js-yaml') } catch { try { parser = yaml('yaml') } catch { parser = undefined } }
    if (parser === undefined) return   // no parser installed here: the byte-level test above still pins the text
    push(home, payload(1, [provider([full], { displayName: 'Vision Co', streamIdleTimeoutMs: 120000 })]))
    const parsed = (parser.load ?? parser.parse).call(parser, readFileSync(home.patch, 'utf-8'))
    const entry = parsed.find(item => item.id === 'llm-pi-ai')
    const route = entry.config.providers['vision-co']
    assert.deepEqual(route.models[0], { id: 'vision-1', name: 'Vision One', contextWindow: 200000, maxTokens: 8192, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high' } })
    assert.equal(route.displayName, 'Vision Co')
    assert.equal(route.streamIdleTimeoutMs, 120000)
  })

  test('MF-3: a field that would make pi-ai reject the whole route is dropped, never written half-way', () => {
    const bad = [
      { id: 'a', name: 'A', input: ['text', 'audio'] },
      { id: 'b', name: 'B', input: [] },
      { id: 'c', name: 'C', input: ['image', 'image'] },
      { id: 'd', name: 'D', contextWindow: 0, maxTokens: -5 },
      { id: 'e', name: 'E', contextWindow: 1.5 },
      { id: 'f', name: 'F', reasoningEfforts: { turbo: 'x' } },
      { id: 'g', name: 'G', reasoningEfforts: { low: null } },
      { id: 'h', name: 'H', reasoningEfforts: { off: null } },
      { id: 'i', name: 'I', reasoningEfforts: {} },
      { id: 'j', name: 'J', reasoningEfforts: 'high' },
    ]
    const { result } = push(home, payload(1, [provider(bad)]))
    assert.equal(result.ok, true, JSON.stringify(result))
    const patch = readFileSync(home.patch, 'utf-8')
    assert.equal(/contextWindow|maxTokens|input:|reasoningEfforts/.test(patch), false, 'nothing invalid reached the file')
    for (const model of bad) assert.match(patch, new RegExp(`- id: "${model.id}"`), `model ${model.id} is still listed`)
    // reasoningEfforts: false (a non-reasoning model) is valid and kept
    push(home, payload(2, [provider([{ id: 'k', name: 'K', reasoningEfforts: false }])]))
    assert.match(readFileSync(home.patch, 'utf-8'), /reasoningEfforts: false/)
  })

  test('MF-4: changing only a model\'s capabilities is a change the node restarts for; an unchanged push is not', () => {
    const first = push(home, payload(1, [provider([{ id: 'vision-1', name: 'Vision One' }])]))
    assert.equal(first.result.ok, true)
    const same = push(home, payload(2, [provider([{ id: 'vision-1', name: 'Vision One' }])]))
    assert.equal(same.result.shouldRestart, false, 'identical models: no restart')
    const upgraded = push(home, payload(3, [provider([{ id: 'vision-1', name: 'Vision One', input: ['text', 'image'] }])]))
    assert.equal(upgraded.result.ok, true)
    assert.equal(upgraded.result.shouldRestart, true, 'the model can read images now: the running node must restart to see it')
    assert.match(readFileSync(home.patch, 'utf-8'), /input: \["text", "image"\]/)
    const again = push(home, payload(4, [provider([{ id: 'vision-1', name: 'Vision One', input: ['text', 'image'] }])]))
    assert.equal(again.result.shouldRestart, false)
    const idle = push(home, payload(5, [provider([{ id: 'vision-1', name: 'Vision One', input: ['text', 'image'] }], { streamIdleTimeoutMs: 90000 })]))
    assert.equal(idle.result.shouldRestart, true, 'a provider-level change is a change too')
  })
})

describe('the cleaners', () => {
  test('MF-5: cleanPiModel keeps only what pi-ai accepts; the src copy is the same', () => {
    assert.deepEqual(cleanPiModel({ id: 'm' }), { id: 'm', name: 'm' })
    assert.deepEqual(cleanPiModel(full), full)
    for (const impl of [cleanPiModel, src.cleanPiModel]) {
      assert.deepEqual(impl({ ...full, input: ['video'], reasoningEfforts: { low: 'low', turbo: 'x' } }), { id: 'vision-1', name: 'Vision One', contextWindow: 200000, maxTokens: 8192 })
    }
    assert.deepEqual(cleanPiProviderExtras({ displayName: 'D', streamIdleTimeoutMs: 5, compat: { x: 1 }, headers: { a: 'secret' } }), { displayName: 'D', streamIdleTimeoutMs: 5 }, 'compat and headers never go to the node')
    assert.equal(piModelYaml(cleanPiModel(full), 4), src.piModelYaml(src.cleanPiModel(full), 4), 'the src copy writes the same text')
  })
})
