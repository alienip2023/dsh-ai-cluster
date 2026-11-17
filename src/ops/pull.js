/** ops/pull：拉取落盘目录解析（逐字取自 lib/hub/ui-routes.js:332，仅换 import）。 */
import fs from 'node:fs'
import path from 'node:path'
import { isInside, normalizePath } from '../fsbox/glob.js'

const MAX_ERR_MESSAGE = 300

function shortMessage(err) {
  const raw = String(err?.message ?? err ?? '')
  const firstLine = raw.split(/\r?\n/)[0]
  return firstLine.slice(0, MAX_ERR_MESSAGE)
}

/**
 * 计算 pull 的落盘目录，双道校验。
 *
 * 顺序（**不可调换**）：
 *   1. 字符串层 `isInside(pullRoot, destDir)` —— 挡 `../`、`..\`、绝对路径
 *   2. `mkdirSync(destDir)` —— 目录不存在时 realpath 会失败，所以必须先建
 *   3. `realpathSync(destDir)` 后复查 `isInside(realRoot, realDest)`
 *      —— 挡符号链接、Windows 8.3 短名、junction 等字符串层看不出的逃逸
 *
 * 已知的取舍：第 2 步可能创建一个"最终会被判定越界"的空目录
 * （例如 pullRoot 内已有一个指向 /etc 的符号链接，我们会在 /etc 下 mkdir）。
 * 这是可接受的 —— 创建空目录不是数据泄漏，越界**写入**才是，
 * 而第 3 步保证了越界写入不会发生。反过来若先校验再 mkdir，
 * 新建目录的 realpath 会抛 ENOENT，正常路径反而不可用。
 *
 * @returns {{ok:true, dir:string} | {ok:false, code:string, dest:string}}
 */
export function resolvePullDest(pullRoot, sub) {
  const destDir = path.resolve(pullRoot, typeof sub === 'string' ? sub : '')

  // ① 字符串层：挡 ../ 与反斜杠写法
  if (!isInside(normalizePath(pullRoot), normalizePath(destDir), {})) {
    return { ok: false, code: 'dest-outside-pull-root', dest: typeof sub === 'string' ? sub : '' }
  }

  let realRoot
  let realDest
  try {
    fs.mkdirSync(pullRoot, { recursive: true })
    realRoot = fs.realpathSync.native ? fs.realpathSync.native(pullRoot) : fs.realpathSync(pullRoot)
    // ② 建目录（realpath 要求路径存在）
    fs.mkdirSync(destDir, { recursive: true })
    // ③ realpath 归一后复查：挡符号链接逃逸
    realDest = fs.realpathSync.native ? fs.realpathSync.native(destDir) : fs.realpathSync(destDir)
  } catch (err) {
    return { ok: false, code: 'pull-root-unusable', dest: typeof sub === 'string' ? sub : '', message: shortMessage(err) }
  }

  if (!isInside(normalizePath(realRoot), normalizePath(realDest), {})) {
    return { ok: false, code: 'dest-outside-pull-root-after-resolve', dest: typeof sub === 'string' ? sub : '' }
  }
  return { ok: true, dir: realDest }
}
