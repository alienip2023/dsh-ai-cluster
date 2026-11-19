import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createTicketSessions, ticketWorkspace, ticketSessionId, TicketSessionError, TicketSessionDenyCode,
} from '../../src/ticket-session/index.js'
import { ticketIdOf } from '../../src/tickets/index.js'
import { createFsService, FsError } from '../../src/fsbox/index.js'

const ticket = ticketIdOf('a'.repeat(64))
const other = ticketIdOf('b'.repeat(64))
const third = ticketIdOf('c'.repeat(64))
const moduleUrl = new URL('../../src/ticket-session/index.js', import.meta.url)

function temp(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sa-p0c-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fixture(t) {
  const fixtureDir = temp(t)
  const root = path.join(fixtureDir, 'root')
  const bindingsFile = path.join(fixtureDir, 'bindings.jsonl')
  fs.mkdirSync(root)
  const options = { root, bindingsFile }
  return { ...options, options, sessions: createTicketSessions(options) }
}

function errorCode(action) {
  try {
    action()
    return 'none'
  } catch (error) {
    assert.ok(error instanceof TicketSessionError, `expected TicketSessionError, got ${error}`)
    return error.code
  }
}

function rows(file) {
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
}

// repo-proven (fixture)
test('P0C-1 ticketWorkspace returns a directory inside the frozen root', t => {
  const { root, bindingsFile } = fixture(t)
  const alias = path.join(path.dirname(root), 'alias')
  fs.symlinkSync(root, alias, 'dir')
  const workspace = ticketWorkspace(ticket, alias, { bindingsFile })
  assert.equal(workspace.dir, fs.realpathSync.native(path.join(root, ticket)))
  assert.ok(workspace.dir.startsWith(root + path.sep))
  assert.ok(fs.statSync(workspace.dir).isDirectory())
  const sessions = createTicketSessions({ root: alias, bindingsFile })
  fs.unlinkSync(alias)
  fs.symlinkSync(temp(t), alias, 'dir')
  assert.deepEqual(sessions.workspace(ticket), workspace)
  const forbidden = new RegExp('sand' + 'box', 'i')
  for (const file of [moduleUrl, new URL(import.meta.url)]) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), forbidden)
  }
})

test('P0C-2 two tickets get distinct directories and distinct session ids', t => {
  const { sessions } = fixture(t)
  const first = sessions.workspace(ticket)
  const second = sessions.workspace(other)
  assert.notEqual(first.dir, second.dir)
  assert.equal(first.sessionId, `ticket-${ticket}`)
  assert.equal(second.sessionId, `ticket-${other}`)
})

test('P0C-3 repeated workspace call is idempotent and writes one binding line', t => {
  const { sessions, bindingsFile } = fixture(t)
  const first = sessions.workspace(ticket)
  assert.deepEqual(sessions.workspace(ticket), first)
  assert.deepEqual(rows(bindingsFile), [{ v: 1, ...first }])
  assert.ok(fs.readFileSync(bindingsFile, 'utf8').endsWith('\n'))
})

test('P0C-4 symlink inside root pointing outside root is rejected', t => {
  const { root, sessions } = fixture(t)
  const outside = temp(t)
  fs.mkdirSync(path.join(outside, 'child'))
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir')
  const actualCode = errorCode(() => sessions.assertInside(path.join(root, 'escape', 'child')))
  assert.strictEqual(actualCode, 'outside_root', 'M1: existing child under outside-linked ancestor must be denied with outside_root')
  fs.mkdirSync(path.join(root, 'inside'))
  fs.symlinkSync(path.join(root, 'inside'), path.join(root, ticket), 'dir')
  const leafCode = errorCode(() => sessions.workspace(ticket))
  assert.strictEqual(leafCode, 'link_entry', 'M4: leaf link inside root must be denied with link_entry')
  assert.equal(errorCode(() => sessions.assertInside(path.join(root, ticket) + path.sep)), 'link_entry')
})

test('P0C-5 missing target under an ancestor that links outside root is rejected', t => {
  const { root, sessions } = fixture(t)
  const outside = temp(t)
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir')
  assert.strictEqual(errorCode(() => sessions.assertInside(path.join(root, 'escape', 'absent', 'child'))),
    'outside_root', 'missing target with outside-linked ancestor must be denied')
})

test('P0C-6 a session id cannot bind a second directory', t => {
  const { root, sessions, bindingsFile } = fixture(t)
  const first = sessions.workspace(ticket)
  const second = path.join(root, 'second')
  fs.mkdirSync(second)
  const actualCode = errorCode(() => sessions.bindSession(ticket, second))
  assert.strictEqual(actualCode, 'session_bound_elsewhere', 'M3: rebinding a session id to a second directory must be denied with session_bound_elsewhere')
  assert.deepEqual(rows(bindingsFile), [{ v: 1, ...first }])
  assert.deepEqual(sessions.bindSession(ticket, first.dir), first)
})

