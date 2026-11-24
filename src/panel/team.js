/**
 * 团队屏：按机器列出 Bot（对话 / 编辑 / 停止 / 定位）、创建与编辑表单、Bot 对话、模型目录、
 * 团队记忆（ds-bot 的 memory-hub-*）、目标、Bot 间通信审计。
 * 构建脚本会把本文件并入 lib/client.js（去掉 import/export）：顶层标识符一律以 `team` 开头，import 只能单行。
 * 纯函数放在顶层（测试直接 import）；要用 React 的都在 createTeam 里。
 */
import { coreExplain, coreFmtTime, coreMinNodeVersion, coreShortId, coreVersionAtLeast } from './core.js'

/* ── 常量：上限与服务端一致（src/http/routes.js 的 BOT_LIMITS / BOT_TURN_TEXT_MAX） ── */

export const teamLimits = Object.freeze({ name: 40, role: 24, modelRef: 128, workDir: 1024, instructionsBytes: 8000 })
export const teamTurnTextMax = 8000
export const teamTurnPollMs = 2000
export const teamTurnDeadlineMs = 5 * 60 * 1000
export const teamMemMissing = 'memory-api-missing'
export const teamTeamScope = JSON.stringify({ kind: 'team' })

/** 稳定错误码 → 一句人话；未知码原样显示（见 teamExplain）。 */
export const teamErrorText = {
  'bot-nodeId-missing': '还没有选机器',
  'bot-nodeId-invalid': '机器 id 格式不对',
  'bot-botId-invalid': 'Bot id 格式不对',
  'bot-create-name-missing': '名称不能为空',
  'bot-name-too-long': '名称超过 40 个字符',
  'bot-role-too-long': '角色超过 24 个字符',
  'bot-modelRef-too-long': '模型超过 128 个字符',
  'bot-workDir-too-long': '工作目录超过 1024 个字符',
  'bot-instructions-too-long': '指令超过 8000 字节',
  'bot-update-remoteBotId-missing': '缺少要编辑的 Bot',
  'bot-update-all-null': '没有任何改动（留空的字段表示「不修改」）',
  'bot-create-failed': '机器没有创建成功',
  'bot-update-failed': '机器没有保存成功',
  'bot-history-failed': '读不到对话历史',
  'bot-stop-failed': '停止没有成功',
  'bot-turn-failed': '这一轮对话失败了',
  'bot-turn-text-empty': '消息不能为空',
  'bot-turn-text-too-long': '消息超过 8000 个字符',
  'bot-history-params-missing': '缺少机器或 Bot',
  'bot-create-busy': '正在处理的请求太多，稍后再试',
  'bot-update-busy': '正在处理的请求太多，稍后再试',
  'bot-history-busy': '正在处理的请求太多，稍后再试',
  'bot-stop-busy': '正在处理的请求太多，稍后再试',
  'bot-identityId-missing': '这个 Bot 没有身份 id',
  'bot-locate-failed': '定位没有成功',
  'bad-bot-id': '身份 id 格式不对',
  'no-registry': '主控暂时没有可用的机器注册表',
  'roster-unavailable': '主控读不到名册存储',
  'turn-unknown': '主控已经不认识这一轮（可能已过期）',
  'bad-body': '请求内容不对',
}
export function teamExplain(code) {
  const c = String(code || 'unknown')
  return teamErrorText[c] ? teamErrorText[c] + '（' + c + '）' : coreExplain(c)
}

export function teamUtf8Bytes(s) {
  const str = String(s == null ? '' : s)
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length
  return unescape(encodeURIComponent(str)).length
}

/* ── ds-bot 的 /api/bot：归类 (status, 原文) ───────────────────────────── */

/** ds-bot 回 {ok:true,value} 或 {ok:false,error:{code,message}}。404 / 非 JSON / 没有 ok 字段 / bot/not-found 都表示端点不存在。 */
export function teamBotOutcome(status, text) {
  if (status === 404) return { kind: 'missing', reason: teamMemMissing, status }
  let body
  try { body = JSON.parse(text) } catch { return { kind: 'missing', reason: teamMemMissing, status } }
  if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') return { kind: 'missing', reason: teamMemMissing, status }
  if (body.ok === true) return { kind: 'ok', value: body.value }
  const err = body.error && typeof body.error === 'object' ? body.error : {}
  if (err.code === 'bot/not-found') return { kind: 'missing', reason: teamMemMissing, status }
  return { kind: 'error', reason: String(err.message || err.code || 'unknown'), status }
}

/** 调 ds-bot 端点；失败时 reject 一个带 reason / missing / status 的 Error。 */
export function teamBotCall(endpoint, payload) {
  return fetch('/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload: payload || {} }),
  }).then((r) => r.text().then((text) => teamBotOutcome(r.status, text)), (e) => ({ kind: 'error', reason: String((e && e.message) || 'network'), status: 0 }))
    .then((out) => {
      if (out.kind === 'ok') return out.value
      const e = new Error(out.reason)
      e.reason = out.reason
      e.missing = out.kind === 'missing'
      e.status = out.status
      throw e
    })
}

/* ── 名册 / 模型：回包投影 ──────────────────────────────────────────────── */

/** GET /bots 的回包（或 safe() 包出来的失败）→ { kind:'data', nodes } | { kind:'error', reason }。 */
export function teamRosterProject(d) {
  if (d && typeof d === 'object' && d.ok === true && Array.isArray(d.nodes)) return { kind: 'data', nodes: d.nodes }
  const reason = d && typeof d === 'object' ? String(d.code || d.error || d.reason || 'unexpected-shape') : 'unexpected-shape'
  return { kind: 'error', reason }
}

/** GET /models：ok:true 带 nodes 才是数据（空数组 = 还没有机器上报）；其余是错误，不是空。 */
export function teamModelsProject(d) {
  if (d && typeof d === 'object' && d.ok === true && Array.isArray(d.nodes)) {
    const nodes = d.nodes.filter((n) => n && typeof n === 'object' && typeof n.nodeId === 'string' && n.nodeId !== '')
    return { kind: nodes.length === 0 ? 'empty' : 'data', nodes }
  }
  const parts = d && typeof d === 'object' ? [d.code, d.reason, d.error].filter((x) => typeof x === 'string' && x !== '') : []
  return { kind: 'error', reason: parts.length ? parts.join(' / ') : 'unexpected-shape' }
}

/**
 * 机器行 = 名册里的机器 ∪ 主机快照里在线、但名册还没有的机器（新机器的第一个 Bot 才建得出来）。
 * 在线状态以名册为准，只有名册里没有这台机器时才退回主机快照。
 */
export function teamNodeRows(rosterNodes, hubNodes) {
  const roster = Array.isArray(rosterNodes) ? rosterNodes : []
  const seen = new Set()
  const rows = roster.filter((n) => n && n.nodeId != null).map((n) => {
    seen.add(String(n.nodeId))
    const acVersion = typeof n.acVersion === 'string' ? n.acVersion : ''
    const at = coreVersionAtLeast(acVersion, coreMinNodeVersion)
    return {
      nodeId: String(n.nodeId),
      hostname: String(n.hostname || n.nodeId),
      online: n.online === true,
      lastSeen: typeof n.lastSeen === 'number' ? n.lastSeen : null,
      acVersion,
      versionState: at === true ? 'ok' : at === false ? 'old' : 'unknown',
      hasRoster: true,
      bots: (Array.isArray(n.bots) ? n.bots : []).filter((b) => b && b.id != null).map((b) => {
        const identityId = typeof b.identityId === 'string' ? b.identityId : ''
        return {
          key: String(n.nodeId) + '/' + String(b.id),
          id: String(b.id),
          name: String(b.name || b.id),
          role: String(b.role || ''),
          model: String(b.model || ''),
          identityId,
          shortId: coreShortId(identityId, 8),
        }
      }),
    }
  })
  for (const n of Array.isArray(hubNodes) ? hubNodes : []) {
    if (!n || n.online !== true || n.nodeId == null || seen.has(String(n.nodeId))) continue
    rows.push({
      nodeId: String(n.nodeId), hostname: String(n.hostname || n.nodeId), online: true, lastSeen: null,
      acVersion: '', versionState: 'unknown', hasRoster: false, bots: [],
    })
  }
  rows.sort((a, b) => (a.online === b.online ? a.hostname.localeCompare(b.hostname) : a.online ? -1 : 1))
  return rows
}

export function teamFindBot(rows, nodeId, botId) {
  const node = (rows || []).find((n) => n.nodeId === nodeId)
  if (!node) return null
  const bot = node.bots.find((b) => b.id === botId)
  return bot ? { node, bot } : null
}

/** nodeId → 主机名。名册优先，其次主机快照；都没有就是 nodeId 本身。 */
export function teamNameMap(rows, hubNodes) {
  const map = {}
  for (const n of Array.isArray(hubNodes) ? hubNodes : []) if (n && n.nodeId != null) map[String(n.nodeId)] = String(n.hostname || n.nodeId)
  for (const n of rows || []) map[n.nodeId] = n.hostname
  return map
}

export function teamVersionNote(row) {
  if (row.versionState === 'old') return { tone: 'warn', badge: 'AC ' + row.acVersion + ' 过旧', hint: '低于 ' + coreMinNodeVersion + '：Bot 协作、停止、定位在这台机器上可能不可用，请升级它的 AC。' }
  if (row.versionState === 'unknown') return { tone: '', badge: '版本未知', hint: '' }
  return { tone: '', badge: 'AC ' + row.acVersion, hint: '' }
}

/** 各动作为什么不可用；空串 = 可用。 */
export function teamBotBlockers(node, bot) {
  const offline = node.online ? '' : '这台机器离线'
  return {
    chat: offline,
    edit: offline,
    stop: offline,
    locate: bot.identityId ? '' : '这个 Bot 没有身份 id（机器上的 AC 版本太旧，名册没带它）',
  }
}

/* ── 创建 / 编辑表单 ───────────────────────────────────────────────────── */

export function teamFormInit(extra) {
  return Object.assign({ mode: 'create', nodeId: '', botId: '', name: '', role: '', modelRef: '', workDir: '', instructions: '', base: null, applied: '' }, extra || {})
}

