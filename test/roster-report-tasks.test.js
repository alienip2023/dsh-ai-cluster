// The roster report carries each Bot's running background tasks (a small read-only summary the hub
// shows). cleanRosterBots is the whitelist on both sides of the link (node rosterFrame, hub ingest),
// so a field it does not copy never reaches the hub.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanRosterBots, cleanRosterTasks, rosterFrame, ROSTER_TASK_CAP } from '../lib/roster-report.js'

const task = (over = {}) => ({ id: 't1', title: 'Build', status: 'running', startedAt: 100, sessionId: 'secret-session', workDir: '/root/x', ...over })

test('tasks pass as a small summary: only id, title, status, startedAt; running states only', () => {
  const [bot] = cleanRosterBots([{ id: 'b1', name: 'B', tasks: [task(), task({ id: 't2', status: 'waiting_approval' }), task({ id: 't3', status: 'completed' }), task({ id: '' })] }])
  assert.deepEqual(bot.tasks, [
    { id: 't1', title: 'Build', status: 'running', startedAt: 100 },
    { id: 't2', title: 'Build', status: 'waiting_approval', startedAt: 100 },
  ])
})

test('an empty list is kept; no tasks field stays absent; a wrong type is dropped', () => {
  assert.deepEqual(cleanRosterBots([{ id: 'b1', tasks: [] }])[0].tasks, [])
  assert.equal('tasks' in cleanRosterBots([{ id: 'b1' }])[0], false)
  assert.equal('tasks' in cleanRosterBots([{ id: 'b1', tasks: 'x' }])[0], false)
  assert.equal(cleanRosterTasks({}), undefined)
})

test('the list and the fields are capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => task({ id: `t${i}`, title: 'x'.repeat(200) }))
  const out = cleanRosterTasks(many)
  assert.equal(out.length, ROSTER_TASK_CAP)
  assert.equal(out[0].title.length, 80)
  assert.equal(cleanRosterTasks([task({ id: 'i'.repeat(100) })])[0].id.length, 64)
  assert.equal(cleanRosterTasks([task({ startedAt: 'now' })])[0].startedAt, 0)
})

test('the node frame keeps the tasks', () => {
  const frame = rosterFrame({ nodeId: 'n1', hostname: 'h', bots: [{ id: 'b1', name: 'B', tasks: [task()] }] })
  assert.deepEqual(frame.bots[0].tasks.map(item => item.id), ['t1'])
  assert.equal(JSON.stringify(frame).includes('secret-session'), false)
})
