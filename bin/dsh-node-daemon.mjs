#!/usr/bin/env node
// dsh-node-daemon.mjs — watchdog process for dsh node.
//
// Keeps the dsh node process alive: forks it as a child, restarts on exit
// with exponential backoff (1s → 2s → 4s → … → 60s max).
//
// Usage:
//   dsh-node-daemon start [--config path/to/config.json]
//   dsh-node-daemon stop
//   dsh-node-daemon status
//   dsh-node-daemon install   # register as launchd/systemd service

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DSH_DIR = join(homedir(), '.dsh')
const PID_FILE = join(DSH_DIR, 'daemon.pid')
const LOG_FILE = join(DSH_DIR, 'daemon.log')
const CONFIG_FILE = join(DSH_DIR, 'daemon-config.json')

const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000, 60000]

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`
  process.stderr.write(line)
  try {
    mkdirSync(DSH_DIR, { recursive: true })
    const { appendFileSync } = await import('node:fs').catch(() => ({ appendFileSync: null }))
    appendFileSync?.(LOG_FILE, line)
  } catch {}
}

function loadConfig(configPath) {
  const path = configPath ?? (existsSync(CONFIG_FILE) ? CONFIG_FILE : null)
  if (!path) return {}
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

function writePid(pid) {
  mkdirSync(DSH_DIR, { recursive: true })
  writeFileSync(PID_FILE, String(pid), 'utf8')
}

function readPid() {
  try { return parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10) } catch { return null }
}

function isRunning(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

// ── commands ──────────────────────────────────────────────────────────────────

async function cmdStatus() {
  const pid = readPid()
  if (isRunning(pid)) {
    console.log(`dsh node daemon is running (pid ${pid})`)
  } else {
    console.log('dsh node daemon is not running')
  }
}

async function cmdStop() {
  const pid = readPid()
  if (!isRunning(pid)) { console.log('daemon is not running'); return }
  try { process.kill(pid, 'SIGTERM'); console.log(`sent SIGTERM to ${pid}`) } catch (err) {
    console.error(`failed to stop daemon: ${err.message}`)
  }
}

async function cmdInstall() {
  const plat = platform()
  const daemonScript = resolve(__dirname, 'dsh-node-daemon.mjs')
  if (plat === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.node-daemon</string>
  <key>ProgramArguments</key>
  <array><string>node</string><string>${daemonScript}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict>
</plist>`
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.dsh.node-daemon.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, plist, 'utf8')
    console.log(`launchd plist written to ${plistPath}`)
    console.log('Run: launchctl load ' + plistPath)
  } else if (plat === 'linux') {
    const unit = `[Unit]
Description=DSH Node Daemon
After=network.target

[Service]
Type=simple
ExecStart=node ${daemonScript} start
Restart=always
RestartSec=5
User=${process.env.USER || 'root'}

[Install]
WantedBy=multi-user.target`
    const unitPath = `/etc/systemd/system/dsh-node.service`
    console.log(`systemd unit (write to ${unitPath}):\n`)
    console.log(unit)
    console.log('\nThen run: systemctl enable --now dsh-node')
  } else {
    console.log('Auto-install not supported on this platform. Run the daemon manually.')
  }
}

async function cmdStart(argv) {
  const configPath = (() => {
    const i = argv.indexOf('--config')
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null
  })()

  const config = loadConfig(configPath)

  // The command to run — default: the dsh node entrypoint
  const nodeCmd = config.command ?? 'dsh'
  const nodeArgs = config.args ?? ['node', 'start']
  const nodeCwd = config.cwd ?? homedir()
  const nodeEnv = { ...process.env, ...config.env }

  writePid(process.pid)
  log(`daemon started (pid ${process.pid}), managing: ${nodeCmd} ${nodeArgs.join(' ')}`)

  let attempt = 0
  let stopping = false

  process.on('SIGTERM', () => { stopping = true; log('daemon received SIGTERM, shutting down'); process.exit(0) })
  process.on('SIGINT', () => { stopping = true; log('daemon received SIGINT, shutting down'); process.exit(0) })

  const run = () => {
    if (stopping) return
    log(`starting node process (attempt ${attempt + 1})`)
    const child = spawn(nodeCmd, nodeArgs, {
      cwd: nodeCwd,
      env: nodeEnv,
      stdio: 'inherit',
    })

    child.on('exit', (code, signal) => {
      if (stopping) return
      const delay = BACKOFF_DELAYS[Math.min(attempt, BACKOFF_DELAYS.length - 1)]
      log(`node process exited (code=${code ?? signal}), restarting in ${delay}ms`)
      attempt += 1
      setTimeout(run, delay).unref()
    })

    child.on('error', (err) => {
      if (stopping) return
      const delay = BACKOFF_DELAYS[Math.min(attempt, BACKOFF_DELAYS.length - 1)]
      log(`node process error: ${err.message}, restarting in ${delay}ms`)
      attempt += 1
      setTimeout(run, delay).unref()
    })
  }

  run()
}

// ── entry point ───────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv
switch (cmd) {
  case 'start':  await cmdStart(rest); break
  case 'stop':   await cmdStop(); break
  case 'status': await cmdStatus(); break
  case 'install': await cmdInstall(); break
  default:
    console.log('Usage: dsh-node-daemon <start|stop|status|install> [--config path]')
    process.exit(1)
}
