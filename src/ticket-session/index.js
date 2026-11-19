import fs from 'node:fs'
import path from 'node:path'

export const TicketSessionDenyCode = Object.freeze({
  ROOT_UNCONFIGURED: 'root_unconfigured',
  TICKET_ID_INVALID: 'ticket_id_invalid',
  PATH_INVALID: 'path_invalid',
  REALPATH_FAILED: 'realpath_failed',
  OUTSIDE_ROOT: 'outside_root',
  LINK_ENTRY: 'link_entry',
  WORKSPACE_CREATE_FAILED: 'workspace_create_failed',
  SESSION_BOUND_ELSEWHERE: 'session_bound_elsewhere',
  ORPHAN_DIRECTORY: 'orphan_directory',
  BINDING_DIR_MISSING: 'binding_dir_missing',
  BINDINGS_UNAVAILABLE: 'bindings_unavailable',
  LOCKED: 'locked',
})
const DENY = TicketSessionDenyCode

export class TicketSessionError extends Error {
  constructor(code, message) {
    const known = Object.values(DENY).includes(code)
    const safeCode = known ? code : DENY.BINDINGS_UNAVAILABLE
    super(known && typeof message === 'string' ? message : safeCode)
    this.name = 'TicketSessionError'
    this.code = safeCode
  }
}

const deny = code => new TicketSessionError(code, code)
const inside = (base, p) => p === base || p.startsWith(base + path.sep)
const realOf = p => fs.realpathSync.native(p)
const absolute = p => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0')
const validTicket = id => typeof id === 'string' && /^tk_[a-f0-9]{24}$/.test(id)

export function ticketSessionId(ticketId) {
  if (!validTicket(ticketId)) throw deny(DENY.TICKET_ID_INVALID)
  return 'ticket-' + ticketId
}

function freezeRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw deny(DENY.ROOT_UNCONFIGURED)
  try {
    const canonical = realOf(root)
    if (fs.statSync(canonical).isDirectory()) return canonical
  } catch {
    throw deny(DENY.ROOT_UNCONFIGURED)
  }
  throw deny(DENY.ROOT_UNCONFIGURED)
}

function bindingLocation(p, root) {
  if (!absolute(p) || !path.basename(p)) throw deny(DENY.BINDINGS_UNAVAILABLE)
  try {
    const parent = realOf(path.dirname(p))
    if (root === path.parse(root).root || inside(root, parent) || !fs.statSync(parent).isDirectory()) {
      throw deny(DENY.BINDINGS_UNAVAILABLE)
    }
    return path.join(parent, path.basename(p))
  } catch {
    throw deny(DENY.BINDINGS_UNAVAILABLE)
  }
}

function lstat(p, errorCode) {
  try {
    return fs.lstatSync(p)
  } catch (error) {
    if (error.code !== 'ENOENT') throw deny(errorCode)
    return undefined
  }
}

function resolveEntry(base, requested) {
  if (!absolute(requested)) throw deny(DENY.PATH_INVALID)
  if (requested.split(path.sep === '\\' ? /[\\/]/ : '/').includes('..')) throw deny(DENY.OUTSIDE_ROOT)
  const target = path.resolve(requested)
  const lst = lstat(target, DENY.REALPATH_FAILED)
  if (lst?.isSymbolicLink()) throw deny(DENY.LINK_ENTRY)

  let canonical
  try {
    if (lst) {
      canonical = realOf(target)
    } else {
      let probe = path.dirname(target)
      const tail = [path.basename(target)]
      for (let depth = 0; depth < 64; depth += 1) {
        if (lstat(probe, DENY.REALPATH_FAILED)) {
          let probeReal
          probeReal = realOf(probe)
          canonical = path.join(probeReal, ...tail)
          break
        }
        const parent = path.dirname(probe)
        if (parent === probe) break
        tail.unshift(path.basename(probe))
        probe = parent
      }
    }
  } catch {
    throw deny(DENY.REALPATH_FAILED)
  }
  if (canonical === undefined) throw deny(DENY.REALPATH_FAILED)
  if (!inside(base, canonical)) throw deny(DENY.OUTSIDE_ROOT)
  return { canonical, exists: lst !== undefined }
}

function readBindings(file) {
  const dirs = new Map()
  try {
    if (realOf(path.dirname(file)) !== path.dirname(file)) throw deny(DENY.BINDINGS_UNAVAILABLE)
    const entry = lstat(file, DENY.BINDINGS_UNAVAILABLE)
    if (!entry) return { dirs, torn: false }
    if (!entry.isFile()) throw deny(DENY.BINDINGS_UNAVAILABLE)
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const torn = lines.pop() !== ''
    for (const line of lines) {
      const row = JSON.parse(line)
      if (!row || row.v !== 1 || Object.keys(row).length !== 3 ||
          typeof row.sessionId !== 'string' || !row.sessionId.startsWith('ticket-') ||
          !validTicket(row.sessionId.slice(7)) || !absolute(row.dir) || path.resolve(row.dir) !== row.dir) {
        throw deny(DENY.BINDINGS_UNAVAILABLE)
      }
      const previous = dirs.get(row.sessionId)
      if (previous !== undefined && previous !== row.dir) throw deny(DENY.BINDINGS_UNAVAILABLE)
      dirs.set(row.sessionId, row.dir)
    }
    return { dirs, torn }
  } catch {
    throw deny(DENY.BINDINGS_UNAVAILABLE)
  }
}

