// Reliable link (W0, DESIGN-work-model.md §8): exactly-once delivery of chosen frames over one hop (hub ↔ node).
//
// A message is written to disk before it is sent and kept until the other side acks it; it is sent again when the
// other side becomes ready (connected, E2E up) and on a backoff while it stays unacked. The receiver remembers every
// message id it handled (7 days), so a resend is acked again and never handled twice. A handler that throws is not
// acked: the sender sends again later.
//
// Store-and-forward on the hub: a node posts with `to: <nodeId>`; the hub keeps it as its own outgoing message to that
// node, acks the sender, and delivers it when that node is ready — however long that takes. No clock runs meanwhile.
//
// Pure apart from the injected `send`, `ready`, `deliver` and the store file, so it runs in tests without a network.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const REL_FRAME = 'rel/frame'
export const REL_ACK = 'rel/ack'
const DAY = 24 * 60 * 60 * 1000

/**
 * @param {object} o
 * @param {string} o.self              this side's name on the link: 'hub' or the node's id
 * @param {string} [o.file]            where unacked and seen ids are kept (absent: memory only, for tests)
 * @param {(peer: string, type: string, data: object) => boolean} o.send   raw send of a rel/* frame to a peer
 * @param {(peer: string) => boolean} o.ready   the peer can take a sealed frame now
 * @param {(msg: {type: string, data: object, from: string, rid: string}) => any} o.deliver   hand an inner message over (may throw / reject)
 * @param {(type: string) => boolean} [o.accepts]   inner types this side handles or forwards
 */
