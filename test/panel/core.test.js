import assert from 'node:assert/strict'
import test from 'node:test'
import { makeCore } from './_fake.js'
import { coreActiveStatuses, coreApi, coreApiLegacy, coreFailedStatuses, coreThemeResolve } from '../../src/panel/core.js'
import { dataActivePollMs, dataPollDelay, dataPollMs, dataSetupStatePath, dataShouldPoll, dataStatusPath } from '../../src/panel/data.js'
import { settingsApplyPath, settingsRotatePath } from '../../src/panel/settings.js'

function response(status, body = { status }) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
}

/** 用记录型 fetch 桩跑 fn，返回请求记录；replies 按顺序给，多发请求会失败。 */
async function withFetch(replies, fn) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    assert.ok(replies.length, 'unexpected additional request: ' + url)
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    return reply
  }
  try {
    await fn(calls)
  } finally {
    globalThis.fetch = real
  }
  return calls
}

test('the UI prefix is the new one with the legacy prefix as fallback', () => {
  assert.equal(coreApi, '/api/ai-cluster/ui')
  assert.equal(coreApiLegacy, '/api/remote-agent/ui')
})

for (const name of ['get', 'post']) {
  const path = '/config?probe=1'
  const body = { relayUrl: 'ws://relay.example', autoHubToken: 'test-token' }
  const call = (api) => api[name](path, body)

  test('api.' + name + ' retries a 404 once with the same path and request options', async () => {
    const api = makeCore().api
    const result = { config: { role: 'hub' } }
    const first = response(404)
    first.json = () => { throw new Error('the first 404 must not be parsed') }
    const calls = await withFetch([first, response(200, result)], async () => { assert.equal(await call(api), result) })
    assert.deepEqual(calls.map((c) => c.url), [coreApi + path, coreApiLegacy + path])
    assert.deepEqual(calls[1].options, calls[0].options)
    if (name === 'get') {
      assert.equal(calls[0].options.cache, 'no-store')
    } else {
      assert.equal(calls[0].options.method, 'POST')
      assert.equal(calls[0].options.headers['content-type'], 'application/json')
      assert.equal(calls[0].options.body, JSON.stringify(body))
    }
  })

  test('api.' + name + ' starts at the new prefix again on every call', async () => {
    const api = makeCore().api
    const calls = await withFetch([response(404), response(200), response(200)], async () => { await call(api); await call(api) })
    assert.deepEqual(calls.map((c) => c.url), [coreApi + path, coreApiLegacy + path, coreApi + path])
  })

  test('api.' + name + ' never retries a second 404', async () => {
    const api = makeCore().api
    const result = { error: 'missing on both prefixes' }
    const calls = await withFetch([response(404), response(404, result)], async () => {
      await assert.rejects(call(api), (e) => e.status === 404 && e.body === result)
    })
    assert.equal(calls.length, 2)
  })

  for (const status of [200, 403, 405, 500]) {
    test('api.' + name + ' preserves HTTP ' + status + ' without fallback', async () => {
      const api = makeCore().api
      const result = { message: 'original response' }
      const calls = await withFetch([response(status, result)], async () => {
        if (status === 200) assert.equal(await call(api), result)
        else await assert.rejects(call(api), (e) => e.status === status && e.body === result && e.message === 'original response')
      })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, coreApi + path)
    })
  }

  test('api.' + name + ' preserves network rejections from either prefix', async () => {
    const api = makeCore().api
    for (const fallback of [false, true]) {
      const error = new Error('offline')
      const calls = await withFetch(fallback ? [response(404), error] : [error], async () => {
        await assert.rejects(call(api), (e) => e === error)
      })
      assert.equal(calls.length, fallback ? 2 : 1)
    }
  })
}

test('an error response without a message falls back to the HTTP status; the body stays on the error', async () => {
  const api = makeCore().api
  await withFetch([response(502, { code: 'x' })], async () => {
    await assert.rejects(api.get('/x'), (e) => e.message === 'HTTP 502' && e.body.code === 'x')
  })
  await withFetch([{ status: 500, ok: false, json: async () => { throw new Error('not json') } }], async () => {
    await assert.rejects(api.get('/x'), (e) => e.status === 500 && e.message === 'HTTP 500')
  })
})

