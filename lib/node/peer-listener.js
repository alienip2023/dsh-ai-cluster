import { timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { listCandidateAddresses, startListenServer, resolveListenHost } from '../listen-server.js'
import { PEER, PROTOCOL_VERSION, ERROR_CODE, decodeFrame, encodeFrame, envelope } from '../protocol.js'
import { createSession, generateEphemeral } from '../e2e.js'
import { isPeerRelType, isPeerType, sendPeerFrame } from './peer-link.js'
import { PROOF_SKEW_MS, helloProof, sameProof, validPairKey, welcomeProof } from './peer-auth.js'

export function validPeerSecret(expected, received) {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)
    || typeof received !== 'string' || !/^[0-9a-f]{64}$/.test(received)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))
}

// `getSecret()`: what the hub (`@hub`) must present (legacy, only while the hub link is up). `getPairKey(id)`: the pair
// key a node dialing in as `id` must prove (AC 0.4.40); it is in the node's saved book, so it works while the hub is down.
export function attachPeerConnection(conn, { nodeId, getSecret, getPairKey = () => undefined, onFrame, onReady, remote = '', log = () => {}, helloTimeoutMs = 5000, heartbeatMs = 15_000 }) {
  let session
  let peerId
  let rejected = false
  let managed = false
  let heartbeat
  let lastPong = Date.now()
  let pingAt
  let paired = false
  const channel = new EventEmitter()
  channel.state = 'connecting'
  channel.rttMs = null
  channel.send = (type, data, opts) => isPeerType(type, paired) && sendPeerFrame(conn, session, type, data, opts)
  channel.sendNow = (type, data) => paired && isPeerRelType(type) && channel.state === 'connected' && sendPeerFrame(conn, session, type, data)
  channel.stop = () => conn.destroy()
  const reject = code => {
    if (rejected) return
    rejected = true
    log('warn', code, { remote })
    conn.send(encodeFrame(envelope('error', { code })))
    conn.close(1008, code)
  }
  const timer = setTimeout(() => reject(ERROR_CODE.PEER_AUTH_FAILED), helloTimeoutMs)
  timer.unref?.()
  conn.on('close', () => {
    clearTimeout(timer)
    clearInterval(heartbeat)
    session?.destroy()
    channel.state = 'failed'
    channel.emit('disconnect')
  })
  conn.on('error', () => { clearTimeout(timer); conn.destroy() })
  conn.on('pong', () => { lastPong = Date.now(); if (pingAt !== undefined) channel.rttMs = Math.max(0, lastPong - pingAt) })
  conn.on('message', (raw, binary) => {
    if (rejected) return
    try {
      const decoded = binary ? null : decodeFrame(raw)
      if (!decoded?.ok) { reject('peer-frame-forbidden'); return }
      let frame = decoded.frame
      if (!session) {
        if (frame.t !== PEER.HELLO || frame.d?.protocol !== PROTOCOL_VERSION
          || typeof frame.d.nodeId !== 'string' || !frame.d.nodeId
          || !(frame.d.nodeId === '@hub' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(frame.d.nodeId))
          || !Number.isFinite(frame.d.time)
          || typeof frame.d.pub !== 'string') { reject(ERROR_CODE.PEER_AUTH_FAILED); return }
        // The hub presents this node's secret; a node proves the key of the pair it forms with this one, so the id it
        // claims is the id of the key: a node cannot pass as another (AC 0.4.40).
        const pairKey = frame.d.nodeId === '@hub' ? undefined : getPairKey(frame.d.nodeId)
        const authentic = frame.d.nodeId === '@hub'
          ? validPeerSecret(getSecret(), frame.d.secret)
          : validPairKey(pairKey) && Math.abs(Date.now() - frame.d.time) <= PROOF_SKEW_MS
            && sameProof(helloProof(pairKey, { from: frame.d.nodeId, to: nodeId, time: frame.d.time, pub: frame.d.pub }), frame.d.proof)
        if (!authentic) { reject(ERROR_CODE.PEER_AUTH_FAILED); return }
        paired = pairKey !== undefined
        const eph = generateEphemeral()
        session = createSession({ role: 'hub', ownPrivB64: eph.privateKeyB64,
          peerPubB64: frame.d.pub, nodePubB64: frame.d.pub, hubPubB64: eph.publicKeyB64 })
        peerId = frame.d.nodeId
        clearTimeout(timer)
        conn.send(encodeFrame(envelope(PEER.WELCOME, { nodeId, time: Date.now(), pub: eph.publicKeyB64,
          ...(paired ? { proof: welcomeProof(pairKey, { from: nodeId, to: peerId, dialerPub: frame.d.pub, pub: eph.publicKeyB64 }) } : {}) })))
        channel.state = 'connected'
        channel.rttMs = 0
        managed = onReady?.(peerId, channel) === true
        if (conn.closed) return
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong > heartbeatMs * 3) { conn.destroy(); return }
          pingAt = Date.now()
          if (!conn.ping()) conn.destroy()
        }, heartbeatMs)
        heartbeat.unref?.()
        return
      }
      if (!isPeerType(frame.t, paired)) { reject('peer-frame-forbidden'); return }
      frame = { ...frame, d: session.openFrame(frame.t, frame.id, frame.d) }
      if (managed) channel.emit('frame', frame)
      else onFrame(frame, channel.send, peerId)
    } catch { reject(session ? 'peer-frame-forbidden' : ERROR_CODE.PEER_AUTH_FAILED) }
  })
}

export async function startPeerListener({ nodeId, host = '', port = 19388, getSecret, getPairKey, onFrame, onReady, log }) {
  const listener = await startListenServer({ host: resolveListenHost({ listenHost: host }).host, port,
    path: '/api/remote-agent/peer', log,
    onUpgrade: (conn, req) => attachPeerConnection(conn, { nodeId, getSecret, getPairKey, onFrame, onReady, log, remote: req.socket.remoteAddress ?? '' }),
  })
  const authority = listener.host.includes(':') ? `[${listener.host}]` : listener.host
  return { ...listener, url: `ws://${authority}:${listener.port}/api/remote-agent/peer`, listening: `${authority}:${listener.port}` }
}

/**
 * The address to listen on for other nodes: the one of this machine's addresses on the hub's network (same /24 as the
 * hub's IPv4 address). '' when the hub is not addressed by an IPv4 address or none matches (the listen server then
 * picks: Tailscale, then a private address).
 */
export function peerHostToward(hubUrl, candidates = listCandidateAddresses()) {
  let host
  try { host = new URL(hubUrl).hostname } catch { return '' }
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return ''
  const prefix = `${parts.slice(0, 3).join('.')}.`
  return candidates.find(candidate => typeof candidate?.address === 'string' && candidate.address.startsWith(prefix) && candidate.address !== host)?.address ?? ''
}
