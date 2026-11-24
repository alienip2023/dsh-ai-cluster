/**
 * 机群屏：总览（Overview）+ 机器（Machines）。
 * 总览 = 提示横幅 + 统计 + 拓扑（SVG，确定性布局）+ 文字表格；机器 = 节点卡 + 局域网发现 + SSH 上桥 + 添加机器。
 * 顶层标识符一律以 `fleet` 开头；对外只导出 createFleet(core)。纯函数全部导出，测试直接 import。
 * 只读 props.hub（由 data.js 轮询）；自己的附加数据（ssh 主机、配对码、入网口令）只在机器屏挂载时才拉，且放进
 * 模块级 store，切屏、轮询都不会丢进度。
 */
import { coreFailure, coreFmtDur, coreFmtTime, corePct, coreShortId, coreVersionAtLeast, coreMinNodeVersion } from './core.js'

const fleetNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const fleetCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/* ── 通用 ─────────────────────────────────────────────────────────── */

export function fleetCut(text, max) {
  const s = String(text == null ? '' : text)
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function fleetAgo(at, now) {
  const t = fleetNum(at)
  return t === null ? '—' : coreFmtDur(Math.max(0, now - t)) + '前'
}

export function fleetName(n) {
  return n && typeof n === 'object' ? String(n.hostname || n.nodeId || '') : ''
}

/** 失败文案：优先后端 message，并保留稳定 code，绝不吞原文。 */
export function fleetErrText(e) {
  const f = coreFailure(e)
  const msg = f.body && typeof f.body.message === 'string' ? f.body.message : ''
  return msg && msg !== f.error ? msg + '（' + f.error + '）' : f.error
}

/** 局域网地址判定：RFC1918 / 回环 / 链路本地 / .local / 单标签主机名；allowV6 时也认 IPv6 本地段。 */
export function fleetIsLan(host, allowV6) {
  const s = String(host || '').replace(/^\[|\]$/g, '')
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (m) {
    const o = m.slice(1).map(Number)
    if (o.some((x) => x > 255)) return false
    return o[0] === 10 || o[0] === 127 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254)
  }
  if (allowV6 === true && (s === '::1' || /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]+$/i.test(s))) return true
  if (/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.local$/i.test(s)) return true
  return /^[A-Za-z0-9_-]+$/.test(s)
}

/* ── 公网地址默认隐藏：局域网地址与机器自己的名字始终可见，其余 IP / 域名 / URL 主机显示成「首段+•••」 ── */

export const fleetPrefKey = 'dra-show-public'
const fleetDots = '•••'
const fleetFileTail = ['json', 'yml', 'yaml', 'js', 'mjs', 'cjs', 'md', 'txt', 'log', 'ts', 'sh', 'ps1', 'tgz']

/** 要不要遮：不是局域网（含本地 IPv6）、也不是 0.0.0.0 / :: 这种「未指定」写法。 */
export function fleetPublicHost(host) {
  const bare = String(host == null ? '' : host).replace(/^\[|\]$/g, '')
  if (bare === '' || bare === '0.0.0.0' || bare === '::') return false
  return !fleetIsLan(bare, true)
}

/** 稳定的短形式：IPv4 取首段，IPv6 取首组，域名取首个标签；末尾统一 •••。 */
export function fleetMaskHost(host) {
  const raw = String(host == null ? '' : host)
  const bare = raw.replace(/^\[|\]$/g, '')
  let out
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare)) out = bare.split('.')[0] + '.' + fleetDots
  else if (bare.includes(':')) out = bare.split(':')[0] + ':' + fleetDots
  else out = bare.split('.')[0] + '.' + fleetDots
  return bare !== raw ? '[' + out + ']' : out
}

/** 单个地址：URL / host:port / [v6]:port / 裸主机。局域网原样返回；公网只留协议、遮后的主机和端口（路径、查询、账号全部丢掉）。 */
export function fleetMask(value) {
  const s = String(value == null ? '' : value).trim()
  if (s === '') return ''
  const url = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)(:\d+)?(?:[/?#].*)?$/i.exec(s)
  if (url) return fleetPublicHost(url[2]) ? url[1] + fleetMaskHost(url[2]) + (url[3] || '') : s
  const hp = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/.exec(s)
  if (hp) return fleetPublicHost(hp[1]) ? fleetMaskHost(hp[1]) + ':' + hp[2] : s
  return fleetPublicHost(s) ? fleetMaskHost(s) : s
}

/** URL / host:port / 裸主机里的主机部分（用来判断公网与否）。 */
export function fleetHostOf(value) {
  const s = String(value == null ? '' : value).trim()
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)/i.exec(s)
  if (url) return url[1]
  const hp = /^(\[[^\]]+\]|[^:\s]+):\d{1,5}$/.exec(s)
  return hp ? hp[1] : s
}

/** 显示用：开关打开原样，否则遮。复制按钮不走这里，永远复制原值。 */
export function fleetShowAddr(value, show) {
  return show === true ? String(value == null ? '' : value) : fleetMask(value)
}

const fleetTextAddr = new RegExp([
  '[a-z][a-z0-9+.-]*:\\/\\/[^\\s\'"<>()]*[^\\s\'"<>().,;:，。；]', // URL
  '\\[[0-9a-f:.]+\\](?::\\d{1,5})?', // [v6]:port
  '\\b\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d{1,5})?\\b', // IPv4[:port]
  '(?:[0-9a-f]{0,4}:){2,7}:?[0-9a-f]{0,4}(?=[\\s)，。；,;]|$)', // IPv6（至少带 ::，不碰 12:30:45 这种时间）
  '\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}(?::\\d{1,5})?\\b', // 域名[:port]
].join('|'), 'gi')

/** 一段自由文本（错误、提示、日志）里的地址：局域网与文件名保持，其余按开关遮。 */
export function fleetMaskText(text, show) {
  const s = String(text == null ? '' : text)
  if (show === true) return s
  return s.replace(fleetTextAddr, (m) => {
    if (/^(?:[0-9a-f]{0,4}:){2,7}:?[0-9a-f]{0,4}$/i.test(m) && !m.includes('::') && m.split(':').length < 8) return m
    const tail = /\.([a-z0-9]+)$/i.exec(m)
    if (tail && fleetFileTail.includes(tail[1].toLowerCase()) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(m)) return m
    return fleetMask(m)
  })
}

/* ── 节点派生值 ───────────────────────────────────────────────────── */

export const fleetStaleText = '心跳超时'
export const fleetStatusText = { online: '在线', stale: '在线 · ' + fleetStaleText, offline: '离线' }
export const fleetTransportText = { direct: '直连', relay: '中继', unknown: '连接方式未知' }

/** 只有在线节点才可能「心跳超时」；离线就是离线。 */
export function fleetStatus(n) {
  if (!n || n.online !== true) return 'offline'
  return n.stale === true ? 'stale' : 'online'
}

export function fleetTransport(n) {
  const c = n && n.connectivity && typeof n.connectivity === 'object' ? n.connectivity : null
  const mode = (n && n.transportMode) || (c && c.transportMode) || ''
  return mode === 'direct' || mode === 'relay' ? mode : 'unknown'
}

/** 展示用地址：peerHost / hostname 里优先挑局域网地址，否则取第一个有值的。 */
export function fleetAddress(n) {
  const list = [n && n.address, n && n.peerHost, n && n.hostname].filter((a) => typeof a === 'string' && a !== '')
  return list.find((a) => fleetIsLan(a, true)) || list[0] || ''
}

/** 链路类别：只看节点自己上报的 transportMode；缺失/非法一律「未知」，不用别处的字段推断。 */
export function fleetLinkKind(n) {
  const mode = n && typeof n.transportMode === 'string' ? n.transportMode : ''
  if (mode === 'relay') return '中继'
  if (mode !== 'direct') return '未知'
  return fleetIsLan(fleetAddress(n), true) ? '局域网直连' : '直连'
}

/** 延迟：直连的帧 RTT 最新样本优先，否则探测里最小的 rttMs；没测过就是 null，绝不补 0。 */
export function fleetRtt(n) {
  const fr = n && Array.isArray(n.frameRttMs) ? n.frameRttMs.filter((x) => fleetNum(x) !== null && x >= 0) : []
  if (fr.length > 0) return { kind: 'frame', ms: Math.round(fr[fr.length - 1]) }
  const c = n && n.connectivity && typeof n.connectivity === 'object' ? n.connectivity : null
  let best = null
  for (const p of c && Array.isArray(c.probes) ? c.probes : []) {
    const ms = p ? fleetNum(p.rttMs) : null
    if (ms !== null && ms >= 0) best = best === null ? ms : Math.min(best, ms)
  }
  return best === null ? null : { kind: 'probe', ms: Math.round(best) }
}

export function fleetRttText(n) {
  if (!n || n.online !== true) return '—'
  const r = fleetRtt(n)
  return r ? (r.kind === 'frame' ? '帧 RTT ' : '探测 ') + r.ms + 'ms' : '延迟未测'
}

/** 帧 RTT 折线：纯函数，返回 SVG points；一个样本给 null（调用方画点）。 */
export function fleetSpark(samples, w, hh) {
  const list = (Array.isArray(samples) ? samples : []).filter((x) => fleetNum(x) !== null)
  if (list.length < 2) return null
  const max = Math.max(1, ...list)
  return list.map((ms, i) => fleetR1(1 + (w - 2) * i / (list.length - 1)) + ',' + fleetR1(hh - 1 - (hh - 2) * (ms / max))).join(' ')
}

export function fleetLoad(n) {
  const res = n && n.resource
  if (!res || typeof res !== 'object') return { reported: false }
  const cpu = fleetNum(res.cpuPct)
  const used = fleetNum(res.memUsedMb)
  const total = fleetNum(res.memTotalMb)
  return {
    reported: true,
    cpu,
    cpuLabel: cpu === null ? '?' : Math.round(cpu) + '%',
    cpuPct: cpu === null ? 0 : corePct(cpu),
    memLabel: (used === null ? '?' : used) + '/' + (total === null ? '?' : total) + ' MB',
    memPct: used !== null && total !== null && total > 0 ? corePct(used / total * 100) : 0,
    at: fleetNum(res.at),
  }
}

