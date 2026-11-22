// Roster report: the remote DS-Bot list rides a frame of its own.
// It is not part of hello. hello stays node identity only.
import { NODE_TO_HUB } from '../wire/index.js'

export const ROSTER_CAP = 64

// clusterBotId (interface only): copied when it is a well-formed string, omitted otherwise.
// This module neither generates nor stores it. See MEMORY-STORE-DESIGN.md section 8.
const CLUSTER_BOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// Running background tasks of a Bot (a small read-only summary the hub shows). Anything else is
// dropped: no sessions, no paths. An empty list is kept (it tells the hub none are running).
export const ROSTER_TASK_CAP = 8
const ROSTER_TASK_STATUSES = new Set(['running', 'waiting_approval', 'waiting_work'])

export function cleanRosterTasks(tasks) {
  if (!Array.isArray(tasks)) return undefined
  const out = []
  for (const task of tasks) {
    if (out.length >= ROSTER_TASK_CAP) break
    if (!task || typeof task !== 'object') continue
    const id = typeof task.id === 'string' ? task.id.trim().slice(0, 64) : ''
    if (id === '' || !ROSTER_TASK_STATUSES.has(task.status)) continue
    out.push({
      id,
      title: typeof task.title === 'string' ? task.title.trim().slice(0, 80) : '',
      status: task.status,
      startedAt: Number.isFinite(task.startedAt) ? task.startedAt : 0,
    })
  }
  return out
}

// Cards a Bot is waiting on someone to answer (a learned-skill proposal, a question, a tool approval…).
// The node has no screen, so these ride the roster report to the hub, where the user answers them
// (bot/action → card-answer). Everything is cut down to plain strings and small caps; nothing else
// the node knows about the card leaves it.
export const ROSTER_CARD_CAP = 8
export const ROSTER_CARD_BODY_CAP = 2000
const ROSTER_CARD_KINDS = new Set(['approval', 'question', 'skill', 'rule', 'view', 'secret', 'folder', 'computer', 'other'])

export function cleanRosterCards(cards) {
  if (!Array.isArray(cards)) return undefined
  const out = []
  for (const card of cards) {
    if (out.length >= ROSTER_CARD_CAP) break
    if (!card || typeof card !== 'object') continue
    const id = typeof card.id === 'string' ? card.id.trim().slice(0, 200) : ''
    if (id === '') continue
    const options = []
    for (const option of Array.isArray(card.options) ? card.options : []) {
      if (options.length >= 8) break
      const optionId = typeof option?.id === 'string' ? option.id.trim().slice(0, 64) : ''
      if (optionId === '') continue
      options.push({ id: optionId, label: typeof option.label === 'string' ? option.label.trim().slice(0, 60) : optionId })
    }
    out.push({
      id,
      kind: ROSTER_CARD_KINDS.has(card.kind) ? card.kind : 'other',
      title: typeof card.title === 'string' ? card.title.trim().slice(0, 120) : '',
      body: typeof card.body === 'string' ? card.body.slice(0, ROSTER_CARD_BODY_CAP) : '',
      options,
      input: card.input === true,
      at: Number.isFinite(card.at) ? card.at : 0,
    })
  }
  return out
}

export function cleanRosterBots(bots) {
  const out = []
  if (!Array.isArray(bots)) return out
  for (const bot of bots) {
    if (out.length >= ROSTER_CAP) break
    if (!bot || typeof bot !== 'object') continue
    if (bot.type === 'remote-worker') continue
    const id = typeof bot.id === 'string' ? bot.id.trim().slice(0, 80) : ''
    if (id === '') continue
    const entry = {
      id,
      name: typeof bot.name === 'string' ? bot.name.trim().slice(0, 40) : '',
      role: typeof bot.role === 'string' ? bot.role.trim().slice(0, 24) : '',
    }
    // A bad model drops the field, not the bot. Over-long is truncated, not rejected.
    if (typeof bot.model === 'string') {
      const model = bot.model.trim().slice(0, 128)
      if (model !== '') entry.model = model
    }
    if (typeof bot.clusterBotId === 'string' && CLUSTER_BOT_ID_RE.test(bot.clusterBotId)) {
      entry.clusterBotId = bot.clusterBotId
    }
    const tasks = cleanRosterTasks(bot.tasks)
    if (tasks !== undefined) entry.tasks = tasks
    const cards = cleanRosterCards(bot.cards)
    if (cards !== undefined) entry.cards = cards
    out.push(entry)
  }
  return out
}

export function cleanRosterSkills(skills) {
  if (!skills || skills.version !== 1 || !Array.isArray(skills.items)) return undefined
  const items = []
  for (const item of skills.items.slice(0, 100)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = {
      id: typeof item.id === 'string' ? item.id : '',
      name: typeof item.name === 'string' ? item.name : '',
      description: typeof item.description === 'string' ? item.description : '',
      content: typeof item.content === 'string' ? item.content : '',
    }
    if (!entry.id.trim() || !entry.name.trim()) continue
    if (entry.id.length > 64 || entry.name.length > 120
      || entry.description.length > 400 || entry.content.length > 20000) continue
    items.push(entry)
  }
  const snapshot = { version: 1, items }
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 64 * 1024 ? snapshot : undefined
}

