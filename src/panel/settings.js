/**
 * 设置模块：首次配置向导（含换角色）、副机视图、设置抽屉（连接配置 / 环境体检 / 通道与审计）。
 * 顶层标识符一律以 `settings` 开头；对外只导出 createSettings(core)。纯函数全部导出，测试直接 import。
 * 构建脚本会去掉 import/export 并把所有屏拼进同一个闭包，所以这里不能出现不带前缀的顶层名字。
 *
 * 写盘只有一条路：POST /api/remote-agent/setup/apply（先备份、写后校验、重启生效）。向导与「连接配置」卡都走它，
 * 区别只是向导发整张表单、配置卡只发改过的字段（没发的字段服务端原样保留）。口令从不回显：只显示「已设置 / 未设置」，
 * 输入框留空 = 沿用旧口令。
 */
import { coreFailure, coreFmtDur, coreFmtTime } from './core.js'
import { dataSavedRole, dataSetupStatePath } from './data.js'

export const settingsApplyPath = '/api/remote-agent/setup/apply'
export const settingsRotatePath = '/api/remote-agent/setup/rotate-token'

/* ── 角色 ──────────────────────────────────────────────────────────── */

export const settingsRoleIds = ['hub', 'worker', 'both']
export const settingsRoleInfo = {
  hub: {
    label: '主机', title: '我是主机（Hub）', tagline: '派任务、管副机',
    detail: '你坐在这台机器前，要给别的机器派活、看结果。副机连到这里。',
  },
  worker: {
    label: '副机', title: '我是副机（Worker）', tagline: '等任务、回报结果',
    detail: '这台机器听另一台主机的安排，只在你指定的工作区里干活。',
  },
  both: {
    label: '同机', title: '同机自测（both）', tagline: '一台机器同时当主机和副机',
    detail: '单机体验或自测用：主机和副机都跑在这台机器上。',
  },
}

export function settingsRoleName(role) {
  const info = settingsRoleInfo[String(role || '').trim().toLowerCase()]
  return info ? info.label : '未配置'
}

/** 角色 → 表单需要哪些字段、哪些必填、标签怎么写。 */
export function settingsRolePlan(role) {
  const r = String(role || '').trim().toLowerCase()
  const valid = r === 'hub' || r === 'worker' || r === 'both'
  const worker = r === 'worker'
  return {
    role: valid ? r : '',
    valid,
    hub: r === 'hub' || r === 'both',
    worker: r === 'worker' || r === 'both',
    pair: worker,
    rootsPrimary: r === 'worker' || r === 'both',
    requireRelayUrl: worker,
    requireHubUrl: worker,
    relayUrlLabel: worker ? '中继地址（relayUrl）' : '中继地址（relayUrl）· 可选',
    hubUrlLabel: worker ? '主机地址（hubUrl）' : '本机对外地址（hubUrl）· 可留空自动推断',
    tokenLabel: worker ? '接入口令（enrollToken）' : '中继口令（hubToken）',
  }
}

/* ── 表单：默认值、校验、载荷 ─────────────────────────────────────── */

export function settingsEmptyForm() {
  return { transportMode: 'relay', relayUrl: '', hubUrl: '', token: '', nodeId: '', roots: '', listenHost: '', listenPort: '' }
}

/** 用 /setup/state 的 current 播种表单。口令永远不播种（服务端留空 = 沿用）。 */
export function settingsFormFromCurrent(cur) {
  const c = cur && typeof cur === 'object' ? cur : {}
  const s = (v) => (typeof v === 'string' ? v : '')
  return {
    transportMode: c.transportMode === 'direct' ? 'direct' : 'relay',
    relayUrl: s(c.relayUrl),
    hubUrl: s(c.hubUrl),
    token: '',
    nodeId: s(c.nodeId),
    roots: Array.isArray(c.roots) ? c.roots.filter((r) => typeof r === 'string').join('\n') : '',
    listenHost: s(c.listenHost),
    listenPort: Number.isInteger(c.listenPort) ? String(c.listenPort) : '',
  }
}

export function settingsParseRoots(text) {
  return String(text == null ? '' : text).split(/[\n,]+/).map((x) => x.trim()).filter(Boolean)
}

export function settingsPlatform(ua) {
  const s = String(ua || '')
  if (/Windows/i.test(s)) return 'windows'
  if (/Mac/i.test(s)) return 'mac'
  if (/Linux|X11/i.test(s)) return 'linux'
  return ''
}

/** 工作区示例路径（占位符，不预填：roots 是安全边界，必须是用户自己决定的具体子目录）。 */
export function settingsRootsExample(platform) {
  if (platform === 'windows') return 'D:\\work'
  if (platform === 'mac') return '/Users/你的用户名/work'
  return '/home/你的用户名/work'
}

/** 地址格式问题；合法返回 ''。 */
export function settingsUrlProblem(value, opts) {
  const s = String(value == null ? '' : value).trim()
  if (s === '') return ''
  if (/\s/.test(s)) return '地址里不能有空格'
  if (!/^(wss?|https?):\/\//i.test(s)) return '地址要以 ws:// wss:// http:// 或 https:// 开头'
  let u
  try { u = new URL(s) } catch { return '地址格式不对' }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === '') return '地址里没有主机名'
  if (host === '0.0.0.0' || host === '::') return '不能用 0.0.0.0，请填具体的局域网 / Tailscale IP'
  if (opts && opts.noLoopback && (host === 'localhost' || /^127\./.test(host) || host === '::1')) {
    return '副机不能连 localhost / 127.0.0.1（那是它自己），请填主机的局域网 / Tailscale IP'
  }
  return ''
}

export function settingsRootProblem(root) {
  const s = String(root || '').trim()
  if (s === '') return ''
  if (s.startsWith('~')) return s + '：不要用 ~，请写绝对路径'
  const win = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\')
  if (!win && !s.startsWith('/')) return s + '：必须是绝对路径'
  if (s === '/' || /^[A-Za-z]:[\\/]?$/.test(s)) return s + '：不能是整个磁盘，请指定具体子目录'
  if (/^\/(Users|home)\/[^/]+\/?$/.test(s) || /^[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]?$/i.test(s)) return s + '：不能是整个家目录，请指定具体子目录'
  return ''
}

/** 提交前校验。返回 { 字段: 错误文案 }，空对象 = 通过。规则与服务端 /setup/apply 一致，并补上它不拦的几条（直连必须有地址等）。 */
export function settingsValidate(role, form) {
  const f = Object.assign(settingsEmptyForm(), form || {})
  const plan = settingsRolePlan(role)
  const errors = {}
  if (!plan.valid) errors.role = '请先选择角色'
  const direct = f.transportMode === 'direct'
  const noLoopback = plan.role === 'worker'
  const relayUrl = f.relayUrl.trim()
  const hubUrl = f.hubUrl.trim()
  if (direct) {
    if (hubUrl === '' && plan.requireHubUrl) errors.hubUrl = '直连模式必须填主机地址'
    else if (settingsUrlProblem(hubUrl, { noLoopback })) errors.hubUrl = settingsUrlProblem(hubUrl, { noLoopback })
  } else {
    if (relayUrl === '' && plan.requireRelayUrl) errors.relayUrl = '中继模式必须填中继地址（或粘贴配对码）'
    else if (settingsUrlProblem(relayUrl, { noLoopback })) errors.relayUrl = settingsUrlProblem(relayUrl, { noLoopback })
    if (plan.role !== 'worker' && settingsUrlProblem(hubUrl)) errors.hubUrl = settingsUrlProblem(hubUrl)
  }
  if (/\s/.test(f.token.trim())) errors.token = '口令里不能有空格或换行'
  if (/\s/.test(f.listenHost.trim())) errors.listenHost = '监听地址里不能有空格'
  const port = f.listenPort.trim()
  if (port !== '' && (!/^\d+$/.test(port) || Number(port) > 65535)) errors.listenPort = '端口必须是 0–65535 的整数；留空 = 自动，0 = 关闭独立监听'
  const nodeId = f.nodeId.trim()
  if (nodeId !== '' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nodeId)) errors.nodeId = '节点 ID 只能含字母数字 . _ -，以字母或数字开头，最长 64'
  const rootProblems = settingsParseRoots(f.roots).map(settingsRootProblem).filter(Boolean)
  if (rootProblems.length) errors.roots = rootProblems.join('；')
  return errors
}

/** 向导的 /setup/apply 载荷：整张表单。口令只在用户填了才带；监听两项总是带（空串 = 自动）。 */
export function settingsApplyPayload(role, form, opts) {
  const f = Object.assign(settingsEmptyForm(), form || {})
  const r = settingsRolePlan(role).role
  const body = { role: r }
  if (opts && opts.force === true) body.force = true
  const direct = f.transportMode === 'direct'
  body.transportMode = direct ? 'direct' : 'relay'
  const hubUrl = f.hubUrl.trim()
  const relayUrl = f.relayUrl.trim()
  const token = f.token.trim()
  if (direct) {
    if (hubUrl !== '') body.hubUrl = hubUrl
  } else {
    if (relayUrl !== '') body.relayUrl = relayUrl
    if (r !== 'worker' && hubUrl !== '') body.hubUrl = hubUrl
    if (token !== '') body.hubToken = token
  }
  body.listenHost = f.listenHost.trim()
  body.listenPort = f.listenPort.trim()
  if (f.nodeId.trim() !== '') body.nodeId = f.nodeId.trim()
  const roots = settingsParseRoots(f.roots)
  if (roots.length) body.roots = roots
  return body
}

export const settingsFieldLabels = {
  transportMode: '连接方式', relayUrl: '中继地址', hubUrl: '主机地址', token: '口令', listenHost: '监听地址', listenPort: '监听端口',
}

/** 连接配置卡的载荷：只发和当前生效值不同的字段（没发的服务端原样保留），口令只在填了才发。 */
export function settingsConfigPayload(role, current, form) {
  const plan = settingsRolePlan(role)
  const f = Object.assign(settingsEmptyForm(), form || {})
  const base = settingsFormFromCurrent(current)
  const payload = { role: plan.role }
  const changed = []
  for (const k of ['transportMode', 'relayUrl', 'hubUrl', 'listenHost', 'listenPort']) {
    const now = String(f[k]).trim()
    if (now !== String(base[k]).trim()) { payload[k] = now; changed.push(k) }
  }
  if (f.token.trim() !== '') { payload.hubToken = f.token.trim(); changed.push('token') }
  return { payload, changed, errors: settingsValidate(role, f) }
}