export function teamFormFromBot(node, bot) {
  return teamFormInit({
    mode: 'edit', nodeId: node.nodeId, botId: bot.id, name: bot.name, role: bot.role, modelRef: bot.model,
    base: { name: bot.name, role: bot.role, modelRef: bot.model },
  })
}

const teamTrimLen = (s) => String(s == null ? '' : s).trim().length

/** 与服务端同口径的校验：name/role/modelRef/workDir 去首尾空白后按字符数，instructions 按 UTF-8 字节。 */
export function teamFormCheck(f) {
  const out = []
  if (f.mode === 'edit') {
    if (String(f.botId || '').trim() === '') out.push({ field: 'botId', code: 'bot-update-remoteBotId-missing' })
  } else if (String(f.nodeId || '').trim() === '') out.push({ field: 'nodeId', code: 'bot-nodeId-missing' })
  if (f.mode !== 'edit' && teamTrimLen(f.name) === 0) out.push({ field: 'name', code: 'bot-create-name-missing' })
  if (teamTrimLen(f.name) > teamLimits.name) out.push({ field: 'name', code: 'bot-name-too-long' })
  if (teamTrimLen(f.role) > teamLimits.role) out.push({ field: 'role', code: 'bot-role-too-long' })
  if (teamTrimLen(f.modelRef) > teamLimits.modelRef) out.push({ field: 'modelRef', code: 'bot-modelRef-too-long' })
  if (teamTrimLen(f.workDir) > teamLimits.workDir) out.push({ field: 'workDir', code: 'bot-workDir-too-long' })
  if (teamUtf8Bytes(String(f.instructions || '').trim()) > teamLimits.instructionsBytes) out.push({ field: 'instructions', code: 'bot-instructions-too-long' })
  return out
}

export function teamCreateBody(f) {
  const t = (v) => String(v == null ? '' : v).trim()
  return { nodeId: t(f.nodeId), name: t(f.name), role: t(f.role), modelRef: t(f.modelRef), workDir: t(f.workDir), instructions: t(f.instructions) }
}

/** 编辑只发有改动的字段（服务端本来就把空白当「不修改」）；一项都没改返回 null。 */
export function teamEditBody(f) {
  const base = f.base || { name: '', role: '', modelRef: '' }
  const t = (v) => String(v == null ? '' : v).trim()
  const body = { nodeId: t(f.nodeId), botId: t(f.botId) }
  let changed = false
  for (const k of ['name', 'role', 'modelRef']) {
    if (t(f[k]) !== '' && t(f[k]) !== t(base[k])) { body[k] = t(f[k]); changed = true }
  }
  for (const k of ['workDir', 'instructions']) {
    if (t(f[k]) !== '') { body[k] = t(f[k]); changed = true }
  }
  return changed ? body : null
}

/** 表单里有没有用户填的东西（决定切换目标前要不要确认）。 */
export function teamFormDirty(f) {
  if (!f) return false
  if (f.mode === 'edit') return teamEditBody(f) !== null
  return ['name', 'role', 'modelRef', 'workDir', 'instructions'].some((k) => String(f[k] || '').trim() !== '')
}

/** 创建成功后：保留机器，其余清空；编辑成功后：基线更新为刚保存的值，工作目录与指令回到「留空」。 */
export function teamFormAfterSave(f) {
  if (f.mode !== 'edit') return teamFormInit({ nodeId: f.nodeId })
  const t = (v) => String(v == null ? '' : v).trim()
  const base = f.base || {}
  return Object.assign({}, f, {
    workDir: '', instructions: '', applied: '',
    name: t(f.name) || t(base.name), role: t(f.role) || t(base.role), modelRef: t(f.modelRef) || t(base.modelRef),
    base: { name: t(f.name) || t(base.name), role: t(f.role) || t(base.role), modelRef: t(f.modelRef) || t(base.modelRef) },
  })
}

/** 模板（ds-bot list-templates）填表：名称 / 角色 / 指令（取 description）/ 模型。 */
export function teamApplyTemplate(f, t) {
  const patch = {
    name: String(t.name || ''), role: String(t.role || '').slice(0, teamLimits.role),
    instructions: String(t.instructions || t.description || '').trim(), applied: '模板「' + String(t.name || t.id) + '」',
  }
  if (t.model) patch.modelRef = String(t.model)
  return Object.assign({}, f, patch)
}

/** 人才库（ds-bot list-talents）填表：名称 / 角色；服务端只给一句职责（duty），当作指令的起点。 */
export function teamApplyTalent(f, t) {
  return Object.assign({}, f, {
    name: String(t.name || ''), role: String(t.role || t.duty || '').slice(0, teamLimits.role),
    instructions: String(t.duty || '').trim(), applied: '人才「' + String(t.name) + '」',
  })
}

export function teamTemplateGroups(templates) {
  const by = {}
  for (const t of Array.isArray(templates) ? templates : []) {
    if (!t || t.id == null) continue
    const cat = t.category || '其他'
    ;(by[cat] = by[cat] || []).push(t)
  }
  return Object.keys(by).sort().map((cat) => ({ category: cat, items: by[cat] }))
}

/** 一台机器上报的模型：null = 从未上报；数组里不是「带非空 id 的对象」的条目丢掉，顺序不变。 */
export function teamCleanModels(models) {
  if (!Array.isArray(models)) return null
  return models.filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id !== '')
}

/** 某台机器上报的模型（给表单的模型选择器）。 */
export function teamModelOptions(modelNodes, nodeId) {
  const n = (Array.isArray(modelNodes) ? modelNodes : []).find((x) => x && String(x.nodeId) === String(nodeId))
  const list = n ? teamCleanModels(n.models) : null
  if (!list) return []
  return list.map((m) => ({
    id: String(m.id), label: String(m.name || m.id) + (String(m.name || m.id) === String(m.id) ? '' : ' (' + String(m.id) + ')') + (n.defaultModel != null && m.id === n.defaultModel ? ' · 默认' : ''),
  }))
}

/** 模型目录的一台机器：把 models 的三种状态（null / [] / 有数据）说清楚。 */
export function teamModelsNodeView(n) {
  const models = teamCleanModels(n.models)
  return {
    nodeId: String(n.nodeId), hostname: String(n.hostname || n.nodeId), online: n.online === true,
    defaultModel: typeof n.defaultModel === 'string' && n.defaultModel !== '' ? n.defaultModel : null,
    state: models === null ? 'unreported' : models.length === 0 ? 'none' : 'list',
    rows: (models || []).map((m) => ({
      id: String(m.id), label: String(m.name || m.id) + ' (' + String(m.id) + ')', isDefault: n.defaultModel != null && m.id === n.defaultModel,
      efforts: Array.isArray(m.efforts) ? m.efforts.filter((e) => e && e.id != null).map((e) => String(e.id)) : [],
    })),
  }
}
export function teamModelsTotal(nodes) {
  return (Array.isArray(nodes) ? nodes : []).reduce((sum, n) => sum + (n ? (teamCleanModels(n.models) || []).length : 0), 0)
}

/* ── 对话：历史与回合的纯状态机 ─────────────────────────────────────────── */

export const teamHistInit = Object.freeze({ state: 'loading', items: [], error: '' })
/** load 保留旧条目（刷新时不闪空）；ok 换成新条目；fail 清空并记原文。 */
export function teamHistReduce(s, a) {
  switch (a.type) {
    case 'load': return { state: 'loading', items: s.items, error: '' }
    case 'ok': return { state: 'ready', items: Array.isArray(a.items) ? a.items : [], error: '' }
    case 'fail': return { state: 'error', items: [], error: String(a.error || 'unknown') }
    default: return s
  }
}

export const teamTurnInit = Object.freeze({ state: 'idle', sent: '', text: '', error: '', warn: '', linkLost: false })
export function teamTurnReduce(s, a) {
  switch (a.type) {
    case 'start': return { state: 'running', sent: String(a.sent || ''), text: '', error: '', warn: '', linkLost: false }
    case 'running': return Object.assign({}, s, { state: 'running', warn: '', linkLost: a.linkLost === true })
    case 'warn': return Object.assign({}, s, { warn: String(a.error || 'unknown') })
    case 'done': return Object.assign({}, s, { state: 'done', text: String(a.text || ''), error: '', warn: '', linkLost: false })
    case 'failed': return Object.assign({}, s, { state: 'failed', text: String(a.text || ''), error: String(a.error || 'unknown'), warn: '', linkLost: false })
    case 'timeout': return Object.assign({}, s, { state: 'timeout', warn: '', linkLost: false })
    case 'reset': return teamTurnInit
    default: return s
  }
}

/** GET /bots/turn?exchangeId 的回包（或 safe() 包出的传输失败）→ reducer 动作。传输失败只是「轮询没成」，不判回合失败。 */
export function teamTurnFromPoll(s) {
  if (!s || typeof s !== 'object') return { type: 'warn', error: 'unexpected-shape' }
  if (s.state === 'done') return { type: 'done', text: s.text }
  if (s.state === 'failed') return { type: 'failed', error: s.error || 'bot-turn-failed', text: s.text }
  if (s.state === 'unknown') return { type: 'failed', error: 'turn-unknown' }
  if (s.state === 'running') return { type: 'running', linkLost: s.linkLost === true }
  return { type: 'warn', error: String(s.error || 'unexpected-shape') }
}

/** 发送前的本地检查，返回服务端同名错误码；'' = 可以发。 */
export function teamTurnCheck(text) {
  const t = String(text == null ? '' : text)
  if (t.trim() === '') return 'bot-turn-text-empty'
  if (t.length > teamTurnTextMax) return 'bot-turn-text-too-long'
  return ''
}

/** Enter 发送，Shift/Ctrl/Alt/Meta+Enter 与输入法组字中的 Enter 不发送（交给 textarea 换行/确认候选）。 */
export function teamEnterSends(e) {
  if (!e || e.key !== 'Enter') return false
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false
  return !(e.isComposing === true || (e.nativeEvent && e.nativeEvent.isComposing === true))
}

