// Wires the reliable link (lib/reliable-link.js) into the hub registry and the node transport, and offers it to the
// host (ds-bot) on the bot-network service: post(...) to send, onReliable(type, handler) to receive.
// A message with no handler yet is not acked, so it waits until the host registers one (ds-bot may load after AC).
import { join } from 'node:path'
import { createReliableLink, REL_ACK, REL_FRAME } from './reliable-link.js'
import { validateRelAck, validateRelFrame } from './protocol.js'

/** Inner types the link carries (prefixes). W0: tests; W3 adds the work model. */
export const RELIABLE_PREFIXES = Object.freeze(['work/', 'team/', 'test/'])
const accepts = type => RELIABLE_PREFIXES.some(prefix => type.startsWith(prefix))
const TICK_MS = 5_000

function handlerTable() {
  const handlers = new Map()
  return {
    deliver: async (msg) => {
      const handler = handlers.get(msg.type)
      if (typeof handler !== 'function') throw new Error(`no handler for ${msg.type} yet`)
      await handler(msg)
    },
    on: (type, handler) => {
      if (typeof handler !== 'function') throw new TypeError('reliable handler must be a function')
      handlers.set(type, handler)
      return () => { if (handlers.get(type) === handler) handlers.delete(type) }
    },
  }
}

/** Hub side. `network` is the hub bot-network service object; gains post / onReliable / reliablePending. */
export function attachHubReliable({ registry, network, stateDir, log = () => {} }) {
  const table = handlerTable()
  const link = createReliableLink({
    self: 'hub',
    file: stateDir ? join(stateDir, 'reliable-hub.json') : undefined,
    send: (nodeId, type, data) => registry.send(nodeId, type, data) === true,
    ready: nodeId => registry.nodes.get(nodeId)?.online === true && registry.e2eReady?.(nodeId) === true,
    deliver: table.deliver,
    accepts,
    log,
  })
  registry.reliable = link
  const onReady = ({ nodeId } = {}) => { if (typeof nodeId === 'string') link.peerReady(nodeId) }
  registry.on('e2eEstablished', onReady)
  const timer = setInterval(() => { try { link.tick() } catch (error) { log('warn', 'reliable tick failed', { error: String(error?.message ?? error) }) } }, TICK_MS)
  timer.unref?.()
  if (network) {
    network.post = (nodeId, type, data) => link.post(nodeId, type, data)
    network.onReliable = (type, handler) => table.on(type, handler)
    network.reliablePending = peer => link.pending(peer)
  }
  return () => {
    clearInterval(timer)
    registry.off?.('e2eEstablished', onReady)
    if (registry.reliable === link) registry.reliable = undefined
  }
}

/** Node side. `network` is the node bot-network object; gains post / onReliable / receiveReliable / reliablePending. */
export function attachNodeReliable({ nodeId, transport, send, network, stateDir, log = () => {} }) {
  const table = handlerTable()
  const link = createReliableLink({
    self: nodeId,
    file: stateDir ? join(stateDir, 'reliable-node.json') : undefined,
    send: (_peer, type, data) => send(type, data) === true,
    ready: peer => peer === 'hub' && transport.online === true,
    deliver: table.deliver,
    accepts,
    log,
  })
  const onOnline = () => link.peerReady('hub')
  const onE2E = (state) => { if (state === 'ok') link.peerReady('hub') }
  transport.on?.('online', onOnline)
  transport.on?.('e2e', onE2E)
  const timer = setInterval(() => { try { link.tick() } catch (error) { log('warn', 'reliable tick failed', { error: String(error?.message ?? error) }) } }, TICK_MS)
  timer.unref?.()
  network.post = (type, data, { to } = {}) => link.post('hub', type, data, to ? { to } : {})
  network.onReliable = (type, handler) => table.on(type, handler)
  network.reliablePending = () => link.pending('hub')
  network.receiveReliable = (frameType, data) => {
    let checked
    try { checked = frameType === REL_FRAME ? validateRelFrame(data) : frameType === REL_ACK ? validateRelAck(data) : null } catch { checked = null }
    if (checked === null) { log('warn', 'rel frame rejected', { type: frameType }); return }
    void link.receive('hub', frameType, checked)
  }
  return () => {
    clearInterval(timer)
    transport.off?.('online', onOnline)
    transport.off?.('e2e', onE2E)
  }
}
