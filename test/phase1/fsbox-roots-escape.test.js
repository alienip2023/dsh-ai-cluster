/**
 * 发布阻断项：roots 之外的写必须失败。每个用例同时断言
 *  (1) 抛 FsError code === 'workspace-denied'；(2) 文件系统上 root 之外没有任何变化。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createFsService, FsError } from '../../src/fsbox/index.js'

function snapshot(dir) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const st = fs.lstatSync(p)
      out.push(`${p}|${e.isSymbolicLink() ? 'L' : e.isDirectory() ? 'D' : 'F'}|${e.isFile() ? fs.readFileSync(p, 'utf8') : ''}|${st.mtimeMs}`)
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p)
    }
  }
  walk(dir)
  return out.sort()
}

function setup(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsbox-esc-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'root')
  const evil = path.join(base, 'root-evil')
  const outside = path.join(base, 'outside')
  for (const d of [root, evil, outside]) fs.mkdirSync(d)
  fs.writeFileSync(path.join(outside, 'existing.txt'), 'ORIGINAL')
  fs.writeFileSync(path.join(root, 'inside.txt'), 'IN')
  fs.writeFileSync(path.join(evil, 'e.txt'), 'EVIL')
  fs.symlinkSync(outside, path.join(root, 'link'), 'dir')
  fs.symlinkSync(path.join(outside, 'existing.txt'), path.join(root, 'filelink.txt'), 'file')
  return { base, root, evil, outside }
}

const denied = (e) => e instanceof FsError && e.code === 'workspace-denied'

/** 跑 fn，断言被拒，且 base 下除 root/ 之外的内容、以及 root/ 里的符号链接目标均未变。 */
function expectDenied(env, fn, label) {
  const before = { evil: snapshot(env.evil), outside: snapshot(env.outside) }
  assert.throws(fn, denied, label)
  assert.deepEqual(snapshot(env.evil), before.evil, `${label}: root-evil 被改动`)
  assert.deepEqual(snapshot(env.outside), before.outside, `${label}: outside 被改动`)
  assert.deepEqual(fs.readdirSync(env.base).sort(), ['outside', 'root', 'root-evil'], `${label}: base 下出现新条目`)
}

test('1 绝对路径写到 outside/ 被拒', (t) => {
  const e = setup(t)
  const svc = createFsService({ roots: [e.root] })
  expectDenied(e, () => svc.write({ path: path.join(e.outside, 'new.txt'), content: 'x' }), 'abs outside')
})

test('2 含 .. 的路径解析到 root 外被拒', (t) => {
  const e = setup(t)
  const svc = createFsService({ roots: [e.root] })
  expectDenied(e, () => svc.write({ path: `${e.root}/../outside/new.txt`, content: 'x' }), 'dotdot')
  expectDenied(e, () => svc.write({ path: `${e.root}/sub/../../outside/new.txt`, content: 'x' }), 'dotdot deep')
})

test('3 前缀兄弟 root-evil/ 被拒', (t) => {
  const e = setup(t)
  const svc = createFsService({ roots: [e.root] })
  expectDenied(e, () => svc.write({ path: path.join(e.evil, 'new.txt'), content: 'x' }), 'prefix sibling new')
  expectDenied(e, () => svc.write({ path: path.join(e.evil, 'e.txt'), content: 'x', overwrite: true }), 'prefix sibling overwrite')
})

test('4 经 root 内符号链接写到 outside/ 被拒（已有链接、新文件、已有目标）', (t) => {
  const e = setup(t)
  const svc = createFsService({ roots: [e.root] })
  expectDenied(e, () => svc.write({ path: path.join(e.root, 'link', 'new.txt'), content: 'x' }), 'symlink dir new file')
  expectDenied(e, () => svc.write({ path: path.join(e.root, 'link', 'existing.txt'), content: 'x', overwrite: true }), 'symlink dir existing target')
  expectDenied(e, () => svc.write({ path: path.join(e.root, 'filelink.txt'), content: 'x', overwrite: true }), 'symlink file')
  expectDenied(e, () => svc.write({ path: path.join(e.root, 'link', 'a', 'b', 'c.txt'), content: 'x' }), 'symlink deep')
  assert.equal(fs.readFileSync(path.join(e.outside, 'existing.txt'), 'utf8'), 'ORIGINAL')
})

