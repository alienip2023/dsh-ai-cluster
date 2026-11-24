import { EventEmitter } from 'node:events'
import { NODE_TO_HUB, RemoteAgentError, validateBotDirectory, validateBotMessage, validateTeamAct, validateTeamActResult } from '../protocol.js'

/** How long a node waits for the hub to answer a team/act. */
export const TEAM_ACT_TIMEOUT_MS = 120_000

export const BOT_MESSAGE_REPLAY_MS = 60_000
const MAX_DEPTH = 3
/** ds-bot 以 nodeId:null 标记 hub 自有 Bot；节点侧校验要求非空 nodeId，故用此常量代位。 */
export const HUB_NODE_ID = 'hub'

// 不改动入参：返回新对象，仅把 nodeId 为 null/undefined 的对象条目映射到 HUB_NODE_ID。
function withHubStandIn(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.bots)) return data
  const bots = data.bots.map(bot => (bot && typeof bot === 'object' && !Array.isArray(bot) && bot.nodeId == null)
    ? { ...bot, nodeId: HUB_NODE_ID } : bot)
  return { ...data, bots }
}

/**
 * 节点 Bot 网络传输层。目录生成、目标路由及 Bot 身份选择由宿主负责。
 * send({ from, to, exchangeId, kind, text, depth }) 的 from 标识本机发送 Bot；
 * nodeId 必须匹配本连接，不能凭节点目录猜测多 Bot 节点上的发送者。
 * directory 事件载荷是 { bots, rooms, machines } 快照，可通过 on('directory', handler) 订阅。
 * identityOf(localBotId) 给出本机 Bot 的 identityId，send() 用它给 from 补上全局身份。
 */