export function fleetQueue(n) {
  const q = n && n.queue
  if (!q || typeof q !== 'object') return null
  const queued = fleetNum(q.queued) || 0
  const running = fleetNum(q.running) || 0
  const max = fleetNum(q.maxConcurrent) || 0
  const oldest = fleetNum(q.oldestQueuedMs) || 0
  return {
    starved: q.starved === true,
    text: '排队 ' + queued + ' · 运行 ' + running + (max > 0 ? '/' + max : ''),
    warn: q.starved === true ? '排队被占满：最久已排 ' + coreFmtDur(oldest) : '',
  }
}

const fleetTunnelText = { ready: '就绪', configured: '已配置', error: '异常', none: '无' }
const fleetProbeText = { open: '可达', closed: '拒绝', timeout: '超时' }

export function fleetProbeRows(n, show) {
  const c = n && n.connectivity && typeof n.connectivity === 'object' ? n.connectivity : null
  return (c && Array.isArray(c.probes) ? c.probes : []).filter((p) => p && p.target).map((p) => ({
    target: fleetShowAddr(p.target, show),
    text: fleetProbeText[p.result] || '超时',
    ok: p.result === 'open',
    rtt: fleetNum(p.rttMs),
  }))
}

/** 一行链路摘要：隧道 · 探测可达数 · 采样时间。 */
export function fleetConnLine(n, now) {
  const c = n && n.connectivity && typeof n.connectivity === 'object' ? n.connectivity : null
  if (!c) return '链路详情未上报'
  const probes = fleetProbeRows(n)
  const parts = ['隧道 ' + (fleetTunnelText[c.tunnelState] || '未知')]
  if (probes.length > 0) parts.push('探测 ' + probes.filter((p) => p.ok).length + '/' + probes.length + ' 可达')
  const at = fleetNum(c.sampledAt)
  parts.push(at === null ? '采样时间未知' : '采样 ' + fleetAgo(at, now) + (now - at > 600000 ? '（陈旧）' : ''))
  return parts.join(' · ')
}

export function fleetTunnelLine(n, show) {
  const t = n && n.connectivity && n.connectivity.tunnel
  if (!t || typeof t !== 'object') return ''
  const ports = [t.localPort, t.remotePort].filter((x) => fleetNum(x) !== null)
  return [t.kind, t.server ? fleetShowAddr(t.server, show) : '', ports.length === 2 ? ports[0] + '→' + ports[1] : ''].filter(Boolean).join(' · ')
}

/** 心跳超时优先；其次采样超过 10 分钟；缺失不推断。 */
export function fleetStaleLabel(n, now) {
  if (!n) return ''
  if (n.stale === true) return fleetStaleText
  const c = n.connectivity && typeof n.connectivity === 'object' ? n.connectivity : null
  const at = c ? fleetNum(c.sampledAt) : null
  return at !== null && now - at > 600000 ? '采样陈旧' : ''
}

/** 在线：静默多久；离线：最后在线时间。 */
export function fleetLastSeen(n, now) {
  if (!n) return '—'
  if (n.online === true) {
    const s = fleetNum(n.silentMs)
    return s === null ? '在线' : '静默 ' + Math.round(s / 1000) + ' 秒'
  }
  const at = fleetNum(n.lastSeen)
  return at === null ? '最后在线时间未知' : '最后在线 ' + coreFmtTime(at) + '（' + fleetAgo(at, now) + '）'
}

/** 连续「心跳超时」计数：prev 是上一轮的 { nodeId: 次数 }。stale 未知(null)时保持原值。 */
export const fleetStaleLimit = 2
export function fleetStaleCounts(prev, nodes) {
  const old = prev && typeof prev === 'object' ? prev : {}
  const next = {}
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || !n.nodeId) continue
    if (n.stale === true) next[n.nodeId] = (old[n.nodeId] || 0) + 1
    else if (n.stale === false) next[n.nodeId] = 0
    else if (old[n.nodeId] !== undefined) next[n.nodeId] = old[n.nodeId]
  }
  return next
}

export function fleetHealth(n, count) {
  if (!n || typeof n.stale !== 'boolean') return '健康：未知'
  if (!count) return '健康：稳定'
  return count >= fleetStaleLimit ? '健康：连续失败' : '健康：探测失败 ' + count + '/' + fleetStaleLimit
}

/** AC 版本：absent/不可解析 = 版本未知，不是旧。 */
export function fleetVersion(n) {
  const v = n && typeof n.acVersion === 'string' ? n.acVersion : ''
  const ok = coreVersionAtLeast(v, coreMinNodeVersion)
  return { version: v, state: ok === null ? 'unknown' : ok ? 'ok' : 'old' }
}

export function fleetVersionText(n) {
  const v = fleetVersion(n)
  if (v.state === 'unknown') return '版本未知'
  return 'v' + v.version + (v.state === 'old' ? ' · 低于 ' + coreMinNodeVersion : '')
}

/** 可靠通道积压（node.link，来自 /link-status）。没有积压返回 null。 */
export function fleetBacklog(n) {
  const l = n && n.link
  const pending = l ? fleetNum(l.pending) : null
  if (pending === null || pending <= 0) return null
  const oldest = fleetNum(l.oldestMs)
  const types = Object.entries(l.types && typeof l.types === 'object' ? l.types : {}).sort((a, b) => b[1] - a[1] || fleetCmp(a[0], b[0])).slice(0, 4)
  return {
    pending,
    oldestMs: oldest,
    maxTries: fleetNum(l.maxTries) || 0,
    types,
    online: n.online === true,
    text: pending + ' 条待送达' + (oldest === null ? '' : '，最久等了 ' + coreFmtDur(oldest)),
  }
}

export function fleetBacklogTotals(nodes) {
  const rows = []
  let total = 0
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const b = fleetBacklog(n)
    if (b) { rows.push({ node: n, backlog: b }); total += b.pending }
  }
  return { rows, total }
}

/* ── 任务活动 ─────────────────────────────────────────────────────── */

export function fleetTaskState(status) {
  if (status === 'running') return 'running'
  if (status === 'queued' || status === 'pending_approval') return 'queued'
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'aborted' || status === 'interrupted' || status === 'rejected') return 'failed'
  return 'other'
}

export function fleetActivity(tasks) {
  const out = {}
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || t.nodeId == null) continue
    const a = out[t.nodeId] || (out[t.nodeId] = { running: 0, queued: 0, done: 0, failed: 0, total: 0 })
    const s = fleetTaskState(t.status)
    if (s !== 'other') a[s] += 1
    a.total += 1
  }
  return out
}

export function fleetActivityText(a) {
  if (!a || a.total === 0) return '无任务'
  const parts = []
  if (a.running) parts.push(a.running + ' 运行')
  if (a.queued) parts.push(a.queued + ' 排队')
  if (a.done) parts.push(a.done + ' 完成')
  if (a.failed) parts.push(a.failed + ' 失败')
  return parts.length ? parts.join(' · ') : a.total + ' 个任务'
}

/* ── 提示横幅（纯数据，组件只负责画） ─────────────────────────────── */

/** 中继状态三态：只有明确写 reachable === false 才是不可达；明确 true 才是可达；其余「未上报」。 */
export function fleetRelayStatus(connection, relay) {
  const flags = [relay && relay.reachable, connection && connection.relay && connection.relay.reachable, connection && connection.relayReachable]
  if (flags.some((v) => v === false)) return 'unreachable'
  if (flags.some((v) => v === true)) return 'reachable'
  return 'unreported'
}
export const fleetRelayText = { unreported: '中继：未上报', unreachable: '中继：不可达', reachable: '中继：上报可达' }

/** 独立监听状态 → 提示。正常监听返回 null。 */
export function fleetListenerNotice(l, now, show) {
  if (!l || typeof l !== 'object') return null
  if (l.ok === true || l.state === 'listening') return null
  const since = fleetNum(l.waitingSince)
  let body
  if (l.state === 'waiting-port') body = '独立监听端口被占用，正在等待释放' + (since === null ? '' : '（已等待 ' + Math.max(0, Math.round((now - since) / 1000)) + ' 秒）') + '；端口空出后会自动接上。'
  else if (l.disabled) body = '独立监听已关闭（' + fleetMaskText(l.disabled, show) + '），副机只能走 DSH webserver 通道。'
  else if (l.error) body = '独立监听启动失败：' + fleetMaskText(l.error, show) + '（改 listenPort / listenHost 后重启）。'
  else body = '独立监听尚未就绪（刚启动？稍后刷新）。'
  return { key: 'listener', tone: 'warn', title: '副机接入监听没有在工作', body }
}

export function fleetNotices(hub, now, show) {
  const out = []
  const nodes = hub && Array.isArray(hub.nodes) ? hub.nodes : []
  const caps = hub && hub.caps ? hub.caps : null
  const reach = caps && caps.reachability ? caps.reachability : null
  const conn = hub && hub.connection ? hub.connection : null
  const loopback = reach !== null && reach.loopback === true
  if (loopback) {
    out.push({
      key: 'loopback', tone: 'err', title: '主机只监听本机回环地址，副机永远连不上',
      body: [fleetMaskText(reach.hint, show), reach.bound ? '当前绑定 ' + fleetShowAddr(reach.bound, show) + (reach.port ? ':' + reach.port : '') : ''].filter(Boolean).join(' ') || '请把监听地址改成局域网地址后重启 DSH。',
    })
  }
  const ln = fleetListenerNotice(caps && caps.listener, now, show)
  if (ln) out.push(ln)
  const recent = conn && Array.isArray(conn.recent) ? conn.recent : []
  if (conn && conn.everConnected !== true && (nodes.length > 0 || recent.length > 0)) {
    const diag = (conn.reachability && conn.reachability.hint) || (reach && reach.hint) || ''
    const showDiag = diag !== '' && !(loopback && diag === reach.hint)
    out.push({
      key: 'never', tone: 'warn', title: '还没有连上过',
      body: (nodes.length > 0 ? '有 ' + nodes.length + ' 个节点登记过，但从未成功握手。' : '') + '检查独立监听、中继地址与口令；地址不能是 0.0.0.0。' + (showDiag ? ' 诊断：' + fleetMaskText(diag, show) : ''),
      go: 'machines', goLabel: '去「机器」看接入',
    })
  }
  const old = nodes.filter((n) => fleetVersion(n).state === 'old')
  if (old.length > 0) {
    out.push({
      key: 'old', tone: 'warn', title: old.length + ' 台机器的 AC 版本低于 ' + coreMinNodeVersion,
      body: old.map((n) => fleetName(n) + ' ' + fleetVersionText(n)).join('；') + '。Bot 协作的新协议需要升级这些机器上的 dsh-ai-cluster。',
      go: 'machines', goLabel: '查看机器',
    })
  }
  const bl = fleetBacklogTotals(nodes)
  if (bl.rows.length > 0) {
    out.push({
      key: 'backlog', tone: 'warn', title: bl.rows.length + ' 台机器有消息还没送达（共 ' + bl.total + ' 条）',
      body: '消息会一直保留，没有超时；机器回来后自动补发，不需要重发。 '
        + bl.rows.map((r) => fleetName(r.node) + (r.backlog.online ? '（在线，补发中）' : '（离线）') + '：' + r.backlog.text).join('；'),
      go: 'machines', goLabel: '查看机器',
    })
  }
  return out
}

