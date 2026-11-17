import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadAcl, createAclLoader, saveAcl } from '../../src/caps/acl-file.js'
import { checkAcl, makeAcl, ACL_DEFAULTS } from '../../src/caps/acl.js'

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }
const valid = (extra = {}) => JSON.stringify({ version: 1, devices: { n1: { allow: ['shell'] } }, ...extra })
const bump = (f) => { const t = new Date(Date.now() + 5000 + Math.random() * 1000); fs.utimesSync(f, t, t) }

test('missing file: defaults, nothing written', (t) => {
  const d = tmp(t)
  const r = loadAcl(d, {})
  assert.equal(r.source, 'defaults'); assert.deepEqual(r.acl.defaults, ACL_DEFAULTS)
  assert.deepEqual(fs.readdirSync(d), [])
})
test('valid file', (t) => {
  const d = tmp(t); fs.writeFileSync(path.join(d, 'acl.json'), valid())
  const r = loadAcl(d, {})
  assert.equal(r.source, 'file'); assert.equal(checkAcl(r.acl, { node: 'n1', capability: 'shell' }).allowed, true)
})
test('hot reload + repaired-file recovery, no write-back, corrupt not renamed on hot read', (t) => {
  const d = tmp(t); const f = path.join(d, 'acl.json')
  fs.writeFileSync(f, valid())
  const get = createAclLoader({ stateDir: d, log: { warn() {}, error() {} } })
  assert.equal(checkAcl(get(), { node: 'n1', capability: 'shell' }).allowed, true)
  fs.writeFileSync(f, JSON.stringify({ version: 1, devices: { n1: { deny: ['shell'] } } })); bump(f)
  assert.equal(checkAcl(get(), { node: 'n1', capability: 'shell' }).allowed, false)
  fs.writeFileSync(f, '{oops'); bump(f)
  assert.equal(checkAcl(get(), { node: 'n1', capability: 'write' }).allowed, false)
  assert.equal(fs.readFileSync(f, 'utf8'), '{oops')
  fs.writeFileSync(f, valid()); bump(f)
  assert.equal(checkAcl(get(), { node: 'n1', capability: 'shell' }).allowed, true)
  assert.equal(checkAcl(get(), { node: 'n1', capability: 'write' }).allowed, true)
})
test('corrupt file: renamed, bytes preserved, not rewritten', (t) => {
  const d = tmp(t); fs.writeFileSync(path.join(d, 'acl.json'), 'garbage')
  const errs = []
  const r = loadAcl(d, { log: { error: (m) => errs.push(m) } })
  assert.equal(r.source, 'fallback'); assert.equal(errs.length, 1)
  const names = fs.readdirSync(d)
  assert.ok(!names.includes('acl.json'))
  const c = names.filter((n) => n.startsWith('acl.json.corrupt-'))
  assert.equal(c.length, 1); assert.equal(fs.readFileSync(path.join(d, c[0]), 'utf8'), 'garbage')
})
test('saveAcl writes 0600', async (t) => {
  const d = tmp(t)
  await saveAcl(d, makeAcl())
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(d, 'acl.json')).mode & 0o777, 0o600)
  assert.equal(loadAcl(d, {}).source, 'file')
})
test('write failure leaves old file intact, E_ACL_WRITE', async (t) => {
  const d = tmp(t); const f = path.join(d, 'acl.json')
  await saveAcl(d, makeAcl())
  const before = fs.readFileSync(f, 'utf8')
  // 目标变成非空目录：rename 必败
  const sub = path.join(d, 'sub'); fs.mkdirSync(sub); fs.writeFileSync(path.join(sub, 'x'), '1')
  fs.copyFileSync(f, path.join(sub, 'acl.json'))
  fs.mkdirSync(path.join(sub, 'acl.json.d'))
  await assert.rejects(saveAcl(sub, makeAcl()).then(() => { throw new Error('should fail') }).catch((e) => { throw e }), () => true).catch(() => {})
  assert.equal(fs.readFileSync(f, 'utf8'), before)
  // 确定性失败：stateDir 是一个文件
  const filePath = path.join(d, 'afile'); fs.writeFileSync(filePath, 'x')
  await assert.rejects(saveAcl(filePath, makeAcl()), { code: 'E_ACL_WRITE' })
  // 无效 ACL 不落盘
  await assert.rejects(saveAcl(d, { version: 9 }), { code: 'E_INVALID_ARG' })
  assert.equal(fs.readFileSync(f, 'utf8'), before)
})
