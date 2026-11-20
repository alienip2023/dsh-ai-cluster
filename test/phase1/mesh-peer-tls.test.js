import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import test from 'node:test'
import { NodeRegistry } from '../../lib/hub/node-registry.js'
import { HUB_TO_NODE, NODE_TO_HUB, PROTOCOL_VERSION, decodeFrame, encodeFrame, envelope } from '../../lib/protocol.js'
import { WSConnection } from '../../lib/ws.js'
import { generateCert, PEER_PINS_FILE_NAME, savePeerPin } from '../../src/trust/tls.js'

const nodeId = 'peer-node'
const deadline = () => ({ signal: AbortSignal.timeout(3000) })

async function startHub(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-peer-tls-'))
  const registry = new NodeRegistry({ stateDir })
  const sockets = new Set()
  const peers = new EventEmitter()
  let server
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
    registry.dispose()
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  async function credentials(name) {
    const { certFile, keyFile, fingerprint256 } = await generateCert({ stateDir: path.join(stateDir, name) })
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), fingerprint256 }
  }

  const [host, original, replacement] = await Promise.all(['host', 'original', 'replacement'].map(credentials))
  server = tls.createServer({ cert: host.cert, key: host.key, requestCert: true, rejectUnauthorized: false }, (socket) => {
    sockets.add(socket)
    const conn = new WSConnection(socket, { mask: false })
    registry.attachDirect(conn)
    peers.emit('attached', conn)
  })
  const listening = once(server, 'listening', deadline())
  server.listen(0, '127.0.0.1')
  await listening

  async function connect({ cert, key }) {
    const attached = once(peers, 'attached', deadline())
    const socket = tls.connect({ host: '127.0.0.1', port: server.address().port, ca: host.cert, cert, key })
    sockets.add(socket)
    const client = new WSConnection(socket, { mask: true })
    const [peer] = await attached
    return {
      client,
      peer,
      sendHello() {
        const handled = once(peer, 'message', deadline())
        client.send(encodeFrame(envelope(NODE_TO_HUB.HELLO, {
          nodeId, os: 'linux', protocol: PROTOCOL_VERSION,
          fingerprint256: original.fingerprint256,
        })))
        return handled
      },
    }
  }

  async function seedPin() {
    await savePeerPin(stateDir, { nodeId, fingerprint: original.fingerprint256 })
    return fs.readFileSync(path.join(stateDir, PEER_PINS_FILE_NAME), 'utf8')
  }

  return { registry, connect, seedPin, original, replacement, pinFile: path.join(stateDir, PEER_PINS_FILE_NAME) }
}

async function helloReply(conn) {
  const response = once(conn.client, 'message', deadline())
  await conn.sendHello()
  const [payload] = await response
  const decoded = decodeFrame(payload)
  assert.equal(decoded.ok, true)
  return decoded.frame
}

test('首次通过', async (t) => {
  const hub = await startHub(t)
  assert.equal(fs.existsSync(hub.pinFile), false)
  const conn = await hub.connect(hub.original)
  assert.equal((await helloReply(conn)).t, HUB_TO_NODE.WELCOME)
  assert.equal(hub.registry.nodes.get(nodeId)?.online, true)
  const table = JSON.parse(fs.readFileSync(hub.pinFile, 'utf8'))
  assert.equal(table.pins[nodeId].fingerprint, hub.original.fingerprint256)
  if (process.platform !== 'win32') assert.equal(fs.statSync(hub.pinFile).mode & 0o777, 0o600)
})

test('同指纹通过', async (t) => {
  const hub = await startHub(t)
  const before = await hub.seedPin()
  const conn = await hub.connect(hub.original)
  assert.equal((await helloReply(conn)).t, HUB_TO_NODE.WELCOME)
  assert.equal(hub.registry.nodes.get(nodeId)?.online, true)
  assert.equal(fs.readFileSync(hub.pinFile, 'utf8'), before)
})

test('换指纹拒绝', async (t) => {
  const hub = await startHub(t)
  const before = await hub.seedPin()
  const active = await hub.connect(hub.original)
  assert.equal((await helloReply(active)).t, HUB_TO_NODE.WELCOME)
  const conn = await hub.connect(hub.replacement)
  const closed = once(conn.client, 'close', deadline())
  const [reply, [closeCode]] = await Promise.all([helloReply(conn), closed])
  assert.equal(reply.t, HUB_TO_NODE.ERROR)
  assert.equal(reply.d.code, 'E_PIN_MISMATCH')
  assert.equal(closeCode, 1008)
  const [attempt] = hub.registry.connectionReport().recent
  assert.equal(attempt.result, 'fail')
  assert.equal(attempt.code, 'E_PIN_MISMATCH')
  assert.equal(attempt.message, 'peer TLS certificate fingerprint changed')
  assert.equal(hub.registry.nodes.get(nodeId)?.conn, active.peer)
  assert.equal(fs.readFileSync(hub.pinFile, 'utf8'), before)
})

test('拒绝后不在线', async (t) => {
  const hub = await startHub(t)
  const first = await hub.connect(hub.original)
  assert.equal((await helloReply(first)).t, HUB_TO_NODE.WELCOME)
  const disconnected = once(first.peer, 'close', deadline())
  first.client.close(1000, 'reconnect')
  await disconnected
  const record = hub.registry.nodes.get(nodeId)
  assert.equal(record.online, false)

  const online = []
  hub.registry.on('nodeOnline', (event) => online.push(event))
  const changed = await hub.connect(hub.replacement)
  await changed.sendHello()
  assert.equal(hub.registry.nodes.get(nodeId), record)
  assert.equal(record.online, false)
  assert.equal(record.conn, undefined)
  assert.deepEqual(online, [])
})
