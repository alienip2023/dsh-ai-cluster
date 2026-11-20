#!/usr/bin/env node
// npm run check:release -- [<commit> | --worktree [<isolated snapshot>]]
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const baseline = '58052c9cdb2e2c8ab7058837e8176996a6532f3a'
// T-ISO-2 and release criterion 4 verify the measured bytes of lib/client.js.
const clientHash = '13cc09b108b5b1c22fa4031b84193ebdd949afb63a1cc009ee2a34dbf98d81ac'
const srcFiles = ['src/compat/dual-provide.js', 'src/compat/ra-names.js']
const ticketFiles = ['identity.js', 'index.js', 'ledger-file.js', 'snapshot.js', 'store.js']
const registerTest = 'test/phase1/tool-alias-register.test.js'
const repo = process.cwd()
const [ref = 'HEAD', snapshot, ...extra] = process.argv.slice(2)
if (extra.length || (snapshot && ref !== '--worktree')) {
  throw new Error('Usage: npm run check:release -- [<commit> | --worktree [<isolated snapshot>]]')
}
const modules = realpathSync(path.join(repo, 'node_modules'))
const tempRoot = realpathSync(os.tmpdir())
if (tempRoot === repo || tempRoot.startsWith(repo + path.sep)) throw new Error('Use a TMPDIR outside the repository')
const temp = mkdtempSync(path.join(tempRoot, 'release-reachability-'))
const A = path.join(temp, 'A')
const B = path.join(temp, 'B')
const C = path.join(temp, 'C')
const run = (cmd, args, cwd = repo, options = {}) => execFileSync(cmd, args, {
  cwd, encoding: 'utf8', timeout: 60_000, ...options,
})
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8')
const json = (dir, file) => JSON.parse(read(dir, file))
const isFile = file => statSync(file, { throwIfNoEntry: false })?.isFile() ?? false

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => !entry.isDirectory())
    .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

function archive(commit, dest) {
  const tar = path.join(temp, 'source.tar')
  run('git', ['archive', '--format=tar', '-o', tar, commit])
  run('tar', ['-xf', tar, '-C', dest])
  rmSync(tar)
}

function copyTree(dest) {
  const source = snapshot ? realpathSync(snapshot) : repo
  const files = snapshot
    ? listFiles(source)
    : run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean)
  for (const file of new Set(files)) {
    if (file.split('/').some(part => part === '.git' || part === 'node_modules')) continue
    const input = path.join(source, file)
    if (!existsSync(input)) continue // Tracked files may have worktree deletions.
    const output = path.join(dest, file)
    mkdirSync(path.dirname(output), { recursive: true })
    cpSync(input, output, { verbatimSymlinks: true })
  }
  return Object.fromEntries(listFiles(dest).map(file => [file, sha256(readFileSync(path.join(dest, file)))]))
}

