import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { registerUiRoutes, UI_API_PREFIX } from '../../src/http/index.js'

// 宿主的最小替身：把 registerUiRoutes 注册的 exact 路由放进表里，按 pathname 分发；
// 没注册的路径回 404（宿主行为）。非回环对端用伪造 req 直接打 handler。
function setup(t) {
  const routes = new Map()
  const ctx = { webServer: { register: (r) => { routes.set(r.path, r.handler); return () => {} } }, connection: undefined }
  const registry = { list: () => [], getNode: () => null, getTask: () => undefined, onlineNodes: () => [], listTasks: () => [] }
  const disposers = registerUiRoutes({
    ctx, registry, pulls: {}, log: () => {}, defaults: {},
    config: { role: 'hub', relay: { url: 'ws://203.0.113.10:8890/relay', token: 'x' } },
  })
  t.after(() => { for (const d of disposers) { try { d() } catch { /* ignore */ } } })
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (!handler) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not-found"}'); return }
    Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end() })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise((r) => server.close(r)))
    resolve({ routes, port: server.address().port })
  }))
}

function request(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('sec-fetch-site: cross-site → 403', async (t) => {
  const { port } = await setup(t)
  const { status } = await request(port, `${UI_API_PREFIX}/overview`, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(status, 403)
})

test('同一路由 same-origin 请求不是 403（对照：不是一律 403）', async (t) => {
  const { port } = await setup(t)
  const { status } = await request(port, `${UI_API_PREFIX}/overview`, { headers: { 'sec-fetch-site': 'same-origin' } })
  assert.notEqual(status, 403)
})

test('loopback-only 路由 + 非回环对端 → 403 loopback-only', async (t) => {
  const { routes } = await setup(t)
  const handler = routes.get(`${UI_API_PREFIX}/mint-enroll`)
  assert.equal(typeof handler, 'function')
  const out = { status: 0, body: '' }
  const res = { writeHead(c) { out.status = c }, end(p) { out.body = p ?? '' }, setHeader() {} }
  const req = {
    method: 'POST', url: `${UI_API_PREFIX}/mint-enroll`, headers: {},
    socket: { remoteAddress: '192.168.1.50' },
    *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
  }
  await handler(req, res)
  assert.equal(out.status, 403)
  assert.equal(JSON.parse(out.body).error, 'loopback-only')
})

test('relay-enroll 同样 + 非回环对端 → 403 loopback-only', async (t) => {
  const { routes } = await setup(t)
  const handler = routes.get(`${UI_API_PREFIX}/relay-enroll`)
  const out = { status: 0, body: '' }
  const res = { writeHead(c) { out.status = c }, end(p) { out.body = p ?? '' }, setHeader() {} }
  await handler({ method: 'POST', url: `${UI_API_PREFIX}/relay-enroll`, headers: {}, socket: { remoteAddress: '10.0.0.9' }, *[Symbol.asyncIterator]() { yield Buffer.from('{}') } }, res)
  assert.equal(out.status, 403)
  assert.equal(JSON.parse(out.body).error, 'loopback-only')
})

test('从未注册的路由 → 404（不是 403）', async (t) => {
  const { port } = await setup(t)
  const { status } = await request(port, `${UI_API_PREFIX}/nope`)
  assert.equal(status, 404)
  // 即使是跨站请求，不存在的路径也不被改写成 403
  const cross = await request(port, `${UI_API_PREFIX}/nope`, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(cross.status, 404)
})
