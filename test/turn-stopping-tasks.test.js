/**
 * Stress round 3, D1: a turn ending must not cancel the exec (command) tasks it dispatched. The tool says
 * the task "runs persistently on the node"; the agent/turn-stopping hook used to cancel every running task
 * of the session at once, so long commands vanished when the dispatching turn ended. Agent-mode tasks still
 * follow their session (nobody is left to receive their report); cluster_cancel stops an exec task.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'

function fixture() {
  const handlers = {}
  const provided = {}
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on(name, fn) { handlers[name] = fn; return () => {} },
    get(name) { return provided[name] },
    provide(name, value) { provided[name] = value },
    webServer: { register: () => () => {}, registerUpgrade: () => () => {} },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: { registerProvider: () => () => {} },
  }
  return { ctx, handlers, provided }
}

test('TS-1: turn-stopping cancels the session\'s running agent tasks, never its exec tasks, never another session\'s', (t) => {
  const f = fixture()
  const handle = apply(f.ctx, { role: 'hub', nodeToken: 'nt_test', uiEnabled: false, listenPort: 0 })
  t.after(() => handle.dispose())
  const registry = f.provided['remote-agent:registry']
  assert.ok(registry, 'the hub registry is provided')
  assert.equal(typeof f.handlers['agent/turn-stopping'], 'function', 'the hook is registered')

  const cancelled = []
  registry.cancelTask = (taskId) => { cancelled.push(taskId); return true }
  const put = (taskId, mode, sessionId, status = 'running') => registry.tasks.set(taskId, { taskId, mode, sessionId, status })
  put('exec-mine', 'exec', 's1')
  put('agent-mine', 'agent', 's1')
  put('agent-done', 'agent', 's1', 'completed')
  put('agent-other', 'agent', 's2')
  put('exec-other', 'exec', 's2')

  f.handlers['agent/turn-stopping']({ agent: { session: { id: 's1' } } })
  assert.deepEqual(cancelled, ['agent-mine'])
})
