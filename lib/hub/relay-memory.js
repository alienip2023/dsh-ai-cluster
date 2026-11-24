/**
 * 中继配置读取口径：/config、/setup 与面板共用同一份规则（relay.* 优先，其次顶层旧字段）。
 */
export function readRelayUrl(config) {
  if (typeof config?.relay?.url === 'string' && config.relay.url !== '') return config.relay.url
  if (typeof config?.relayUrl === 'string') return config.relayUrl
  return ''
}

export function readRelayToken(config) {
  if (typeof config?.relay?.token === 'string' && config.relay.token !== '') return config.relay.token
  if (typeof config?.relayToken === 'string') return config.relayToken
  return ''
}

export function readRelayTransportMode(config) {
  if (typeof config?.transportMode === 'string' && config.transportMode !== '') return config.transportMode
  return 'relay'
}
