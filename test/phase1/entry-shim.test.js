import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeCtx } from './_plugin-ctx.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const shimPath = path.join(root, 'lib/index.js')
const outputRoot = path.join(root, 'lib/plugin')
const publicNames = [
  'apply', 'Config', 'ROLE', 'resolveRole', 'resolveRoleDetail', 'applyHub',
  'newNodeToken', 'normalizeConfig', 'NODE_UPGRADE_PATH', 'HEALTH_PATH',
].sort()
const build = () => execFileSync(process.execPath, ['scripts/build-plugin-entry.mjs'], { cwd: root, encoding: 'utf8' })

function hashes(dir = outputRoot, result = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) hashes(file, result)
    else result[path.relative(outputRoot, file)] = createHash('sha256').update(readFileSync(file)).digest('hex')
  }
  return result
}

test('build produces a shipped plugin entry and the shim imports it', () => {
  build()
  assert.equal(existsSync(path.join(outputRoot, 'index.js')), true)
  const shim = readFileSync(shimPath, 'utf8')
  assert.doesNotMatch(shim, /(?:from\s*|import\s*\(?\s*)['"][^'"]*\bsrc\//,
    'shim imports src and will not survive packing')
  assert.match(shim, /from\s*['"]\.\/plugin\/index\.js['"]/)
})

test('shim apply preserves the source entry contract', async () => {
  const fromLib = await import('../../lib/index.js')
  const fromSrc = await import('../../src/plugin/index.js')
  assert.equal(typeof fromLib.apply, 'function')
  assert.equal(typeof fromSrc.apply, 'function')
  assert.equal(fromLib.apply.name, fromSrc.apply.name)
  assert.equal(fromLib.apply.length, fromSrc.apply.length)
  const contexts = [makeCtx(), makeCtx()]
  const handles = []
  try {
    for (const [index, { apply }] of [fromLib, fromSrc].entries()) {
      const ctx = contexts[index]
      handles.push(apply(ctx, { role: '', stateDir: ctx.stateDir }))
    }
    assert.deepEqual([...contexts[0].services.keys()].sort(), [...contexts[1].services.keys()].sort())
  } finally {
    for (const handle of handles) handle.dispose()
    for (const ctx of contexts) ctx.cleanup()
  }
})

test('shim Config preserves the source entry contract', async () => {
  const fromLib = await import('../../lib/index.js')
  const fromSrc = await import('../../src/plugin/index.js')
  assert.equal(typeof fromLib.Config, 'function')
  assert.equal(typeof fromSrc.Config, 'function')
  assert.deepEqual(Object.keys(new fromLib.Config()).sort(), Object.keys(new fromSrc.Config()).sort())
})

test('shim preserves all public exports and delegates to the generated entry', async () => {
  const fromLib = await import('../../lib/index.js')
  const generated = await import('../../lib/plugin/index.js')
  assert.deepEqual(Object.keys(fromLib).sort(), publicNames)
  for (const name of publicNames) assert.equal(fromLib[name], generated[name], name)
})

test('a second build preserves the sha256 of every generated module', () => {
  const before = hashes()
  assert.ok(Object.keys(before).length > 0)
  build()
  assert.deepEqual(hashes(), before)
})

test('shim stays under 40 lines and contains no service access or apply body', () => {
  const shim = readFileSync(shimPath, 'utf8')
  assert.ok(shim.trimEnd().split('\n').length < 40)
  assert.doesNotMatch(shim, /\bctx\s*(?:\?\.|\.)\s*webServer|\bctx\s*\[\s*['"]webServer['"]\s*\]/)
  assert.doesNotMatch(shim, /\bctx\s*(?:\?\.|\.)\s*inject\s*\(|\bctx\s*\[\s*['"]inject['"]\s*\]\s*\(/)
  assert.doesNotMatch(shim, /function\s+apply\b|\bapply\s*=/)
})

test('shipped runtime imports and applies without a src directory', (t) => {
  const staging = mkdtempSync(path.join(os.tmpdir(), 'entry-shim-'))
  t.after(() => rmSync(staging, { recursive: true, force: true }))
  cpSync(path.join(root, 'lib'), path.join(staging, 'lib'), { recursive: true })
  cpSync(path.join(root, 'package.json'), path.join(staging, 'package.json'))
  symlinkSync(path.join(root, 'node_modules'), path.join(staging, 'node_modules'), 'dir')
  assert.equal(existsSync(path.join(staging, 'src')), false)
  const generatedFiles = Object.keys(hashes()).map(file => './lib/plugin/' + file.split(path.sep).join('/'))
  const script = `
    import assert from 'node:assert/strict'
    import * as plugin from './lib/index.js'
    for (const file of ${JSON.stringify(generatedFiles)}) await import(file)
    await import('./lib/node/index.js')
    assert.deepEqual(Object.keys(plugin).sort(), ${JSON.stringify(publicNames)})
    const services = new Map()
    const ctx = {
      logger: { info() {}, warn() {} },
      provide(name, value) {
        assert.equal(services.has(name), false)
        services.set(name, value)
        return () => services.delete(name)
      },
    }
    const config = { role: '', stateDir: './state' }
    const first = plugin.apply(ctx, config)
    const second = plugin.apply(ctx, config)
    first.dispose()
    assert.equal(services.size, 2)
    assert.equal(services.get('ai-cluster:role'), services.get('remote-agent:role'))
    second.dispose()
    second.dispose()
    assert.equal(services.size, 0)
  `
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: staging, encoding: 'utf8', timeout: 30_000,
  })
})
