#!/usr/bin/env node
// Cluster test bench: one hub and N stations, each a real DSH (the desktop app's CLI) with its own
// DSH_HOME, web port, AC state dir and Bot state dir, all on this machine, sharing ds-bot's mock model.
// Nothing touches ~/.dsh or the desktop app's data.
//
//   node dev/cluster-bench.mjs start [--stations 2] [--name c1] [--base-port 18700]
//   node dev/cluster-bench.mjs status [--name c1]
//   node dev/cluster-bench.mjs stop   [--name c1]
//
// Env: DSH_CLI (default: the DeepSeek Harness app's CLI), DS_BOT_DIR (default: ../../projects/ds-bot/ds-bot,
// or REMOTE ds-bot checkout), DSH_BENCH_ROOT (default: <tmpdir>/dsh-cluster-bench).
// Ports from base: hub web base+0, hub listen base+1, mock base+2, station i web base+10+i.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const AC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

export function parseArgs(argv) {
  const out = { cmd: argv[0] ?? 'status', stations: 2, name: 'c1', basePort: 18700 }
  for (let i = 1; i < argv.length; i += 1) {
    const [k, v] = [argv[i], argv[i + 1]]
    if (k === '--stations') { out.stations = Number(v); i += 1 }
    else if (k === '--name') { out.name = v; i += 1 }
    else if (k === '--base-port') { out.basePort = Number(v); i += 1 }
  }
  if (!/^[a-z0-9-]{1,32}$/.test(out.name)) throw new Error('--name must match [a-z0-9-]{1,32}')
  if (!Number.isInteger(out.stations) || out.stations < 0 || out.stations > 8) throw new Error('--stations must be 0..8')
  if (!Number.isInteger(out.basePort) || out.basePort < 1024 || out.basePort > 65000) throw new Error('--base-port out of range')
  return out
}