/** ds-bot 的 chatPage 条目：{ kind:'user'|'bot'|'post'|'task-brief'|'event'|'divider'…, text, time }；兼容旧的 role/content 形状。 */
export function teamHistoryRows(items) {
  const who = { user: '我', bot: 'Bot', assistant: 'Bot', post: 'Bot', 'task-brief': '任务简报', event: '事件', answer: '回答' }
  return (Array.isArray(items) ? items : []).map((it, i) => {
    const o = it && typeof it === 'object' ? it : {}
    const kind = String(o.kind || o.role || '')
    if (kind === 'divider') return { key: 'i' + i, side: 'sys', who: '', text: '—— 新的一段对话 ——', time: coreFmtTime(o.time) }
    let text = o.text != null ? o.text : o.content
    if (text == null && Array.isArray(o.texts)) text = o.texts.join('\n')
    return {
      key: 'i' + i,
      side: kind === 'user' ? 'user' : (kind === 'bot' || kind === 'assistant' || kind === 'post') ? 'bot' : 'sys',
      who: who[kind] || kind || '?',
      text: text == null || String(text) === '' ? '[' + (kind || '空条目') + ']' : String(text),
      time: typeof o.time === 'number' ? coreFmtTime(o.time) : '',
    }
  })
}

/* ── 定位结果 ──────────────────────────────────────────────────────────── */

const teamRejectText = {
  'key-does-not-match-bot': '公钥对不上这个 Bot id',
  'bad-signature': '签名核验没通过',
  'wrong-node': '回答来自别的连接',
  'wrong-bot': '回答的不是这个 Bot',
  invalid: '回答格式不对',
}

/** GET /bots/locate 的成功回包 → 一组「人话」。nameOf(nodeId) 把机器 id 换成主机名。 */
export function teamLocateView(d, nameOf) {
  const name = (id) => { const n = nameOf ? nameOf(String(id)) : ''; return n && n !== String(id) ? n + '（' + id + '）' : String(id) }
  const list = (x) => (Array.isArray(x) ? x : [])
  const found = list(d && d.locations).map((l) => ({ nodeId: l.nodeId, label: name(l.nodeId), machineId: String(l.machineId || '') }))
  const groups = [
    { id: 'notHere', title: '回答「不在我这里」的机器', items: list(d && d.notHere).map(name) },
    { id: 'silent', title: '没有在时限内回答的机器', items: list(d && d.silent).map(name) },
    { id: 'unsupported', title: '在线但版本太旧、不支持定位的机器', items: list(d && d.unsupported).map(name) },
    { id: 'unsent', title: '没能把询问发出去的机器', items: list(d && d.unsent).map(name) },
    { id: 'rejected', title: '回答没通过核验、已被忽略的机器', items: list(d && d.rejected).map((r) => name(r.nodeId) + '：' + (teamRejectText[r.reason] || r.reason || '未知原因')) },
  ].filter((g) => g.items.length > 0)
  return { found, groups, nobody: found.length === 0 }
}

/* ── 记忆 ──────────────────────────────────────────────────────────────── */

/** 范围选项：value 是 memory-federation 接受的对象（JSON 串），字段全取自 memory-hub-scopes 的回包。 */
export function teamMemScopeOptions(scopes) {
  if (!scopes || typeof scopes !== 'object') return []
  const out = [{ group: 'team', label: '团队', value: teamTeamScope, entries: scopes.team && scopes.team.entries != null ? scopes.team.entries : null }]
  const nodes = Array.isArray(scopes.nodes) ? scopes.nodes : []
  for (const n of nodes) {
    out.push({ group: 'node', label: String(n.hostname || n.nodeId) + (n.online ? '' : '（离线）'), value: JSON.stringify({ kind: 'node', nodeId: n.nodeId }), entries: n.entries == null ? null : n.entries })
  }
  for (const n of nodes) {
    for (const b of Array.isArray(n.bots) ? n.bots : []) {
      out.push({ group: 'bot', label: String(b.name || b.remoteBotId) + ' @ ' + String(n.hostname || n.nodeId), value: JSON.stringify({ kind: 'bot', nodeId: n.nodeId, remoteBotId: b.remoteBotId }), entries: b.entries == null ? null : b.entries })
    }
  }
  return out
}

export function teamMemScopeObj(value) {
  try {
    const o = JSON.parse(value)
    return o && typeof o === 'object' ? o : { kind: 'team' }
  } catch { return { kind: 'team' } }
}

/** 条目行：原样带出 text / topic / 标记；过期行 muted。 */
export function teamMemEntryRows(view) {
  const entries = view && Array.isArray(view.entries) ? view.entries : []
  const s = (v) => (v == null ? '' : String(v))
  return entries.map((e, i) => ({
    key: e.id != null ? String(e.id) : 'i' + i, text: s(e.text), topic: s(e.topic), added: s(e.added), until: s(e.until), by: s(e.by),
    pinned: e.pinned === true, expired: e.expired === true,
  }))
}

/** 把 reject 出来的 Error 归成 { state:'missing'|'error', reason }。 */
export function teamMemFail(e) {
  return { state: e && e.missing ? 'missing' : 'error', data: null, reason: String((e && (e.reason || e.message)) || 'unknown'), status: (e && e.status) || 0 }
}

/* ── 目标 / 审计 ───────────────────────────────────────────────────────── */

export function teamGoalGroups(goals) {
  const list = Array.isArray(goals) ? goals : []
  return { active: list.filter((g) => g && !g.idle), idle: list.filter((g) => g && g.idle) }
}

const teamAuditKinds = {
  'approval-request': { label: '待批', tone: 'warn' },
  'approval-settled': { label: '已结算', tone: 'ok' },
  ask: { label: 'Bot 提问', tone: '' },
  reply: { label: 'Bot 回复', tone: '' },
  'bot-message': { label: 'Bot 消息', tone: '' },
  'bot.assign': { label: '派活（历史）', tone: '' },
  assign: { label: '派活（历史）', tone: '' },
}

/**
 * 审计条目 → 一行。已知种类：approval-request / approval-settled / ask / reply（Bot 消息：hub 写入时 msg.kind 把
 * 'bot-message' 盖掉了）/ bot-message / bot.assign（0.4.36 起不再产生，旧记录照常显示）；其余种类显示种类名 + 几个字段。
 */
export function teamAuditRow(e, i, nameOf) {
  const o = e && typeof e === 'object' ? e : {}
  const kind = String(o.kind || '')
  const meta = teamAuditKinds[kind] || { label: kind || '未知', tone: '' }
  const host = (id) => (id != null && nameOf && nameOf(String(id)) ? nameOf(String(id)) : id != null ? String(id) : '?')
  const side = (x) => {
    if (x && typeof x === 'object') return String(x.name || x.id || '?') + '@' + host(x.nodeId)
    return x == null ? '?' : String(x)
  }
  const clip = (v, n) => String(v == null ? '' : v).slice(0, n)
  let text
  if (kind === 'approval-request') {
    text = String(o.botId || '?') + '@' + host(o.nodeId) + ' 申请 ' + String(o.tool || '?') + (o.reason ? '：' + clip(o.reason, 80) : '')
  } else if (kind === 'approval-settled') {
    text = String(o.approvalId || '?') + ' → ' + String(o.outcome || '?') + '（' + host(o.nodeId) + '）'
  } else if (kind === 'ask' || kind === 'reply' || kind === 'bot-message') {
    text = side(o.from) + ' → ' + side(o.to) + (o.text ? '：' + clip(o.text, 120) : '') + (typeof o.depth === 'number' ? '（第 ' + o.depth + ' 层）' : '')
  } else if (kind === 'bot.assign' || kind === 'assign') {
    text = side(o.from) + ' → ' + side(o.to) + (o.op ? ' · ' + o.op : '') + (o.outcome ? ' · ' + o.outcome : '') + (typeof o.chars === 'number' ? ' · ' + o.chars + ' 字' : '')
  } else {
    text = Object.keys(o).filter((k) => k !== 'kind' && k !== 'at').slice(0, 4).map((k) => k + '=' + clip(typeof o[k] === 'object' ? JSON.stringify(o[k]) : o[k], 40)).join(' · ')
  }
  return { key: 'a' + i, label: meta.label, tone: meta.tone, time: coreFmtTime(o.at), text, history: kind === 'bot.assign' || kind === 'assign' }
}

/* ── 头像：由身份 id（没有就用名称）确定性生成的一对色相。同一个 Bot 永远同一对，颜色只在 CSS 里用 hsl(var(--tm-h1/h2)) 合成。 ── */

/** FNV-1a（32 位，按 UTF-16 码元）；Math.imul 保证在任何引擎里结果一样。 */
function teamHash(str, seed) {
  let x = (0x811c9dc5 ^ seed) >>> 0
  const s = String(str == null ? '' : str)
  for (let i = 0; i < s.length; i += 1) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0
  return Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0
}

/** seed → [h1, h2]，都是 0..359 的整数；h2 总是比 h1 偏 48..143 度，所以渐变始终有两种可辨的颜色。 */
export function teamAvatarHues(seed) {
  const h1 = teamHash(seed, 0) % 360
  const h2 = (h1 + 48 + (teamHash(seed, 0x9e3779b9) % 96)) % 360
  return [h1, h2]
}

export function teamAvatarSeed(bot) {
  return String((bot && (bot.identityId || bot.name || bot.id)) || '')
}

/** 头像圆首字：名称的第一个字（按码点），没有名称就用 ?。 */
export function teamAvatarInitial(name) {
  const first = Array.from(String(name == null ? '' : name).trim())[0]
  return first ? first.toUpperCase() : '?'
}

/** 设在元素 style 上的自定义属性（全面板唯一允许算出来的颜色，样式表里只读这两个变量）。 */
export function teamAvatarStyle(seed) {
  const hues = teamAvatarHues(seed)
  return { '--tm-h1': String(hues[0]), '--tm-h2': String(hues[1]) }
}

/* ── 样式（类名前缀 tm-，颜色只用 styles.js 的 token） ─────────────────── */