export function createBotNetwork({ nodeId, send: sendRaw = () => false, sendHub, logger, identityOf } = {}) {
  const network = new EventEmitter()
  Object.defineProperty(network, 'nodeId', { value: nodeId, enumerable: true })
  const handlers = new Set()
  const teamActs = new Map()
  const seen = new Map()
  let bots = []
  let rooms = []
  let machines = []
  let disposed = false
  const snapshot = () => bots.map(bot => ({ ...bot }))
  const warn = code => logger?.warn?.('bot network frame dropped', { code })
  const exceedsDepth = payload => {
    if (!(payload?.depth > MAX_DEPTH)) return false
    logger?.warn?.('bot network frame dropped', {
      code: 'bot-message-depth-exceeded', exchangeId: payload.exchangeId,
      from: payload.from, to: payload.to,
    })
    return true
  }

  function cleanSeen() {
    const now = Date.now()
    for (const [id, expires] of seen) {
      if (expires <= now) seen.delete(id)
    }
  }
  const timer = setInterval(cleanSeen, BOT_MESSAGE_REPLAY_MS)
  timer.unref?.()

  // bot/assign always goes over the hub link: the hub delivers it, forwards it to the target node,
  // or bounces it back when that node is not connected.
  const stamp = from => {
    if (typeof identityOf !== 'function' || !from || typeof from !== 'object') return from
    const { identityId: _claimed, ...rest } = from
    // bot/assign names this node's Bots by their team-wide id (joined:<nodeId>:<local id>); the book is keyed by the local id.
    const prefix = `joined:${encodeURIComponent(nodeId)}:`
    const local = typeof rest.id === 'string' && rest.id.startsWith(prefix) ? decodeURIComponent(rest.id.slice(prefix.length)) : rest.id
    const own = typeof local === 'string' ? identityOf(local) : undefined
    return own === undefined ? rest : { ...rest, identityId: own }
  }
  network.directory = snapshot
  network.rooms = () => rooms.map(room => ({ ...room }))
  network.machines = () => machines.map(machine => ({ ...machine }))
  network.send = input => {
    if (disposed) return false
    if (exceedsDepth(input)) return false
    // The sender's portable id comes from this node's identity book, never from the host's word.
    const payload = validateBotMessage({ ...input, from: stamp(input?.from), depth: input?.depth === undefined ? 0 : input.depth })
    if (payload.from.nodeId !== nodeId) {
      throw new RemoteAgentError('bot/message sender must belong to this node', 'bot-message-invalid')
    }
    try { return sendRaw(NODE_TO_HUB.BOT_MESSAGE, payload) === true } catch { return false }
  }
  // Ask the hub to run a team-management tool for one of this node's Bots. Resolves { ok, text };
  // { ok: false } when the hub link is down or the hub does not answer in time.
  network.teamAct = input => new Promise(resolve => {
    if (disposed) { resolve({ ok: false, text: 'The Bot network is closed.' }); return }
    const payload = validateTeamAct({ ...input, actor: stamp(input?.actor) })
    if (payload.actor.nodeId !== nodeId) throw new RemoteAgentError('team/act actor must belong to this node', 'team-act-invalid')
    const timer = setTimeout(() => { teamActs.delete(payload.requestId); resolve({ ok: false, text: 'The hub did not answer in time.' }) }, TEAM_ACT_TIMEOUT_MS)
    timer.unref?.()
    teamActs.set(payload.requestId, { resolve, timer })
    let sent = false
    try { sent = (sendHub ?? sendRaw)(NODE_TO_HUB.TEAM_ACT, payload) === true } catch { sent = false }
    if (!sent) { clearTimeout(timer); teamActs.delete(payload.requestId); resolve({ ok: false, text: 'The hub is not connected.' }) }
  })
  network.receiveTeamActResult = data => {
    let result
    try { result = validateTeamActResult(data) } catch (err) { warn(err.code); return }
    const waiting = teamActs.get(result.requestId)
    if (!waiting) return
    teamActs.delete(result.requestId)
    clearTimeout(waiting.timer)
    waiting.resolve({ ok: result.ok, text: result.text })
  }
  network.onMessage = handler => {
    if (typeof handler !== 'function') throw new TypeError('bot message handler must be a function')
    if (disposed) return () => {}
    handlers.add(handler)
    return () => { handlers.delete(handler) }
  }
  network.receiveDirectory = data => {
    if (disposed) return
    const incoming = withHubStandIn(data)
    if (Array.isArray(data?.bots) && data.bots.some(bot => bot?.nodeId === HUB_NODE_ID)) warn('bot-directory-node-id-hub')
    try { ({ bots, rooms, machines = [] } = validateBotDirectory(incoming)) } catch (err) { warn(err.code); return }
    network.emit('directory', { bots: snapshot(), rooms: network.rooms(), machines: network.machines() })
  }
  network.receiveMessage = async data => {
    if (disposed) return
    if (exceedsDepth(data)) return
    let payload
    try { payload = validateBotMessage(data) } catch (err) { warn(err.code); return }
    if (payload.to.nodeId !== nodeId) { warn('bot-message-node-mismatch'); return }
    cleanSeen()
    const replayKey = JSON.stringify([payload.exchangeId, payload.kind])
    if (seen.has(replayKey)) return
    // ask/reply 分别在首个 await 之前登记，阻止在途及已完成消息的重放。
    seen.set(replayKey, Date.now() + BOT_MESSAGE_REPLAY_MS)
    for (const handler of [...handlers]) {
      if (disposed) break
      try {
        // 每个 handler 拿独立副本，不能改写后续 handler 或自动回复的署名。
        const text = await handler(validateBotMessage(payload))
        if (payload.kind === 'ask' && typeof text === 'string') {
          network.send({ ...payload, kind: 'reply', from: payload.to, to: payload.from,
            text: text.slice(0, 65536), depth: payload.depth + 1 })
        }
      } catch { /* 单个 handler 失败时不回复，也不阻止其他订阅者。 */ }
    }
  }
  network.dispose = () => {
    disposed = true
    clearInterval(timer)
    seen.clear()
    handlers.clear()
    for (const { resolve, timer } of teamActs.values()) { clearTimeout(timer); resolve({ ok: false, text: 'The Bot network is closed.' }) }
    teamActs.clear()
    bots = []
    rooms = []
    machines = []
    network.removeAllListeners()
  }
  return network
}