function staticFailures(target) {
  // As in build-plugin-entry, scan literal relative imports/re-exports, skipping comments and strings.
  const tokens = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|(?:\bimport\s*(?:\(\s*|\s+(?:[\w$*{},\s]+?\s+from\s*)?)|\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\r\n]+)\1|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g
  const visited = new Set()
  const failures = []
  function visit(file, from) {
    if (!file.startsWith(C + path.sep) || !isFile(file)) {
      failures.push(`${from} -> ${path.relative(C, file)}`)
      return
    }
    if (visited.has(file) || !/\.[cm]?js$/.test(file)) return
    visited.add(file)
    const rel = path.relative(C, file)
    for (const match of read(C, rel).matchAll(tokens)) {
      if (match[2]) visit(path.resolve(path.dirname(file), match[2].split(/[?#]/, 1)[0]), rel)
    }
  }
  visit(path.resolve(C, target), 'exports')
  return failures
}

function importEntry(name, key, target) {
  const specifier = name + key.slice(1)
  // The browser entry registers with a host global. Supply an inert load callback.
  // YAML exports are assets. Node must resolve them but has no native YAML loader.
  const probe = `
    import assert from 'node:assert/strict'
    import { statSync } from 'node:fs'
    const [specifier, key, target] = process.argv.slice(1)
    const url = import.meta.resolve(specifier)
    assert.equal(url, new URL(target, import.meta.url).href)
    assert.ok(statSync(new URL(url)).isFile())
    if (key === './client') globalThis.window = { __ModuleLoader__: { load() {} } }
    if (target.endsWith('.yml')) {
      await assert.rejects(import(specifier), { code: 'ERR_UNKNOWN_FILE_EXTENSION' })
      console.log('resolved YAML asset (Node has no YAML loader)')
    } else {
      await import(specifier, target.endsWith('.json') ? { with: { type: 'json' } } : {})
      console.log('imported')
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe, specifier, key, target], {
    cwd: C, encoding: 'utf8', timeout: 30_000,
  })
  return result.status === 0
    ? { ok: true, result: result.stdout.trim() }
    : { ok: false, result: (result.error?.message || result.stderr).split(C + path.sep).join('').trim() }
}

function generatedFiles() {
  const dir = path.join(A, 'lib/plugin')
  return new Map(listFiles(dir).map(file => [file, readFileSync(path.join(dir, file))]))
}

function registerResult(dir) {
  symlinkSync(modules, path.join(dir, 'node_modules'), 'dir')
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', registerTest], {
    cwd: dir, encoding: 'utf8', timeout: 30_000,
  })
  // TAP outcomes and counts are stable. Omit duration and diagnostic paths.
  const output = result.stdout.split('\n').filter(line => /^(?:ok |not ok |1\.\.|# (?:tests|suites|pass|fail|cancelled|skipped|todo) )/.test(line))
  return { status: result.status, sha256: sha256(output.join('\n')), output,
    ...(result.status !== 0 && { error: result.error?.message || result.stderr || result.stdout }) }
}

try {
  for (const dir of [A, B, C]) mkdirSync(dir)
  const input = ref === '--worktree' ? { mode: ref, files: copyTree(A) } : {
    commit: run('git', ['rev-parse', '--verify', `${ref}^{commit}`]).trim(),
  }
  if (input.commit) archive(input.commit, A)
  const pack = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', B], A, {
    env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
      npm_config_cache: path.join(B, 'cache') },
  }))[0]
  const tgz = path.join(B, pack.filename)
  const packed = run('tar', ['-tzf', tgz], B).trimEnd().split('\n').sort()
  run('tar', ['-xzf', tgz, '-C', C, '--strip-components=1'])
  const pkg = json(C, 'package.json')
  const staticChecks = Object.fromEntries(Object.entries(pkg.exports).map(([key, target]) => [key, staticFailures(target)]))
  symlinkSync(modules, path.join(C, 'node_modules'), 'dir')
  const entries = Object.entries(pkg.exports).map(([key, target]) => ({ key, target,
    staticFailures: staticChecks[key], dynamic: importEntry(pkg.name, key, target) }))
  const resolutionFailures = entries.filter(entry => entry.staticFailures.length || !entry.dynamic.ok).length

  const shipped = listFiles(C).filter(file => file.startsWith('src/') || /^lib\/plugin\/(admission|authz|tickets)\//.test(file))
  const actualSrc = shipped.filter(file => file.startsWith('src/'))
  const actualTickets = shipped.filter(file => file.startsWith('lib/plugin/tickets/'))
  const expectedTickets = ticketFiles.map(file => `lib/plugin/tickets/${file}`)
  const missing = [...expectedTickets, 'lib/plugin/authz/decide.js', 'lib/plugin/admission/index.js', ...srcFiles]
    .filter(file => !shipped.includes(file))
  const unexpected = [...actualSrc.filter(file => !srcFiles.includes(file)),
    ...actualTickets.filter(file => !expectedTickets.includes(file))]
  const client = readFileSync(path.join(C, 'lib/client.js'))
  const grep = (text, needle) => text.split('\n').filter(line => line.includes(needle)).length
  const p0 = { sha256: sha256(client), expected: clientHash, greps: {
    'memory-hub-scopes': grep(client.toString(), 'memory-hub-scopes'),
    '尚未上报模型': grep(client.toString(), '尚未上报模型'),
    '"version": "0.4.6"': grep(read(C, 'package.json'), '"version": "0.4.6"'),
  } }

  const before = generatedFiles()
  let build = ''
  let buildError
  try {
    build = run(process.execPath, ['scripts/build-plugin-entry.mjs'], A).trim()
  } catch (error) {
    buildError = error.stderr?.trim() || error.message
  }
  const after = generatedFiles()
  const drift = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(file => {
    if (!before.has(file)) return [{ file, difference: 'missing' }]
    if (!after.has(file)) return [{ file, difference: 'extra' }]
    return before.get(file).equals(after.get(file)) ? [] : [{ file, difference: 'bytes' }]
  })

  const candidate = registerResult(A)
  let reference = candidate
  if (input.commit !== baseline) {
    const D = path.join(temp, 'register-baseline')
    mkdirSync(D)
    archive(baseline, D)
    reference = registerResult(D)
  }
  const outputMatches = JSON.stringify(candidate.output) === JSON.stringify(reference.output)
  const criteria = {
    1: { source: 'artifact-proven', pass: resolutionFailures === 0, resolutionFailures, entries },
    2: { source: 'artifact-proven', pass: missing.length === 0 && unexpected.length === 0, shipped, missing, unexpected },
    3: { source: 'repo-proven', pass: !buildError && drift.length === 0, build, before: before.size, after: after.size, drift,
      ...(buildError && { buildError }) },
    4: { source: 'artifact-proven', pass: p0.sha256 === clientHash && pkg.version === '0.4.6' && Object.values(p0.greps).every(Boolean), ...p0 },
    5: { source: 'repo-proven', pass: candidate.status === 0 && reference.status === 0 && outputMatches,
      baseline, reference, candidate, outputMatches },
  }
  console.log(JSON.stringify({ input, packed, criteria }, null, 2))
  process.exitCode = Object.values(criteria).every(result => result.pass) ? 0 : 1
} finally {
  rmSync(temp, { recursive: true, force: true })
}