/** 写盘成功后把写入的值并进「当前值」：运行中的进程要重启才换配置，重读 /setup/state 只会读回旧值。 */
export function settingsApplyToCurrent(cur, payload) {
  const next = Object.assign({}, cur || {})
  const p = payload || {}
  for (const k of ['transportMode', 'relayUrl', 'hubUrl', 'listenHost']) if (typeof p[k] === 'string') next[k] = p[k]
  if (typeof p.listenPort === 'string') next.listenPort = p.listenPort === '' ? null : Number(p.listenPort)
  if (typeof p.hubToken === 'string' && p.hubToken !== '') next.tokenSet = true
  return next
}

/** 保存前确认框的正文（不含任何口令值）。 */
export function settingsSaveConfirm(changed, file) {
  const names = (changed || []).map((k) => settingsFieldLabels[k] || k).join('、')
  return '将改写配置文件' + (file ? '：\n' + file : '') + '\n\n修改项：' + names
    + '\n\n写入前会先备份，写后校验；运行中的进程要重启 DSH 才会用新配置。继续？'
}

/** 向导确认页的摘要行。 */
export function settingsReviewRows(role, form, cur) {
  const f = Object.assign(settingsEmptyForm(), form || {})
  const c = cur && typeof cur === 'object' ? cur : {}
  const direct = f.transportMode === 'direct'
  const rows = [['角色', settingsRoleName(role) + '（' + settingsRolePlan(role).role + '）'], ['连接方式', direct ? '直连（direct）' : '中继（relay）']]
  if (direct) rows.push(['主机地址', f.hubUrl.trim() || '—'])
  else {
    rows.push(['中继地址', f.relayUrl.trim() || '—'])
    if (settingsRolePlan(role).role !== 'worker') rows.push(['本机对外地址', f.hubUrl.trim() || '自动推断'])
    rows.push(['口令', f.token.trim() !== '' ? '已填写（写入后不再显示）' : (c.tokenSet === true ? '沿用已设置的口令' : '未设置')])
  }
  rows.push(['节点 ID', f.nodeId.trim() || '自动（本机主机名）'])
  const roots = settingsParseRoots(f.roots)
  rows.push(['工作区', roots.length ? roots.join('\n') : '未指定（用默认）'])
  rows.push(['监听', (f.listenHost.trim() || '自动选网卡') + ' : ' + (f.listenPort.trim() === '' ? '自动端口' : f.listenPort.trim() === '0' ? '0（关闭独立监听）' : f.listenPort.trim())])
  return rows
}

/** 口令状态：{ relay, node } 各为 true / false / null（未知）。 */
export function settingsTokenState(role, setupCurrent, cfg, wrote) {
  const cur = setupCurrent && typeof setupCurrent === 'object' ? setupCurrent : {}
  const hasCfg = cfg && typeof cfg === 'object'
  const relay = hasCfg ? cfg.relayTokenSet === true : (cur.tokenSet === true ? true : null)
  const node = hasCfg ? cfg.nodeTokenSet === true : null
  return { relay: wrote === true ? true : relay, node, role: settingsRolePlan(role).role }
}

/** 「复制配置模板」：与 /setup/apply 实际写出的键一致；口令只含用户自己刚输入的值，否则是占位符。 */
export function settingsConfigTemplate(role, form) {
  const f = Object.assign(settingsEmptyForm(), form || {})
  const r = settingsRolePlan(role).role || 'hub'
  const direct = f.transportMode === 'direct'
  const q = (v) => "'" + String(v).replace(/'/g, "''") + "'"
  const lines = ['- id: remote-agent', '  name: dsh-ai-cluster', '  config:', '    role: ' + r, '    transportMode: ' + (direct ? 'direct' : 'relay')]
  if (direct) {
    lines.push('    hubUrl: ' + q(f.hubUrl.trim() || '<主机地址:端口>'))
    lines.push('    nodeToken: ' + q('<入网口令>'))
  } else {
    const url = f.relayUrl.trim() || '<中继地址>'
    lines.push('    relayUrl: ' + q(url))
    if (r !== 'worker' && f.hubUrl.trim() !== '') lines.push('    hubUrl: ' + q(f.hubUrl.trim()))
    lines.push('    relay:', '      url: ' + q(url), '      token: ' + q(f.token.trim() || (r === 'worker' ? '<接入口令>' : '<中继口令>')))
  }
  return lines.join('\n')
}

/* ── 配对码 ────────────────────────────────────────────────────────── */

/** 解析 dshra1:// / cluster1:// 配对码（base64url(JSON)）。成功返回 { ok:true, fill, hasToken, scheme }。 */
export function settingsParsePair(text) {
  let s = String(text == null ? '' : text).trim()
  if (s === '') return { ok: false, error: '配对码为空：请把主机上的 dshra1:// 整行粘贴进来' }
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1).trim()
  s = s.replace(/[\r\n\t ]+/g, '')
  if (s.length > 4096) return { ok: false, error: '配对码过长，疑似粘错了内容' }
  const lower = s.toLowerCase()
  if (lower.startsWith('dshbot1://')) return { ok: false, error: '向导暂不支持 dshbot1:// 配对码，请在主机上换用 dshra1:// 码' }
  const scheme = ['dshra1://', 'cluster1://'].find((x) => lower.startsWith(x))
  if (!scheme) return { ok: false, error: '配对码格式不对：应以 dshra1:// 开头（地址请填在地址栏，别和配对码混用）' }
  const b64 = s.slice(scheme.length)
  if (b64 === '' || !/^[A-Za-z0-9_-]+$/.test(b64)) return { ok: false, error: '配对码内容不完整：请从主机重新完整复制' }
  let d
  try {
    const std = b64.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4))
    d = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
  } catch {
    return { ok: false, error: '配对码解析不了（被截断或改过）：请回主机重新生成并整行复制' }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: '配对码里没有可用内容' }
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const hubUrl = str(d.hubUrl)
  const relayUrl = str(d.relayUrl)
  if (hubUrl === '' && relayUrl === '') return { ok: false, error: '配对码里没有地址' }
  const mode = d.transportMode === 'direct' || d.transportMode === 'relay' ? d.transportMode : (hubUrl !== '' && relayUrl === '' ? 'direct' : 'relay')
  const fill = { transportMode: mode }
  if (hubUrl !== '') fill.hubUrl = hubUrl
  if (relayUrl !== '') fill.relayUrl = relayUrl
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(str(d.nodeId))) fill.nodeId = str(d.nodeId)
  return { ok: true, fill, hasToken: str(d.token) !== '', scheme }
}

/* ── 副机状态 ──────────────────────────────────────────────────────── */

export function settingsTransportLabel(mode) {
  return mode === 'direct' ? '直连' : mode === 'relay' ? '中继' : '未知'
}

export function settingsTaskLine(tasks) {
  const t = tasks && typeof tasks === 'object' ? tasks : {}
  return '总数 ' + (t.total || 0) + ' · 运行 ' + (t.running || 0) + ' · 排队 ' + (t.queued || 0) + ' · 活动 ' + (t.active || 0)
}

/** /api/remote-agent/status → 键值行（全是字符串）。 */
export function settingsWorkerFacts(status) {
  const w = status && typeof status === 'object' ? status : {}
  const caps = Array.isArray(w.caps) ? w.caps.filter((c) => typeof c === 'string') : []
  const roots = Array.isArray(w.roots) ? w.roots.filter((r) => typeof r === 'string') : []
  const runner = typeof w.runner === 'string' && w.runner !== '' ? w.runner : ''
  return [
    ['节点 ID', w.nodeId || '—'],
    ['连接', (w.online === true ? '在线' : '离线') + ' · ' + settingsTransportLabel(w.transportMode)],
    ['主机地址', w.url || '—'],
    ['执行后端', runner ? runner + (w.agentMode === true ? '（agent 模式）' : '') : (w.agentMode === true ? 'agent' : '—')],
    ['工作区', roots.length ? roots.join('\n') : '—'],
    ['能力', caps.length ? caps.join(' · ') : '—'],
    ['任务', settingsTaskLine(w.tasks)],
    ['DSH 版本', w.dshVersion || '—'],
    ['工作目录', w.stateDir || '—'],
    ['状态更新于', coreFmtTime(w.updatedAt)],
  ]
}

/** lastError / lastErrorDetail（旧版是字符串，新版是对象）→ 统一结构；没有错误返回 null。 */
export function settingsWorkerError(status) {
  const w = status && typeof status === 'object' ? status : {}
  const d = w.lastErrorDetail
  const text = typeof w.lastError === 'string' ? w.lastError : ''
  if (d && typeof d === 'object') {
    const s = (v) => (typeof v === 'string' ? v : '')
    return { text, title: s(d.title), detail: s(d.detail), hint: s(d.hint), raw: s(d.raw), code: s(d.code), at: typeof d.at === 'number' ? d.at : 0 }
  }
  const detail = typeof d === 'string' ? d : ''
  if (text === '' && detail === '') return null
  return { text, title: '', detail, hint: '', raw: '', code: '', at: 0 }
}

/* ── 环境体检 / 一键修复 ──────────────────────────────────────────── */

export function settingsEnvItems(data) {
  const items = data && Array.isArray(data.items) ? data.items : []
  return items.filter((it) => it && typeof it === 'object').map((it, i) => {
    const ok = it.ok === true
    const tone = ok ? 'ok' : (it.severity === 'warn' || it.severity === 'info' ? 'warn' : 'bad')
    return {
      id: String(it.id || i), label: String(it.label || it.id || ''), ok, tone,
      state: ok ? '通过' : tone === 'warn' ? '注意' : '未通过',
      detail: typeof it.detail === 'string' ? it.detail : '', fix: typeof it.fix === 'string' ? it.fix : '', autoFix: it.autoFix === true,
    }
  })
}