export function fleetAttemptRows(connection) {
  const rows = connection && Array.isArray(connection.recent) ? connection.recent : []
  return rows.slice(0, 20).map((e, i) => ({
    key: i + ':' + (e.at || 0),
    at: fleetNum(e.at) || 0,
    ok: e.result === 'ok',
    title: e.title || e.code || (e.result === 'ok' ? '连接成功' : '连接失败'),
    remote: e.remote || '',
    nodeId: e.nodeId || '',
    detail: e.detail || '',
    hint: e.hint || '',
  }))
}

export function fleetTransportLine(hub) {
  const s = hub && hub.transportSummary
  const t = hub && hub.topology && hub.topology.summary
  const parts = []
  if (s && s.label) parts.push('连接方式：' + s.label)
  if (t) {
    parts.push('直连 ' + (t.direct || 0) + ' · 中继 ' + (t.relay || 0) + ' · 未知 ' + (t.unknown || 0))
    parts.push('隧道就绪 ' + (t.tunnelReady || 0) + (t.tunnelError ? ' · 异常 ' + t.tunnelError : ''))
  }
  return parts.join('　')
}

/* ── 对等候选（服务端只列「双方都上报了对等地址」的候选，不是链路探测结果） ── */

export const fleetPairCap = 60
export const fleetPreviewCap = 6
const fleetBlank = (v) => typeof v !== 'string' || v.trim() === ''

/**
 * topology 来自 /overview（服务端 peerLinks，最多 60 对）；nodes 是画出来的机器。
 * 只收两端都是「在线且对等」的有效对；不补缺失的对，不假设完全图。
 * 图上预览只连「在线且没有心跳超时」的对端，完整邻居列表不截断。
 */
export function fleetPeerModel(topology, nodes) {
  const t = topology && typeof topology === 'object' && !Array.isArray(topology) ? topology : null
  const raw = t && Array.isArray(t.peerLinks) ? t.peerLinks : null
  const server = t && t.summary ? fleetNum(t.summary.peerCapable) : null
  const drawn = {}
  for (const n of Array.isArray(nodes) ? nodes : []) if (n && typeof n.nodeId === 'string' && n.nodeId !== '' && !drawn[n.nodeId]) drawn[n.nodeId] = n
  const live = (id) => !!drawn[id] && drawn[id].online === true && drawn[id].stale !== true
  const eligible = {}
  for (const e of t && Array.isArray(t.nodes) ? t.nodes : []) {
    if (e && !fleetBlank(e.nodeId) && e.online === true && e.peerCapable === true) eligible[e.nodeId] = true
  }
  const seen = {}
  const pairs = []
  let dropped = 0
  for (const l of raw || []) {
    if (!l || fleetBlank(l.from) || fleetBlank(l.to) || l.from === l.to || eligible[l.from] !== true || eligible[l.to] !== true) { dropped += 1; continue }
    const lo = l.from < l.to ? l.from : l.to
    const hi = l.from < l.to ? l.to : l.from
    if (seen[lo + '\u0000' + hi]) continue
    seen[lo + '\u0000' + hi] = true
    pairs.push([lo, hi])
  }
  pairs.sort((x, y) => fleetCmp(x[0], y[0]) || fleetCmp(x[1], y[1]))
  const neighbors = {}
  for (const p of pairs) {
    (neighbors[p[0]] = neighbors[p[0]] || []).push(p[1]);
    (neighbors[p[1]] = neighbors[p[1]] || []).push(p[0])
  }
  for (const id of Object.keys(neighbors)) neighbors[id].sort(fleetCmp)
  const capped = raw !== null && raw.length >= fleetPairCap
  const state = raw === null ? 'missing' : raw.length === 0 ? 'empty' : 'ready'
  const label = state === 'missing' ? '对等候选：未上报'
    : state === 'empty' ? '无对等候选' + (server !== null && server <= 1 ? '（可对等的机器不足 2 台）' : '')
      : '对等候选：服务端计数 ' + (server === null ? '未上报' : server + ' 台') + ' · 收到 ' + pairs.length + ' 对有效候选'
        + (capped ? ' · 已达服务端上限 ' + fleetPairCap + '，可能不完整' : '') + (dropped > 0 ? ' · ' + dropped + ' 条被丢弃' : '')
  return {
    state, pairs, neighbors, capped, dropped, label,
    badge: (id) => (state === 'missing' ? '' : live(id) && drawn[id].peerCapable === true ? '对等 ' + (neighbors[id] ? neighbors[id].length : 0) + (capped ? '+' : '') : '—'),
    /** 某机器的邻居：preview 按 id 升序取前 cap 个在线的，overflow 是预览放不下的数量，full 不截断。 */
    view(id, cap) {
      const full = neighbors[id] ? neighbors[id].slice() : []
      const max = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : fleetPreviewCap
      const ok = live(id) ? full.filter(live) : []
      return { id, preview: ok.slice(0, max), overflow: Math.max(0, ok.length - max), full, previewable: live(id) }
    },
  }
}

/** 固定的机器还在最新列表里就保持；不在了就清掉并提示。 */
export function fleetPinState(pinned, ids) {
  const has = Array.isArray(ids) && ids.indexOf(pinned) >= 0
  return { pin: has ? pinned : '', lost: pinned !== '' && !has }
}

/** 任务指向的机器不在列表里：不丢，单独数出来。 */
export function fleetOrphans(tasks, nodes) {
  const ids = {}
  for (const n of Array.isArray(nodes) ? nodes : []) if (n && n.nodeId) ids[n.nodeId] = true
  return (Array.isArray(tasks) ? tasks : []).filter((t) => t && !ids[t.nodeId]).length
}

/* ── 局域网发现 ───────────────────────────────────────────────────── */

/** 只展示 LAN 地址名；公网/IPv6/域名一律「地址已隐藏」；已配对的机器剔除。 */
export function fleetDiscoveryRows(discovery, nodes, show) {
  if (!discovery || discovery.enabled !== true) return { enabled: false, rows: [] }
  const paired = {}
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || typeof n !== 'object') continue
    for (const k of [n.nodeId, n.hostname, n.peerHost]) if (typeof k === 'string' && k) paired[k] = true
  }
  const rows = []
  for (const p of Array.isArray(discovery.peers) ? discovery.peers : []) {
    if (!p || typeof p !== 'object') continue
    const host = typeof p.hostname === 'string' ? p.hostname : ''
    if ((typeof p.node === 'string' && paired[p.node]) || (host && paired[host])) continue
    rows.push({
      node: p.node, role: p.role, port: p.port,
      version: typeof p.pluginVersion === 'string' ? p.pluginVersion : '',
      addressLabel: !host ? '地址未上报' : show === true || fleetIsLan(host) ? host : '地址已隐藏（' + fleetMaskHost(host) + '）',
    })
  }
  return { enabled: true, rows }
}

/* ── 拓扑：节点视图模型 + 确定性布局 ───────────────────────────────── */

export function fleetNodeModel(n, act, staleCount) {
  const status = fleetStatus(n)
  const a = act || { running: 0, queued: 0, done: 0, failed: 0, total: 0 }
  const tr = fleetTransport(n)
  return {
    id: String(n.nodeId || ''), name: fleetName(n), status, transport: status === 'offline' ? 'unknown' : tr,
    rttText: fleetRttText(n), act: a, actText: fleetActivityText(a), backlog: fleetBacklog(n),
    health: status === 'offline' ? '' : fleetHealth(n, staleCount),
    /* 心跳超时的机器按断开画（边变虚、不再流动），但文字仍保留它的延迟。 */
    edgeState: status !== 'online' ? 'offline' : a.running ? 'running' : a.queued ? 'queued' : 'idle',
    edgeLabel: status === 'offline' ? '离线' : status === 'stale' ? fleetStaleText : ({ direct: '直连', relay: '中继', unknown: '未知' })[tr] + (fleetRtt(n) ? ' ' + fleetRtt(n).ms + 'ms' : ''),
  }
}

const fleetR1 = (v) => Math.round(v * 10) / 10

/** 纯函数：中心是主控，机器按 id 排序均匀排在椭圆上（超过 8 台再排外圈）。同输入同输出，无迭代、无随机。 */
export function fleetLayout(input) {
  const W = 640
  const models = input && Array.isArray(input.models) ? input.models.slice().sort((a, b) => fleetCmp(a.id, b.id)) : []
  const inner = Math.min(models.length, 8)
  const outer = models.length - inner
  const H = outer > 0 ? 440 : 320
  const hub = { x: W / 2, y: H / 2, r: 26 }
  const ring = (i, count, rx, ry, phase) => {
    const a = -Math.PI / 2 + phase + 2 * Math.PI * i / Math.max(count, 1)
    return { x: fleetR1(hub.x + Math.cos(a) * rx), y: fleetR1(hub.y + Math.sin(a) * ry) }
  }
  const nodes = models.map((m, i) => {
    const p = i < inner ? ring(i, inner, outer > 0 ? 160 : 210, outer > 0 ? 80 : 105, 0) : ring(i - inner, outer, 250, 170, Math.PI / Math.max(outer, 1))
    return Object.assign({ id: m.id, model: m }, p)
  })
  const edges = nodes.map((p) => ({
    id: 'hub>' + p.id, to: p.id, x1: hub.x, y1: hub.y, x2: p.x, y2: p.y, state: p.model.edgeState, transport: p.model.transport,
    label: p.model.edgeLabel, lx: fleetR1((hub.x + p.x) / 2), ly: fleetR1((hub.y + p.y) / 2),
  }))
  const relay = input && input.relayDown === true ? { x: W - 50, y: 34, w: 76, h: 26 } : null
  return { width: W, height: H, hub, nodes, edges, relay }
}

