/** caps/node-caps：节点 hello 能力清单。主体逐字取自 lib/protocol.js:222-247（数组顺序属于契约）。 */
export const MEMORY_CAPS = 'memory-sync/1'
/**
 * 两端都认识 bot/trace（节点 Bot 的思考过程与工具步骤）。节点 hello 带它 = 节点会发；
 * hub welcome 带它 = hub 收得下。节点只在 hub 宣告后才发，旧 hub 不会收到它不认识的帧。
 */
export const BOT_TRACE_CAP = 'bot-trace/1'
/** hub 在 welcome 里宣告的能力；节点凭它决定要不要发 mem/* 与 bot/trace 帧。 */
export const HUB_CAPS = Object.freeze([MEMORY_CAPS, BOT_TRACE_CAP])
export const BOT_MEMORY_UPDATE_CAP = 'bot-memory-update/1'
/** Profile-only updates require a node that preserves these fields through validation. */
export const BOT_PROFILE_UPDATE_CAP = 'bot-profile-update/1'
/** The node takes `mode` (steer | queue) on bot/turn and joins a steer into the running turn. */
export const BOT_TURN_MODE_CAP = 'bot-turn-mode/1'
/** The node has a bot/action receiver (answer a card, stop / follow up / start a task). */
export const BOT_ACTION_CAP = 'bot-action/1'
/** The node reports the cards its Bots wait on (approvals, questions, proposals) in its roster. */
export const ROSTER_CARDS_CAP = 'roster-cards/1'

/** 两处 hello 组装（握手与状态视图）都走这里，避免其中一处漏掉新能力。 */
export function nodeCaps(baseCaps, platform = process.platform) {
  return [
    ...baseCaps,
    'file-transfer', 'selfcheck', 'config-sync/2', 'peer/v1', MEMORY_CAPS, BOT_MEMORY_UPDATE_CAP, BOT_PROFILE_UPDATE_CAP,
    BOT_TURN_MODE_CAP, BOT_ACTION_CAP, ROSTER_CARDS_CAP, BOT_TRACE_CAP,
    ...(platform === 'win32' ? ['desktop', 'gui'] : []),
  ]
}
