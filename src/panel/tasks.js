/**
 * 任务屏：派发、模板、任务总览（需要你处理 / 列表 / 筛选）、任务详情（交接卡、拉取成品）、工单。
 * 纯函数在顶层导出以便测试；用到 React 的东西都在 createTasks 里。
 * 顶层标识符一律以 `tasks` 开头（构建会把所有屏并进同一个闭包）。
 *
 * 服务端契约（只用这些接口，字段以 src/http/routes.js 为准）：
 *   GET  /tasks（hub 快照已带）   GET /task?taskId → { task, handoff }
 *   POST /dispatch { goal, node?, mode, workspace?, model?, outputs?, timeoutMs?, approval? } → { ok, taskId, nodeId, approval }
 *   POST /cancel { taskId } → { requested }     POST /approve | /reject { taskId }
 *   POST /purge { includeActive:false } → { removed, kept }
 *   POST /pull { taskId, paths, dest? } → { dest, results:[{ path, ok, error?, message? }] }   需要 hub.caps.pull
 *   GET  /templates → { templates, max, degraded, reason, file }   POST /templates/save | /templates/delete
 *   hub.tickets（来自 GET /tickets）→ [{ ticketId, state, hasExecutor }]
 *   GET  /assignments?limit=200 → { assignments:[{ taskId, nodeId, status, startedAt, endedAt, at }] }（最新在前；台账落盘，重启与「清理历史任务」都不删它）
 */
import { coreActiveStatuses, coreExplain, coreFailedStatuses, coreFailure, coreFmtBytes, coreFmtDur, coreFmtTime, coreShortId } from './core.js'

/* ── 状态 ──────────────────────────────────────────────────────────── */

export const tasksStatusLabel = {
  running: '运行中', queued: '排队中', pending_approval: '待批准',
  completed: '已完成', failed: '失败', aborted: '已中止', interrupted: '已中断', rejected: '已拒绝', unknown: '未知',
}
export const tasksTerminalStatuses = ['completed', 'failed', 'aborted', 'interrupted', 'rejected']

export function tasksStatusText(status) { return tasksStatusLabel[status] || String(status || '未知') }
export function tasksIsActive(status) { return coreActiveStatuses.indexOf(status) >= 0 }
/** Badge 的色调。状态永远还带着文字，颜色只是辅助。 */
export function tasksStatusTone(status) {
  if (status === 'completed') return 'ok'
  if (coreFailedStatuses.indexOf(status) >= 0) return 'bad'
  if (status === 'pending_approval' || status === 'interrupted') return 'warn'
  return status === 'running' || status === 'queued' ? 'acc' : ''
}

export const tasksFilterDefs = [['all', '全部'], ['active', '进行中'], ['done', '已完成'], ['failed', '失败·中止·拒绝']]

export function tasksFilterMatch(task, filter) {
  const s = task && task.status
  if (filter === 'active') return tasksIsActive(s)
  if (filter === 'done') return s === 'completed'
  if (filter === 'failed') return coreFailedStatuses.indexOf(s) >= 0
  return true
}

export function tasksCounts(tasks) {
  const list = Array.isArray(tasks) ? tasks : []
  const n = (f) => list.filter(f).length
  return {
    all: list.length,
    active: n((t) => tasksIsActive(t.status)),
    pending: n((t) => t.status === 'pending_approval'),
    done: n((t) => t.status === 'completed'),
    failed: n((t) => coreFailedStatuses.indexOf(t.status) >= 0),
    interrupted: n((t) => t.status === 'interrupted'),
  }
}

/** 列表分组：「全部」分成 进行中 / 历史 两组，其余筛选只给一组。服务端已按最新在前排好序。 */
export function tasksGroups(tasks, filter) {
  const shown = (Array.isArray(tasks) ? tasks : []).filter((t) => tasksFilterMatch(t, filter))
  return {
    active: shown.filter((t) => tasksIsActive(t.status)),
    history: shown.filter((t) => !tasksIsActive(t.status)),
    labelled: filter === 'all' || !filter,
    total: shown.length,
  }
}

export function tasksNodeName(nodes, nodeId) {
  const n = (Array.isArray(nodes) ? nodes : []).filter((x) => x && x.nodeId === nodeId)[0]
  return (n && n.hostname) || coreShortId(nodeId) || '?'
}

/** 耗时：进行中从开始算到现在；终态用服务端给的 durationMs，缺了再用起止差。算不出来返回 null（显示「—」）。 */
export function tasksDuration(t, now) {
  if (!t) return null
  if (tasksIsActive(t.status)) return t.startedAt > 0 ? Math.max(0, now - t.startedAt) : null
  if (t.durationMs > 0) return t.durationMs
  return t.startedAt > 0 && t.endedAt > 0 ? t.endedAt - t.startedAt : null
}

/** 一行进度：优先 progressTail 里最后一条非空 detail，其次 summaryText 的首行。 */
export function tasksProgressLine(t) {
  if (!t || typeof t !== 'object') return ''
  const tail = Array.isArray(t.progressTail) ? t.progressTail : []
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const p = tail[i]
    if (p && typeof p.detail === 'string' && p.detail.trim() !== '') return p.detail.trim()
  }
  if (typeof t.summaryText === 'string' && t.summaryText.trim() !== '') return t.summaryText.trim().split('\n')[0]
  return ''
}

export function tasksCancelEvidenceLabel(t) {
  const ev = t && t.cancelEvidence
  if (!ev || ev.state !== 'aborted') return ''
  return ev.abortedBeforeStart === true ? '已取消（未开始，节点确认）' : '已取消（节点确认）'
}

export function tasksStallLabel(t) {
  const sh = t && t.stallHint
  if (!sh || sh.stalled !== true) return ''
  if (!tasksIsActive(t.status)) return ''
  return '已 ' + Math.max(1, Math.floor((Number(sh.idleMs) || 0) / 60000)) + ' 分钟无更新（仅提示）'
}

/** 取消回执只描述「这一次点击」，不描述任务状态；分类依据点击前最后已知的状态。 */
export function tasksCancelReceipt(args) {
  const before = args && args.before
  const response = args && args.response
  if (before && tasksTerminalStatuses.indexOf(before.status) >= 0) return { kind: 'terminal', text: '任务已结束，无需取消' }
  if (response && response.requested === true) return { kind: 'requested', text: '已提交取消请求，等待任务状态更新' }
  return { kind: 'notDelivered', text: '取消请求未送达' }
}