/** The plan for one bench: every instance, its dirs, ports and AC config. Pure, so it can be tested. */
export function planBench({ name, stations, basePort, root, dsBotDir, acDir = AC_DIR, token }) {
  const dir = join(root, name)
  const mockPort = basePort + 2
  const hubListen = basePort + 1
  const hub = {
    id: 'hub', role: 'hub', home: join(dir, 'hub'), webPort: basePort,
    ac: { role: 'hub', nodeToken: token, listenHost: '127.0.0.1', listenPort: hubListen, stateDir: join(dir, 'hub', 'ac-state') },
  }
  const list = [hub]
  for (let i = 1; i <= stations; i += 1) {
    const id = `station-${i}`
    const home = join(dir, id)
    list.push({
      id, role: 'worker', home, webPort: basePort + 10 + i,
      ac: {
        role: 'worker', nodeId: `${name}-${id}`, transportMode: 'direct',
        hubUrl: `ws://127.0.0.1:${hubListen}/api/remote-agent/node`, token,
        stateDir: join(home, 'ac-state'), roots: [join(home, 'work')], listenPort: 0,
      },
    })
  }
  for (const inst of list) {
    inst.botsDir = join(inst.home, 'bots')
    inst.profile = join(inst.home, 'profiles', 'web')
    inst.env = {
      DSH_HOME: inst.home,
      DSH_BOTS_DIR: inst.botsDir,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      DEEPSEEK_API_KEY: 'mock-key',
      // Every node runs on this machine, so a loopback model gateway is reachable.
      DS_BOT_GATEWAY_LOOPBACK: '1',
      DS_BOT_GATEWAY_PORT: '0',
    }
    inst.packageJson = {
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'ds-bot': `link:${dsBotDir}`, 'dsh-ai-cluster': `link:${acDir}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot', 'dsh-ai-cluster'] } },
    }
    // The AC row, layered over the package's own patch (id remote-agent).
    inst.patch = acPatch(inst.ac, inst.role)
  }
  return { dir, mockPort, hubListen, instances: list }
}

/** A cordis patch (YAML) that configures AC for one instance. JSON is valid YAML for these values. */
export function acPatch(ac, role) {
  const inject = role === 'worker' ? '[]' : "['webServer', 'tools', 'systemPrompt']"
  const lines = ['- id: remote-agent', `  inject: ${inject}`, '  config:']
  for (const [key, value] of Object.entries(ac)) lines.push(`    ${key}: ${JSON.stringify(value)}`)
  return `${lines.join('\n')}\n`
}

function findDsBot() {
  const candidates = [process.env.DS_BOT_DIR, resolve(AC_DIR, '../../projects/ds-bot/ds-bot'), resolve(AC_DIR, '../ds-bot/ds-bot')]
  return candidates.filter(Boolean).find(dir => existsSync(join(dir, 'index.js')) && existsSync(join(dir, 'dev', 'mock-llm.mjs')))
}

const pidFile = (inst, what) => join(inst.home ?? inst, `${what}.pid`)
// pid 0 would signal our own process group and always "succeed".
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch { return false } }
const readPid = (file) => { try { return Number(readFileSync(file, 'utf8')) } catch { return 0 } }

function launch(cmd, args, { env, cwd, log, pid }) {
  const out = openSync(log, 'a')
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, stdio: ['ignore', out, out], detached: true })
  writeFileSync(pid, String(child.pid))
  child.unref()
  return child.pid
}

async function waitFor(check, ms, step = 500) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(r => setTimeout(r, step))
  }
  return undefined
}

function prepare(inst) {
  mkdirSync(inst.profile, { recursive: true })
  mkdirSync(inst.botsDir, { recursive: true })
  for (const root of inst.ac.roots ?? []) mkdirSync(root, { recursive: true })
  const pkgPath = join(inst.profile, 'package.json')
  const pkg = JSON.stringify(inst.packageJson, null, 2)
  const fresh = !existsSync(pkgPath) || readFileSync(pkgPath, 'utf8') !== pkg
  writeFileSync(pkgPath, pkg)
  writeFileSync(join(inst.profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(inst.home, 'bench.patch.yml'), inst.patch)
  if (fresh || !existsSync(join(inst.profile, 'node_modules', 'ds-bot'))) {
    const r = spawnSync('pnpm', ['install', '--silent'], { cwd: inst.profile, env: { ...process.env, DSH_HOME: inst.home }, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`pnpm install failed for ${inst.id}: ${r.stderr || r.stdout}`)
  }
}

async function start(opts) {
  const dsBotDir = findDsBot()
  if (!dsBotDir) throw new Error('ds-bot checkout not found; set DS_BOT_DIR')
  const cli = process.env.DSH_CLI ?? APP_CLI
  if (!existsSync(cli)) throw new Error(`DSH CLI not found at ${cli}; set DSH_CLI`)
  const root = process.env.DSH_BENCH_ROOT ?? join(tmpdir(), 'dsh-cluster-bench')
  const tokenFile = join(root, opts.name, 'token')
  mkdirSync(join(root, opts.name), { recursive: true })
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : randomBytes(18).toString('base64url')
  writeFileSync(tokenFile, token, { mode: 0o600 })
  const plan = planBench({ ...opts, root, dsBotDir, token })
  writeFileSync(join(plan.dir, 'plan.json'), JSON.stringify({ ...plan, instances: plan.instances.map(({ packageJson, ...rest }) => ({ ...rest, ac: { ...rest.ac, token: rest.ac.token ? '***' : undefined, nodeToken: rest.ac.nodeToken ? '***' : undefined } })) }, null, 2))

  const mockPid = pidFile(plan.dir, 'mock')
  if (!alive(readPid(mockPid))) {
    launch(process.execPath, [join(dsBotDir, 'dev', 'mock-llm.mjs'), plan.dir], {
      env: { MOCK_PORT: String(plan.mockPort), MOCK_DELAY_MS: '100', MOCK_LOG: join(plan.dir, 'mock.jsonl') },
      cwd: dsBotDir, log: join(plan.dir, 'mock.out'), pid: mockPid,
    })
  }
  for (const inst of plan.instances) {
    prepare(inst)
    const pid = pidFile(inst, 'web')
    if (alive(readPid(pid))) continue
    const log = join(inst.home, 'web.log')
    rmSync(log, { force: true })
    launch(cli, ['--profile', 'web', '--patch', join(inst.home, 'bench.patch.yml'), '--no-open', '--port', String(inst.webPort)], {
      env: inst.env, cwd: inst.home, log, pid,
    })
    const ready = await waitFor(() => existsSync(log) && /dsh web: http/.test(readFileSync(log, 'utf8')), 120_000)
    if (!ready) throw new Error(`${inst.id} did not start; see ${log}`)
    console.log(`${inst.id}: up on web ${inst.webPort}${inst.role === 'hub' ? `, nodes dial ${plan.hubListen}` : ''}`)
  }
  await report(plan)
  return plan
}

/** Start one instance of a running bench again (after it was killed), and wait for its web server. */
export async function restartInstance(plan, id) {
  const inst = plan.instances.find(item => item.id === id)
  if (!inst) throw new Error(`no instance ${id}`)
  const real = JSON.parse(readFileSync(join(plan.dir, 'plan.json'), 'utf8')).instances.find(item => item.id === id)
  const cli = process.env.DSH_CLI ?? APP_CLI
  const log = join(inst.home, 'web.log')
  rmSync(log, { force: true })
  launch(cli, ['--profile', 'web', '--patch', join(inst.home, 'bench.patch.yml'), '--no-open', '--port', String(inst.webPort)], {
    env: real.env, cwd: inst.home, log, pid: pidFile(inst, 'web'),
  })
  const ready = await waitFor(() => existsSync(log) && /dsh web: http/.test(readFileSync(log, 'utf8')), 120_000)
  if (!ready) throw new Error(`${id} did not start again; see ${log}`)
}

/** A logged-in client for an instance's own web API: DSH prints a one-time token URL; trading it gives a cookie. */
export async function webClient(inst) {
  const log = readFileSync(join(inst.home, 'web.log'), 'utf8')
  const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(log)?.[1]
  if (!token) throw new Error(`${inst.id}: no login token in web.log yet`)
  const origin = `http://127.0.0.1:${inst.webPort}`
  const login = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })
  const cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error(`${inst.id}: login gave no session cookie (${login.status})`)
  const call = async (path, init = {}) => {
    const res = await fetch(origin + path, { ...init, headers: { cookie, origin, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } })
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return { status: res.status, body }
  }
  return { origin, call }
}

