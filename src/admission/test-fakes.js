// Isolated regression harness. This module is never imported by the shipped entry.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTicketStore } from '../tickets/index.js'
export { createTicketStore }

const fakeNow = () => 1_700_000_000_000
const noop = () => {}
export const SCOPED = 'NodeA'
export const OUTSIDE = 'NodeB'
export const goal = 'fake task'
export const policy = { mode: 'explicit', actions: ['dispatch'], targets: ['target-a'], allow: [{ action: 'dispatch', target: 'target-a' }] }
export const config = (overrides = {}) => ({
  enabled: true, scope: { nodes: [SCOPED] }, aliases: { [SCOPED]: 'target-a' },
  sources: ['fake'], ledgerDir: '/fake-ac2-ledger', policy, ...overrides,
})
export const identity = eventId => ({
  origin: { source: 'fake', eventId, thread: 'fake-thread', identityRef: 'fake-person' },
  replyTo: { kind: 'fake', conversationId: 'fake-conversation', requesterRef: 'fake-requester' },
})
export const resolverFor = (eventId = 'event-1') => ({ resolve: () => ({ ok: true, work: identity(eventId) }) })
export const deferred = () => Promise.withResolvers()

export function memoryFs(entries = []) {
  const files = new Map(entries.map(([file, base64]) => [file, Buffer.from(base64, 'base64')]))
  const handles = new Map()
  const trace = []
  let fd = 0
  const err = code => Object.assign(new Error(code), { code })
  const fsOps = {
    mkdirSync: noop,
    openSync(file, mode) {
      const name = path.basename(file)
      if (name === 'ledger.lock') trace.push(files.has(file) ? 'lock:busy' : 'lock:acquired')
      if (mode === 'wx' && files.has(file)) throw err('EEXIST')
      if (mode !== 'r' && !files.has(file)) files.set(file, Buffer.alloc(0))
      handles.set(++fd, file)
      return fd
    },
    readFileSync(file) {
      if (!files.has(file)) throw err('ENOENT')
      return files.get(file)
    },
    readdirSync(dir) { return [...files.keys()].filter(file => path.dirname(file) === dir).map(file => path.basename(file)) },
    writeSync(id, bytes, offset, length) {
      const file = handles.get(id)
      files.set(file, Buffer.concat([files.get(file), bytes.subarray(offset, offset + length)]))
      trace.push(`write:${path.basename(file)}`)
      return length
    },
    fsyncSync(id) { trace.push(`fsync:${path.basename(handles.get(id))}`) },
    closeSync(id) { handles.delete(id) },
    unlinkSync(file) {
      if (!files.delete(file)) throw err('ENOENT')
      if (path.basename(file) === 'ledger.lock') trace.push('lock:released')
    },
    renameSync(from, to) { files.set(to, fsOps.readFileSync(from)); files.delete(from) },
  }
  return {
    fsOps, trace,
    bytes: () => [...files].map(([file, bytes]) => [file, bytes.toString('base64')]),
    rows: () => [...files].filter(([file]) => path.basename(file) === 'ledger.jsonl')
      .flatMap(([, bytes]) => bytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))),
  }
}

export function ledgerHarness(options = {}) {
  const memory = options.memory ?? memoryFs()
  const calls = []
  const ledgers = []
  const audit = []
  const logs = []
  const retries = []
  const deps = {
    fsOps: memory.fsOps, now: fakeNow, resolver: resolverFor(),
    audit: (event, fields) => audit.push({ event, ...fields }),
    log: (level, msg, fields) => logs.push({ level, msg, ...fields }),
    wait: async ms => { retries.push(ms) },
    openStore(args) {
      calls.push('open')
      const store = createTicketStore(args)
      ledgers.push(store)
      return {
        ...store,
        async accept(work) {
          if (options.accept) return options.accept(work)
          const result = await store.accept(work)
          calls.push('accept')
          return result
        },
        markInterrupted(id, reason) { calls.push(['interrupt', id, reason]); return store.markInterrupted(id, reason) },
        end(...args) { calls.push('end'); return store.end(...args) },
        close() {
          calls.push('close')
          return options.close ? options.close(store) : store.close()
        },
      }
    },
    ...options.deps,
  }
  return { ...memory, deps, calls, audit, logs, retries, ledgers }
}

export function fakeHost() {
  const tools = new Map()
  const routes = new Map()
  const register = (map, key) => definition => {
    const name = definition[key]
    if (map.has(name)) throw new Error(`Already registered: ${name}`)
    map.set(name, definition)
    return () => map.delete(name)
  }
  return {
    tools, routes,
    ctx: { tools: { register: register(tools, 'name') }, webServer: { register: register(routes, 'path') } },
    tool: (name, args, exec) => tools.get(name).execute(args, exec),
    async post(route, body) {
      let status, value
      const req = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
      await routes.get(route).handler(req, {
        writeHead(code) { status = code }, end(data) { value = JSON.parse(data) },
      })
      return { status, value }
    },
  }
}

