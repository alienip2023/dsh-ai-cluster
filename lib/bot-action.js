/**
 * bot/action 帧处理：hub → node，主控替用户对节点 Bot 的界面状态做操作
 * （回答卡片、停止或追问后台任务）。节点上的 Bot 没有界面，这些操作只能从主控来。
 *
 * 接收方由副机 ds-bot 通过 ctx.provide('remote-agent:bot-action', fn) 注册，
 * 收到 { remoteBotId, action, params }，返回 { ok, error?, detail? }。
 * 没有接收方（旧版 ds-bot）回 ok:false + bot-action-no-receiver，让主控如实告诉用户。
 */
import { validateBotAction, NODE_TO_HUB } from './protocol.js'

export const BOT_ACTION_RECEIVER = 'remote-agent:bot-action'

/**
 * @param {{ frame, data, ctx, send, sendError }} opts
 */
export async function handleBotActionFrame({ frame, data, ctx, send, sendError }) {
  const checked = validateBotAction(data)
  if (!checked.ok) {
    sendError(frame.id, checked.error, `bot/action validation failed: ${checked.error}`)
    // A frame that names its request still gets an answer, so the hub does not wait for it.
    if (typeof data?.requestId === 'string' && data.requestId.trim() !== '') {
      send(NODE_TO_HUB.BOT_ACTION_RESULT, { requestId: data.requestId.trim(), ok: false, error: checked.error }, { replyTo: frame.id })
    }
    return
  }
  const { requestId, remoteBotId, action, params } = checked.action

  let receiver
  try { receiver = ctx?.get?.(BOT_ACTION_RECEIVER) } catch { receiver = undefined }
  if (typeof receiver !== 'function') {
    send(NODE_TO_HUB.BOT_ACTION_RESULT, { requestId, ok: false, error: 'bot-action-no-receiver' }, { replyTo: frame.id })
    return
  }
  try {
    const result = await receiver({ remoteBotId, action, params })
    const failed = result?.ok === false
    send(
      NODE_TO_HUB.BOT_ACTION_RESULT,
      {
        requestId,
        ok: !failed,
        error: failed ? (result?.error ?? 'bot-action-failed') : null,
        detail: typeof result?.detail === 'string' ? result.detail : null,
      },
      { replyTo: frame.id },
    )
  } catch (err) {
    send(NODE_TO_HUB.BOT_ACTION_RESULT, { requestId, ok: false, error: `bot-action-failed: ${err?.message ?? String(err)}` }, { replyTo: frame.id })
  }
}
