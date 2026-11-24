import { HUB_TO_NODE, MEMORY, NODE_TO_HUB, validateBotLocate, validateBotTurn, validateModelSync, validateDirectorySnapshot, validateDirectoryDelta } from '../protocol.js'
import { handleBotTurnFrame } from '../bot-turn.js'
import { handleBotCreateFrame } from '../bot-create.js'
import { handleBotHistoryFrame } from '../bot-history.js'
import { handleBotUpdateFrame } from '../bot-update.js'
import { handleBotDeleteFrame } from '../bot-delete.js'
import { handleBotStopFrame } from '../bot-stop.js'
import { handleBotSteerFrame } from '../bot-steer.js'
import { handleBotActionFrame } from '../bot-action.js'
import { handleBotAttachFrame } from '../bot-attach.js'
import { createTurnSeq } from './turn-seq.js'
import { createTurnReplay } from './turn-replay.js'

/** isPlainObject helper (same as index.js) */
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

function swallow(p) { Promise.resolve(p).catch(() => {}) }

/**
 * Returns a dispatch(frame, d?) function for Bot receivers and transport services.
 * Returns `true` if the frame was handled, `false` if it should fall through to index.js default.
 */
export function createFrameDispatcher({ ctx, send, sendError, engine, logger, stateDir, memory, network, peerDirect = false, onModelSync, hubCaps }) {
  const turnSeq = createTurnSeq(stateDir, { log: (level, message, extra) => logger?.[level]?.(message, extra) })
  const replay = peerDirect ? createTurnReplay() : null
  return function dispatchReceiverFrame(frame, d, reply = send) {
    const data = d ?? (isPlainObject(frame?.d) ? frame.d : {})
    switch (frame?.t) {
      case HUB_TO_NODE.BOT_DIRECTORY:
        network?.receiveDirectory(data)
        return true
      case HUB_TO_NODE.BOT_MESSAGE:
        swallow(network?.receiveMessage(data))
        return true
      case HUB_TO_NODE.BOT_ASSIGN:
        network?.receiveAssign?.(data)
        return true
      case HUB_TO_NODE.REL_FRAME:
      case HUB_TO_NODE.REL_ACK:
        network?.receiveReliable?.(frame.t, data)
        return true
      case HUB_TO_NODE.TEAM_ACT_RESULT:
        network?.receiveTeamActResult?.(data)
        return true
      case HUB_TO_NODE.BOT_TURN:
        if (replay && validateBotTurn(data).ok) {
          swallow(replay.run(data.exchangeId.trim(), async () => {
            let result
            await handleBotTurnFrame({ frame, data, ctx, send: (...args) => { result = args }, sendError, engine, turnSeq, logger })
            return result
          }, reply))
        } else {
          // bot/trace 只回给 hub：来自对等节点的回合（reply 不是 send）与重放路径都不带 hubCaps，不发 trace 帧。
          swallow(handleBotTurnFrame({ frame, data, ctx, send: reply, sendError, engine, turnSeq, logger, ...(reply === send ? { hubCaps } : {}) }))
        }
        return true
      case HUB_TO_NODE.BOT_CREATE:
        swallow(handleBotCreateFrame({ frame, data, ctx, send, sendError, engine }))
        return true
      case HUB_TO_NODE.BOT_HISTORY:
        swallow(handleBotHistoryFrame({ frame, data, ctx, send, sendError }))
        return true
      case HUB_TO_NODE.BOT_UPDATE:
        swallow(handleBotUpdateFrame({ frame, data, ctx, send, sendError }))
        return true
      case HUB_TO_NODE.BOT_DELETE:
        swallow(handleBotDeleteFrame({ frame, data, ctx, send, sendError }))
        return true
      case HUB_TO_NODE.BOT_STOP:
        swallow(handleBotStopFrame({ frame, data, ctx, send, sendError }))
        return true
      case HUB_TO_NODE.BOT_STEER:
        swallow(handleBotSteerFrame({ frame, data, ctx, send, sendError }))
        return true
      case HUB_TO_NODE.BOT_ACTION:
        swallow(handleBotActionFrame({ frame, data, ctx, send, sendError }))
        return true
      case HUB_TO_NODE.BOT_ATTACH:
        // Synchronous on purpose: the chunks must be registered before the bot/turn that follows on the same link.
        handleBotAttachFrame({ frame, data, ctx, send, sendError, logger })
        return true
      case HUB_TO_NODE.BOT_LOCATE: {
        // Hub asks whether a Bot is running here. Sign the requestId with the
        // Bot's keypair so the hub can verify provenance; if the Bot has no
        // identity file here, report found:false rather than ignoring.
        const checked = validateBotLocate(data)
        if (!checked.ok) { logger?.warn?.('bot/locate refused', { error: checked.error }); return true }
        const { botId, requestId } = checked.locate
        let botIdentities
        try { botIdentities = ctx?.get?.('dsh-ai-cluster:bot-identities', false) } catch { botIdentities = undefined }
        const identity = botIdentities instanceof Map ? botIdentities.get(botId) : undefined
        if (!identity) {
          send(NODE_TO_HUB.BOT_LOCATE_RESULT, { requestId, botId, nodeId: data?.nodeId ?? '', found: false })
          return true
        }
        try {
          const sig = identity.sign(requestId)
          send(NODE_TO_HUB.BOT_LOCATE_RESULT, {
            requestId, botId, nodeId: data?.nodeId ?? '',
            found: true, machineId: identity.homeNodeId ?? '', pubKeyB64: identity.publicKeyB64, sig,
          })
        } catch (err) {
          logger?.warn?.('bot/locate sign failed', { error: String(err?.message ?? err) })
          send(NODE_TO_HUB.BOT_LOCATE_RESULT, { requestId, botId, nodeId: data?.nodeId ?? '', found: false })
        }
        return true
      }
      case HUB_TO_NODE.MODEL_SYNC: {
        // P1 模型同步帧：hub 是模型 ref 的唯一事实源。校验与 src/task-run/dispatch.js 同一份（protocol.js）。
        const checked = validateModelSync(data)
        const { requestId, nodeId } = checked.ok ? checked.sync : { requestId: data?.requestId ?? '', nodeId: data?.nodeId ?? '' }
        if (!checked.ok) {
          logger?.warn?.('node/model-sync refused', { error: checked.error })
          if (requestId) send(NODE_TO_HUB.MODEL_SYNC_RESULT, { requestId, nodeId, ok: false, applied: [], error: checked.error })
          return true
        }
        if (typeof onModelSync === 'function') {
          Promise.resolve().then(() => onModelSync(checked.sync, send)).catch(err => {
            logger?.warn?.('node/model-sync handler failed', { error: String(err?.message ?? err) })
            send(NODE_TO_HUB.MODEL_SYNC_RESULT, { requestId, nodeId, ok: false, applied: [], error: String(err?.message ?? err).slice(0, 200) })
          })
        } else {
          send(NODE_TO_HUB.MODEL_SYNC_RESULT, { requestId, nodeId, ok: false, applied: [], error: 'model-sync-not-supported' })
        }
        return true
      }
      // M4：记忆通道的下行三类。真正的读写在 S4 的 outbox/inject 里，
      // 这里只负责把帧交给 memory-link，不让它落进未知帧的告警里。
      case MEMORY.SNAPSHOT:
      case MEMORY.READ_RESULT:
      case MEMORY.WRITE_RESULT:
        if (!memory) return false
        memory.dispatch(frame.t, data)
        return true
      // Phase 1: 团队目录下发帧 — 存入节点本地缓存（context service）。
      case HUB_TO_NODE.DIRECTORY_SNAPSHOT: {
        const checked = validateDirectorySnapshot(data)
        if (!checked.ok) { logger?.warn?.('directory/snapshot refused', { error: checked.error }); return true }
        try {
          const dirService = ctx?.get?.('dsh-ai-cluster:directory', false)
          if (dirService && typeof dirService.applySnapshot === 'function') dirService.applySnapshot(checked.snapshot)
        } catch (err) { logger?.warn?.('directory/snapshot handler failed', { error: String(err?.message ?? err) }) }
        return true
      }
      case HUB_TO_NODE.DIRECTORY_DELTA: {
        const checked = validateDirectoryDelta(data)
        if (!checked.ok) { logger?.warn?.('directory/delta refused', { error: checked.error }); return true }
        try {
          const dirService = ctx?.get?.('dsh-ai-cluster:directory', false)
          if (dirService && typeof dirService.applyDelta === 'function') dirService.applyDelta(checked.delta)
        } catch (err) { logger?.warn?.('directory/delta handler failed', { error: String(err?.message ?? err) }) }
        return true
      }
      default:
        return false
    }
  }
}
