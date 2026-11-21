/**
 * bot/steer 帧处理：hub → node，向节点上某个 Bot 正在跑的回合注入插队消息。
 *
 * 接收方由副机 ds-bot 通过 ctx.provide('remote-agent:bot-steer', fn) 注册，
 * 返回 { ok, steered, error? }。
 *
 * 语义：当用户在 node bot 忙时发消息并选择"插队"模式，hub 把消息以 bot/steer
 * 帧发到节点，节点在当前 turn 的下一个工具调用边界注入文本（STEER_CUT 机制）。
 */
import { NODE_TO_HUB } from './protocol.js'

export const BOT_STEER_RECEIVER = 'remote-agent:bot-steer'

/**
 * @param {{ frame, data, ctx, send, sendError }} opts
 */
export async function handleBotSteerFrame({ frame, data, ctx, send, sendError }) {
  const { remoteBotId, requestId, text } = data ?? {}
  if (!remoteBotId || !requestId || typeof text !== 'string') {
    sendError(frame.id, 'invalid-steer', 'bot/steer missing remoteBotId, requestId, or text')
    return
  }

  let receiver
  try { receiver = ctx?.get?.(BOT_STEER_RECEIVER) } catch { receiver = undefined }
  if (typeof receiver !== 'function') {
    // No receiver registered — node does not support steer yet; silently ack.
    send(NODE_TO_HUB.BOT_STOP_RESULT /* reuse ack shape */, { requestId, ok: true, steered: false }, { replyTo: frame.id })
    return
  }

  try {
    const result = await receiver({ remoteBotId, text, requestId })
    send(NODE_TO_HUB.BOT_STOP_RESULT, {
      requestId,
      ok: result?.ok !== false,
      steered: result?.steered === true,
      error: result?.ok === false ? (result?.error ?? 'bot-steer-failed') : null,
    }, { replyTo: frame.id })
  } catch (err) {
    send(NODE_TO_HUB.BOT_STOP_RESULT, { requestId, ok: false, steered: false, error: `bot-steer-failed: ${err?.message ?? String(err)}` }, { replyTo: frame.id })
  }
}
