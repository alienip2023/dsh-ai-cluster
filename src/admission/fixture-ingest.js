// Read-only, offline adapter: replays recorded fixture events into the existing
// bindWork -> decideAuthorization -> store.accept seams. Not wired into the plugin
// entry. Nothing here dispatches work or talks to a host; tickets get executorRef null.
import { AUTHZ_REASON_CODES, decideAuthorization } from '../authz/decide.js'
import { TicketErrorCode, ticketIdOf, workKeyOf } from '../tickets/index.js'
import { bindWork, hasOriginKey } from '../tickets/identity.js'

const PROVENANCE = 'fixture'
const IDENTIFIER = /^[a-z][a-z0-9_.-]{0,63}$/
const DEFAULT_LIMITS = Object.freeze({
  maxEventBytes: 8192, maxContextPerRef: 32, maxContextText: 2048, maxSubscriptions: 64, maxSourceEvents: 1024,
})
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SOURCE_KEYS = new Set(['kind', 'seq', 'generation', 'origin', 'replyTo', 'text'])
const CONTEXT_KEYS = new Set(['kind', 'seq', 'generation', 'ref', 'text'])
const ORIGIN_KEYS = new Set(['source', 'eventId', 'thread', 'identityRef'])
const REPLY_KEYS = new Set(['kind', 'conversationId', 'requesterRef'])
const REF_KEYS = new Set(['source', 'eventId', 'thread'])
const storeCodes = new Set(Object.values(TicketErrorCode))

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const onlyKeys = (value, allowed) => Object.keys(value).every(key => allowed.has(key))

function hasForbiddenKey(value, depth = 0) {
  if (depth > 6) return true
  if (Array.isArray(value)) return value.some(item => hasForbiddenKey(item, depth + 1))
  if (!isRecord(value)) return false
  return Object.keys(value).some(key => FORBIDDEN_KEYS.has(key) || hasForbiddenKey(value[key], depth + 1))
}

const result = (outcome, extra = {}) => ({ outcome, ...extra, provenance: PROVENANCE })

