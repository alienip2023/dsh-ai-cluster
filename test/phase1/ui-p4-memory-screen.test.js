// p4：记忆屏直接读 ds-bot 的联邦记忆（POST /api/bot），不经本插件的 /memory 桩。
// 夹具的形状抄自 ds-bot 源码：memory-federation.js 的 scopes() / view()，以及 channel.js 的 ok()/fail() 信封。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const src = fs.readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')

function loadClient(fetchImpl) {
  let plugin = null
  const h = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(Infinity) })
  vm.runInNewContext(src, {
    console,
    fetch: fetchImpl,
    window: { __ModuleLoader__: { load(m) {
      plugin = m.factory(() => ({
        createElement: h,
        useState(v) { return [v, () => {}] }, useEffect() {}, useRef(v) { return { current: v } }, useMemo(fn) { return fn() },
      }))
    } } },
  }, { filename: 'lib/client.js' })
  return plugin
}
const texts = (el, out = []) => {
  if (typeof el === 'string') out.push(el)
  else if (el && typeof el === 'object') {
    for (const k of el.kids || []) texts(k, out)
  }
  return out
}

// memory-federation.js scopes() 的回包形状
const SCOPES = {
  team: { entries: 2 },
  nodes: [
    {
      nodeId: 'n1', hostname: 'studio', online: true, lastSeq: 3, sentSeq: 3, lastSeen: 1700000000000, entries: 1,
      bots: [{ remoteBotId: 'rb1', name: 'Scribe', entries: 4 }],
    },
    { nodeId: 'n2', hostname: 'laptop', online: false, lastSeq: 0, sentSeq: 0, lastSeen: null, entries: 0, bots: [] },
  ],
}
// view() 的回包形状
const VIEW = {
  scope: 'team', kind: 'team',
  entries: [
    { scope: 'team', topic: null, text: 'standing rule', id: 'e1', added: '2026-11-01', by: 'user', source: 'memory hub', until: null, pinned: true, expired: false },
    { scope: 'team', topic: 'work', text: 'old plan', id: 'e2', added: '2026-01-02', by: 'user', source: 'memory hub', until: '2026-02-01', pinned: false, expired: true },
  ],
  sizes: { team: 40 }, limits: {}, keys: { team: 'team' }, summary: null, fresh: false, summarizing: false, error: null,
}

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })

test('scope options: team, every node, and each node\'s Bots; values are the real scope objects', () => {
  const p = loadClient()
  const opts = p.memoryScopeOptions(SCOPES)
  assert.deepEqual(Array.from(opts, (o) => o.group), ['team', 'node', 'node', 'bot'])
  assert.deepEqual(JSON.parse(opts[0].value), { kind: 'team' })
  assert.deepEqual(JSON.parse(opts[1].value), { kind: 'node', nodeId: 'n1' })
  assert.deepEqual(JSON.parse(opts[3].value), { kind: 'bot', nodeId: 'n1', remoteBotId: 'rb1' })
  assert.match(opts[2].label, /离线/)
  assert.equal(opts[3].entries, 4)
  assert.equal(p.memoryScopeOptions(null).length, 0)
  assert.equal(p.memoryScopeOptions({}).length, 1, 'only the team when no node reported')
})

test('entry rows carry text/topic/flags; expired rows are muted, pinned rows marked', () => {
  const p = loadClient()
  const rows = p.memoryEntryRows(VIEW)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].text, 'standing rule')
  assert.equal(rows[0].pinned, true)
  assert.equal(rows[0].muted, false)
  assert.equal(rows[1].topic, 'work')
  assert.equal(rows[1].expired, true)
  assert.equal(rows[1].muted, true)
  assert.equal(rows[1].until, '2026-02-01')
  assert.deepEqual(Array.from(p.memoryEntryRows({})), [])
})

test('botApi: POSTs {endpoint,payload} to /api/bot and unwraps ok.value', async () => {
  const calls = []
  const p = loadClient(async (url, init) => { calls.push([url, init]); return reply(200, { ok: true, value: VIEW }) })
  const v = await p.memoryView({ kind: 'team' })
  assert.equal(v.entries.length, 2)
  assert.equal(calls[0][0], '/api/bot')
  assert.equal(calls[0][1].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0][1].body), { endpoint: 'memory-hub-view', payload: { scope: { kind: 'team' } } })
  await p.memoryScopes()
  await p.memoryAdd({ kind: 'bot', nodeId: 'n1', remoteBotId: 'rb1' }, 'x', 'work')
  await p.memoryForget({ kind: 'team' }, 'x')
  assert.deepEqual(calls.map((c) => JSON.parse(c[1].body).endpoint), ['memory-hub-view', 'memory-hub-scopes', 'memory-hub-add', 'memory-hub-forget'])
  assert.deepEqual(JSON.parse(calls[2][1].body).payload, { scope: { kind: 'bot', nodeId: 'n1', remoteBotId: 'rb1' }, text: 'x', topic: 'work' })
})

