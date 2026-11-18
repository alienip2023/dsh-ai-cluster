import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { modelListOf } from '../../src/http/model-list.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../../lib/client.js'), 'utf8')

function loadView() {
  let plugin = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) {
          plugin = mod.factory(function (id) {
            if (id !== 'react') throw new Error('unexpected require ' + id)
            return {
              createElement() { return null },
              useState(v) { return [v, function () {}] },
              useEffect() {},
              useRef(v) { return { current: v } },
              useMemo(fn) { return fn() },
            }
          })
        },
      },
    },
    console,
  }
  vm.runInNewContext(src, sandbox, { filename: 'lib/client.js' })
  assert.equal(typeof plugin.modelRows, 'function')
  return plugin
}

const plain = (v) => JSON.parse(JSON.stringify(v))
const FIXTURES = {
  missing: [{ nodeId: 'n1', defaultModel: 'a' }],
  nullModels: [{ nodeId: 'n1', models: null, defaultModel: '' }],
  mixed: [{ nodeId: 'n1', defaultModel: 'a', models: [{ id: 'a' }, { id: '' }, { id: 42 }] }],
  empty: [{ nodeId: 'n1', models: [] }],
  skipped: [null, 'x', { nodeId: '' }, { nodeId: 7 }, { nodeId: 'n2', models: [null, 'a', { id: 'z' }] }, { nodeId: 'n1', models: [] }],
}

test('parity: modelRows deep-equals modelListOf', () => {
  const P = loadView()
  for (const [name, fx] of Object.entries(FIXTURES)) {
    assert.deepEqual(plain(P.modelRows(fx)), plain(modelListOf(fx)), name)
  }
})

test('null models is unreported; [] is reported-empty; invalid entries dropped; order kept', () => {
  const P = loadView()
  const [nul] = P.modelRows(FIXTURES.nullModels)
  assert.equal(nul.reported, false)
  assert.equal(nul.defaultModel, null)
  const [emp] = P.modelRows(FIXTURES.empty)
  assert.equal(emp.reported, true)
  assert.equal(emp.ids.length, 0)
  const [mix] = P.modelRows(FIXTURES.mixed)
  assert.deepEqual(plain(mix.ids), ['a'])
  assert.deepEqual(plain(P.modelRows(FIXTURES.skipped).map((r) => r.nodeId)), ['n2', 'n1'])
})

const effectStart = src.indexOf('React.useEffect(function () {\n        function store(')
const effectSlice = effectStart >= 0 ? src.slice(effectStart, src.indexOf('}, [activeScreen])', effectStart)) : ''
const modelsStart = src.indexOf("screen === 'models' ?")
const renderSlice = modelsStart >= 0 ? src.slice(modelsStart, src.indexOf("h('p', null, '未接入')", modelsStart)) : ''

test('source: models branch fetches /models and renders distinct sentences', () => {
  assert.ok(effectSlice && renderSlice)
  const branch = effectSlice.slice(effectSlice.indexOf("activeScreen === 'models'"))
  assert.match(branch, /apiGet\('\/models'\)/)
  assert.match(renderSlice, /同步状态未采集/)
  assert.match(renderSlice, /未上报/)
  assert.match(renderSlice, /明确没有/)
  assert.match(renderSlice, /先接一台电脑/)
  assert.match(renderSlice, /dra-hl/)
  assert.match(renderSlice, /默认/)
  const nullBranch = renderSlice.slice(renderSlice.indexOf('!row.reported'), renderSlice.indexOf('row.ids.length === 0'))
  assert.match(nullBranch, /未上报/)
  assert.doesNotMatch(nullBranch, /明确没有|0 个/)
})

test('source: no sync path, apiKey or appliedRevision in the client', () => {
  assert.doesNotMatch(src, /models\/sync/)
  assert.doesNotMatch(src, /apiKey/)
  assert.doesNotMatch(src, /appliedRevision/)
})

test('source: fetch is guarded once per mount and lives in the effect', () => {
  assert.match(effectSlice, /!screenFetched\.current\.models/)
  assert.match(effectSlice, /screenFetched\.current\.models\s*=\s*true/)
  assert.doesNotMatch(renderSlice, /apiGet/)
})
