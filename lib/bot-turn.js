/**
 * 名单第 2 步：hub→node 的 bot/turn 不进任务引擎。
 *
 * 副机 ds-bot 用 ctx.set('remote-agent:bot-turn', receiver) 注册接收方。
 * 本模块只校验、转发、把同一 exchangeId 的 bot/turn-result 送回。
 * 不调用 engine.accept，不调用 runner，不把缺字段改写成 mode:'agent'。
 *
 * 思考过程与工具步骤（能力 bot-trace/1）：receiver 的第二个参数 `{ enabled, trace(payload) }`。
 * enabled = hub 在 welcome 里宣告了 bot-trace/1（旧 hub 不认识 bot/trace，一帧也不发）；
 * trace({ items, omitted? }) 把一批步骤作为 bot/trace 发给 hub，返回是否发出（尽力而为，丢了由 final 修补）。
 * receiver 返回值里的 `trace: { items, omitted? }` 是本回合权威的完整步骤，作为 final:true 的 bot/trace
 * 在 bot/turn-result 之前发出（与结果同样带重试）。校验与上限都在 protocol.js 的 validateBotTrace。

 */
import { BOT_TRACE_CAP, NODE_TO_HUB, validateBotTrace, validateBotTurn } from './protocol.js'
import { AgentJournal } from './persist/agent-journal.js'

export const BOT_TURN_RECEIVER = 'remote-agent:bot-turn'

/**
 * 结果帧发送失败（链路断着、封密失败、背压）时的重试间隔，毫秒。
 * 一个回合可能跑好几分钟、横跨一次重连：结果发出的那一刻链路是断的，
 * 帧就此永久丢失，主控的页面回合会一直悬到超时。所以失败要重试，总预算约 30 分钟
 * （压力下节点掉线再重连可能不止几分钟；主控侧迟到结果的监听窗口是 1 小时）。
 */
export const RESULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000, ...Array(29).fill(60000)]
const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() })