export function createReliableLink({ self, file, send, ready, deliver, accepts = () => true, now = Date.now, log = () => {},
  minRetryMs = 10_000, maxRetryMs = 120_000, seenTtlMs = 7 * DAY, seenMax = 20_000 } = {}) {
  const store = load()
  let saving = false
  let dirty = false
  const inFlight = new Set()   // rids being handed to `deliver` right now (a resend meanwhile is not handled twice)

  function load() {
    if (!file) return { out: {}, seen: {} }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return { out: parsed?.out && typeof parsed.out === 'object' ? parsed.out : {}, seen: parsed?.seen && typeof parsed.seen === 'object' ? parsed.seen : {} }
    } catch {
      return { out: {}, seen: {} }
    }
  }
  // Written synchronously and atomically before a message leaves or an ack goes back: a crash right after never loses
  // what was promised. Coalesced only within one tick of the event loop.
  function persist() {
    if (!file) return
    dirty = true
    if (saving) return
    saving = true
    try {
      while (dirty) {
        dirty = false
        mkdirSync(dirname(file), { recursive: true })
        const temp = `${file}.${process.pid}.tmp`
        writeFileSync(temp, JSON.stringify(store), { mode: 0o600 })
        renameSync(temp, file)
      }
    } catch (error) {
      log('warn', 'reliable link store not written', { error: String(error?.message ?? error) })
    } finally {
      saving = false
    }
  }

  function transmit(entry, at = now()) {
    entry.tries = (entry.tries ?? 0) + 1
    entry.lastTry = at
    entry.next = at + Math.min(maxRetryMs, minRetryMs * 2 ** Math.min(entry.tries - 1, 10))
    let sent = false
    try {
      sent = ready(entry.peer) === true && send(entry.peer, REL_FRAME, frameOf(entry)) === true
    } catch (error) {
      log('warn', 'reliable link send failed', { peer: entry.peer, rid: entry.rid, error: String(error?.message ?? error) })
    }
    return sent
  }
  const frameOf = entry => ({ rid: entry.rid, type: entry.type, data: entry.data, ...(entry.to ? { to: entry.to } : {}), ...(entry.from ? { from: entry.from } : {}) })

  /** Send one message to `peer`, exactly once. `to`: final node when a node sends through the hub. Returns its id. */
  function post(peer, type, data, { to, from, rid = randomUUID() } = {}) {
    if (typeof peer !== 'string' || peer === '') throw new TypeError('reliable link: peer required')
    if (typeof type !== 'string' || type === '') throw new TypeError('reliable link: type required')
    if (Object.hasOwn(store.out, rid)) return rid
    const entry = { rid, peer, type, data: data ?? {}, at: now(), tries: 0, ...(to ? { to } : {}), ...(from ? { from } : {}) }
    store.out[rid] = entry
    persist()
    if (ready(peer) === true) transmit(entry)
    return rid
  }

  function markSeen(rid) { store.seen[rid] = now(); persist() }

  function ack(peer, rid) {
    try { send(peer, REL_ACK, { rid }) } catch { /* the sender sends again; it is acked then */ }
  }

  /** A rel/frame or rel/ack from `peer` (the link's own fact of who sent it). */
  async function receive(peer, type, data) {
    if (type === REL_ACK) {
      const rid = data?.rid
      if (typeof rid === 'string' && store.out[rid]?.peer === peer) { delete store.out[rid]; persist() }
      return 'acked'
    }
    if (type !== REL_FRAME) return 'ignored'
    const rid = data?.rid
    if (typeof rid !== 'string' || rid === '' || typeof data?.type !== 'string') return 'invalid'
    if (Object.hasOwn(store.seen, rid)) { ack(peer, rid); return 'duplicate' }
    if (inFlight.has(rid)) return 'in-flight'
    if (!accepts(data.type)) { log('warn', 'reliable link: inner type not accepted', { peer, type: data.type }); ack(peer, rid); store.seen[rid] = now(); persist(); return 'refused' }
    // Only the hub forwards; the sender of a forwarded message is the node it came from, never what the frame says.
    const forward = self === 'hub' && typeof data.to === 'string' && data.to !== '' && data.to !== 'hub'
    const from = self === 'hub' ? peer : (typeof data.from === 'string' && data.from !== '' ? data.from : peer)
    inFlight.add(rid)
    try {
      if (forward) post(data.to, data.type, data.data, { from, rid })
      else await deliver({ type: data.type, data: data.data ?? {}, from, rid })
    } catch (error) {
      log('warn', 'reliable link: handler failed, not acked', { peer, rid, type: data.type, error: String(error?.message ?? error) })
      return 'failed'
    } finally {
      inFlight.delete(rid)
    }
    markSeen(rid)
    ack(peer, rid)
    return forward ? 'forwarded' : 'delivered'
  }

  /** `peer` became ready (connected, E2E up): send everything it has not acked, now. */
  function peerReady(peer) {
    const at = now()
    for (const entry of Object.values(store.out)) if (entry.peer === peer) transmit(entry, at)
    persist()
  }

  /** Resend what is due; forget seen ids past their time. Call on a timer. */
  function tick() {
    const at = now()
    let changed = false
    for (const entry of Object.values(store.out)) {
      if ((entry.next ?? 0) > at) continue
      if (ready(entry.peer) !== true) continue   // not reachable: no clock runs, it goes when the peer is ready
      transmit(entry, at)
      changed = true
    }
    const seen = Object.entries(store.seen)
    for (const [rid, t] of seen) if (!(at - t <= seenTtlMs)) { delete store.seen[rid]; changed = true }
    if (seen.length > seenMax) {
      for (const [rid] of seen.sort((a, b) => a[1] - b[1]).slice(0, seen.length - seenMax)) delete store.seen[rid]
      changed = true
    }
    if (changed) persist()
  }

  return {
    post, receive, peerReady, tick,
    pending: (peer) => Object.values(store.out).filter(entry => peer === undefined || entry.peer === peer).map(entry => ({ rid: entry.rid, peer: entry.peer, type: entry.type, to: entry.to, tries: entry.tries ?? 0, at: entry.at })),
    seenCount: () => Object.keys(store.seen).length,
  }
}