export function createFixtureIngest({
  enabled, sources, policy, target, store, now, audit, log, limits, generation = 1,
  decide = decideAuthorization,
} = {}) {
  if (enabled !== true) return null
  if (!store || !['accept', 'get', 'list'].every(name => typeof store[name] === 'function')) {
    throw new TypeError('A ticket store is required')
  }
  const sourceList = sources instanceof Set ? [...sources] : sources
  if (!Array.isArray(sourceList) || sourceList.length === 0 ||
      !sourceList.every(source => typeof source === 'string' && source.trim())) {
    throw new TypeError('Invalid sources')
  }
  if (typeof target !== 'string' || !IDENTIFIER.test(target)) throw new TypeError('Invalid target')
  if (!Number.isSafeInteger(generation)) throw new TypeError('Invalid generation')
  if (typeof decide !== 'function') throw new TypeError('Invalid decide')
  const cfg = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Invalid limit ${key}`)
    }
    cfg[key] = value
  }
  const sourceSet = new Set(sourceList)
  const subscriptions = new Map() // ticketId -> { ref, items, evicted }
  const stats = { evicted: 0, oversizeDropped: 0, sourceEvents: 0 }
  let closed = false
  let lastEventAt = null
  let storeCode = null

  const notify = (sink, ...args) => { try { sink?.(...args) } catch {} }
  const stamp = () => {
    try { return typeof now === 'function' ? new Date(now()).toISOString() : null } catch { return null }
  }
  const finish = out => {
    notify(audit, 'fixture.ingest', { outcome: out.outcome, code: out.code ?? null })
    return out
  }
  const malformed = code => finish(result('malformed', { code }))
  const refKey = ref => {
    if (!isRecord(ref) || !onlyKeys(ref, REF_KEYS) || hasForbiddenKey(ref) || !hasOriginKey(ref)) return null
    return ticketIdOf(workKeyOf(ref))
  }
  const safeStoreCode = error => storeCodes.has(error?.code) ? error.code : TicketErrorCode.STORE_FAILED

  function envelope(event, allowed) {
    if (!isRecord(event)) return 'not_object'
    if (hasForbiddenKey(event)) return 'forbidden_key'
    if (!onlyKeys(event, allowed)) return 'extra_field'
    if (!Number.isSafeInteger(event.seq)) return 'seq_invalid'
    if (event.generation !== undefined && !Number.isSafeInteger(event.generation)) return 'generation_invalid'
    if (event.text !== undefined && typeof event.text !== 'string') return 'text_invalid'
    return null
  }

  async function ingestSource(event) {
    const bad = envelope(event, SOURCE_KEYS)
    if (bad) return malformed(bad)
    if (event.origin !== undefined && (!isRecord(event.origin) || !onlyKeys(event.origin, ORIGIN_KEYS))) {
      return malformed('origin_shape')
    }
    if (event.replyTo !== undefined && (!isRecord(event.replyTo) || !onlyKeys(event.replyTo, REPLY_KEYS))) {
      return malformed('reply_shape')
    }
    if (event.generation !== undefined && event.generation !== generation) {
      return finish(result('dropped', { code: 'stale_generation' }))
    }
    if (stats.sourceEvents >= cfg.maxSourceEvents) return finish(result('limit', { code: 'limit' }))
    stats.sourceEvents++

    let binding
    try {
      binding = bindWork({ origin: event.origin, replyTo: event.replyTo, executorRef: null }, sourceSet)
    } catch {
      return malformed('bind_failed')
    }
    if (binding.denied) return finish(result('rejected', { code: binding.code }))
    const origin = { source: binding.origin.source, eventId: binding.origin.eventId, thread: binding.origin.thread }

    let decision
    try { decision = decide({ action: 'dispatch', target }, policy) } catch { decision = null }
    if (decision?.decision !== 'allow') {
      const code = decision?.decision === 'deny' && AUTHZ_REASON_CODES.includes(decision.reasonCode)
        ? decision.reasonCode : 'authz_indeterminate'
      return finish(result('rejected', { code, origin }))
    }

    let accepted
    try {
      accepted = await store.accept({ ...binding, executorRef: null })
    } catch (error) {
      storeCode = safeStoreCode(error)
      return finish(result('unavailable', { code: storeCode, origin }))
    }
    if (accepted?.denied) return finish(result('rejected', { code: accepted.code, origin }))
    lastEventAt = stamp()
    const ticketId = accepted.ticket.ticketId
    return finish(result(accepted.duplicate ? 'duplicate' : 'accepted', { ticketId, origin }))
  }

  function ingestContext(event) {
    const bad = envelope(event, CONTEXT_KEYS)
    if (bad) return malformed(bad)
    if (typeof event.text !== 'string') return malformed('text_invalid')
    const ticketId = refKey(event.ref)
    if (!ticketId) return malformed('ref_invalid')
    if (event.generation !== undefined && event.generation !== generation) {
      return finish(result('dropped', { code: 'stale_generation' }))
    }
    const entry = subscriptions.get(ticketId)
    if (!entry) return finish(result('dropped', { code: 'not_subscribed' }))
    if (event.text.length > cfg.maxContextText) {
      stats.oversizeDropped++
      return finish(result('dropped', { code: 'text_too_long', ticketId }))
    }
    entry.items.push({ seq: event.seq, text: event.text, untrusted_context: true, provenance: PROVENANCE })
    while (entry.items.length > cfg.maxContextPerRef) {
      entry.items.shift()
      entry.evicted++
      stats.evicted++
    }
    return finish(result('context', { ticketId }))
  }

  async function ingest(event) {
    if (closed) return result('closed', { code: 'closed' })
    let bytes
    try { bytes = Buffer.byteLength(JSON.stringify(event) ?? '') } catch { return malformed('unserializable') }
    if (bytes > cfg.maxEventBytes) return malformed('oversize')
    if (!isRecord(event)) return malformed('not_object')
    if (event.kind === 'source-event') return ingestSource(event)
    if (event.kind === 'subscription-context') return ingestContext(event)
    return malformed('kind_unknown')
  }

  async function ingestJsonl(text) {
    const outcomes = []
    if (typeof text !== 'string') return [malformed('not_text')]
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      if (closed) { outcomes.push(result('closed', { code: 'closed' })); continue }
      if (Buffer.byteLength(line) > cfg.maxEventBytes) { outcomes.push(malformed('oversize')); continue }
      let event
      try { event = JSON.parse(line) } catch { outcomes.push(malformed('unparsable')); continue }
      outcomes.push(await ingest(event))
    }
    return outcomes
  }

  function subscribe(ref) {
    if (closed) return result('closed', { code: 'closed' })
    const ticketId = refKey(ref)
    if (!ticketId) return result('malformed', { code: 'ref_invalid' })
    let ticket
    try { ticket = store.get(ticketId) } catch (error) {
      return result('unavailable', { code: safeStoreCode(error) })
    }
    if (!ticket) return result('rejected', { code: 'unknown_ticket' })
    if (!subscriptions.has(ticketId)) {
      if (subscriptions.size >= cfg.maxSubscriptions) return result('limit', { code: 'limit' })
      subscriptions.set(ticketId, { ref: { source: ref.source, eventId: ref.eventId, thread: ref.thread }, items: [], evicted: 0 })
    }
    return result('subscribed', { ticketId })
  }

  function unsubscribe(ref) {
    if (closed) return result('closed', { code: 'closed' })
    const ticketId = refKey(ref)
    if (!ticketId) return result('malformed', { code: 'ref_invalid' })
    subscriptions.delete(ticketId)
    return result('unsubscribed', { ticketId })
  }

  function reset() {
    if (closed) return result('closed', { code: 'closed' })
    subscriptions.clear()
    return result('reset')
  }

  function dispose() {
    closed = true
    subscriptions.clear()
  }

  function snapshot() {
    const base = { source: PROVENANCE, provenance: PROVENANCE, generation, lastEventAt, stats: { ...stats } }
    const contexts = [...subscriptions].map(([ticketId, entry]) => ({
      ticketId, ref: { ...entry.ref }, evicted: entry.evicted, items: entry.items.map(item => ({ ...item })),
    }))
    let list
    try { list = store.list() } catch (error) {
      return { ...base, state: 'unavailable', code: safeStoreCode(error), tickets: 0, ticketList: [], contexts }
    }
    const ticketList = list.map(ticket => ({
      ticketId: ticket.ticketId, state: ticket.state, provenance: PROVENANCE,
      origin: { source: ticket.origin.source, eventId: ticket.origin.eventId, thread: ticket.origin.thread },
      identityRef: ticket.origin.identityRef, identityLabel: 'fixture-declared',
    }))
    const state = closed ? 'closed' : storeCode ? 'unavailable' : ticketList.length === 0 ? 'empty' : 'ready'
    return {
      ...base, state, ...(storeCode && !closed ? { code: storeCode } : {}),
      tickets: ticketList.length, ticketList, contexts, subscriptions: subscriptions.size,
    }
  }

  return { ingest, ingestJsonl, subscribe, unsubscribe, reset, snapshot, dispose }
}
