/**
 * 名单第 2 步：hub→node 的 bot/turn 不进任务引擎。
 *
 * 副机 ds-bot 用 ctx.set('remote-agent:bot-turn', receiver) 注册接收方。
 * 本模块只校验、转发、把同一 exchangeId 的 bot/turn-result 送回。
 * 不调用 engine.accept，不调用 runner，不把缺字段改写成 mode:'agent'。
 */
import { NODE_TO_HUB, validateBotTurn } from './protocol.js'

export const BOT_TURN_RECEIVER = 'remote-agent:bot-turn'

/**
 * 结果帧发送失败（链路断着、封密失败、背压）时的重试间隔，毫秒。
 * 一个回合可能跑好几分钟、横跨一次重连：结果发出的那一刻链路是断的，
 * 帧就此永久丢失，主控的页面回合会一直悬到超时。所以失败要重试，总预算约 30 分钟
 * （压力下节点掉线再重连可能不止几分钟；主控侧迟到结果的监听窗口是 1 小时）。
 */
export const RESULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000, ...Array(29).fill(60000)]
const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() })

export async function handleBotTurnFrame({ frame, data, ctx, send, sendError, engine, turnSeq, logger, retryDelaysMs = RESULT_RETRY_DELAYS_MS }) {
  const v = validateBotTurn(data)
  if (!v.ok) {
    sendError?.(frame?.id, v.error, `invalid bot/turn: ${v.error}`)
    return { accepted: false, error: v.error }
  }
  // engine 只是为了让测试能断言它没被调用。这里不读它、不调用它。
  void engine
  let receiver
  try { receiver = ctx?.get?.(BOT_TURN_RECEIVER) } catch { receiver = undefined }
  const seq = typeof turnSeq?.next === 'function' ? turnSeq.next(v.turn.remoteBotId) : 0
  // 只有 send 明确返回 false（没发出去）才重试；返回 undefined 的收集型 send 视为已交付。
  const reply = async (payload) => {
    const frame = {
      nodeId: v.turn.nodeId,
      remoteBotId: v.turn.remoteBotId,
      exchangeId: v.turn.exchangeId,
      text: typeof payload.text === 'string' ? payload.text : '',
      ok: payload.ok !== false,
      seq,
      ...(payload.ok === false ? { error: payload.error ?? 'bot-turn-failed' } : {}),
      ...(Object.hasOwn(v.turn, 'roomId') ? { roomId: v.turn.roomId } : {}),
    }
    const where = { exchangeId: frame.exchangeId, remoteBotId: frame.remoteBotId, seq, ok: frame.ok }
    for (let attempt = 0; ; attempt += 1) {
      const sent = send?.(NODE_TO_HUB.BOT_TURN_RESULT, frame)
      if (sent !== false) {
        logger?.info?.('bot/turn-result sent', { ...where, attempt })
        return true
      }
      if (attempt >= retryDelaysMs.length) {
        logger?.warn?.('bot/turn-result NOT delivered: link stayed down, giving up', { ...where, attempts: attempt + 1 })
        return false
      }
      logger?.warn?.('bot/turn-result not sent (link down?), will retry', { ...where, attempt, retryInMs: retryDelaysMs[attempt] })
      await sleep(retryDelaysMs[attempt])
    }
  }
  if (typeof receiver !== 'function') {
    await reply({ ok: false, error: 'bot-turn-no-receiver', text: '' })
    return { accepted: false, error: 'bot-turn-no-receiver' }
  }
  try {
    const result = await receiver(v.turn)
    const ok = result?.ok !== false
    await reply({
      ok,
      text: typeof result?.text === 'string' ? result.text : '',
      error: ok ? undefined : (typeof result?.error === 'string' && result.error !== '' ? result.error : 'bot-turn-failed'),
    })
    return { accepted: ok, exchangeId: v.turn.exchangeId, ...(ok ? {} : { error: result?.error ?? 'bot-turn-failed' }) }
  } catch {
    await reply({ ok: false, error: 'bot-turn-failed', text: '' })
    return { accepted: false, error: 'bot-turn-failed' }
  }
}