export async function handleBotTurnFrame({ frame, data, ctx, send, sendError, engine, turnSeq, logger, hubCaps, retryDelaysMs = RESULT_RETRY_DELAYS_MS }) {
  const v = validateBotTurn(data)
  if (!v.ok) {
    sendError?.(frame?.id, v.error, `invalid bot/turn: ${v.error}`)
    // The error frame is not something the hub waits on: a turn it can name (a bad attachment manifest, say) is
    // answered with a failed result so the page says why at once instead of waiting out the whole turn timeout.
    const idOf = (value) => (typeof value === 'string' && value.trim() !== '' && value.length <= 200 ? value.trim() : undefined)
    const named = { nodeId: idOf(data?.nodeId), remoteBotId: idOf(data?.remoteBotId), exchangeId: idOf(data?.exchangeId) }
    if (named.nodeId && named.remoteBotId && named.exchangeId) {
      try { send?.(NODE_TO_HUB.BOT_TURN_RESULT, { ...named, text: '', ok: false, seq: 0, error: v.error }) } catch { /* best effort */ }
    }
    return { accepted: false, error: v.error }
  }
  // engine 只是为了让测试能断言它没被调用。这里不读它、不调用它。
  void engine
  let receiver
  try { receiver = ctx?.get?.(BOT_TURN_RECEIVER) } catch { receiver = undefined }
  const seq = typeof turnSeq?.next === 'function' ? turnSeq.next(v.turn.remoteBotId) : 0
  // 只有 send 明确返回 false（没发出去）才重试；返回 undefined 的收集型 send 视为已交付。
  const deliver = async (type, frame, where, delays = retryDelaysMs) => {
    for (let attempt = 0; ; attempt += 1) {
      const sent = send?.(type, frame)
      if (sent !== false) {
        logger?.info?.(`${type} sent`, { ...where, attempt })
        return true
      }
      if (attempt >= delays.length) {
        logger?.warn?.(`${type} NOT delivered: link stayed down, giving up`, { ...where, attempts: attempt + 1 })
        return false
      }
      logger?.warn?.(`${type} not sent (link down?), will retry`, { ...where, attempt, retryInMs: delays[attempt] })
      await sleep(delays[attempt])
    }
  }
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
    return deliver(NODE_TO_HUB.BOT_TURN_RESULT, frame, { exchangeId: frame.exchangeId, remoteBotId: frame.remoteBotId, seq, ok: frame.ok })
  }
  // bot/trace：只在 hub 宣告 bot-trace/1 时发。批号 seq 由这里分配（同一 exchangeId 内严格递增）。
  const hubTraces = (() => { try { return typeof hubCaps === 'function' && hubCaps()?.includes?.(BOT_TRACE_CAP) === true } catch { return false } })()
  let traceSeq = 0
  const traceFrame = (payload, final) => {
    const checked = validateBotTrace({
      nodeId: v.turn.nodeId,
      remoteBotId: v.turn.remoteBotId,
      exchangeId: v.turn.exchangeId,
      seq: ++traceSeq,
      ...(final ? { final: true } : {}),
      items: Array.isArray(payload?.items) ? payload.items : [],
      ...(Number.isSafeInteger(payload?.omitted) ? { omitted: payload.omitted } : {}),
      ...(Object.hasOwn(v.turn, 'roomId') ? { roomId: v.turn.roomId } : {}),
    })
    if (!checked.ok) { logger?.warn?.('bot/trace not sent: invalid', { exchangeId: v.turn.exchangeId, error: checked.error }); return undefined }
    return checked.trace
  }
  const control = {
    enabled: hubTraces,
    trace: (payload) => {
      if (!hubTraces || !Array.isArray(payload?.items)) return false
      const frame = traceFrame(payload, false)
      if (frame === undefined) return false
      try { return send?.(NODE_TO_HUB.BOT_TRACE, frame) !== false } catch { return false }
    },
  }
  // 权威的完整步骤：在 bot/turn-result 之前发出，修补丢掉的中间帧。重试只用前 10 档（约 4 分钟）：
  // 链路掉线时它先于结果重试；放弃后结果自己还有约 30 分钟的重试，不会因 trace 把结果拖成两倍。
  const sendFinalTrace = async (payload) => {
    if (!hubTraces || payload === null || typeof payload !== 'object') return
    const frame = traceFrame(payload, true)
    if (frame === undefined) return
    await deliver(NODE_TO_HUB.BOT_TRACE, frame, { exchangeId: frame.exchangeId, remoteBotId: frame.remoteBotId, seq: frame.seq, final: true }, retryDelaysMs.slice(0, 10))
  }
  if (typeof receiver !== 'function') {
    await reply({ ok: false, error: 'bot-turn-no-receiver', text: '' })
    return { accepted: false, error: 'bot-turn-no-receiver' }
  }
  // AC announces bot-attach/1 for itself; the ds-bot on this node may be older and never register the chunk receiver.
  // A message whose images or files would then be silently dropped is refused, with the reason.
  if (Array.isArray(v.turn.attachments) && v.turn.attachments.length > 0) {
    let attachReceiver
    try { attachReceiver = ctx?.get?.('remote-agent:bot-attach') } catch { attachReceiver = undefined }
    if (typeof attachReceiver !== 'function') {
      await reply({ ok: false, error: 'bot-attach-no-receiver', text: '' })
      return { accepted: false, error: 'bot-attach-no-receiver' }
    }
  }
  // Journal: open per-Bot append-only journal for crash recovery.
  // remoteBotId is the local Bot's id on this node.
  let journal = null
  try {
    if (typeof v.turn.remoteBotId === 'string' && v.turn.remoteBotId !== '') {
      journal = new AgentJournal(v.turn.remoteBotId)
      journal.turnStart({
        exchangeId: v.turn.exchangeId,
        text: v.turn.text,
        fromBotId: v.turn.fromBotId,
      })
    }
  } catch { journal = null }

  try {
    const result = await receiver(v.turn, control)
    const ok = result?.ok !== false
    // Log trace steps into the journal so a crash replay can see what ran.
    if (journal && Array.isArray(result?.trace?.items)) {
      for (let i = 0; i < result.trace.items.length; i++) {
        const item = result.trace.items[i]
        try {
          if (item?.type === 'tool_use') {
            journal.stepTool({ exchangeId: v.turn.exchangeId, stepIdx: i, name: item.name, args: item.input })
          } else if (item?.type === 'tool_result') {
            journal.stepToolResult({ exchangeId: v.turn.exchangeId, stepIdx: i, name: item.name, ok: item.ok !== false, result: item.content })
          } else if (item?.type === 'text' || item?.type === 'thinking') {
            journal.stepModel({ exchangeId: v.turn.exchangeId, stepIdx: i })
          }
        } catch { /* non-fatal: best-effort step logging */ }
      }
    }
    await sendFinalTrace(result?.trace)
    await reply({
      ok,
      text: typeof result?.text === 'string' ? result.text : '',
      error: ok ? undefined : (typeof result?.error === 'string' && result.error !== '' ? result.error : 'bot-turn-failed'),
    })
    try { journal?.turnEnd({ exchangeId: v.turn.exchangeId, reason: ok ? 'ok' : (result?.error ?? 'bot-turn-failed') }) } catch {}
    return { accepted: ok, exchangeId: v.turn.exchangeId, ...(ok ? {} : { error: result?.error ?? 'bot-turn-failed' }) }
  } catch (err) {
    try { journal?.turnFail({ exchangeId: v.turn.exchangeId, error: err }) } catch {}
    await reply({ ok: false, error: 'bot-turn-failed', text: '' })
    return { accepted: false, error: 'bot-turn-failed' }
  } finally {
    try { journal?.close() } catch {}
  }
}
