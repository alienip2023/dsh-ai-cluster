#!/usr/bin/env node
// dsh-node-daemon — keep this machine's DSH (with the AC and ds-bot plugins) running.
//
//   dsh-node-daemon start [--config <file>]   supervise DSH in the foreground
//   dsh-node-daemon stop | status
//
// The command it supervises comes from the config file (~/.dsh/daemon-config.json:
// { command, args, cwd, env }) or, when absent, from detectDshCommand(). Autostart at
// login per platform is installed by the AC panel (ARCHITECTURE.md §10).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSupervisor } from '../lib/daemon/supervisor.js'
import { detectDshCommand } from '../lib/daemon/detect.js'

const DSH_DIR = join(homedir(), '.dsh')
const PID_FILE = join(DSH_DIR, 'daemon.pid')
const LOG_FILE = join(DSH_DIR, 'daemon.log')
const CONFIG_FILE = join(DSH_DIR, 'daemon-config.json')

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`
  process.stderr.write(line)
  try { mkdirSync(DSH_DIR, { recursive: true }); appendFileSync(LOG_FILE, line) } catch { /* logging must not stop the daemon */ }
}

function loadConfig(path) {
  const file = path ?? (existsSync(CONFIG_FILE) ? CONFIG_FILE : undefined)
  if (!file) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (err) { log(`config ${file} unreadable: ${err.message}`); return {} }
}

const readPid = () => { try { return Number.parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10) } catch { return undefined } }
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch { return false } }

async function start(argv) {
  const i = argv.indexOf('--config')
  const config = loadConfig(i !== -1 ? argv[i + 1] : undefined)
  const running = readPid()
  if (alive(running) && running !== process.pid) { console.error(`dsh-node-daemon already running (pid ${running})`); process.exitCode = 1; return }
  const target = config.command ? { command: config.command, args: config.args ?? [] } : detectDshCommand()
  if (!target) {
    console.error(`No DSH to start: install DeepSeek Harness, or set "command" in ${CONFIG_FILE}.`)
    process.exitCode = 1
    return
  }
  mkdirSync(DSH_DIR, { recursive: true })
  writeFileSync(PID_FILE, String(process.pid), 'utf8')
  const supervisor = createSupervisor({ ...target, cwd: config.cwd ?? homedir(), env: { ...process.env, ...config.env }, log })
  const shutdown = async (signal) => {
    log(`received ${signal}, stopping`)
    await supervisor.stop()
    try { if (readPid() === process.pid) rmSync(PID_FILE) } catch { /* already gone */ }
    process.exit(0)
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void shutdown(signal))
  log(`daemon ${process.pid} supervising ${target.command} ${target.args.join(' ')}`)
  supervisor.start()
}

function stop() {
  const pid = readPid()
  if (!alive(pid)) { console.log('dsh-node-daemon is not running'); return }
  process.kill(pid, 'SIGTERM')
  console.log(`stopping dsh-node-daemon (pid ${pid})`)
}

function status() {
  const pid = readPid()
  console.log(alive(pid) ? `dsh-node-daemon is running (pid ${pid})` : 'dsh-node-daemon is not running')
}

const [,, cmd, ...rest] = process.argv
if (cmd === 'start') await start(rest)
else if (cmd === 'stop') stop()
else if (cmd === 'status') status()
else { console.log('Usage: dsh-node-daemon <start|stop|status> [--config <file>]'); process.exitCode = 1 }
