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
  assert.equal(typeof plugin.nodeCardView, 'function')
  return plugin
}

function allStrings(v, out = []) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => allStrings(x, out))
  return out
}

test('1. missing resource reports no load and leaks no 0%', () => {
  const v = loadView().nodeCardView({ resource: null, silentMs: null })
  assert.equal(v.loadReported, false)
  assert.equal(v.cpuLabel, '负载未上报')
  assert.equal(v.memLabel, '负载未上报')
  const joined = allStrings(v).join('|')
  assert.equal(joined.includes('0%'), false)
  assert.equal(joined.includes('0/0'), false)
})

test('2. reported resource formats labels', () => {
  const v = loadView().nodeCardView({ resource: { cpuPct: 12.6, memUsedMb: 100, memTotalMb: 400 } })
  assert.equal(v.loadReported, true)
  assert.equal(v.cpuLabel, '13%')
  assert.equal(v.memLabel, '100/400 MB')
})

test('2b. non-finite values fall back to ?', () => {
  const v = loadView().nodeCardView({ resource: { cpuPct: 'x', memUsedMb: NaN, memTotalMb: 400 } })
  assert.equal(v.cpuLabel, '?')
  assert.equal(v.memLabel, '?/400 MB')
})

test('3. offline + stale shows both, 离线 first', () => {
  const v = loadView().nodeCardView({ online: false, stale: true })
  assert.deepEqual(Array.from(v.statusLines), ['离线', '心跳超时'])
})

test('4. online + stale shows both', () => {
  const v = loadView().nodeCardView({ online: true, stale: true })
  assert.ok(v.statusLines.includes('在线'))
  assert.ok(v.statusLines.includes('心跳超时'))
  assert.equal(v.statusLines.includes('离线'), false)
})

test('5. online only', () => {
  const v = loadView().nodeCardView({ online: true })
  assert.deepEqual(Array.from(v.statusLines), ['在线'])
})

test('projection defaults for absent / odd input', () => {
  const p = loadView()
  assert.equal(p.nodeCardView().nodeId, '')
  assert.equal(p.nodeCardView({ online: 'yes', stale: 1 }).online, false)
  assert.equal(p.nodeCardView({ resource: 5 }).loadReported, false)
})

test('6. NodeCard renders from nodeCardView, old literal gone', () => {
  const a = src.indexOf('function NodeCard(props)')
  const b = src.indexOf('function NodeCardGrid(props)')
  assert.ok(a > 0 && b > a)
  const slice = src.slice(a, b)
  assert.equal(slice.includes('资源未上报'), false)
  assert.ok(slice.includes('nodeCardView('))
})
