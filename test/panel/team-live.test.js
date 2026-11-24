// 团队屏的「活」测试：一个带真实 state / effect / 卸载清理的迷你 React，加上假 fetch 和假时钟，
// 驱动 Screen 走完整流程（轮询、对话回合、记忆读写、停止、定位、表单）。
// 这些是旧 ui-p3-s2 / s4 / p4 的「面板行为」测试迁过来的：断言的是可观察的行为（请求体、屏幕文字、取消），不是源码。
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCore } from '../../src/panel/core.js'
import { createTeam } from '../../src/panel/team.js'
import { dataEmptyHub } from '../../src/panel/data.js'
import { findAll, findButtons, texts } from './_fake.js'

/* ── 迷你 React：按组件实例（路径 + 类型名）保存 hook；卸载时跑 effect 清理 ── */
function makeLive() {
  const instances = new Map()
  let cur = null
  let dirty = false
  let effects = []
  const slot = (init) => {
    const i = cur.i++
    if (!(i in cur.hooks)) cur.hooks[i] = init()
    return cur.hooks[i]
  }
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...kids) {
      return { type, props: props || {}, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false) }
    },
    useState(init) {
      const s = slot(() => {
        const st = { v: typeof init === 'function' ? init() : init }
        st.set = (nv) => {
          const next = typeof nv === 'function' ? nv(st.v) : nv
          if (!Object.is(next, st.v)) { st.v = next; dirty = true }
        }
        return st
      })
      return [s.v, s.set]
    },
    useRef(v) { return slot(() => ({ current: v })) },
    useEffect(fn, deps) {
      const s = slot(() => ({ deps: null, cleanup: null }))
      const changed = !deps || !s.deps || deps.some((d, k) => !Object.is(d, s.deps[k]))
      if (!changed) return
      s.deps = deps || null
      effects.push(() => {
        if (typeof s.cleanup === 'function') s.cleanup()
        const c = fn()
        s.cleanup = typeof c === 'function' ? c : null
      })
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
  React.useLayoutEffect = React.useEffect

  function renderNode(el, path, seen) {
    if (el === null || el === undefined || el === false) return null
    if (typeof el === 'string' || typeof el === 'number') return String(el)
    if (Array.isArray(el)) return { type: 'fragment', props: {}, kids: el.map((k, i) => renderNode(k, path + '/' + i, seen)).filter((x) => x !== null) }
    if (typeof el.type === 'function') {
      const id = path + '#' + el.type.name
      let inst = instances.get(id)
      if (!inst) { inst = { hooks: [], i: 0 }; instances.set(id, inst) }
      seen.add(id)
      inst.i = 0
      cur = inst
      const out = el.type({ ...el.props, children: el.kids.length <= 1 ? el.kids[0] : el.kids })
      cur = null
      return renderNode(out, id, seen)
    }
    if (el.props && el.props.ref && typeof el.props.ref === 'object' && !el.props.ref.current) el.props.ref.current = { scrollTop: 0, scrollHeight: 0 }
    return {
      type: el.type, props: el.props,
      kids: el.kids.map((k, i) => renderNode(k, path + '/' + (k && k.props && k.props.key != null ? k.props.key : i), seen)).filter((x) => x !== null),
    }
  }

  function mount(makeEl) {
    const root = { tree: null }
    root.render = () => {
      let n = 0
      do {
        dirty = false
        effects = []
        const seen = new Set()
        root.tree = renderNode(makeEl(), 'r', seen)
        for (const [id, inst] of [...instances]) {
          if (seen.has(id)) continue
          for (const hk of inst.hooks) if (hk && typeof hk.cleanup === 'function') hk.cleanup()
          instances.delete(id)
        }
        const run = effects
        for (const f of run) f()
      } while (dirty && ++n < 40)
    }
    root.update = () => { if (dirty) root.render() }
    root.settle = async () => {
      for (let i = 0; i < 8; i += 1) {
        await new Promise((r) => setImmediate(r))
        if (dirty) root.render()
      }
    }
    root.dispose = () => {
      for (const inst of instances.values()) for (const hk of inst.hooks) if (hk && typeof hk.cleanup === 'function') hk.cleanup()
      instances.clear()
    }
    root.render()
    return root
  }
  return { React, mount }
}