test('5 不存在的深路径，首个存在的祖先在 root 外', (t) => {
  const e = setup(t)
  const svc = createFsService({ roots: [e.root] })
  expectDenied(e, () => svc.write({ path: path.join(e.outside, 'x', 'y', 'z', 'new.txt'), content: 'x' }), 'deep outside')
  expectDenied(e, () => svc.write({ path: path.join(e.base, 'nonexist', 'a', 'b.txt'), content: 'x' }), 'deep under base')
})

test('6 相对路径与空路径被拒', (t) => {
  const e = setup(t)
  const svc = createFsService({ roots: [e.root] })
  for (const p of ['rel.txt', './rel.txt', '../outside/x.txt', '', undefined, null, 42]) {
    expectDenied(e, () => svc.write({ path: p, content: 'x' }), `write ${String(p)}`)
    expectDenied(e, () => svc.mkdir({ path: p }), `mkdir ${String(p)}`)
    expectDenied(e, () => svc.delete({ path: p }), `delete ${String(p)}`)
    expectDenied(e, () => svc.move({ from: p, to: path.join(e.root, 'x') }), `move from ${String(p)}`)
    expectDenied(e, () => svc.move({ from: path.join(e.root, 'inside.txt'), to: p }), `move to ${String(p)}`)
  }
  assert.equal(fs.existsSync(path.join(e.root, 'x')), false)
})

test('7 命中 denyPaths 且尚不存在的路径被拒（绝对与相对条目）', (t) => {
  const e = setup(t)
  const svc = createFsService({ roots: [e.root], denyPaths: [path.join(e.root, 'secret'), '.git'] })
  const before = snapshot(e.root)
  assert.throws(() => svc.write({ path: path.join(e.root, 'secret', 'new.txt'), content: 'x' }), denied)
  assert.throws(() => svc.write({ path: path.join(e.root, 'proj', '.git', 'config'), content: 'x' }), denied)
  assert.throws(() => svc.mkdir({ path: path.join(e.root, 'secret', 'd') }), denied)
  assert.deepEqual(snapshot(e.root), before, 'root 被改动')
  assert.equal(fs.existsSync(path.join(e.root, 'secret')), false)
})

test('8 mkdir / move（源与目的）/ delete 对每种逃逸都被拒', (t) => {
  const e = setup(t)
  const svc = createFsService({ roots: [e.root] })
  const escapes = {
    abs: path.join(e.outside, 'n'),
    dotdot: `${e.root}/../outside/n`,
    sibling: path.join(e.evil, 'n'),
    symlinkNew: path.join(e.root, 'link', 'n'),
    symlinkExisting: path.join(e.root, 'link', 'existing.txt'),
    deep: path.join(e.outside, 'a', 'b', 'n'),
  }
  const inside = path.join(e.root, 'inside.txt')
  for (const [name, p] of Object.entries(escapes)) {
    expectDenied(e, () => svc.mkdir({ path: p }), `mkdir ${name}`)
    expectDenied(e, () => svc.move({ from: inside, to: p }), `move dest ${name}`)
    expectDenied(e, () => svc.move({ from: p, to: path.join(e.root, 'moved') }), `move src ${name}`)
    expectDenied(e, () => svc.delete({ path: p }), `delete ${name}`)
    expectDenied(e, () => svc.delete({ path: p, recursive: true }), `delete recursive ${name}`)
  }
  assert.equal(fs.readFileSync(inside, 'utf8'), 'IN', '源文件不得被移走')
  assert.equal(fs.existsSync(path.join(e.root, 'moved')), false)
  assert.equal(fs.readFileSync(path.join(e.outside, 'existing.txt'), 'utf8'), 'ORIGINAL')
})

