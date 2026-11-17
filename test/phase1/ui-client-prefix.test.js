import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const src = fs.readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')

function loadPanel() {
  let plugin
  vm.runInNewContext(src, {
    window: { __ModuleLoader__: { load(mod) {
      plugin = mod.factory(id => {
        assert.equal(id, 'react')
        return {
          createElement(type, props, ...children) { return { type, props: props || {}, children } },
          useState(value) { return [typeof value === 'function' ? value() : value, () => {}] },
          useEffect() {},
          useRef(value) { return { current: value } },
          useMemo(fn) { return fn() },
        }
      })
    } } },
  }, { filename: 'lib/client.js' })
  return plugin
}

// The panel keeps request helpers private. Execute their actual source with a
// stub fetch, without adding browser exports or making network requests.
function loadHelpers(fetch) {
  const constants = src.match(/const API(?:_FALLBACK)? = '[^']+'/g)
  assert.equal(constants?.length, 2)
  const start = src.indexOf('    function readJson(')
  const end = src.indexOf('    function copyText(', start)
  assert.ok(start >= 0 && end > start)
  return vm.runInNewContext(
    constants.join('\n') + '\n' + src.slice(start, end) + '\n({ apiGet, apiPost })',
    { fetch },
    { filename: 'lib/client.js request helpers' },
  )
}

function response(status, body = { status }) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
}

test('panel loads and declares the new UI prefix with a legacy fallback', () => {
  assert.equal(typeof loadPanel().apply, 'function')
  assert.ok(src.includes("const API = '/api/ai-cluster/ui'"))
  assert.ok(src.includes("const API_FALLBACK = '/api/remote-agent/ui'"))
  for (const name of ['apiGet', 'apiPost']) {
    const body = src.match(new RegExp('function ' + name + '\\([^]*?\\n    }'))?.[0]
    assert.ok(body, name + ' must exist')
    assert.match(body, /API_FALLBACK/)
    assert.match(body, /\.status === 404/)
  }
})

for (const name of ['apiGet', 'apiPost']) {
  const path = '/config?probe=1'
  const body = { relayUrl: 'ws://relay.example', autoHubToken: 'test-token' }

  function setup(replies) {
    const calls = []
    const helpers = loadHelpers(async (url, options) => {
      calls.push({ url, options })
      assert.ok(replies.length, 'unexpected additional request')
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return reply
    })
    return { calls, call: () => helpers[name](path, body) }
  }

  test(name + ' retries a 404 once with the same path and request options', async () => {
    const result = { config: { role: 'hub' } }
    const first = response(404)
    first.json = () => { throw new Error('the first 404 must not be parsed') }
    const { calls, call } = setup([first, response(200, result)])
    assert.equal(await call(), result)
    assert.deepEqual(calls.map(c => c.url), [
      '/api/ai-cluster/ui' + path,
      '/api/remote-agent/ui' + path,
    ])
    assert.deepEqual(calls[1].options, calls[0].options)
    if (name === 'apiGet') {
      assert.equal(calls[0].options.cache, 'no-store')
    } else {
      assert.equal(calls[0].options.method, 'POST')
      assert.equal(calls[0].options.headers['content-type'], 'application/json')
      assert.equal(calls[0].options.body, JSON.stringify(body))
    }
  })

  test(name + ' starts at the new prefix again on every call', async () => {
    const { calls, call } = setup([response(404), response(200), response(200)])
    await call()
    await call()
    assert.deepEqual(calls.map(c => c.url), [
      '/api/ai-cluster/ui' + path,
      '/api/remote-agent/ui' + path,
      '/api/ai-cluster/ui' + path,
    ])
  })

  test(name + ' never retries a second 404', async () => {
    const result = { error: 'missing on both prefixes' }
    const { calls, call } = setup([response(404), response(404, result)])
    await assert.rejects(call(), e => e.status === 404 && e.body === result)
    assert.equal(calls.length, 2)
  })

  for (const status of [200, 403, 405, 500]) {
    test(name + ' preserves HTTP ' + status + ' without fallback', async () => {
      const result = { message: 'original response' }
      const { calls, call } = setup([response(status, result)])
      if (status === 200) assert.equal(await call(), result)
      else await assert.rejects(call(), e => e.status === status && e.body === result)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, '/api/ai-cluster/ui' + path)
    })
  }

  test(name + ' preserves network rejections from either prefix', async () => {
    for (const fallback of [false, true]) {
      const error = new Error('offline')
      const { calls, call } = setup(fallback ? [response(404), error] : [error])
      await assert.rejects(call(), e => e === error)
      assert.equal(calls.length, fallback ? 2 : 1)
    }
  })
}

test('relay autoconfig and config reads use the UI helpers', () => {
  assert.doesNotMatch(src, /fetch\s*\(\s*['"`]\/api\/remote-agent\/ui/)
  assert.equal(src.match(/\/api\/remote-agent\/ui/g)?.length, 1)
  assert.match(src, /apiPost\('\/relay-autoconfig',/)
  assert.equal(src.match(/apiGet\('\/config'\)/g)?.length, 3)
})

test('status and setup paths remain outside the UI prefix', () => {
  assert.ok(src.includes("const STATUS_PATH = '/api/remote-agent/status'"))
  assert.ok(src.includes("const SETUP_STATE_PATH = '/api/remote-agent/setup/state'"))
  assert.ok(src.includes("const SETUP_APPLY_PATH = '/api/remote-agent/setup/apply'"))
})

test('polling tooltip agrees with the unchanged 8000ms interval', () => {
  assert.ok(src.includes('每 8 秒自动刷新'))
  assert.ok(!src.includes('每 4 秒自动刷新'))
  assert.ok(src.includes('const POLL_MS = 8000'))
  assert.equal(loadPanel().POLL_MS, 8000)
})

test('task states use protocol names without legacy aliases', () => {
  const active = src.match(/const ACTIVE_STATUSES = (\[[^\n]+\])/)
  assert.ok(active)
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(active[1]))), [
    'running', 'queued', 'pending_approval',
  ])
  const labels = src.match(/const STATUS_LABEL = (\{[^]*?\n    })/)
  assert.ok(labels)
  const statusLabel = vm.runInNewContext('(' + labels[1] + ')')
  assert.equal(statusLabel.pending_approval, '待批准')
  assert.equal(statusLabel.completed, '已完成')
  assert.equal(statusLabel.interrupted, '已中断')
  assert.ok(!Object.hasOwn(statusLabel, 'done'))
  assert.ok(!Object.hasOwn(statusLabel, 'pending'))
  assert.ok(!Object.hasOwn(statusLabel, 'provisioning'))
  assert.doesNotMatch(src, /t\.status === '(?:done|pending)'/)
  assert.match(src, /\['completed', '已完成'\]/)
  assert.match(src, /filter === 'completed'/)
  assert.match(src, /taskFilter === 'completed'/)
  assert.match(src, /t\.status === 'pending_approval' \? 'warn'/)
  assert.match(src, /const done = list\.filter\(function \(t\) \{ return t\.status === 'completed' }\)\.length/)
})