/* ── 假时钟（setTimeout / clearTimeout / Date.now）与假 fetch ── */
function installClock() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now }
  let now = 1_700_000_000_000
  let seq = 0
  let timers = []
  globalThis.setTimeout = (f, ms) => { const t = { id: ++seq, at: now + (ms || 0), f }; timers.push(t); return t.id }
  globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id) }
  Date.now = () => now
  return {
    advance(ms) {
      const end = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((t) => t !== due)
        now = Math.max(now, due.at)
        due.f()
      }
      now = end
    },
    pending: () => timers.length,
    restore() { globalThis.setTimeout = real.setTimeout; globalThis.clearTimeout = real.clearTimeout; Date.now = real.now },
  }
}

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
const deferred = () => { const d = {}; d.promise = new Promise((res) => { d.resolve = res }); return d }

const BOTS = {
  ok: true, at: 1, total: 2, nodes: [
    { nodeId: 'n1', hostname: 'mac-a', online: true, acVersion: '0.4.36', bots: [
      { id: 'b1', name: '小研', role: '研究', model: 'p/m', identityId: '0123456789abcdef' },
      { id: 'b2', name: '二号', role: '', model: '' },
    ] },
    { nodeId: 'n2', hostname: 'win-b', online: false, bots: [] },
  ],
}
const MODELS = { ok: true, at: 1, total: 1, nodes: [{ nodeId: 'n1', hostname: 'mac-a', online: true, defaultModel: 'p/m', models: [{ id: 'p/m', name: 'M', efforts: [] }] }] }
const SCOPES = { team: { entries: 0 }, nodes: [{ nodeId: 'n1', hostname: 'mac-a', online: true, entries: 0, bots: [{ remoteBotId: 'b1', name: '小研', entries: 0 }] }] }
const entry = (id, text, topic) => ({ id, text, topic: topic || null, added: '2026-11-01', by: 'user', until: null, pinned: false, expired: false })
const view = (entries) => ({ scope: 'team', kind: 'team', entries })

/** 路由表：key 是 `GET /bots`、`POST /bots/turn`、`BOT memory-hub-view`（ds-bot 端点，返回 value）。覆盖项见各测试。 */
function defaults() {
  return {
    'GET /bots': () => BOTS,
    'GET /models': () => MODELS,
    'GET /bots/history': () => ({ ok: true, items: [] }),
    'BOT list-talents': () => ({ talents: [{ name: '分析师', role: '分析', duty: '做分析', category: '通用' }] }),
    'BOT list-templates': () => ({ templates: [{ id: 't1', name: '审稿人', role: '编辑', category: '写作', description: '审稿说明', model: 'p/m' }] }),
    'BOT memory-hub-scopes': () => SCOPES,
    'BOT memory-hub-view': () => view([]),
  }
}

function makeNet(overrides) {
  const calls = []
  const table = { ...defaults(), ...overrides }
  const fetch = (url, init = {}) => {
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    const isBot = url === '/api/bot'
    const path = isBot ? url : url.replace(/^\/api\/(ai-cluster|remote-agent)\/ui/, '')
    const key = isBot ? 'BOT ' + body.endpoint : method + ' ' + path.split('?')[0]
    const call = { key, path, method, body, query: new URLSearchParams(path.split('?')[1] || '') }
    calls.push(call)
    const h = table[key]
    if (!h) return Promise.resolve(reply(404, {}))
    return Promise.resolve().then(() => h(call)).then((r) => {
      if (r && r.__status) return reply(r.__status, r.body)
      if (isBot) return reply(200, r && r.__error ? { ok: false, error: { code: 'bot/error', message: r.__error } } : { ok: true, value: r })
      return reply(200, r)
    })
  }
  return { fetch, calls, table, of: (key) => calls.filter((c) => c.key === key) }
}

const HUB_NODES = [{ nodeId: 'n1', hostname: 'mac-a', online: true }, { nodeId: 'n2', hostname: 'win-b', online: false }]