test('9a roots: [] / roots 缺省：一切被拒（workspace-denied）', (t) => {
  const e = setup(t)
  for (const roots of [[], undefined]) {
    const svc = createFsService({ roots })
    for (const p of [path.join(e.root, 'n.txt'), path.join(e.outside, 'n.txt'), e.root]) {
      expectDenied(e, () => svc.write({ path: p, content: 'x' }), `write roots=${JSON.stringify(roots)} ${p}`)
      expectDenied(e, () => svc.mkdir({ path: p }), `mkdir roots=${JSON.stringify(roots)}`)
      expectDenied(e, () => svc.delete({ path: p }), `delete roots=${JSON.stringify(roots)}`)
      expectDenied(e, () => svc.move({ from: path.join(e.root, 'inside.txt'), to: p }), `move roots=${JSON.stringify(roots)}`)
    }
  }
  assert.equal(fs.existsSync(path.join(e.root, 'n.txt')), false)
  assert.equal(fs.readFileSync(path.join(e.root, 'inside.txt'), 'utf8'), 'IN')
})

test('9b 不可达（尚不存在）的 root：root 之外一切被拒；root 自身的行为按旧代码原样记录', (t) => {
  const e = setup(t)
  const ghost = path.join(e.base, 'ghost-root')
  const svc = createFsService({ roots: [ghost] })
  // root 之外（含真实存在的 root/、outside/、root-evil/）：全部 workspace-denied，且无任何变化
  for (const p of [path.join(e.root, 'n.txt'), path.join(e.outside, 'n.txt'), path.join(e.evil, 'n.txt'), path.join(e.base, 'ghost-root-2', 'n.txt')]) {
    expectDenied(e, () => svc.write({ path: p, content: 'x' }), `write ${p}`)
    expectDenied(e, () => svc.mkdir({ path: p }), `mkdir ${p}`)
    expectDenied(e, () => svc.delete({ path: p }), `delete ${p}`)
  }
  assert.equal(fs.existsSync(path.join(e.base, 'ghost-root-2')), false)
  // 已知差异（旧代码行为，原样保留，见报告「开放项」）：write 到 ghost 下因父目录不存在抛 artifact-missing（非 workspace-denied）。
  assert.throws(() => svc.write({ path: path.join(ghost, 'n.txt'), content: 'x' }), (err) => err instanceof FsError && err.code === 'artifact-missing')
  assert.equal(fs.existsSync(ghost), false, 'write 不得创建 ghost root')
  // 已知差异：mkdir 落在 ghost root 之内（路径恰好等于声明的 root），旧代码允许。这没有写到 root 之外。
  svc.mkdir({ path: path.join(ghost, 'd') })
  assert.deepEqual(fs.readdirSync(e.base).sort(), ['ghost-root', 'outside', 'root', 'root-evil'])
  assert.deepEqual(fs.readdirSync(ghost), ['d'])
})

test('对照：root 内合法写、mkdir、move、delete 仍然成功', (t) => {
  const e = setup(t)
  const svc = createFsService({ roots: [e.root] })
  svc.write({ path: path.join(e.root, 'a.txt'), content: 'ok' })
  assert.equal(fs.readFileSync(path.join(e.root, 'a.txt'), 'utf8'), 'ok')
  svc.mkdir({ path: path.join(e.root, 'd1', 'd2') })
  svc.move({ from: path.join(e.root, 'a.txt'), to: path.join(e.root, 'd1', 'a.txt') })
  svc.delete({ path: path.join(e.root, 'd1', 'a.txt') })
  assert.equal(fs.existsSync(path.join(e.root, 'd1', 'a.txt')), false)
})
