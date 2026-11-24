/**
 * bot/attach 帧处理：hub → node，主控把用户消息里的图片/文件按块送给节点 Bot（能力 bot-attach/1）。
 *
 * 接收方由副机 ds-bot 通过 ctx.provide('remote-agent:bot-attach', fn) 注册，
 * 收到 { remoteBotId, exchangeId, index, chunk, chunks, data }。没有结果帧。
 *
 * 顺序是这个帧的全部要点：hub 把一个回合的全部分块发完，再在同一条链路上发点名它们的 bot/turn，
 * 节点必须在 bot/turn 交给接收方之前就把分块登记好。所以这里的接收方调用与帧的分发在同一个 tick 里完成：
 * 校验和取接收方都是同步的，中间没有任何 await；接收方同步抛错、返回 rejected promise 都被吞掉，
 * 不会让一块坏数据影响后面的帧。没有接收方只记一条日志（hub 发之前先看了 bot-attach/1 能力）。
 */
import { validateBotAttach } from './protocol.js'

export const BOT_ATTACH_RECEIVER = 'remote-agent:bot-attach'

/**
 * 同步函数，不返回 promise：调用方（dispatch）不需要 swallow，也没有可等的东西。
 * @param {{ frame, data, ctx, send, sendError, logger }} opts
 * @returns {{ accepted: boolean, error?: string }}
 */
export function handleBotAttachFrame({ frame, data, ctx, send, sendError, logger }) {
  void send
  const checked = validateBotAttach(data)
  if (!checked.ok) {
    try { sendError?.(frame?.id, checked.error, `bot/attach validation failed: ${checked.error}`) } catch { /* the error frame is best effort */ }
    return { accepted: false, error: checked.error }
  }
  const { remoteBotId, exchangeId, index, chunk, chunks, data: body } = checked.attach
  let receiver
  try { receiver = ctx?.get?.(BOT_ATTACH_RECEIVER) } catch { receiver = undefined }
  if (typeof receiver !== 'function') {
    try { logger?.warn?.('bot/attach dropped: no receiver', { exchangeId, index, chunk }) } catch { /* logging must not throw */ }
    return { accepted: false, error: 'bot-attach-no-receiver' }
  }
  try {
    const pending = receiver({ remoteBotId, exchangeId, index, chunk, chunks, data: body })
    // An async receiver that rejects must not become an unhandled rejection.
    if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
      Promise.resolve(pending).catch((err) => {
        try { logger?.warn?.('bot/attach receiver rejected', { exchangeId, index, chunk, error: String(err?.message ?? err) }) } catch { /* ignore */ }
      })
    }
  } catch (err) {
    try { logger?.warn?.('bot/attach receiver threw', { exchangeId, index, chunk, error: String(err?.message ?? err) }) } catch { /* ignore */ }
    return { accepted: false, error: 'bot-attach-receiver-failed' }
  }
  return { accepted: true }
}