/** 跑一个场景：装假时钟 / 假 fetch，挂上 Screen，把一组辅助方法交给 body。 */
async function run(overrides, body) {
  const clock = installClock()
  const realFetch = globalThis.fetch
  const net = makeNet(overrides)
  globalThis.fetch = net.fetch
  const confirms = []
  const answers = []
  const notes = []
  const ui = {
    confirm: (msg) => { confirms.push(msg); return Promise.resolve(answers.length ? answers.shift() : true) },
    alert() {}, prompt: () => Promise.resolve(null), notify: (text, tone) => notes.push([text, tone]),
  }
  const live = makeLive()
  const core = createCore(live.React)
  const { Screen } = createTeam(core)
  const props = { hub: { ...dataEmptyHub, loading: false, tick: 1, nodes: HUB_NODES, goals: [], botAudit: [] }, ui, role: 'hub', go() {}, refresh() {} }
  const root = live.mount(() => core.h(Screen, props))
  const t = {
    root, net, clock, ui, confirms, answers, notes,
    text: () => texts(root.tree).join(''),
    buttons: (label) => findButtons(root.tree, label),
    async act(fn) { const r = fn(); root.update(); await root.settle(); return r },
    async click(label, nth = 0) {
      const b = findButtons(root.tree, label)[nth]
      assert.ok(b, 'no button ' + label)
      assert.equal(b.props.disabled === true, false, label + ' is disabled')
      if (typeof b.props.onClick === 'function') { await t.act(() => b.props.onClick({ preventDefault() {}, stopPropagation() {} })); return }
      // 提交按钮没有 onClick：点它等于提交它所在的表单
      assert.equal(b.props.type, 'submit', label + ' has no click handler')
      const f = findAll(root.tree, (n) => n.type === 'form' && findAll(n, (m) => m.props === b.props).length > 0)[0]
      assert.ok(f, 'submit button outside a form')
      await t.act(() => f.props.onSubmit({ preventDefault() {} }))
    },
    field(labelText) {
      const lab = findAll(root.tree, (n) => n.type === 'label' && texts(n).join('').includes(labelText))[0]
      assert.ok(lab, 'no field ' + labelText)
      const ctl = findAll(lab, (n) => n.type === 'input' || n.type === 'textarea' || n.type === 'select')[0]
      assert.ok(ctl, 'no control in ' + labelText)
      return ctl
    },
    async type(labelText, value) { const f = t.field(labelText); await t.act(() => f.props.onChange({ target: { value } })) },
    async submit(labelText) {
      const f = findAll(root.tree, (n) => n.type === 'form' && findAll(n, (m) => m.type === 'label' && texts(m).join('').includes(labelText)).length > 0)[0]
      assert.ok(f, 'no form with ' + labelText)
      await t.act(() => f.props.onSubmit({ preventDefault() {} }))
    },
    async bump() { props.hub = { ...props.hub, tick: props.hub.tick + 1 }; root.render(); await root.settle() },
  }
  try {
    await root.settle()
    await body(t)
  } finally {
    root.dispose()
    globalThis.fetch = realFetch
    clock.restore()
  }
}

const POLL_RUNNING = { ok: true, state: 'running' }

/* ── 对话 ── */

test('chat: history loads, Shift+Enter does not send, Enter sends; polling every 2s to done, then history reloads', async () => {
  const script = [POLL_RUNNING, { ok: true, state: 'running', linkLost: true }, { ok: true, state: 'done', text: '答案' }]
  await run({
    'GET /bots/history': () => ({ ok: true, items: [{ kind: 'user', text: '旧问' }, { kind: 'bot', text: '旧答' }] }),
    'POST /bots/turn': () => ({ ok: true, exchangeId: 'x1' }),
    'GET /bots/turn': () => script.shift(),
  }, async (t) => {
    await t.click('对话')
    assert.match(t.text(), /对话：小研/)
    assert.ok(t.text().includes('旧问') && t.text().includes('旧答'))
    assert.deepEqual([t.net.of('GET /bots/history')[0].query.get('nodeId'), t.net.of('GET /bots/history')[0].query.get('botId')], ['n1', 'b1'])
    await t.type('发给 小研', '你好')
    let prevented = 0
    const key = (e) => t.act(() => t.field('发给 小研').props.onKeyDown({ preventDefault() { prevented += 1 }, ...e }))
    await key({ key: 'Enter', shiftKey: true })
    assert.equal(t.net.of('POST /bots/turn').length, 0, 'Shift+Enter is a newline, not a send')
    assert.equal(prevented, 0)
    await key({ key: 'Enter' })
    assert.equal(prevented, 1)
    assert.deepEqual(t.net.of('POST /bots/turn')[0].body, { nodeId: 'n1', botId: 'b1', text: '你好' })
    assert.match(t.text(), /运行中…你刚发的是：你好/)
    assert.equal(t.field('发给 小研').props.value, '', 'the draft is cleared once the turn is accepted')
    assert.equal(t.buttons('运行中…')[0].props.disabled, true, 'send is disabled while running')
    assert.equal(t.net.of('GET /bots/turn').length, 0, 'the first poll comes after 2s, not at once')
    t.clock.advance(2000); await t.root.settle()
    assert.equal(t.net.of('GET /bots/turn')[0].query.get('exchangeId'), 'x1')
    assert.doesNotMatch(t.text(), /连接断了/)
    t.clock.advance(2000); await t.root.settle()
    assert.match(t.text(), /连接断了/, 'linkLost is said in plain words and the wait continues')
    t.clock.advance(2000); await t.root.settle()
    assert.equal(t.net.of('GET /bots/history').length, 2, 'history is reloaded after the turn')
    assert.match(t.text(), /已完成，回答在上方对话里/)
    t.clock.advance(20000); await t.root.settle()
    assert.equal(t.net.of('GET /bots/turn').length, 3, 'no more polling once done')
    assert.equal(t.clock.pending(), 0)
  })
})

