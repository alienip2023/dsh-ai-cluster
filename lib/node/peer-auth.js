// Pair keys for node ↔ node direct links (AC 0.4.40, docs/reliable-link.md §直连).
//
// The hub makes one key for each pair of nodes and gives it to the two of them only, inside its E2E link. A node that
// dials another proves it holds the pair's key (an HMAC over both ids, the time and its ephemeral key); the listener
// answers with a proof of its own over both ephemeral keys. The key itself never crosses the wire, so a LAN observer
// learns nothing it can replay, and a node holding the key of pair (A, C) cannot pass as B to C.
//
// Each node keeps its book (addresses + pair keys) on disk, so direct links keep working while the hub is down. Only
// the hub adds or removes a node: a node it removes is dropped from every book the next time the hub is up.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const HEX64 = /^[0-9a-f]{64}$/
/** A hello older or newer than this is refused (clocks of one LAN drift far less). */
export const PROOF_SKEW_MS = 5 * 60_000

export const validPairKey = key => typeof key === 'string' && HEX64.test(key)
export const newPairKey = () => randomBytes(32).toString('hex')
/** The store key of the pair (a, b), whichever side asks. */
export const pairIdOf = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)

const mac = (key, parts) => createHmac('sha256', Buffer.from(key, 'hex')).update(parts.join('\n')).digest('hex')
export const helloProof = (key, { from, to, time, pub }) => mac(key, ['peer-hello/2', from, to, String(time), pub])
export const welcomeProof = (key, { from, to, dialerPub, pub }) => mac(key, ['peer-welcome/2', from, to, dialerPub, pub])

export function sameProof(expected, received) {
  if (typeof expected !== 'string' || !HEX64.test(expected) || typeof received !== 'string' || !HEX64.test(received)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))
}

/** A node's saved book: `{ directory: [{nodeId, url}], credentials: [{nodeId, pairKey}] }`; empty when unreadable. */
export function loadPeerBook(file) {
  if (!file) return { directory: [], credentials: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      directory: Array.isArray(parsed?.directory) ? parsed.directory.filter(peer => typeof peer?.nodeId === 'string' && typeof peer?.url === 'string') : [],
      credentials: Array.isArray(parsed?.credentials) ? parsed.credentials.filter(peer => typeof peer?.nodeId === 'string' && validPairKey(peer?.pairKey)) : [],
    }
  } catch {
    return { directory: [], credentials: [] }
  }
}

/** Written atomically, 0600: it holds keys. */
export function savePeerBook(file, book) {
  if (!file) return
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ directory: book.directory ?? [], credentials: book.credentials ?? [], at: Date.now() }), { mode: 0o600 })
  renameSync(temp, file)
}

/** The hub's pair keys, kept in `file` (0600). */
export function createPairKeyStore(file) {
  let keys = {}
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') for (const [id, key] of Object.entries(parsed.keys ?? {})) if (validPairKey(key)) keys[id] = key
    } catch { /* none yet */ }
  }
  const save = () => {
    if (!file) return
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ keys }), { mode: 0o600 })
    renameSync(temp, file)
  }
  return {
    /** The key of pair (a, b), made the first time it is asked for. */
    keyOf(a, b) {
      const id = pairIdOf(a, b)
      if (!validPairKey(keys[id])) { keys = { ...keys, [id]: newPairKey() }; save() }
      return keys[id]
    },
    /** Every key `nodeId` is part of goes: the hub removed that node. */
    forget(nodeId) {
      const kept = Object.fromEntries(Object.entries(keys).filter(([id]) => !id.split('|').includes(nodeId)))
      if (Object.keys(kept).length === Object.keys(keys).length) return
      keys = kept
      save()
    },
    size: () => Object.keys(keys).length,
  }
}