/* ── 机器屏：store、反应器、异步流程（可注入 io 测试） ─────────────── */

export const fleetMachInit = Object.freeze({
  showPublic: false,
  hosts: [], hostsErr: '',
  probe: {}, probing: {}, job: {}, deploying: {}, installing: {}, installErr: {},
  pair: { loading: false, data: null, note: '' },
  enroll: { loading: false, data: null, error: '' },
})

export function fleetMachReduce(s, e) {
  const set = (k, alias, v) => Object.assign({}, s[k], { [alias]: v })
  switch (e.type) {
    case 'hosts': return Object.assign({}, s, { hosts: e.hosts, hostsErr: e.err })
    case 'probe-start': return Object.assign({}, s, { probing: set('probing', e.alias, true) })
    case 'probe-done': return Object.assign({}, s, { probing: set('probing', e.alias, false), probe: set('probe', e.alias, e.result) })
    case 'deploy-start': return Object.assign({}, s, { deploying: set('deploying', e.alias, true), job: set('job', e.alias, null) })
    case 'job': return Object.assign({}, s, { job: set('job', e.alias, e.job) })
    case 'deploy-end': return Object.assign({}, s, { deploying: set('deploying', e.alias, false) })
    case 'install-start': return Object.assign({}, s, { installing: set('installing', e.alias, true), installErr: set('installErr', e.alias, '') })
    case 'install-end': return Object.assign({}, s, { installing: set('installing', e.alias, false), installErr: set('installErr', e.alias, e.err || '') })
    case 'pair-start': return Object.assign({}, s, { pair: Object.assign({}, s.pair, { loading: true, note: '' }) })
    case 'show': return Object.assign({}, s, { showPublic: e.value === true })
    case 'patch': return Object.assign({}, s, { [e.key]: e.value })
    default: return s
  }
}

/** 「显示公网地址」只记在本机浏览器里；没有存储（或被禁用）就当没记。 */
function fleetPrefRead() {
  try { return localStorage.getItem(fleetPrefKey) === '1' } catch { return false }
}
function fleetPrefWrite(on) {
  try { localStorage.setItem(fleetPrefKey, on ? '1' : '0') } catch { /* 无存储就不记 */ }
}

function fleetStore(init) {
  let state = init
  const subs = new Set()
  return {
    get: () => state,
    set(fn) { state = fn(state); for (const f of subs) f(state) },
    sub(f) { subs.add(f); return () => { subs.delete(f) } },
  }
}

export const fleetStepText = {
  connect: '连接 SSH', probe: '探测环境', upload: '上传文件', install: '校验文件', configure: '写入配置', start: '启动守护服务', 'wait-online': '等待节点上线',
}

export function fleetProbeBadge(probe) {
  if (!probe) return { label: '未探测', tone: '' }
  if (probe.ok === false) return { label: '探测失败', tone: 'bad' }
  if (Array.isArray(probe.missing) && probe.missing.length > 0) return { label: '缺运行环境', tone: 'warn' }
  if (probe.isRelay) return { label: '中继主机', tone: 'acc' }
  return { label: '环境就绪', tone: 'ok' }
}

export function fleetCanDeploy(probe) {
  return !!probe && probe.ok !== false && probe.isRelay !== true && !(Array.isArray(probe.missing) && probe.missing.length > 0)
}

export function fleetRelayReady(cfgResp) {
  const c = cfgResp && cfgResp.config
  return !!(c && String(c.relayUrl || '').trim() !== '' && c.relayTokenSet === true)
}

export const fleetPollMs = 1500
export const fleetJobMaxMs = 600000

/**
 * io = { get(path), post(path, body), confirm(msg)->Promise<bool>, alert(msg), notify(text, tone), dispatch(event),
 *        probes()->{alias: result}, sleep(ms), now(), port(), refresh() }
 * 保持老面板每个行为：探测、缺环境时安装运行时、上桥前没配中继则从已探测的中继主机自动配置、上桥进度轮询。
 */
export function fleetMachFlow(io) {
  const dispatch = io.dispatch
  /* 弹窗文案在生成时就按当前开关遮；存进状态的原文在渲染时再按开关遮，所以开关一拨立刻生效。 */
  const shown = () => (io.show ? io.show() === true : false)
  const mask = (text) => fleetMaskText(text, shown())

  function loadHosts() {
    return io.get('/ssh-hosts').then((d) => {
      if (d && d.ok === false) dispatch({ type: 'hosts', hosts: [], err: d.message || d.error || 'ssh-hosts' })
      else dispatch({ type: 'hosts', hosts: d && Array.isArray(d.hosts) ? d.hosts : [], err: '' })
    }, (e) => dispatch({ type: 'hosts', hosts: [], err: fleetErrText(e) }))
  }

  function probe(alias) {
    dispatch({ type: 'probe-start', alias })
    return io.post('/ssh-probe', { alias }).then(
      (d) => dispatch({ type: 'probe-done', alias, result: d }),
      (e) => dispatch({ type: 'probe-done', alias, result: { ok: false, error: fleetErrText(e) } }))
  }

  async function poll(alias, id) {
    const deadline = io.now() + fleetJobMaxMs
    let fails = 0
    let last = { id, status: 'running', steps: [] }
    await io.sleep(800)
    for (;;) {
      try {
        const d = await io.get('/ssh-deploy?id=' + encodeURIComponent(id))
        last = d && d.job ? d.job : d
        fails = 0
        dispatch({ type: 'job', alias, job: last })
        if (last && (last.status === 'done' || last.status === 'failed')) return last
      } catch (e) {
        fails += 1
        if (fails >= 3) {
          const failed = Object.assign({}, last, { status: 'failed', error: '读取上桥进度失败：' + fleetErrText(e) })
          dispatch({ type: 'job', alias, job: failed })
          return failed
        }
      }
      if (io.now() > deadline) {
        const failed = Object.assign({}, last, { status: 'failed', error: '超过 10 分钟仍没有结果，请到副机上检查' })
        dispatch({ type: 'job', alias, job: failed })
        return failed
      }
      await io.sleep(fleetPollMs)
    }
  }

  async function startJob(alias) {
    const d = await io.post('/ssh-deploy', { alias })
    if (!d || !d.jobId) {
      dispatch({ type: 'job', alias, job: { status: 'failed', steps: [], error: (d && (d.message || d.error)) || '没有返回任务号' } })
      return
    }
    dispatch({ type: 'job', alias, job: { id: d.jobId, status: 'running', steps: [] } })
    const job = await poll(alias, d.jobId)
    if (job && job.status === 'done') { io.notify(alias + ' 已上桥，等它出现在机器列表里', 'ok'); io.refresh() }
  }

  /** 整个上桥流程（含配置检查）都算「上桥中」，按钮在这期间不可再点。 */
  async function deploy(alias) {
    dispatch({ type: 'deploy-start', alias })
    try {
      let cfg
      try { cfg = await io.get('/config') } catch (e) { io.alert(mask('读不到主机配置，不能判断中继是否已配好：' + fleetErrText(e))); return }
      if (!fleetRelayReady(cfg)) {
        const probes = io.probes()
        const relayHost = Object.keys(probes).map((k) => probes[k]).find((p) => p && p.isRelay && p.relayUrl)
        if (!relayHost) { io.alert('主机还没有配置中继，也没在已探测的主机里发现中继服务（8890 端口）。请先对运行中继的主机点「探测」，再上桥。'); return }
        const yes = await io.confirm('主机还没有配置中继。探测发现中继服务在 ' + fleetShowAddr(relayHost.relayUrl, shown()) + '，把它写入主机的中继配置并继续上桥「' + alias + '」？')
        if (!yes) return
        try {
          await io.post('/relay-autoconfig', { relayUrl: relayHost.relayUrl, autoHubToken: relayHost.relayHubToken || '' })
        } catch (e) { io.alert(mask('自动配置中继失败：' + fleetErrText(e))); return }
        let again
        try { again = await io.get('/config') } catch (e) { io.alert(mask('中继配置已写入，但重读主机配置失败：' + fleetErrText(e))); return }
        if (!fleetRelayReady(again)) { io.alert('自动配置中继后仍缺少 Hub Token，请在设置里手动填写 Hub Token'); return }
        io.notify('已按探测结果写入中继配置', 'ok')
      }
      await startJob(alias)
    } catch (e) {
      dispatch({ type: 'job', alias, job: { status: 'failed', steps: [], error: fleetErrText(e) } })
    } finally {
      dispatch({ type: 'deploy-end', alias })
    }
  }

  async function install(alias) {
    const yes = await io.confirm('将在「' + alias + '」上安装 Node.js LTS 和 dsh（会在对方机器上执行安装命令，约 1–3 分钟），继续？')
    if (!yes) return
    dispatch({ type: 'install-start', alias })
    try {
      const d = await io.post('/ssh-deploy/install-runtime', { alias, confirm: 'yes' })
      if (d && d.ok) { dispatch({ type: 'install-end', alias, err: '' }); await probe(alias) }
      else dispatch({ type: 'install-end', alias, err: (d && (d.message || d.error)) || '安装失败' })
    } catch (e) {
      dispatch({ type: 'install-end', alias, err: fleetErrText(e) })
    }
  }

  function loadPair() {
    dispatch({ type: 'pair-start' })
    return io.get('/pair-info?port=' + encodeURIComponent(io.port())).then(
      (d) => dispatch({ type: 'patch', key: 'pair', value: { loading: false, data: d || null, note: d && d.ok === false ? (d.message || d.code || d.error || '配对码读取失败') : '' } }),
      (e) => dispatch({ type: 'patch', key: 'pair', value: { loading: false, data: null, note: '配对码读取失败：' + fleetErrText(e) } }))
  }

  function mint() {
    dispatch({ type: 'patch', key: 'enroll', value: { loading: true, data: null, error: '' } })
    return io.post('/mint-enroll', {}).then((d) => {
      if (!d || typeof d.token !== 'string' || !d.token) throw new Error((d && (d.message || d.error)) || '没有返回口令')
      const ms = fleetNum(d.expiresInMs)
      dispatch({ type: 'patch', key: 'enroll', value: { loading: false, error: '', data: { token: d.token, expiresAt: ms === null ? null : io.now() + ms, expiresInMs: ms } } })
    }).catch((e) => dispatch({ type: 'patch', key: 'enroll', value: { loading: false, data: null, error: '铸造失败：' + fleetErrText(e) } }))
  }

  return { loadHosts, probe, deploy, install, loadPair, mint }
}