test('P0C-7 sibling directory sharing the root prefix is outside', t => {
  const { root, sessions } = fixture(t)
  fs.mkdirSync(root + '-evil')
  for (const requested of [root + '-evil', root + 'x/a']) {
    const actualCode = errorCode(() => sessions.assertInside(requested))
    assert.strictEqual(actualCode, 'outside_root', 'M6: sibling directory sharing the root prefix must be denied with outside_root')
  }
})

test('P0C-8 dot-dot and relative and non-string paths are denied', t => {
  const { root, sessions } = fixture(t)
  assert.equal(errorCode(() => sessions.assertInside(root + '/../x')), 'outside_root')
  for (const requested of ['./a', '', null, undefined, 42, {}, root + '/a\0b']) {
    assert.equal(errorCode(() => sessions.assertInside(requested)), 'path_invalid')
  }
})

test('P0C-9 unconfigured, relative, missing or file root fails closed without default directory', t => {
  const { root, bindingsFile } = fixture(t)
  const relative = path.relative(process.cwd(), root)
  fs.writeFileSync(bindingsFile, '')
  assert.ok(fs.statSync(relative).isDirectory())
  const defaultDirs = [process.cwd(), fs.realpathSync(os.tmpdir())].map(base => path.join(base, ticket))
  const before = defaultDirs.map(dir => fs.existsSync(dir))
  const actualCode = errorCode(() => ticketWorkspace(ticket, relative, { bindingsFile }))
  assert.strictEqual(actualCode, 'root_unconfigured', 'M7: relative existing root must be denied with root_unconfigured')
  for (const invalid of [undefined, null, path.join(root, 'missing'), bindingsFile]) {
    assert.equal(errorCode(() => ticketWorkspace(ticket, invalid, { bindingsFile })), 'root_unconfigured')
  }
  for (const options of [null, undefined, 42, {}]) {
    assert.equal(errorCode(() => createTicketSessions(options)), 'root_unconfigured')
  }
  for (const file of [null, undefined, 42, {}, 'relative', path.join(root, 'bindings.jsonl')]) {
    assert.equal(errorCode(() => createTicketSessions({ root, bindingsFile: file })), 'bindings_unavailable')
  }
  const link = path.join(path.dirname(root), 'linked-parent')
  fs.symlinkSync(root, link, 'dir')
  assert.equal(errorCode(() => createTicketSessions({ root, bindingsFile: path.join(link, 'bindings') })), 'bindings_unavailable')
  assert.deepEqual(fs.readdirSync(root), [])
  assert.deepEqual(defaultDirs.map(dir => fs.existsSync(dir)), before)
})

test('P0C-10 existing unbound directory is an orphan and is not adopted', t => {
  const { sessions, root, bindingsFile } = fixture(t)
  const dir = path.join(root, ticket)
  fs.mkdirSync(dir)
  const actualCode = errorCode(() => sessions.workspace(ticket))
  assert.strictEqual(actualCode, 'orphan_directory', 'M5: existing unbound directory must be denied with orphan_directory')
  assert.equal(fs.existsSync(bindingsFile), false)
  assert.deepEqual(sessions.listOrphans(), [dir])
})

test('P0C-11 restart rebuilds from bindings and torn tail or corrupt line fails closed', t => {
  const { sessions, root, options, bindingsFile } = fixture(t)
  const first = sessions.workspace(ticket)
  sessions.close()
  const baseline = fs.readFileSync(bindingsFile, 'utf8')
  const restarted = createTicketSessions(options)
  assert.deepEqual(restarted.workspace(ticket), first)
  const partialDir = path.join(root, other)
  fs.mkdirSync(partialDir)
  const partial = JSON.stringify({ v: 1, sessionId: ticketSessionId(other), dir: partialDir }).slice(0, -1)
  fs.appendFileSync(bindingsFile, partial)
  assert.deepEqual(restarted.workspace(ticket), first)
  assert.deepEqual(restarted.listOrphans(), [partialDir])
  assert.equal(errorCode(() => restarted.workspace(other)), 'orphan_directory')
  assert.equal(errorCode(() => restarted.workspace(third)), 'bindings_unavailable')
  assert.equal(fs.existsSync(path.join(root, third)), false)
  assert.equal(fs.readFileSync(bindingsFile, 'utf8'), baseline + partial)
  const corrupt = baseline + partial + '\n'
  fs.writeFileSync(bindingsFile, corrupt)
  assert.equal(errorCode(() => restarted.workspace(ticket)), 'bindings_unavailable')
  assert.equal(fs.readFileSync(bindingsFile, 'utf8'), corrupt)
  fs.writeFileSync(bindingsFile, baseline + JSON.stringify({ v: 1, ...first, dir: partialDir }) + '\n')
  assert.equal(errorCode(() => restarted.workspace(ticket)), 'bindings_unavailable')
  fs.writeFileSync(bindingsFile, baseline + baseline)
  assert.deepEqual(restarted.workspace(ticket), first)
  fs.rmdirSync(first.dir)
  assert.equal(errorCode(() => restarted.workspace(ticket)), 'binding_dir_missing')
  assert.equal(fs.existsSync(first.dir), false)
})

