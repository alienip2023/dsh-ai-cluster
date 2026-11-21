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
  assert.ok(plugin && Array.isArray(plugin.P2_SCREENS), 'panel factory must export P2_SCREENS')
  assert.equal(typeof plugin.selectHubScreen, 'function')
  return plugin
}

test('hub screen ids and labels match the five-screen skeleton', () => {
  const { P2_SCREENS } = loadView()
  assert.deepEqual(Array.from(P2_SCREENS, (entry) => entry[0]), ['nodes', 'tasks', 'team'])
  assert.deepEqual(Array.from(P2_SCREENS, (entry) => entry[1]), ['节点', '任务', '团队'])
})

test('empty hub screen defaults to computers', () => {
  assert.equal(loadView().selectHubScreen({}), 'nodes')
})

test('unknown hub screen defaults to computers', () => {
  assert.equal(loadView().selectHubScreen({ screen: 'nope' }), 'nodes')
})

test('hub screen remembers models', () => {
  assert.equal(loadView().selectHubScreen({ screen: 'models' }), 'team')
})

test('worker branch does not reference P2_SCREENS', () => {
  const workerStart = src.indexOf('/* ── Worker 视图（副机）')
  const hubStart = src.indexOf('/* ── Hub 视图（主机）')
  assert.ok(workerStart >= 0 && hubStart > workerStart, 'worker and hub branch markers must exist in order')
  assert.doesNotMatch(src.slice(workerStart, hubStart), /P2_SCREENS/)
})