test('chat: when history cannot be reloaded the answer text itself is shown', async () => {
  let hist = 0
  await run({
    'GET /bots/history': () => { hist += 1; return hist === 1 ? { ok: true, items: [] } : { ok: false, error: 'bot-history-timeout' } },
    'POST /bots/turn': () => ({ ok: true, exchangeId: 'x1' }),
    'GET /bots/turn': () => ({ ok: true, state: 'done', text: '这是答案' }),
  }, async (t) => {
    await t.click('对话')
    await t.type('发给 小研', 'q')
    await t.click('发送')
    t.clock.advance(2000); await t.root.settle()
    assert.match(t.text(), /Bot 回答：这是答案/)
    assert.match(t.text(), /读取对话失败/)
    assert.match(t.text(), /机器没有在时限内回应（bot-history-timeout）/)
  })
})

test('chat: a refused start keeps the draft and shows the server code; HTTP 400 bodies are read too', async () => {
  let n = 0
  await run({
    'POST /bots/turn': () => { n += 1; return n === 1 ? { ok: false, error: 'bot-turn-busy' } : { __status: 400, body: { ok: false, error: 'bot-turn-text-too-long' } } },
  }, async (t) => {
    await t.click('对话')
    await t.type('发给 小研', '你好')
    await t.click('发送')
    assert.match(t.text(), /失败：正在跑的对话太多，稍后再试（bot-turn-busy）/)
    assert.equal(t.field('发给 小研').props.value, '你好')
    assert.equal(t.clock.pending(), 0, 'a refused turn starts no polling')
    await t.click('发送')
    assert.match(t.text(), /失败：消息超过 8000 个字符（bot-turn-text-too-long）/)
    assert.equal(t.field('发给 小研').props.value, '你好')
  })
})

test('chat: a failed poll is retried and its error text shown; a failed turn shows its code', async () => {
  const script = [() => { throw new Error('Failed to fetch') }, () => ({ ok: true, state: 'failed', error: 'bot-turn-failed', text: '' })]
  await run({
    'POST /bots/turn': () => ({ ok: true, exchangeId: 'x1' }),
    'GET /bots/turn': () => script.shift()(),
  }, async (t) => {
    await t.click('对话')
    await t.type('发给 小研', 'q')
    await t.click('发送')
    t.clock.advance(2000); await t.root.settle()
    assert.match(t.text(), /读取进度失败（会重试）：Failed to fetch/)
    assert.equal(t.clock.pending(), 1, 'the poll is rescheduled')
    t.clock.advance(2000); await t.root.settle()
    assert.match(t.text(), /失败：这一轮对话失败了（bot-turn-failed）/)
    assert.doesNotMatch(t.text(), /读取进度失败/)
    assert.equal(t.buttons('发送')[0].props.disabled, true, 'empty draft')
  })
})

test('chat: an unknown exchange is a failure, not an endless wait', async () => {
  await run({
    'POST /bots/turn': () => ({ ok: true, exchangeId: 'x1' }),
    'GET /bots/turn': () => ({ ok: true, state: 'unknown' }),
  }, async (t) => {
    await t.click('对话')
    await t.type('发给 小研', 'q')
    await t.click('发送')
    t.clock.advance(2000); await t.root.settle()
    assert.match(t.text(), /主控已经不认识这一轮（可能已过期）（turn-unknown）/)
    assert.equal(t.clock.pending(), 0)
  })
})

test('chat: gives up after 5 minutes with its own sentence and can send again', async () => {
  await run({
    'POST /bots/turn': () => ({ ok: true, exchangeId: 'x1' }),
    'GET /bots/turn': () => POLL_RUNNING,
  }, async (t) => {
    await t.click('对话')
    await t.type('发给 小研', 'q')
    await t.click('发送')
    for (let i = 0; i < 12 && !/等了 5 分钟/.test(t.text()); i += 1) { t.clock.advance(60_000); await t.root.settle() }
    assert.match(t.text(), /等了 5 分钟/)
    assert.equal(t.clock.pending(), 0)
    await t.type('发给 小研', 'again')
    assert.equal(t.buttons('发送')[0].props.disabled, false)
  })
})

