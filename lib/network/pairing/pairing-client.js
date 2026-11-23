// pairing-client.js — initiate pairing with a remote machine.
//
// The user has a pairing code from the remote machine and its address.
// This module connects, presents the code, and stores the resulting TrustRecord.

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { MachineIdentity } from '../../identity/machine-identity.js'
import { connect } from '../../ws.js'

export const PAIRING_PORT = 8125

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

/**
 * Pair with a remote machine.
 *
 * @param {object} opts
 * @param {string} opts.code             6-digit pairing code from the remote machine
 * @param {string} opts.peerAddress      e.g. '192.168.1.5' or 'relay.example.com'
 * @param {number} [opts.peerPort]       default 8125
 * @param {MachineIdentity} opts.identity
 * @param {import('./trust-store.js').TrustStore} opts.trustStore
 * @param {number} [opts.timeoutMs]      default 15000
 * @returns {Promise<{ peerId: string, peerPubKeyB64: string, secret: string }>}
 */
export async function pairWith({ code, peerAddress, peerPort = PAIRING_PORT, identity, trustStore, timeoutMs = 15_000 }) {
  const url = `ws://${peerAddress}:${peerPort}`
  const nonce = randomBytes(16).toString('hex')

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (reason) => {
      if (settled) return
      settled = true
      reject(new Error(reason))
    }

    const timer = setTimeout(() => fail('pairing timeout'), timeoutMs)
    timer.unref?.()

    connect(url, { timeoutMs, name: 'pairing-client' }).then(conn => {
      if (settled) { conn.destroy(); return }

      conn.on('error', () => fail('connection error'))
      conn.on('close', () => { if (!settled) fail('connection closed unexpectedly') })

      conn.on('message', (raw) => {
        if (settled) return
        try {
          const msg = JSON.parse(String(raw))
          if (msg.type === 'pair-error') { fail(`pairing rejected: ${msg.error}`); return }
          if (msg.type !== 'pair-response') { fail('unexpected message type'); return }

          const { machineId: peerId, pubKeyB64: peerPubKeyB64, sig } = msg

          // Verify the server's signature over the nonce we sent
          const sigValid = MachineIdentity.verify(peerPubKeyB64, Buffer.from(nonce, 'hex'), sig)
          if (!sigValid) { fail('signature verification failed — possible MITM'); return }

          // Derive shared secret
          const secret = deriveSecret(identity.publicKeyB64, peerPubKeyB64, nonce)

          // Store trust record
          trustStore.set({
            peerId,
            peerPubKeyB64,
            secret,
            pairedAt: Date.now(),
            lastSeen: Date.now(),
          })

          settled = true
          clearTimeout(timer)
          conn.close(1000, 'pairing complete')
          resolve({ peerId, peerPubKeyB64, secret })
        } catch (err) {
          fail(`pairing error: ${err.message}`)
        }
      })

      // Send pairing request
      conn.send(JSON.stringify({
        type: 'pair-request',
        code,
        machineId: identity.id,
        pubKeyB64: identity.publicKeyB64,
        nonce,
      }))
    }).catch(err => fail(`connection failed: ${err.message}`))
  })
}
