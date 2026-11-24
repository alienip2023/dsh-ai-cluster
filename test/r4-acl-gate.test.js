// R4（重写 2026-11-24）：集群工具的每机能力 ACL 接通。acl.json 不存在 → 不拦（旧行为）；存在 → 热读并按机器拦。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { hubAclGate } from '../src/caps/acl-file.js'
import { checkAcl } from '../src/caps/acl.js'

test('R4-ACL-1 no acl.json: no gate; written: enforced per machine; removed: no gate again', t => {
  const dir = mkdtempSync(join(tmpdir(), 'r4-acl-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const gate = hubAclGate({ stateDir: dir })
  assert.equal(gate(), null)
  writeFileSync(join(dir, 'acl.json'), JSON.stringify({ version: 1, defaults: { shell: true }, devices: { node012: { deny: ['shell', 'write'] } } }))
  const acl = gate()
  assert.equal(checkAcl(acl, { node: 'node012', capability: 'shell' }).allowed, false)
  assert.equal(checkAcl(acl, { node: 'node012', capability: 'write' }).allowed, false)
  assert.equal(checkAcl(acl, { node: 'node010', capability: 'shell' }).allowed, true)
  rmSync(join(dir, 'acl.json'))
  assert.equal(gate(), null)
})

test('R4-ACL-2 the live plugin passes the gate to registerClusterTools', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/plugin/index.js', import.meta.url), 'utf8')
  assert.match(src, /registerClusterTools\(\{[^}]*\bacl\b[^}]*\}\)/)
})
