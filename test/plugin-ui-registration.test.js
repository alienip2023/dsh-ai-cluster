/**
 * One apply() must register each UI route exactly once, with BOTH prefixes
 * answering, and the client bundle must register its factory exactly once.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { apply } from '../lib/index.js'

const NEW = '/api/ai-cluster/ui'
const OLD = '/api/remote-agent/ui'

function makeCtx() {
  const exact = new Map()
  const upgrades = []
  const logs = []
  const duplicates = []
  const rec = (level) => (msg, extra) => logs.push({ level, msg: String(msg), extra })
  const ctx = {
    logger: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    get() { return undefined },
    provide() {},
    webServer: {
      register({ kind, path: p }) {
        const key = `${kind}:${p}`
        if (exact.has(key)) { duplicates.push(key); throw new Error(`webserver: duplicate exact route "${p}"`) }
        exact.set(key, true)
        return () => exact.delete(key)
      },
      registerUpgrade({ path: p }) {
        if (upgrades.includes(p)) throw new Error(`webserver: duplicate upgrade route "${p}"`)
        upgrades.push(p)
        return () => { upgrades.splice(upgrades.indexOf(p), 1) }
      },
    },
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    subagents: { registerProvider: () => () => {} },
  }
  return { ctx, exact, duplicates, logs }
}

test('one apply registers every UI route once under both prefixes, no errors', () => {
  const f = makeCtx()
  const handles = apply(f.ctx, { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0 })
  try {
    assert.deepEqual(f.duplicates, [], 'no duplicate registration attempted')
    const errors = f.logs.filter((l) => l.level === 'error' || /registration failed/.test(l.msg))
    assert.deepEqual(errors, [], 'no registration error logged')
    const paths = [...f.exact.keys()].map((k) => k.replace(/^exact:/, ''))
    const fresh = paths.filter((p) => p.startsWith(NEW + '/')).map((p) => p.slice(NEW.length))
    const legacy = paths.filter((p) => p.startsWith(OLD + '/')).map((p) => p.slice(OLD.length))
    assert.ok(fresh.length >= 30, `canonical prefix registered (${fresh.length})`)
    assert.deepEqual([...legacy].sort(), [...fresh].sort(), 'both prefixes serve the same set')
    for (const p of ['/overview', '/nodes', '/tasks', '/config', '/models', '/bots', '/memory']) {
      assert.ok(fresh.includes(p) && legacy.includes(p), `${p} on both prefixes`)
    }
  } finally {
    handles.dispose()
  }
  assert.equal(f.exact.size > 0 ? [...f.exact.keys()].some((k) => k.includes('/ui/')) : false, false, 'dispose removes ui routes')
})

test('re-apply on the same host stays duplicate-free (hot activation)', () => {
  const f = makeCtx()
  const cfg = { role: 'hub', nodeToken: 'nt_test', uiEnabled: true, listenPort: 0 }
  const h1 = apply(f.ctx, cfg)
  const h2 = apply(f.ctx, cfg)
  try {
    assert.deepEqual(f.duplicates, [])
    assert.deepEqual(f.logs.filter((l) => /registration failed|threw/.test(l.msg)), [])
  } finally {
    h2.dispose(); h1.dispose()
  }
})

test('uiEnabled:false registers no UI routes', () => {
  const f = makeCtx()
  const h = apply(f.ctx, { role: 'hub', nodeToken: 'nt_test', uiEnabled: false, listenPort: 0 })
  try {
    assert.equal([...f.exact.keys()].filter((k) => k.includes('/ui/')).length, 0)
  } finally { h.dispose() }
})

test('client bundle registers its factory exactly once, under its own id', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const loads = []
  vm.runInNewContext(src, { window: { __ModuleLoader__: { load(m) { loads.push(m.id) } } } })
  assert.deepEqual(loads, ['dsh-ai-cluster'])
  assert.ok(!/PANEL_KEY\s*=\s*'dsh-remote-agent'/.test(src))
})
