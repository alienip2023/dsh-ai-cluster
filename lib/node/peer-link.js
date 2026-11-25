import { EventEmitter } from 'node:events'
import { connect } from '../ws.js'
import { PEER, PEER_BOT_TYPES, PEER_REL_TYPES, PROTOCOL_VERSION, decodeFrame, encodeFrame, envelope, validateBotTurnResult, validateBotMessage } from '../protocol.js'
import { createSession, generateEphemeral } from '../e2e.js'
import { BOT_MESSAGE_REPLAY_MS } from './bot-network.js'
import { FrameRttRing } from './frame-rtt.js'
import { helloProof, sameProof, validPairKey, welcomeProof } from './peer-auth.js'

export const PEER_MAX_BUFFER = 2 * 1024 * 1024
export const isPeerBotType = type => PEER_BOT_TYPES.includes(type)
export const isPeerRelType = type => PEER_REL_TYPES.includes(type)
/** What may cross a direct link: Bot frames, and between two nodes holding a pair key also the reliable link's. */
export const isPeerType = (type, paired) => isPeerBotType(type) || (paired === true && isPeerRelType(type))

export function sendPeerFrame(conn, session, type, data, opts) {
  if (!conn || conn.closed || conn.bufferedBytes > PEER_MAX_BUFFER) return false
  const frame = envelope(type, data, opts)
  frame.d = session.sealFrame(type, frame.id, frame.d)
  return conn.send(encodeFrame(frame)) === true
}

/** One lazy outbound connection per destination. Business frames reuse the existing E2E codec. */
export class PeerLink extends EventEmitter {
  // `pairKey`: a node dialing a node proves the pair's key (peer-auth.js); `secret`: the hub dialing a node (legacy).
  constructor({ nodeId, remoteNodeId, url, secret, pairKey, connectFn = connect, timeoutMs = 800, heartbeatMs = 15_000 }) {
    super()
    Object.assign(this, { nodeId, remoteNodeId, url, secret, pairKey, connectFn, timeoutMs, heartbeatMs })
    this.paired = validPairKey(pairKey)
    this.state = 'idle'
    this.rttMs = null
    this.frameRtt = new FrameRttRing()
    this.stopped = false
  }

  ready() {
    if (this.stopped) return Promise.reject(new Error('peer stopped'))
    if (this.state === 'connected' && !this.conn?.closed) return Promise.resolve()
    if (this.connecting) return this.connecting
    this.state = 'connecting'
    this.connecting = this.open().finally(() => { this.connecting = null })
    return this.connecting
  }

  open() {
    return new Promise((resolve, reject) => {
      let settled = false
      const eph = generateEphemeral()
      const started = Date.now()
      const fail = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.state = 'failed'
        this.conn?.destroy()
        reject(new Error('peer connection or handshake failed'))
      }
      this.cancelOpen = fail
      const timer = setTimeout(fail, this.timeoutMs)
      timer.unref?.()
      Promise.resolve().then(() => this.connectFn(this.url, { timeoutMs: this.timeoutMs, name: `peer:${this.remoteNodeId}` })).then(conn => {
        if (settled || this.stopped) { conn.destroy(); return }
        this.conn = conn
        conn.on('error', () => { if (!settled) fail(); else conn.destroy() })
        conn.on('close', () => {
          if (this.conn !== conn) return
          clearInterval(this.heartbeat)
          this.session?.destroy()
          this.session = null
          this.state = this.stopped ? 'idle' : 'failed'
          fail()
          this.emit('disconnect')
        })
        conn.on('pong', () => {
          this.lastPong = Date.now()
          if (this.pingAt !== undefined) {
            this.rttMs = Math.max(0, this.lastPong - this.pingAt)
            this.frameRtt.push(this.rttMs)
          }
        })
        conn.on('message', (raw, binary) => {
          try {
            const decoded = binary ? null : decodeFrame(raw)
            if (!decoded?.ok) throw new Error('invalid peer frame')
            let frame = decoded.frame
            if (!this.session) {
              if (frame.t !== PEER.WELCOME || frame.d?.nodeId !== this.remoteNodeId) throw new Error('invalid peer welcome')
              // The listener proves it holds the pair's key over both ephemeral keys: no one in between can answer.
              if (this.paired && !sameProof(welcomeProof(this.pairKey, { from: this.remoteNodeId, to: this.nodeId, dialerPub: eph.publicKeyB64, pub: frame.d.pub }), frame.d.proof)) throw new Error('invalid peer welcome proof')
              this.session = createSession({ role: 'node', ownPrivB64: eph.privateKeyB64,
                peerPubB64: frame.d.pub, nodePubB64: eph.publicKeyB64, hubPubB64: frame.d.pub })
              settled = true
              clearTimeout(timer)
              this.cancelOpen = null
              this.state = 'connected'
              this.rttMs = Math.max(0, Date.now() - started)
              this.lastPong = Date.now()
              this.heartbeat = setInterval(() => {
                if (Date.now() - this.lastPong > this.heartbeatMs * 3) { conn.destroy(); return }
                this.pingAt = Date.now()
                if (!conn.ping()) conn.destroy()
              }, this.heartbeatMs)
              this.heartbeat.unref?.()
              resolve()
              this.emit('connected')
              return
            }
            if (!isPeerType(frame.t, this.paired)) throw new Error('peer frame forbidden')
            frame = { ...frame, d: this.session.openFrame(frame.t, frame.id, frame.d) }
            this.emit('frame', frame)
          } catch {
            if (!settled) fail()
            conn.send(encodeFrame(envelope('error', { code: 'peer-frame-forbidden' })))
            conn.close(1008, 'peer frame rejected')
          }
        })
        const time = Date.now()
        const auth = this.paired
          ? { proof: helloProof(this.pairKey, { from: this.nodeId, to: this.remoteNodeId, time, pub: eph.publicKeyB64 }) }
          : { secret: this.secret }
        if (!conn.send(encodeFrame(envelope(PEER.HELLO, { nodeId: this.nodeId, protocol: PROTOCOL_VERSION,
          ...auth, time, pub: eph.publicKeyB64 })))) fail()
      }).catch(fail)
    })
  }

  async send(type, data, opts) {
    if (!isPeerBotType(type)) return false
    try {
      await this.ready()
      return !this.stopped && sendPeerFrame(this.conn, this.session, type, data, opts)
    } catch { return false }
  }

  /** A reliable-link frame on the open connection now; false when it is not open (the link tries again later). */
  sendNow(type, data) {
    if (!this.paired || !isPeerRelType(type) || this.stopped || this.state !== 'connected' || !this.session) return false
    return sendPeerFrame(this.conn, this.session, type, data)
  }

  stop() {
    this.stopped = true
    clearInterval(this.heartbeat)
    this.cancelOpen?.()
    this.conn?.destroy()
    this.session?.destroy()
    this.state = 'idle'
  }
}