// One roster frame may never exceed this many serialized bytes. The ws layer closes a link on a
// frame over 4 MiB (lib/ws.js), and the worst case of the caps above is about 5 MB (64 Bots x 16
// cards x 4000 chars before the caps were cut, plus tasks and skills). A frame that kills the link
// loses every reply riding it, so the node trims instead: card bodies first, then skill content,
// then the oldest tasks, then the cards themselves. A Bot is never dropped.
export const ROSTER_FRAME_BUDGET_BYTES = 512 * 1024

const frameBytes = (frame) => Buffer.byteLength(JSON.stringify(frame), 'utf8')

/**
 * Trim `frame` in place until it fits `budget` bytes. Returns the list of steps that were taken
 * (empty when it already fit), in the order they were applied.
 */
export function fitRosterFrame(frame, budget = ROSTER_FRAME_BUDGET_BYTES) {
  const steps = []
  if (frameBytes(frame) <= budget) return steps
  // 1. card bodies (the biggest part: up to 8 x 2000 chars per Bot)
  let touched = false
  for (const bot of frame.bots) for (const card of bot.cards ?? []) {
    if (card.body !== '') { card.body = ''; touched = true }
  }
  if (touched) steps.push('card-bodies')
  if (frameBytes(frame) <= budget) return steps
  // 2. skill content (names and descriptions stay, so the hub still lists the skills)
  if (frame.skills) {
    for (const item of frame.skills.items) item.content = ''
    steps.push('skill-content')
    if (frameBytes(frame) <= budget) return steps
  }
  // 3. oldest tasks first, across all Bots
  const all = []
  for (const bot of frame.bots) for (const task of bot.tasks ?? []) all.push({ bot, task })
  all.sort((a, b) => a.task.startedAt - b.task.startedAt)
  let droppedTasks = false
  for (const { bot, task } of all) {
    if (frameBytes(frame) <= budget) break
    bot.tasks.splice(bot.tasks.indexOf(task), 1)
    droppedTasks = true
  }
  if (droppedTasks) steps.push('oldest-tasks')
  if (frameBytes(frame) <= budget) return steps
  // 4. last resort: the cards themselves (oldest first). The Bots stay.
  const cards = []
  for (const bot of frame.bots) for (const card of bot.cards ?? []) cards.push({ bot, card })
  cards.sort((a, b) => a.card.at - b.card.at)
  for (const { bot, card } of cards) {
    if (frameBytes(frame) <= budget) break
    bot.cards.splice(bot.cards.indexOf(card), 1)
  }
  steps.push('cards')
  return steps
}

export function rosterFrame({ nodeId, hostname, bots, skills } = {}) {
  const frame = {
    nodeId: typeof nodeId === 'string' ? nodeId : '',
    hostname: typeof hostname === 'string' ? hostname.slice(0, 80) : '',
    bots: cleanRosterBots(bots),
  }
  const snapshot = cleanRosterSkills(skills)
  if (snapshot !== undefined) frame.skills = snapshot
  // headroom for the `trimmed` marker that is added below, so the final frame is still within the budget
  const trimmed = fitRosterFrame(frame, ROSTER_FRAME_BUDGET_BYTES - 128)
  // Visible, not silent: the hub logs it and ds-bot can read it from the roster event.
  if (trimmed.length > 0) frame.trimmed = trimmed
  return frame
}

// An unchanged roster is not sent again within this window (the host republishes every 5 s).
// 30 s keeps the hub's last-seen fresh without a 5 s stream of identical, potentially large frames.
export const ROSTER_RESEND_MS = 30_000

// The node plugin registers this. The remote DS-Bot calls it. It is not hello.
export function bindRosterReport(ctx, { send, nodeId, hostname, now = Date.now } = {}) {
  let lastJson = ''
  let lastAt = 0
  const report = (payload = {}) => {
    const frame = rosterFrame({
      nodeId: payload.nodeId ?? nodeId,
      hostname: payload.hostname ?? hostname,
      bots: payload.bots,
      skills: payload.skills,
    })
    if (typeof send !== 'function') return false
    const json = JSON.stringify(frame)
    const at = now()
    // Same content as the last frame that went out, and it went out recently: nothing to tell the hub.
    // Reported as sent (true): the caller's contract is "the hub has this roster".
    if (json === lastJson && at - lastAt < ROSTER_RESEND_MS) return true
    const sent = send(NODE_TO_HUB.ROSTER, frame) === true
    if (sent) { lastJson = json; lastAt = at }
    return sent
  }
  try { ctx?.provide?.('remote-agent:roster-report', report) } catch { /* registry is optional */ }
  return report
}