test('chat: closing the chat or switching Bot cancels the pending poll (no request after that)', async () => {
  await run({
    'POST /bots/turn': () => ({ ok: true, exchangeId: 'x1' }),
    'GET /bots/turn': () => POLL_RUNNING,
  }, async (t) => {
    await t.click('对话')
    await t.type('发给 小研', 'q')
    await t.click('发送')
    await t.click('关闭')
    assert.equal(t.clock.pending(), 0, 'the poll timer is cleared on close')
    t.clock.advance(30_000); await t.root.settle()
    assert.equal(t.net.of('GET /bots/turn').length, 0)

    await t.click('对话')
    await t.type('发给 小研', 'q')
    await t.click('发送')
    t.clock.advance(2000); await t.root.settle()
    assert.equal(t.net.of('GET /bots/turn').length, 1)
    await t.click('对话', 1)
    assert.match(t.text(), /对话：二号/)
    assert.doesNotMatch(t.text(), /运行中/, 'the other Bot starts idle')
    t.clock.advance(30_000); await t.root.settle()
    assert.equal(t.net.of('GET /bots/turn').length, 1, 'the old Bot is no longer polled')
  })
})

test('polling ticks refresh the roster but never reset a typed chat draft, an open form or a memory draft', async () => {
  await run({}, async (t) => {
    await t.click('对话')
    await t.type('发给 小研', '没发完的话')
    await t.type('记住一件事', '半条记忆')
    await t.type('主题（可选）', '偏好')
    const scopeSelect = findAll(t.root.tree, (n) => n.type === 'select' && n.props['aria-label'] === undefined && findAll(n, (o) => o.type === 'option' && o.props.value === JSON.stringify({ kind: 'node', nodeId: 'n1' })).length > 0)[0]
    await t.act(() => scopeSelect.props.onChange({ target: { value: JSON.stringify({ kind: 'node', nodeId: 'n1' }) } }))
    const rosterBefore = t.net.of('GET /bots').length
    const histBefore = t.net.of('GET /bots/history').length
    await t.bump(); await t.bump()
    assert.ok(t.net.of('GET /bots').length > rosterBefore, 'the roster is polled on every tick')
    assert.equal(t.net.of('GET /bots/history').length, histBefore, 'the open chat is not reloaded by a tick')
    assert.equal(t.field('发给 小研').props.value, '没发完的话')
    assert.equal(t.field('记住一件事').props.value, '半条记忆')
    assert.equal(t.field('主题（可选）').props.value, '偏好')
    const views = t.net.of('BOT memory-hub-view')
    assert.deepEqual(views[views.length - 1].body.payload.scope, { kind: 'node', nodeId: 'n1' }, 'the selected scope survives ticks and is what gets refreshed')
    const sel = findAll(t.root.tree, (n) => n.type === 'select' && n.props.value === JSON.stringify({ kind: 'node', nodeId: 'n1' }))
    assert.equal(sel.length, 1)

    await t.click('新建 Bot')
    await t.type('名称', '草稿 Bot')
    await t.bump()
    assert.equal(t.field('名称').props.value, '草稿 Bot')
  })
})

/* ── 名册轮询 ── */

test('roster: one request in flight at a time; a failed refresh keeps the old data and can be retried', async () => {
  const first = deferred()
  let n = 0
  await run({
    'GET /bots': () => { n += 1; if (n === 1) return first.promise; if (n === 2) throw new Error('network down'); return BOTS },
  }, async (t) => {
    assert.match(t.text(), /读取名册中/)
    await t.bump(); await t.bump()
    assert.equal(t.net.of('GET /bots').length, 1, 'ticks while a request is pending are skipped')
    first.resolve(BOTS); await t.root.settle()
    assert.match(t.text(), /小研/)
    await t.bump()
    assert.match(t.text(), /名册刷新失败/)
    assert.match(t.text(), /network down/)
    assert.match(t.text(), /小研/, 'the old roster stays on screen')
    await t.click('重试')
    assert.doesNotMatch(t.text(), /名册刷新失败/)
  })
})

/* ── 记忆 ── */