/* ── 样式（类名前缀 fl-，只用 styles.js 的 token） ─────────────────── */

export const fleetCss = [
  '.fl-privacy{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap}',
  '.fl-topo{container-type:inline-size}',
  '.fl-svg{width:100%;height:auto;max-height:480px;display:block}',
  '@container (max-width:520px){.fl-svg,.fl-legend{display:none}}',
  '.fl-edge{fill:none;stroke:var(--dra-text-dim);stroke-width:1.5}',
  '.fl-edge.tr-relay{stroke-dasharray:6 4}.fl-edge.tr-unknown{stroke-dasharray:1 5}',
  '.fl-edge.st-offline{stroke:var(--dra-text-faint);stroke-dasharray:2 6}',
  '.fl-edge.st-queued{stroke:var(--dra-warn);stroke-dasharray:8 4}',
  '.fl-edge.st-running{stroke:var(--dra-accent);stroke-width:2.5;stroke-dasharray:8 6;animation:fl-flow 1s linear infinite}',
  '.fl-edge.down{stroke:var(--dra-danger);stroke-dasharray:3 4}',
  '.fl-peer{stroke:var(--dra-mesh);stroke-width:1;stroke-dasharray:1 3;opacity:.9}',
  '@keyframes fl-flow{to{stroke-dashoffset:-14}}',
  '@media (prefers-reduced-motion:reduce){.fl-edge.st-running{animation:none!important}}',
  '.fl-elabel{font-size:10px;fill:var(--dra-text-dim);text-anchor:middle;paint-order:stroke;stroke:var(--dra-surface-1);stroke-width:3px}',
  '.fl-hub{fill:color-mix(in srgb,var(--dra-accent) 16%,var(--dra-surface-2));stroke:var(--dra-accent);stroke-width:2}',
  '.fl-hubtext{font-size:12px;font-weight:700;fill:var(--dra-accent);text-anchor:middle}',
  '.fl-relaybox{fill:var(--dra-surface-2);stroke:var(--dra-danger);stroke-width:1.5;stroke-dasharray:4 3}',
  '.fl-node{cursor:pointer}',
  '.fl-dot{fill:var(--dra-surface-3);stroke:var(--dra-text-dim);stroke-width:2}',
  '.fl-node.online .fl-dot{stroke:var(--dra-ok)}.fl-node.stale .fl-dot{stroke:var(--dra-warn)}.fl-node.offline .fl-dot{stroke:var(--dra-text-faint);stroke-dasharray:3 3}',
  '.fl-node.pinned .fl-dot{fill:color-mix(in srgb,var(--dra-accent) 28%,var(--dra-surface-3));stroke:var(--dra-accent);stroke-width:3}',
  '.fl-node:focus-visible .fl-dot{stroke:var(--dra-accent);stroke-width:3}',
  '.fl-glyph{font-size:12px;font-weight:700;fill:var(--dra-text);text-anchor:middle}',
  '.fl-nname{font-size:11px;fill:var(--dra-text);text-anchor:middle}.fl-nsub{font-size:10px;fill:var(--dra-text-dim);text-anchor:middle}',
  '.fl-table-wrap{overflow-x:auto}',
  '.fl-table{width:100%;border-collapse:collapse;font-size:12px}',
  '.fl-table th,.fl-table td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--dra-border);white-space:nowrap;vertical-align:top}',
  '.fl-table th{color:var(--dra-text-dim);font-weight:600}.fl-table tr.pinned td{background:color-mix(in srgb,var(--dra-accent) 10%,transparent)}',
  '.fl-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
  '.fl-detail{border:1px solid var(--dra-border-strong);border-radius:var(--dra-r-sm);background:var(--dra-surface-2);padding:10px 12px;margin-top:10px}',
  '.fl-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.fl-h{margin:0 0 6px;font-size:13px;font-weight:600}',
  '.fl-legend{margin-top:6px}',
  '.fl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,330px),1fr));gap:12px;align-items:start}',
  '.fl-card{border:1px solid var(--dra-border);border-radius:var(--dra-r-md);background:var(--dra-surface-2);padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}',
  '.fl-card.offline{border-style:dashed}.fl-card.stale{border-color:color-mix(in srgb,var(--dra-warn) 55%,transparent)}',
  '.fl-title{font-weight:600;font-size:14px;overflow-wrap:anywhere}',
  '.fl-meta{display:flex;gap:6px 10px;flex-wrap:wrap;color:var(--dra-text-dim);font-size:12px}',
  '.fl-badges{display:flex;gap:6px;flex-wrap:wrap}',
  '.fl-gauge{display:flex;align-items:center;gap:8px;font-size:12px}.fl-gauge-k{width:34px;color:var(--dra-text-dim)}.fl-gauge-v{min-width:90px;text-align:right}',
  '.fl-bar{flex:1;height:6px;border-radius:3px;background:var(--dra-surface-3);overflow:hidden}.fl-bar>i{display:block;height:100%;background:var(--dra-accent)}.fl-bar.hot>i{background:var(--dra-warn)}',
  '.fl-spark{color:var(--dra-accent);vertical-align:middle}',
  '.fl-more>summary{cursor:pointer;color:var(--dra-text-dim);font-size:12px}.fl-more[open]>summary{margin-bottom:6px}',
  '.fl-list{margin:0;padding-left:18px;font-size:12px;display:flex;flex-direction:column;gap:2px}.fl-list.plain{list-style:none;padding-left:0}',
  '.fl-host{border-top:1px solid var(--dra-border);padding:8px 0;display:flex;flex-direction:column;gap:6px}.fl-host:first-child{border-top:0}',
  '.fl-step{display:flex;gap:6px;font-size:12px}.fl-step.done .fl-sg{color:var(--dra-ok)}.fl-step.failed .fl-sg{color:var(--dra-danger)}',
  '.fl-token{font-family:var(--dra-mono);font-size:14px;padding:8px 10px;border:1px solid var(--dra-border-strong);border-radius:var(--dra-r-sm);background:var(--dra-surface-2);overflow-wrap:anywhere}',
  '.fl-steps{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0;padding:0;list-style:none;counter-reset:fl}',
  '.fl-steps li{counter-increment:fl;display:flex;align-items:center;gap:6px;border:1px solid var(--dra-border);border-radius:999px;padding:2px 12px 2px 4px}',
  '.fl-steps li::before{content:counter(fl);width:20px;height:20px;border-radius:50%;background:var(--dra-surface-3);display:inline-flex;align-items:center;justify-content:center;font-family:var(--dra-mono);font-size:11px}',
  '.fl-attempts{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}.fl-attempts li{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;font-size:12px}',
]

/* ── 组件 ─────────────────────────────────────────────────────────── */

