/** tools/routing：目标节点解析（取自 lib/hub/tools.js:1993，仅改名）。 */
import { ERROR_CODE, RemoteAgentError } from '../wire/index.js'

/**
 * 解析目标节点：显式 id/主机名优先；省略时唯一在线节点直接用，多节点则
 * 负载感知自动选（提案 #14：在跑任务数 → CPU → 内存 → id 逐级比较，
 * mode=agent 只考虑支持 agent 后端的节点）。
 */
export function resolveNodeId(registry, wanted, { mode } = {}) {
  if (typeof wanted === 'string' && wanted.trim() !== '') {
    const rec = registry.pickNode(wanted)
    if (!rec) throw new RemoteAgentError(`unknown node: ${wanted}`, ERROR_CODE.TASK_UNKNOWN)
    if (!rec.online) throw new RemoteAgentError(`node offline: ${rec.nodeId}`, ERROR_CODE.INTERNAL)
    return rec.nodeId
  }
  const online = registry.onlineNodes()
  if (online.length === 0) {
    throw new RemoteAgentError('no online node: 先让副机接入（cluster_nodes 可看当前状态）', ERROR_CODE.INTERNAL)
  }
  // 多节点不再强制显式指定（提案 #14）：负载感知自动选；选不出有能力匹配的
  // 节点（如 agent 模式但没有 agentMode 的节点）才报错并点名原因。
  const auto = registry.pickAutoNode({ mode })
  if (!auto) {
    throw new RemoteAgentError(
      mode === 'agent'
        ? 'no online node supports agent mode（agentMode）; 请显式指定 node 或改用 mode:"exec"'
        : 'no online node: 先让副机接入（cluster_nodes 可看当前状态）',
      ERROR_CODE.INTERNAL,
    )
  }
  return auto
}