test('memory: scopes are requested as {endpoint,payload} on /api/bot; adding sends scope+text+topic and clears the draft on success', async () => {
  const list = []
  await run({
    'BOT memory-hub-view': () => view(list.slice()),
    'BOT memory-hub-add': (c) => { list.push(entry('e' + list.length, c.body.payload.text, c.body.payload.topic)); return view(list.slice()) },
  }, async (t) => {
    assert.deepEqual(t.net.of('BOT memory-hub-scopes')[0].body, { endpoint: 'memory-hub-scopes', payload: {} })
    assert.deepEqual(t.net.of('BOT memory-hub-view')[0].body, { endpoint: 'memory-hub-view', payload: { scope: { kind: 'team' } } })
    assert.match(t.text(), /这个范围还没有记忆/)
    assert.equal(findButtons(t.root.tree, '记住').find((b) => b.props.type === 'submit').props.disabled, true)
    await t.type('记住一件事', '  要简洁  ')
    await t.type('主题（可选）', '偏好')
    await t.submit('记住一件事')
    assert.deepEqual(t.net.of('BOT memory-hub-add')[0].body, { endpoint: 'memory-hub-add', payload: { scope: { kind: 'team' }, text: '要简洁', topic: '偏好' } })
    assert.match(t.text(), /要简洁/)
    assert.match(t.text(), /主题 偏好/)
    assert.equal(t.field('记住一件事').props.value, '')
    await t.type('记住一件事', '无主题')
    await t.type('主题（可选）', '')
    await t.submit('记住一件事')
    assert.equal('topic' in t.net.of('BOT memory-hub-add')[1].body.payload, false, 'a blank topic is not sent')
  })
})

test('memory: a failed write keeps the draft and shows the ds-bot message', async () => {
  await run({ 'BOT memory-hub-add': () => ({ __error: 'Unknown memory scope' }) }, async (t) => {
    await t.type('记住一件事', '别丢')
    await t.submit('记住一件事')
    assert.match(t.text(), /写记忆失败：Unknown memory scope/)
    assert.equal(t.field('记住一件事').props.value, '别丢')
  })
})

test('memory: forgetting asks first, then sends scope+text+topic and shows the returned view', async () => {
  let list = [entry('e1', '旧规则', '工作'), entry('e2', '别的', null)]
  await run({
    'BOT memory-hub-view': () => view(list),
    'BOT memory-hub-forget': (c) => { list = list.filter((e) => e.text !== c.body.payload.text); return view(list) },
  }, async (t) => {
    t.answers.push(false)
    await t.click('遗忘')
    assert.equal(t.net.of('BOT memory-hub-forget').length, 0, 'declined: nothing is sent')
    assert.match(t.confirms[0], /旧规则/)
    await t.click('遗忘')
    assert.deepEqual(t.net.of('BOT memory-hub-forget')[0].body.payload, { scope: { kind: 'team' }, text: '旧规则', topic: '工作' })
    assert.doesNotMatch(t.text(), /旧规则/)
    assert.match(t.text(), /别的/)
  })
})

test('memory: a slow answer for the old scope is dropped after the scope changed', async () => {
  const slowTeam = deferred()
  await run({
    'BOT memory-hub-view': (c) => (c.body.payload.scope.kind === 'team' ? slowTeam.promise : view([entry('n', '节点上的记忆')])),
  }, async (t) => {
    const nodeScope = JSON.stringify({ kind: 'node', nodeId: 'n1' })
    const sel = findAll(t.root.tree, (n) => n.type === 'select' && findAll(n, (o) => o.type === 'option' && o.props.value === nodeScope).length > 0)[0]
    await t.act(() => sel.props.onChange({ target: { value: nodeScope } }))
    assert.match(t.text(), /节点上的记忆/)
    slowTeam.resolve(view([entry('t', '团队的旧回包')])); await t.root.settle()
    assert.doesNotMatch(t.text(), /团队的旧回包/)
    assert.match(t.text(), /节点上的记忆/)
  })
})

test('memory: a missing endpoint is its own state, never an empty list', async () => {
  await run({
    'BOT memory-hub-scopes': () => ({ __status: 404, body: '' }),
    'BOT memory-hub-view': () => ({ __status: 200, body: '<!doctype html>' }),
  }, async (t) => {
    assert.match(t.text(), /记忆接口不可用（memory-api-missing）/)
    assert.doesNotMatch(t.text(), /这个范围还没有记忆/)
  })
})

/* ── 停止 / 定位 ── */