/** 象限：需要你（待批准）/ 执行中 / 中断·失败 / 最近完成（最新 4 条）。 */
export function tasksQuadrants(tasks) {
  const list = Array.isArray(tasks) ? tasks : []
  const by = (f) => list.filter((t) => f(t.status))
  const newest = (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
  return {
    needsYou: by((s) => s === 'pending_approval'),
    working: by((s) => s === 'running' || s === 'queued'),
    blocked: by((s) => s === 'interrupted' || s === 'aborted' || s === 'failed'),
    done: by((s) => s === 'completed').sort(newest).slice(0, 4),
  }
}

export function tasksQuadLabel(t, nodes) {
  const goal = String((t && t.goal) || '')
  return (goal ? goal.slice(0, 36) + (goal.length > 36 ? '…' : '') : coreShortId(t && t.taskId)) + ' @' + tasksNodeName(nodes, t && t.nodeId)
}

/* ── 工单（需要你处理） ─────────────────────────────────────────────── */

const tasksPersonReasons = ['answer', 'review', 'blocked', 'failed']
export const tasksTicketText = {
  title: '待你处理的工单', idle: '未结束', working: '执行中', withExecutor: '已关联执行器', withoutExecutor: '未关联执行器',
  answer: '需要你回答', review: '需要你审阅', blocked: '被阻塞，等你处理', failed: '执行失败，等你处理',
}

/** 工单阶段：结束/中断 → ended；执行器上报了需要人 → person；在跑 → working；其余 idle。 */
export function tasksTicketStage(ticket, executorState) {
  if (ticket && (ticket.state === 'ended' || ticket.state === 'interrupted')) return { stage: 'ended' }
  if (ticket && ticket.state === 'open' && executorState && typeof executorState === 'object') {
    const reason = executorState.attention && executorState.attention.kind
    if (tasksPersonReasons.indexOf(reason) >= 0) return { stage: 'person', reason }
    if (executorState.running === true) return { stage: 'working' }
  }
  return { stage: 'idle' }
}

/** 去掉已结束的，需要人的排最前，其次在跑，最后未结束。 */
export function tasksSortAttention(rows) {
  const order = { person: 0, working: 1, idle: 2 }
  return rows.filter((r) => r.stage !== 'ended').sort((a, b) => order[a.stage] - order[b.stage])
}

/** hub.tickets → 排好序的行。服务端当前只回 { ticketId, state, hasExecutor }；带 executorState 的话会按它分阶段。 */
export function tasksAttentionRows(tickets) {
  if (!Array.isArray(tickets)) return []
  return tasksSortAttention(tickets
    .filter((t) => t && typeof t.ticketId === 'string')
    .map((t) => { const s = tasksTicketStage(t, t.executorState); return { ticket: t, stage: s.stage, reason: s.reason || '' } }))
}

export function tasksTicketLabel(row) {
  if (row.stage === 'person') return tasksTicketText[row.reason] || tasksTicketText.title
  return tasksTicketText[row.stage] || tasksTicketText.idle
}

/* ── 派发表单 ──────────────────────────────────────────────────────── */

export function tasksNewForm() {
  return { goal: '', node: '', mode: 'agent', workspace: '', model: '', outputs: '', timeoutMs: '', needApproval: false, templateId: '' }
}

export function tasksParseOutputs(text) {
  return String(text || '').split(/[, \n]+/).map((s) => s.trim()).filter(Boolean)
}

/** 超时：留空 = 不传（服务端按模式取默认）；写了就必须是 > 0 的数，不再悄悄丢掉。 */
export function tasksParseTimeout(text) {
  const s = String(text == null ? '' : text).trim()
  if (s === '') return { value: undefined, error: '' }
  const n = Number(s)
  if (Number.isFinite(n) && n > 0) return { value: Math.round(n), error: '' }
  return { value: undefined, error: '超时需要是大于 0 的毫秒数（留空 = 用默认值）' }
}

export function tasksDispatchBody(form) {
  const f = form || {}
  const goal = String(f.goal || '').trim()
  if (goal === '') return { ok: false, error: '先填写任务目标' }
  const tmo = tasksParseTimeout(f.timeoutMs)
  if (tmo.error) return { ok: false, error: tmo.error }
  const outputs = tasksParseOutputs(f.outputs)
  const body = { goal, mode: f.mode === 'exec' ? 'exec' : 'agent' }
  if (f.node) body.node = f.node
  if (String(f.workspace || '').trim()) body.workspace = String(f.workspace).trim()
  if (String(f.model || '').trim()) body.model = String(f.model).trim()
  if (outputs.length) body.outputs = outputs
  if (tmo.value !== undefined) body.timeoutMs = tmo.value
  if (f.needApproval === true) body.approval = 'manual'
  return { ok: true, body }
}

/**
 * 派发前就能判断的阻碍（给一句人话，按钮据此禁用）。
 * 服务端规则：没指定 node 时，只有整个 hub 恰好一台机器才会自动选；多台必须指定。
 */
export function tasksDispatchProblem(form, nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  if (list.filter((n) => n && n.online === true).length === 0) return list.length === 0 ? '还没有接入任何机器，无法派发' : '所有机器都离线，无法派发'
  if (form && form.node) {
    const n = list.filter((x) => x && x.nodeId === form.node)[0]
    if (!n) return '所选机器已不存在，请重新选择'
    return n.online === true ? '' : '所选机器已离线，请换一台在线的机器'
  }
  return list.length > 1 ? '有多台机器，请先选一台目标机器' : ''
}

/** 模型清单：选了机器就用它自己的，没选就合并所有在线机器的。reported=false 表示没有任何清单（退回自由文本）。 */
export function tasksModelOptions(nodes, nodeId) {
  const list = Array.isArray(nodes) ? nodes : []
  const picked = nodeId ? list.filter((n) => n && n.nodeId === nodeId) : list.filter((n) => n && n.online === true)
  const reported = picked.some((n) => Array.isArray(n.models))
  const seen = {}
  const options = []
  picked.forEach((n) => {
    ;(Array.isArray(n.models) ? n.models : []).forEach((m) => {
      const key = m.provider ? m.provider + '/' + m.id : m.id
      if (seen[key]) return
      seen[key] = true
      options.push({ key, label: (m.name || m.id) + (nodeId ? '' : ' · ' + tasksNodeName(list, n.nodeId)) })
    })
  })
  const d = nodeId && picked[0] && picked[0].defaultModel
  return { options, reported, defaultLabel: d && d.model ? (d.provider ? d.provider + '/' + d.model : d.model) : '' }
}

/* ── 模板 ↔ 表单 ──────────────────────────────────────────────────── */

export function tasksModelString(m) {
  if (!m || typeof m !== 'object') return ''
  return m.provider ? m.provider + '/' + (m.model || '') : (m.model || '')
}

/** 套用模板：只覆盖模板里有的字段；目标机器和「需要审批」是这一次派发的选择，不动。 */
export function tasksFormFromTemplate(t, form) {
  return Object.assign({}, form, {
    templateId: t.id,
    goal: t.goal || '',
    mode: t.mode === 'exec' ? 'exec' : 'agent',
    workspace: t.workspace || '',
    model: tasksModelString(t.model),
    outputs: (t.outputs || []).join(', '),
    timeoutMs: t.timeoutMs ? String(t.timeoutMs) : '',
  })
}

export function tasksTemplateBody(form, name) {
  const f = form || {}
  const tmo = tasksParseTimeout(f.timeoutMs)
  if (tmo.error) return { ok: false, error: tmo.error }
  const outputs = tasksParseOutputs(f.outputs)
  const body = { name: String(name).trim(), goal: String(f.goal || '').trim(), mode: f.mode === 'exec' ? 'exec' : 'agent' }
  if (String(f.workspace || '').trim()) body.workspace = String(f.workspace).trim()
  if (String(f.model || '').trim()) body.model = String(f.model).trim()
  if (outputs.length) body.outputs = outputs
  if (tmo.value !== undefined) body.timeoutMs = tmo.value
  if (f.templateId) body.id = f.templateId
  return { ok: true, body }
}

export function tasksTemplateOptionLabel(t) {
  return t.name + (t.mode === 'exec' ? '（exec）' : '') + (t.workspace ? ' · ' + t.workspace : '')
}

/* ── 详情 / 拉取 ──────────────────────────────────────────────────── */

/** 成品清单在 handoff.artifacts.final（[{ path, kind, bytes, sha256 }]）；只有 final 能拉。 */
export function tasksFinals(handoff) {
  const a = handoff && handoff.artifacts
  return a && Array.isArray(a.final) ? a.final.filter((f) => f && typeof f.path === 'string' && f.path !== '') : []
}
export function tasksFinalPaths(handoff) { return tasksFinals(handoff).map((f) => f.path) }

export function tasksChangedLine(c) {
  if (!c || typeof c !== 'object') return String(c)
  const d = Number(c.deltaBytes)
  return (c.op || '?') + ' ' + (c.path || '') + (Number.isFinite(d) && d !== 0 ? '（' + (d > 0 ? '+' : '') + d + ' B）' : '')
}

export function tasksProgressItemLine(p, i) {
  if (typeof p === 'string') return (i + 1) + '. ' + p
  const x = p && typeof p === 'object' ? p : {}
  return (i + 1) + '. ' + (x.phase && x.phase !== 'progress' ? '[' + x.phase + '] ' : '') + (x.detail || x.message || '')
}

/** hub.caps.pull === false → 禁用并说明原因；caps 还没读到（null）时先放行，服务端会兜底拒绝。 */
export function tasksPullState(caps) {
  if (caps && caps.pull === false) return { enabled: false, reason: '主机没有配置 uiPullRoot（拉取落地目录），不能从这里拉取产物', root: '' }
  return { enabled: true, reason: '', root: caps && typeof caps.pullRoot === 'string' ? caps.pullRoot : '' }
}

export function tasksPullPrompt(root) {
  return (root ? '拉到 ' + root + ' 下的哪个相对子目录？' : '拉到主机 uiPullRoot 下的哪个相对子目录？') + '（留空 = 直接放进去）'
}

export function tasksPullBody(taskId, paths, dest) {
  const d = String(dest == null ? '' : dest).trim()
  return d ? { taskId, paths, dest: d } : { taskId, paths }
}

/** 「拉取 x/y 个文件到 …」，有失败的把原因跟在后面。 */
export function tasksPullSummary(resp, sent) {
  const results = resp && Array.isArray(resp.results) ? resp.results : []
  const ok = results.filter((r) => r && r.ok === true)
  const bad = results.filter((r) => r && r.ok !== true)
  let text = '拉取 ' + ok.length + '/' + sent.length + ' 个文件到 ' + ((resp && resp.dest) || '目标目录')
  if (bad.length) text += '；失败：' + bad.map((r) => r.path + '（' + (r.message || r.error || 'unknown') + '）').join('、')
  if (results.length < sent.length) text += '（单次最多拉 ' + results.length + ' 个，其余请再拉一次）'
  return { text, tone: ok.length === sent.length ? 'ok' : ok.length === 0 ? 'err' : '' }
}

/** 失败文案：优先给服务端的人话（message），再补稳定错误码；已知错误码给一句解释。 */
export function tasksErr(e) {
  const f = coreFailure(e)
  const msg = String((e && e.message) || f.error)
  const code = f.body && typeof f.body.error === 'string' ? f.body.error : ''
  return coreExplain(msg) + (code && code !== msg ? '（' + code + '）' : '')
}

/* ── 分配台账（只读）──────────────────────────────────────────────── */

export const tasksLedgerText = {
  title: '分配台账',
  empty: '还没有记录；任务结束后会记在这里，清理历史任务不会删除它',
  emptyNode: '这台机器还没有记录',
  unavailable: '主机没有返回台账（可能版本较旧）；这不代表记录丢失',
  gone: '任务记录已清理，台账保留',
}

function tasksLedgerWhen(r) {
  if (Number.isFinite(r.at) && r.at > 0) return r.at
  return Number.isFinite(r.endedAt) && r.endedAt > 0 ? r.endedAt : 0
}

/**
 * 台账记录 → 展示行：最新在前；同一任务只留最新一条（older = 更早的记录数）；缺字段不抛。
 * 记录本身只有 taskId/nodeId/status/startedAt/endedAt/at；目标取记录里的 goal/summary（若有），否则取仍在列表里的任务的目标。
 */
export function tasksLedgerRows(assignments, tasks, nodes) {
  const live = {}
  ;(Array.isArray(tasks) ? tasks : []).forEach((t) => { if (t && typeof t.taskId === 'string') live[t.taskId] = t })
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '')
  const sorted = (Array.isArray(assignments) ? assignments : [])
    .filter((r) => r && typeof r === 'object' && typeof r.taskId === 'string' && r.taskId !== '')
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (tasksLedgerWhen(b.r) - tasksLedgerWhen(a.r)) || (a.i - b.i))
  const byTask = {}
  const rows = []
  sorted.forEach((e) => {
    const r = e.r
    if (byTask[r.taskId]) { byTask[r.taskId].older += 1; return }
    const nodeId = typeof r.nodeId === 'string' ? r.nodeId : ''
    const status = str(r.status) || 'unknown'
    const started = Number.isFinite(r.startedAt) ? r.startedAt : 0
    const ended = Number.isFinite(r.endedAt) ? r.endedAt : 0
    const row = {
      taskId: r.taskId, shortId: coreShortId(r.taskId), nodeId, nodeName: nodeId ? tasksNodeName(nodes, nodeId) : '未知机器',
      status, statusText: tasksStatusText(status), tone: tasksStatusTone(status), at: tasksLedgerWhen(r), startedAt: started, endedAt: ended,
      durationMs: started > 0 && ended >= started ? ended - started : null,
      goal: str(r.goal) || str(r.summary) || str(live[r.taskId] && live[r.taskId].goal),
      exists: !!live[r.taskId], older: 0,
    }
    byTask[r.taskId] = row
    rows.push(row)
  })
  return rows
}

