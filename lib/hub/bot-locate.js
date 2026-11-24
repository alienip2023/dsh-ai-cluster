// Hub side of bot/locate: where is a Bot running right now, proven by the Bot's own key.
//
// The hub asks every online node that announces bot-locate/1. Each node gets its own
// requestId, so an answer counts only from the node it was sent to: a node cannot replay
// another node's signed answer as its own. A "found" answer is accepted only when
//   1. the public key derives the asked-for Bot id (the id is self-certifying), and
//   2. the signature over that node's requestId verifies with that key.
// Anything else is reported as rejected, never as a location.
import { randomUUID } from 'node:crypto'
import { BotIdentity, BOT_IDENTITY_ID_RE, deriveBotId } from '../identity/bot-identity.js'
import { BOT_LOCATE_CAP, HUB_TO_NODE } from '../protocol.js'

export const LOCATE_TIMEOUT_MS = 5_000

/** Nodes that are online and announce bot-locate/1, and the online ones that do not. */
function candidates(registry) {
  const asked = []
  const unsupported = []
  for (const record of registry.nodes?.values?.() ?? []) {
    if (record?.online !== true || typeof record.nodeId !== 'string') continue
    const caps = Array.isArray(record.hello?.caps) ? record.hello.caps : []
    ;(caps.includes(BOT_LOCATE_CAP) ? asked : unsupported).push(record.nodeId)
  }
  return { asked, unsupported }
}

/** Check one answer against what was asked; returns a location or a rejection reason. */
export function verifyLocateAnswer({ botId, requestId, answer }) {
  if (answer?.found !== true) return { found: false }
  if (deriveBotId(answer.pubKeyB64) !== botId) return { rejected: 'key-does-not-match-bot' }
  if (!BotIdentity.verify(answer.pubKeyB64, requestId, answer.sig)) return { rejected: 'bad-signature' }
  return { found: true, machineId: answer.machineId ?? '' }
}

/**
 * @returns {Promise<{ botId: string, locations: {nodeId:string, machineId:string}[],
 *   notHere: string[], silent: string[], unsupported: string[], unsent: string[],
 *   rejected: {nodeId:string, reason:string}[], error?: string }>}
 */
export function locateBot(registry, botId, { timeoutMs = LOCATE_TIMEOUT_MS } = {}) {
  const id = typeof botId === 'string' ? botId.trim() : ''
  const empty = { botId: id, locations: [], notHere: [], silent: [], unsupported: [], unsent: [], rejected: [] }
  if (!BOT_IDENTITY_ID_RE.test(id)) return Promise.resolve({ ...empty, error: 'bad-bot-id' })
  if (!registry || typeof registry.send !== 'function' || typeof registry.on !== 'function') {
    return Promise.resolve({ ...empty, error: 'no-registry' })
  }
  const { asked, unsupported } = candidates(registry)
  const result = { ...empty, unsupported }
  const pending = new Map() // requestId → nodeId
  return new Promise((resolve) => {
    let timer
    // An answer can arrive while requests are still going out; never settle before all are sent.
    let sending = true
    const finish = () => {
      clearTimeout(timer)
      registry.off?.('botLocateResult', onResult)
      result.silent = [...pending.values()]
      resolve(result)
    }
    const onResult = (answer) => {
      const nodeId = pending.get(answer?.requestId)
      if (nodeId === undefined) return
      // The answer must come over the connection the request went to.
      if (answer.nodeId !== nodeId) { result.rejected.push({ nodeId: answer.nodeId ?? '', reason: 'wrong-node' }); return }
      pending.delete(answer.requestId)
      if (answer.ok === false && answer.found === undefined) result.rejected.push({ nodeId, reason: answer.error ?? 'invalid' })
      else if (answer.botId !== id) result.rejected.push({ nodeId, reason: 'wrong-bot' })
      else {
        const checked = verifyLocateAnswer({ botId: id, requestId: answer.requestId, answer })
        if (checked.found) result.locations.push({ nodeId, machineId: checked.machineId })
        else if (checked.rejected) result.rejected.push({ nodeId, reason: checked.rejected })
        else result.notHere.push(nodeId)
      }
      if (pending.size === 0 && !sending) finish()
    }
    registry.on('botLocateResult', onResult)
    for (const nodeId of asked) {
      const requestId = randomUUID()
      pending.set(requestId, nodeId)
      let sent
      try { sent = registry.send(nodeId, HUB_TO_NODE.BOT_LOCATE, { botId: id, requestId, nodeId }) } catch { sent = false }
      if (sent === false) { pending.delete(requestId); result.unsent.push(nodeId) }
    }
    sending = false
    if (pending.size === 0) { finish(); return }
    timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
  })
}