/** Preserve the synchronous send contract: true means accepted for delivery. */
//
// AC 0.4.40: the router also carries the reliable link between two nodes. `relState` says whether a direct link to a
// node is up (and dials one when it is not, at most every `redialMs`), `sendRel` writes a frame on it, `onRel` gets
// the frames that come in, `onConnected` says a link came up so what waits for that node goes now.
export function createPeerRouter({ nodeId, fallback, onFrame, onRel, onConnected, log = () => {}, makeLink = opts => new PeerLink(opts),
  redialMs = 30_000, now = Date.now }) {
  const links = new Map()
  const directory = new Map()
  const pending = new Set()
  let credentials = new Map()
  let stopped = false
  const lastDial = new Map()
  const counts = new Map()   // nodeId → { direct, viaHub }: how reliable frames to it went
  const keyOf = cred => cred?.pairKey ?? cred?.secret
  const linkKey = link => link.pairKey ?? link.secret
  const dial = target => {
    const cred = credentials.get(target)
    const link = makeLink({ nodeId, remoteNodeId: target, url: directory.get(target), ...(cred?.pairKey ? { pairKey: cred.pairKey } : { secret: cred?.secret }) })
    bind(target, link)
    return link
  }
  const bind = (target, link) => {
    link.on?.('connected', () => { if (links.get(target) === link) onConnected?.(target) })
    link.on('frame', frame => {
      if (isPeerRelType(frame.t)) { onRel?.(target, frame.t, frame.d); return }
      if (frame.t === 'bot/turn-result') {
        const checked = validateBotTurnResult(frame.d)
        if (!checked.ok || checked.result.nodeId !== target) throw new Error('invalid peer result')
      }
      if (frame.t === 'bot/message' && validateBotMessage(frame.d).from.nodeId !== target) throw new Error('invalid peer sender')
      for (const request of pending) {
        if (request.link === link && request.data.exchangeId === frame.d?.exchangeId
          && ((request.type === 'bot/turn' && frame.t === 'bot/turn-result')
            || (request.type === 'bot/message' && frame.t === 'bot/message' && frame.d?.kind === 'reply'))) {
          request.completed = true
          pending.delete(request)
        }
      }
      onFrame?.(frame, target, (replyType, result, replyOpts) => link.send(replyType, result, replyOpts))
    })
    link.on('disconnect', () => {
      for (const request of [...pending]) if (request.link === link) request.fail()
    })
    links.set(target, link)
  }
  return {
    has(target) { return directory.has(target) },
    adopt(target, link) {
      if (stopped || !directory.has(target)) return false
      const previous = links.get(target)
      // Simultaneous dials converge on the socket initiated by the smaller nodeId.
      if (previous && ['connected', 'connecting'].includes(previous.state) && nodeId < target) { link.stop(); return true }
      previous?.stop()
      link.url = directory.get(target)
      link.inbound = true
      bind(target, link)
      if (link.state === 'connected') onConnected?.(target)
      return true
    },
    directory(peers) {
      directory.clear()
      for (const peer of peers ?? []) if (peer.nodeId !== nodeId) directory.set(peer.nodeId, peer.url)
      for (const [id, link] of links) {
        if (directory.get(id) !== link.url) { link.stop(); links.delete(id) }
      }
    },
    // `[{ nodeId, pairKey }]` between nodes, `[{ nodeId, secret }]` for the hub's own dials (legacy).
    credentials(peers) {
      credentials = new Map((peers ?? []).filter(peer => peer.nodeId !== nodeId)
        .map(peer => [peer.nodeId, peer.pairKey ? { pairKey: peer.pairKey } : { secret: peer.secret }]))
      for (const [id, link] of links) {
        if (!link.inbound && keyOf(credentials.get(id)) !== linkKey(link)) { link.stop(); links.delete(id) }
        else if (link.inbound && !credentials.has(id)) { link.stop(); links.delete(id) }
      }
    },
    /** The pair key a node dialing in as `id` must prove (undefined: not a known peer). */
    pairKeyOf(id) { return credentials.get(id)?.pairKey },
    /** 'connected' | 'connecting' | 'down' (dialed lately, failed) | 'none' (no address or key for it). */
    relState(target) {
      if (stopped || !directory.has(target) || !credentials.get(target)?.pairKey) return 'none'
      let link = links.get(target)
      if (link?.state === 'connected') return 'connected'
      if (link?.state === 'connecting' && !link.inbound) return 'connecting'
      const at = now()
      if (lastDial.has(target) && at - lastDial.get(target) < redialMs) return 'down'
      lastDial.set(target, at)
      if (!link || link.inbound) { link?.stop?.(); link = dial(target) }
      void Promise.resolve().then(() => link.ready()).catch(() => {})
      return 'connecting'
    },
    sendRel(target, type, data) {
      if (stopped || !isPeerRelType(type)) return false
      const link = links.get(target)
      if (link?.state !== 'connected') return false
      return (link.sendNow ? link.sendNow(type, data) : link.send(type, data)) === true
    },
    noteRoute(target, via) {
      const count = counts.get(target) ?? { direct: 0, viaHub: 0, lastDirectAt: null }
      if (via === 'direct') { count.direct += 1; count.lastDirectAt = now() } else count.viaHub += 1
      counts.set(target, count)
    },
    send(target, type, data, opts) {
      if (stopped) return false
      if (!isPeerBotType(type) || !directory.has(target)) return fallback(target, type, data, opts)
      let link = links.get(target)
      if (!link || (link.inbound && link.state !== 'connected')) {
        if (!keyOf(credentials.get(target))) {
          log('warn', 'peer-direct-fallback', { nodeId: target, type })
          return fallback(target, type, data, opts)
        }
        link = dial(target)
      }
      let failed = false
      const request = { link, data, type, at: Date.now(), ttlMs: type === 'bot/message' ? BOT_MESSAGE_REPLAY_MS : 300_000, fail: () => {
        pending.delete(request)
        if (failed || stopped || request.completed || Date.now() - request.at >= request.ttlMs) return
        failed = true
        log('warn', 'peer-direct-fallback', { nodeId: target, type })
        try { fallback(target, type, data, opts) } catch { /* fallback is attempted exactly once */ }
      } }
      for (const item of pending) if (Date.now() - item.at >= item.ttlMs) pending.delete(item)
      if (pending.size >= 512) pending.values().next().value.fail()
      pending.add(request)
      // A successful write only queues bytes; TCP may report the disconnect later.
      // Keep turns/messages replayable, including forwarded asks and replies
      // whose response never traverses this link. The bounded window above limits
      // retention; message replay expires within the receiver's dedupe window.
      void Promise.resolve().then(() => link.send(type, data, opts)).catch(() => false).then(ok => {
        if (!ok) request.fail()
        else if (type === 'bot/turn-result') pending.delete(request)
      })
      return true
    },
    rttOf(nodeId) {
      return links.get(nodeId)?.rttMs ?? null
    },
    frameRttOf(nodeId) {
      return links.get(nodeId)?.frameRtt?.snapshot() ?? []
    },
    snapshot() {
      return [...directory.keys()].map(id => ({ nodeId: id, state: links.get(id)?.state ?? 'idle', rttMs: links.get(id)?.rttMs ?? null,
        ...(counts.has(id) ? { routes: { ...counts.get(id) } } : {}) }))
    },
    stop() { stopped = true; pending.clear(); for (const link of links.values()) link.stop(); links.clear(); directory.clear(); credentials.clear() },
  }
}