/** 筛选下拉的机器：hub 里的所有机器，加上台账里出现过但 hub 已经不认识的。 */
export function tasksLedgerNodes(rows, nodes) {
  const out = []
  const seen = {}
  const add = (id) => { if (id && !seen[id]) { seen[id] = true; out.push({ id, label: tasksNodeName(nodes, id) }) } }
  ;(Array.isArray(nodes) ? nodes : []).forEach((n) => { if (n) add(n.nodeId) })
  ;(Array.isArray(rows) ? rows : []).forEach((r) => add(r.nodeId))
  return out
}

export function tasksLedgerFilter(rows, nodeId) { return nodeId ? rows.filter((r) => r.nodeId === nodeId) : rows }

/** 台账区当前该显示哪种状态：loading / error / unavailable / empty / rows。 */
export function tasksLedgerStage(ledger, rows, shown) {
  const l = ledger || {}
  if (!l.loaded && !l.error) return 'loading'
  if (l.error && rows.length === 0) return 'error'
  if (l.unavailable) return 'unavailable'
  return shown.length === 0 ? 'empty' : 'rows'
}

export function tasksLedgerNew() { return { open: false, loaded: false, loading: false, error: '', unavailable: false, items: [] } }

/* ── 组件 ──────────────────────────────────────────────────────────── */