/** The stations the hub reports online (its panel API). */
export async function hubOnline(plan) {
  const client = await webClient(plan.instances[0])
  const { status, body } = await client.call('/api/remote-agent/ui/nodes')
  if (status !== 200) throw new Error(`hub nodes API answered ${status}`)
  return (body?.nodes ?? []).filter(node => node.online === true)
}

async function report(plan) {
  const want = plan.instances.slice(1).map(s => s.ac.nodeId)
  const online = await waitFor(async () => {
    try {
      const nodes = await hubOnline(plan)
      return want.every(id => nodes.some(n => n.nodeId === id)) ? nodes : undefined
    } catch { return undefined }
  }, 60_000, 1000) ?? await hubOnline(plan).catch(() => [])
  for (const id of want) {
    const node = online.find(n => n.nodeId === id)
    console.log(`  ${node ? '✓' : '✗'} ${id} ${node ? `online (caps: ${node.caps?.length ?? 0})` : 'not online at the hub'}`)
  }
  console.log(`bench dir: ${plan.dir}`)
  return online
}

function stop(opts) {
  const root = process.env.DSH_BENCH_ROOT ?? join(tmpdir(), 'dsh-cluster-bench')
  const dir = join(root, opts.name)
  if (!existsSync(dir)) { console.log('no bench'); return }
  const files = [join(dir, 'mock.pid')]
  for (const name of ['hub', ...Array.from({ length: 8 }, (_, i) => `station-${i + 1}`)]) files.push(join(dir, name, 'web.pid'))
  for (const file of files) {
    const pid = readPid(file)
    if (pid && alive(pid)) { try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } } }
    rmSync(file, { force: true })
  }
  console.log(`stopped bench ${opts.name}`)
}

function status(opts) {
  const root = process.env.DSH_BENCH_ROOT ?? join(tmpdir(), 'dsh-cluster-bench')
  const dir = join(root, opts.name)
  for (const name of ['mock', 'hub', ...Array.from({ length: 8 }, (_, i) => `station-${i + 1}`)]) {
    const file = name === 'mock' ? join(dir, 'mock.pid') : join(dir, name, 'web.pid')
    if (!existsSync(file)) continue
    const pid = readPid(file)
    console.log(`${name}: ${alive(pid) ? `running (pid ${pid})` : 'stopped'}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2))
  try {
    if (opts.cmd === 'start') await start(opts)
    else if (opts.cmd === 'stop') stop(opts)
    else status(opts)
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}