/** 体检摘要：{ tone, text, failed }。error 是请求失败的原文。 */
export function settingsEnvSummary(data, error) {
  if (error) return { tone: 'bad', text: '体检失败', failed: 0 }
  if (!data) return { tone: '', text: '尚未体检', failed: 0 }
  const items = settingsEnvItems(data)
  const failed = typeof data.failed === 'number' ? data.failed : items.filter((x) => !x.ok).length
  return failed > 0 ? { tone: 'bad', text: failed + ' 项需要处理', failed } : { tone: 'ok', text: '全部通过', failed: 0 }
}

/** POST /fix {action:'plan'} 的回包 → 预览。 */
export function settingsFixPreview(resp) {
  const r = resp && typeof resp === 'object' ? resp : {}
  if (r.ok === false || !r.plan || typeof r.plan !== 'object') {
    return { ok: false, error: String(r.message || r.error || '读取修复计划失败'), fixable: [], skipped: [], file: '', host: '', backups: [] }
  }
  const p = r.plan
  const list = (a) => (Array.isArray(a) ? a.filter((x) => x && typeof x === 'object') : [])
  const s = (v) => (typeof v === 'string' ? v : '')
  return {
    ok: true, error: '',
    fixable: list(p.fixable).map((x) => ({ id: s(x.id), label: s(x.label), change: s(x.change), note: s(x.note) })),
    skipped: list(p.skipped).map((x) => ({ id: s(x.id), label: s(x.label), reason: s(x.reason) })),
    file: s(p.file), host: s(p.host),
    backups: list(p.backups).map((b) => ({ name: s(b.name), at: typeof b.at === 'number' ? b.at : 0 })),
  }
}

export function settingsFixConfirm(preview) {
  const p = preview || { fixable: [], file: '' }
  return '将修改 DSH 的配置文件' + (p.file ? '：\n' + p.file : '') + '\n\n'
    + p.fixable.map((x) => '· ' + (x.change || x.label) + (x.note ? '（' + x.note + '）' : '')).join('\n')
    + '\n\n写入前会先备份，写后校验，只改托管块；重启 DSH 后生效。继续？'
}

/** POST /fix {action:'apply'} 的回包 → 提示条。 */
export function settingsFixResult(resp) {
  const r = resp && typeof resp === 'object' ? resp : {}
  if (r.ok === false) return { tone: 'err', text: '修复失败：' + String(r.message || r.error || 'unknown') }
  const applied = Array.isArray(r.applied) && r.applied.length ? '（' + r.applied.join('、') + '）' : ''
  return { tone: 'ok', text: '已应用修复' + applied + '，重启 DSH 生效' + (r.backup ? '。备份：' + r.backup : '') }
}

/* ── 通道与审计 ───────────────────────────────────────────────────── */

export function settingsLinkSummary(link) {
  const l = link && typeof link === 'object' ? link : {}
  if (l.available !== true) return { available: false, total: 0, nodes: 0, text: '可靠通道未启用或暂时读不到' }
  const total = Number.isFinite(l.total) ? l.total : 0
  const nodes = Array.isArray(l.nodes) ? l.nodes.length : 0
  return { available: true, total, nodes, text: total === 0 ? '没有等待送达的消息' : total + ' 条消息等待送达（' + nodes + ' 台）' }
}

/** 每台机器一行：待送达条数、最久等待、已重试次数、消息类型分布。积压多的排前面。 */
export function settingsLinkRows(link, nodes) {
  const rows = link && Array.isArray(link.nodes) ? link.nodes : []
  const names = new Map((Array.isArray(nodes) ? nodes : []).map((n) => [n && n.nodeId, n && n.hostname]))
  return rows.filter((r) => r && typeof r === 'object' && typeof r.nodeId === 'string').map((r) => ({
    nodeId: r.nodeId,
    name: typeof names.get(r.nodeId) === 'string' ? names.get(r.nodeId) : '',
    pending: Number.isFinite(r.pending) ? r.pending : 0,
    oldestText: typeof r.oldestMs === 'number' ? coreFmtDur(r.oldestMs) : '—',
    tries: Number.isFinite(r.maxTries) ? r.maxTries : 0,
    online: r.online === true,
    types: Object.entries(r.types && typeof r.types === 'object' ? r.types : {})
      .map((e) => ({ type: e[0], count: Number(e[1]) || 0 })).sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)),
  })).sort((a, b) => b.pending - a.pending)
}

/** hub.caps 里的独立监听与可达性 → 展示模型；没有对应字段就是 null。now 只用于「已等 X」。 */
export function settingsListenerView(caps, now) {
  const c = caps && typeof caps === 'object' ? caps : {}
  const out = { listener: null, reach: null }
  const L = c.listener && typeof c.listener === 'object' ? c.listener : null
  if (L) {
    const where = (L.host || '?') + ':' + (L.port == null ? '?' : L.port)
    if (L.ok === true) out.listener = { tone: 'ok', label: '独立监听在听', detail: where + '（来源 ' + (L.source || 'auto') + '）' }
    else if (L.state === 'waiting-port') {
      const waited = typeof L.waitingSince === 'number' && typeof now === 'number' ? '，已等 ' + coreFmtDur(now - L.waitingSince) : ''
      out.listener = { tone: 'warn', label: '等待端口释放', detail: '端口被占用' + waited + '；空出后会自动接上' }
    } else if (typeof L.disabled === 'string' && L.disabled !== '') out.listener = { tone: 'warn', label: '独立监听已关闭', detail: '原因：' + L.disabled + '；副机只能走 DSH 的 webserver 通道' }
    else if (L.ok === false) out.listener = { tone: 'bad', label: '独立监听启动失败', detail: L.error || '未知原因' }
    else out.listener = { tone: 'warn', label: '独立监听尚未就绪', detail: '刚启动？稍后刷新' }
  }
  const R = c.reachability && typeof c.reachability === 'object' ? c.reachability : null
  if (R) {
    if (R.loopback === true) out.reach = { tone: 'bad', label: '只绑在本机回环，副机连不上', detail: R.hint || '', where: R.bound || '' }
    else out.reach = { tone: 'ok', label: '副机可以连进来', detail: R.hint || '', where: (R.origin || R.bound || '') + (R.port ? ':' + R.port : '') + (R.via ? '（通道：' + R.via + '）' : '') }
  }
  return out
}

/* ── 小工具 ────────────────────────────────────────────────────────── */

/** Tab 焦点环：返回下一个要聚焦的下标（抽屉里的焦点陷阱用）。 */
export function settingsNextFocus(index, count, shift) {
  if (!(count > 0)) return -1
  if (index < 0) return shift ? count - 1 : 0
  return shift ? (index + count - 1) % count : (index + 1) % count
}

export function settingsErrText(e) {
  return coreFailure(e).error
}

export const settingsSteps = [['role', '选角色'], ['connect', '填连接信息'], ['review', '确认写入']]

/** 角色卡上的大图标字形（纯装饰，aria-hidden）。 */
export const settingsRoleGlyph = { hub: '◉', worker: '◌', both: '◎' }
/** 体检行的状态字形：不只靠颜色。 */
export const settingsStateGlyph = { ok: '✓', warn: '▲', bad: '✕' }

/* ── 组件 ──────────────────────────────────────────────────────────── */