export async function modules(root = path.resolve(import.meta.dirname, '../..')) {
  const load = file => import(pathToFileURL(path.join(root, file)))
  const [tools, registry, routes, subagent, publicHub, legacyRoutes, legacyTools, protocol] = await Promise.all([
    load('src/tools/register.js'), load('lib/hub/node-registry.js'), load('src/http/routes.js'),
    load('lib/hub/subagent-provider.js'), load('lib/hub/index.js'), load('lib/hub/ui-routes.js'),
    load('lib/hub/tools.js'), load('lib/protocol.js'),
  ])
  return {
    ...tools, ...registry, ...routes, ...subagent, ...protocol,
    publicHub, legacyRoutes: legacyRoutes.registerUiRoutes, legacyTools: legacyTools.registerRemoteTools,
  }
}

export function fakeRegistry(m, { calls = [], audit = [], nodeIds = [SCOPED, OUTSIDE], ack } = {}) {
  const registry = new m.NodeRegistry({ limits: { approvalTimeoutMs: 0 }, audit: { record: (event, fields) => audit.push({ event, ...fields }) } })
  const frames = []
  for (const nodeId of nodeIds) {
    registry.nodes.set(nodeId, {
      nodeId, hello: { roots: ['/fake-root'], caps: [], host: nodeId }, online: true, tasks: new Map(),
      conn: { closed: false, send: text => { frames.push(text); calls.push('send') } },
    })
  }
  const createTask = registry.createTask.bind(registry)
  registry.createTask = request => { calls.push('createTask'); return createTask(request) }
  registry.awaitAccepted = (id, opts) => {
    calls.push('awaitAccepted')
    return ack ? ack(id, opts) : Promise.resolve({ accepted: true, status: 'accepted' })
  }
  registry.awaitTerminal = async taskId => { calls.push('awaitTerminal'); return { ...registry.getTask(taskId), status: 'completed' } }
  return { registry, calls, frames }
}

export const currentRoutes = ['/api/ai-cluster/ui/dispatch', '/api/remote-agent/ui/dispatch']
export const legacyRoute = currentRoutes[1]

// A fresh process fixes the wire ID counters as well as the clock and RNG, so
// the captured frames can be compared byte for byte without rewriting IDs.
async function capture(root, enabled) {
  Date.now = fakeNow
  Math.random = () => 0.125
  const m = await modules(root)
  const admission = enabled ? (await import('./index.js')).createAdmission(config(), ledgerHarness().deps) : null
  await admission?.ready
  const captures = {}
  const args = node => ({ node, goal, mode: 'exec', approval: 'auto' })
  for (const [entry, invoke] of [
    ...['cluster_task', 'remote_task'].map(name => [name, (host, _registry, node) => host.tool(name, args(node))]),
    ...['cluster_task_batch', 'remote_task_batch'].map(name => [name, (host, _registry, node) => host.tool(name, { tasks: [args(node)], approval: 'auto' })]),
    ...currentRoutes.map(route => [route, (host, _registry, node) => host.post(route, args(node))]),
    ['subagent', async (_host, registry, node) => {
      const { id, result } = await m.createRemoteAgentProvider({ registry }).start({ label: node, prompt: goal })
      return { id, result: await result }
    }],
    ['./hub legacy UI', (host, _registry, node) => host.post(legacyRoute, args(node))],
    ['legacy remote_task', (host, _registry, node) => host.tool('remote_task', args(node))],
    ['registry', (_host, registry, node) => registry.createTask({ nodeId: node, spec: m.validateTaskStart({ taskId: 'fake-id', goal }).spec }).taskId],
  ]) {
    const host = fakeHost()
    const { registry, calls, frames } = fakeRegistry(m, { nodeIds: [OUTSIDE] })
    if (admission) registry.checkTaskAdmission = admission.checkTaskAdmission
    const options = { ctx: host.ctx, registry, log: noop }
    if (entry === './hub legacy UI') m.legacyRoutes(options)
    else if (entry === 'legacy remote_task') m.legacyTools(options)
    else {
      m.registerUiRoutes({ ...options, admission })
      m.registerClusterTools({ ...options, admission })
    }
    try {
      captures[entry] = { value: await invoke(host, registry, OUTSIDE), calls, frames }
    } catch (error) {
      captures[entry] = { error: error.message, calls, frames }
    }
  }
  admission?.dispose()
  return captures
}

if (process.argv[2] === '--ac2-capture') {
  process.stdout.write(JSON.stringify(await capture(process.argv[3], process.argv[4] === 'enabled')))
} else if (process.argv[2] === '--ac2-crash') {
  const m = await modules()
  const { createAdmission } = await import('./index.js')
  const h = ledgerHarness()
  const host = fakeHost()
  const { registry, frames, calls } = fakeRegistry(m, { calls: h.calls })
  const admission = createAdmission(config(), h.deps)
  await admission.ready
  registry.checkTaskAdmission = admission.checkTaskAdmission
  registry.getNode(SCOPED).hello.caps.push('selfcheck')
  registry.fsRequest = () => {
    // Selfcheck is the first step after S1. Terminate without dispose or any
    // chance for createTask, preserving the fake file image for replay.
    process.stdout.write(JSON.stringify({ bytes: h.bytes(), frames, calls, trace: h.trace }), () => process.exit(73))
    return new Promise(() => {})
  }
  m.registerClusterTools({ ctx: host.ctx, registry, admission })
  void host.tool('cluster_task', { node: SCOPED, goal })
}
