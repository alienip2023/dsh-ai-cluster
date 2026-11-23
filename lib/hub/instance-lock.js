/**
 * 监听端口被自家旧实例占住时的回收（压测 D2）。
 *
 * 现象：用户 ⌘Q 后重开，旧宿主进程没有退出，继续占着 hub 的监听端口，新宿主的 hub 一直绑不上，
 * 节点全部掉线，直到人工 kill -9。已有的退避重试只会等。
 *
 * 这里只在「端口被占、已经等了很久」时才可能动手，并且必须同时满足：
 *   - 锁文件记着这个端口、这个 pid，pid 活着、不是自己或自己的祖先；
 *   - 同一个 profile（DSH_HOME / DSH_PROFILE 一致）、命令行是 DeepSeek Harness；
 *   - lsof 确认这个 pid 真的在监听这个端口（防 pid 复用）；
 *   - 它比自己更早启动；
 *   - 等了至少 30 秒（正常退出的旧实例有时间自己放手）；
 *   - 它对 hub 自己的健康检查接口没有任何回应（一个健康的实例，比如另一个窗口的同 profile 实例，
 *     会回应，绝不能杀）。
 * 动手时先 SIGTERM，等 3 秒，还活着才 SIGKILL。任何一项拿不到信息，都按「继续等」处理。
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { resolveProfileDir } from '../profile-path.js'

export const MIN_WAIT_MS = 30_000
export const TERM_WAIT_MS = 3_000

export function lockPath(home = os.homedir(), port) {
  return path.join(home, '.dsh', 'ai-cluster', Number.isInteger(port) ? `hub-${port}.lock.json` : 'hub.lock.json')
}

/**
 * 同一个用户可以同时开几个 profile。桌面版的 profile 不靠环境变量区分（宿主进程没有 DSH_HOME / DSH_PROFILE，
 * profile 在启动参数和插件所在目录里），所以这里还要带上 resolveProfileDir() 解析出的 profile 目录；
 * 解析不出来（不在 profile 里加载，比如测试）就按原来的算法，只看 home 与这两个变量。
 */
function ownProfileDir(home, env) {
  try {
    return resolveProfileDir({ env, homeDir: home })
  } catch {
    return ''
  }
}

export function profileTag(home = os.homedir(), env = process.env, profileDir = ownProfileDir(home, env)) {
  const extra = `${env?.DSH_HOME ?? ''}\n${env?.DSH_PROFILE ?? ''}${profileDir ? `\n${profileDir}` : ''}`
  return createHash('sha256').update(extra === '\n' ? home : `${home}\n${extra}`).digest('hex').slice(0, 12)
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 1 && pid <= 0x7fff_ffff
}

export function readLock(file) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (lock == null || !validPid(lock.pid)
      || !Number.isInteger(lock.port) || lock.port < 1 || lock.port > 65535
      || typeof lock.host !== 'string' || typeof lock.profileTag !== 'string'
      || typeof lock.version !== 'string' || typeof lock.startedAt !== 'string') return null
    return lock
  } catch {
    return null
  }
}

export function writeLock(file, data) {
  const target = path.resolve(file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(data))
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, target)
  } catch (err) {
    try { fs.unlinkSync(temporary) } catch { /* 保留原始写入错误 */ }
    throw err
  }
  return target
}

export function clearLock(file, pid) {
  const lock = readLock(file)
  if (lock === null || lock.pid !== pid) return false
  try {
    fs.unlinkSync(file)
    return true
  } catch (err) {
    if (err?.code === 'ENOENT') return false
    throw err
  }
}

export function isAlive(pid, { allowEperm = true } = {}) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (err?.code === 'ESRCH') return false
    if (err?.code === 'EPERM' && allowEperm) return true
    throw err
  }
}

export function commandLine(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  } catch {
    return ''
  }
}

function killProcess(pid, signal = 'SIGKILL') {
  try {
    return process.kill(pid, signal)
  } catch {
    return false
  }
}

/** 真正在监听这个端口的 pid 列表；拿不到（没有 lsof 等）返回 undefined。 */
export function listenersOf(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch (err) {
    // lsof 找不到任何匹配时退出码是 1、输出为空：那是「没有监听者」，不是「拿不到信息」。
    if (err?.status === 1 && String(err.stdout ?? '') === '') return []
    return undefined
  }
}

/** 占着端口的那个进程会不会回应 hub 自己的健康检查：任何 HTTP 回应都算活着。 */
export function holderResponds({ host = '127.0.0.1', port, path: healthPath = '/health', timeoutMs = 3000 }) {
  const target = host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const request = http.get({ host: target, port, path: healthPath, timeout: timeoutMs, agent: false }, (response) => {
      response.resume()
      finish(true)
    })
    request.on('timeout', () => { request.destroy(); finish(false) })
    request.on('error', () => finish(false))
  })
}

