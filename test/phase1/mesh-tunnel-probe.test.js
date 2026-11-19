import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { collectConnectivity } from '../../src/roster/connectivity.js'

const frpc = `serverAddr = "frps.example"
serverPort = 7000
[[proxies]]
localPort = 25565
remotePort = 35565
`
const absent = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }

function fixture({ readFile = async () => frpc, errorCode } = {}) {
  const connects = []
  const options = {
    dshHome: '/fixture/dsh',
    platform: 'linux',
    readFile,
    readdir: absent,
    net: { connect(address) {
      connects.push(address)
      const socket = new EventEmitter()
      socket.destroy = () => {}
      queueMicrotask(() => {
        if (errorCode) socket.emit('error', Object.assign(new Error('connect failed'), { code: errorCode }))
        else socket.emit('connect')
      })
      return socket
    } },
  }
  return { options, connects }
}

test('TUN-17 probes local listen port', async () => {
  const { options, connects } = fixture()
  const address = { host: '127.0.0.1', port: 25565 }
  const message = 'TUN-17: probe target must be the local listen port'
  const sample = await collectConnectivity(options)
  assert.deepEqual(connects, [address], message)
  assert.equal(sample.probes.length, 1, message)
  assert.equal(sample.probes[0].target, '127.0.0.1:25565', message)
  assert.equal(sample.probes[0].result, 'open')
  assert.ok(Number.isFinite(sample.probes[0].rttMs) && sample.probes[0].rttMs >= 0)

  const repeated = await collectConnectivity(options)
  assert.deepEqual(connects, [address], message)
  assert.deepEqual(repeated, sample, message)

  const duplicate = await collectConnectivity({ ...options, config: { probeHosts: ['127.0.0.1:25565'] } })
  assert.deepEqual(connects, [address, address], message)
  assert.equal(duplicate.probes.length, 1, message)
})

test('TUN-17 does not probe without a config', async () => {
  const { options, connects } = fixture({ readFile: absent })
  const sample = await collectConnectivity(options)
  const message = 'TUN-17: no config must not probe'
  assert.deepEqual(connects, [], message)
  assert.deepEqual(sample.probes, [], message)
  assert.equal(sample.tunnel, null, message)
  assert.equal(sample.tunnelState, 'none', message)
})

test('TUN-17 failure is not never', async () => {
  for (const [errorCode, expected] of [['ECONNREFUSED', 'closed'], ['ETIMEDOUT', 'timeout']]) {
    const { options } = fixture({ errorCode })
    const sample = await collectConnectivity(options)
    const message = 'TUN-17: failure must not set never'
    assert.equal(sample.probes[0]?.result, expected, message)
    assert.equal('never' in sample, false, message)
    assert.equal('never' in sample.probes[0], false, message)
  }
})

test('TUN-17 does not mark ready', async () => {
  for (const errorCode of [undefined, 'ECONNREFUSED']) {
    const { options } = fixture({ errorCode })
    const sample = await collectConnectivity(options)
    assert.equal(sample.tunnelState, 'configured', 'TUN-17: open port must not set ready')
  }
})