test('getPath / postPath use the full path: no UI prefix, no 404 fallback', async () => {
  const api = makeCore().api
  const result = { ok: true }
  const calls = await withFetch([response(200, result), response(200, result)], async () => {
    assert.equal(await api.getPath(dataStatusPath), result)
    assert.equal(await api.postPath(settingsApplyPath, { role: 'hub' }), result)
  })
  assert.deepEqual(calls.map((c) => c.url), [dataStatusPath, settingsApplyPath])
  assert.equal(calls[0].options.cache, 'no-store')
  assert.equal(calls[1].options.method, 'POST')
  assert.equal(calls[1].options.body, JSON.stringify({ role: 'hub' }))
  const missing = await withFetch([response(404, { error: 'nope' })], async () => {
    await assert.rejects(api.getPath(dataStatusPath), (e) => e.status === 404 && e.body.error === 'nope')
  })
  assert.equal(missing.length, 1, '完整路径的 404 不重试')
})

test('status and setup paths stay outside the UI prefix', () => {
  assert.equal(dataStatusPath, '/api/remote-agent/status')
  assert.equal(dataSetupStatePath, '/api/remote-agent/setup/state')
  assert.equal(settingsApplyPath, '/api/remote-agent/setup/apply')
  assert.equal(settingsRotatePath, '/api/remote-agent/setup/rotate-token')
  for (const p of [dataStatusPath, dataSetupStatePath, settingsApplyPath, settingsRotatePath]) {
    assert.equal(p.startsWith(coreApi), false)
    assert.equal(p.startsWith(coreApiLegacy), false)
  }
})

test('safe turns a rejected request into { ok:false, error, status } instead of throwing', async () => {
  const { safe } = makeCore()
  const e = Object.assign(new Error('boom'), { status: 503, body: { message: 'upstream down' } })
  assert.deepEqual(await safe(Promise.reject(e)), { ok: false, status: 503, error: 'upstream down', body: { message: 'upstream down' } })
  assert.equal((await safe(Promise.reject(new Error('plain')))).error, 'plain')
  assert.deepEqual(await safe(Promise.resolve({ ok: true, n: 1 })), { ok: true, n: 1 })
})

test('polling: 8s idle, 3s while something is active, paused while the page is hidden', () => {
  assert.equal(dataPollMs, 8000)
  assert.equal(dataActivePollMs, 3000)
  assert.equal(dataPollDelay(0), 8000)
  assert.equal(dataPollDelay(2), 3000)
  assert.equal(dataShouldPoll({ hidden: true }), false)
  assert.equal(dataShouldPoll({ hidden: false }), true)
  assert.equal(dataShouldPoll(undefined), true)
})

test('task states use protocol names without legacy aliases', () => {
  assert.deepEqual([...coreActiveStatuses], ['running', 'queued', 'pending_approval'])
  assert.deepEqual([...coreFailedStatuses], ['failed', 'aborted', 'rejected'])
  for (const legacy of ['done', 'pending', 'provisioning']) {
    assert.equal(coreActiveStatuses.includes(legacy) || coreFailedStatuses.includes(legacy), false, legacy)
  }
})

test('theme: saved value beats host, host beats prefers-color-scheme, default is dark', () => {
  const vals = [undefined, null, '', 'light', 'dark', 'bogus']
  const prefs = [undefined, null, true, false]
  for (const saved of vals) for (const host of vals) for (const prefersDark of prefs) {
    const want = saved === 'light' || saved === 'dark' ? saved
      : host === 'light' || host === 'dark' ? host
        : prefersDark === true ? 'dark' : prefersDark === false ? 'light' : 'dark'
    assert.equal(coreThemeResolve({ saved, host, prefersDark }), want, JSON.stringify({ saved, host, prefersDark }))
  }
  assert.equal(coreThemeResolve(), 'dark')
  assert.equal(coreThemeResolve(null), 'dark')
  assert.equal(coreThemeResolve({ saved: 'dark', host: 'light', prefersDark: false }), 'dark')
  assert.equal(coreThemeResolve({ host: 'light', prefersDark: true }), 'light')
})