export const teamCss = [
  /* 版式：不用视口媒体查询，两栏靠 auto-fit 自动折成一栏 */
  '.tm-layout{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:16px;align-items:start}',
  '.tm-sub{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
  '.tm-why{color:var(--dra-text-dim);font-size:12px;margin:0 0 6px}',
  '.tm-count{display:inline-flex;align-items:center;border:1px solid var(--dra-border);border-radius:var(--dra-r-pill);padding:2px 12px;background:color-mix(in srgb,var(--dra-surface-2) 60%,transparent);color:var(--dra-text-dim);font-variant-numeric:tabular-nums}',

  /* 头像：渐变圆（颜色只来自 --tm-h1/--tm-h2），在线的有呼吸环；首字用 CSS 画，不进文本 */
  '.tm-avatar{position:relative;flex:none;width:38px;height:38px;border-radius:var(--dra-r-pill);display:inline-flex;align-items:center;justify-content:center;color:var(--dra-ok);',
  'background:linear-gradient(140deg,hsl(var(--tm-h1) 84% 64%),hsl(var(--tm-h2) 78% 54%));box-shadow:var(--dra-hl),0 3px 10px -3px hsl(var(--tm-h2) 80% 45%)}',
  '.tm-avatar::before{content:attr(data-initial);color:var(--dra-on-primary);font-size:16px;font-weight:700;line-height:1}',
  '.dra-light .tm-avatar{background:linear-gradient(140deg,hsl(var(--tm-h1) 70% 46%),hsl(var(--tm-h2) 66% 38%))}',
  '.tm-avatar.tm-on{animation:tm-ring 2.8s ease-out infinite}',
  '@keyframes tm-ring{0%{box-shadow:var(--dra-hl),0 0 0 0 color-mix(in srgb,currentColor 60%,transparent)}70%,100%{box-shadow:var(--dra-hl),0 0 0 9px transparent}}',
  '.tm-off .tm-avatar{opacity:.55;filter:grayscale(.9)}',
  '.tm-avatar.tm-sm{width:26px;height:26px}.tm-avatar.tm-sm::before{font-size:12px}',

  /* 机器 = 玻璃卡：在线的顶上一条极光细光；Bot 列表是 iOS 风的内嵌分组 */
  '.tm-node{position:relative}',
  '.tm-node.tm-on::before{content:"";position:absolute;left:24px;right:24px;top:0;height:2px;border-radius:var(--dra-r-pill);background:var(--dra-aurora);opacity:.85}',
  '.tm-bots{list-style:none;margin:0;padding:0;border:1px solid var(--dra-border);border-radius:var(--dra-r-md);overflow:hidden;background:color-mix(in srgb,var(--dra-surface-1) 55%,transparent)}',
  '.tm-bot{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:start;padding:12px 14px;border-top:1px solid color-mix(in srgb,var(--dra-border) 80%,transparent);transition:background-color .2s var(--dra-ease)}',
  '.tm-bot:first-child{border-top:0}.tm-bot:hover{background:color-mix(in srgb,var(--dra-accent) 6%,transparent)}',
  '.tm-bot-body{display:flex;flex-direction:column;gap:7px;min-width:0}',
  '.tm-bot-main{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}.tm-name{font-size:14px;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere}',
  '.tm-off .tm-bot-main,.tm-off .tm-id{opacity:.7}',
  '.tm-chip{display:inline-flex;align-items:center;max-width:100%;border:1px solid var(--dra-border);border-radius:var(--dra-r-pill);padding:0 10px;font-size:12px;line-height:20px;color:var(--dra-text-dim);background:color-mix(in srgb,var(--dra-surface-2) 70%,transparent);overflow-wrap:anywhere}',
  '.tm-chip.tm-topic{color:var(--dra-accent);border-color:color-mix(in srgb,var(--dra-accent) 40%,transparent);background:color-mix(in srgb,var(--dra-accent) 10%,transparent)}',
  '.tm-pill{display:inline-flex;align-items:center;border:1px solid color-mix(in srgb,var(--dra-accent-2) 45%,transparent);border-radius:var(--dra-r-pill);padding:0 10px;font-size:12px;line-height:20px;color:var(--dra-text);background:color-mix(in srgb,var(--dra-accent-2) 14%,transparent);letter-spacing:.02em}',

  /* 详情面板：抬高的玻璃卡 */
  '.tm-detail{background:var(--dra-sheen),var(--dra-glass-strong);border-color:var(--dra-border-strong);box-shadow:var(--dra-hl),var(--dra-elev-2)}',
  '.tm-picks{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:10px;padding:12px;border:1px dashed var(--dra-border-strong);border-radius:var(--dra-r-md);background:color-mix(in srgb,var(--dra-accent) 5%,transparent)}',

  /* 聊天：气泡（--dra-r-md，朝向一侧收小角）；新的弹入；运行中三点跳动 + 扫光 */
  '.tm-log{max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;border:1px solid var(--dra-border);border-radius:var(--dra-r-md);background:color-mix(in srgb,var(--dra-surface-1) 70%,transparent);padding:12px;scrollbar-width:thin}',
  '.tm-msg{max-width:88%;border:1px solid var(--dra-border);border-radius:var(--dra-r-md) var(--dra-r-md) var(--dra-r-md) var(--dra-r-xs);padding:7px 13px;background:var(--dra-sheen),var(--dra-surface-2);box-shadow:var(--dra-hl),var(--dra-shadow);align-self:flex-start;min-width:0}',
  '.tm-msg.tm-user{align-self:flex-end;border-color:transparent;border-radius:var(--dra-r-md) var(--dra-r-md) var(--dra-r-xs) var(--dra-r-md);background:var(--dra-primary);color:var(--dra-on-primary)}',
  '.tm-msg.tm-user .tm-who{color:inherit;opacity:.8}',
  '.tm-msg.tm-sys{align-self:center;max-width:100%;border-radius:var(--dra-r-pill);padding:2px 14px;color:var(--dra-text-dim);font-size:12px;box-shadow:none;background:color-mix(in srgb,var(--dra-surface-2) 60%,transparent)}',
  '.tm-who{font-size:11px;color:var(--dra-text-dim);margin-bottom:1px}',
  '.tm-pending{padding:10px 14px}',
  '.tm-dots{display:inline-flex;align-items:center;gap:4px;margin-right:8px;vertical-align:middle}',
  '.tm-dots i{display:block;width:7px;height:7px;border-radius:50%;background:var(--dra-accent);animation:tm-dot 1.2s var(--dra-ease) infinite}',
  '.tm-dots i:nth-child(2){animation-delay:.16s;background:var(--dra-accent-2)}.tm-dots i:nth-child(3){animation-delay:.32s;background:var(--dra-accent-3)}',
  '@keyframes tm-dot{0%,80%,100%{opacity:.35;transform:scale(.7)}40%{opacity:1;transform:scale(1.15)}}',
  '.tm-run{margin:0;padding:7px 14px;border:1px solid color-mix(in srgb,var(--dra-accent) 40%,transparent);border-radius:var(--dra-r-pill);background:color-mix(in srgb,var(--dra-accent) 8%,transparent);color:var(--dra-text);font-size:12px;overflow-wrap:anywhere}',
  '.tm-note{margin:0;padding:7px 14px;border:1px solid color-mix(in srgb,currentColor 38%,transparent);border-radius:var(--dra-r-md);background:color-mix(in srgb,currentColor 8%,transparent);overflow-wrap:anywhere}',
  '.tm-note.dra-warn::before{content:"▲ "}.tm-note.dra-ok::before{content:"✓ "}',
  '.tm-err{color:var(--dra-danger);font-size:12px}.tm-err::before{content:"✕ "}.tm-note.tm-err{font-size:13px}',

  /* iOS 分组列表：圆角内嵌组 + 发丝分隔线（模型目录 / 记忆 / 目标 / 审计 / 定位结果） */
  '.tm-group{border:1px solid var(--dra-border);border-radius:var(--dra-r-md);background:color-mix(in srgb,var(--dra-surface-1) 55%,transparent);overflow:hidden;margin:0;padding:0;list-style:none}',
  '.tm-group-title{font-size:12px;font-weight:500;color:var(--dra-text-dim);margin:8px 0 4px 14px}',
  '.tm-row{padding:9px 14px;border-top:1px solid color-mix(in srgb,var(--dra-border) 80%,transparent);min-width:0}.tm-row:first-child{border-top:0}',
  '.tm-row-head{display:flex;align-items:center;gap:8px;background:color-mix(in srgb,var(--dra-surface-3) 40%,transparent)}',
  '.tm-model{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}',
  '.tm-scroll{max-height:320px;overflow:auto}',
  '.tm-line{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:8px;align-items:baseline;font-size:12px}',
  '.tm-line-goal{grid-template-columns:auto auto minmax(0,1fr) auto}',
  '.tm-mem-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}.tm-mem-row.tm-muted{opacity:.7}',
  '.tm-mem-text{flex:1 1 220px;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}',
  '.tm-compose{padding:12px 14px}',
]

/* ── 组件 ──────────────────────────────────────────────────────────────── */

