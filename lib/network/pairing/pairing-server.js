// pairing-server.js — accept pairing requests from remote machines.
//
// Listens on ws://0.0.0.0:8125 for incoming pairing attempts.
// Generates a 6-digit TOTP-style code valid for 5 minutes.
// On successful pairing, stores the TrustRecord and emits 'paired'.

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { MachineIdentity } from '../../identity/machine-identity.js'

export const PAIRING_PORT = 8125
const CODE_VALID_MS = 5 * 60_000

function generateCode() {
  return String(Math.floor(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000)))
}

function deriveSecret(ownPubKeyB64, peerPubKeyB64, nonce) {
  const ownPub = Buffer.from(ownPubKeyB64, 'base64').slice(0, 32)
  const peerPub = Buffer.from(peerPubKeyB64, 'base64').slice(0, 32)
  const combined = Buffer.concat([
    ownPub < peerPub ? ownPub : peerPub,
    ownPub < peerPub ? peerPub : ownPub,
  ])
  const base = createHash('sha256').update(combined).digest()
  return createHmac('sha256', base).update(nonce).digest('hex')
}

export class PairingServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {MachineIdentity} opts.identity
   * @param {import('./trust-store.js').TrustStore} opts.trustStore
   * @param {number} [opts.port]
   * @param {function} [opts.log]
   */
  constructor({ identity, trustStore, port = PAIRING_PORT, log }) {
    super()
    this.identity = identity
    this.trustStore = trustStore
    this.port = port
    this._log = log ?? (() => {})
    this._server = null
    this._wss = null
    this._codes = new Map() // code → { createdAt }
  }

  /**
   * Generate a fresh pairing code. Previous codes remain valid until they expire.
   * @returns {string} 6-digit code
   */
  generateCode() {
    const code = generateCode()
    this._codes.set(code, { createdAt: Date.now() })
    // Prune expired codes
    for (const [c, entry] of this._codes) {
      if (Date.now() - entry.createdAt > CODE_VALID_MS) this._codes.delete(c)
    }
    return code
  }

  /**
   * Start listening for pairing requests.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server = createServer()
      // Lazy-import ws to avoid hard dependency in environments without it
      import('ws').then(({ WebSocketServer }) => {
        this._wss = new WebSocketServer({ server: this._server })
        this._wss.on('connection', (ws) => this._handleConnection(ws))
        this._server.listen(this.port, '0.0.0.0', () => {
          this._log('info', 'pairing server listening', { port: this.port })
          resolve()
        })
        this._server.on('error', reject)
      }).catch(reject)
    })
  }

  stop() {
    this._wss?.close()
    this._server?.close()
    this._codes.clear()
  }

  _handleConnection(ws) {
    let handled = false
    const timer = setTimeout(() => { if (!handled) ws.close(1008, 'timeout') }, 15_000)
    timer.unref?.()

    ws.on('error', () => {})
    ws.on('message', (raw) => {
      if (handled) return
      try {
        const msg = JSON.parse(String(raw))
        if (msg.type !== 'pair-request') { ws.close(1008, 'unexpected message'); return }

        const { code, machineId: peerId, pubKeyB64: peerPubKeyB64, nonce } = msg

        // Validate inputs
        if (typeof code !== 'string' || typeof peerId !== 'string' ||
            typeof peerPubKeyB64 !== 'string' || typeof nonce !== 'string') {
          ws.send(JSON.stringify({ type: 'pair-error', error: 'invalid request' }))
          ws.close(); return
        }

        // Check code
        const entry = this._codes.get(code)
        if (!entry || Date.now() - entry.createdAt > CODE_VALID_MS) {
          ws.send(JSON.stringify({ type: 'pair-error', error: 'invalid or expired code' }))
          ws.close(); return
        }

        handled = true
        clearTimeout(timer)
        this._codes.delete(code)

        // Derive shared secret
        const secret = deriveSecret(this.identity.publicKeyB64, peerPubKeyB64, nonce)

        // Sign the nonce with our private key so the client can verify us
        const sig = this.identity.sign(Buffer.from(nonce, 'hex'))

        // Store trust record
        this.trustStore.set({
          peerId,
          peerPubKeyB64,
          secret,
          pairedAt: Date.now(),
          lastSeen: Date.now(),
        })

        ws.send(JSON.stringify({
          type: 'pair-response',
          machineId: this.identity.id,
          pubKeyB64: this.identity.publicKeyB64,
          sig,
        }))

        ws.close(1000, 'pairing complete')
        this._log('info', 'pairing completed', { peerId })
        this.emit('paired', { peerId, peerPubKeyB64, secret })
      } catch (err) {
        this._log('warn', 'pairing error', { error: err.message })
        ws.send(JSON.stringify({ type: 'pair-error', error: 'internal error' }))
        ws.close()
      }
    })
  }
}
