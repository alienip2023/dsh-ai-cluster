import { createHash } from 'node:crypto'

const defaultLimits = Object.freeze({ maxResults: 1024, maxAttemptsPerResult: 3 })
const replyFields = ['kind', 'conversationId', 'requesterRef']
const nonblank = value => typeof value === 'string' && value.trim().length > 0
const rejected = code => ({ outcome: 'rejected', code })
const failed = code => ({ outcome: 'failed', code })

function validReply(replyTo) {
  return replyTo !== null && typeof replyTo === 'object' && !Array.isArray(replyTo) &&
    Object.keys(replyTo).length === replyFields.length &&
    replyFields.every(field => Object.hasOwn(replyTo, field) && nonblank(replyTo[field]))
}

function canonicalize(result) {
  // Normalize to JSON data and sort every object from the leaves up, keeping array order.
  return JSON.parse(JSON.stringify(result), (_, value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
  })
}

export function createResultRelay({ store, channel, now, audit, limits = {} } = {}) {
  if (typeof store?.get !== 'function') throw new TypeError('A readable ticket store is required')
  if (typeof channel?.send !== 'function') throw new TypeError('A fake channel is required')
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) throw new TypeError('Invalid limits')
  const config = { ...defaultLimits }
  for (const [name, value] of Object.entries(limits)) {
    if (!Object.hasOwn(defaultLimits, name) || !Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Invalid limit ${name}`)
    }
    config[name] = value
  }

  // Owner-side fixture state is memory-only. Retries are at-least-once with a stable ID.
  // Channel deduplication is required for exactly-once visibility, including across restarts.
  const receipts = new Map()
  const inflight = new Map()

  function report(result) {
    try {
      audit?.('fixture.result_relay', { outcome: result.outcome, code: result.code, at: now?.() })
    } catch {
      // Observability must not change the delivery outcome.
    }
    return result
  }

  async function deliver({ ticketId, resultId, result } = {}) {
    const ticket = typeof ticketId === 'string' ? store.get(ticketId) : undefined
    if (!ticket) return report(rejected('unknown_ticket'))
    if (!validReply(ticket.replyTo)) return report(rejected('reply_unbound'))
    if (!nonblank(resultId) || resultId.length > 200) return report(rejected('invalid_result_id'))

    let canonicalBody
    try {
      canonicalBody = canonicalize(result)
    } catch {
      return report(rejected('invalid_result_body'))
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([resultId, canonicalBody])).digest('hex')
    const key = ticketId + '\0' + resultId
    let entry = receipts.get(key)
    if (entry && entry.fingerprint !== fingerprint) {
      return report({ outcome: 'conflict', code: 'fingerprint_mismatch' })
    }
    if (entry?.state === 'delivered') return report({ outcome: 'duplicate', receipt: entry.receipt })
    const active = inflight.get(key)
    if (active) {
      const first = await active
      return report(first.outcome === 'sent' ? { outcome: 'duplicate', receipt: first.receipt } : first)
    }
    if (!entry) {
      if (receipts.size >= config.maxResults) return report(rejected('limit'))
      entry = { fingerprint, attempts: 0 }
      receipts.set(key, entry)
    }
    if (entry.attempts >= config.maxAttemptsPerResult) return report(failed('attempts_exhausted'))
    entry.attempts++
    entry.state = 'pending'
    const messageId = 'ac-result:' + ticketId + ':' + resultId
    const replyTo = Object.freeze(structuredClone(ticket.replyTo))
    const body = JSON.stringify(canonicalBody)

    // Publish the pending promise before calling the injected channel, even for a synchronous send.
    const sending = Promise.resolve().then(async () => {
      try {
        entry.receipt = await channel.send({ messageId, replyTo, body })
        entry.state = 'delivered'
        return { outcome: 'sent', receipt: entry.receipt }
      } catch {
        entry.state = 'failed'
        return failed('send_failed')
      } finally {
        inflight.delete(key)
      }
    })
    inflight.set(key, sending)
    return report(await sending)
  }

  return { deliver }
}