test('P0C-12 invalid ticket ids are rejected before any filesystem effect', t => {
  const { sessions, root, bindingsFile } = fixture(t)
  const lock = bindingsFile + '.lock'
  fs.writeFileSync(lock, 'held')
  const before = fs.readdirSync(path.dirname(root))
  for (const id of ['tk_', ticket.toUpperCase(), `tk_${'A'.repeat(24)}`, '../x', ticket + '0', ticket + '\n', null, undefined, 42, {}]) {
    assert.equal(errorCode(() => ticketSessionId(id)), 'ticket_id_invalid')
    assert.equal(errorCode(() => sessions.workspace(id)), 'ticket_id_invalid')
    assert.equal(errorCode(() => sessions.bindSession(id, root)), 'ticket_id_invalid')
    assert.equal(errorCode(() => ticketWorkspace(id)), 'ticket_id_invalid')
  }
  assert.deepEqual(fs.readdirSync(root), [])
  assert.deepEqual(fs.readdirSync(path.dirname(root)), before)
  assert.equal(fs.readFileSync(lock, 'utf8'), 'held')
  assert.ok(Object.isFrozen(TicketSessionDenyCode))
  assert.equal(new TicketSessionError(null).code, 'bindings_unavailable')
})

test('P0C-13 concurrent creators of one ticket produce exactly one directory and one binding', t => {
  const { root, options, bindingsFile } = fixture(t)
  const lock = bindingsFile + '.lock'
  const fd = fs.openSync(lock, 'wx')
  try {
    fs.writeFileSync(fd, String(process.pid))
    assert.equal(errorCode(() => createTicketSessions(options).workspace(ticket)), 'locked')
  } finally {
    fs.closeSync(fd)
    fs.unlinkSync(lock)
  }
  const worker = `
    import { createTicketSessions } from ${JSON.stringify(moduleUrl.href)}
    const [options, ticket] = process.argv.slice(1)
    const sessions = createTicketSessions(JSON.parse(options))
    await new Promise(resolve => process.stdin.once('data', resolve))
    try { console.log(JSON.stringify({ value: sessions.workspace(ticket) })) }
    catch (error) { console.log(JSON.stringify({ code: error.code })) }
  `
  const launch = `
    import { spawn } from 'node:child_process'
    import { once } from 'node:events'
    const workers = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', ...process.argv.slice(1)],
      { stdio: ['pipe', 'pipe', 'inherit'] }))
    const results = workers.map(async worker => {
      let stdout = ''
      worker.stdout.on('data', bytes => { stdout += bytes })
      const [code] = await once(worker, 'close')
      if (code !== 0) throw new Error('worker exited with ' + code)
      return JSON.parse(stdout)
    })
    for (const worker of workers) worker.stdin.end('go')
    console.log(JSON.stringify(await Promise.all(results)))
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', launch, worker, JSON.stringify(options), ticket],
    { encoding: 'utf8', timeout: 10_000 })
  assert.ifError(child.error)
  assert.strictEqual(child.status, 0, child.stderr)
  const results = JSON.parse(child.stdout)
  const expected = { sessionId: ticketSessionId(ticket), dir: path.join(root, ticket) }
  assert.ok(results.some(result => result.value))
  for (const result of results) {
    if (result.value) assert.deepEqual(result.value, expected)
    else assert.equal(result.code, 'locked')
  }
  assert.deepEqual(fs.readdirSync(root), [ticket])
  assert.deepEqual(rows(bindingsFile), [{ v: 1, ...expected }])
  assert.equal(fs.existsSync(lock), false)
})

test('P0C-14 fence decisions agree with fsbox mkdir on a differential matrix', t => {
  const { root, sessions } = fixture(t)
  const outside = temp(t)
  fs.mkdirSync(path.join(root, 'existing'))
  fs.mkdirSync(path.join(outside, 'existing'))
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir')
  const service = createFsService({ roots: [root] })
  for (const [name, requested, expected] of [
    ['inside new', path.join(root, 'new'), true],
    ['inside existing', path.join(root, 'existing'), true],
    ['outside', outside, false],
    ['link-escape', path.join(root, 'escape', 'existing'), false],
    ['missing-under-link-escape', path.join(root, 'escape', 'missing'), false],
  ]) {
    const allowed = errorCode(() => sessions.assertInside(requested)) === 'none'
    let fsboxAllowed = true
    try {
      service.mkdir({ path: requested })
    } catch (error) {
      if (!(error instanceof FsError) || error.code !== 'workspace-denied') throw error
      fsboxAllowed = false
    }
    assert.equal(allowed, fsboxAllowed, name)
    assert.equal(allowed, expected, name)
  }
  assert.deepEqual(fs.readdirSync(outside), ['existing'])
})
