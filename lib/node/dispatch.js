import { HUB_TO_NODE, MEMORY, NODE_TO_HUB, validateBotTurn } from '../protocol.js'
import { handleBotTurnFrame } from '../bot-turn.js'
import { handleBotCreateFrame } from '../bot-create.js'
import { handleBotHistoryFrame } from '../bot-history.js'
import { handleBotUpdateFrame } from '../bot-update.js'
import { handleBotDeleteFrame } from '../bot-delete.js'
import { handleBotStopFrame } from '../bot-stop.js'
import { handleBotSteerFrame } from '../bot-steer.js'
import { createTurnSeq } from './turn-seq.js'
import { createTurnReplay } from './turn-replay.js'

/** isPlainObject helper (same as index.js) */
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

function swallow(p) { Promise.resolve(p).catch(() => {}) }

/**
 * Returns a dispatch(frame, d?) function for Bot receivers and transport services.
 * Returns `true` if the frame was handled, `false` if it should fall through to index.js default.
 */
export function createFrameDispatcher({ ctx, send, sendError, engine, logger, stateDir, memory, network, peerDirect = false, onModelSync }) {
  const turnSeq = createTurnSeq(stateDir)
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
      case HUB_TO_NODE.BOT_TURN:
        if (replay && validateBotTurn(data).ok) {
          swallow(replay.run(data.exchangeId.trim(), async () => {
            let result
            await handleBotTurnFrame({ frame, data, ctx, send: (...args) => { result = args }, sendError, engine, turnSeq, logger })
            return result
          }, reply))
        } else {
          swallow(handleBotTurnFrame({ frame, data, ctx, send: reply, sendError, engine, turnSeq, logger }))
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
      case HUB_TO_NODE.MODEL_SYNC: {
        // P1 模型同步帧：hub 是模型 ref 的唯一事实源。
        // validateModelSync 由 protocol.js 导出（lib/ 在下次 build 后生效）。
        // 未更新的旧 protocol.js 不含该函数时，做保守校验后交给 onModelSync。
        const validate = typeof validateModelSync === 'function' ? validateModelSync : (d2) => {
          if (!d2 || typeof d2 !== 'object') return { ok: false, error: 'model-sync-missing' }
          if (typeof d2.requestId !== 'string' || d2.requestId.trim() === '') return { ok: false, error: 'model-sync-requestId-missing' }
          if (typeof d2.nodeId !== 'string' || d2.nodeId.trim() === '') return { ok: false, error: 'model-sync-nodeId-missing' }
          if (typeof d2.modelRef !== 'string' || d2.modelRef.trim() === '') return { ok: false, error: 'model-sync-modelRef-missing' }
          const scope = d2.scope
          if (!['default', 'bot', 'all'].includes(scope)) return { ok: false, error: 'model-sync-scope-invalid' }
          return { ok: true, sync: { nodeId: d2.nodeId.trim(), requestId: d2.requestId.trim(), scope, modelRef: d2.modelRef.trim(), ...(typeof d2.effort === 'string' && d2.effort.trim() ? { effort: d2.effort.trim() } : {}), ...(scope === 'bot' && typeof d2.botId === 'string' ? { botId: d2.botId.trim() } : {}) } }
        }
        const checked = validate(data)
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
      default:
        return false
    }
  }
}
