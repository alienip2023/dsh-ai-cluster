// The node's Bot identity book: the portable ed25519 identity of every local Bot.
//
// - load(): reads every identity file under botsRoot() at startup.
// - decorate(bots): called on each roster report; gives every reported Bot an identity
//   (created on first sight, keyed by its local ds-bot id) and adds `identityId` to its
//   roster entry, so the hub learns the id it can locate the Bot by.
// The same Map is what bot/locate (lib/node/dispatch.js) signs with, so a Bot created
// after startup can be located as soon as it has been reported once.
import { BotIdentity, ensureBotIdentityFor, listBotIds, loadBotIdentity } from '../identity/bot-identity.js'

export function createBotIdentityBook({ homeNodeId = '', botsDir, log = () => {} } = {}) {
  const identities = new Map() // identity id → BotIdentity
  const byLocal = new Map() // local ds-bot id → identity id
  const dirOpt = botsDir === undefined ? {} : { botsDir }

  const add = (record) => {
    if (!record) return undefined
    let identity = identities.get(record.id)
    if (!identity) {
      try { identity = new BotIdentity(record) } catch { return undefined }
      identities.set(record.id, identity)
    }
    if (typeof record.localBotId === 'string' && record.localBotId !== '') byLocal.set(record.localBotId, record.id)
    return identity
  }

  const load = () => {
    for (const id of listBotIds(botsDir)) add(loadBotIdentity(id, botsDir))
    return identities.size
  }

  const decorate = (bots) => bots.map((bot) => {
    const localBotId = typeof bot?.id === 'string' ? bot.id.trim() : ''
    if (localBotId === '' || bot.type === 'remote-worker') return bot
    // Roster reports come every few seconds: a Bot already in the book needs no disk read.
    const knownId = byLocal.get(localBotId)
    if (knownId !== undefined && identities.has(knownId)) return { ...bot, identityId: knownId }
    const record = ensureBotIdentityFor({ localBotId, name: bot.name ?? '', role: bot.role ?? '', homeNodeId, cache: byLocal, ...dirOpt })
    const identity = add(record)
    if (!identity) { log('warn', 'bot identity not available', { localBotId }); return bot }
    return { ...bot, identityId: identity.id }
  })

  return { identities, load, decorate }
}