test('stop: confirms first; says whether something was stopped; shows the server error text; blocks double clicks', async () => {
  const slow = deferred()
  let n = 0
  await run({
    'POST /bots/stop': () => { n += 1; if (n === 1) return { ok: true, stopped: true }; if (n === 2) return { ok: true, stopped: false }; if (n === 3) return { ok: false, error: 'node-offline' }; return slow.promise },
  }, async (t) => {
    t.answers.push(false)
    await t.click('停止')
    assert.equal(t.net.of('POST /bots/stop').length, 0)
    assert.match(t.confirms[0], /小研/)
    await t.click('停止')
    assert.deepEqual(t.net.of('POST /bots/stop')[0].body, { nodeId: 'n1', botId: 'b1' })
    assert.deepEqual(t.notes[0], ['已停止「小研」当前的回合', 'ok'])
    await t.click('停止')
    assert.match(t.notes[1][0], /没有在跑的回合/)
    await t.click('停止')
    assert.equal(t.notes[2][1], 'err')
    assert.match(t.notes[2][0], /这台机器当前不在线（node-offline）/)
    await t.click('停止')
    assert.equal(t.buttons('停止中…')[0].props.disabled, true)
    slow.resolve({ ok: true, stopped: true }); await t.root.settle()
    assert.equal(t.buttons('停止中…').length, 0)
  })
})

test('stop: a transport error is shown verbatim', async () => {
  await run({ 'POST /bots/stop': () => { throw new Error('socket hang up') } }, async (t) => {
    await t.click('停止')
    assert.match(t.notes[0][0], /socket hang up/)
    assert.equal(t.notes[0][1], 'err')
  })
})

test('locate: asks by identity id, reports machines in plain words, can be repeated, shows the server error', async () => {
  let n = 0
  await run({
    'GET /bots/locate': () => {
      n += 1
      if (n === 1) return { ok: true, identityId: '0123456789abcdef', locations: [{ nodeId: 'n1', machineId: 'm-1' }], notHere: ['n2'], silent: [], unsupported: [], unsent: [], rejected: [] }
      return { ok: false, error: 'bot-locate-unavailable' }
    },
  }, async (t) => {
    await t.click('定位')
    assert.equal(t.net.of('GET /bots/locate')[0].query.get('identityId'), '0123456789abcdef')
    assert.match(t.text(), /定位：小研/)
    assert.match(t.text(), /mac-a（n1）/)
    assert.match(t.text(), /win-b（n2）/)
    await t.click('重新定位')
    assert.equal(t.net.of('GET /bots/locate').length, 2)
    assert.match(t.text(), /这台主控不支持按身份定位（bot-locate-unavailable）/)
  })
})

/* ── 表单 ── */

test('create: validates locally, sends the trimmed body, resets keeping the machine, refreshes the roster now and 2.5s later', async () => {
  await run({ 'POST /bots/create': () => ({ ok: true, nodeId: 'n1', remoteBotId: 'rb9' }) }, async (t) => {
    await t.click('新建 Bot')
    await t.act(() => t.field('机器').props.onChange({ target: { value: 'n1' } }))
    await t.type('名称', 'a'.repeat(41))
    await t.click('创建')
    assert.equal(t.net.of('POST /bots/create').length, 0, 'over the limit: nothing is sent')
    assert.match(t.text(), /名称超过 40 个字符/)
    await t.type('名称', '  新 Bot ')
    await t.type('角色', '审稿')
    await t.type('指令', ' 认真 ')
    const rosterBefore = t.net.of('GET /bots').length
    await t.click('创建')
    assert.deepEqual(t.net.of('POST /bots/create')[0].body, { nodeId: 'n1', name: '新 Bot', role: '审稿', modelRef: '', workDir: '', instructions: '认真' })
    assert.match(t.text(), /已创建：rb9/)
    assert.equal(t.field('名称').props.value, '')
    assert.equal(t.field('机器').props.value, 'n1', 'the machine stays selected for the next Bot')
    assert.equal(t.net.of('GET /bots').length, rosterBefore + 1)
    t.clock.advance(2500); await t.root.settle()
    assert.equal(t.net.of('GET /bots').length, rosterBefore + 2)
  })
})

test('create: nothing chosen is reported with its code; a server refusal keeps every value and shows the code text', async () => {
  await run({ 'POST /bots/create': () => ({ ok: false, error: 'node-offline' }) }, async (t) => {
    await t.click('新建 Bot')
    await t.click('创建')
    assert.equal(t.net.of('POST /bots/create').length, 0)
    assert.match(t.text(), /还没有选机器（bot-nodeId-missing）/)
    assert.match(t.text(), /名称不能为空（bot-create-name-missing）/)
    await t.act(() => t.field('机器').props.onChange({ target: { value: 'n1' } }))
    await t.type('名称', 'keep-me')
    await t.type('工作目录', '/w')
    await t.click('创建')
    assert.equal(t.net.of('POST /bots/create').length, 1)
    assert.match(t.text(), /这台机器当前不在线（node-offline）/)
    assert.equal(t.field('名称').props.value, 'keep-me')
    assert.equal(t.field('工作目录').props.value, '/w')
    assert.equal(t.field('机器').props.value, 'n1')
  })
})

