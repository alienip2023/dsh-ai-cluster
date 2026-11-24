import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

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
  assert.equal(typeof plugin.screenAvailability, 'function')
  return plugin
}

const S1 = { ok: false, code: 'not-available', screen: 'S1', reason: 'roster-store-not-built' }
const S4 = { ok: false, code: 'not-available', screen: 'S4', reason: 'memory-store-not-built' }

test('S1 not-available is an empty state carrying the reason', () => {
  const r = loadView().screenAvailability(S1, 200)
  assert.equal(r.kind, 'empty')
  assert.equal(r.status, 200)
  assert.equal(r.reason, 'roster-store-not-built')
  assert.equal('items' in r, false)
})

test('S4 not-available is an empty state carrying the reason', () => {
  const r = loadView().screenAvailability(S4, 200)
  assert.equal(r.kind, 'empty')
  assert.equal(r.reason, 'memory-store-not-built')
  assert.equal('items' in r, false)
})

test('status 500 is an error', () => {
  const r = loadView().screenAvailability(S1, 500)
  assert.equal(r.kind, 'error')
  assert.equal(r.status, 500)
  assert.equal('items' in r, false)
})

test('status 200 with {} is an unexpected shape', () => {
  const v = loadView()
  for (const body of [{}, null, 'x']) {
    const r = v.screenAvailability(body, 200)
    assert.equal(r.kind, 'error')
    assert.equal(r.reason, 'unexpected-shape')
  }
})

const effectStart = src.indexOf('React.useEffect(function () {\n        function store(')
const effectSlice = effectStart >= 0 ? src.slice(effectStart, src.indexOf('}, [activeScreen, pollTick, tick])', effectStart)) : ''

test('source: bots/memory branches fetch and render the exact empty sentences', () => {
  assert.ok(effectSlice, 'screen fetch effect must exist')
  // Merged design: bots, models and memory are sections of the single 'team' screen, so the effect has one
  // 'team' guard per fetch instead of one branch per screen. Each fetch keeps its own in-flight ref.
  const botsBranch = effectSlice.slice(effectSlice.indexOf("activeScreen === 'team' && !botsInflight.current"), effectSlice.indexOf("activeScreen === 'team' && !modelsInflight.current"))
  const modelsBranch = effectSlice.slice(effectSlice.indexOf("activeScreen === 'team' && !modelsInflight.current"), effectSlice.indexOf("activeScreen === 'team' && !talentsInflight.current"))
  assert.ok(botsBranch.length > 0 && modelsBranch.length > 0, 'both team-screen fetch branches exist')
  assert.match(botsBranch, /apiGet\('\/bots'\)/)
  assert.match(modelsBranch, /apiGet\('\/models'\)/)
  // p4：记忆屏不再走本插件的 /memory 桩，由 ui-p4-memory-screen.test.js 覆盖
  assert.doesNotMatch(effectSlice, /apiGet\('\/memory'\)/)
  assert.doesNotMatch(src, /名册未采集，本阶段不建存储/, 'p3-s1: roster stub sentence is gone')
  assert.match(src, /还没有机器人上报/)
  assert.doesNotMatch(src, /记忆存储未建，本阶段不读写/, 'p4: memory stub sentence is gone')
  assert.match(src, /读机器人列表失败/)
  assert.match(src, /读取中…/)
  assert.match(src, /h\('p', null, '未接入'\)/, 'models screen keeps 未接入')
})