let cachedAncestors
export function getSelfAncestors() {
  if (cachedAncestors !== undefined) return cachedAncestors
  const ancestors = []
  let pid = process.pid
  for (let depth = 0; depth < 16 && pid > 1; depth += 1) {
    const parent = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    if (parent === '0' || parent === '1') break
    pid = Number(parent)
    if (!validPid(pid)) throw new Error('Invalid parent PID from ps')
    ancestors.push(pid)
  }
  cachedAncestors = Object.freeze(ancestors)
  return cachedAncestors
}

/**
 * 只通过注入函数取进程状态，按守卫顺序决定是否允许回收。
 * 回收所需的新信息缺一项（等了多久、谁在监听、对方是否回应、自己何时启动）都按「继续等」处理。
 */
export function decideReclaim({
  lock, port, selfPid, selfAncestors, profileTag: ownProfileTag,
  isAlive: checkAlive, commandLine: readCommandLine,
  waitedMs, minWaitMs = MIN_WAIT_MS, listeners, holderResponsive, selfStartedAtMs,
}) {
  if (lock == null) return { action: 'wait', reason: 'no-lock' }
  if (lock.port !== port) return { action: 'wait', reason: 'port-mismatch' }
  if (!validPid(lock.pid)) return { action: 'wait', reason: 'invalid-pid' }
  if (lock.pid === selfPid) return { action: 'none', reason: 'self' }
  if (selfAncestors.includes(lock.pid)) return { action: 'wait', reason: 'ancestor' }
  try {
    if (!checkAlive(lock.pid)) return { action: 'wait', reason: 'stale-lock-dead-pid' }
    if (lock.profileTag !== ownProfileTag) return { action: 'wait', reason: 'foreign-profile' }
    if (!String(readCommandLine(lock.pid)).includes('DeepSeek Harness')) return { action: 'wait', reason: 'foreign-process' }
    if (!Number.isFinite(waitedMs) || waitedMs < minWaitMs) return { action: 'wait', reason: 'grace' }
    const pids = typeof listeners === 'function' ? listeners(port) : undefined
    if (!Array.isArray(pids) || !pids.includes(lock.pid)) return { action: 'wait', reason: 'not-listener' }
    const startedAt = Date.parse(lock.startedAt)
    if (!Number.isFinite(selfStartedAtMs) || !Number.isFinite(startedAt) || startedAt >= selfStartedAtMs) return { action: 'wait', reason: 'not-older' }
    if (holderResponsive !== false) return { action: 'wait', reason: holderResponsive === true ? 'responsive' : 'unprobed' }
  } catch (err) {
    if (err?.code === 'EPERM') return { action: 'wait', reason: 'permission-denied' }
    throw err
  }
  return { action: 'reclaim', reason: 'stale-hub-instance' }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** SIGTERM，等 termWaitMs，还活着才 SIGKILL。返回 { killed, signal }。 */
export async function terminate(pid, { kill = killProcess, isAlive: checkAlive = (target) => isAlive(target, { allowEperm: false }), termWaitMs = TERM_WAIT_MS } = {}) {
  if (!kill(pid, 'SIGTERM')) return { killed: false, signal: 'SIGTERM' }
  const deadline = Date.now() + termWaitMs
  while (Date.now() < deadline) {
    if (!checkAlive(pid)) return { killed: true, signal: 'SIGTERM' }
    await sleep(50)
  }
  if (!checkAlive(pid)) return { killed: true, signal: 'SIGTERM' }
  return { killed: kill(pid, 'SIGKILL') === true, signal: 'SIGKILL' }
}

export async function reclaimPort({
  lock, port, selfPid, selfAncestors, waitedMs, holderResponsive, selfStartedAtMs,
  isAlive: checkAlive = (pid) => isAlive(pid, { allowEperm: false }),
  commandLine: readCommandLine = commandLine,
  listeners = listenersOf,
  kill = killProcess,
  termWaitMs = TERM_WAIT_MS,
  minWaitMs = MIN_WAIT_MS,
}) {
  const { action, reason } = decideReclaim({
    lock, port, selfPid, selfAncestors, profileTag: profileTag(),
    isAlive: checkAlive, commandLine: readCommandLine,
    waitedMs, minWaitMs, listeners, holderResponsive, selfStartedAtMs,
  })
  if (action !== 'reclaim') return { killed: false, reason }
  const { killed, signal } = await terminate(lock.pid, { kill, isAlive: checkAlive, termWaitMs })
  return killed ? { killed: true, reason, signal } : { killed: false, reason: 'kill-failed' }
}