export function createFleet(core) {
  const { React, h, api, Badge, Card, Fold, Banner, Stat, Empty, CopyBtn } = core
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const safe = (promise) => promise.then((d) => d, (e) => ({ ok: false, error: fleetErrText(e) }))

  /* 连续心跳超时计数：每轮轮询算一次，总览与机器屏共用，切屏不重置。 */
  const health = { tick: -1, counts: {} }
  function healthFor(hub) {
    if (health.tick !== hub.tick) { health.counts = fleetStaleCounts(health.counts, hub.nodes); health.tick = hub.tick }
    return health.counts
  }

  /* 机器屏的数据放模块级 store：切屏、轮询都不丢上桥进度和只显示一次的口令。 */
  const machStore = fleetStore(Object.assign({}, fleetMachInit, { showPublic: fleetPrefRead() }))
  /* io 里的 ui / refresh 每次渲染都是新对象，这里记最新的一份。 */
  const latest = { ui: { confirm: () => Promise.resolve(false), alert() {}, notify() {} }, refresh() {} }
  const machFlow = fleetMachFlow({
    get: (path) => api.get(path), post: (path, body) => api.post(path, body),
    dispatch: (e) => machStore.set((s) => fleetMachReduce(s, e)),
    probes: () => machStore.get().probe, show: () => machStore.get().showPublic, sleep, now: () => Date.now(),
    port: () => (typeof window !== 'undefined' && window.location && window.location.port) || '',
    confirm: (msg) => latest.ui.confirm(msg), alert: (msg) => latest.ui.alert(msg), notify: (text, tone) => latest.ui.notify(text, tone), refresh: () => latest.refresh(),
  })

  function useMach() {
    const [s, setS] = React.useState(machStore.get())
    React.useEffect(() => { setS(machStore.get()); return machStore.sub(setS) }, [])
    return s
  }

  /* ── 小件 ── */
  function StatusBadge(p) {
    const st = fleetStatus(p.node)
    return h(Badge, { tone: st === 'online' ? 'ok' : st === 'stale' ? 'warn' : '' }, fleetStatusText[st])
  }
  function VersionBadge(p) {
    const v = fleetVersion(p.node)
    return h(Badge, { tone: v.state === 'old' ? 'warn' : '', title: v.state === 'unknown' ? '这台机器没有上报 AC 版本（可能是旧版本）' : '' }, fleetVersionText(p.node))
  }
  function BacklogBadge(p) {
    const b = fleetBacklog(p.node)
    return b ? h(Badge, { tone: 'warn', title: '可靠通道里还没送达的消息；机器回来后自动补发，不会超时丢弃' }, b.text) : null
  }
  function Gauge(p) {
    return h('div', { className: 'fl-gauge' },
      h('span', { className: 'fl-gauge-k' }, p.label),
      h('div', { className: 'fl-bar' + (p.pct >= 85 ? ' hot' : ''), role: 'meter', 'aria-label': p.label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p.pct }, h('i', { style: { width: p.pct + '%' } })),
      h('span', { className: 'fl-gauge-v dra-mono' }, p.text))
  }
  function Spark(p) {
    const samples = p.samples
    if (!Array.isArray(samples) || samples.length === 0) return null
    const pts = fleetSpark(samples, 90, 18)
    const last = samples[samples.length - 1]
    return h('svg', { className: 'fl-spark', width: 90, height: 18, viewBox: '0 0 90 18', role: 'img', 'aria-label': '帧 RTT 最近 ' + samples.length + ' 个样本，最新 ' + last + ' ms' },
      pts ? h('polyline', { points: pts, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }) : h('circle', { cx: 88, cy: 9, r: 2, fill: 'currentColor' }))
  }

  /* ══════════ 总览 ══════════ */

  function Notices(p) {
    return fleetNotices(p.hub, p.now, p.show).map((n) => h(Banner, {
      key: n.key, tone: n.tone, title: n.title,
      actions: n.go ? h('button', { type: 'button', className: 'dra-btn sm', onClick: () => p.go(n.go) }, n.goLabel) : undefined,
    }, n.body))
  }

  function StatBar(p) {
    const c = p.hub.counts
    const bl = fleetBacklogTotals(p.hub.nodes)
    const old = p.hub.nodes.filter((n) => fleetVersion(n).state === 'old').length
    return h('div', { className: 'dra-statbar' },
      h(Stat, { label: '节点总数', value: c.nodes, title: '登记在本主机上的副机数量' }),
      h(Stat, { label: '在线', value: c.online, tone: 'ok', title: '当前握手在线的副机' }),
      h(Stat, { label: '任务中', value: c.active, tone: 'acc', title: '运行中 + 排队 + 待批准' }),
      h(Stat, { label: '已完成', value: c.done, tone: 'ok' }),
      h(Stat, { label: '失败', value: c.failed, tone: c.failed > 0 ? 'bad' : '', title: 'failed / aborted / rejected' }),
      bl.total > 0 ? h(Stat, { label: '待送达消息', value: bl.total, tone: 'warn', title: '可靠通道里尚未送达的消息，机器回来后补发' }) : null,
      old > 0 ? h(Stat, { label: '版本过旧', value: old, tone: 'warn', title: '低于 ' + coreMinNodeVersion }) : null)
  }

  const fmtAt = (ms) => (ms ? coreFmtTime(ms) : '—')

  function Attempts(p) {
    const rows = fleetAttemptRows(p.connection)
    if (rows.length === 0) return null
    return h(Fold, { title: '最近连接尝试', badge: rows.length + ' 条', open: p.connection.everConnected !== true },
      h('ul', { className: 'fl-attempts' }, rows.map((r) => h('li', { key: r.key },
        h(Badge, { tone: r.ok ? 'ok' : 'bad' }, r.ok ? '成功' : '失败'),
        h('span', { className: 'dra-mono' }, fmtAt(r.at)),
        h('strong', null, fleetMaskText(r.title, p.show)),
        r.remote ? h('span', { className: 'dra-hint' }, fleetShowAddr(r.remote, p.show)) : null,
        r.nodeId ? h('span', { className: 'dra-hint dra-mono' }, coreShortId(r.nodeId, 12)) : null,
        r.detail ? h('span', { className: 'dra-hint dra-wrap' }, fleetMaskText(r.detail, p.show)) : null,
        r.hint ? h('span', { className: 'dra-warn dra-wrap' }, '建议：' + fleetMaskText(r.hint, p.show)) : null))))
  }

  function Topology(p) {
    const [pinned, setPinned] = React.useState('')
    const [peek, setPeek] = React.useState('')
    const hub = p.hub
    const act = fleetActivity(hub.tasks)
    const counts = p.counts
    const models = hub.nodes.map((n) => fleetNodeModel(n, act[n.nodeId], counts[n.nodeId]))
    const byId = {}
    for (const m of models) byId[m.id] = m
    const peers = fleetPeerModel(hub.topology, hub.nodes)
    const relay = fleetRelayStatus(hub.connection, hub.relay)
    const { pin, lost } = fleetPinState(pinned, models.map((m) => m.id))
    const focusId = pin || (byId[peek] ? peek : '')
    const nv = focusId ? peers.view(focusId, fleetPreviewCap) : null
    const layout = fleetLayout({ models, relayDown: relay === 'unreachable' })
    const pos = {}
    for (const q of layout.nodes) pos[q.id] = q
    const toggle = (id) => setPinned(pin === id ? '' : id)
    const compact = layout.nodes.length > 8
    const orphans = fleetOrphans(hub.tasks, hub.nodes)
    const announce = lost ? '已固定的机器不在最新列表中' : pin ? '已固定：' + byId[pin].name : ''
    const stale = hub.error !== ''

    if (models.length === 0) {
      return h(Card, { title: '机器拓扑' }, hub.loading ? h('div', { className: 'dra-hint', 'aria-busy': 'true' }, '读取中…') : h(Empty, null,
        '还没有任何机器接入。', h('button', { type: 'button', className: 'dra-btn sm', onClick: () => p.go('machines') }, '去「机器」添加')))
    }
    return h(Card, { title: '机器拓扑', sub: models.length + ' 台机器 · ' + hub.tasks.length + ' 个任务' + (orphans > 0 ? '（' + orphans + ' 个不属于列表里的机器）' : '') + ' · ' + fleetRelayText[relay],
      actions: stale ? h(Badge, { tone: 'warn' }, '数据陈旧：刷新失败，显示最后一次成功的数据') : null },
    h('div', { className: 'fl-topo', onKeyDown: (e) => { if (e.key === 'Escape' && (pin || peek)) { setPinned(''); setPeek('') } } },
      h('div', { className: 'dra-hint' }, fleetTransportLine(hub)),
      h('svg', { className: 'fl-svg', viewBox: '0 0 ' + layout.width + ' ' + layout.height, preserveAspectRatio: 'xMidYMid meet', role: 'group', 'aria-label': '机器拓扑：' + models.length + ' 台，完整信息见下方列表' },
        layout.edges.map((e) => h('g', { key: e.id },
          h('line', { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, className: 'fl-edge st-' + e.state + ' tr-' + e.transport }),
          compact && e.to !== pin ? null : h('text', { x: e.lx, y: e.ly - 4, className: 'fl-elabel' }, e.label))),
        nv ? nv.preview.filter((id) => pos[id] && pos[focusId]).map((id) => h('line', { key: 'pe-' + id, x1: pos[focusId].x, y1: pos[focusId].y, x2: pos[id].x, y2: pos[id].y, className: 'fl-peer' })) : null,
        layout.relay ? h('g', { key: 'relay' },
          h('line', { x1: layout.hub.x, y1: layout.hub.y, x2: layout.relay.x, y2: layout.relay.y, className: 'fl-edge down' }),
          h('rect', { x: layout.relay.x - layout.relay.w / 2, y: layout.relay.y - layout.relay.h / 2, width: layout.relay.w, height: layout.relay.h, rx: 8, className: 'fl-relaybox' }),
          h('text', { x: layout.relay.x, y: layout.relay.y + 4, className: 'fl-nname' }, '中继 ✕')) : null,
        h('g', { key: 'hub' }, h('circle', { cx: layout.hub.x, cy: layout.hub.y, r: layout.hub.r, className: 'fl-hub' }), h('text', { x: layout.hub.x, y: layout.hub.y + 4, className: 'fl-hubtext' }, '主控')),
        layout.nodes.map((q) => {
          const m = q.model
          const label = m.name + '，' + fleetStatusText[m.status] + '，' + fleetTransportText[m.transport] + '，' + m.rttText + '，' + m.actText + (pin === m.id ? '（已固定）' : '')
          return h('g', {
            key: m.id, className: 'fl-node ' + m.status + (pin === m.id ? ' pinned' : ''), tabIndex: 0, role: 'button', 'aria-pressed': pin === m.id ? 'true' : 'false', 'aria-label': label,
            onClick: () => toggle(m.id),
            onMouseEnter: () => setPeek(m.id), onMouseLeave: () => setPeek(''), onFocus: () => setPeek(m.id), onBlur: () => setPeek(''),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(m.id) } },
          },
          h('title', null, label),
          h('circle', { cx: q.x, cy: q.y, r: 13, className: 'fl-dot' }),
          h('text', { x: q.x, y: q.y + 4, className: 'fl-glyph' }, m.status === 'online' ? '✓' : m.status === 'stale' ? '!' : '✕'),
          h('text', { x: q.x, y: q.y + 28, className: 'fl-nname' }, fleetCut(m.name, 16)),
          h('text', { x: q.x, y: q.y + 40, className: 'fl-nsub' }, fleetCut(m.act.running ? m.act.running + ' 运行' : m.actText, 14)))
        })),
      h('div', { className: 'dra-hint fl-legend' }, '实线＝直连 · 短划＝经主控中继 · 点线＝连接方式未知 · 流动粗线＝有任务在运行 · 细点线＝对等候选（服务端列出，未验证，不代表可用链路）'),
      h('div', { className: 'dra-hint' }, peers.label + (nv && nv.overflow > 0 ? ' · ' + byId[focusId].name + ' +' + nv.overflow + ' 更多' : '')),
      h('div', { className: 'fl-live', 'aria-live': 'polite', 'aria-atomic': 'true' }, announce),
      lost ? h('div', { className: 'dra-hint dra-warn' }, '已固定的机器不在最新列表中') : null,
      h('div', { className: 'fl-table-wrap' }, h('table', { className: 'fl-table', 'aria-label': '机器列表' },
        h('thead', null, h('tr', null, ['机器', '状态', '连接', '延迟', '任务', '版本', '待送达', '对等', '操作'].map((t, i) => h('th', { key: i, scope: 'col' }, t)))),
        h('tbody', null, models.map((m) => {
          const n = hub.nodes.find((x) => x.nodeId === m.id)
          return h('tr', { key: m.id, className: pin === m.id ? 'pinned' : '' },
            h('th', { scope: 'row', title: m.id }, m.name),
            h('td', null, fleetStatusText[m.status] + (m.health && m.health !== '健康：稳定' ? ' · ' + m.health : '')),
            h('td', null, m.status === 'offline' ? '—' : fleetTransportText[m.transport]),
            h('td', null, m.rttText),
            h('td', null, m.actText),
            h('td', null, fleetVersionText(n)),
            h('td', null, m.backlog ? m.backlog.text : '—'),
            h('td', null, peers.badge(m.id) || '—'),
            h('td', null, h('button', { type: 'button', className: 'dra-btn sm', 'aria-pressed': pin === m.id ? 'true' : 'false', onClick: () => toggle(m.id) }, pin === m.id ? '取消固定' : '固定')))
        })))),
      pin ? PinDetail({ node: hub.nodes.find((x) => x.nodeId === pin), model: byId[pin], view: nv, byId, peers, go: p.go, now: p.now }) : null))
  }

  function PinDetail(p) {
    const n = p.node
    const m = p.model
    return h('section', { className: 'fl-detail', 'aria-label': m.name + ' 详情' },
      h('div', { className: 'fl-head' }, h('strong', null, m.name), h(StatusBadge, { node: n }), h(VersionBadge, { node: n }), h(BacklogBadge, { node: n }),
        h('span', { className: 'dra-spacer' }), h('button', { type: 'button', className: 'dra-btn sm', onClick: () => p.go('machines') }, '在「机器」里看全部')),
      h('dl', { className: 'dra-kv', style: { marginTop: 8 } },
        h('dt', null, '节点 ID'), h('dd', { className: 'dra-mono' }, m.id),
        h('dt', null, '连接'), h('dd', null, (m.status === 'offline' ? '—' : fleetTransportText[m.transport]) + ' · ' + fleetLinkKind(n) + ' · ' + m.rttText),
        h('dt', null, '任务'), h('dd', null, m.actText),
        h('dt', null, '最近'), h('dd', null, fleetLastSeen(n, p.now)),
        p.peers.state === 'missing' ? null : h('dt', null, '对等候选'),
        p.peers.state === 'missing' ? null : h('dd', null, p.view.full.length === 0 ? '无' : p.view.full.map((id) => (p.byId[id] ? p.byId[id].name + '（' + fleetStatusText[p.byId[id].status] + '）' : id)).join('、') + (p.view.overflow > 0 ? '；图上只画前 ' + fleetPreviewCap + ' 条在线的，另有 ' + p.view.overflow + ' 条见此列表' : ''))))
  }

  function Overview(p) {
    const hub = p.hub
    const now = Date.now()
    const counts = healthFor(hub)
    /* 机器屏切进来才挂载，所以这里直接读当前开关，不需要订阅。 */
    const show = machStore.get().showPublic === true
    return h('div', { className: 'dra-col' },
      h(Notices, { hub, now, go: p.go, show }),
      h(StatBar, { hub }),
      h('div', { className: 'dra-hint', role: 'note' }, show ? '公网地址：已显示（在「机器」页可关闭）' : '公网地址：已隐藏，局域网地址与机器名照常显示（在「机器」页可打开「显示公网地址」）'),
      h(Attempts, { connection: hub.connection, show }),
      h(Topology, { hub, counts, go: p.go, now }))
  }

  /* ══════════ 机器 ══════════ */

  function NodeCard(p) {
    const [busy, setBusy] = React.useState(false)
    const [, bump] = React.useState(0)
    /* 采样「N 秒前」每秒走字；页面隐藏时不重画，卸载时清掉定时器。 */
    React.useEffect(() => {
      const timer = setInterval(() => { if (typeof document === 'undefined' || document.hidden !== true) bump((x) => x + 1) }, 1000)
      return () => clearInterval(timer)
    }, [])
    const n = p.node
    const now = Date.now()
    const st = fleetStatus(n)
    const load = fleetLoad(n)
    const queue = fleetQueue(n)
    const show = p.show === true
    const probes = fleetProbeRows(n, show)
    const tunnel = fleetTunnelLine(n, show)
    const rtt = fleetRtt(n)
    const stale = fleetStaleLabel(n, now)
    const roots = Array.isArray(n.roots) && n.roots.length > 0 ? n.roots : []
    const repos = Array.isArray(n.repos) ? n.repos : []
    const caps = Array.isArray(n.caps) ? n.caps : []
    const name = fleetName(n)
    const purge = () => {
      p.ui.confirm('清理「' + name + '」已结束的历史任务记录？运行中的任务会保留；只清主机上的记录，不影响这台机器本身。').then((yes) => {
        if (!yes) return
        setBusy(true)
        safe(api.post('/purge', { node: n.nodeId, includeActive: false })).then((d) => {
          if (d && d.ok === false) p.ui.notify('清理失败：' + fleetMaskText(d.error, show), 'err')
          else p.ui.notify('已清理 ' + coreShortId(n.nodeId, 12) + ' 的 ' + (d && d.removed != null ? d.removed : 0) + ' 条历史（运行中的保留）', 'ok')
          setBusy(false)
          p.refresh()
        })
      })
    }
    return h('article', { className: 'fl-card ' + st, 'aria-label': name },
      h('div', { className: 'fl-head' },
        h('span', { className: 'fl-title' }, name),
        h('span', { className: 'dra-spacer' }),
        h(StatusBadge, { node: n })),
      h('div', { className: 'fl-meta' },
        h('span', { className: 'dra-mono', title: n.nodeId }, coreShortId(n.nodeId, 14)),
        h(CopyBtn, { text: n.nodeId, label: '复制 ID', title: '复制完整节点 ID' }),
        h('span', null, (n.os || '?') + '/' + (n.arch || '?')),
        h('span', null, '任务 ' + (n.taskCount || 0)),
        n.agentMode ? h('span', null, 'agent') : null,
        n.runnerKind ? h('span', null, n.runnerKind) : null),
      h('div', { className: 'fl-badges' },
        h(Badge, null, st === 'offline' ? '—' : fleetTransportText[fleetTransport(n)]),
        h(Badge, null, fleetLinkKind(n)),
        h(VersionBadge, { node: n }),
        h(BacklogBadge, { node: n }),
        stale && st !== 'stale' ? h(Badge, { tone: 'warn' }, stale) : null,
        st !== 'offline' ? h(Badge, null, fleetHealth(n, p.counts[n.nodeId])) : null,
        h(Badge, { title: '身份确认：节点握手是否经过签名身份核验' }, n.confirm === 'confirmed' ? '身份已确认' : '身份未确认')),
      h('div', { className: 'dra-hint' }, fleetConnLine(n, now)),
      h('div', { className: 'dra-hint' }, fleetLastSeen(n, now) + (rtt ? ' · ' + fleetRttText(n) : ''),
        ' ', st === 'offline' || fleetTransport(n) === 'relay' ? null : h(Spark, { samples: n.frameRttMs })),
      load.reported
        ? h('div', { className: 'dra-col', style: { gap: 4 } },
          h(Gauge, { label: 'CPU', pct: load.cpuPct, text: load.cpuLabel }),
          h(Gauge, { label: '内存', pct: load.memPct, text: load.memLabel }),
          load.at !== null && (st === 'offline' || now - load.at > 120000) ? h('div', { className: 'dra-hint' }, '负载采样于 ' + fleetAgo(load.at, now)) : null)
        : h('div', { className: 'dra-hint' }, '负载未上报'),
      queue ? h('div', { className: queue.starved ? 'dra-warn' : 'dra-hint' }, queue.text + (queue.warn ? ' · ' + queue.warn : '')) : null,
      fleetBacklog(n) ? h('div', { className: 'dra-hint' }, '待送达类型：' + (fleetBacklog(n).types.map((t) => t[0] + '×' + t[1]).join('、') || '—') + (fleetBacklog(n).maxTries > 0 ? ' · 最多重试 ' + fleetBacklog(n).maxTries + ' 次' : '') + '。消息保留到机器回来，没有超时。') : null,
      h('details', { className: 'fl-more' },
        h('summary', null, '详情'),
        h('dl', { className: 'dra-kv' },
          h('dt', null, '节点 ID'), h('dd', { className: 'dra-mono' }, n.nodeId),
          h('dt', null, '对端地址'), h('dd', null, (n.peerHost || fleetAddress(n)) ? fleetShowAddr(n.peerHost || fleetAddress(n), show) : '未上报'),
          h('dt', null, '上线于'), h('dd', null, n.since ? coreFmtTime(n.since) : '—'),
          h('dt', null, '能力'), h('dd', null, caps.length ? caps.join(' · ') : '未上报'),
          h('dt', null, roots.length ? '工作区' : '仓库'), h('dd', { className: 'dra-wrap' }, (roots.length ? roots : repos).join('\n') || '未上报'),
          h('dt', null, '隧道'), h('dd', null, tunnel || '无'),
          h('dt', null, '连通探测'), h('dd', null, probes.length === 0 ? '无' : h('ul', { className: 'fl-list plain' }, probes.map((q) => h('li', { key: q.target }, q.target + ' · ' + q.text + (q.rtt !== null ? ' · ' + Math.round(q.rtt) + 'ms' : '')))))),
        ),
      h('div', { className: 'dra-row' },
        h('button', { type: 'button', className: 'dra-btn sm', disabled: busy, onClick: purge }, busy ? '清理中…' : '清理历史')))
  }

  function Discovery(p) {
    const [busy, setBusy] = React.useState(false)
    const [err, setErr] = React.useState('')
    const [over, setOver] = React.useState(null)
    const disc = over && over.at > p.hub.at ? over.d : p.hub.discovery
    const dv = fleetDiscoveryRows(disc, p.hub.nodes, p.show)
    const configured = disc && typeof disc.configured === 'boolean' ? disc.configured : dv.enabled
    const act = (path, body) => {
      setBusy(true)
      setErr('')
      safe(api.post(path, body)).then((d) => {
        if (d && d.ok === true && d.discovery) setOver({ d: d.discovery, at: Date.now() })
        else setErr('局域网发现操作失败：' + fleetMaskText((d && d.error) || 'unknown', p.show))
        setBusy(false)
      })
    }
    return h(Card, {
      title: '局域网发现', sub: dv.rows.length + ' 台未配对',
      actions: [
        h('button', { key: 'toggle', type: 'button', className: 'dra-btn sm', role: 'switch', 'aria-checked': configured ? 'true' : 'false', disabled: busy, onClick: () => act('/discovery/toggle', { enabled: !configured }) }, configured ? '已开启 · 点此关闭' : '已关闭 · 点此开启'),
        h('button', { key: 'scan', type: 'button', className: 'dra-btn sm', disabled: busy || !dv.enabled, onClick: () => act('/discovery/scan') }, '扫描'),
      ],
    },
    err ? h('p', { className: 'dra-warn', role: 'alert' }, err) : null,
    !dv.enabled
      ? h('p', { className: 'dra-hint' }, configured ? '发现监听未启动。可关闭后重试。' : '局域网发现未开启')
      : dv.rows.length === 0
        ? h('p', { className: 'dra-hint' }, '未发现未配对的机器')
        : h('ul', { className: 'fl-list plain' }, dv.rows.map((r, i) => h('li', { key: String(r.node) + ':' + i },
          h('span', { className: 'dra-mono' }, r.addressLabel), ' · ' + String(r.role || '') + (r.port == null ? '' : ' · 端口 ' + r.port) + (r.version ? ' · v' + r.version : '')))))
  }

  function SshHosts(p) {
    const s = p.mach
    const show = s.showPublic === true
    if (s.hosts.length === 0 && !s.hostsErr) return null
    return h(Fold, { title: 'SSH 一键上桥', badge: s.hosts.length + ' 台' },
      s.hostsErr ? h('div', { className: 'dra-hint dra-danger', role: 'alert' }, '主机列表读取失败：' + fleetMaskText(s.hostsErr, show)) : null,
      s.hosts.map((host) => {
        const alias = host.alias || ''
        const probe = s.probe[alias] || null
        const badge = fleetProbeBadge(probe)
        const job = s.job[alias] || null
        const missing = probe && Array.isArray(probe.missing) ? probe.missing : []
        return h('div', { key: alias, className: 'fl-host' },
          h('div', { className: 'dra-row' },
            h('strong', { className: 'dra-mono' }, alias),
            h('span', { className: 'dra-hint' }, (host.user || '') + '@' + fleetShowAddr(host.host || '', show) + ':' + (host.port || 22)),
            h('span', { className: 'dra-spacer' }),
            h(Badge, { tone: badge.tone }, badge.label),
            h('button', { type: 'button', className: 'dra-btn sm', disabled: !!s.probing[alias], onClick: () => p.flow.probe(alias) }, s.probing[alias] ? '探测中…' : '探测'),
            missing.length > 0 ? h('button', { type: 'button', className: 'dra-btn sm', disabled: !!s.installing[alias], onClick: () => p.flow.install(alias) }, s.installing[alias] ? '安装中…' : '安装运行环境') : null,
            fleetCanDeploy(probe) ? h('button', { type: 'button', className: 'dra-btn sm', disabled: !!s.deploying[alias], onClick: () => p.flow.deploy(alias) }, s.deploying[alias] ? '上桥中…' : '上桥') : null),
          host.description ? h('div', { className: 'dra-hint' }, host.description) : null,
          probe && probe.ok === false ? h('div', { className: 'dra-hint dra-danger', role: 'alert' }, '探测失败：' + fleetMaskText(probe.message || probe.error || 'unknown', show)) : null,
          probe && probe.ok !== false ? h('div', { className: 'dra-hint' }, [probe.os, probe.node && 'node ' + probe.node, probe.dsh && 'dsh ' + probe.dsh].filter(Boolean).join(' · ') + (probe.isRelay ? ' · 在 8890 端口发现中继服务' : '')) : null,
          missing.length > 0 ? h('div', { className: 'dra-hint dra-warn' }, '缺少：' + missing.join('、')) : null,
          s.installErr[alias] ? h('div', { className: 'dra-hint dra-danger', role: 'alert' }, '安装失败：' + fleetMaskText(s.installErr[alias], show)) : null,
          job ? h('div', { className: 'dra-col', style: { gap: 3 }, role: 'status' },
            (job.steps || []).map((st) => h('div', { key: st.name, className: 'fl-step ' + st.status },
              h('span', { className: 'fl-sg' }, st.status === 'done' ? '✔' : st.status === 'failed' ? '✘' : '○'),
              h('span', null, fleetStepText[st.name] || st.name),
              st.log ? h('span', { className: 'dra-hint dra-wrap' }, fleetMaskText(String(st.log).trim(), show)) : null)),
            job.status === 'done' ? h('div', { className: 'dra-ok' }, '✔ 已上桥') : null,
            job.error ? h('div', { className: 'dra-danger dra-wrap' }, '✘ ' + fleetMaskText(job.error, show)) : null) : null)
      }))
  }

  function AddMachine(p) {
    const s = p.mach
    const pair = s.pair.data
    const codes = pair && Array.isArray(pair.codes) ? pair.codes : []
    const en = s.enroll
    const now = Date.now()
    const show = s.showPublic === true
    return h('div', { className: 'dra-col' },
      h('div', null,
        h('div', { className: 'dra-row' },
          h('h4', { className: 'fl-h' }, '配对码'),
          h('span', { className: 'dra-spacer' }),
          h('button', { type: 'button', className: 'dra-btn sm', disabled: s.pair.loading, onClick: p.flow.loadPair }, s.pair.loading ? '读取中…' : '刷新配对码')),
        h('div', { className: 'dra-hint' }, pair && pair.listener && pair.listener.host ? '监听 ' + fleetShowAddr(pair.listener.host, show) + ':' + (pair.listener.port || '') : '尚未读到监听状态'),
        pair && pair.listener && pair.listener.hint ? h('div', { className: 'dra-hint dra-warn' }, fleetMaskText(pair.listener.hint, show)) : null,
        pair && pair.note ? h('div', { className: 'dra-hint dra-warn' }, fleetMaskText(pair.note, show)) : null,
        s.pair.note ? h('div', { className: 'dra-hint dra-warn', role: 'alert' }, fleetMaskText(s.pair.note, show)) : null,
        codes.length === 0
          ? h('div', { className: 'dra-hint' }, '还没有可用配对码。先确认独立监听已启动（端口默认 19387），再点「刷新配对码」。')
          : codes.map((c) => {
            /* 配对码里编码了接入地址：地址是公网又没开开关时只露个头，复制按钮仍复制完整的一行。 */
            const hidden = !show && c.hubUrl && fleetPublicHost(fleetHostOf(c.hubUrl))
            const line = 'pair: ' + (c.pairCode || '')
            return h('div', { key: c.address || c.name, className: 'dra-field', style: { marginTop: 6 } },
              h('div', { className: 'dra-row' },
                h('span', { className: 'dra-field-label' }, (c.name || 'address') + (c.private ? ' · 内网' : '') + (c.usable ? '' : ' · 当前监听不在这个地址，可能连不上')),
                h('span', { className: 'dra-spacer' }),
                h(CopyBtn, { label: hidden ? '复制完整配置行' : '复制 pair 配置行', text: line })),
              h('div', { className: 'dra-mono dra-wrap' }, hidden ? 'pair: ' + String(c.pairCode || '').slice(0, 6) + fleetDots : line),
              c.hubUrl ? h('div', { className: 'dra-row' },
                h('span', { className: 'dra-hint dra-wrap' }, fleetShowAddr(c.hubUrl, show)),
                h(CopyBtn, { label: '复制完整地址', text: c.hubUrl })) : null)
          })),
      h('div', null,
        h('h4', { className: 'fl-h' }, '一次性入网口令'),
        h('button', { type: 'button', className: 'dra-btn primary', disabled: en.loading, onClick: p.flow.mint }, en.loading ? '生成中…' : '生成一次性接入口令'),
        en.error ? h('div', { className: 'dra-hint dra-danger', role: 'alert', style: { marginTop: 6 } }, fleetMaskText(en.error, show)) : null,
        en.data ? h('div', { style: { marginTop: 8 } },
          h('div', { className: 'dra-row' }, h('span', { className: 'dra-field-label' }, '入网口令'), h('span', { className: 'dra-spacer' }), h(CopyBtn, { label: '复制', text: en.data.token })),
          h('div', { className: 'fl-token' }, en.data.token),
          h('div', { className: 'dra-hint' }, en.data.expiresAt === null
            ? '有效期以中继为准（通常 15 分钟），仅显示这一次'
            : now > en.data.expiresAt ? '已过期，请重新生成' : '有效至 ' + coreFmtTime(en.data.expiresAt) + '（约 ' + Math.max(1, Math.round(en.data.expiresInMs / 60000)) + ' 分钟），仅显示这一次')) : null),
      h('div', null,
        h('h4', { className: 'fl-h' }, '接入步骤'),
        h('ol', { className: 'fl-steps' }, ['重启 DSH', '生成配对码', '在副机上粘贴', '等它连上'].map((t) => h('li', { key: t }, t))),
        h('div', { className: 'dra-hint' }, '你现在用的这台是主机；副机装好 dsh-ai-cluster 后，把配对码或入网口令贴进它的配置即可，不需要手写 YAML。')))
  }

  function Machines(p) {
    const hub = p.hub
    const counts = healthFor(hub)
    const mach = useMach()
    latest.ui = p.ui
    latest.refresh = p.refresh
    /* 只在机器屏挂载时拉一次，轮询不碰这些。 */
    React.useEffect(() => { machFlow.loadHosts(); machFlow.loadPair() }, [])
    const nodes = hub.nodes
    const show = mach.showPublic === true
    const setShow = (on) => { fleetPrefWrite(on); machStore.set((st) => fleetMachReduce(st, { type: 'show', value: on })) }
    return h('div', { className: 'dra-col' },
      h('div', { className: 'fl-privacy' },
        h('label', { className: 'dra-check' },
          h('input', { type: 'checkbox', checked: show, onChange: (e) => setShow(e.target.checked) }), '显示公网地址'),
        h('span', { className: 'dra-hint' }, show
          ? '公网 IP、域名和中继 / 隧道地址已显示。'
          : '公网 IP、域名和中继 / 隧道地址默认隐藏，只露出开头；局域网地址与机器名始终可见。复制按钮仍复制完整地址。')),
      h(Card, { title: '副机节点', sub: hub.counts.online + '/' + nodes.length + ' 在线' },
        nodes.length === 0
          ? h(Empty, null, hub.loading ? '读取中…' : '还没有副机。往下看「添加机器」，按步骤把另一台电脑接进来。')
          : h('div', { className: 'fl-grid' }, nodes.map((n) => h(NodeCard, { key: n.nodeId, node: n, counts, show, ui: p.ui, refresh: p.refresh })))),
      h(Discovery, { hub, show }),
      h(SshHosts, { mach, flow: machFlow }),
      h(Fold, { title: '添加机器', badge: nodes.length === 0 ? '先接一台' : nodes.length + ' 台', open: !hub.loading && nodes.length === 0 },
        h(AddMachine, { mach, flow: machFlow })))
  }

  return { css: fleetCss, Overview, Machines }
}
