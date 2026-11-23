// router.js — network routing layer for the DSH Bot Network.
//
// Integrates LAN discovery, trust store, and peer-link routing into one surface.
// Priority: LAN peer-direct → relay peer → hub fallback.
//
// This replaces the hub-distributed peer directory with a self-managed one:
// machines learn about each other via LAN beacon and manual pairing,
// not via the hub pushing peer/directory frames.

import { LanBeacon } from '../discovery/lan-beacon.js'
import { TrustStore } from '../pairing/trust-store.js'

/**
 * Create a network router that manages peer discovery and routing.
 *
 * @param {object} opts
 * @param {object} opts.identity           MachineIdentity instance
 * @param {string} opts.peerUrl            This machine's peer WS URL (ws://LAN-IP:8124)
 * @param {string[]} [opts.caps]           Capability strings
 * @param {object} opts.peerRouter         createPeerRouter instance from peer-link.js
 * @param {function} opts.hubFallback      (nodeId, type, data, opts) => boolean — hub send
 * @param {string} [opts.trustStorePath]   override default path
 * @param {function} [opts.log]
 * @returns {NetworkRouter}
 */
export function createNetworkRouter({ identity, peerUrl, caps = [], peerRouter, hubFallback, trustStorePath, log }) {
  const trustStore = new TrustStore(trustStorePath)
  const _log = log ?? (() => {})

  const beacon = new LanBeacon({
    machineId: identity.id,
    peerUrl,
    pubKeyB64: identity.publicKeyB64,
    caps,
    log: _log,
  })

  // When a new peer is discovered via LAN beacon, add it to the peer router's directory.
  // If we have a trust record for this machine, also supply the credential.
  beacon.on('peer', (frame) => {
    const { machineId, peerUrl: url } = frame
    // Update directory unconditionally — URL may have changed
    peerRouter.directory([...currentDirectory(), { nodeId: machineId, url }])
    // Supply credential if we trust this machine
    const rec = trustStore.get(machineId)
    if (rec) peerRouter.credentials([...currentCredentials(), { nodeId: machineId, secret: rec.secret }])
    trustStore.touch(machineId)
  })

  beacon.on('peer-lost', ({ machineId }) => {
    // Remove from directory when beacon times out
    peerRouter.directory(currentDirectory().filter(e => e.nodeId !== machineId))
  })

  // Track directory and credentials separately so we can diff them
  let _directory = []
  let _credentials = []

  function currentDirectory() { return _directory }
  function currentCredentials() { return _credentials }

  // Seed from trust store on startup — machines we've previously paired with
  function seedFromTrustStore() {
    // We don't know their current URLs until they beacon, but we can pre-load credentials
    const creds = trustStore.credentialsSnapshot()
    _credentials = creds
    if (creds.length > 0) peerRouter.credentials(creds)
    _log('info', 'network-router: seeded credentials from trust store', { count: creds.length })
  }

  /**
   * Called when a pairing completes (from PairingServer 'paired' event or pairWith()).
   * Updates the peer router immediately.
   */
  function onPaired({ peerId, peerPubKeyB64, secret, peerUrl: url }) {
    const creds = [..._credentials.filter(c => c.nodeId !== peerId), { nodeId: peerId, secret }]
    _credentials = creds
    peerRouter.credentials(creds)
    if (url) {
      const dir = [..._directory.filter(d => d.nodeId !== peerId), { nodeId: peerId, url }]
      _directory = dir
      peerRouter.directory(dir)
    }
    _log('info', 'network-router: peer paired', { peerId })
  }

  /**
   * Send a frame to a machine. Uses peer-direct if available, hub otherwise.
   * Returns true if accepted for delivery.
   */
  function send(machineId, type, data, opts) {
    return peerRouter.send(machineId, type, data, opts)
  }

  /**
   * Start LAN discovery.
   */
  function start() {
    seedFromTrustStore()
    beacon.start()
    _log('info', 'network-router: started', { machineId: identity.id, peerUrl })
  }

  /**
   * Stop LAN discovery and all peer links.
   */
  function stop() {
    beacon.stop()
    peerRouter.stop()
    _log('info', 'network-router: stopped')
  }

  /**
   * All currently visible peers (from LAN beacon).
   */
  function peers() {
    return beacon.peers()
  }

  /**
   * RTT to a machine (from peer-link, null if not connected).
   */
  function rttOf(machineId) {
    return peerRouter.rttOf(machineId)
  }

  /**
   * Full status snapshot for the UI.
   */
  function snapshot() {
    return {
      machineId: identity.id,
      peers: peers(),
      links: peerRouter.snapshot(),
      trustedCount: trustStore.list().length,
    }
  }

  return { start, stop, send, peers, rttOf, snapshot, onPaired, trustStore }
}
