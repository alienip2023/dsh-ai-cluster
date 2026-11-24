import { HUB_TO_NODE, RemoteAgentError, validateBotDirectory, validateBotMessage, validateTeamActResult } from '../protocol.js'

/** hub 只转交宿主，不在传输层生成目录或决定 Bot 路由。 */
export function createHubBotNetwork({ registry, ctx, log = () => {} }) {
  let disposed = false
  async function onMessage(payload) {
    if (disposed) return
    try {
      // 每次到达时查找，允许 ds-bot 在 remote-agent 之后加载。
      const handler = ctx?.get?.('remote-agent:bot-message', false)
      if (typeof handler !== 'function') {
        log('debug', 'bot/message dropped: no host handler', { nodeId: payload.from.nodeId })
        return
      }
      await handler(payload)
    } catch {
      log('debug', 'bot/message host handler failed', { nodeId: payload.from.nodeId })
    }
  }
  registry.on('botMessage', onMessage)
  return {
    sendDirectory(nodeId, bots, rooms = []) {
      if (disposed) return false
      const payload = validateBotDirectory({ bots, rooms, at: Date.now() })
      return registry.send(nodeId, HUB_TO_NODE.BOT_DIRECTORY, payload)
    },
    sendMessage(nodeId, data) {
      if (disposed) return false
      const payload = validateBotMessage(data)
      if (payload.to.nodeId !== nodeId || !registry.nodes.has(nodeId)) {
        throw new RemoteAgentError('bot/message recipient must match a known destination node', 'bot-message-invalid')
      }
      return registry.send(nodeId, HUB_TO_NODE.BOT_MESSAGE, payload)
    },
    /**
     * Team-management requests from node Bots. handler({ requestId, actor, tool, args, nodeId }) returns
     * { ok, text } (or a string); the answer goes back to the asking node as team/act-result.
     */
    onTeamAct(handler) {
      if (typeof handler !== 'function') throw new TypeError('team act handler must be a function')
      const listener = async (act) => {
        let answer
        try {
          const out = await handler(act)
          answer = typeof out === 'string' ? { ok: true, text: out } : { ok: out?.ok === true, text: String(out?.text ?? '') }
        } catch (err) {
          answer = { ok: false, text: String(err?.message ?? err) }
        }
        if (disposed) return
        try { registry.send(act.nodeId, HUB_TO_NODE.TEAM_ACT_RESULT, validateTeamActResult({ requestId: act.requestId, ...answer })) } catch { /* node gone */ }
      }
      registry.on('teamAct', listener)
      return () => registry.off('teamAct', listener)
    },
    dispose() {
      disposed = true
      registry.off('botMessage', onMessage)
    },
  }
}