test('missing api: 404, HTML body, bare {error}, bot/not-found are memory-api-missing, never an empty list', async () => {
  const cases = [
    reply(404, 'not found'),
    reply(200, '<!doctype html><html></html>'),
    reply(200, { error: 'method' }),
    reply(200, { ok: false, error: { code: 'bot/not-found', message: 'Unknown endpoint memory-hub-view', details: {} } }),
  ]
  for (const r of cases) {
    const p = loadClient(async () => r)
    await assert.rejects(p.memoryView({ kind: 'team' }), (e) => e.missing === true && e.reason === 'memory-api-missing')
  }
})

test('a real ds-bot failure is an error with its message, not "missing"', async () => {
  const p = loadClient(async () => reply(200, { ok: false, error: { code: 'bot/error', message: 'Unknown memory scope', details: {} } }))
  await assert.rejects(p.memoryView({ kind: 'nope' }), (e) => e.missing === false && e.reason === 'Unknown memory scope')
  const q = loadClient(async () => { throw new Error('offline') })
  await assert.rejects(q.memoryScopes(), (e) => e.missing === false && e.reason === 'offline')
})

test('screen states are four different sentences', () => {
  const p = loadClient()
  const base = { scopes: { state: 'ok', data: SCOPES, reason: '' }, view: { state: 'ok', data: VIEW, reason: '' }, options: p.memoryScopeOptions(SCOPES), scope: '{"kind":"team"}', draft: '', topic: '', busy: false, note: '', onScope() {}, onDraft() {}, onTopic() {}, onAdd() {}, onForget() {} }
  const t = (patch) => texts(p.memoryScreenView({ ...base, ...patch })).join('|')
  assert.match(t({ view: { state: 'loading', data: null, reason: '' } }), /读取中…/)
  assert.match(t({ view: { state: 'ok', data: { entries: [] }, reason: '' } }), /还没有记忆/)
  assert.match(t({ view: { state: 'error', data: null, reason: 'boom' } }), /读记忆失败：boom/)
  assert.match(t({ view: { state: 'missing', data: null, reason: 'memory-api-missing' } }), /记忆接口不可用/)
  const data = t({})
  assert.match(data, /standing rule/)
  assert.match(data, /已过期/)
  assert.match(data, /已置顶/)
  assert.match(data, /遗忘/)
  assert.match(data, /记住/)
  assert.doesNotMatch(data, /记忆存储未建/)
})

test('source: client posts the four memory endpoints to /api/bot; the old stub is gone from the screen', () => {
  assert.match(src, /const BOT_API = '\/api\/bot'/)
  for (const e of ['memory-hub-scopes', 'memory-hub-view', 'memory-hub-add', 'memory-hub-forget']) {
    assert.match(src, new RegExp(`botApi\\('${e}'`))
  }
  assert.doesNotMatch(src, /记忆存储未建/)
  assert.doesNotMatch(src, /范围视图本阶段未接入/)
  assert.doesNotMatch(src, /\['own', 'group', 'team', 'bot'\]/)
  assert.doesNotMatch(src, /apiGet\('\/memory'\)/)
})

test('source: the memory effect depends on the poll tick and is in-flight guarded', () => {
  const start = src.indexOf("if (activeScreen !== 'memory') return")
  assert.ok(start >= 0, 'memory effect must exist')
  const end = src.indexOf('\n      }, [', start)
  const deps = src.slice(end, src.indexOf(')', end + 8) + 1)
  assert.match(deps, /\bpollTick\b/)
  assert.match(deps, /\bmemScope\b/)
  const body = src.slice(start, end)
  assert.match(body, /memViewInflight\.current/)
  assert.match(body, /memScopesInflight\.current/)
  assert.doesNotMatch(body, /\b(setMemScope|setMemDraft|setMemTopic)\(/, 'a poll never resets scope or typed input')
})
