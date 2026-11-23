// lan-beacon.js — UDP multicast LAN discovery for the DSH Bot Network.
//
// Every machine broadcasts its presence on the local network every 15 seconds.
// Other machines on the same LAN receive these beacons and update their peer directory,
// enabling zero-configuration peer discovery without a central server.
//
// Protocol:
//   Multicast group: 224.0.0.251  port: 8129  (same as dsh-mesh)
//   Frame: UTF-8 JSON, max 1400 bytes (fits in one UDP datagram, below MTU)
//   { type: 'dsh-beacon', v: 1, machineId, peerUrl, pubKeyB64, hostname, caps, ts }
//
// Security: beacons are unauthenticated broadcasts (anyone on the LAN can see them).
// The public key in the beacon is pinned on first contact during pairing — an attacker
// who spoofs a beacon gets no session until they also complete the pairing handshake.

import { createSocket } from 'node:dgram'
import { hostname } from 'node:os'
import { EventEmitter } from 'node:events'

export const BEACON_MULTICAST = '224.0.0.251'
export const BEACON_PORT = 8129
export const BEACON_INTERVAL_MS = 15_000
export const BEACON_TTL_MS = 45_000
export const BEACON_VERSION = 1

/**
 * @typedef {object} BeaconFrame
 * @property {'dsh-beacon'} type
 * @property {1} v
 * @property {string} machineId
 * @property {string} peerUrl      ws:// or wss:// URL for peer-link connections
 * @property {string} pubKeyB64    ed25519 public key (SPKI DER base64)
 * @property {string} hostname
 * @property {string[]} caps       capability strings
 * @property {number} ts           sender's Date.now()
 */

/**
 * LAN beacon service. Emits 'peer' events when a new or updated machine is discovered.
 *
 * @example
 *   const beacon = new LanBeacon({ machineId, peerUrl, pubKeyB64, caps })
 *   beacon.on('peer', ({ machineId, peerUrl, pubKeyB64 }) => {
 *     peerRouter.directory([{ nodeId: machineId, url: peerUrl }])
 *   })
 *   beacon.start()
 *   // later:
 *   beacon.stop()
 */
export class LanBeacon extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.machineId     This machine's ID
   * @param {string} opts.peerUrl       ws:// URL others should connect to
   * @param {string} opts.pubKeyB64     This machine's ed25519 public key
   * @param {string[]} [opts.caps]      Capability strings
   * @param {number}  [opts.intervalMs] Broadcast interval (default 15s)
   * @param {number}  [opts.port]       UDP port (default 8129)
   * @param {string}  [opts.multicast]  Multicast group (default 224.0.0.251)
   * @param {function} [opts.log]       Logger
   */
  constructor({ machineId, peerUrl, pubKeyB64, caps = [], intervalMs = BEACON_INTERVAL_MS, port = BEACON_PORT, multicast = BEACON_MULTICAST, log }) {
    super()
    Object.assign(this, { machineId, peerUrl, pubKeyB64, caps, intervalMs, port, multicast })
    this._log = log ?? (() => {})
    this._socket = null
    this._timer = null
    this._peers = new Map()  // machineId → { beacon, seenAt }
    this._running = false
  }

  /**
   * Start broadcasting and listening.
   */
  start() {
    if (this._running) return
    this._running = true
    this._socket = createSocket({ type: 'udp4', reuseAddr: true })

    this._socket.on('error', (err) => {
      this._log('warn', 'lan-beacon socket error', { error: err.message })
    })

    this._socket.on('message', (msg, rinfo) => {
      try {
        this._handleMessage(msg, rinfo)
      } catch { /* malformed beacon: ignore */ }
    })

    this._socket.bind(this.port, () => {
      try {
        this._socket.addMembership(this.multicast)
        this._socket.setMulticastTTL(1)      // LAN only, do not route past first hop
        this._socket.setMulticastLoopback(false)
      } catch (err) {
        this._log('warn', 'lan-beacon multicast setup failed', { error: err.message })
      }
    })

    // Broadcast immediately, then on interval
    this._broadcast()
    this._timer = setInterval(() => {
      this._broadcast()
      this._evictStale()
    }, this.intervalMs)
    this._timer.unref?.()
  }

  /**
   * Stop broadcasting and close the socket.
   */
  stop() {
    if (!this._running) return
    this._running = false
    clearInterval(this._timer)
    this._timer = null
    try { this._socket?.close() } catch { /* ignore */ }
    this._socket = null
  }

  /**
   * All currently live peers (seen within BEACON_TTL_MS).
   * @returns {BeaconFrame[]}
   */
  peers() {
    return [...this._peers.values()].map(e => e.beacon)
  }

  // ── private ──────────────────────────────────────────────────────────────

  _broadcast() {
    if (!this._socket || !this._running) return
    /** @type {BeaconFrame} */
    const frame = {
      type: 'dsh-beacon',
      v: BEACON_VERSION,
      machineId: this.machineId,
      peerUrl: this.peerUrl,
      pubKeyB64: this.pubKeyB64,
      hostname: hostname(),
      caps: this.caps,
      ts: Date.now(),
    }
    const payload = Buffer.from(JSON.stringify(frame), 'utf8')
    if (payload.length > 1400) {
      this._log('warn', 'lan-beacon frame too large, truncating caps', {})
      frame.caps = []
      const trimmed = Buffer.from(JSON.stringify(frame), 'utf8')
      this._send(trimmed)
      return
    }
    this._send(payload)
  }

  _send(payload) {
    this._socket.send(payload, 0, payload.length, this.port, this.multicast, (err) => {
      if (err) this._log('warn', 'lan-beacon send error', { error: err.message })
    })
  }

  _handleMessage(msg, rinfo) {
    const frame = JSON.parse(msg.toString('utf8'))
    if (frame.type !== 'dsh-beacon' || frame.v !== BEACON_VERSION) return
    if (typeof frame.machineId !== 'string' || frame.machineId === '') return
    if (frame.machineId === this.machineId) return  // ignore own beacons
    if (typeof frame.peerUrl !== 'string' || typeof frame.pubKeyB64 !== 'string') return
    // Basic staleness check: ignore beacons more than 60s old (clock drift tolerance)
    if (typeof frame.ts === 'number' && Date.now() - frame.ts > 60_000) return

    const existing = this._peers.get(frame.machineId)
    const isNew = !existing
    const urlChanged = existing && existing.beacon.peerUrl !== frame.peerUrl
    this._peers.set(frame.machineId, { beacon: frame, seenAt: Date.now() })

    if (isNew || urlChanged) {
      this.emit('peer', frame)
      this._log('info', isNew ? 'lan-beacon: new peer discovered' : 'lan-beacon: peer URL updated', {
        machineId: frame.machineId, peerUrl: frame.peerUrl, host: rinfo.address,
      })
    }
  }

  _evictStale() {
    const cutoff = Date.now() - BEACON_TTL_MS
    for (const [id, entry] of this._peers) {
      if (entry.seenAt < cutoff) {
        this._peers.delete(id)
        this.emit('peer-lost', { machineId: id })
        this._log('info', 'lan-beacon: peer timed out', { machineId: id })
      }
    }
  }
}