export function createTeam(core) {
  const { React, h, api, safe, Badge, Card, Fold, Banner, Field, Empty, CopyBtn } = core
  const enc = encodeURIComponent

  /** 装饰性头像（名称就在旁边，所以对读屏隐藏）；online 时有呼吸环，离线时灰掉由 .tm-off 负责。 */
  function avatar(name, seed, online, small) {
    return h('span', {
      className: 'tm-avatar' + (online ? ' tm-on' : '') + (small ? ' tm-sm' : ''), 'aria-hidden': 'true',
      'data-initial': teamAvatarInitial(name), style: teamAvatarStyle(seed),
    })
  }
  const dots = () => h('span', { className: 'tm-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))

  /* —— Bot 对话 —— 历史与回合都在本组件里；父级用 key 区分 Bot，换 Bot / 关闭时卸载并作废在途轮询。 */
  function ChatPane(p) {
    const [hist, setHist] = React.useState(teamHistInit)
    const [turn, setTurn] = React.useState(teamTurnInit)
    const [draft, setDraft] = React.useState('')
    const run = React.useRef(0)
    const histSeq = React.useRef(0)
    const timer = React.useRef(0)
    const logEl = React.useRef(null)

    function loadHistory() {
      const seq = ++histSeq.current
      setHist((s) => teamHistReduce(s, { type: 'load' }))
      safe(api.get('/bots/history?nodeId=' + enc(p.nodeId) + '&botId=' + enc(p.botId))).then((d) => {
        if (seq !== histSeq.current) return
        setHist((s) => teamHistReduce(s, d && d.ok === true ? { type: 'ok', items: d.items } : { type: 'fail', error: (d && d.error) || 'unknown' }))
      })
    }
    React.useEffect(() => {
      loadHistory()
      return () => { run.current += 1; histSeq.current += 1; clearTimeout(timer.current) }
    }, [])
    React.useEffect(() => {
      const el = logEl.current
      if (el) el.scrollTop = el.scrollHeight
    }, [hist.items.length, turn.state])

    function send() {
      if (turn.state === 'running' || !p.online) return
      const bad = teamTurnCheck(draft)
      if (bad) { setTurn((s) => teamTurnReduce(s, { type: 'failed', error: bad })); return }
      const text = draft
      const my = ++run.current
      setTurn((s) => teamTurnReduce(s, { type: 'start', sent: text }))
      safe(api.post('/bots/turn', { nodeId: p.nodeId, botId: p.botId, text })).then((d) => {
        if (my !== run.current) return
        if (!d || d.ok !== true || !d.exchangeId) { setTurn((s) => teamTurnReduce(s, { type: 'failed', error: (d && d.error) || 'unknown' })); return }
        setDraft('')
        const deadline = Date.now() + teamTurnDeadlineMs
        const poll = () => {
          if (my !== run.current) return
          if (Date.now() > deadline) { setTurn((s) => teamTurnReduce(s, { type: 'timeout' })); return }
          safe(api.get('/bots/turn?exchangeId=' + enc(d.exchangeId))).then((s) => {
            if (my !== run.current) return
            const a = teamTurnFromPoll(s)
            setTurn((prev) => teamTurnReduce(prev, a))
            if (a.type === 'done' || a.type === 'failed') loadHistory()
            else timer.current = setTimeout(poll, teamTurnPollMs)
          })
        }
        timer.current = setTimeout(poll, teamTurnPollMs)
      })
    }

    const rows = teamHistoryRows(hist.items)
    const running = turn.state === 'running'
    const blocked = p.online ? '' : '这台机器离线，发不了消息'
    return h(Card, {
      className: 'tm-detail dra-pop' + (p.online ? '' : ' tm-off'),
      title: '对话：' + p.name, sub: h('span', { className: 'tm-sub' }, avatar(p.name, p.seed, p.online, true), '@ ' + p.host),
      actions: [
        h('button', { key: 'e', type: 'button', className: 'dra-btn sm', onClick: p.onEdit, disabled: !p.online, title: blocked }, '编辑'),
        h('button', { key: 'c', type: 'button', className: 'dra-btn sm', onClick: p.onClose }, '关闭'),
      ],
    },
    h('div', { className: 'dra-col' },
      blocked ? h('p', { className: 'tm-why', role: 'status' }, blocked + '；历史可能读不到。') : null,
      hist.state === 'error' ? h(Banner, { tone: 'err', title: '读取对话失败', actions: h('button', { type: 'button', className: 'dra-btn sm', onClick: loadHistory }, '重试') }, teamExplain(hist.error)) : null,
      h('div', { className: 'tm-log', ref: logEl, role: 'log', 'aria-live': 'polite', 'aria-label': '对话记录' },
        hist.state === 'loading' && rows.length === 0 ? h('p', { className: 'dra-hint' }, '加载中…') : null,
        hist.state === 'ready' && rows.length === 0 ? h('p', { className: 'dra-hint' }, '还没有对话') : null,
        rows.map((r, i) => h('div', { key: r.key, className: 'tm-msg tm-' + r.side + (i >= rows.length - 6 ? ' dra-pop' : '') },
          r.who ? h('div', { className: 'tm-who' }, r.who + (r.time ? ' · ' + r.time : '')) : null,
          h('div', { className: 'dra-wrap' }, r.text))),
        running ? h('div', { className: 'tm-msg tm-bot tm-pending dra-pop', 'aria-hidden': 'true' }, dots()) : null),
      hist.state === 'loading' && rows.length > 0 ? h('p', { className: 'dra-hint', role: 'status' }, '刷新对话中…') : null,
      running ? h('p', { className: 'tm-run dra-shimmer', role: 'status' }, dots(), '运行中…你刚发的是：' + turn.sent) : null,
      running && turn.linkLost ? h('p', { className: 'tm-note dra-warn', role: 'status' }, '与这台机器的连接断了；结果可能在重连后补回来，仍在等待。') : null,
      running && turn.warn ? h('p', { className: 'tm-note dra-warn', role: 'status' }, '读取进度失败（会重试）：' + turn.warn) : null,
      turn.state === 'failed' ? h('p', { className: 'tm-note tm-err', role: 'alert' }, '失败：' + teamExplain(turn.error) + (turn.text ? '；已收到的部分回答：' + turn.text : '')) : null,
      turn.state === 'timeout' ? h('p', { className: 'tm-note dra-warn', role: 'status' }, '等了 5 分钟还没有结果；稍后点「刷新对话」看看历史里有没有。') : null,
      turn.state === 'done' ? (hist.state === 'ready'
        ? h('p', { className: 'tm-note dra-ok', role: 'status' }, '已完成，回答在上方对话里。')
        : h('p', { className: 'tm-note dra-wrap', role: 'status' }, 'Bot 回答：' + turn.text)) : null,
      h(Field, { label: '发给 ' + p.name, wide: true, hint: 'Enter 发送，Shift+Enter 换行 · ' + draft.length + '/' + teamTurnTextMax },
        h('textarea', {
          className: 'dra-textarea', rows: 3, value: draft, placeholder: '发给这个 Bot…',
          onChange: (e) => setDraft(e.target.value),
          onKeyDown: (e) => { if (teamEnterSends(e)) { e.preventDefault(); send() } },
        })),
      h('div', { className: 'dra-row' },
        h('button', { type: 'button', className: 'dra-btn primary', disabled: running || !p.online || draft.trim() === '', title: blocked, onClick: send }, running ? '运行中…' : '发送'),
        h('button', { type: 'button', className: 'dra-btn', disabled: running, onClick: loadHistory }, '刷新对话'))))
  }

  /* —— 定位：按身份 id 问所有在线机器。 */
  function LocatePane(p) {
    const [res, setRes] = React.useState({ state: 'loading', data: null, error: '' })
    const seq = React.useRef(0)
    function locate() {
      const my = ++seq.current
      setRes({ state: 'loading', data: null, error: '' })
      safe(api.get('/bots/locate?identityId=' + enc(p.identityId))).then((d) => {
        if (my !== seq.current) return
        setRes(d && d.ok === true ? { state: 'ready', data: d, error: '' } : { state: 'error', data: null, error: (d && d.error) || 'unknown' })
      })
    }
    React.useEffect(() => { locate(); return () => { seq.current += 1 } }, [])
    const view = res.state === 'ready' ? teamLocateView(res.data, p.nameOf) : null
    return h(Card, {
      className: 'tm-detail dra-pop',
      title: '定位：' + p.name, sub: h('span', { className: 'tm-sub' }, avatar(p.name, p.identityId, true, true), '身份 id ', h('span', { className: 'tm-pill dra-mono' }, p.identityId)),
      actions: [
        h('button', { key: 'r', type: 'button', className: 'dra-btn sm', disabled: res.state === 'loading', onClick: locate }, res.state === 'loading' ? '询问中…' : '重新定位'),
        h('button', { key: 'c', type: 'button', className: 'dra-btn sm', onClick: p.onClose }, '关闭'),
      ],
    },
    h('div', { className: 'dra-col' },
      res.state === 'loading' ? h('p', { className: 'dra-hint', role: 'status' }, '正在问所有在线机器（最多等几秒）…') : null,
      res.state === 'error' ? h(Banner, { tone: 'err', title: '定位失败' }, teamExplain(res.error)) : null,
      view && view.found.length > 0 ? h('div', null,
        h('p', { className: 'tm-note dra-ok' }, 'Bot 现在在这些机器上（已用它自己的密钥核验）：'),
        h('ul', { className: 'tm-group' }, view.found.map((l) => h('li', { key: l.nodeId, className: 'tm-row' }, l.label + (l.machineId ? ' · 机器标识 ' + coreShortId(l.machineId, 12) : ''))))) : null,
      view && view.nobody ? h('p', { className: 'tm-note dra-warn' }, '没有任何机器认领这个 Bot（它可能不在线，或所在机器还没回答）。') : null,
      view ? view.groups.map((g) => h('div', { key: g.id },
        h('div', { className: 'tm-group-title' }, g.title + '（' + g.items.length + '）'),
        h('ul', { className: 'tm-group' }, g.items.map((x, i) => h('li', { key: i, className: 'tm-row' }, x))))) : null))
  }

  /* —— 团队记忆。选中的范围、草稿、提示全放在这里；轮询只刷新数据，不碰它们。 */
  function MemorySection(p) {
    const [scope, setScope] = React.useState(teamTeamScope)
    const [scopes, setScopes] = React.useState({ state: 'loading', data: null, reason: '', status: 0 })
    const [view, setView] = React.useState({ state: 'loading', data: null, reason: '', status: 0 })
    const [draft, setDraft] = React.useState('')
    const [topic, setTopic] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [note, setNote] = React.useState('')
    const seq = React.useRef(0)
    const reqId = React.useRef(0)
    const viewFlight = React.useRef(0)
    const scopesFlight = React.useRef(0)
    const scopeRef = React.useRef(teamTeamScope)
    const alive = React.useRef(true)

    function loadScopes() {
      if (scopesFlight.current) return
      const my = ++reqId.current
      scopesFlight.current = my
      teamBotCall('memory-hub-scopes', {}).then((d) => ({ state: 'ok', data: d, reason: '', status: 200 }), teamMemFail).then((r) => {
        if (scopesFlight.current === my) scopesFlight.current = 0
        if (alive.current) setScopes(r)
      })
    }
    /** 每次请求带当时的 seq；换范围 / 写入会推进 seq，旧回包直接丢。 */
    function loadView(force) {
      if (viewFlight.current && !force) return
      const my = ++reqId.current
      const mySeq = seq.current
      viewFlight.current = my
      teamBotCall('memory-hub-view', { scope: teamMemScopeObj(scopeRef.current) }).then((v) => ({ state: 'ok', data: v, reason: '', status: 200 }), teamMemFail).then((r) => {
        if (viewFlight.current === my) viewFlight.current = 0
        if (alive.current && mySeq === seq.current) setView(r)
      })
    }
    React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    React.useEffect(() => { loadScopes(); if (!busy) loadView(false) }, [p.tick])

    function pickScope(v) {
      seq.current += 1
      scopeRef.current = v
      setScope(v)
      setNote('')
      setView({ state: 'loading', data: null, reason: '', status: 0 })
      loadView(true)
    }
    function mutate(endpoint, payload, onOk) {
      seq.current += 1
      setBusy(true)
      setNote('')
      teamBotCall(endpoint, payload).then((v) => {
        if (!alive.current) return
        setView({ state: 'ok', data: v, reason: '', status: 200 })
        if (onOk) onOk()
      }, (e) => { if (alive.current) setNote('写记忆失败：' + String((e && (e.reason || e.message)) || 'unknown')) })
        .then(() => { if (alive.current) setBusy(false) })
    }
    function add() {
      const text = draft.trim()
      if (text === '' || busy) return
      mutate('memory-hub-add', { scope: teamMemScopeObj(scope), text, topic: topic.trim() || undefined }, () => setDraft(''))
    }
    function forget(r) {
      if (busy) return
      p.ui.confirm('遗忘这条记忆？\n\n' + r.text).then((ok) => {
        if (ok) mutate('memory-hub-forget', { scope: teamMemScopeObj(scope), text: r.text, topic: r.topic || undefined })
      })
    }

    const missing = scopes.state === 'missing' || view.state === 'missing'
    const options = teamMemScopeOptions(scopes.data)
    const known = options.some((o) => o.value === scope)
    const rows = view.state === 'ok' ? teamMemEntryRows(view.data) : []
    const status = view.state === 'missing' ? view.status : scopes.status
    if (missing) {
      return h(Banner, { title: '记忆接口不可用（' + teamMemMissing + '）' }, 'ds-bot 没有响应 /api/bot 的记忆端点' + (status ? '（HTTP ' + status + '）' : '') + '；团队记忆在这里读不到。')
    }
    return h('div', { className: 'dra-col' },
      h(Field, { label: '记忆范围' },
        h('select', { className: 'dra-select', value: scope, onChange: (e) => pickScope(e.target.value) },
          known ? null : h('option', { value: scope }, '当前范围（名单里暂时没有）'),
          [['team', '团队'], ['node', '每台机器'], ['bot', '机器下的 Bot']].map((g) => {
            const list = options.filter((o) => o.group === g[0])
            return list.length === 0 ? null : h('optgroup', { key: g[0], label: g[1] },
              list.map((o) => h('option', { key: o.value, value: o.value }, o.label + (o.entries == null ? '' : '（' + o.entries + '）'))))
          }))),
      scopes.state === 'error' ? h('p', { className: 'tm-err', role: 'alert' }, '读范围列表失败：' + scopes.reason) : null,
      view.state === 'loading' ? h('p', { className: 'dra-hint', role: 'status' }, '读取中…') : null,
      view.state === 'error' ? h('p', { className: 'tm-err', role: 'alert' }, '读记忆失败：' + view.reason) : null,
      view.state === 'ok' && rows.length === 0 ? h('p', { className: 'dra-hint' }, '这个范围还没有记忆') : null,
      rows.length > 0 ? h('div', { className: 'tm-group tm-scroll' }, rows.map((r) => {
        const chips = [r.topic ? ['tm-topic', '主题 ' + r.topic] : null, r.by ? ['', '来自 ' + r.by] : null, r.added ? ['', '添加 ' + r.added] : null, r.until ? ['', '到期 ' + r.until] : null].filter(Boolean)
        return h('div', { key: r.key, className: 'tm-row tm-mem-row' + (r.expired ? ' tm-muted' : '') },
          r.pinned ? h(Badge, { tone: 'acc' }, '置顶') : null,
          r.expired ? h(Badge, null, '已过期') : null,
          h('span', { className: 'tm-mem-text' }, r.text),
          chips.map((c, i) => h('span', { key: i, className: 'tm-chip ' + c[0] }, c[1])),
          h('button', { type: 'button', className: 'dra-btn sm danger', disabled: busy, onClick: () => forget(r) }, '遗忘'))
      })) : null,
      h('form', { className: 'dra-form tm-group tm-compose', onSubmit: (e) => { e.preventDefault(); add() } },
        h(Field, { label: '记住一件事', wide: true },
          h('input', { className: 'dra-input', value: draft, placeholder: '写进当前范围的记忆…', onChange: (e) => setDraft(e.target.value) })),
        h(Field, { label: '主题（可选）' },
          h('input', { className: 'dra-input', value: topic, onChange: (e) => setTopic(e.target.value) })),
        h('div', { className: 'dra-row' },
          h('button', { type: 'submit', className: 'dra-btn primary', disabled: busy || draft.trim() === '' }, busy ? '提交中…' : '记住'))),
      note ? h('p', { className: 'tm-err', role: 'alert' }, note) : null)
  }

  /* —— 只读列表：模型目录 / 目标 / 审计 —— 没有自己的状态，不用 hook。 */
  function modelsBody(models) {
    if (models.state === 'loading') return h('p', { className: 'dra-hint', role: 'status' }, '读取中…')
    const stale = models.error && models.nodes.length > 0
    if (models.state === 'error' && models.nodes.length === 0) return h('p', { className: 'tm-err', role: 'alert' }, '读模型列表失败：' + models.error)
    const views = models.nodes.map(teamModelsNodeView)
    if (views.length === 0) return h('p', { className: 'dra-hint' }, '还没有机器上报模型')
    return h('div', { className: 'dra-col' },
      stale ? h('p', { className: 'tm-err', role: 'alert' }, '刷新失败，下面是上一次的数据：' + models.error) : null,
      views.every((v) => v.state !== 'list') ? h('p', { className: 'dra-hint' }, '所有机器都没有可用模型') : null,
      views.map((v) => h('div', { key: v.nodeId, className: 'tm-group' + (v.online ? '' : ' tm-off') },
        h('div', { className: 'tm-row tm-row-head' }, h('span', { className: 'dra-mono' }, v.hostname), h(Badge, { tone: v.online ? 'ok' : '' }, v.online ? '在线' : '离线')),
        v.state === 'unreported' ? h('p', { className: 'tm-row dra-hint' }, '尚未上报模型') : null,
        v.state === 'none' ? h('p', { className: 'tm-row dra-hint' }, '没有可用模型') : null,
        v.rows.map((m) => h('div', { key: m.id, className: 'tm-row tm-model' },
          h('span', { className: 'dra-mono' }, m.label),
          m.isDefault ? h(Badge, { tone: 'acc' }, '默认') : null,
          h('span', { className: 'tm-chip' }, m.efforts.length === 0 ? '无思考等级' : '思考等级：' + m.efforts.join(' / ')))))))
  }

  function goalsBody(hub, nameOf) {
    if (hub.goals === undefined) return h('p', { className: 'dra-hint', role: 'status' }, hub.loading ? '读取中…' : '暂时读不到目标列表')
    if (hub.goals.length === 0) return h('p', { className: 'dra-hint' }, '没有 Bot 在追踪目标')
    const g = teamGoalGroups(hub.goals)
    const rows = (list, idle) => list.map((x, i) => h('div', { key: x.nodeId + '/' + x.botId + '/' + (x.roomId || '') + '/' + i, className: 'tm-row tm-line tm-line-goal' },
      h(Badge, { tone: idle ? '' : 'acc' }, idle ? '空闲' : '进行中'),
      h('span', { className: 'dra-mono' }, (x.botName || x.botId) + ' @ ' + nameOf(x.nodeId)),
      h('span', { className: 'dra-wrap' }, x.goal || '（无目标）'),
      h('span', { className: 'dra-hint' }, x.lastAt ? coreFmtTime(x.lastAt) : '')))
    const section = (title, list, idle) => (list.length ? [
      h('div', { key: 't' + idle, className: 'tm-group-title' }, title + '（' + list.length + '）'),
      h('div', { key: 'g' + idle, className: 'tm-group tm-scroll' }, rows(list, idle))] : null)
    return h('div', { className: 'dra-col' }, section('进行中', g.active, false), section('空闲', g.idle, true))
  }

  function auditBody(hub, nameOf) {
    if (hub.botAudit === undefined) return h('p', { className: 'dra-hint', role: 'status' }, hub.loading ? '读取中…' : '暂时读不到审计记录')
    return h('div', { className: 'dra-col' },
      h('p', { className: 'dra-hint' }, '只读历史，最近 200 条、新的在前。0.4.36 起不再产生新的 assign 记录，旧记录照常显示。'),
      hub.botAudit.length === 0 ? h('p', { className: 'dra-hint' }, '还没有 Bot 之间的通信') : null,
      hub.botAudit.length === 0 ? null : h('div', { className: 'tm-group tm-scroll' }, hub.botAudit.map((e, i) => {
        const r = teamAuditRow(e, i, nameOf)
        return h('div', { key: r.key, className: 'tm-row tm-line' },
          h(Badge, { tone: r.tone }, r.label), h('span', { className: 'dra-hint' }, r.time), h('span', { className: 'dra-wrap' }, r.text))
      })))
  }

  function Screen(props) {
    const hub = props.hub
    const ui = props.ui
    const tick = hub.tick
    const [bots, setBots] = React.useState({ state: 'loading', nodes: [], at: 0, error: '' })
    const [models, setModels] = React.useState({ state: 'loading', nodes: [], error: '' })
    const [catalog, setCatalog] = React.useState({ talents: { state: 'loading', list: [], reason: '' }, templates: { state: 'loading', list: [], reason: '' } })
    const [detail, setDetail] = React.useState(null)
    const [form, setForm] = React.useState(teamFormInit())
    const [formStatus, setFormStatus] = React.useState({ busy: false, ok: false, note: '', tried: false })
    const [stopping, setStopping] = React.useState({})
    const alive = React.useRef(true)
    const botsSeq = React.useRef(0)
    const botsFlight = React.useRef(0)
    const modelsSeq = React.useRef(0)
    const modelsFlight = React.useRef(0)
    const catFlight = React.useRef(false)
    const reload = React.useRef(0)

    function loadBots(force) {
      if (botsFlight.current && !force) return
      const my = ++botsSeq.current
      botsFlight.current = my
      safe(api.get('/bots')).then((d) => {
        if (botsFlight.current === my) botsFlight.current = 0
        if (!alive.current || my !== botsSeq.current) return
        const r = teamRosterProject(d)
        setBots((prev) => (r.kind === 'data'
          ? { state: 'ok', nodes: r.nodes, at: Date.now(), error: '' }
          : { state: prev.state === 'ok' ? 'ok' : 'error', nodes: prev.nodes, at: prev.at, error: r.reason }))
      })
    }
    function loadModels() {
      if (modelsFlight.current) return
      const my = ++modelsSeq.current
      modelsFlight.current = my
      safe(api.get('/models')).then((d) => {
        if (modelsFlight.current === my) modelsFlight.current = 0
        if (!alive.current || my !== modelsSeq.current) return
        const r = teamModelsProject(d)
        setModels((prev) => (r.kind === 'error'
          ? { state: prev.nodes.length > 0 ? 'ok' : 'error', nodes: prev.nodes, error: r.reason }
          : { state: 'ok', nodes: r.nodes, error: '' }))
      })
    }
    /** 人才库 / 模板库：读到（或确认端点不存在）就不再读；读失败的下一次轮询再试。 */
    function loadCatalog() {
      if (catFlight.current) return
      const need = (c) => c.state === 'loading' || c.state === 'error'
      if (!need(catalog.talents) && !need(catalog.templates)) return
      catFlight.current = true
      const one = (name, endpoint, key) => (need(catalog[name]) ? teamBotCall(endpoint, {}).then(
        (d) => ({ state: 'ok', list: d && Array.isArray(d[key]) ? d[key] : [], reason: '' }),
        (e) => ({ state: e && e.missing ? 'missing' : 'error', list: [], reason: String((e && (e.reason || e.message)) || 'unknown') })) : Promise.resolve(catalog[name]))
      Promise.all([one('talents', 'list-talents', 'talents'), one('templates', 'list-templates', 'templates')]).then((r) => {
        catFlight.current = false
        if (alive.current) setCatalog({ talents: r[0], templates: r[1] })
      })
    }
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(reload.current) } }, [])
    React.useEffect(() => { loadBots(false); loadModels(); loadCatalog() }, [tick])

    const rows = teamNodeRows(bots.state === 'loading' ? [] : bots.nodes, hub.nodes)
    const nameMap = teamNameMap(rows, hub.nodes)
    const nameOf = (id) => nameMap[String(id)] || String(id)
    const totalBots = rows.reduce((s, n) => s + n.bots.length, 0)

    function patchForm(patch) { setForm((prev) => Object.assign({}, prev, patch)) }
    function guardForm(next) {
      const same = next && form.mode === next.mode && form.nodeId === next.nodeId && form.botId === next.botId
      if (!teamFormDirty(form) || same) return Promise.resolve(true)
      return ui.confirm('表单里有没保存的内容，放弃它？')
    }
    function openChat(node, bot) { setDetail({ kind: 'chat', nodeId: node.nodeId, botId: bot.id }) }
    function openEdit(node, bot) {
      guardForm({ mode: 'edit', nodeId: node.nodeId, botId: bot.id }).then((ok) => {
        if (!ok) return
        if (!(form.mode === 'edit' && form.nodeId === node.nodeId && form.botId === bot.id)) setForm(teamFormFromBot(node, bot))
        setFormStatus({ busy: false, ok: false, note: '', tried: false })
        setDetail({ kind: 'form' })
      })
    }
    function openCreate(nodeId) {
      guardForm({ mode: 'create', nodeId: nodeId || form.nodeId, botId: '' }).then((ok) => {
        if (!ok) return
        if (form.mode !== 'create') { setForm(teamFormInit({ nodeId: nodeId || '' })); setFormStatus({ busy: false, ok: false, note: '', tried: false }) } else if (nodeId) patchForm({ nodeId })
        setDetail({ kind: 'form' })
      })
    }
    function cancelForm() { setForm(teamFormInit()); setFormStatus({ busy: false, ok: false, note: '', tried: false }); setDetail(null) }

    function stopBot(node, bot) {
      const key = bot.key
      ui.confirm('停止「' + bot.name + '」（' + node.hostname + '）当前正在跑的回合？\n只会停掉这一轮，不会删除 Bot。').then((ok) => {
        if (!ok) return
        setStopping((s) => Object.assign({}, s, { [key]: true }))
        safe(api.post('/bots/stop', { nodeId: node.nodeId, botId: bot.id })).then((d) => {
          if (alive.current) setStopping((s) => { const n = Object.assign({}, s); delete n[key]; return n })
          if (d && d.ok === true) {
            if (d.stopped === true) ui.notify('已停止「' + bot.name + '」当前的回合', 'ok')
            else ui.notify('「' + bot.name + '」当前没有在跑的回合，没有可停止的', 'warn')
          } else ui.notify('停止「' + bot.name + '」失败：' + teamExplain(d && d.error), 'err')
        })
      })
    }

    function submitForm() {
      if (formStatus.busy) return
      const errs = teamFormCheck(form)
      if (errs.length > 0) { setFormStatus({ busy: false, ok: false, tried: true, note: errs.map((x) => teamExplain(x.code)).join('；') }); return }
      const editing = form.mode === 'edit'
      const body = editing ? teamEditBody(form) : teamCreateBody(form)
      if (!body) { setFormStatus({ busy: false, ok: false, tried: true, note: teamExplain('bot-update-all-null') }); return }
      setFormStatus({ busy: true, ok: false, tried: true, note: '' })
      safe(api.post(editing ? '/bots/update' : '/bots/create', body)).then((d) => {
        if (!alive.current) return
        if (d && d.ok === true) {
          setFormStatus({ busy: false, ok: true, tried: false, note: (editing ? '已保存' : '已创建') + (d.remoteBotId ? '：' + d.remoteBotId : '') + '。名册由机器上报，几秒内会更新。' })
          setForm((prev) => teamFormAfterSave(prev))
          loadBots(true)
          clearTimeout(reload.current)
          reload.current = setTimeout(() => loadBots(true), 2500)
        } else setFormStatus({ busy: false, ok: false, tried: true, note: teamExplain(d && d.error) })
      })
    }

    /* —— 左：按机器分组的 Bot —— */
    function botRow(node, bot) {
      const b = teamBotBlockers(node, bot)
      const stop = stopping[bot.key] === true
      return h('li', { key: bot.key, className: 'tm-bot' },
        avatar(bot.name, teamAvatarSeed(bot), node.online),
        h('div', { className: 'tm-bot-body' },
          h('div', { className: 'tm-bot-main' },
            h('span', { className: 'tm-name' }, bot.name),
            bot.role ? h('span', { className: 'tm-chip' }, '角色 ' + bot.role) : null,
            h('span', { className: 'tm-chip dra-mono' }, bot.model ? '模型 ' + bot.model : '模型未设置')),
          h('div', { className: 'tm-sub tm-id' },
            bot.identityId
              ? [h('span', { key: 'i', className: 'dra-hint' }, '身份 '), h('span', { key: 'v', className: 'tm-pill dra-mono', title: bot.identityId }, bot.shortId + '…'),
                h(CopyBtn, { key: 'c', text: bot.identityId, label: '复制 id', title: '复制完整身份 id' })]
              : h('span', { className: 'dra-hint' }, '没有身份 id')),
          h('div', { className: 'dra-row' },
            h('button', { type: 'button', className: 'dra-btn sm', disabled: !!b.chat, title: b.chat, onClick: () => openChat(node, bot) }, '对话'),
            h('button', { type: 'button', className: 'dra-btn sm', disabled: !!b.edit, title: b.edit, onClick: () => openEdit(node, bot) }, '编辑'),
            h('button', { type: 'button', className: 'dra-btn sm danger', disabled: !!b.stop || stop, title: b.stop || '停止这个 Bot 当前正在跑的回合', onClick: () => stopBot(node, bot) }, stop ? '停止中…' : '停止'),
            h('button', { type: 'button', className: 'dra-btn sm', disabled: !!b.locate, title: b.locate || '问所有在线机器：这个 Bot 现在在哪', onClick: () => setDetail({ kind: 'locate', nodeId: node.nodeId, botId: bot.id }) }, '定位')),
          b.locate ? h('p', { className: 'tm-why' }, b.locate) : null))
    }

    function nodeCard(node) {
      const v = teamVersionNote(node)
      return h(Card, {
        key: node.nodeId, className: 'tm-node ' + (node.online ? 'tm-on' : 'tm-off'), title: node.hostname,
        sub: h('span', { className: 'tm-sub' },
          h('span', { className: 'dra-dot ' + (node.online ? 'ok' : ''), 'aria-hidden': 'true' }),
          h(Badge, { tone: node.online ? 'ok' : '' }, node.online ? '在线' : '离线'),
          h(Badge, { tone: v.tone }, v.badge),
          h('span', { className: 'dra-hint dra-mono' }, node.nodeId)),
        actions: h('button', { type: 'button', className: 'dra-btn sm', disabled: !node.online, title: node.online ? '' : '这台机器离线，不能在它上面新建 Bot', onClick: () => openCreate(node.nodeId) }, '在这台新建'),
      },
      v.hint ? h('p', { className: 'tm-note dra-warn' }, v.hint) : null,
      node.online ? null : h('p', { className: 'tm-why', role: 'status' }, '这台机器离线：下面是最后一次名册' + (node.lastSeen ? '（最后在线 ' + coreFmtTime(node.lastSeen) + '）' : '') + '；对话、编辑、停止不可用。'),
      node.bots.length === 0
        ? h('p', { className: 'dra-hint' }, node.hasRoster ? '这台机器上还没有 Bot' : '这台机器还没有上报名册')
        : h('ul', { className: 'tm-bots' }, node.bots.map((b) => botRow(node, b))))
    }

    function roster() {
      if (bots.state === 'loading') return h('p', { className: 'dra-hint', role: 'status' }, '读取名册中…')
      return h('div', { className: 'dra-col' },
        bots.error ? h(Banner, { tone: 'err', title: bots.state === 'ok' ? '名册刷新失败，显示的是 ' + coreFmtTime(bots.at) + ' 的数据' : '读不到名册', actions: h('button', { type: 'button', className: 'dra-btn sm', onClick: () => loadBots(true) }, '重试') }, teamExplain(bots.error)) : null,
        rows.length === 0 && !bots.error ? h(Empty, null,
          h('p', null, '还没有机器上报 Bot。'),
          h('button', { type: 'button', className: 'dra-btn sm', onClick: () => props.go('machines') }, '去「机器」接入副机')) : null,
        rows.map(nodeCard))
    }

    /* —— 右：详情（对话 / 表单 / 定位） —— */
    function formView() {
      const editing = form.mode === 'edit'
      const online = rows.filter((n) => n.online)
      const errs = teamFormCheck(form)
      const errOf = (field) => {
        const e = errs.find((x) => x.field === field && (formStatus.tried || /too-long$/.test(x.code)))
        return e ? h('span', { className: 'tm-err', role: 'alert' }, teamExplain(e.code)) : null
      }
      const opts = teamModelOptions(models.nodes, form.nodeId)
      const groups = teamTemplateGroups(catalog.templates.list)
      const talents = catalog.talents.list
      const blank = editing ? '（留空 = 不修改）' : ''
      const node = rows.find((n) => n.nodeId === form.nodeId)
      return h(Card, { className: 'tm-detail dra-pop', title: editing ? '编辑 Bot：' + (form.base && form.base.name ? form.base.name : form.botId) : '新建 Bot', sub: editing ? 'id ' + form.botId : null },
        h('form', { className: 'dra-col', onSubmit: (e) => { e.preventDefault(); submitForm() } },
          !editing && (groups.length > 0 || talents.length > 0) ? h('div', { className: 'tm-picks' },
            groups.length > 0 ? h(Field, { label: '从模板库套用（可选）' },
              h('select', {
                className: 'dra-select', value: '',
                onChange: (e) => {
                  const t = catalog.templates.list.find((x) => x.id === e.target.value)
                  if (t) setForm((prev) => teamApplyTemplate(prev, t))
                },
              },
              h('option', { value: '' }, '选一个模板…'),
              groups.map((g) => h('optgroup', { key: g.category, label: g.category },
                g.items.map((t) => h('option', { key: t.id, value: t.id }, t.name + (t.role ? ' · ' + t.role : ''))))))) : null,
            talents.length > 0 ? h(Field, { label: '从人才库套用（可选）' },
              h('select', {
                className: 'dra-select', value: '',
                onChange: (e) => {
                  const t = talents.find((x) => x.name === e.target.value)
                  if (t) setForm((prev) => teamApplyTalent(prev, t))
                },
              },
              h('option', { value: '' }, '选一位人才…'),
              talents.map((t) => h('option', { key: t.name, value: t.name }, t.name + (t.role ? ' · ' + t.role : '') + (t.category ? ' [' + t.category + ']' : ''))))) : null) : null,
          !editing && (catalog.templates.state === 'error' || catalog.talents.state === 'error')
            ? h('p', { className: 'dra-hint' }, '模板库 / 人才库读取失败：' + [catalog.templates, catalog.talents].filter((c) => c.state === 'error').map((c) => c.reason).join(' / ')) : null,
          form.applied ? h('p', { className: 'dra-hint', role: 'status' }, '已套用' + form.applied + '，下面的内容都可以继续改。') : null,
          h(Field, { label: '机器（只列在线的）' },
            h('select', { className: 'dra-select', value: form.nodeId, disabled: editing, onChange: (e) => patchForm({ nodeId: e.target.value }) },
              editing && node && !node.online ? h('option', { value: node.nodeId }, node.hostname + '（离线）') : h('option', { value: '' }, '选择在线机器…'),
              online.map((n) => h('option', { key: n.nodeId, value: n.nodeId }, n.hostname)))),
          errOf('nodeId'),
          h(Field, { label: '名称' + (editing ? '（留空 = 不改名）' : '（必填）'), hint: teamTrimLen(form.name) + '/' + teamLimits.name },
            h('input', { className: 'dra-input', value: form.name, onChange: (e) => patchForm({ name: e.target.value }) })),
          errOf('name'),
          h(Field, { label: '角色' + blank, hint: teamTrimLen(form.role) + '/' + teamLimits.role },
            h('input', { className: 'dra-input', value: form.role, onChange: (e) => patchForm({ role: e.target.value }) })),
          errOf('role'),
          opts.length > 0 ? h(Field, { label: '从这台机器的模型里选' },
            h('select', { className: 'dra-select', value: '', onChange: (e) => { if (e.target.value) patchForm({ modelRef: e.target.value }) } },
              h('option', { value: '' }, '选一个模型…'),
              opts.map((o) => h('option', { key: o.id, value: o.id }, o.label)))) : null,
          h(Field, { label: '模型（provider/model）' + blank, hint: teamTrimLen(form.modelRef) + '/' + teamLimits.modelRef },
            h('input', { className: 'dra-input dra-mono', value: form.modelRef, onChange: (e) => patchForm({ modelRef: e.target.value }) })),
          errOf('modelRef'),
          h(Field, { label: '工作目录' + blank, hint: teamTrimLen(form.workDir) + '/' + teamLimits.workDir },
            h('input', { className: 'dra-input dra-mono', value: form.workDir, onChange: (e) => patchForm({ workDir: e.target.value }) })),
          errOf('workDir'),
          h(Field, { label: '指令' + blank, wide: true, hint: teamUtf8Bytes(String(form.instructions).trim()) + '/' + teamLimits.instructionsBytes + ' 字节' },
            h('textarea', { className: 'dra-textarea', rows: 5, value: form.instructions, onChange: (e) => patchForm({ instructions: e.target.value }) })),
          errOf('instructions'),
          formStatus.note ? h('p', { className: formStatus.ok ? 'dra-ok' : 'tm-err', role: formStatus.ok ? 'status' : 'alert' }, formStatus.note) : null,
          h('div', { className: 'dra-row' },
            h('button', { type: 'submit', className: 'dra-btn primary', disabled: formStatus.busy }, formStatus.busy ? '提交中…' : editing ? '保存' : '创建'),
            h('button', { type: 'button', className: 'dra-btn', disabled: formStatus.busy, onClick: cancelForm }, editing ? '取消编辑' : '清空并关闭'))))
    }

    function detailView() {
      if (!detail) {
        return h(Card, { className: 'tm-detail', title: '详情' }, h(Empty, null, '点 Bot 的「对话」「编辑」「定位」，或「新建 Bot」，内容会显示在这里。'))
      }
      if (detail.kind === 'form') return formView()
      const f = teamFindBot(rows, detail.nodeId, detail.botId)
      const gone = h(Card, { className: 'tm-detail', title: '详情', actions: h('button', { type: 'button', className: 'dra-btn sm', onClick: () => setDetail(null) }, '关闭') },
        h('p', { className: 'tm-note dra-warn' }, '这个 Bot 已经不在名册里了（可能被删除，或名册还没刷新）。'))
      if (!f) return bots.state === 'loading' ? h(Card, { className: 'tm-detail', title: '详情' }, h('p', { className: 'dra-hint' }, '读取名册中…')) : gone
      if (detail.kind === 'chat') {
        return h(ChatPane, {
          key: 'chat:' + f.node.nodeId + '/' + f.bot.id, nodeId: f.node.nodeId, botId: f.bot.id, name: f.bot.name, host: f.node.hostname,
          online: f.node.online, seed: teamAvatarSeed(f.bot), onClose: () => setDetail(null), onEdit: () => openEdit(f.node, f.bot),
        })
      }
      if (!f.bot.identityId) return gone
      return h(LocatePane, { key: 'locate:' + f.bot.identityId, identityId: f.bot.identityId, name: f.bot.name, nameOf, onClose: () => setDetail(null) })
    }

    const modelTotal = teamModelsTotal(models.nodes)
    return h('div', { className: 'dra-col' },
      h('div', { className: 'dra-row' },
        h('span', { className: 'tm-count' }, rows.length + ' 台机器 · ' + totalBots + ' 个 Bot'),
        h('span', { className: 'dra-spacer' }),
        h('button', { type: 'button', className: 'dra-btn primary', onClick: () => openCreate('') }, '新建 Bot'),
        h('button', { type: 'button', className: 'dra-btn', onClick: () => { loadBots(true); loadModels() } }, '刷新名册')),
      h('div', { className: 'tm-layout' }, h('div', { className: 'dra-col' }, roster()), h('div', { className: 'dra-col' }, detailView())),
      h(Fold, { title: '模型目录', badge: models.state === 'loading' ? '读取中' : modelTotal + ' 个' }, modelsBody(models)),
      h(Fold, { title: '团队记忆' }, h(MemorySection, { tick, ui })),
      h(Fold, { title: '目标追踪', badge: hub.goals === undefined ? '—' : hub.goals.length + ' 个', open: hub.goals !== undefined && hub.goals.some((g) => g && !g.idle) }, goalsBody(hub, nameOf)),
      h(Fold, { title: 'Bot 间通信审计（历史）', badge: hub.botAudit === undefined ? '—' : hub.botAudit.length + ' 条' }, auditBody(hub, nameOf)))
  }

  return { css: teamCss, Screen }
}
