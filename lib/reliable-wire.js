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
/** A message to another node waits this long for its direct link to come up, then goes through the hub. */
export const DIRECT_FAILOVER_MS = 10_000

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

/**
 * Node side. `network` is the node bot-network object; gains post / onReliable / receiveReliable / reliablePending.
 * `peers` (the peer router, AC 0.4.40): a message to another node goes over a direct link to it when there is one,
 * else (or once it has waited `failoverMs` for one, or on a resend while the hub is up) through the hub. While the hub
 * is away it goes direct only; with neither way up it waits. Returns `{ detach, receivePeer, peerReady }`.
 */
export function attachNodeReliable({ nodeId, transport, send, network, stateDir, peers, failoverMs = DIRECT_FAILOVER_MS, log = () => {} }) {
  const table = handlerTable()
  const hubUp = () => transport.online === true
  const route = peers ? (entry, at, earlier = []) => {
    if (entry.peer === 'hub') return hubUp() ? 'hub' : null
    // In order per node: behind something not yet sent it waits; behind something that went through the hub it goes
    // through the hub too, so a work/cancel never overtakes its work/handoff.
    if (earlier.some(other => (other.tries ?? 0) === 0)) return null
    if (hubUp() && earlier.some(other => (other.vias ?? []).includes('hub'))) return 'hub'
    const state = peers.relState(entry.peer)
    // A resend goes through the hub while it is up: the direct way already had its chance (both arriving is harmless).
    if (state === 'connected' && !((entry.tries ?? 0) >= 1 && hubUp())) return entry.peer
    if (state === 'connected') return 'hub'
    if (state === 'connecting' && at - entry.at < failoverMs) return null
    return hubUp() ? 'hub' : null
  } : undefined
  const link = createReliableLink({
    self: nodeId,
    file: stateDir ? join(stateDir, 'reliable-node.json') : undefined,
    send: (peer, type, data) => {
      if (peer === 'hub') {
        const sent = send(type, data) === true
        if (sent && type === REL_FRAME && typeof data?.to === 'string') peers?.noteRoute?.(data.to, 'hub')
        return sent
      }
      const sent = peers?.sendRel(peer, type, data) === true
      if (sent && type === REL_FRAME) peers?.noteRoute?.(peer, 'direct')
      return sent
    },
    ready: peer => (peer === 'hub' ? hubUp() : peers?.relState(peer) === 'connected'),
    deliver: table.deliver,
    accepts,
    route,
    log,
  })
  const onOnline = () => link.peerReady('hub')
  const onE2E = (state) => { if (state === 'ok') link.peerReady('hub') }
  transport.on?.('online', onOnline)
  transport.on?.('e2e', onE2E)
  const timer = setInterval(() => { try { link.tick() } catch (error) { log('warn', 'reliable tick failed', { error: String(error?.message ?? error) }) } }, TICK_MS)
  timer.unref?.()
  network.post = (type, data, { to } = {}) => (peers && typeof to === 'string' && to !== '' && to !== 'hub' && to !== nodeId
    ? link.post(to, type, data)
    : link.post('hub', type, data, to ? { to } : {}))
  network.onReliable = (type, handler) => table.on(type, handler)
  network.reliablePending = () => link.pending()
  network.receiveReliable = (frameType, data) => {
    let checked
    try { checked = frameType === REL_FRAME ? validateRelFrame(data) : frameType === REL_ACK ? validateRelAck(data) : null } catch { checked = null }
    if (checked === null) { log('warn', 'rel frame rejected', { type: frameType }); return }
    void link.receive('hub', frameType, checked)
  }
  const detach = () => {
    clearInterval(timer)
    transport.off?.('online', onOnline)
    transport.off?.('e2e', onE2E)
  }
  return Object.assign(detach, {
    /** A rel/* frame that came straight from node `peerId` (the direct link's own fact of who sent it). */
    receivePeer(peerId, frameType, data) {
      let checked
      try { checked = frameType === REL_FRAME ? validateRelFrame(data) : frameType === REL_ACK ? validateRelAck(data) : null } catch { checked = null }
      if (checked === null || typeof peerId !== 'string' || peerId === '' || peerId === 'hub') { log('warn', 'peer rel frame rejected', { type: frameType }); return }
      void link.receive(peerId, frameType, checked)
    },
    /** A direct link to `peerId` came up: what waits for it goes now. */
    peerReady: peerId => link.peerReady(peerId),
  })
}