test('edit: opens prefilled with the machine locked, sends only what changed, and knows when nothing changed', async () => {
  await run({ 'POST /bots/update': () => ({ ok: true, nodeId: 'n1' }) }, async (t) => {
    await t.click('编辑')
    assert.match(t.text(), /编辑 Bot：小研/)
    assert.equal(t.field('名称').props.value, '小研')
    assert.equal(t.field('角色').props.value, '研究')
    assert.equal(t.field('模型（provider/model）').props.value, 'p/m')
    assert.equal(t.field('机器').props.disabled, true)
    await t.click('保存')
    assert.equal(t.net.of('POST /bots/update').length, 0)
    assert.match(t.text(), /没有任何改动（留空的字段表示「不修改」）（bot-update-all-null）/)
    await t.type('角色', '审稿')
    await t.click('保存')
    assert.deepEqual(t.net.of('POST /bots/update')[0].body, { nodeId: 'n1', botId: 'b1', role: '审稿' })
    assert.match(t.text(), /已保存/)
    await t.click('保存')
    assert.equal(t.net.of('POST /bots/update').length, 1, 'after saving, the same values are no longer a change')
  })
})

test('edit: a server refusal keeps the typed values', async () => {
  await run({ 'POST /bots/update': () => ({ ok: false, error: 'bot-update-timeout' }) }, async (t) => {
    await t.click('编辑')
    await t.type('指令', '新的指令')
    await t.click('保存')
    assert.match(t.text(), /机器没有在时限内回应（bot-update-timeout）/)
    assert.equal(t.field('指令').props.value, '新的指令')
  })
})

test('edit: the chat pane has an edit button that opens the same form', async () => {
  await run({}, async (t) => {
    await t.click('对话')
    await t.click('编辑', 2)
    assert.match(t.text(), /编辑 Bot：小研/)
  })
})

test('create: template and talent pickers fill the form; the model picker sets the model', async () => {
  await run({}, async (t) => {
    await t.click('新建 Bot')
    await t.act(() => t.field('机器').props.onChange({ target: { value: 'n1' } }))
    await t.act(() => t.field('从模板库套用').props.onChange({ target: { value: 't1' } }))
    assert.equal(t.field('名称').props.value, '审稿人')
    assert.equal(t.field('角色').props.value, '编辑')
    assert.equal(t.field('指令').props.value, '审稿说明')
    assert.equal(t.field('模型（provider/model）').props.value, 'p/m')
    assert.match(t.text(), /已套用模板「审稿人」/)
    await t.act(() => t.field('从人才库套用').props.onChange({ target: { value: '分析师' } }))
    assert.equal(t.field('名称').props.value, '分析师')
    assert.equal(t.field('角色').props.value, '分析')
    assert.equal(t.field('指令').props.value, '做分析')
    await t.act(() => t.field('从这台机器的模型里选').props.onChange({ target: { value: 'p/m' } }))
    assert.equal(t.field('模型（provider/model）').props.value, 'p/m')
  })
})

test('template and talent catalogs: a missing ds-bot endpoint hides the pickers quietly, a real failure says why', async () => {
  await run({ 'BOT list-templates': () => ({ __status: 404, body: '' }), 'BOT list-talents': () => ({ __error: '人才库坏了' }) }, async (t) => {
    await t.click('新建 Bot')
    assert.equal(findAll(t.root.tree, (n) => n.type === 'label' && texts(n).join('').includes('从模板库套用')).length, 0)
    assert.match(t.text(), /模板库 \/ 人才库读取失败：人才库坏了/)
    assert.doesNotMatch(t.text(), /memory-api-missing/)
  })
})

test('switching away from a dirty form asks first; declining keeps the form', async () => {
  await run({}, async (t) => {
    await t.click('新建 Bot')
    await t.type('名称', '写到一半')
    t.answers.push(false)
    await t.click('编辑')
    assert.match(t.confirms[0], /没保存/)
    assert.match(t.text(), /新建 Bot/)
    assert.equal(t.field('名称').props.value, '写到一半')
    await t.click('编辑')
    assert.match(t.text(), /编辑 Bot：小研/)
  })
})

test('detail pane: a Bot that vanishes from the roster is said so instead of crashing', async () => {
  let gone = false
  await run({ 'GET /bots': () => (gone ? { ...BOTS, nodes: [{ ...BOTS.nodes[0], bots: [BOTS.nodes[0].bots[1]] }, BOTS.nodes[1]] } : BOTS) }, async (t) => {
    await t.click('对话')
    gone = true
    await t.bump()
    assert.match(t.text(), /已经不在名册里/)
  })
})