function appendBinding(file, sessionId, dir) {
  let fd
  try {
    fd = fs.openSync(file, 'a', 0o600)
    const line = Buffer.from(JSON.stringify({ v: 1, sessionId, dir }) + '\n')
    if (fs.writeSync(fd, line) !== line.length) throw deny(DENY.BINDINGS_UNAVAILABLE)
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function withLock(file, action) {
  const lock = file + '.lock'
  let fd
  try {
    if (realOf(path.dirname(file)) !== path.dirname(file)) throw deny(DENY.BINDINGS_UNAVAILABLE)
    fd = fs.openSync(lock, 'wx', 0o600)
  } catch (error) {
    throw deny(error.code === 'EEXIST' ? DENY.LOCKED : DENY.BINDINGS_UNAVAILABLE)
  }
  try {
    fs.writeFileSync(fd, String(process.pid) + '\n')
    return action()
  } catch (error) {
    if (error instanceof TicketSessionError) throw error
    throw deny(DENY.BINDINGS_UNAVAILABLE)
  } finally {
    try {
      try {
        fs.closeSync(fd)
      } finally {
        fs.unlinkSync(lock)
      }
    } catch {
      throw deny(DENY.BINDINGS_UNAVAILABLE)
    }
  }
}

function checkPrior(prior, canonical) {
  if (prior !== undefined && prior !== canonical) throw deny(DENY.SESSION_BOUND_ELSEWHERE)
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function createTicketSessions(options) {
  const root = freezeRoot(options?.root)
  const file = bindingLocation(options?.bindingsFile, root)

  return {
    workspace(ticketId) {
      const sessionId = ticketSessionId(ticketId)
      const target = path.join(root, ticketId)
      return withLock(file, () => {
        const { canonical, exists } = resolveEntry(root, target)
        const { dirs, torn } = readBindings(file)
        const prior = dirs.get(sessionId)
        checkPrior(prior, canonical)
        if (exists && prior === undefined) throw deny(DENY.ORPHAN_DIRECTORY)
        if (prior !== undefined) {
          if (!exists || !isDirectory(canonical)) throw deny(DENY.BINDING_DIR_MISSING)
          return { sessionId, dir: canonical }
        }
        // Appending after a torn row would turn it into a complete, invalid row.
        if (torn) throw deny(DENY.BINDINGS_UNAVAILABLE)
        try {
          fs.mkdirSync(target)
        } catch {
          throw deny(DENY.WORKSPACE_CREATE_FAILED)
        }
        const created = resolveEntry(root, target)
        if (!created.exists || !isDirectory(created.canonical)) throw deny(DENY.WORKSPACE_CREATE_FAILED)
        appendBinding(file, sessionId, created.canonical)
        return { sessionId, dir: created.canonical }
      })
    },

    bindSession(ticketId, dir) {
      const sessionId = ticketSessionId(ticketId)
      return withLock(file, () => {
        const { canonical, exists } = resolveEntry(root, dir)
        const { dirs, torn } = readBindings(file)
        const prior = dirs.get(sessionId)
        checkPrior(prior, canonical)
        if (!exists || !isDirectory(canonical)) throw deny(DENY.BINDING_DIR_MISSING)
        if (prior === undefined) {
          if (torn) throw deny(DENY.BINDINGS_UNAVAILABLE)
          appendBinding(file, sessionId, canonical)
        }
        return { sessionId, dir: canonical }
      })
    },

    assertInside(p) {
      return resolveEntry(root, p).canonical
    },

    listOrphans() {
      const bound = new Set(readBindings(file).dirs.values())
      let entries
      try {
        if (realOf(root) !== root) throw deny(DENY.OUTSIDE_ROOT)
        entries = fs.readdirSync(root, { withFileTypes: true })
      } catch (error) {
        if (error instanceof TicketSessionError) throw error
        throw deny(DENY.REALPATH_FAILED)
      }
      return entries.filter(entry => entry.isDirectory() && validTicket(entry.name))
        .map(entry => resolveEntry(root, path.join(root, entry.name)).canonical)
        .filter(dir => !bound.has(dir)).sort()
    },

    close() {
      // All descriptors are scoped to synchronous calls.
    },
  }
}

export function ticketWorkspace(ticketId, root, options) {
  ticketSessionId(ticketId)
  return createTicketSessions({ root, bindingsFile: options?.bindingsFile }).workspace(ticketId)
}
