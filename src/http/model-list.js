export function modelListOf(nodes) {
  const result = []
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const nodeId = node.nodeId
    if (typeof nodeId !== 'string' || nodeId.length === 0) continue

    const defaultModel = node.defaultModel
    const models = node.models
    const reported = Array.isArray(models)
    const ids = []
    if (reported) {
      for (const model of models) {
        if (model === null || typeof model !== 'object') continue
        const id = model.id
        if (typeof id === 'string' && id.length > 0) ids.push(id)
      }
    }

    result.push({
      nodeId,
      defaultModel: typeof defaultModel === 'string' && defaultModel.length > 0 ? defaultModel : null,
      reported,
      ids,
    })
  }
  return result
}