export function createTasks(core) {
  const { React, h, api, Badge, Banner, Card, CopyBtn, Empty, Field, Fold, Seg, Stat } = core

  const css = [
    '.tk{display:flex;flex-direction:column;gap:14px;min-width:0}',
    '.tk-note{position:sticky;top:0;z-index:5}.tk-note .dra-banner{margin:0;box-shadow:var(--dra-hl),var(--dra-elev-2)}',
    '.tk-dur{font-family:var(--dra-mono);font-variant-numeric:tabular-nums}',

    /* 四个象限：大玻璃块，状态字形 + 大号等宽数字 */
    '.tk-attn{gap:14px}',
    '.tk-quads{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}',
    '.tk-quad{display:flex;flex-direction:column;gap:6px;min-width:0;padding:14px 16px 12px;border:1px solid var(--dra-border);border-radius:var(--dra-r-md);background:var(--dra-sheen),var(--dra-glass);box-shadow:var(--dra-hl),var(--dra-shadow)}',
    '.tk-quad.needs{--tk-tone:var(--dra-warn)}.tk-quad.working{--tk-tone:var(--dra-accent)}.tk-quad.blocked{--tk-tone:var(--dra-danger)}.tk-quad.done{--tk-tone:var(--dra-ok)}',
    '.tk-quad.needs.hot{border-color:color-mix(in srgb,var(--dra-warn) 55%,transparent);box-shadow:var(--dra-hl),var(--dra-elev-2)}',
    '.tk-quad-title{display:flex;align-items:center;gap:7px;margin:0;font-size:12px;font-weight:600;color:var(--dra-text-dim)}',
    '.tk-quad-glyph{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:var(--dra-r-pill);font-size:11px;color:var(--tk-tone);background:color-mix(in srgb,var(--tk-tone) 16%,transparent);border:1px solid color-mix(in srgb,var(--tk-tone) 45%,transparent)}',
    '.tk-quad.needs .tk-quad-glyph::before{content:"▲"}.tk-quad.working .tk-quad-glyph::before{content:"●"}.tk-quad.blocked .tk-quad-glyph::before{content:"✕"}.tk-quad.done .tk-quad-glyph::before{content:"✓"}',
    '.tk-quad-count{font-size:34px;line-height:1.05;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--tk-tone)}',
    '.tk-quad.zero .tk-quad-count{color:var(--dra-text-dim)}',
    '.tk-quad-items{display:flex;flex-direction:column;gap:2px;margin-top:2px;min-width:0}',
    '.tk-quad-item{display:block;width:100%;text-align:left;background:none;border:0;border-radius:var(--dra-r-sm);color:var(--dra-text);padding:4px 8px;font:inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background-color .18s var(--dra-ease)}',
    '.tk-quad-item:hover{background:color-mix(in srgb,var(--tk-tone) 12%,transparent)}',
    '.tk-quad-none{color:var(--dra-text-dim);font-size:12px;padding:4px 8px}',

    /* 工单：iOS 风格分组列表（嵌在大卡里，内圆角 = 外圆角 - 间距） */
    '.tk-attn .dra-fold{border-radius:var(--dra-r-md);box-shadow:none;background:color-mix(in srgb,var(--dra-surface-2) 55%,transparent);backdrop-filter:none;-webkit-backdrop-filter:none}',
    '.tk-attn .dra-fold-sum{border-radius:var(--dra-r-md)}',
    '.tk-ios{border:1px solid var(--dra-border);border-radius:var(--dra-r-md);background:color-mix(in srgb,var(--dra-surface-1) 70%,transparent);overflow:hidden}',
    '.tk-ios-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;min-height:44px}',
    '.tk-ios-row+.tk-ios-row{border-top:1px solid var(--dra-border)}',
    '.tk-ios-row .dra-hint{margin-left:auto}',

    /* 派发表单：抬高的玻璃卡，模板条是胶囊组，主按钮是全屏唯一的渐变 */
    '.tk-dispatch{position:relative;box-shadow:var(--dra-hl),var(--dra-elev-2);border-color:color-mix(in srgb,var(--dra-accent) 24%,var(--dra-border))}',
    '.tk-dispatch::before{content:"";position:absolute;left:24px;right:24px;top:0;height:2px;border-radius:var(--dra-r-pill);background:var(--dra-aurora);opacity:.75}',
    '.tk-tplbar{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}',
    '.tk-tpl{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 6px 4px 16px;border:1px solid var(--dra-border);border-radius:var(--dra-r-pill);background:color-mix(in srgb,var(--dra-surface-1) 72%,transparent);box-shadow:inset 0 1px 3px color-mix(in srgb,var(--dra-bg) 70%,transparent)}',
    '.tk-tpl .dra-field{flex:1 1 240px;flex-direction:row;align-items:center;gap:10px}',
    '.tk-tpl .dra-field-label{white-space:nowrap;font-weight:600}',
    '.tk-tpl .dra-select{border:0;background:transparent;box-shadow:none;min-height:30px}',
    '.tk-tpl .dra-select:focus{box-shadow:none}',
    '.tk-tpl-btns{display:flex;gap:4px;flex-wrap:wrap}',
    '.tk-tpl-msg{padding-left:16px}',
    '.tk-adv{margin-top:12px}.tk-adv .dra-fold{border-radius:var(--dra-r-md);box-shadow:none;background:color-mix(in srgb,var(--dra-surface-2) 45%,transparent);backdrop-filter:none;-webkit-backdrop-filter:none}.tk-adv .dra-fold-sum{border-radius:var(--dra-r-md)}',
    '.tk-form-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:16px}',
    '.tk-submit{min-height:40px;padding:8px 28px;font-size:14px;border-radius:var(--dra-r-pill)}',
    '.tk-form-note{margin-top:8px}',
    '.tk-split{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:14px;align-items:start}',
    '.tk-detail-col{position:sticky;top:8px;display:flex;flex-direction:column;max-height:calc(100vh - 24px)}',
    '.tk-detail{display:flex;flex-direction:column;min-height:0}.tk-detail .dra-card-body{overflow:auto;min-height:0}',

    /* 任务列表：每行是一块圆角瓷砖；运行中的行有旋转的极光描边和带扫光的进度槽 */
    '.tk-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
    '.tk-group{margin:8px 2px 0;font-size:12px;color:var(--dra-text-dim);font-weight:600}',
    '.tk-row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:11px 14px;border-radius:var(--dra-r-md)}',
    '.tk-row.tk-calm{border:1px solid var(--dra-border);background:var(--dra-sheen),color-mix(in srgb,var(--dra-surface-2) 70%,transparent);box-shadow:var(--dra-hl);transition:border-color .2s var(--dra-ease),box-shadow .2s var(--dra-ease)}',
    '.tk-row.tk-calm:hover{border-color:var(--dra-border-strong)}',
    '.tk-row.tk-raised{border-color:color-mix(in srgb,var(--dra-warn) 55%,transparent);background:linear-gradient(90deg,color-mix(in srgb,var(--dra-warn) 14%,transparent),transparent 65%),var(--dra-sheen),var(--dra-surface-2);box-shadow:var(--dra-hl),var(--dra-elev-2),inset 4px 0 0 var(--dra-warn)}',
    '.tk-row.sel{box-shadow:var(--dra-hl),var(--dra-shadow),0 0 0 2px color-mix(in srgb,var(--dra-accent) 60%,transparent)}',
    '.tk-row-main{flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:4px;text-align:left;background:none;border:0;border-radius:var(--dra-r-sm);color:var(--dra-text);font:inherit;cursor:pointer;padding:0}',
    '.tk-row-title{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.tk-goal{font-weight:600;font-size:14px;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
    '.tk-row-sub{display:flex;gap:4px 12px;flex-wrap:wrap;font-size:12px;color:var(--dra-text-dim)}',
    '.tk-row-line{font-size:12px;color:var(--dra-text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.tk-stall{color:var(--dra-warn)}.tk-stall::before{content:"▲ "}',
    '.tk-row-acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex:none}',
    '.tk-approve{border-color:color-mix(in srgb,var(--dra-ok) 55%,transparent);color:var(--dra-ok);background:color-mix(in srgb,var(--dra-ok) 14%,var(--dra-surface-2));font-weight:600}',
    '.tk-approve::before{content:"✓"}.tk-reject::before{content:"✕"}',
    '.tk-track{display:block;flex:1 0 100%;height:8px;border-radius:var(--dra-r-pill);background:color-mix(in srgb,var(--dra-bg) 55%,var(--dra-surface-1));box-shadow:inset 0 1px 3px color-mix(in srgb,var(--dra-bg) 80%,transparent);overflow:hidden}',
    '.tk-track-fill{display:block;width:100%;height:100%;border-radius:var(--dra-r-pill);background:var(--dra-aurora)}',
    '.tk-track.stalled .tk-track-fill{background:color-mix(in srgb,var(--dra-warn) 70%,transparent)}',

    /* 详情：抬高的玻璃面板，打开时回弹进入 */
    '.tk-detail{box-shadow:var(--dra-hl),var(--dra-elev-2);border-color:color-mix(in srgb,var(--dra-accent) 30%,var(--dra-border))}',
    '.tk-detail .tk-track{margin:2px 0 10px}',
    '.tk-pre{margin:0;padding:10px 12px;background:color-mix(in srgb,var(--dra-surface-1) 70%,transparent);border:1px solid var(--dra-border);border-radius:var(--dra-r-xs);box-shadow:inset 0 1px 3px color-mix(in srgb,var(--dra-bg) 60%,transparent);font-family:var(--dra-mono);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}',
    '.tk-sec{margin:14px 0 6px;font-size:12px;color:var(--dra-text-dim);font-weight:600}',
    '.tk-final{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:6px 10px;margin-bottom:4px;border:1px solid var(--dra-border);border-radius:var(--dra-r-sm);background:color-mix(in srgb,var(--dra-surface-2) 55%,transparent)}',
    '.tk-final-path{flex:1;min-width:0;font-family:var(--dra-mono);font-size:12px;overflow-wrap:anywhere}',
    '.tk-final-meta{color:var(--dra-text-dim);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.tk-detail-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',

    /* 分配台账：竖直时间线，一条细渐变脊线，每条记录一个按最终状态着色并带字形的节点 */
    '.tk-led-bar{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.tk-led-bar .dra-field{min-width:200px}',
    '.tk-led-list{position:relative;list-style:none;margin:0;padding:0 0 0 32px;display:flex;flex-direction:column;gap:8px}',
    '.tk-led-list::before{content:"";position:absolute;left:11px;top:8px;bottom:8px;width:2px;border-radius:var(--dra-r-pill);background:linear-gradient(180deg,var(--dra-accent),var(--dra-accent-2),var(--dra-accent-3));opacity:.6}',
    '.tk-led-row{position:relative}',
    '.tk-led-dot{position:absolute;left:-32px;top:9px;width:24px;height:24px;display:grid;place-items:center;border-radius:var(--dra-r-pill);font-size:11px;font-weight:700;color:var(--dra-text-dim);background:var(--dra-surface-1);border:2px solid color-mix(in srgb,var(--dra-text-dim) 60%,transparent);box-shadow:var(--dra-hl),0 2px 6px -1px color-mix(in srgb,var(--dra-bg) 70%,transparent)}',
    '.tk-led-dot::before{content:"?"}',
    '.tk-led-dot.ok{color:var(--dra-ok);border-color:var(--dra-ok)}.tk-led-dot.ok::before{content:"✓"}',
    '.tk-led-dot.bad{color:var(--dra-danger);border-color:var(--dra-danger)}.tk-led-dot.bad::before{content:"✕"}',
    '.tk-led-dot.warn{color:var(--dra-warn);border-color:var(--dra-warn)}.tk-led-dot.warn::before{content:"▲"}',
    '.tk-led-dot.acc{color:var(--dra-accent);border-color:var(--dra-accent)}.tk-led-dot.acc::before{content:"●"}',
    '.tk-led-body{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;padding:9px 14px;border:1px solid var(--dra-border);border-radius:var(--dra-r-md);background:color-mix(in srgb,var(--dra-surface-2) 55%,transparent);box-shadow:var(--dra-hl)}',
    '.tk-led-meta{display:flex;gap:4px 12px;flex-wrap:wrap;align-items:center;flex:1;min-width:0;font-size:12px;color:var(--dra-text-dim)}',
    '.tk-led-goal{flex-basis:100%;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  ]

  /* 象限：四块大玻璃块（字形 + 大号数字 + 名单）。「需要你」有内容时抬高。 */
  function Quadrants(p) {
    const q = tasksQuadrants(p.tasks)
    const quad = (key, title, items) => h('div', {
      key, className: 'tk-quad ' + key + (items.length === 0 ? ' zero' : '') + (key === 'needs' && items.length ? ' hot' : ''), role: 'group', 'aria-label': title,
    },
    h('h4', { className: 'tk-quad-title' }, h('span', { className: 'tk-quad-glyph', 'aria-hidden': 'true' }), title),
    h('div', { className: 'tk-quad-count' }, items.length),
    h('div', { className: 'tk-quad-items' }, items.length === 0
      ? h('div', { className: 'tk-quad-none' }, '无')
      : items.map((t) => h('button', {
        key: t.taskId, type: 'button', className: 'tk-quad-item', title: t.goal || t.taskId, onClick: () => p.onSelect(t.taskId),
      }, tasksQuadLabel(t, p.nodes)))))
    return h('div', { className: 'tk-quads' },
      quad('needs', '需要你（待批准）', q.needsYou), quad('working', '执行中', q.working),
      quad('blocked', '中断 · 失败', q.blocked), quad('done', '最近完成', q.done))
  }

  function Tickets(p) {
    const rows = tasksAttentionRows(p.tickets)
    if (rows.length === 0) return null
    return h(Fold, { title: tasksTicketText.title, badge: rows.length, open: rows.some((r) => r.stage === 'person') },
      h('div', { className: 'tk-ios' }, rows.map((r) => h('div', { key: r.ticket.ticketId, className: 'tk-ios-row' },
        h('span', { className: 'dra-mono' }, r.ticket.ticketId),
        h(Badge, { tone: r.stage === 'person' ? 'warn' : '' }, tasksTicketLabel(r)),
        h('span', { className: 'dra-hint' }, r.ticket.hasExecutor === true ? tasksTicketText.withExecutor : tasksTicketText.withoutExecutor)))))
  }

  /* 进度槽：没有百分比，所以是「不确定」进度——只有运行中的任务有，带扫光；停滞时不扫光、变琥珀。 */
  function Track(p) {
    const t = p.task
    if (!t || t.status !== 'running') return null
    const stalled = tasksStallLabel(t) !== ''
    return h('span', {
      className: 'tk-track' + (stalled ? ' stalled' : ''), role: 'progressbar', 'aria-label': '任务进行中（不确定进度）', 'aria-valuetext': tasksProgressLine(t) || (stalled ? '运行中，暂无更新' : '运行中'),
    }, h('span', { className: 'tk-track-fill' + (stalled ? '' : ' dra-shimmer') }))
  }

  /* 任务行：整行主体是一个按钮（键盘可达），动作按钮是它的兄弟，不嵌套。 */
  function TaskRow(p) {
    const t = p.task
    const active = tasksIsActive(t.status)
    const dur = tasksDuration(t, p.now)
    const line = tasksProgressLine(t)
    const ev = tasksCancelEvidenceLabel(t)
    const stall = tasksStallLabel(t)
    const busy = (a) => p.busyKeys[a + ':' + t.taskId] === true
    const act = (a, label, busyLabel, cls) => h('button', {
      key: a, type: 'button', className: 'dra-btn sm' + (cls ? ' ' + cls : ''), disabled: busy(a), onClick: () => p.onAct(t.taskId, a),
    }, busy(a) ? busyLabel : label)
    const tone = t.status === 'running' && !stall ? ' dra-live' : ' tk-calm' + (t.status === 'pending_approval' ? ' tk-raised' : '')
    return h('li', { className: 'tk-row' + tone + (p.selected ? ' sel' : '') },
      h('button', { type: 'button', className: 'tk-row-main', 'aria-current': p.selected ? 'true' : undefined, onClick: () => p.onSelect(t.taskId) },
        h('span', { className: 'tk-row-title' },
          h('span', { className: 'tk-goal', title: t.goal }, t.goal || '(无目标)'),
          h(Badge, { tone: tasksStatusTone(t.status) }, tasksStatusText(t.status)),
          t.mode ? h(Badge, null, t.mode) : null),
        h('span', { className: 'tk-row-sub' },
          h('span', { className: 'dra-mono' }, coreShortId(t.taskId)),
          h('span', null, tasksNodeName(p.nodes, t.nodeId)),
          h('span', { className: 'tk-dur' }, (active ? '已跑 ' : '耗时 ') + coreFmtDur(dur)),
          h('span', { className: 'tk-dur' }, coreFmtTime(t.updatedAt || t.createdAt)),
          t.changedCount ? h('span', null, '改动 ' + t.changedCount) : null),
        line ? h('span', { className: 'tk-row-line', title: line }, '最近：' + line) : null,
        ev ? h('span', { className: 'dra-hint' }, ev) : null,
        stall ? h('span', { className: 'dra-hint tk-stall' }, stall) : null),
      h('div', { className: 'tk-row-acts' },
        active ? act('cancel', '取消', '取消中…') : null,
        t.status === 'pending_approval' ? act('approve', '批准', '批准中…', 'tk-approve') : null,
        t.status === 'pending_approval' ? act('reject', '拒绝', '拒绝中…', 'danger tk-reject') : null,
        t.status === 'completed' ? act('pull', '拉取', '拉取中…') : null),
      h(Track, { task: t }))
  }

  function TaskList(p) {
    const g = tasksGroups(p.tasks, p.filter)
    const counts = tasksCounts(p.tasks)
    const rowOf = (t) => h(TaskRow, {
      key: t.taskId, task: t, nodes: p.nodes, now: p.now, busyKeys: p.busyKeys, selected: p.selected === t.taskId, onSelect: p.onSelect, onAct: p.onAct,
    })
    const body = []
    if (p.tasks.length === 0) {
      body.push(h('li', { key: 'none' }, h(Empty, null, p.loading ? '读取任务…' : '还没有任务。在上面写一个目标并派发。')))
    } else if (g.total === 0) {
      body.push(h('li', { key: 'none' }, h(Empty, null, p.filter === 'active' ? '当前没有进行中的任务' : '没有匹配的任务')))
    } else {
      if (g.active.length) {
        if (g.labelled) body.push(h('li', { key: 'g-a', className: 'tk-group', role: 'presentation' }, '进行中（' + g.active.length + '）'))
        g.active.forEach((t) => body.push(rowOf(t)))
      }
      if (g.history.length) {
        if (g.labelled) body.push(h('li', { key: 'g-h', className: 'tk-group', role: 'presentation' }, '历史（' + g.history.length + '）'))
        g.history.forEach((t) => body.push(rowOf(t)))
      }
    }
    const nums = { all: counts.all, active: counts.active, done: counts.done, failed: counts.failed }
    return h(Card, {
      title: '任务', sub: counts.all + ' 条（最近 200 条）',
      actions: [
        h(Seg, { key: 'seg', label: '任务筛选', value: p.filter, onChange: p.onFilter, options: tasksFilterDefs.map((d) => [d[0], d[1] + ' ' + nums[d[0]]]) }),
        h('button', {
          key: 'purge', type: 'button', className: 'dra-btn sm danger', disabled: p.purgeBusy || counts.all === counts.active,
          title: '只清已结束的任务记录，进行中的保留', onClick: p.onPurge,
        }, p.purgeBusy ? '清理中…' : '清理历史任务'),
      ],
    }, h('ul', { className: 'tk-list' }, body))
  }

  /* 详情：轮询刷新时保留上一次的内容，不闪、不收起。 */
  function Detail(p) {
    const d = p.detail
    const head = (t) => h('div', { className: 'dra-row' },
      h('h4', { className: 'dra-card-title' }, '任务详情'),
      t ? h(Badge, { tone: tasksStatusTone(t.status) }, tasksStatusText(t.status)) : null,
      h('span', { className: 'dra-spacer' }),
      h('button', { type: 'button', className: 'dra-btn sm', onClick: p.onClose }, '收起'))
    const shell = (t, children) => h('section', { className: 'dra-card tk-detail dra-pop', 'aria-label': '任务详情', tabIndex: -1, ref: p.detailRef },
      h('div', { className: 'dra-card-head' }, head(t)),
      h('div', { className: 'dra-card-body' }, children))

    if (!d || d.id !== p.selected || (!d.task && !d.error)) return shell(null, h('div', { className: 'dra-hint', role: 'status' }, '读取任务详情…'))
    if (!d.task) return shell(null, h(Banner, { tone: 'err', title: '读不到这条任务' }, d.error))

    const t = d.task
    const handoff = d.handoff
    const finals = tasksFinals(handoff)
    const pull = tasksPullState(p.caps)
    const busy = (a) => p.busyKeys[a + ':' + t.taskId] === true
    const active = tasksIsActive(t.status)
    const dur = tasksDuration(t, p.now)
    const ev = tasksCancelEvidenceLabel(t)
    const stall = tasksStallLabel(t)
    const summary = (handoff && handoff.summaryText) || t.summaryText
    const changed = Array.isArray(t.changed) ? t.changed : []
    const progress = Array.isArray(t.progressTail) ? t.progressTail : []
    const logs = Array.isArray(t.logTail) ? t.logTail : []
    const diffs = handoff && Array.isArray(handoff.diffs) ? handoff.diffs : []
    const art = handoff && handoff.artifacts
    const pullBtn = (label, paths, key) => h('button', {
      key: key || 'pull', type: 'button', className: 'dra-btn sm', disabled: !pull.enabled || busy('pull'), title: pull.enabled ? '' : pull.reason,
      onClick: () => p.onAct(t.taskId, 'pull', paths),
    }, busy('pull') ? '拉取中…' : label)

    return shell(t, [
      d.error ? h('div', { key: 'stale', className: 'dra-hint dra-warn', role: 'status' }, '刷新失败：' + d.error + '（下面是上一次读到的内容）') : null,
      h(Track, { key: 'track', task: t }),
      h('dl', { key: 'kv', className: 'dra-kv' },
        h('dt', null, '任务 ID'), h('dd', { className: 'dra-mono' }, t.taskId),
        h('dt', null, '机器'), h('dd', null, tasksNodeName(p.nodes, t.nodeId) + (active && t.nodeOnline === false ? '（当前离线）' : ''), ' ', h('span', { className: 'dra-mono dra-hint' }, coreShortId(t.nodeId, 16))),
        h('dt', null, '模式'), h('dd', null, (t.mode || '—') + (t.approval === 'manual' ? ' · 需审批' : '')),
        h('dt', null, '创建'), h('dd', { className: 'tk-dur' }, coreFmtTime(t.createdAt)),
        h('dt', null, '开始'), h('dd', { className: 'tk-dur' }, coreFmtTime(t.startedAt)),
        h('dt', null, '结束'), h('dd', { className: 'tk-dur' }, coreFmtTime(t.endedAt)),
        h('dt', null, active ? '已跑' : '耗时'), h('dd', { className: 'tk-dur' }, coreFmtDur(dur)),
        t.exit ? h('dt', null, '退出码') : null,
        t.exit ? h('dd', { className: 'dra-mono' }, String(t.exit.code) + (t.exit.code === 0 ? '（成功）' : '（非 0）') + (t.exit.timedOut ? ' · 超时' : '') + (t.exit.aborted ? ' · 中止' : '')) : null,
        ev ? h('dt', null, '取消证据') : null, ev ? h('dd', null, ev) : null,
        stall ? h('dt', null, '停滞提示') : null, stall ? h('dd', null, stall) : null,
        t.error ? h('dt', null, '错误') : null,
        t.error ? h('dd', { className: 'dra-danger dra-wrap' }, ((t.error.code || '') + ' ' + (t.error.message || '')).trim()) : null),
      h('div', { key: 'goal-h', className: 'tk-sec' }, '目标'),
      h('div', { key: 'goal', className: 'tk-pre' }, t.goal || '(无目标)'),
      h('div', { key: 'acts', className: 'tk-detail-acts' },
        active ? h('button', { type: 'button', className: 'dra-btn sm', disabled: busy('cancel'), onClick: () => p.onAct(t.taskId, 'cancel') }, busy('cancel') ? '取消中…' : '取消任务') : null,
        t.status === 'pending_approval' ? h('button', { type: 'button', className: 'dra-btn sm tk-approve', disabled: busy('approve'), onClick: () => p.onAct(t.taskId, 'approve') }, busy('approve') ? '批准中…' : '批准') : null,
        t.status === 'pending_approval' ? h('button', { type: 'button', className: 'dra-btn sm danger tk-reject', disabled: busy('reject'), onClick: () => p.onAct(t.taskId, 'reject') }, busy('reject') ? '拒绝中…' : '拒绝') : null,
        finals.length ? pullBtn('拉取全部成品（' + finals.length + '）', undefined, 'pull-all') : null),
      finals.length && !pull.enabled ? h('div', { key: 'nopull', className: 'dra-hint dra-warn' }, pull.reason) : null,
      summary ? h('div', { key: 'sum-h', className: 'tk-sec' }, '摘要') : null,
      summary ? h('div', { key: 'sum', className: 'tk-pre' }, summary) : null,
      finals.length ? h('div', { key: 'fin-h', className: 'tk-sec' }, '成品（' + finals.length + '）' + (art && art.bytesFinal ? ' · ' + coreFmtBytes(art.bytesFinal) : '')) : null,
      finals.map((f) => h('div', { key: 'f:' + f.path, className: 'tk-final' },
        h('span', { className: 'tk-final-path' }, f.path),
        h('span', { className: 'tk-final-meta' }, coreFmtBytes(f.bytes)),
        pullBtn('拉取', [f.path], 'p:' + f.path))),
      art && art.counts ? h('div', { key: 'art', className: 'dra-hint' }, '产物：共 ' + art.counts.total + '（成品 ' + art.counts.final + '，中间 ' + art.counts.intermediate + '）。只有成品可以拉取，中间产物留在副机。') : null,
      !handoff && !active && t.status === 'completed' ? h('div', { key: 'nohand', className: 'dra-hint' }, '节点没有回传交接卡，没有可拉的成品。') : null,
      handoff && finals.length === 0 && !active ? h('div', { key: 'nofinal', className: 'dra-hint' }, '该任务没有成品可拉。') : null,
      changed.length ? h('div', { key: 'chg-h', className: 'tk-sec' }, '改动（' + (t.changedCount || changed.length) + '）') : null,
      changed.length ? h('div', { key: 'chg', className: 'tk-pre' }, changed.map(tasksChangedLine).join('\n')) : null,
      diffs.map((x) => h(Fold, { key: 'd:' + x.path, title: '差异 ' + x.path, badge: x.truncated ? '已截断' : undefined }, h('pre', { className: 'tk-pre' }, x.diff))),
      progress.length ? h('div', { key: 'prog-h', className: 'tk-sec' }, '进度') : null,
      progress.length ? h('div', { key: 'prog', className: 'tk-pre' }, progress.map(tasksProgressItemLine).join('\n')) : null,
      logs.length ? h('div', { key: 'log-h', className: 'tk-sec' }, '日志（尾）') : null,
      logs.length ? h('div', { key: 'log', className: 'tk-pre' }, logs.join('\n')) : null,
    ])
  }

  /* 派发表单：所有输入都由父级的 state 驱动，轮询重绘不会重置它。 */
  function Dispatch(p) {
    const f = p.form
    const nodes = p.nodes
    const online = nodes.filter((n) => n.online === true)
    const picked = nodes.filter((n) => n.nodeId === f.node)[0] || null
    const models = tasksModelOptions(nodes, f.node)
    const hasList = models.options.length > 0
    const isCustom = p.modelCustom || (!!f.model && hasList && !models.options.some((o) => o.key === f.model))
    const problem = p.loading ? '' : tasksDispatchProblem(f, nodes)
    const tpl = p.tpl
    const atMax = tpl.max > 0 && tpl.list.length >= tpl.max && !f.templateId
    const roots = picked && Array.isArray(picked.roots) ? picked.roots : []
    const set = (k) => (e) => p.onForm({ [k]: e.target.value })
    const nodeLabel = (n) => tasksNodeName(nodes, n.nodeId) + (n.os && n.os !== 'unknown' ? ' · ' + n.os : '')

    const tplHints = [
      tpl.max > 0 && tpl.list.length >= tpl.max ? h('span', { key: 'max', className: 'dra-hint' }, '模板已达上限 ' + tpl.max + ' 条') : null,
      tpl.degraded ? h('span', { key: 'deg', className: 'dra-hint dra-warn' }, '模板文件读不出来（' + (tpl.reason || 'unknown') + '）') : null,
      tpl.error ? h('span', { key: 'err', className: 'dra-hint dra-warn' }, '模板库不可用：' + tpl.error) : null,
      p.tplMsg ? h('span', { key: 'msg', className: 'dra-hint', role: 'status' }, p.tplMsg) : null,
    ].filter(Boolean)

    return h(Card, { className: 'tk-dispatch', title: '派发任务', sub: '主机 → 选中的机器，由那台机器在本地执行' },
      h('div', { className: 'tk-tplbar' },
        h('div', { className: 'tk-tpl' },
        h(Field, { label: '模板' },
          h('select', {
            className: 'dra-select', value: f.templateId || '', disabled: p.tplBusy, title: tpl.file ? '模板存于 ' + tpl.file : '',
            onChange: (e) => p.onTplApply(e.target.value),
          },
          h('option', { value: '' }, tpl.loading ? '读取中…' : tpl.list.length === 0 ? '（还没有，可把当前表单存下来）' : '选一个一键填充'),
          tpl.list.map((t) => h('option', { key: t.id, value: t.id }, tasksTemplateOptionLabel(t))))),
        h('div', { className: 'tk-tpl-btns' },
          h('button', {
            type: 'button', className: 'dra-btn sm', disabled: p.tplBusy || p.dispatching || !f.goal.trim() || !!tpl.error || atMax,
            title: tpl.error ? '模板库不可读' : atMax ? '模板已达上限，先删一条' : '把当前表单内容存成模板', onClick: p.onTplSave,
          }, f.templateId ? '更新模板' : '存为模板'),
          h('button', {
            type: 'button', className: 'dra-btn sm', disabled: p.tplBusy || p.dispatching || !f.templateId,
            title: f.templateId ? '删除当前选中的模板' : '先在下拉框里选一条模板', onClick: p.onTplDelete,
          }, '删除模板'))),
        tplHints.length ? h('div', { className: 'dra-row tk-tpl-msg' }, tplHints) : null),
      h('div', { className: 'dra-form' },
        h(Field, { label: '目标机器' },
          h('select', { className: 'dra-select', value: f.node || '', onChange: set('node') },
            h('option', { value: '' }, nodes.length > 1 ? '请选择一台在线的机器…' : '自动（只有一台机器）'),
            online.map((n) => h('option', { key: n.nodeId, value: n.nodeId }, nodeLabel(n))),
            picked && picked.online !== true ? h('option', { key: picked.nodeId, value: picked.nodeId }, nodeLabel(picked) + '（已离线）') : null)),
        h(Field, { label: '执行模式' },
          h('select', { className: 'dra-select', value: f.mode || 'agent', onChange: set('mode') },
            h('option', { value: 'agent' }, 'agent · 新开独立会话'),
            h('option', { value: 'exec' }, 'exec · 直接执行命令'))),
        h(Field, { label: '任务目标（必填）', wide: true },
          h('textarea', {
            className: 'dra-textarea', value: f.goal, placeholder: '例如：运行测试并修复失败的用例；或执行 npm run build 并汇报结果', onChange: set('goal'),
          }))),
      h('div', { className: 'tk-adv' },
        h(Fold, { title: '高级选项' },
          h('div', { className: 'dra-form' },
            h(Field, { label: '工作区（副机 roots 内）', hint: '留空 = 副机默认工作区' },
              h('input', {
                className: 'dra-input dra-mono', value: f.workspace, list: 'tk-ws-list', onChange: set('workspace'),
                placeholder: roots[0] || '副机默认工作区',
              }),
              h('datalist', { id: 'tk-ws-list' }, roots.map((r) => h('option', { key: r, value: r })))),
            h(Field, {
              label: '模型',
              hint: !models.reported ? '这台机器没有上报模型清单，请手动填 provider/model' : !hasList ? '这台机器上报的模型清单是空的，可以手动填' : '',
            },
            hasList ? h('select', {
              className: 'dra-select', value: isCustom ? '__custom__' : (f.model || ''),
              onChange: (e) => {
                const v = e.target.value
                if (v === '__custom__') { p.onModelCustom(true); p.onForm({ model: '' }) } else { p.onModelCustom(false); p.onForm({ model: v }) }
              },
            },
            h('option', { value: '' }, '跟随副机默认' + (models.defaultLabel ? '（' + models.defaultLabel + '）' : '')),
            models.options.map((o) => h('option', { key: o.key, value: o.key }, o.label)),
            h('option', { value: '__custom__' }, '自定义模型…'))
              : h('input', {
                className: 'dra-input dra-mono', value: f.model, placeholder: 'provider/model 或 model',
                onChange: (e) => { p.onModelCustom(true); p.onForm({ model: e.target.value }) },
              }),
            hasList && isCustom ? h('input', {
              className: 'dra-input dra-mono', value: f.model, placeholder: 'provider/model 或 model', 'aria-label': '自定义模型', onChange: set('model'),
            }) : null),
            h(Field, { label: '产出 glob（逗号或换行分隔）' },
              h('input', { className: 'dra-input dra-mono', value: f.outputs, placeholder: 'dist/**, *.md', onChange: set('outputs') })),
            h(Field, { label: '超时（毫秒）', hint: '留空 = 用默认值' },
              h('input', { className: 'dra-input dra-mono', value: f.timeoutMs, inputMode: 'numeric', placeholder: '600000', onChange: set('timeoutMs') })),
            h('label', { className: 'dra-check', style: { gridColumn: '1 / -1' } },
              h('input', { type: 'checkbox', checked: f.needApproval === true, onChange: (e) => p.onForm({ needApproval: e.target.checked }) }),
              '需要先审批再派给副机')))),
      h('div', { className: 'tk-form-actions' },
        h('button', {
          type: 'button', className: 'dra-btn primary tk-submit' + (p.dispatching ? ' dra-shimmer' : ''), disabled: p.dispatching || !!problem, 'aria-describedby': problem ? 'tk-problem' : undefined, onClick: p.onDispatch,
        }, p.dispatching ? '派发中…' : '派发任务'),
        problem ? h('span', { id: 'tk-problem', className: 'dra-hint dra-warn' }, problem) : null,
        problem && online.length === 0 ? h('button', { type: 'button', className: 'dra-btn sm', onClick: () => p.go('machines') }, '去「机器」看看') : null),
      h('div', { className: 'dra-hint tk-form-note' }, 'agent = 在副机新开独立会话；exec = 直接执行命令。两条路径都由副机本地执行。'))
  }

  /* 分配台账：只读。折叠区自己管开合（要知道何时第一次打开才去拉），节点筛选是 Screen 的 state，轮询不重置。 */
  const noopLedger = () => {}

  function Ledger(p) {
    const l = p.ledger
    const rows = tasksLedgerRows(l.items, p.tasks, p.nodes)
    const shown = tasksLedgerFilter(rows, p.node)
    const stage = tasksLedgerStage(l, rows, shown)
    const options = tasksLedgerNodes(rows, p.nodes)
    let body
    if (stage === 'loading') body = h('div', { className: 'dra-hint', role: 'status' }, '读取台账…')
    else if (stage === 'error') {
      body = h(Banner, { tone: 'err', title: '读不到台账', actions: h('button', { type: 'button', className: 'dra-btn sm', onClick: p.onRetry }, '重试') }, l.error)
    } else if (stage === 'unavailable') body = h(Banner, { title: tasksLedgerText.unavailable })
    else if (stage === 'empty') body = h(Empty, null, p.node && rows.length ? tasksLedgerText.emptyNode : tasksLedgerText.empty)
    else {
      body = h('ul', { className: 'tk-led-list' }, shown.map((r) => h('li', { key: r.taskId, className: 'tk-led-row' },
        h('span', { className: 'tk-led-dot ' + r.tone, 'aria-hidden': 'true' }),
        h('div', { className: 'tk-led-body' },
          h(Badge, { tone: r.tone }, r.statusText),
          h('span', { className: 'tk-led-meta' },
            h('span', { className: 'tk-dur' }, coreFmtTime(r.at)),
            h('span', null, r.nodeName),
            h('span', { className: 'dra-mono', title: r.taskId }, r.shortId),
            h(CopyBtn, { text: r.taskId, title: '复制任务 ID' }),
            r.durationMs !== null ? h('span', { className: 'tk-dur' }, '耗时 ' + coreFmtDur(r.durationMs)) : null,
            r.older > 0 ? h('span', null, '另有 ' + r.older + ' 条更早记录') : null),
          r.exists
            ? h('button', { type: 'button', className: 'dra-btn sm', onClick: () => p.onSelect(r.taskId) }, '看详情')
            : h('span', { className: 'dra-hint' }, tasksLedgerText.gone),
          r.goal ? h('span', { className: 'tk-led-goal', title: r.goal }, r.goal) : null))))
    }
    return h('details', { className: 'dra-fold', open: l.open, onToggle: (e) => p.onToggle(e.target.open === true) },
      h('summary', { className: 'dra-fold-sum' }, h('span', null, tasksLedgerText.title),
        l.loaded && !l.unavailable ? h('span', { className: 'dra-fold-badge' }, rows.length) : null),
      h('div', { className: 'dra-fold-body' },
        h('div', { className: 'dra-hint' }, '谁把什么任务派给了哪台机器、最后什么状态。只读；清理历史任务和重启都不会删除台账（配置了状态目录时落盘）。'),
        l.open && (rows.length > 0 || options.length > 0) ? h('div', { className: 'tk-led-bar' },
          h(Field, { label: '按机器筛选' },
            h('select', { className: 'dra-select', value: p.node, onChange: (e) => p.onNode(e.target.value) },
              h('option', { value: '' }, '全部机器'),
              options.map((o) => h('option', { key: o.id, value: o.id }, o.label))))) : null,
        l.open && l.error && rows.length > 0 ? h('div', { className: 'dra-hint dra-warn', role: 'status' }, '刷新失败：' + l.error + '（下面是上一次读到的内容）') : null,
        l.open ? body : null))
  }

  /** 整屏视图：无状态，所有状态和动作由 Screen 传入（测试直接渲染它）。 */
  function TasksView(p) {
    const hub = p.hub
    const nodes = Array.isArray(hub.nodes) ? hub.nodes : []
    const tasks = Array.isArray(hub.tasks) ? hub.tasks : []
    const counts = tasksCounts(tasks)
    const online = nodes.filter((n) => n.online === true).length
    const attention = tasksAttentionRows(hub.tickets)
    const showAttention = tasks.length > 0 || attention.length > 0
    return h('div', { className: 'tk' },
      p.note ? h('div', { key: 'note', className: 'tk-note' },
        h(Banner, { tone: p.note.tone, title: p.note.text, actions: h('button', { type: 'button', className: 'dra-btn sm', onClick: p.onNoteClose }, '知道了') })) : null,
      !hub.loading && online === 0 ? h(Banner, {
        key: 'nonode', title: nodes.length === 0 ? '还没有机器接入，现在无法派发任务' : '所有机器都离线，现在无法派发任务',
        actions: h('button', { type: 'button', className: 'dra-btn sm', onClick: () => p.go('machines') }, '去「机器」'),
      }, nodes.length === 0 ? '先在「机器」里接入一台副机，任务才有地方执行。' : '等机器重新上线后再派发；已有任务的记录仍可在下面查看。') : null,
      h('div', { key: 'stats', className: 'dra-statbar' },
        h(Stat, { tone: 'acc', value: counts.active, label: '进行中' }),
        h(Stat, { tone: counts.pending ? 'warn' : '', value: counts.pending, label: '待批准' }),
        h(Stat, { tone: 'ok', value: counts.done, label: '已完成' }),
        h(Stat, { tone: counts.failed ? 'bad' : '', value: counts.failed, label: '失败·中止·拒绝' })),
      showAttention ? h(Card, { key: 'attn', title: '需要你处理', sub: '待批准的任务、中断或失败的任务、待处理的工单' },
        h('div', { className: 'dra-col tk-attn' }, h(Quadrants, { tasks, nodes, onSelect: p.onSelect }), h(Tickets, { tickets: hub.tickets }))) : null,
      h(Dispatch, {
        key: 'dispatch', nodes, loading: hub.loading === true, form: p.form, onForm: p.onForm, modelCustom: p.modelCustom, onModelCustom: p.onModelCustom,
        dispatching: p.dispatching, onDispatch: p.onDispatch, tpl: p.tpl, tplMsg: p.tplMsg, tplBusy: p.tplBusy,
        onTplApply: p.onTplApply, onTplSave: p.onTplSave, onTplDelete: p.onTplDelete, go: p.go,
      }),
      h('div', { key: 'split', className: 'tk-split' },
        h(TaskList, {
          tasks, nodes, now: p.now, filter: p.filter, onFilter: p.onFilter, loading: hub.loading === true, purgeBusy: p.purgeBusy, onPurge: p.onPurge,
          busyKeys: p.busyKeys, selected: p.selected, onSelect: p.onSelect, onAct: p.onAct,
        }),
        p.selected ? h('div', { key: p.selected, className: 'tk-detail-col' }, h(Detail, {
          detail: p.detail, selected: p.selected, nodes, now: p.now, caps: hub.caps, busyKeys: p.busyKeys, onClose: p.onClose, onAct: p.onAct, detailRef: p.detailRef,
        })) : null),
      h(Ledger, {
        key: 'ledger', ledger: p.ledger || tasksLedgerNew(), node: p.ledgerNode || '', tasks, nodes, onToggle: p.onLedgerToggle || noopLedger, onNode: p.onLedgerNode || noopLedger, onRetry: p.onLedgerRetry || noopLedger, onSelect: p.onSelect,
      }))
  }

  function Screen(props) {
    /* 所有 hook 在任何条件 return 之前；表单、选中项、详情都是本组件的 state，轮询重绘不会动它们。 */
    const hub = props.hub
    const ui = props.ui
    const nodes = Array.isArray(hub.nodes) ? hub.nodes : []
    const [form, setForm] = React.useState(tasksNewForm)
    const [modelCustom, setModelCustom] = React.useState(false)
    const [dispatching, setDispatching] = React.useState(false)
    const [note, setNote] = React.useState(null)
    const [tpl, setTpl] = React.useState({ loading: true, list: [], max: 0, degraded: false, reason: '', file: '', error: '' })
    const [tplMsg, setTplMsg] = React.useState('')
    const [tplBusy, setTplBusy] = React.useState(false)
    const [filter, setFilter] = React.useState('all')
    const [selected, setSelected] = React.useState('')
    const [detail, setDetail] = React.useState(null)
    const [purgeBusy, setPurgeBusy] = React.useState(false)
    const [busyKeys, setBusyKeys] = React.useState({})
    const [ledger, setLedger] = React.useState(tasksLedgerNew)
    const [ledgerNode, setLedgerNode] = React.useState('')
    const guard = React.useRef({})
    const detailSeq = React.useRef(0)
    const detailBusy = React.useRef('')
    const detailRef = React.useRef(null)
    const ledgerBusy = React.useRef(false)

    const say = (text, tone) => setNote({ text, tone: tone === undefined ? 'ok' : tone })
    const patchForm = (patch) => setForm((f) => Object.assign({}, f, patch))
    const begin = (key) => {
      if (guard.current[key]) return false
      guard.current[key] = true
      setBusyKeys((b) => Object.assign({}, b, { [key]: true }))
      return true
    }
    const end = (key) => {
      delete guard.current[key]
      setBusyKeys((b) => { const n = Object.assign({}, b); delete n[key]; return n })
    }

    /* 模板库只在自己的请求里拉（不进 3 秒轮询，否则正在编辑的下拉框会被重建）。 */
    const loadTemplates = () => api.get('/templates').then((d) => {
      setTpl({
        loading: false, list: (d && d.templates) || [], max: (d && d.max) || 0, degraded: !!(d && d.degraded), reason: (d && d.reason) || '', file: (d && d.file) || '', error: '',
      })
    }, (e) => { setTpl((t) => Object.assign({}, t, { loading: false, error: tasksErr(e) })) })
    React.useEffect(() => { loadTemplates() }, [])

    /* 详情：选中项或快照 tick 变了就重读；上一次还在飞就不再叠一个；失败时保留旧内容。 */
    React.useEffect(() => {
      if (!selected) { detailSeq.current += 1; detailBusy.current = ''; setDetail(null); return }
      if (detailBusy.current === selected) return
      detailBusy.current = selected
      detailSeq.current += 1
      const seq = detailSeq.current
      api.get('/task?taskId=' + encodeURIComponent(selected)).then(
        (d) => { if (seq === detailSeq.current) setDetail({ id: selected, task: (d && d.task) || null, handoff: (d && d.handoff) || null, error: '' }) },
        (e) => {
          if (seq !== detailSeq.current) return
          setDetail((prev) => (prev && prev.id === selected && prev.task ? Object.assign({}, prev, { error: tasksErr(e) }) : { id: selected, task: null, handoff: null, error: tasksErr(e) }))
        }).then(() => { if (seq === detailSeq.current) detailBusy.current = '' })
    }, [selected, hub.tick])

    /* 台账：第一次打开才拉；只在打开期间随快照 tick 刷新；上一次还在飞就不叠；失败时保留旧内容。 */
    const loadLedger = () => {
      if (ledgerBusy.current) return
      ledgerBusy.current = true
      setLedger((l) => Object.assign({}, l, { loading: !l.loaded }))
      api.get('/assignments?limit=200').then(
        (d) => setLedger((l) => (d && Array.isArray(d.assignments)
          ? Object.assign({}, l, { loaded: true, loading: false, error: '', unavailable: false, items: d.assignments })
          : Object.assign({}, l, { loaded: true, loading: false, error: '', unavailable: true, items: [] }))),
        (e) => setLedger((l) => Object.assign({}, l, { loading: false, error: tasksErr(e) }))).then(() => { ledgerBusy.current = false })
    }
    React.useEffect(() => { if (ledger.open) loadLedger() }, [ledger.open, hub.tick])

    const select = (taskId) => {
      setSelected(taskId)
      globalThis.setTimeout(() => {
        const el = detailRef.current
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
        if (el && el.focus) el.focus({ preventScroll: true })
      }, 0)
    }

    const dispatch = () => {
      const built = tasksDispatchBody(form)
      if (!built.ok) { say(built.error, ''); return }
      const problem = hub.loading ? '' : tasksDispatchProblem(form, nodes)
      if (problem) { say(problem, ''); return }
      if (!begin('dispatch')) return
      setDispatching(true)
      setNote(null)
      api.post('/dispatch', built.body).then((d) => {
        if (d && d.ok === false) throw new Error(d.error || 'dispatch-failed')
        say('已派发给 ' + tasksNodeName(nodes, d && d.nodeId) + '（' + coreShortId(d && d.taskId) + '）' + (d && d.approval === 'manual' ? '，已挂起，等你批准后才会开始' : ''))
        patchForm({ goal: '' })
        props.refresh()
      }).catch((e) => say('派发失败：' + tasksErr(e), 'err')).then(() => { end('dispatch'); setDispatching(false) })
    }

    const applyTemplate = (id) => {
      setTplMsg('')
      const t = tpl.list.filter((x) => x.id === id)[0]
      if (!t) { patchForm({ templateId: '' }); return }
      setForm((f) => tasksFormFromTemplate(t, f))
      setModelCustom(false)
      setTplMsg('已填充模板「' + t.name + '」')
    }

    const saveTemplate = () => {
      if (!form.goal.trim()) { setTplMsg('先填任务目标，再存为模板'); return }
      if (tplBusy) return
      ui.prompt('模板名（之后在下拉框里选它）', form.goal.trim().split('\n')[0].slice(0, 30)).then((name) => {
        if (name === null) return null
        if (String(name).trim() === '') { setTplMsg('模板名不能为空'); return null }
        const built = tasksTemplateBody(form, name)
        if (!built.ok) { setTplMsg(built.error); return null }
        setTplBusy(true)
        setTplMsg('保存中…')
        return api.post('/templates/save', built.body).then((r) => {
          const t = (r && r.template) || {}
          patchForm({ templateId: t.id || '' })
          setTplMsg((r && r.updated ? '已更新模板「' : '已保存模板「') + (t.name || '') + '」')
          return loadTemplates()
        }).catch((e) => setTplMsg('保存失败：' + tasksErr(e))).then(() => setTplBusy(false))
      })
    }

    const deleteTemplate = () => {
      const id = form.templateId
      if (!id) { setTplMsg('先在下拉框里选中一条模板'); return }
      if (tplBusy) return
      const t = tpl.list.filter((x) => x.id === id)[0]
      ui.confirm('删除模板「' + ((t && t.name) || id) + '」？只删这条预设，不影响已派出的任务。').then((ok) => {
        if (!ok) return null
        setTplBusy(true)
        setTplMsg('删除中…')
        return api.post('/templates/delete', { id }).then(() => {
          patchForm({ templateId: '' })
          setTplMsg('已删除模板')
          return loadTemplates()
        }).catch((e) => setTplMsg('删除失败：' + tasksErr(e))).then(() => setTplBusy(false))
      })
    }

    const purge = () => {
      if (purgeBusy) return
      ui.confirm('清理已结束的历史任务？运行中的任务会保留。').then((ok) => {
        if (!ok) return null
        setPurgeBusy(true)
        return api.post('/purge', { includeActive: false }).then((d) => {
          say('已清理 ' + (d && d.removed != null ? d.removed : '') + ' 条历史任务（运行中的保留）')
          props.refresh()
        }).catch((e) => say('清理失败：' + tasksErr(e), 'err')).then(() => setPurgeBusy(false))
      })
    }

    /* 拉取：paths 缺省 = 这条任务的全部成品（行上的「拉取」按钮要先读一次详情才知道有哪些）。 */
    const pullTask = (taskId, paths) => {
      const state = tasksPullState(hub.caps)
      if (!state.enabled) { say(state.reason, ''); return }
      const key = 'pull:' + taskId
      if (!begin(key)) return
      const known = paths && paths.length ? Promise.resolve(paths)
        : detail && detail.id === taskId && detail.handoff ? Promise.resolve(tasksFinalPaths(detail.handoff))
          : api.get('/task?taskId=' + encodeURIComponent(taskId)).then((d) => tasksFinalPaths(d && d.handoff))
      known.then((list) => {
        if (!list.length) { say('该任务没有可拉的成品文件', ''); return null }
        return ui.prompt(tasksPullPrompt(state.root), '').then((dest) => {
          if (dest === null) return null
          return api.post('/pull', tasksPullBody(taskId, list, dest)).then((resp) => { const s = tasksPullSummary(resp, list); say(s.text, s.tone) })
        })
      }).catch((e) => say('拉取失败：' + tasksErr(e), 'err')).then(() => end(key))
    }

    const act = (taskId, action, paths) => {
      if (action === 'pull') { pullTask(taskId, paths); return }
      const key = action + ':' + taskId
      if (action === 'cancel') {
        const before = (hub.tasks || []).filter((x) => x && x.taskId === taskId)[0] || (detail && detail.task && detail.task.taskId === taskId ? detail.task : null)
        if (!begin(key)) return
        api.post('/cancel', { taskId }).then((resp) => {
          const r = tasksCancelReceipt({ response: resp, before })
          say(r.text, r.kind === 'notDelivered' ? '' : 'ok')
          props.refresh()
        }).catch((e) => say('取消失败：' + tasksErr(e), 'err')).then(() => end(key))
        return
      }
      if (action === 'approve' || action === 'reject') {
        if (!begin(key)) return
        api.post('/' + action, { taskId }).then(() => {
          say(action === 'approve' ? '已批准，任务开始派给机器' : '已拒绝这条任务')
          props.refresh()
        }).catch((e) => say((action === 'approve' ? '批准失败：' : '拒绝失败：') + tasksErr(e), 'err')).then(() => end(key))
      }
    }

    return h(TasksView, {
      hub, now: Date.now(), go: props.go, note, onNoteClose: () => setNote(null),
      form, onForm: patchForm, modelCustom, onModelCustom: setModelCustom, dispatching, onDispatch: dispatch,
      tpl, tplMsg, tplBusy, onTplApply: applyTemplate, onTplSave: saveTemplate, onTplDelete: deleteTemplate,
      filter, onFilter: setFilter, purgeBusy, onPurge: purge,
      selected, detail, detailRef, busyKeys, onSelect: select, onClose: () => setSelected(''), onAct: act,
      ledger, ledgerNode, onLedgerToggle: (open) => setLedger((l) => Object.assign({}, l, { open })), onLedgerNode: setLedgerNode, onLedgerRetry: loadLedger,
    })
  }

  return { css, Screen, parts: { TasksView, TaskRow, TaskList, Detail, Dispatch, Quadrants, Tickets, Ledger } }
}
