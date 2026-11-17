/**
 * store/atomic：唯一的「临时文件 → rename」写入器。
 *
 * 行为取自 lib/hub/templates.js 的 atomicWriteJson（EPERM 事故史见
 * test/phase1/atomic-write-eperm.test.js 头注释）：
 *  - rename 遇瞬态锁（EPERM/EBUSY/EACCES）有界重试：16 次，指数退避封顶 500ms；
 *  - 只在前 15 次全失败后，最后一次尝试前才 unlink 目标兜底；
 *  - 失败清理临时文件、保持原文件不动、父目录不存在则创建。
 *
 * 权限不统一：`mode` 由调用方显式给。atomicWriteJson 默认 0o600；
 * atomicWrite / atomicWriteSync 不传 mode 时按进程默认（对应旧 config-sync 的
 * 非机密写）。需要 0o600 的调用方必须显式传入。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const RENAME_RETRIES = 16
const RENAME_BACKOFF_MS = 10
const RENAME_BACKOFF_MAX_MS = 500
/** 第几次尝试开始走 unlink 兜底（0 基；= RENAME_RETRIES - 1 即最后一次）。 */
const RENAME_UNLINK_FALLBACK_AT = RENAME_RETRIES - 1

/**
 * 异步原子写（带 EPERM 窗口）。默认把 value 序列化成缩进 JSON + 换行；
 * `raw: true` 时 value 作为字符串/Buffer 原样写入（atomicWrite 走这条）。
 *
 * @param {string} file 目标绝对路径
 * @param {unknown} value 可 JSON 序列化的值（raw 时为 string|Buffer）
 * @param {{ mode?: number, encoding?: BufferEncoding, raw?: boolean }} [opts]
 */
export async function atomicWriteJson(file, value, { mode = 0o600, encoding = 'utf8', raw = false } = {}) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  try {
    await fs.promises.writeFile(tmp, raw ? value : `${JSON.stringify(value, null, 2)}\n`, { encoding, ...(mode === undefined ? {} : { mode }) })
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.promises.rename(tmp, file)
        return
      } catch (err) {
        const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES'
        if (!transient || attempt >= RENAME_RETRIES) throw err
        if (attempt === RENAME_UNLINK_FALLBACK_AT) {
          try {
            await fs.promises.rm(file, { force: true })
          } catch {
            /* 删不掉就继续等下一轮 */
          }
        }
        await new Promise((r) => setTimeout(r, Math.min(RENAME_BACKOFF_MAX_MS, RENAME_BACKOFF_MS * 2 ** attempt)))
      }
    }
  } catch (err) {
    try {
      await fs.promises.rm(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw err
  }
}

/** 异步原子写任意内容（mode 缺省 = 进程默认权限）。 */
export function atomicWrite(file, data, { mode, encoding = 'utf8' } = {}) {
  return atomicWriteJson(file, data, { mode, encoding, raw: true })
}

/**
 * 同步原子写：与旧同步调用点（instance-config / task-store / config-sync）同形，
 * 不做 EPERM 重试（旧代码也没有）；失败清理临时文件并重新抛出。
 */
export function atomicWriteSync(file, data, { mode, encoding = 'utf8' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    fs.writeFileSync(tmp, data, { encoding, ...(mode === undefined ? {} : { mode }) })
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw err
  }
}
