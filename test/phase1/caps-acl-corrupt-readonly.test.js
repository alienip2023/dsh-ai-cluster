// 发布阻断：坏 ACL 文件绝不授予超过 read 的权限。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadAcl, createAclLoader } from '../../src/caps/acl-file.js'
import { ACL_CAPABILITIES, ACL_DEFAULTS, checkAcl } from '../../src/caps/acl.js'

const NODES = ['unlisted', 'n1', '@hub']
const GOOD = JSON.stringify({ version: 1, defaults: { write: true }, devices: { n1: { allow: ['shell'] }, '@hub': { allow: ['shell', 'desktop'] } } })
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-rb-')); t.after(() => { try { fs.chmodSync(path.join(d, 'acl.json'), 0o600) } catch {} fs.rmSync(d, { recursive: true, force: true }) }); return d }
const bump = (f) => { const x = new Date(Date.now() + 5000); fs.utimesSync(f, x, x) }

function assertReadOnly(acl) {
  for (const node of NODES) for (const capability of ACL_CAPABILITIES) {
    assert.equal(checkAcl(acl, { node, capability }).allowed, capability === 'read', `${node}/${capability}`)
  }
}

const cases = {
  'empty file': '',
  'truncated JSON': GOOD.slice(0, 30),
  'binary garbage': Buffer.from([0, 255, 254, 1, 2, 128, 0, 77]),
  'array': '[]', 'string': '"x"', 'null': 'null',
  'wrong version': JSON.stringify({ version: 2, devices: { n1: { allow: ['shell'] } } }),
  'capability typo next to valid shell grant': JSON.stringify({ version: 1, devices: { n1: { allow: ['shell', 'shel'] } } }),
  'non-boolean default': JSON.stringify({ version: 1, defaults: { write: 'true' } }),
}
for (const [name, bytes] of Object.entries(cases)) {
  test(`blocker: ${name} -> read-only`, (t) => {
    const d = tmp(t); const f = path.join(d, 'acl.json')
    fs.writeFileSync(f, bytes)
    const r = loadAcl(d, { log: { error() {} } })
    assert.equal(r.source, 'fallback'); assertReadOnly(r.acl)
    assert.equal(fs.existsSync(f), false, 'no acl.json written back')
    const c = fs.readdirSync(d).filter((n) => n.startsWith('acl.json.corrupt-'))
    assert.equal(c.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(d, c[0])), Buffer.from(bytes))
  })
}

test('blocker: acl.json is a directory -> read-only', (t) => {
  const d = tmp(t); fs.mkdirSync(path.join(d, 'acl.json'))
  const r = loadAcl(d, { log: { error() {} } })
  assert.equal(r.source, 'fallback'); assertReadOnly(r.acl)
})

test('blocker: unreadable (mode 000) -> read-only', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('SKIPPED: root or win32 ignores mode 000'); console.log('# SKIPPED mode-000 case (root/win32)'); return }
  const d = tmp(t); const f = path.join(d, 'acl.json')
  fs.writeFileSync(f, GOOD); fs.chmodSync(f, 0)
  const r = loadAcl(d, { log: { error() {} } })
  assert.equal(r.source, 'fallback'); assertReadOnly(r.acl)
})

test('blocker: hot read corruption -> read-only, not earlier broad ACL (D1)', (t) => {
  const d = tmp(t); const f = path.join(d, 'acl.json')
  fs.writeFileSync(f, GOOD)
  const get = createAclLoader({ stateDir: d, log: { warn() {}, error() {} } })
  assert.equal(checkAcl(get(), { node: 'n1', capability: 'shell' }).allowed, true)
  fs.writeFileSync(f, '{broken'); bump(f)
  assertReadOnly(get())
})

test('contrast: missing file -> defaults (write allowed); valid allow shell works', (t) => {
  const d = tmp(t)
  const r = loadAcl(d, {})
  assert.equal(r.source, 'defaults'); assert.deepEqual(r.acl.defaults, ACL_DEFAULTS)
  assert.equal(checkAcl(r.acl, { node: 'unlisted', capability: 'write' }).allowed, true)
  fs.writeFileSync(path.join(d, 'acl.json'), GOOD)
  const v = loadAcl(d, {})
  assert.equal(v.source, 'file')
  assert.equal(checkAcl(v.acl, { node: 'n1', capability: 'shell' }).allowed, true)
  assert.equal(checkAcl(v.acl, { node: 'unlisted', capability: 'shell' }).allowed, false)
})
