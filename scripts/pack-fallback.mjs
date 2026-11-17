#!/usr/bin/env node
/**
 * 安装窗口的同名回退包：只在暂存目录改包名、版本和 patch 入口名，不构建、不改仓库。
 * 用法：node scripts/pack-fallback.mjs <已存在的输出目录>
 * 需要本机已有 npm / tar；产物只供本地回退，禁止发布。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rewriteBundlePatch } from './rewrite-bundle-patch.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const NAME = 'dsh-remote-agent'
const VERSION = '0.10.1-fork.98'
const FILENAME = `${NAME}-${VERSION}.tgz`
const ENTRIES = ['lib/index.js', 'lib/plugin/index.js']
let temporary

// 所有退出路径共用清理；参数检查完成前绝不创建目录。
process.once('exit', () => {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true })
})
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} 失败：${result.error?.message || result.stderr.trim() || `退出码 ${result.status}`}`)
  }
  return result.stdout
}

try {
  if (!process.argv[2]) throw new Error('用法：node scripts/pack-fallback.mjs <已存在的输出目录>')
  const outputDir = path.resolve(process.argv[2])
  let isDirectory = false
  try {
    isDirectory = fs.statSync(outputDir).isDirectory()
  } catch { /* 不创建输出目录，交给操作者指定已有目录。 */ }
  if (!isDirectory) throw new Error(`输出目录不存在或不是目录：${outputDir}`)

  for (const entry of ENTRIES) {
    if (!fs.existsSync(path.join(ROOT, entry))) {
      throw new Error(`缺少 ${entry}；请先运行 node scripts/build-plugin-entry.mjs`)
    }
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fallback-'))
  const staged = path.join(temporary, 'staged')
  const extracted = path.join(temporary, 'extracted')
  fs.mkdirSync(staged)
  fs.mkdirSync(extracted)

  // 与 check-packaging 一致：本仓库 files 只含文件/目录，不含 glob。
  // npm 仍负责最终筛选；package.json 单独写入，其他字段原样保留。
  for (const entry of pkg.files) {
    if (typeof entry !== 'string' || /[*?[\]{}!]/.test(entry)
      || path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
      throw new Error(`不支持的 files 路径：${JSON.stringify(entry)}`)
    }
    fs.cpSync(path.join(ROOT, entry), path.join(staged, entry), { recursive: true })
  }
  // npm 还会自动收录根目录的 README / LICENSE（如 files 未列出的 README.en.md）。
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && /^(?:readme|licen[cs]e|copying)(?:[.-]|$)/i.test(entry.name)) {
      fs.cpSync(path.join(ROOT, entry.name), path.join(staged, entry.name))
    }
  }
  fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify({
    ...pkg, name: NAME, version: VERSION,
  }, null, 2) + '\n')
  const patchPath = pkg.dsh.bundle.patch
  const stagedPatch = path.join(staged, patchPath)
  fs.writeFileSync(stagedPatch, rewriteBundlePatch(fs.readFileSync(stagedPatch, 'utf8'), NAME))

  // 名称和版本决定固定文件名；禁用生命周期脚本，回退打包不隐式触发构建。
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outputDir], staged))
  if (packed.length !== 1 || packed[0].filename !== FILENAME) {
    throw new Error(`npm pack 返回了非预期文件名：${JSON.stringify(packed)}`)
  }
  const tarball = path.join(outputDir, FILENAME)

  // 检查真实归档，不能拿暂存文件冒充产物验证。
  const members = run('tar', ['-tzf', tarball], staged).trim().split('\n')
  for (const entry of ['package.json', ...ENTRIES]) {
    if (!members.includes(`package/${entry}`)) throw new Error(`归档缺少 package/${entry}`)
  }
  if (members.some(member => /^package\/(?:src|test)(?:\/|$)/.test(member))) {
    throw new Error('归档含 package/src/ 或 package/test/')
  }
  run('tar', ['-xzf', tarball, '-C', extracted], staged)
  const archived = JSON.parse(fs.readFileSync(path.join(extracted, 'package/package.json'), 'utf8'))
  if (archived.name !== NAME || archived.version !== VERSION) {
    throw new Error(`归档名称/版本不符：${archived.name}@${archived.version}`)
  }
  const archivedPatch = fs.readFileSync(path.join(extracted, 'package', archived.dsh.bundle.patch), 'utf8')
  if (rewriteBundlePatch(archivedPatch, NAME) !== archivedPatch) {
    throw new Error(`归档 patch 入口名不是 ${NAME}`)
  }
  for (const entry of ENTRIES) {
    run(process.execPath, ['--check', path.join(extracted, 'package', entry)], extracted)
  }
  console.log(`验证通过：${archived.name}@${archived.version}`)
  console.log(`入口存在且 node --check 通过：${ENTRIES.join('、')}`)
  console.log('归档不含 package/src/、package/test/')
  const bytes = fs.readFileSync(tarball)
  console.log(`tarball: ${tarball}`)
  console.log(`bytes: ${bytes.length}`)
  console.log(`sha256: ${createHash('sha256').update(bytes).digest('hex')}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
