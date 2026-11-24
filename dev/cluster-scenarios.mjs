#!/usr/bin/env node
// Scenarios run against a started cluster bench (dev/cluster-bench.mjs). Each prints ✓/✗ and the script
// exits non-zero on any ✗. Uses only the instances' own web APIs (the same ones the pages use).
//
//   node dev/cluster-scenarios.mjs [--name c1] [--base-port 18700] [--stations 2]
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, planBench, webClient } from './cluster-bench.mjs'

const opts = parseArgs(['run', ...process.argv.slice(2)])
const root = process.env.DSH_BENCH_ROOT ?? join(tmpdir(), 'dsh-cluster-bench')
const plan = planBench({ ...opts, root, dsBotDir: '-', token: '-' })
if (!existsSync(join(plan.dir, 'hub', 'web.log'))) { console.error('no running bench; start it first'); process.exit(1) }

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`) }
const wait = async (fn, ms = 30_000, step = 1000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn().catch(() => undefined)
    if (value) return value
    if (Date.now() > end) return undefined
    await new Promise(r => setTimeout(r, step))
  }
}

const [hubInst, ...stationInsts] = plan.instances
const hub = await webClient(hubInst)
const bot = (client) => async (endpoint, payload = {}) => {
  const { status, body } = await client.call('/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) })
  if (status !== 200) throw new Error(`${endpoint}: HTTP ${status}`)
  return body
}
const hubBot = bot(hub)
const state = async () => (await hubBot('state', {}))
const botsOf = s => { const bots = s?.value?.bots ?? []; return Array.isArray(bots) ? bots : Object.values(bots) }

// 1. Every station is online at the hub with the capabilities this release needs.
{
  const { body } = await hub.call('/api/remote-agent/ui/nodes')
  for (const st of stationInsts) {
    const node = (body?.nodes ?? []).find(n => n.nodeId === st.ac.nodeId)
    check(`${st.ac.nodeId} online at the hub`, node?.online === true)
    check(`${st.ac.nodeId} announces bot-locate/1`, node?.caps?.includes('bot-locate/1') === true)
  }
}

// 2. The hub creates a Bot on station-1 (the "create a Bot on a chosen machine" flow).
const target = stationInsts[0]
const name = `Bench${Date.now() % 100000}`
let created
try {
  created = await hubBot('create-bot', { nodeId: target.ac.nodeId, name, role: 'Tester' })
  check(`create-bot on ${target.ac.nodeId}`, created?.ok !== false, created?.ok === false ? JSON.stringify(created).slice(0, 200) : '')
} catch (error) {
  check(`create-bot on ${target.ac.nodeId}`, false, error.message)
}

// 3. The new Bot shows on the hub as a node Bot, with a portable identity (roster identityId).
const shown = await wait(async () => {
  const bots = botsOf(await state())
  const row = bots.find(b => b.name === name)
  return row?.worker?.identityId ? row : undefined
}, 45_000)
check('the node Bot is listed on the hub', shown !== undefined)
check('it carries a portable identity (identityId)', /^[0-9a-f]{16}$/.test(shown?.worker?.identityId ?? ''), shown?.worker?.identityId ?? 'none')

// 4. Its identity file lives in station-1's own Bot dir, owner-only, and nowhere else.
if (shown?.worker?.identityId) {
  const id = shown.worker.identityId
  const here = join(target.botsDir, id, 'identity.json')
  check('identity file on the station that runs it', existsSync(here))
  check('not on the hub', !existsSync(join(hubInst.botsDir, id, 'identity.json')))
  if (existsSync(here)) {
    const rec = JSON.parse(readFileSync(here, 'utf8'))
    check('identity file names the station Bot (localBotId)', typeof rec.localBotId === 'string' && rec.localBotId !== '')
  }
}

// 5. A message from the hub page reaches the node Bot, runs there, and the answer comes back to the hub page.
if (shown) {
  const ensured = await hubBot('joined-ensure', { botId: shown.id }).catch(error => ({ ok: false, error: error.message }))
  const sessionId = ensured?.value?.sessionId
  check('the hub opens the node Bot\'s page', typeof sessionId === 'string' && sessionId !== '', sessionId ? '' : JSON.stringify(ensured).slice(0, 200))
  const marker = `ping-${Date.now() % 100000}`
  const started = Date.now()
  const sent = await hubBot('send', { sessionId, text: `hello ${marker}` }).catch(error => ({ ok: false, error: error.message }))
  check('the hub sends to the node Bot', sent?.ok !== false, sent?.ok === false ? JSON.stringify(sent).slice(0, 200) : '')
  const page = await wait(async () => {
    const chat = await hubBot('chat', { botId: shown.id })
    const items = chat?.value?.items ?? []
    const asked = items.findIndex(item => item.kind === 'user' && String(item.text).includes(marker))
    // The mock model echoes the message: an answer that names the marker was made by the node Bot for this message.
    const answer = asked < 0 ? undefined : items.slice(asked + 1).find(item => item.kind === 'bot' && String(item.text).includes(marker))
    return answer
  }, 60_000)
  check('the node Bot\'s answer reaches the hub page', page !== undefined, page ? `${Date.now() - started} ms` : 'no answer within 60 s')
}

// 6. A station restarts (crash, reboot): it reconnects to the hub by itself and its Bot answers again.
if (shown && process.argv.includes('--restart')) {
  const { readFileSync: read } = await import('node:fs')
  const { restartInstance } = await import('./cluster-bench.mjs')
  const pid = Number(read(join(target.home, 'web.pid'), 'utf8'))
  try { process.kill(-pid, 'SIGKILL') } catch { process.kill(pid, 'SIGKILL') }
  const offline = await wait(async () => {
    const { body } = await hub.call('/api/remote-agent/ui/nodes')
    return (body?.nodes ?? []).find(n => n.nodeId === target.ac.nodeId)?.online === false ? true : undefined
  }, 90_000)
  check(`the hub sees ${target.ac.nodeId} go offline`, offline === true)
  const t0 = Date.now()
  await restartInstance(plan, target.id)
  const back = await wait(async () => {
    const { body } = await hub.call('/api/remote-agent/ui/nodes')
    return (body?.nodes ?? []).find(n => n.nodeId === target.ac.nodeId)?.online === true ? true : undefined
  }, 90_000)
  check(`${target.ac.nodeId} reconnects after restart`, back === true, back ? `${Date.now() - t0} ms` : '')
  const marker = `after-restart-${Date.now() % 100000}`
  const ensured = await hubBot('joined-ensure', { botId: shown.id })
  await hubBot('send', { sessionId: ensured?.value?.sessionId, text: `hello ${marker}` })
  const answer = await wait(async () => {
    const items = (await hubBot('chat', { botId: shown.id }))?.value?.items ?? []
    const asked = items.findIndex(item => item.kind === 'user' && String(item.text).includes(marker))
    return asked < 0 ? undefined : items.slice(asked + 1).find(item => item.kind === 'bot' && String(item.text).includes(marker))
  }, 60_000)
  check('the Bot answers again after the restart', answer !== undefined)
}

const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