export function createSettings(core) {
  const { React, h, api, safe, Badge, Card, Banner, Stat, Seg, Field, Fold, CopyBtn } = core

  const patchOf = (setSt) => (o) => setSt((prev) => Object.assign({}, prev, o))
  const errHint = (errors, key, hint) => (errors[key] ? h('span', { className: 'st-err', role: 'alert' }, '✕ ' + errors[key]) : hint)
  /** iOS 分组列表：每行「标签在左 / 值在右」，行间发丝线。rows = [[标签, 值, 额外 class?]]。 */
  const factList = (rows) => h('dl', { className: 'st-group st-list' }, rows.map((r) => h('div', { key: r[0], className: 'st-row' },
    h('dt', null, r[0]), h('dd', { className: r[2] || 'dra-wrap' }, r[1]))))
  const textInput = (value, onChange, extra) => h('input', Object.assign({
    className: 'dra-input dra-mono', type: 'text', value, autoComplete: 'off', spellCheck: false, onChange: (e) => onChange(e.target.value),
  }, extra))

  function StepBar(p) {
    const idx = settingsSteps.findIndex((s) => s[0] === p.step)
    return h('ol', { className: 'st-steps', 'aria-label': '配置步骤' }, settingsSteps.map((s, i) => {
      const done = p.step === 'done' || i < idx
      const cur = p.step !== 'done' && i === idx
      return h('li', { key: s[0], className: 'st-step' + (cur ? ' on' : '') + (done ? ' done' : ''), 'aria-current': cur ? 'step' : undefined },
        h('span', { className: 'st-step-n' }, done ? '✓' : String(i + 1)), h('span', null, '步骤 ' + (i + 1) + '：' + s[1]))
    }))
  }

  function RoleCards(p) {
    return h('fieldset', { className: 'st-roles' },
      h('legend', { className: 'dra-field-label' }, '这台机器的角色'),
      settingsRoleIds.map((id) => {
        const info = settingsRoleInfo[id]
        const on = p.value === id
        return h('label', { key: id, className: 'st-role' + (on ? ' on' : '') },
          h('input', { type: 'radio', name: 'st-role', value: id, checked: on, onChange: () => p.onChange(id) }),
          on ? h('span', { className: 'st-check dra-pop', 'aria-hidden': 'true' }, '✓') : null,
          h('span', { className: 'st-role-glyph', 'aria-hidden': 'true' }, settingsRoleGlyph[id]),
          h('span', { className: 'st-role-body' },
            h('b', null, info.title, p.current === id ? h(Badge, { tone: 'acc' }, '当前角色') : null),
            h('span', { className: 'st-role-tag' }, info.tagline),
            h('span', { className: 'dra-hint' }, info.detail)))
      }))
  }

  /** 连接字段：向导第二步与「连接配置」卡共用。showNode = 同时给节点 ID 与工作区（只有向导要）。 */
  function ConnectFields(p) {
    const plan = settingsRolePlan(p.role)
    const f = p.form
    const errors = p.errors || {}
    const direct = f.transportMode === 'direct'
    const set = p.set
    const advErr = Boolean(errors.listenHost || errors.listenPort || errors.nodeId || (!plan.rootsPrimary && errors.roots))
    const tokenPlaceholder = p.tokenSet === true ? '已设置，留空 = 沿用' : p.tokenSet === false ? '未设置' : '留空 = 沿用当前口令'
    const rootsField = p.showNode ? h(Field, { label: '工作区 roots（每行一个，绝对路径）', wide: true, hint: errHint(errors, 'roots', '只有这些目录里的东西副机才能碰，请指定具体子目录，别写整个磁盘或家目录。目录不存在会自动创建。') },
      h('textarea', { className: 'dra-textarea dra-mono', value: f.roots, placeholder: settingsRootsExample(p.platform), spellCheck: false, 'aria-invalid': errors.roots ? 'true' : undefined, onChange: (e) => set('roots', e.target.value) })) : null
    return h('div', { className: 'dra-col' },
      h('div', { className: 'dra-field st-group st-pad' },
        h('span', { className: 'dra-field-label' }, '连接方式'),
        h(Seg, { label: '连接方式', value: f.transportMode, options: [['relay', '中继（relay）'], ['direct', '直连（direct）']], onChange: (v) => set('transportMode', v) }),
        h('span', { className: 'dra-hint' }, direct
          ? (plan.role === 'worker' ? '直连：这台副机主动连主机，主机端口必须能被这里访问；主机在 NAT 后请改用中继。' : '直连：副机主动连这台主机，本机端口必须能被副机访问；在 NAT 后请改用中继。')
          : '中继：双方都连到同一个中继服务，主机或副机在 NAT 后也能用。需要中继地址和口令。')),
      h('div', { className: 'dra-form st-group st-pad' },
        direct
          ? h(Field, { label: plan.hubUrlLabel + (plan.requireHubUrl ? ' · 必填' : ''), wide: true, hint: errHint(errors, 'hubUrl', plan.requireHubUrl ? '例：ws://主机IP:19387/api/remote-agent/node' : '例：http://192.168.1.10:19387') },
            textInput(f.hubUrl, (v) => set('hubUrl', v), { placeholder: plan.requireHubUrl ? 'ws://主机IP:19387/api/remote-agent/node' : 'http://192.168.1.10:19387', 'aria-invalid': errors.hubUrl ? 'true' : undefined }))
          : [
            h(Field, { key: 'relay', label: plan.relayUrlLabel + (plan.requireRelayUrl ? ' · 必填' : ''), wide: true, hint: errHint(errors, 'relayUrl', '请填具体的局域网 / Tailscale IP，不能用 0.0.0.0 或 localhost') },
              textInput(f.relayUrl, (v) => set('relayUrl', v), { placeholder: 'ws://192.168.1.10:8890/relay', 'aria-invalid': errors.relayUrl ? 'true' : undefined })),
            plan.role === 'worker' ? null : h(Field, { key: 'hub', label: plan.hubUrlLabel, wide: true, hint: errHint(errors, 'hubUrl', '') },
              textInput(f.hubUrl, (v) => set('hubUrl', v), { placeholder: 'http://192.168.1.10:19387', 'aria-invalid': errors.hubUrl ? 'true' : undefined })),
            h(Field, { key: 'token', label: plan.tokenLabel, wide: true, hint: errHint(errors, 'token', '口令不会回显；留空表示沿用已设置的口令。') },
              h('input', { className: 'dra-input dra-mono', type: 'password', value: f.token, placeholder: tokenPlaceholder, autoComplete: 'new-password', 'aria-invalid': errors.token ? 'true' : undefined, onChange: (e) => set('token', e.target.value) })),
          ]),
      direct && plan.role === 'worker' ? h('div', { className: 'dra-hint st-foot' }, '直连模式的入网口令由主机生成（主机面板 → 设置 → 入网口令），这里不写副机侧口令；可用配对码里的 pair 字段或 dsh-remote-setup 写入。') : null,
      plan.rootsPrimary ? rootsField : null,
      h(Fold, { title: '高级：监听' + (p.showNode ? '与本机标识' : ''), open: advErr },
        h('div', { className: 'dra-form' },
          h(Field, { label: '监听地址 listenHost（空 = 自动选网卡）', hint: errHint(errors, 'listenHost', '') },
            textInput(f.listenHost, (v) => set('listenHost', v), { placeholder: '留空 = 自动选网卡', 'aria-invalid': errors.listenHost ? 'true' : undefined })),
          h(Field, { label: '监听端口 listenPort（0–65535，空 = 自动，0 = 关闭）', hint: errHint(errors, 'listenPort', '') },
            textInput(f.listenPort, (v) => set('listenPort', v), { placeholder: '19387', inputMode: 'numeric', 'aria-invalid': errors.listenPort ? 'true' : undefined })),
          p.showNode ? h(Field, { label: '节点 ID（空 = 自动用本机主机名）', hint: errHint(errors, 'nodeId', '') },
            textInput(f.nodeId, (v) => set('nodeId', v), { placeholder: '留空 = 自动用本机主机名', 'aria-invalid': errors.nodeId ? 'true' : undefined })) : null),
        plan.rootsPrimary ? null : rootsField))
  }

  /* ── 首次配置 / 换角色 ─────────────────────────────────────────── */

  function Setup(p) {
    const switching = p.switching === true
    const setup = p.setup && typeof p.setup === 'object' ? p.setup : {}
    const cur = setup.current && typeof setup.current === 'object' ? setup.current : {}
    const saved = dataSavedRole(p.setup)
    const [st, setSt] = React.useState(() => ({
      step: 'role', role: switching ? saved : '', form: settingsFormFromCurrent(cur), pair: '', pairNote: null,
      showErrors: false, busy: false, error: null, conflict: '', written: null,
    }))
    const headRef = React.useRef(null)
    React.useEffect(() => { if (headRef.current && headRef.current.focus) headRef.current.focus() }, [st.step])
    const patch = patchOf(setSt)
    const setField = (k, v) => setSt((prev) => Object.assign({}, prev, { form: Object.assign({}, prev.form, { [k]: v }) }))
    const platform = settingsPlatform(typeof navigator !== 'undefined' ? navigator.userAgent : '')
    const errors = st.showErrors ? settingsValidate(st.role, st.form) : {}
    const plan = settingsRolePlan(st.role)
    const head = (text) => h('h2', { className: 'st-head', tabIndex: -1, ref: headRef }, text)
    const cancel = switching ? h('button', { type: 'button', className: 'dra-btn', onClick: p.onCancel }, '取消') : null

    const applyPair = () => {
      const r = settingsParsePair(st.pair)
      if (!r.ok) { patch({ pairNote: { tone: 'err', text: r.error } }); return }
      setSt((prev) => Object.assign({}, prev, {
        form: Object.assign({}, prev.form, r.fill),
        pairNote: { tone: 'ok', text: '已从配对码填入（' + (r.fill.transportMode === 'direct' ? '直连' : '中继') + '）' + (r.hasToken ? '。配对码里带有口令，向导不会自动写入它；中继模式的接入口令请在下面单独填。' : '。') + '确认后继续。' },
      }))
    }
    const goConnect = () => patch({ step: 'connect', showErrors: false })
    const goReview = () => {
      if (Object.keys(settingsValidate(st.role, st.form)).length) { patch({ showErrors: true }); return }
      patch({ step: 'review', error: null, conflict: '' })
    }
    const submit = (force) => {
      if (Object.keys(settingsValidate(st.role, st.form)).length) { patch({ step: 'connect', showErrors: true }); return }
      patch({ busy: true, error: null, conflict: '' })
      api.postPath(settingsApplyPath, settingsApplyPayload(st.role, st.form, { force: force === true })).then(
        (body) => {
          if (body && body.ok === false) patch({ busy: false, error: { text: String(body.message || body.error || '写入失败'), code: String(body.error || '') } })
          else patch({ busy: false, step: 'done', written: body || {} })
        },
        (e) => {
          const f = coreFailure(e)
          const code = f.body && typeof f.body.error === 'string' ? f.body.error : ''
          const conflict = f.status === 409 || /conflict|exists/i.test(code)
          patch({ busy: false, error: { text: f.error, code, file: f.body && f.body.file ? String(f.body.file) : '' }, conflict: conflict ? f.error : '' })
        })
    }
    const replaceHandwritten = () => {
      Promise.resolve(p.ui.confirm('profile 里有手写的 remote-agent 条目。替换它会改写该条目（先备份）。继续？')).then((ok) => { if (ok) submit(true) })
    }

    if (st.step === 'done') {
      const w = st.written || {}
      const warnings = Array.isArray(w.warnings) ? w.warnings : []
      return h('div', { className: 'dra-col st-setup' },
        h(StepBar, { step: 'done' }),
        h(Card, { title: '写入完成', sub: '角色：' + settingsRoleName(w.role || st.role), className: 'st-summary' },
          h('div', { className: 'st-seal', 'aria-hidden': 'true' }, '✓'),
          h('h2', { className: 'st-head st-center', tabIndex: -1, ref: headRef }, '配置已写入'),
          h(Banner, { tone: 'ok', title: '重启 DSH 生效' }, '配置改动不会热加载：重启 DSH 之后这台机器才按新配置运行。'),
          factList([
            ['配置文件', [w.file || '—', w.file ? h(CopyBtn, { key: 'cp', label: '复制路径', text: w.file }) : null], 'dra-mono dra-wrap'],
            w.backup ? ['备份', w.backup, 'dra-mono dra-wrap'] : null,
            w.instanceFile ? ['独立配置', w.instanceFile, 'dra-mono dra-wrap'] : null,
          ].filter(Boolean)),
          warnings.length ? h('ul', { className: 'st-warns' }, warnings.map((x, i) => h('li', { key: i, className: 'dra-warn' }, '▲ ' + String(x)))) : null,
          h('div', { className: 'dra-row' }, h('button', { type: 'button', className: 'dra-btn primary', onClick: () => p.onDone(st.written || {}) }, '知道了'))))
    }

    if (st.step === 'role') {
      return h('div', { className: 'dra-col st-setup' },
        h(StepBar, { step: 'role' }),
        h(Card, { title: switching ? '切换角色 / 重新配置' : '首次配置', sub: switching ? '当前：' + settingsRoleName(saved) : '先选这台机器扮演什么角色' },
          head(switching ? '要把这台机器改成什么角色？' : '这台机器是主机还是副机？'),
          h('p', { className: 'dra-hint' }, '选错角色，后面的字段都会不对。放心，之后随时可以在设置里重新选。'),
          h(RoleCards, { value: st.role, current: saved, onChange: (v) => patch({ role: v }) }),
          h('div', { className: 'dra-row' },
            h('button', { type: 'button', className: 'dra-btn primary', disabled: !plan.valid, onClick: goConnect }, switching && st.role === saved ? '下一步：重新配置当前角色' : '下一步'),
            cancel)))
    }

    if (st.step === 'connect') {
      return h('div', { className: 'dra-col st-setup' },
        h(StepBar, { step: 'connect' }),
        h(Card, { title: settingsRoleInfo[plan.role].title, sub: '怎么连、连谁' },
          head('填连接信息'),
          plan.pair ? h('div', { className: 'st-pair st-group st-pad' },
            h(Field, { label: '配对码（dshra1://…，整行粘贴即可）', wide: true, hint: '主机的「机器」屏里生成；粘贴后点「解析填入」，不用手抄地址。' },
              h('div', { className: 'dra-row' },
                textInput(st.pair, (v) => patch({ pair: v }), { placeholder: 'dshra1://eyJ…' }),
                h('button', { type: 'button', className: 'dra-btn', onClick: applyPair }, '解析填入'))),
            st.pairNote ? h('div', { className: 'dra-hint ' + (st.pairNote.tone === 'err' ? 'dra-danger' : 'dra-ok'), role: st.pairNote.tone === 'err' ? 'alert' : 'status' }, (st.pairNote.tone === 'err' ? '✕ ' : '✓ ') + st.pairNote.text) : null) : null,
          h(ConnectFields, { role: st.role, form: st.form, errors, set: setField, tokenSet: cur.tokenSet === true ? true : undefined, platform, showNode: true }),
          Object.keys(errors).length ? h('div', { className: 'dra-hint dra-danger', role: 'alert' }, '✕ 有 ' + Object.keys(errors).length + ' 处需要先改好（见上面标红的字段）') : null,
          h('div', { className: 'dra-row' },
            h('button', { type: 'button', className: 'dra-btn primary', onClick: goReview }, '下一步：确认'),
            h('button', { type: 'button', className: 'dra-btn', onClick: () => patch({ step: 'role', showErrors: false }) }, '上一步'),
            cancel)))
    }

    return h('div', { className: 'dra-col st-setup' },
      h(StepBar, { step: 'review' }),
      h(Card, { title: '确认写入', sub: settingsRoleName(st.role), className: 'st-summary' },
        head('确认后写入配置'),
        factList(settingsReviewRows(st.role, st.form, cur)),
        h('p', { className: 'dra-hint' }, '将写入：', h('span', { className: 'dra-mono dra-wrap' }, setup.patchFile || 'profile 的 cordis.patch.yml'), '。写盘会先备份并校验；重启 DSH 后生效。'),
        st.error ? h(Banner, { tone: 'err', title: '写入失败' },
          h('div', { className: 'dra-mono dra-wrap' }, st.error.text), st.error.code ? h('div', { className: 'dra-hint' }, '错误码：' + st.error.code) : null,
          st.conflict ? h('div', { className: 'dra-row' }, h('button', { type: 'button', className: 'dra-btn danger', disabled: st.busy, onClick: replaceHandwritten }, '替换手写配置')) : null) : null,
        h('div', { className: 'dra-row' },
          h('button', { type: 'button', className: 'dra-btn primary', disabled: st.busy, onClick: () => submit(false) }, st.busy ? '写入中…' : '写入配置'),
          h('button', { type: 'button', className: 'dra-btn', disabled: st.busy, onClick: () => patch({ step: 'connect' }) }, '上一步'),
          cancel)))
  }

  /* ── 副机状态卡 ─────────────────────────────────────────────────── */

  function WorkerStats(p) {
    const w = p.status || {}
    const t = w.tasks || {}
    return h('div', { className: 'dra-statbar st-counters' },
      h(Stat, { value: w.online === true ? '在线' : '离线', label: '连接状态', tone: w.online === true ? 'ok' : 'bad' }),
      h(Stat, { value: String(t.running || 0), label: '运行中', tone: 'acc' }),
      h(Stat, { value: String(t.queued || 0), label: '排队中' }),
      h(Stat, { value: String(t.total || 0), label: '任务总数' }),
      h(Stat, { value: w.dshVersion || '—', label: 'DSH 版本' }))
  }

  function WorkerError(p) {
    const e = settingsWorkerError(p.status)
    if (!e) return null
    return h(Banner, { tone: 'err', title: e.title || '最近错误' },
      e.text ? h('div', { className: 'dra-mono dra-wrap' }, e.text) : null,
      e.detail ? h('div', { className: 'dra-wrap' }, e.detail) : null,
      e.hint ? h('div', { className: 'dra-wrap' }, '下一步：' + e.hint) : null,
      h('div', { className: 'dra-hint' }, [e.code ? '错误码 ' + e.code : '', e.at ? '最后尝试 ' + coreFmtTime(e.at) : ''].filter(Boolean).join(' · ')),
      e.raw && e.raw !== e.text ? h('div', { className: 'dra-hint dra-mono dra-wrap' }, '原始错误：' + e.raw) : null)
  }

  function WorkerCard(p) {
    const w = p.worker || {}
    const s = w.status
    return h('div', { className: 'dra-col' },
      w.error ? h(Banner, { tone: 'err', title: '读不到副机状态', actions: p.refresh ? h('button', { type: 'button', className: 'dra-btn sm', onClick: p.refresh }, '重试') : null },
        h('div', { className: 'dra-mono dra-wrap' }, w.error)) : null,
      w.loading && !s ? h('div', { className: 'dra-hint' }, '读取副机状态…') : null,
      s ? h(WorkerStats, { status: s }) : null,
      s ? h(WorkerError, { status: s }) : null,
      s ? h(Card, { title: '本机状态', sub: '副机 Worker', actions: p.actions, className: 'st-sec' },
        factList(settingsWorkerFacts(s)),
        p.hideHint ? null : h('p', { className: 'dra-hint st-foot' }, '任务在主机的面板上看；本机只负责执行，并显示连接与队列计数。')) : null)
  }

  /* ── 连接配置卡（副机视图与设置抽屉共用） ───────────────────────── */

  function ConfigEditor(p) {
    const plan = p.plan || settingsRolePlan(p.role)
    const role = settingsRolePlan(p.role).role
    const [st, setSt] = React.useState({
      phase: 'loading', error: '', base: null, cfg: null, form: null, showErrors: false, busy: false, msg: null, conflict: '',
      wroteToken: false, rotating: false, fresh: '', rotateMsg: null, pending: false,
    })
    const alive = React.useRef(true)
    const patch = patchOf(setSt)
    const load = () => {
      Promise.all([
        api.getPath(dataSetupStatePath).then((d) => ({ ok: true, d }), (e) => ({ ok: false, e })),
        plan.hub ? safe(api.get('/config')) : Promise.resolve(null),
      ]).then((r) => {
        if (!alive.current) return
        if (!r[0].ok) { setSt((prev) => Object.assign({}, prev, { phase: prev.base ? 'ready' : 'error', error: settingsErrText(r[0].e) })); return }
        const cfg = r[1] && r[1].ok !== false && r[1].config ? r[1].config : null
        setSt((prev) => Object.assign({}, prev, { phase: 'ready', error: '', base: r[0].d, cfg, form: prev.form || settingsFormFromCurrent(r[0].d && r[0].d.current) }))
      })
    }
    React.useEffect(() => { alive.current = true; load(); return () => { alive.current = false } }, [])

    const cur = st.base && st.base.current ? st.base.current : null
    const form = st.form || settingsEmptyForm()
    const setField = (k, v) => setSt((prev) => Object.assign({}, prev, { form: Object.assign({}, prev.form || settingsEmptyForm(), { [k]: v }), msg: null }))
    const result = settingsConfigPayload(role, cur, form)
    const errors = st.showErrors ? result.errors : {}
    const file = (st.base && st.base.patchFile) || (st.cfg && st.cfg.patchFilePath) || ''
    const tokens = settingsTokenState(role, cur, st.cfg, st.wroteToken)
    const platform = settingsPlatform(typeof navigator !== 'undefined' ? navigator.userAgent : '')

    const doSave = (force) => {
      patch({ busy: true, msg: null, conflict: '' })
      const body = Object.assign({}, result.payload, force ? { force: true } : {})
      api.postPath(settingsApplyPath, body).then(
        (w) => {
          if (w && w.ok === false) { patch({ busy: false, msg: { tone: 'err', text: '写入失败：' + String(w.message || w.error || 'unknown') } }); return }
          const warns = w && Array.isArray(w.warnings) ? w.warnings : []
          setSt((prev) => Object.assign({}, prev, {
            busy: false, pending: true, showErrors: false,
            base: Object.assign({}, prev.base, { current: settingsApplyToCurrent(prev.base && prev.base.current, result.payload) }),
            wroteToken: prev.wroteToken || Object.prototype.hasOwnProperty.call(result.payload, 'hubToken'),
            form: Object.assign({}, prev.form, { token: '' }),
            msg: { tone: 'ok', text: '配置已写入' + (w && w.file ? '：' + w.file : '') + '。重启 DSH 后生效', warns },
          }))
          p.ui.notify('配置已写入，重启 DSH 生效', 'ok')
          if (p.refresh) p.refresh()
        },
        (e) => {
          const f = coreFailure(e)
          const code = f.body && typeof f.body.error === 'string' ? f.body.error : ''
          patch({ busy: false, msg: { tone: 'err', text: '写入失败：' + f.error + (code ? '（' + code + '）' : '') }, conflict: f.status === 409 || /conflict|exists/i.test(code) ? f.error : '' })
        })
    }
    const save = () => {
      if (Object.keys(result.errors).length) { patch({ showErrors: true }); return }
      if (!result.changed.length) return
      Promise.resolve(p.ui.confirm(settingsSaveConfirm(result.changed, file))).then((ok) => { if (ok) doSave(false) })
    }
    const replaceHandwritten = () => {
      Promise.resolve(p.ui.confirm('profile 里有手写的 remote-agent 条目。替换它会改写该条目（先备份）。继续？')).then((ok) => { if (ok) doSave(true) })
    }
    const rotate = () => {
      Promise.resolve(p.ui.confirm('将生成新的入网口令并写入配置文件（先备份）。已配对的副机要用新口令重新配对；重启 DSH 后生效。继续？')).then((ok) => {
        if (!ok) return
        patch({ rotating: true, rotateMsg: null })
        api.postPath(settingsRotatePath, {}).then(
          (d) => {
            const token = d && typeof d.token === 'string' ? d.token : ''
            setSt((prev) => Object.assign({}, prev, {
              rotating: false, fresh: token, cfg: Object.assign({}, prev.cfg, { nodeTokenSet: true }),
              rotateMsg: { tone: token ? 'ok' : 'err', text: token ? '新入网口令已写入，重启 DSH 生效；副机需用新口令重新配对。口令不在这里显示，用下面的按钮复制。' : String((d && (d.message || d.error)) || '没有返回口令') },
            }))
          },
          (e) => patch({ rotating: false, rotateMsg: { tone: 'err', text: '生成口令失败：' + settingsErrText(e) } }))
      })
    }

    const tokenLine = (label, on) => h('div', { key: label, className: 'st-row st-tok' }, label + '：', h(Badge, { tone: on === true ? 'ok' : on === false ? 'warn' : '' }, on === true ? '已设置' : on === false ? '未设置' : '未知'))
    const cfg = st.cfg
    const facts = cfg ? [
      ['拉取落地目录 uiPullRoot', cfg.uiPullRoot || '未设置（拉取产物功能关闭）'],
      ['界面接口 uiEnabled', cfg.uiEnabled === false ? '关闭' : '开启'],
      ['会话开关 sessionGate', cfg.sessionGate === true ? '开（每个会话需 /remote-agent on）' : '关'],
      ['节点 ID', cfg.nodeId || '自动（主机名）'],
      ['工作区', Array.isArray(cfg.roots) && cfg.roots.length ? cfg.roots.join('\n') : '—'],
      ['状态目录 stateDir', cfg.stateDir || '—'],
    ] : []
    const persist = st.base && st.base.persist ? st.base.persist : null

    return h(Card, {
      className: 'st-sec',
      title: '连接配置', sub: settingsRoleName(role) + (role ? '（' + role + '）' : ''),
      actions: [
        h(CopyBtn, { key: 'tpl', label: '复制配置模板', text: settingsConfigTemplate(role, form), title: '复制一段可贴进 cordis.patch.yml 的配置' }),
        h('button', { key: 'save', type: 'button', className: 'dra-btn primary sm', disabled: st.busy || st.phase !== 'ready' || result.changed.length === 0, onClick: save }, st.busy ? '写入中…' : '保存并写入'),
      ],
    },
    st.phase === 'loading' ? h('div', { className: 'dra-hint' }, '读取当前配置…') : null,
    st.phase === 'error' ? h(Banner, { tone: 'err', title: '读不到当前配置', actions: h('button', { type: 'button', className: 'dra-btn sm', onClick: load }, '重试') }, h('div', { className: 'dra-mono dra-wrap' }, st.error)) : null,
    st.phase === 'ready' ? h('div', { className: 'dra-col' },
      st.pending ? h(Banner, { tone: 'ok', title: '已写入，等待重启' }, '运行中的进程仍在使用旧配置；下面显示的是你刚写入的值。') : null,
      st.msg ? h(Banner, { tone: st.msg.tone, title: st.msg.text }, st.msg.warns && st.msg.warns.length ? st.msg.warns.map((x, i) => h('div', { key: i, className: 'dra-warn' }, '▲ ' + String(x))) : null,
        st.conflict ? h('div', { className: 'dra-row' }, h('button', { type: 'button', className: 'dra-btn danger', disabled: st.busy, onClick: replaceHandwritten }, '替换手写配置')) : null) : null,
      plan.hub ? h('div', { className: 'dra-hint' }, '在线节点上报的连接方式：' + (p.transportSummary && p.transportSummary.label ? p.transportSummary.label : '未知（暂无在线节点）')) : null,
      h(ConnectFields, { role, form, errors, set: setField, tokenSet: tokens.relay === null ? undefined : tokens.relay, platform, showNode: false }),
      h('div', { className: 'st-group st-list st-toks' },
        tokenLine(role === 'worker' ? '接入口令' : '中继口令', tokens.relay),
        plan.hub ? tokenLine('入网口令（副机直连用）', tokens.node) : null,
        plan.hub || st.fresh ? h('div', { key: 'acts', className: 'st-row st-acts' },
          plan.hub ? h('button', { type: 'button', className: 'dra-btn sm', disabled: st.rotating, onClick: rotate }, st.rotating ? '生成中…' : (tokens.node === true ? '重新生成入网口令' : '生成入网口令')) : null,
          st.fresh ? h(CopyBtn, { label: '复制新口令', text: st.fresh, title: '复制刚生成的口令（不在界面显示）' }) : null) : null),
      plan.hub && tokens.node === false ? h('div', { className: 'dra-hint dra-warn' }, '▲ 未设置入网口令：独立监听只能绑回环，副机连不上。生成口令后重启 DSH。') : null,
      st.rotateMsg ? h('div', { className: 'dra-hint ' + (st.rotateMsg.tone === 'ok' ? 'dra-ok' : 'dra-danger'), role: 'status' }, (st.rotateMsg.tone === 'ok' ? '✓ ' : '✕ ') + st.rotateMsg.text) : null,
      result.changed.length ? h('div', { className: 'dra-hint' }, '待保存的修改：' + result.changed.map((k) => settingsFieldLabels[k] || k).join('、')) : h('div', { className: 'dra-hint' }, '没有未保存的修改。'),
      h('p', { className: 'dra-hint st-foot' }, '保存只发你改过的字段，写盘前先备份、写后校验；重启 DSH 后生效。'),
      cfg ? h(Fold, { title: '其它生效配置（只读）', badge: facts.length + ' 项' },
        factList(facts),
        h('div', { className: 'dra-hint' }, '这些值要在 profile 的 cordis.patch.yml 里改。')) : null,
      h(Fold, { title: '配置文件与持久化' },
        factList([
          ['配置文件', [file || '—', file ? h(CopyBtn, { key: 'cp', label: '复制路径', text: file }) : null], 'dra-mono dra-wrap'],
          persist ? ['独立配置', persist.instanceFile === true ? '已保存（DSH 重写 patch 文件也丢不了）' + (persist.instanceRole ? '，角色 ' + persist.instanceRole : '') : '未保存：只靠 patch 文件，DSH 重写它时配置可能丢失'] : null,
        ].filter(Boolean)))) : null)
  }

  /* ── 副机视图 ───────────────────────────────────────────────────── */

  function WorkerView(p) {
    const switchBtn = h('button', { key: 'sw', type: 'button', className: 'dra-btn sm', onClick: p.onSwitchRole }, '切换角色')
    return h('div', { className: 'dra-screen' },
      h(WorkerCard, { worker: p.worker, refresh: p.refresh, actions: switchBtn }),
      !(p.worker && p.worker.status) ? h('div', { className: 'dra-row' }, switchBtn) : null,
      h(ConfigEditor, { role: 'worker', plan: settingsRolePlan('worker'), ui: p.ui, refresh: p.refresh }))
  }

  /* ── 设置抽屉的各节 ─────────────────────────────────────────────── */

  function EnvCard(p) {
    const [st, setSt] = React.useState({ phase: 'idle', data: null, error: '', fixBusy: false, preview: null, msg: null })
    const alive = React.useRef(true)
    const patch = patchOf(setSt)
    const run = () => {
      patch({ phase: 'loading', error: '' })
      api.get('/env-check').then(
        (d) => { if (alive.current) patch({ phase: 'done', data: d || null, error: '' }) },
        (e) => { if (alive.current) patch({ phase: 'error', error: settingsErrText(e) }) })
    }
    React.useEffect(() => { alive.current = true; run(); return () => { alive.current = false } }, [])
    const items = settingsEnvItems(st.data)
    const sum = settingsEnvSummary(st.data, st.error)
    const previewFix = () => {
      patch({ fixBusy: true, msg: null })
      api.post('/fix', { action: 'plan' }).then(
        (d) => { const pv = settingsFixPreview(d); patch({ fixBusy: false, preview: pv.ok ? pv : null, msg: pv.ok ? null : { tone: 'err', text: pv.error } }) },
        (e) => patch({ fixBusy: false, preview: null, msg: { tone: 'err', text: '读取修复计划失败：' + settingsErrText(e) } }))
    }
    const applyFix = () => {
      const pv = st.preview
      if (!pv || !pv.fixable.length) return
      Promise.resolve(p.ui.confirm(settingsFixConfirm(pv))).then((ok) => {
        if (!ok) return
        patch({ fixBusy: true, msg: null })
        api.post('/fix', { action: 'apply', confirm: 'yes' }).then(
          (d) => { patch({ fixBusy: false, preview: null, msg: settingsFixResult(d) }); run() },
          (e) => patch({ fixBusy: false, msg: { tone: 'err', text: '修复失败：' + settingsErrText(e) } }))
      })
    }
    return h(Card, {
      className: 'st-sec',
      title: '环境体检', sub: sum.text,
      actions: [
        h(Badge, { key: 'sum', tone: sum.tone }, sum.text),
        h('button', { key: 'run', type: 'button', className: 'dra-btn sm primary', disabled: st.phase === 'loading', onClick: run }, st.phase === 'loading' ? '体检中…' : '重新体检'),
        h('button', { key: 'pv', type: 'button', className: 'dra-btn sm', disabled: st.fixBusy, onClick: previewFix }, '一键修复预览'),
        st.preview && st.preview.fixable.length ? h('button', { key: 'ap', type: 'button', className: 'dra-btn sm danger', disabled: st.fixBusy, onClick: applyFix }, '应用修复') : null,
      ],
    },
    st.phase === 'error' ? h(Banner, { tone: 'err', title: '体检请求失败' }, h('div', { className: 'dra-mono dra-wrap' }, st.error)) : null,
    st.phase === 'loading' && !st.data ? h('div', { className: 'dra-hint' }, '正在体检…') : null,
    items.length ? h('ul', { className: 'st-group st-list st-stagger' }, items.map((it) => h('li', { key: it.id, className: 'st-row st-item' },
      h('span', { className: 'st-state ' + it.tone },
        h('span', { className: 'st-glyph dra-pop', 'aria-hidden': 'true' }, settingsStateGlyph[it.tone] || '●'), it.state),
      h('div', { className: 'st-item-body' },
        h('div', { className: 'dra-row' }, h('span', { className: 'st-item-label' }, it.label), it.autoFix ? h(Badge, { tone: 'warn' }, '可自动修复') : null),
        it.detail ? h('div', { className: 'dra-hint dra-wrap' }, it.detail) : null,
        !it.ok && it.fix ? h('div', { className: 'dra-row' }, h('span', { className: 'dra-hint dra-wrap st-fix' }, it.fix), h(CopyBtn, { label: '复制修法', text: it.fix, title: '复制这条修法' })) : null)))) : null,
    st.preview ? h('div', { className: 'st-preview dra-pop' },
      h('div', { className: 'dra-field-label' }, '修复预览：将修改 ' + (st.preview.file || '配置文件')),
      st.preview.fixable.length ? h('ul', { className: 'st-items' }, st.preview.fixable.map((x) => h('li', { key: x.id, className: 'st-item' }, h(Badge, { tone: 'warn' }, '将修改'), h('div', { className: 'st-item-body' }, h('div', null, x.change || x.label), x.note ? h('div', { className: 'dra-hint' }, x.note) : null)))) : h('div', { className: 'dra-hint' }, '没有可以一键修复的项。'),
      st.preview.skipped.length ? h('ul', { className: 'st-items' }, st.preview.skipped.map((x) => h('li', { key: x.id, className: 'st-item' }, h(Badge, null, '需人工'), h('div', { className: 'st-item-body' }, h('div', null, x.label), x.reason ? h('div', { className: 'dra-hint' }, x.reason) : null)))) : null,
      st.preview.backups.length ? h('div', { className: 'dra-hint' }, '最近备份：' + st.preview.backups.map((b) => b.name + (b.at ? '（' + coreFmtTime(b.at) + '）' : '')).join('；')) : null) : null,
    st.msg ? h(Banner, { tone: st.msg.tone, title: st.msg.text }) : null,
    h('p', { className: 'dra-hint st-foot' }, '一键修复只改托管块并备份，写后校验；不会改动其它插件配置。'))
  }

  function ChannelCard(p) {
    const hub = p.hub || {}
    const sum = settingsLinkSummary(hub.link)
    const rows = settingsLinkRows(hub.link, hub.nodes)
    const lv = settingsListenerView(hub.caps, p.now)
    return h(Card, { title: '通道与审计', sub: '全局视图；每台机器的状态在「机器」屏', className: 'st-sec' },
      h('div', { className: 'dra-col' },
        h('div', null,
          h('div', { className: 'dra-field-label' }, '可靠通道（待送达消息）'),
          h('p', { className: 'dra-hint st-foot' }, '主机与节点之间的协作消息先写进磁盘再发送，对方就绪后自动重发，没有超时、不会丢；对方离线多久都会留着。'),
          hub.loading ? h('div', { className: 'dra-hint' }, '读取中…') : h('div', { className: 'dra-row' }, h(Badge, { tone: sum.available ? (sum.total === 0 ? 'ok' : 'warn') : '' }, sum.available ? (sum.total === 0 ? '无积压' : '有积压') : '不可用'), h('span', null, sum.text)),
          rows.length ? h('ul', { className: 'st-group st-list st-stagger' }, rows.map((r) => h('li', { key: r.nodeId, className: 'st-row st-item st-node' },
            h('span', { className: 'dra-dot warn st-park', role: 'img', 'aria-label': '消息在等对方就绪', title: '消息在等对方就绪' }),
            h(Badge, { tone: r.online ? 'ok' : 'warn' }, r.online ? '在线' : '离线'),
            h('div', { className: 'st-item-body' },
              h('div', null, (r.name ? r.name + ' · ' : '') + r.nodeId),
              h('div', { className: 'dra-hint' }, '待送达 ' + r.pending + ' 条 · 最久等了 ' + r.oldestText + ' · 已重试 ' + r.tries + ' 次'),
              r.types.length ? h('div', { className: 'dra-hint dra-mono' }, r.types.map((t) => t.type + ' ×' + t.count).join('  ')) : null),
            h('span', { className: 'st-count', 'aria-hidden': 'true', title: '待送达条数' }, r.pending)))) : null),
        lv.listener || lv.reach ? h('div', null,
          h('div', { className: 'dra-field-label' }, '监听与可达性'),
          h('div', { className: 'st-group st-list' },
          lv.listener ? h('div', { className: 'st-row st-line' }, h(Badge, { tone: lv.listener.tone }, lv.listener.label), h('span', { className: 'dra-hint dra-wrap' }, lv.listener.detail)) : null,
          lv.reach ? h('div', { className: 'st-row st-line' }, h(Badge, { tone: lv.reach.tone }, lv.reach.label), h('span', { className: 'dra-hint dra-wrap' }, [lv.reach.where, lv.reach.detail].filter(Boolean).join(' · '))) : null)) : null))
  }

  function RoleCard(p) {
    const plan = p.plan
    const info = settingsRoleInfo[settingsRolePlan(p.role).role]
    return h(Card, { className: 'st-sec', title: '角色', actions: h('button', { type: 'button', className: 'dra-btn sm', onClick: p.onSwitchRole }, '切换角色') },
      h('div', { className: 'st-group st-list' },
        h('div', { className: 'st-row' }, h('span', { className: 'st-row-label' }, '当前角色'), h('span', { className: 'dra-row' }, h(Badge, { tone: 'acc' }, settingsRoleName(p.role)), info ? h('span', null, info.tagline) : null))),
      info ? h('p', { className: 'dra-hint st-foot' }, info.detail) : null,
      h('p', { className: 'dra-hint st-foot' }, '切换会重写 profile 的 cordis.patch.yml（先备份），重启 DSH 后生效。'),
      plan && plan.both ? h('div', { className: 'st-both' }, h('div', { className: 'st-sec-title' }, '本机副机'), h(WorkerCard, { worker: p.worker, hideHint: true })) : null)
  }

  /* ── 设置抽屉 ───────────────────────────────────────────────────── */

  function Drawer(p) {
    const ref = React.useRef(null)
    const dialogOpen = React.useRef(false)
    const closeRef = React.useRef(p.onClose)
    closeRef.current = p.onClose
    React.useEffect(() => {
      const prev = typeof document !== 'undefined' ? document.activeElement : null
      if (ref.current && ref.current.focus) ref.current.focus()
      const onKey = (e) => { if (e.key === 'Escape' && !dialogOpen.current) closeRef.current() }
      document.addEventListener('keydown', onKey)
      return () => { document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus() }
    }, [])
    const trap = (e) => {
      if (e.key !== 'Tab' || !ref.current) return
      const nodes = Array.prototype.slice.call(ref.current.querySelectorAll('button:not([disabled]),input:not([disabled]),select,textarea,summary,a[href],[tabindex]:not([tabindex="-1"])'))
      const next = settingsNextFocus(nodes.indexOf(document.activeElement), nodes.length, e.shiftKey)
      if (next < 0) return
      e.preventDefault()
      nodes[next].focus()
    }
    /* 确认框由外壳画在抽屉之外：它开着时 Esc 不该把抽屉关掉。 */
    const ui = Object.assign({}, p.ui, {
      confirm: (msg) => { dialogOpen.current = true; return Promise.resolve(p.ui.confirm(msg)).then((v) => { dialogOpen.current = false; return v }) },
    })
    const plan = p.plan || {}
    const hub = p.hub || {}
    return h('div', { className: 'dra-drawer-wrap', onClick: (e) => { if (e.target === e.currentTarget) p.onClose() } },
      h('div', { className: 'dra-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'st-drawer-title', tabIndex: -1, ref, onKeyDown: trap },
        h('header', { className: 'st-drawer-head' },
          h('h2', { id: 'st-drawer-title', className: 'st-title' }, '设置'),
          h(Badge, { tone: 'acc' }, settingsRoleName(p.role)),
          h('span', { className: 'dra-spacer' }),
          h('button', { type: 'button', className: 'dra-btn sm', onClick: p.onClose }, '关闭')),
        h(RoleCard, { role: p.role, plan, worker: p.worker, onSwitchRole: p.onSwitchRole }),
        h(ConfigEditor, { role: p.role, plan, ui, refresh: p.refresh, transportSummary: hub.transportSummary }),
        plan.hub ? h(EnvCard, { ui }) : null,
        plan.hub ? h(ChannelCard, { hub, now: hub.at || undefined }) : null))
  }

  const css = [
    /* ── 通用：分组列表（iOS 风格的内嵌圆角组，行间发丝线，行 = 标签在左 / 值在右） ── */
    '.st-group{border:1px solid var(--dra-border);border-radius:var(--dra-r-md);background:var(--dra-sheen),var(--dra-glass);backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);box-shadow:var(--dra-hl),var(--dra-shadow);min-width:0}',
    '.st-pad{padding:12px 14px}',
    '.st-list{margin:0;padding:0;list-style:none;overflow:hidden}',
    '.st-row{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:10px 14px;min-width:0}',
    '.st-row+.st-row{border-top:1px solid color-mix(in srgb,var(--dra-border) 75%,transparent)}',
    '.st-row dt,.st-row-label{flex:none;color:var(--dra-text-dim)}',
    '.st-row dd{flex:1;margin:0;min-width:0;text-align:right;overflow-wrap:anywhere}',
    '.st-foot{margin:2px 6px 0}',
    '.st-err{color:var(--dra-danger)}',
    '.st-head{margin:0 0 4px;font-size:18px;font-weight:700;letter-spacing:-.02em;outline:none}',
    '.st-center{text-align:center}',
    '.st-title{margin:0;font-size:20px;font-weight:700;letter-spacing:-.02em}',

    /* ── 向导：胶囊进度条，当前步亮起，走过的步打勾 ── */
    '.st-setup{max-width:780px}',
    '.st-steps{display:flex;gap:4px;list-style:none;margin:0;padding:4px;border:1px solid var(--dra-border);border-radius:var(--dra-r-pill);background:color-mix(in srgb,var(--dra-surface-1) 70%,transparent);box-shadow:inset 0 1px 3px color-mix(in srgb,var(--dra-bg) 70%,transparent)}',
    '.st-step{flex:1 1 0;min-width:0;display:flex;align-items:center;justify-content:center;gap:8px;padding:6px 12px;border-radius:var(--dra-r-pill);color:var(--dra-text-dim);font-size:12px;font-weight:500;transition:background-color .3s var(--dra-ease),color .2s,box-shadow .3s var(--dra-ease)}',
    '.st-step>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.st-step-n{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--dra-surface-3);font-variant-numeric:tabular-nums;font-size:12px;font-weight:600}',
    '.st-step.on{color:var(--dra-on-primary);background:var(--dra-primary);font-weight:600;animation:st-glow 2.6s ease-in-out infinite}',
    '.st-step.on .st-step-n{background:color-mix(in srgb,var(--dra-on-primary) 18%,transparent);color:var(--dra-on-primary)}',
    '.st-step.done{color:var(--dra-ok)}',
    '.st-step.done .st-step-n{background:color-mix(in srgb,var(--dra-ok) 22%,transparent);color:var(--dra-ok);animation:dra-pop .45s var(--dra-spring) both}',
    '@keyframes st-glow{0%,100%{box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dra-on-primary) 25%,transparent),0 0 0 0 color-mix(in srgb,var(--dra-accent) 0%,transparent)}50%{box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dra-on-primary) 25%,transparent),0 0 20px 1px color-mix(in srgb,var(--dra-accent) 55%,transparent)}}',

    /* ── 角色选择：三块大玻璃选择卡；选中 = 极光描边（旋转）+ 对勾，不只靠颜色 ── */
    '.st-roles{border:0;margin:0 0 14px;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;min-width:0}',
    '.st-roles legend{padding:0 0 8px}',
    '.st-role{position:relative;display:flex;flex-direction:column;gap:10px;align-items:flex-start;border:1.5px solid var(--dra-border);border-radius:var(--dra-r-lg);background:var(--dra-sheen),var(--dra-glass);backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);box-shadow:var(--dra-hl),var(--dra-shadow);padding:16px 16px 14px;cursor:pointer;transition:border-color .2s var(--dra-ease),box-shadow .25s var(--dra-ease),transform .3s var(--dra-spring)}',
    '.st-role:hover{border-color:var(--dra-border-strong);box-shadow:var(--dra-hl),var(--dra-elev-2)}',
    '.st-role:active{transform:scale(.98)}',
    '.st-role:focus-within{outline:2px solid var(--dra-accent);outline-offset:2px}',
    '.st-role.on{border-color:transparent;background:var(--dra-sheen) padding-box,linear-gradient(var(--dra-surface-2),var(--dra-surface-2)) padding-box,conic-gradient(from var(--dra-angle),var(--dra-accent),var(--dra-accent-2),var(--dra-accent-3),var(--dra-accent)) border-box;box-shadow:var(--dra-hl),var(--dra-glow);animation:dra-spin 5s linear infinite}',
    '.st-role input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}',
    '.st-role-glyph{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:var(--dra-r-md);background:var(--dra-sheen),var(--dra-surface-3);box-shadow:var(--dra-hl);font-size:24px;line-height:1;color:var(--dra-accent)}',
    '.st-role.on .st-role-glyph{background:var(--dra-primary);color:var(--dra-on-primary)}',
    '.st-check{position:absolute;top:12px;right:12px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--dra-primary);color:var(--dra-on-primary);font-size:13px;font-weight:700}',
    '.st-role-body{display:flex;flex-direction:column;gap:3px;min-width:0}.st-role-body b{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:15px;letter-spacing:-.01em}',
    '.st-role-tag{font-weight:500}',

    /* ── 连接信息：配对盒子是内凹虚线组 ── */
    '.st-pair{display:flex;flex-direction:column;gap:8px;margin-bottom:12px;border-style:dashed;border-color:var(--dra-border-strong);box-shadow:inset 0 1px 3px color-mix(in srgb,var(--dra-bg) 60%,transparent)}',
    '.st-toks{margin:0}.st-tok{align-items:center}',
    '.st-acts{justify-content:flex-start;align-items:center;flex-wrap:wrap}',

    /* ── 确认页 / 完成页：抬高的玻璃摘要；完成页有一次性的弹入对勾章 ── */
    '.st-summary.dra-card{border-color:var(--dra-border-strong);box-shadow:var(--dra-hl),var(--dra-elev-2)}',
    '.st-summary .dra-card-body{display:flex;flex-direction:column;gap:12px}',
    '.st-seal{position:relative;align-self:center;display:flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;background:var(--dra-primary);color:var(--dra-on-primary);font-size:32px;font-weight:700;box-shadow:var(--dra-hl),0 14px 30px -10px color-mix(in srgb,var(--dra-accent) 80%,transparent);animation:st-seal .7s var(--dra-spring) both}',
    '.st-seal::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--dra-accent);animation:st-ripple 1.1s .25s var(--dra-ease) both}',
    '@keyframes st-seal{0%{opacity:0;transform:scale(.4) rotate(-20deg)}100%{opacity:1;transform:none}}',
    '@keyframes st-ripple{0%{opacity:.8;transform:scale(1)}100%{opacity:0;transform:scale(2)}}',
    '.st-warns{margin:0;padding:0;list-style:none}',

    /* ── 设置抽屉 / 副机页：分区去掉外框，内容是分组列表 ── */
    '.st-drawer-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;margin:-18px -20px 0;padding:16px 20px 12px;background:var(--dra-glass-strong);backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);border-bottom:1px solid color-mix(in srgb,var(--dra-border) 75%,transparent);border-radius:var(--dra-r-xl) 0 0 0}',
    '.st-sec.dra-card,.st-sec.dra-card:hover{background:none;border:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;border-radius:0}',
    '.st-sec .dra-card-head{border:0;padding:2px 6px 8px}',
    '.st-sec .dra-card-title{font-size:15px}',
    '.st-sec .dra-card-body{padding:0;display:flex;flex-direction:column;gap:10px}',
    '.st-sec-title{margin:0 6px 2px;font-size:13px;font-weight:600;color:var(--dra-text-dim)}',
    '.st-both{display:flex;flex-direction:column;gap:6px}',

    /* ── 体检 / 通道：行逐个弹入，状态字形弹出；修复预览是内凹面板 ── */
    '.st-item{align-items:flex-start;justify-content:flex-start}',
    '.st-item-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.st-item-label{font-weight:500}',
    '.st-state{flex:none;display:inline-flex;align-items:center;gap:6px;min-width:76px;font-weight:600;white-space:nowrap}',
    '.st-state.ok{color:var(--dra-ok)}.st-state.warn{color:var(--dra-warn)}.st-state.bad{color:var(--dra-danger)}',
    '.st-glyph{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;font-size:12px;font-weight:700;background:color-mix(in srgb,currentColor 16%,transparent);border:1px solid color-mix(in srgb,currentColor 45%,transparent)}',
    '.st-stagger>.st-row{--st-d:0s;animation:st-in .55s var(--dra-spring) var(--st-d) both}',
    '.st-stagger>.st-row:nth-child(2){--st-d:.06s}.st-stagger>.st-row:nth-child(3){--st-d:.12s}.st-stagger>.st-row:nth-child(4){--st-d:.18s}.st-stagger>.st-row:nth-child(5){--st-d:.24s}.st-stagger>.st-row:nth-child(6){--st-d:.3s}.st-stagger>.st-row:nth-child(7){--st-d:.36s}.st-stagger>.st-row:nth-child(8){--st-d:.42s}.st-stagger>.st-row:nth-child(n+9){--st-d:.48s}',
    '.st-stagger>.st-row .st-glyph{animation:dra-pop .5s var(--dra-spring) calc(var(--st-d) + .2s) both}',
    '@keyframes st-in{0%{opacity:0;transform:translateY(10px) scale(.98)}100%{opacity:1;transform:none}}',
    '.st-fix{flex:1;font-family:var(--dra-mono)}',
    '.st-preview{margin:0;padding:12px 14px;border:1px dashed var(--dra-border-strong);border-radius:var(--dra-r-md);background:color-mix(in srgb,var(--dra-bg) 45%,var(--dra-surface-1));box-shadow:inset 0 2px 6px color-mix(in srgb,var(--dra-bg) 70%,transparent)}',
    '.st-items{list-style:none;margin:8px 0;padding:0;display:flex;flex-direction:column;gap:8px}',
    '.st-line{align-items:center;justify-content:flex-start;flex-wrap:wrap}',
    '.dra-dot.warn.st-park{width:10px;height:10px;margin-top:4px;animation:dra-breathe 1.8s ease-out infinite}',
    '.st-node .st-item-body{gap:1px}',
    '.st-count{flex:none;align-self:center;min-width:28px;padding:1px 9px;border-radius:var(--dra-r-pill);text-align:center;font-variant-numeric:tabular-nums;font-weight:700;color:var(--dra-warn);background:color-mix(in srgb,var(--dra-warn) 14%,transparent);border:1px solid color-mix(in srgb,var(--dra-warn) 40%,transparent)}',

    /* ── 副机计数器：大号等宽数字 ── */
    '.st-counters .dra-stat-value{font-size:30px;letter-spacing:-.03em}',

    /* ── 降级：没有毛玻璃 / 要求减少透明度时换实色面；强制颜色模式下选中靠边框 ── */
    '@supports not (backdrop-filter:blur(1px)){.st-group,.st-role,.st-drawer-head{background:var(--dra-surface-1)}}',
    '@media (prefers-reduced-transparency:reduce){.st-group,.st-role,.st-drawer-head{background:var(--dra-surface-1);backdrop-filter:none;-webkit-backdrop-filter:none}}',
    '@media (forced-colors:active){.st-role.on{border:2px solid Highlight}.st-step.on{border:2px solid Highlight}.st-group,.st-role{border:1px solid CanvasText}}',
  ]

  return { css, Setup, WorkerView, Drawer }
}
