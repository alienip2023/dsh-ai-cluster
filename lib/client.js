/**
 * dsh-ai-cluster 的浏览器半边（零依赖纯 JS，无 JSX/TS/import）。
 *
 * v2 从零重写（fork.17）：
 *   · Panel 顶部集中声明全部 useState —— 任何条件 return 之前
 *   · 运行界面由已保存的 role 决定，顶栏不切换；接入配置区始终可见
 *   · 深色科技感（accent #2ee6ff，底色见 --dra-s0 token），hover 显示次要信息
 *   · 数据只走本包 Host 半边注册的真实路由，不臆造端点
 *
 * 两个插槽配对使用（DSH 标准「点侧栏图标打开面板」）：
 *   - sidebar.panellist：注册图标，id = 'dsh-ai-cluster'
 *   - main：注册面板，key 必须等于那个 id
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-cluster',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/api/ai-cluster/ui'
    const API_FALLBACK = '/api/remote-agent/ui'
    const PANEL_KEY = 'dsh-ai-cluster'
    const STATUS_PATH = '/api/remote-agent/status'
    const SETUP_STATE_PATH = '/api/remote-agent/setup/state'
    const SETUP_APPLY_PATH = '/api/remote-agent/setup/apply'
    const POLL_MS = 8000
    const P2_SCREENS = [['computers','电脑'],['tasks','交办'],['bots','机器人'],['models','模型'],['memory','记忆']]

    function selectHubScreen(state) {
      const screen = state && state.screen
      return P2_SCREENS.some(function (entry) { return entry[0] === screen }) ? screen : 'computers'
    }

    function ticketStage(ticket, executorState) {
      if (ticket?.state === 'ended' || ticket?.state === 'interrupted') return { stage: 'ended' }
      if (ticket?.state === 'open' && executorState && typeof executorState === 'object') {
        const reason = executorState.attention?.kind
        if (['answer', 'review', 'blocked', 'failed'].includes(reason)) return { stage: 'person', reason: reason }
        if (executorState.running === true) return { stage: 'working' }
      }
      return { stage: 'idle' }
    }

    /* A2 外壳纯函数接缝：主题决议 / 标签模型 / 方向键 / 一句话摘要（只读已有数据，不发请求）。 */
    function themeResolve(input) {
      const o = input && typeof input === 'object' ? input : {}
      const ok = function (v) { return v === 'light' || v === 'dark' }
      if (ok(o.saved)) return o.saved
      if (ok(o.host)) return o.host
      if (o.prefersDark === true) return 'dark'
      if (o.prefersDark === false) return 'light'
      return 'dark'
    }

    function shellTabModel(screen, counts) {
      const c = counts && typeof counts === 'object' ? counts : {}
      const cur = selectHubScreen({ screen: screen })
      const num = function (v) { return typeof v === 'number' && isFinite(v) ? String(v) : null }
      const count = {
        computers: typeof c.online === 'number' && typeof c.nodes === 'number' ? c.online + '/' + c.nodes : null,
        tasks: num(c.active), bots: num(c.bots), models: num(c.models), memory: num(c.memory),
      }
      return P2_SCREENS.map(function (entry) {
        return { id: entry[0], label: entry[1], count: count[entry[0]], selected: entry[0] === cur, tabId: 'tab-' + entry[0], panelId: 'panel-' + entry[0] }
      })
    }

    function shellTabKey(screen, key) {
      const ids = P2_SCREENS.map(function (entry) { return entry[0] })
      const i = ids.indexOf(selectHubScreen({ screen: screen }))
      if (key === 'ArrowRight') return ids[(i + 1) % ids.length]
      if (key === 'ArrowLeft') return ids[(i - 1 + ids.length) % ids.length]
      if (key === 'Home') return ids[0]
      if (key === 'End') return ids[ids.length - 1]
      return null
    }

    function shellScreenSummary(screen, st) {
      const s = st && typeof st === 'object' ? st : {}
      const c = s.counts && typeof s.counts === 'object' ? s.counts : {}
      const n = function (v) { return typeof v === 'number' && isFinite(v) ? v : 0 }
      const id = selectHubScreen({ screen: screen })
      if (id === 'computers') return n(c.online) + '/' + n(c.nodes) + ' 台在线 · ' + n(c.active) + ' 个任务运行中'
      if (id === 'tasks') return n(c.active) + ' 个任务进行中 · 共 ' + n(c.tasks) + ' 个'
      if (id === 'bots' || id === 'models') {
        const av = id === 'bots' ? s.bots : s.models
        const noun = id === 'bots' ? '机器人' : '模型'
        if (!av) return '读取中…'
        if (av.kind === 'empty') return id === 'bots' ? '还没有机器人上报' : '还没有电脑上报模型'
        if (av.kind !== 'data') return noun + '列表读取失败'
        const list = Array.isArray(av.nodes) ? av.nodes : []
        const total = list.reduce(function (sum, x) { const a = x && x[id]; return sum + (Array.isArray(a) ? a.length : 0) }, 0)
        return list.length + ' 台电脑 · ' + total + ' 个' + noun
      }
      const m = s.memory || {}
      if (m.state === 'missing') return '记忆接口不可用'
      if (m.state === 'error') return '记忆读取失败'
      if (m.state !== 'ok') return '读取中…'
      const entries = m.data && Array.isArray(m.data.entries) ? m.data.entries.length : 0
      return '当前范围 ' + entries + ' 条记忆'
    }

    /* bots / memory 屏的可用性投影：纯函数，只区分 empty / error，不产出列表。 */
    function screenAvailability(body, status) {
      if (status !== 200) return { kind: 'error', status: status, reason: '' }
      if (body && typeof body === 'object' && body.code === 'not-available') {
        return { kind: 'empty', status: 200, reason: String(body.reason || '') }
      }
      /* 名册：ok:true 带 nodes 数组才是数据；total 为 0 才是空；ok:false 是错误，不是空。 */
      if (body && typeof body === 'object' && body.ok === true && Array.isArray(body.nodes)) {
        if (Number(body.total) === 0) return { kind: 'empty', status: 200, reason: '' }
        return { kind: 'data', status: 200, nodes: body.nodes }
      }
      if (body && typeof body === 'object' && body.ok === false && typeof body.code === 'string') {
        return { kind: 'error', status: 200, reason: body.code }
      }
      return { kind: 'error', status: 200, reason: 'unexpected-shape' }
    }

    /* 模型屏的可用性投影：ok:true 带 nodes 即数据（全空由视图自己判断，机器行仍要显示）；ok:false / 非 200 是错误，不是空。 */
    function modelsAvailability(body, status) {
      if (status !== 200) return { kind: 'error', status: status, reason: '' }
      if (body && typeof body === 'object' && body.ok === true && Array.isArray(body.nodes)) {
        if (body.nodes.length === 0) return { kind: 'empty', status: 200, reason: '' }
        return { kind: 'data', status: 200, nodes: body.nodes }
      }
      if (body && typeof body === 'object' && body.ok === false) {
        return { kind: 'error', status: 200, reason: String(body.reason || body.code || '') }
      }
      return { kind: 'error', status: 200, reason: 'unexpected-shape' }
    }

    /* ───────── 记忆屏（p4）：数据来自 ds-bot 自己的联邦记忆，经同源 POST /api/bot ───────── */
    const BOT_API = '/api/bot'
    const MEMORY_API_MISSING = 'memory-api-missing'

    /* 纯函数：把 /api/bot 的 (status, 原文) 归类。ds-bot 回 {ok:true,value} 或 {ok:false,error:{code,message}}；
     * 404 / 非 JSON（HTML）/ 没有 ok 字段 / bot/not-found 都表示端点不存在，不是“空列表”。 */
    function botApiOutcome(status, text) {
      if (status === 404) return { kind: 'missing', reason: MEMORY_API_MISSING }
      let body
      try { body = JSON.parse(text) } catch (e) { return { kind: 'missing', reason: MEMORY_API_MISSING } }
      if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') return { kind: 'missing', reason: MEMORY_API_MISSING }
      if (body.ok === true) return { kind: 'ok', value: body.value }
      const err = body.error && typeof body.error === 'object' ? body.error : {}
      if (err.code === 'bot/not-found') return { kind: 'missing', reason: MEMORY_API_MISSING }
      return { kind: 'error', reason: String(err.message || err.code || 'unknown') }
    }

    function botApi(endpoint, payload) {
      return fetch(BOT_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: endpoint, payload: payload || {} }),
      }).then(function (r) {
        return r.text().then(function (text) { return botApiOutcome(r.status, text) })
      }, function (e) {
        return { kind: 'error', reason: String((e && e.message) || 'network') }
      }).then(function (out) {
        if (out.kind === 'ok') return out.value
        const e = new Error(out.reason)
        e.reason = out.reason
        e.missing = out.kind === 'missing'
        throw e
      })
    }

    function memoryScopes() { return botApi('memory-hub-scopes', {}) }
    function memoryView(scope) { return botApi('memory-hub-view', { scope: scope }) }
    function memoryAdd(scope, text, topic) { return botApi('memory-hub-add', { scope: scope, text: text, topic: topic || undefined }) }
    function memoryForget(scope, text, topic) { return botApi('memory-hub-forget', { scope: scope, text: text, topic: topic || undefined }) }

    /* 范围选项：value 是 memory-federation panelScope() 接受的对象（JSON 串），字段全部取自 memory-hub-scopes 的回包。 */
    function memoryScopeOptions(scopes) {
      if (!scopes || typeof scopes !== 'object') return []
      const out = [{ group: 'team', label: '团队', value: JSON.stringify({ kind: 'team' }), entries: scopes.team && scopes.team.entries != null ? scopes.team.entries : null }]
      const nodes = Array.isArray(scopes.nodes) ? scopes.nodes : []
      nodes.forEach(function (n) {
        const host = String(n.hostname || n.nodeId)
        out.push({ group: 'node', label: host + (n.online ? '' : '（离线）'), value: JSON.stringify({ kind: 'node', nodeId: n.nodeId }), entries: n.entries == null ? null : n.entries })
      })
      nodes.forEach(function (n) {
        const host = String(n.hostname || n.nodeId)
        ;(Array.isArray(n.bots) ? n.bots : []).forEach(function (b) {
          out.push({ group: 'bot', label: String(b.name || b.remoteBotId) + ' @ ' + host, value: JSON.stringify({ kind: 'bot', nodeId: n.nodeId, remoteBotId: b.remoteBotId }), entries: b.entries == null ? null : b.entries })
        })
      })
      return out
    }

    /* 条目行：原样带出 text / topic / 标记；expired 行 muted。 */
    function memoryEntryRows(view) {
      const entries = view && Array.isArray(view.entries) ? view.entries : []
      return entries.map(function (e, i) {
        return {
          key: String(e.id != null ? e.id : 'i' + i), text: String(e.text == null ? '' : e.text),
          topic: e.topic == null ? '' : String(e.topic), added: e.added == null ? '' : String(e.added),
          until: e.until == null ? '' : String(e.until), by: e.by == null ? '' : String(e.by),
          pinned: e.pinned === true, expired: e.expired === true, muted: e.expired === true,
        }
      })
    }

    function memoryScreenView(ui) {
      const missing = ui.scopes.state === 'missing' || ui.view.state === 'missing'
      const groups = [['team', '团队'], ['node', '每台机器'], ['bot', '机器下的 Bot']]
      const rows = ui.view.state === 'ok' ? memoryEntryRows(ui.view.data) : []
      return h('div', { className: 'dra-col dra-memory' },
        missing ? h('p', { className: 'dra-warn' }, '记忆接口不可用（' + MEMORY_API_MISSING + '）：ds-bot 没有响应 /api/bot 的记忆端点') : null,
        missing ? null : h('select', { className: 'dra-select', value: ui.scope, onChange: function (e) { ui.onScope(e.target.value) } },
          groups.map(function (g) {
            const list = ui.options.filter(function (o) { return o.group === g[0] })
            return list.length === 0 ? null : h('optgroup', { key: g[0], label: g[1] },
              list.map(function (o) { return h('option', { key: o.value, value: o.value }, o.label + (o.entries == null ? '' : '（' + o.entries + '）')) }))
          })),
        missing ? null : ui.scopes.state === 'error' ? h('p', { className: 'dra-warn' }, '读记忆失败：' + String(ui.scopes.reason)) : null,
        missing ? null : ui.view.state === 'loading' ? h('p', null, '读取中…')
          : ui.view.state === 'error' ? h('p', { className: 'dra-warn' }, '读记忆失败：' + String(ui.view.reason))
          : rows.length === 0 ? h('p', { className: 'dra-hint' }, '还没有记忆')
          : h('div', { className: 'dra-col' }, rows.map(function (r) {
            const hints = [r.topic ? '主题 ' + r.topic : '', r.added ? '添加 ' + r.added : '', r.until ? '到期 ' + r.until : '', r.pinned ? '已置顶' : '', r.expired ? '已过期' : ''].filter(Boolean)
            return h('div', { key: r.key, className: 'dra-row dra-mem-row' + (r.muted ? ' dra-muted' : ''), style: r.muted ? { opacity: 0.5 } : undefined },
              r.pinned ? h('span', { className: 'dra-badge acc' }, '置顶') : null,
              h('span', null, r.text),
              h('span', { className: 'dra-hint' }, hints.join(' · ')),
              h('button', { className: 'dra-btn sm', disabled: ui.busy, onClick: function () { ui.onForget(r) } }, '遗忘'))
          })),
        missing ? null : h('div', { className: 'dra-row' },
          h('input', { className: 'dra-input', placeholder: '记住一件事…', value: ui.draft, onChange: function (e) { ui.onDraft(e.target.value) } }),
          h('input', { className: 'dra-input', placeholder: '主题（可选）', value: ui.topic, onChange: function (e) { ui.onTopic(e.target.value) } }),
          h('button', { className: 'dra-btn dra-btn-primary', disabled: ui.busy || String(ui.draft).trim() === '', onClick: ui.onAdd }, ui.busy ? '提交中…' : '记住')),
        ui.note ? h('p', { className: 'dra-warn' }, ui.note) : null)
    }

    /* 局域网发现行：纯函数。只展示 LAN 地址名，公网/IPv6/域名一律隐藏；已配对机器剔除。 */
    function isLanHostname(host) {
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
      if (m) {
        const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
        if (o.some(function (x) { return x > 255 })) return false
        if (o[0] === 10 || o[0] === 127) return true
        if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true
        if (o[0] === 192 && o[1] === 168) return true
        if (o[0] === 169 && o[1] === 254) return true
        return false
      }
      if (/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.local$/i.test(host)) return true
      return /^[A-Za-z0-9_-]+$/.test(host)
    }

    function discoveryRows(discovery, nodes) {
      if (!discovery || discovery.enabled !== true) return { enabled: false, rows: [] }
      const peers = Array.isArray(discovery.peers) ? discovery.peers : []
      const list = Array.isArray(nodes) ? nodes : []
      const paired = {}
      const hostPaired = {}
      list.forEach(function (n) {
        if (!n || typeof n !== 'object') return
        if (typeof n.nodeId === 'string' && n.nodeId) { paired[n.nodeId] = true; hostPaired[n.nodeId] = true }
        if (typeof n.name === 'string' && n.name) hostPaired[n.name] = true
        if (typeof n.host === 'string' && n.host) hostPaired[n.host] = true
      })
      const rows = []
      peers.forEach(function (p) {
        if (!p || typeof p !== 'object') return
        const host = typeof p.hostname === 'string' ? p.hostname : ''
        if (typeof p.node === 'string' && p.node && paired[p.node] === true) return
        if (host && hostPaired[host] === true) return
        rows.push({
          node: p.node,
          role: p.role,
          port: p.port,
          addressLabel: !host ? '地址未上报' : (isLanHostname(host) ? host : '地址已隐藏'),
        })
      })
      return { enabled: true, rows: rows }
    }

    /* 与 src/http/model-list.js 的 modelListOf 同语义（客户端无 import，镜像实现，测试证明一致）。 */
    function modelRows(nodes) {
      const rows = []
      const list = Array.isArray(nodes) ? nodes : []
      for (let i = 0; i < list.length; i += 1) {
        const node = list[i]
        if (node === null || typeof node !== 'object') continue
        const nodeId = node.nodeId
        if (typeof nodeId !== 'string' || nodeId.length === 0) continue
        const models = node.models
        const reported = Array.isArray(models)
        const ids = []
        if (reported) {
          for (let j = 0; j < models.length; j += 1) {
            const m = models[j]
            if (m === null || typeof m !== 'object') continue
            if (typeof m.id === 'string' && m.id.length > 0) ids.push(m.id)
          }
        }
        const dm = node.defaultModel
        rows.push({
          nodeId: nodeId,
          defaultModel: typeof dm === 'string' && dm.length > 0 ? dm : null,
          reported: reported,
          ids: ids,
        })
      }
      return rows
    }

    /* 运行中（+ 待派发）状态集合。终态一律不进「运行中」分组。 */
    const ACTIVE_STATUSES = ['running', 'queued', 'pending_approval']
    const STATUS_LABEL = {
      running: '运行中', queued: '排队中', pending_approval: '待批准',
      completed: '已完成', failed: '失败', aborted: '已中止', interrupted: '已中断', rejected: '已拒绝',
    }

    function shouldPoll(doc) {
      return doc?.hidden !== true
    }

    function topoActivity(tasks) {
      const running = (tasks || []).some(function (t) { return t && t.status === 'running' })
      return { running: running, pulseCount: running ? 2 : 0 }
    }

    /* 运行界面只看已保存的 role。删掉下面三个 role 分支会落到旧的失败回退。 */
    function selectRuntimeView(role, probe) {
      var r = String(role || '').trim().toLowerCase()
      var overviewOk = !!(probe && probe.overviewOk)
      var overviewError = probe && probe.overviewError ? String(probe.overviewError) : '主机读失败'
      var statusError = probe && probe.statusError ? String(probe.statusError) : ''
      if (r === 'worker') {
        return {
          view: 'worker',
          showHub: false,
          showWorker: true,
          showDispatch: false,
          showNodeGrid: false,
          showTopology: false,
          showMint: false,
          showHubCard: false,
          toolbarSwitch: false,
          sections: ['副机'],
          error: statusError,
        }
      }
      if (r === 'both') {
        return {
          view: 'both',
          showHub: true,
          showWorker: true,
          showDispatch: true,
          showNodeGrid: true,
          showTopology: true,
          showMint: true,
          showHubCard: true,
          toolbarSwitch: false,
          sections: ['主机', '副机'],
          error: overviewOk ? '' : overviewError,
        }
      }
      if (r === 'hub') {
        return {
          view: overviewOk ? 'hub' : 'hub-error',
          showHub: true,
          showWorker: false,
          showDispatch: true,
          showNodeGrid: true,
          showTopology: true,
          showMint: true,
          showHubCard: true,
          toolbarSwitch: false,
          sections: ['主机'],
          error: overviewOk ? '' : overviewError,
        }
      }
      if (probe && probe.overviewOk === false) {
        return {
          view: 'worker',
          showHub: true,
          showWorker: true,
          showDispatch: true,
          toolbarSwitch: true,
          sections: ['副机'],
          error: '',
        }
      }
      return {
        view: 'hub',
        showHub: true,
        showWorker: false,
        showDispatch: true,
        toolbarSwitch: true,
        sections: ['主机'],
        error: '',
      }
    }

    /* ═══ 拓扑图：网络图（非树）。纯函数 + 单一 tick(t) 驱动的渲染 ═══ */
    const TOPO_COMPACT_BELOW = 660

    function topologyScale(width) {
      return Number.isFinite(width) && width > 0 && width < TOPO_COMPACT_BELOW ? 'compact' : 'wide'
    }

    /* 任务状态 → 四类动效之一（running / queued / completed / failed）；其余归 other，无动效。 */
    function topoTaskState(status) {
      if (status === 'running') return 'running'
      if (status === 'queued' || status === 'pending_approval') return 'queued'
      if (status === 'completed') return 'completed'
      if (status === 'failed' || status === 'aborted' || status === 'interrupted' || status === 'rejected') return 'failed'
      return 'other'
    }

    function topoHash(text) {
      const s = String(text)
      let x = 2166136261
      for (let i = 0; i < s.length; i += 1) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0 }
      return x >>> 0
    }
    function topoUnit(id, salt) { return (topoHash(id + '|' + salt) % 10000) / 10000 }
    function topoR1(v) { return Math.round(v * 10) / 10 }

    /* 只取真实探测到的 rttMs；没有就是 null，绝不补 0。 */
    function topoRtt(n) {
      const c = n.connectivity && typeof n.connectivity === 'object' ? n.connectivity : null
      const probes = Array.isArray(n.probes) ? n.probes : (c && Array.isArray(c.probes) ? c.probes : [])
      let best = null
      probes.forEach(function (p) {
        if (p && typeof p.rttMs === 'number' && Number.isFinite(p.rttMs) && p.rttMs >= 0) {
          best = best === null ? p.rttMs : Math.min(best, p.rttMs)
        }
      })
      return best === null ? null : Math.round(best)
    }

    /* 概览只有明确写 reachable === false 才算中继不可达；缺字段不画中继。 */
    function topologyRelayDown(connection, relay) {
      return (relay && relay.reachable === false)
        || (connection && connection.relay && connection.relay.reachable === false)
        || (connection && connection.relayReachable === false)
    }

    /* 中继状态三态：只有明确写 reachable === false 才是「不可达」；明确 true 才是「上报可达」；其余一律「未上报」。 */
    function topoRelayStatus(connection, relay) {
      const flags = [
        relay && relay.reachable,
        connection && connection.relay && connection.relay.reachable,
        connection && connection.relayReachable,
      ]
      if (flags.some(function (v) { return v === false })) return 'unreachable'
      if (flags.some(function (v) { return v === true })) return 'reachable'
      return 'unreported'
    }

    /* ═══ 对等候选（peer candidate）：纯函数模型。服务端 peerLinks 只是「双方均上报对等地址」的候选列表，
       不是链路探测结果；这里不推断缺失的对、不假设完全图、不得写成「已连接」。 ═══ */
    const TOPO_PAIR_CAP = 60
    const TOPO_PREVIEW_WIDE = 6
    const TOPO_PREVIEW_COMPACT = 3
    const TOPO_SAMPLE_STALE_MS = 600000
    const TOPO_STALE_HYSTERESIS_N = 2
    // The state setter is stable for the lifetime of its Panel instance.
    const topoStaleByPanel = new WeakMap()

    /* 拓扑局部文案表（本文件没有通用翻译机制，这里集中，渲染与测试共用同一份）。 */
    const TOPO_TEXT = {
      missing: '对等候选：未上报',
      empty: '无对等候选',
      insufficient: '可对等节点不足 2 台',
      received: function (n) { return '收到 ' + n + ' 对有效候选' },
      capped: '已达服务端上限 60，可能不完整',
      band: function (server, n, capped) {
        return '对等候选组：服务端计数 ' + (server === null ? '未上报' : server + ' 台') + ' · ' + TOPO_TEXT.received(n)
          + (capped ? ' · ' + TOPO_TEXT.capped : '')
      },
      dropped: function (n) { return n + ' 条被丢弃' },
      oldData: '预览基于旧数据',
      staleData: '数据陈旧',
      staleAnnounce: '数据陈旧：刷新失败，显示最后一次成功的数据',
      staleBody: '刷新失败，显示最后一次成功的数据',
      lost: '已固定的电脑不在最新列表中',
      pinned: function (name) { return '已固定：' + name },
      unpinned: function (name) { return '已取消固定' + (name ? '：' + name : '') },
      more: function (n) { return '+' + n + ' 更多' },
      relay: { unreported: '中继：未上报', unreachable: '中继：不可达', reachable: '中继：上报可达' },
      hbTimeout: '心跳超时',
      sampleStale: '采样陈旧',
      online: '在线',
      offline: '离线',
      transport: { direct: '直连', relay: '中继', unknown: '传输未知' },
      peer: function (d, capped) { return '对等 ' + d + (capped ? '+' : '') },
      noPeer: '—',
      listLabel: '电脑列表',
      svgLabel: function (n) { return '电脑与任务拓扑：' + n + ' 台电脑，完整信息见下方电脑列表' },
      legend: '实线＝主控直连 · 短划＝经主控中继 · 点线＝传输方式未知（空闲边；运行、排队、离线的边另有线型）'
        + ' · 细点线（预览）＝对等候选：服务端列出，未验证 · 虚线带＝对等候选组',
      legacyLegend: '实线 = 经主控直连 · 橙色虚线 = 经主控中继 · 点线 = 未知 · 点划虚线带 = 对等候选组（服务端列出，未验证，不代表可用链路）',
      pin: '固定',
      unpin: '取消固定',
      loading: '读取中…',
      empty0: '还没有任何电脑接入',
    }

    function topoNodeId(n) {
      return n && typeof n === 'object' && !Array.isArray(n) ? String(n.nodeId != null ? n.nodeId : (n.id != null ? n.id : '')) : ''
    }
    function topoCmp(a, b) { return a < b ? -1 : a > b ? 1 : 0 }

    function topoMeshModel(topology, drawnNodes) {
      const T = TOPO_TEXT
      const drawn = Object.create(null)
      ;(Array.isArray(drawnNodes) ? drawnNodes : []).forEach(function (n) {
        const id = topoNodeId(n)
        if (id !== '' && !(id in drawn)) drawn[id] = n
      })
      const isObj = topology !== null && typeof topology === 'object' && !Array.isArray(topology)
      const raw = isObj && Array.isArray(topology.peerLinks) ? topology.peerLinks : null
      const summary = isObj && topology.summary && typeof topology.summary === 'object' ? topology.summary : null
      const server = summary && typeof summary.peerCapable === 'number' && Number.isFinite(summary.peerCapable) ? summary.peerCapable : null
      const interactive = Object.create(null)
      Object.keys(drawn).forEach(function (id) {
        if (drawn[id].online === true && drawn[id].stale !== true) interactive[id] = true
      })
      const eligible = Object.create(null)
      if (isObj && Array.isArray(topology.nodes)) {
        topology.nodes.forEach(function (e) {
          if (e && typeof e === 'object' && typeof e.nodeId === 'string' && e.nodeId.trim() !== '' && e.online === true && e.peerCapable === true) eligible[e.nodeId] = true
        })
      }
      const seen = Object.create(null)
      const pairs = []
      let dropped = 0
      let duplicates = 0
      ;(raw || []).forEach(function (l) {
        if (!l || typeof l !== 'object' || Array.isArray(l) || typeof l.from !== 'string' || typeof l.to !== 'string'
          || l.from.trim() === '' || l.to.trim() === '' || l.from === l.to || eligible[l.from] !== true || eligible[l.to] !== true) {
          dropped += 1
          return
        }
        const lo = l.from < l.to ? l.from : l.to
        const hi = l.from < l.to ? l.to : l.from
        const key = lo + '\u0000' + hi
        if (seen[key]) { duplicates += 1; return }
        seen[key] = true
        pairs.push({ a: lo, b: hi })
      })
      pairs.sort(function (x, y) { return topoCmp(x.a, y.a) || topoCmp(x.b, y.b) })
      const neighbors = Object.create(null)
      pairs.forEach(function (p) {
        ;(neighbors[p.a] = neighbors[p.a] || []).push(p.b)
        ;(neighbors[p.b] = neighbors[p.b] || []).push(p.a)
      })
      const degree = Object.create(null)
      Object.keys(neighbors).forEach(function (id) { neighbors[id].sort(topoCmp); degree[id] = neighbors[id].length })
      const state = raw === null ? 'missing' : raw.length === 0 ? 'empty' : 'ready'
      const capped = raw !== null && raw.length >= TOPO_PAIR_CAP
      const reason = state === 'empty' && server !== null && server <= 1 ? 'insufficient' : ''
      const band = state === 'ready' && pairs.length >= 1
      const badges = Object.create(null)
      Object.keys(drawn).forEach(function (id) {
        badges[id] = state === 'missing' ? ''
          : interactive[id] === true && drawn[id].peerCapable === true ? T.peer(degree[id] || 0, capped) : T.noPeer
      })
      const labels = {
        received: T.received(pairs.length),
        capped: capped ? T.capped : '',
        band: band ? T.band(server, pairs.length, capped) : '',
        dropped: dropped > 0 ? T.dropped(dropped) : '',
        summary: state === 'missing' ? T.missing
          : state === 'empty' ? T.empty + (reason ? '（' + T.insufficient + '）' : '')
            : T.received(pairs.length) + (capped ? ' · ' + T.capped : ''),
      }
      return {
        state: state, pairs: pairs, received: raw === null ? 0 : raw.length, aggregate: pairs.length,
        dropped: dropped, duplicates: duplicates, degree: degree, neighbors: neighbors, interactive: interactive,
        capped: capped, serverPeerCapable: server, reason: reason, band: band, badges: badges, labels: labels,
      }
    }

    /* 某节点的预览/完整邻居：预览按 id 升序取前 cap 条且排除心跳超时/离线端点；完整列表不截断。 */
    function topoNeighborView(model, id, opts) {
      const m = model && typeof model === 'object' ? model : {}
      const key = String(id)
      const capIn = opts && Number.isFinite(opts.cap) ? Math.floor(opts.cap) : TOPO_PREVIEW_WIDE
      const cap = Math.max(0, capIn)
      const full = m.neighbors && m.neighbors[key] ? m.neighbors[key].slice() : []
      const previewable = !!(m.interactive && m.interactive[key] === true)
      const live = previewable ? full.filter(function (x) { return m.interactive[x] === true }) : []
      return { id: key, preview: live.slice(0, cap), overflow: Math.max(0, live.length - cap), full: full, previewable: previewable }
    }

    const TOPO_PIN_INIT = { pinned: '', hover: '', focus: '', stale: false, lost: false, announce: '', exitFullscreen: false }

    /* 固定 / 预览 / 陈旧状态机；纯函数，不改入参。exitFullscreen 只在「Escape 且已无可清除内容」时为 true。 */
    function topoPinReducer(state, event) {
      const s = Object.assign({}, TOPO_PIN_INIT, state && typeof state === 'object' ? state : {})
      const e = event && typeof event === 'object' ? event : {}
      const T = TOPO_TEXT
      const id = e.id == null ? '' : String(e.id)
      const base = Object.assign({}, s, { exitFullscreen: false })
      const toggle = function () {
        const name = e.label == null || e.label === '' ? id : String(e.label)
        if (id === '') return base
        return s.pinned === id
          ? Object.assign({}, base, { pinned: '', lost: false, announce: T.unpinned(name) })
          : Object.assign({}, base, { pinned: id, lost: false, announce: T.pinned(name) })
      }
      const escape = function () {
        if (s.pinned !== '' || s.hover !== '' || s.focus !== '') {
          return Object.assign({}, base, { pinned: '', hover: '', focus: '', announce: s.pinned !== '' ? T.unpinned('') : s.announce })
        }
        return Object.assign({}, base, { exitFullscreen: true })
      }
      switch (e.type) {
        case 'hover': return Object.assign({}, base, { hover: id })
        case 'focus': return Object.assign({}, base, { focus: id })
        case 'blur': return Object.assign({}, base, { focus: id === '' || s.focus === id ? '' : s.focus })
        case 'click': return toggle()
        case 'key':
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') return toggle()
          if (e.key === 'Escape') return escape()
          return s
        case 'escape': return escape()
        case 'refresh': {
          const ids = Array.isArray(e.ids) ? e.ids.map(String) : []
          const has = function (x) { return x === '' || ids.indexOf(x) >= 0 }
          const lost = s.pinned !== '' && !has(s.pinned)
          return Object.assign({}, base, {
            pinned: has(s.pinned) ? s.pinned : '', hover: has(s.hover) ? s.hover : '', focus: has(s.focus) ? s.focus : '',
            stale: false, lost: s.lost || lost,
            announce: lost ? T.lost : s.stale ? '' : s.announce,
          })
        }
        case 'error':
          return s.stale ? s : Object.assign({}, base, { stale: true, announce: T.staleAnnounce })
        default: return s
      }
    }

    /* 节点数 / 候选对数 / 容器宽度 → 回退行为（与 BOOK §3.4-9 一致）。默认零候选边，与对数无关。 */
    function topoFallbackMode(nodeCount, pairCount, width) {
      const n = Number.isFinite(nodeCount) && nodeCount > 0 ? Math.floor(nodeCount) : 0
      const p = Number.isFinite(pairCount) && pairCount > 0 ? Math.floor(pairCount) : 0
      const scale = topologyScale(width)
      const previewCap = scale === 'compact' ? TOPO_PREVIEW_COMPACT : TOPO_PREVIEW_WIDE
      const maxDegree = n <= 1 ? 0 : Math.min(n - 1, p)
      return {
        scale: scale, previewCap: previewCap, band: n >= 2 && p >= 1, capped: p >= TOPO_PAIR_CAP,
        overflowPossible: maxDegree > previewCap, defaultEdges: 0,
      }
    }

    /* 心跳超时优先；采样超过 600 s 才算陈旧；缺失不推断。 */
    function topoStaleLabel(node, now) {
      if (!node || typeof node !== 'object') return ''
      if (node.stale === true) return TOPO_TEXT.hbTimeout
      const c = node.connectivity && typeof node.connectivity === 'object' ? node.connectivity : null
      const at = c && c.sampledAt != null ? c.sampledAt : node.sampledAt
      const t = Number.isFinite(now) ? now : Date.now()
      return typeof at === 'number' && Number.isFinite(at) && t - at > TOPO_SAMPLE_STALE_MS ? TOPO_TEXT.sampleStale : ''
    }

    function topoNodeStatus(raw) {
      return raw && raw.stale === true ? 'stale' : raw && raw.online === true ? 'online' : 'offline'
    }
    function topoTransportLabel(raw) {
      const c = raw && raw.connectivity && typeof raw.connectivity === 'object' ? raw.connectivity : null
      const mode = raw && raw.transportMode != null ? raw.transportMode : (raw && raw.transport != null ? raw.transport : (c ? c.transportMode : null))
      return mode === 'direct' ? TOPO_TEXT.transport.direct : mode === 'relay' ? TOPO_TEXT.transport.relay : TOPO_TEXT.transport.unknown
    }
    function topoTransportKey(raw) {
      const l = topoTransportLabel(raw)
      return l === TOPO_TEXT.transport.direct ? 'direct' : l === TOPO_TEXT.transport.relay ? 'relay' : 'unknown'
    }
    function topoLinkCategory(raw) {
      // Limit the evidence to transportMode, excluding the legacy transport fallbacks.
      const transport = topoTransportKey({ transportMode: raw.transportMode })
      if (transport === 'relay') return '中继'
      if (transport !== 'direct') return '未知'
      return typeof raw.address === 'string' && isLanHostname(raw.address) ? '局域网直连' : '直连'
    }

    function topoHealthForRender(panel, nodes) {
      const previous = topoStaleByPanel.get(panel)
      const consecutiveStale = new Map()
      const health = new Map()
      nodes.forEach(function (node) {
        const id = topoNodeId(node)
        if (!id || health.has(id)) return
        let count = previous?.get(id)
        if (node.stale === true) count = (count ?? 0) + 1
        else if (node.stale === false) count = 0
        if (count !== undefined) consecutiveStale.set(id, count)

        let label = '健康: 未知'
        if (typeof node.stale === 'boolean') {
          if (count === 0) label = '健康: 稳定'
          else if (count >= TOPO_STALE_HYSTERESIS_N) label = '健康: 连续失败'
          else label = '健康: 探测失败 ' + count + '/' + TOPO_STALE_HYSTERESIS_N
        }
        health.set(id, { category: topoLinkCategory(node), label: label })
      })
      topoStaleByPanel.set(panel, consecutiveStale)
      return health
    }

    function topoHealthOverlay(health, id) {
      const entry = health?.get(id)
      return entry ? [
        h('span', { key: 'link-category', className: 'dra-link-category' }, entry.category),
        h('span', { key: 'link-health', className: 'dra-badge dra-link-health' }, entry.label),
      ] : null
    }

    function topoStatusText(status) {
      return status === 'stale' ? TOPO_TEXT.hbTimeout : status === 'online' ? TOPO_TEXT.online : TOPO_TEXT.offline
    }

    /* 容器实测尺寸；永远不读 window.innerWidth。 */
    function topologyFit(box) {
      const w = box && Number.isFinite(box.clientWidth) && box.clientWidth > 0 ? box.clientWidth : 0
      const hh = box && Number.isFinite(box.clientHeight) && box.clientHeight > 0 ? box.clientHeight : 0
      return { width: w, height: hh || Math.round(w * 0.6) }
    }

    /* 纯函数：同输入同输出，无随机、无时钟、无窗口读取。任务只作为机器上的投影，不是节点。 */
    function boardLayout(input) {
      const src = input && typeof input === 'object' ? input : {}
      const W = Number.isFinite(src.width) && src.width > 0 ? src.width : 960
      const H = Number.isFinite(src.height) && src.height > 0 ? src.height : 560
      const scale = topologyScale(W)
      const compact = scale === 'compact'
      const cardW = compact ? 88 : 140
      const cardH = compact ? 34 : 52
      const tickR = compact ? 2.6 : 3.2
      const hubR = compact ? 22 : 32
      const ringRx = cardW / 2 + 7
      const ringRy = cardH / 2 + 7
      const pad = Math.hypot(ringRx, ringRy) + 6
      const seen = {}
      const list = []
      ;(Array.isArray(src.nodes) ? src.nodes : []).forEach(function (n) {
        if (!n || typeof n !== 'object' || Array.isArray(n)) return
        const id = String(n.nodeId != null ? n.nodeId : (n.id != null ? n.id : ''))
        if (id === '' || seen[id]) return
        seen[id] = true
        list.push({ n: n, id: id })
      })
      list.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 })
      const byNode = {}
      const unattached = []
      ;(Array.isArray(src.tasks) ? src.tasks : [])
        .filter(function (t) { return t && typeof t === 'object' && t.taskId != null })
        .slice().sort(function (a, b) { return String(a.taskId) < String(b.taskId) ? -1 : String(a.taskId) > String(b.taskId) ? 1 : 0 })
        .forEach(function (t) {
          const nid = t.nodeId == null ? '' : String(t.nodeId)
          const entry = { taskId: String(t.taskId), state: topoTaskState(t.status) }
          if (seen[nid]) (byNode[nid] = byNode[nid] || []).push(entry)
          else unattached.push({ taskId: entry.taskId, state: entry.state, nodeId: nid })
        })
      const hub = { id: 'hub', label: '中控', x: topoR1(W / 2 + W * 0.015), y: topoR1(H / 2 - H * 0.02), r: hubR }
      const rx = Math.max(0, (W / 2 - pad) * 0.96)
      const ry = Math.max(0, (H / 2 - pad) * 0.96)
      const count = list.length
      const order = { running: 0, queued: 1, failed: 2, completed: 3, other: 4 }
      const nodes = list.map(function (e, i) {
        const step = Math.PI * 2 / count
        const ang = -Math.PI / 2 + step * i + (topoUnit(e.id, 'a') - 0.5) * step * 0.45 + 0.35
        const rf = 0.72 + 0.28 * topoUnit(e.id, 'r')
        const x = topoR1(Math.min(W - pad, Math.max(pad, hub.x + Math.cos(ang) * rx * rf)))
        const y = topoR1(Math.min(H - pad, Math.max(pad, hub.y + Math.sin(ang) * ry * rf)))
        const online = e.n.online === true && e.n.stale !== true
        const mine = (byNode[e.id] || []).slice().sort(function (a, b) {
          return order[a.state] - order[b.state] || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)
        })
        const counts = { running: 0, queued: 0, completed: 0, failed: 0, total: mine.length }
        mine.forEach(function (t) { if (counts[t.state] !== undefined) counts[t.state] += 1 })
        const parts = []
        if (counts.running) parts.push(counts.running + ' 运行')
        if (counts.queued) parts.push(counts.queued + ' 排队')
        if (counts.completed) parts.push(counts.completed + ' 完成')
        if (counts.failed) parts.push(counts.failed + ' 失败')
        const badge = parts.length ? parts.join(' · ') : '无任务'
        const shown = Math.min(mine.length, 24)
        const ticks = mine.slice(0, shown).map(function (t, k) {
          const a = -Math.PI / 2 + Math.PI * 2 * k / shown
          return { taskId: t.taskId, state: t.state, x: topoR1(x + Math.cos(a) * ringRx), y: topoR1(y + Math.sin(a) * ringRy) }
        })
        const rtt = topoRtt(e.n)
        const edgeState = !online ? 'offline' : counts.running ? 'running' : counts.queued ? 'queued'
          : counts.total > 0 && counts.completed === counts.total ? 'completed' : 'idle'
        return {
          id: e.id,
          name: String(e.n.name || e.id),
          address: typeof e.n.address === 'string' ? e.n.address : '',
          x: x, y: y, w: cardW, h: cardH, tickR: tickR,
          online: online, state: online ? 'online' : 'offline', edgeState: edgeState,
          status: topoNodeStatus(e.n), transportLabel: topoTransportLabel(e.n),
          transport: topoTransportKey(e.n),
          rttMs: rtt,
          rttLabel: rtt === null ? '延迟未测' : 'rtt ' + rtt + 'ms',
          counts: counts,
          badge: badge,
          badgeCompact: badge.replace(/ /g, ''),
          ticks: ticks,
          moreTicks: mine.length - shown,
        }
      })
      const edges = nodes.map(function (m) {
        const dx = m.x - hub.x
        const dy = m.y - hub.y
        const len = Math.hypot(dx, dy) || 1
        const off = len * (0.06 + 0.08 * topoUnit(m.id, 'c')) * (topoHash(m.id + '|s') % 2 === 0 ? 1 : -1)
        const cx = topoR1((hub.x + m.x) / 2 - dy / len * off)
        const cy = topoR1((hub.y + m.y) / 2 + dx / len * off)
        return {
          id: 'hub>' + m.id, kind: 'hub', from: 'hub', to: m.id, state: m.edgeState, transport: m.transport,
          x1: hub.x, y1: hub.y, cx: cx, cy: cy, x2: m.x, y2: m.y,
          d: 'M' + hub.x + ' ' + hub.y + ' Q' + cx + ' ' + cy + ' ' + m.x + ' ' + m.y,
          lx: topoR1(0.25 * hub.x + 0.5 * cx + 0.25 * m.x), ly: topoR1(0.25 * hub.y + 0.5 * cy + 0.25 * m.y),
          label: !m.online ? '断' : m.rttMs === null ? 'rtt —' : 'rtt ' + m.rttMs + 'ms',
        }
      })
      let relay = null
      if (src.relayUnreachable === true) {
        const rxp = topoR1(W - pad)
        const ryp = topoR1(pad)
        const cx = topoR1((hub.x + rxp) / 2 + 10)
        const cy = topoR1((hub.y + ryp) / 2 - 10)
        relay = { id: 'relay', label: '中继', x: rxp, y: ryp, w: cardW * 0.7, h: cardH * 0.8, state: 'down' }
        edges.push({
          id: 'hub>relay', kind: 'relay', from: 'hub', to: 'relay', state: 'down',
          x1: hub.x, y1: hub.y, cx: cx, cy: cy, x2: rxp, y2: ryp,
          d: 'M' + hub.x + ' ' + hub.y + ' Q' + cx + ' ' + cy + ' ' + rxp + ' ' + ryp,
          lx: topoR1(0.25 * hub.x + 0.5 * cx + 0.25 * rxp), ly: topoR1(0.25 * hub.y + 0.5 * cy + 0.25 * ryp),
          label: '中继不可达',
        })
      }
      return { width: W, height: H, scale: scale, hub: hub, nodes: nodes, edges: edges, relay: relay, unattached: unattached }
    }

    function topologyLayout(input, second) {
      return Array.isArray(input) ? legacyTopologyLayout(input, second) : boardLayout(input)
    }

    function topoQuad(e, p) {
      const q = 1 - p
      return { x: q * q * e.x1 + 2 * q * p * e.cx + p * p * e.x2, y: q * q * e.y1 + 2 * q * p * e.cy + p * p * e.y2 }
    }

    /* 所有动效只由 t（秒）推出；reduced 或 t 非法 → 完全静态。 */
    function topologyMotion(layout, t, opts) {
      const still = (opts && opts.reduced === true) || typeof t !== 'number' || !Number.isFinite(t)
      const m = { reduced: still, edges: {}, nodes: {}, hub: { angle: 0, pulseR: 0, pulseOpacity: 0 }, shimmer: 0, tick: 1 }
      const hub = layout.hub
      if (!still) {
        const p = (t * 0.55) % 1
        m.hub = { angle: (t * 24) % 360, pulseR: hub.r + 6 + p * 34, pulseOpacity: 0.45 * (1 - p) }
        m.shimmer = (t * 0.7) % 1
        m.tick = 0.65 + 0.35 * Math.sin(t * 5)
      }
      layout.edges.forEach(function (e) {
        const run = e.state === 'running' && !still
        m.edges[e.id] = { dashOffset: run ? -(t * 36) : 0, packets: run ? [0, 0.5].map(function (ph) {
          const pos = topoQuad(e, (((t * 0.45 + ph) % 1) + 1) % 1)
          return { x: topoR1(pos.x), y: topoR1(pos.y), r: 3.6, glow: 8 }
        }) : [] }
      })
      layout.nodes.forEach(function (n) {
        if (still || !n.online) { m.nodes[n.id] = null; return }
        const b = 0.5 + 0.5 * Math.sin(t * 2.2 + topoUnit(n.id, 'p') * 6.28)
        m.nodes[n.id] = { expand: 3 + 5 * b, opacity: 0.2 + 0.35 * b }
      })
      return m
    }

    function topoCut(text, max) {
      const s = String(text)
      return s.length > max ? s.slice(0, max - 1) + '…' : s
    }

    function renderTopologyScene(layout, tasks, opts) {
      const o = opts || {}
      const m = topologyMotion(layout, o.t, { reduced: o.reduced === true })
      const compact = layout.scale === 'compact'
      const hover = o.hover || null
      const onHover = typeof o.onHover === 'function' ? o.onHover : function () {}
      let hl = ''
      if (hover && hover.kind === 'node') hl = String(hover.id)
      else if (hover && hover.kind === 'task') {
        const tk = (tasks || []).find(function (x) { return x && String(x.taskId) === String(hover.id) })
        hl = tk && tk.nodeId != null ? String(tk.nodeId) : ''
      }
      const dim = function (id) { return hl !== '' && id !== hl ? ' dim' : '' }
      const hub = layout.hub
      const kids = []
      const mesh = o.mesh || null
      const dispatch = typeof o.dispatch === 'function' ? o.dispatch : null
      const ui = o.ui && typeof o.ui === 'object' ? o.ui : TOPO_PIN_INIT
      const rawById = o.rawById || {}
      const pos = {}
      layout.nodes.forEach(function (n) { pos[n.id] = n })
      /* 对等候选：默认零连线。只有一条整圈虚线带；预览线只在悬停/聚焦/固定时出现，数量受 cap 限制。 */
      if (mesh && mesh.band && layout.nodes.length > 0) {
        const cw = layout.nodes[0].w
        const ch = layout.nodes[0].h
        const pad = Math.hypot(cw / 2 + 7, ch / 2 + 7) + 6
        const mrx = Math.max(hub.r + 16, (layout.width / 2 - pad) * 0.96 * 0.52)
        const mry = Math.max(hub.r + 16, (layout.height / 2 - pad) * 0.96 * 0.52)
        kids.push(h('ellipse', { key: 'mesh-band', cx: hub.x, cy: hub.y, rx: topoR1(mrx), ry: topoR1(mry), className: 'dra-mesh-band' },
          h('title', null, mesh.labels.band)))
      }
      const focusId = ui.hover || ui.focus || ui.pinned || ''
      const nv = mesh && focusId !== '' ? topoNeighborView(mesh, focusId, { cap: o.previewCap || (compact ? TOPO_PREVIEW_COMPACT : TOPO_PREVIEW_WIDE) }) : null
      if (nv) {
        nv.preview.forEach(function (nid) {
          const p1 = pos[focusId]
          const p2 = pos[nid]
          if (!p1 || !p2) return
          kids.push(h('line', {
            key: 'me-' + focusId + '>' + nid, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
            className: 'dra-mesh-edge' + (o.staleData === true ? ' old' : ''),
          }))
        })
      }
      layout.edges.forEach(function (e) {
        const mo = m.edges[e.id]
        const flow = e.state === 'running' && !m.reduced
        kids.push(h('path', {
          key: 'e-' + e.id, d: e.d,
          className: 'dra-tg-edge st-' + e.state + (e.kind === 'hub' && e.transport ? ' tr-' + e.transport : '') + (flow ? ' is-flow' : '') + dim(e.to),
          style: flow ? { strokeDashoffset: mo.dashOffset } : undefined,
        }))
        if (!compact || e.state === 'offline' || e.kind === 'relay') {
          kids.push(h('text', { key: 'el-' + e.id, x: e.lx, y: e.ly - 4, className: 'dra-tg-elabel st-' + e.state + dim(e.to) }, e.label))
        }
      })
      layout.edges.forEach(function (e) {
        m.edges[e.id].packets.forEach(function (p, i) {
          kids.push(h('g', { key: 'pk-' + e.id + '-' + i, className: 'dra-tg-packet' + dim(e.to) },
            h('circle', { cx: p.x, cy: p.y, r: p.glow, className: 'dra-tg-glow' }),
            h('circle', { cx: p.x, cy: p.y, r: p.r, className: 'dra-tg-dot' })))
        })
      })
      kids.push(h('g', { key: 'hub', className: 'dra-tg-hub' },
        m.hub.pulseOpacity > 0 ? h('circle', { cx: hub.x, cy: hub.y, r: m.hub.pulseR, className: 'dra-tg-hubpulse', style: { opacity: m.hub.pulseOpacity } }) : null,
        h('circle', { cx: hub.x, cy: hub.y, r: hub.r + 6, className: 'dra-tg-hubring', transform: 'rotate(' + m.hub.angle + ' ' + hub.x + ' ' + hub.y + ')' }),
        h('circle', { cx: hub.x, cy: hub.y, r: hub.r, className: 'dra-tg-hubcore' }),
        h('text', { x: hub.x, y: hub.y + 4, className: 'dra-tg-hubtext' }, hub.label)))
      if (layout.relay) {
        const r = layout.relay
        kids.push(h('g', { key: 'relay', className: 'dra-tg-relay' + dim('relay') },
          h('rect', { x: r.x - r.w / 2, y: r.y - r.h / 2, width: r.w, height: r.h, rx: 8, className: 'dra-tg-relaybox' }),
          h('text', { x: r.x, y: r.y + 4, className: 'dra-tg-name' }, r.label)))
      }
      layout.nodes.forEach(function (n) {
        const pulse = m.nodes[n.id]
        const raw = rawById[n.id]
        const peerBadge = mesh && mesh.badges[n.id] ? mesh.badges[n.id] : ''
        const staleText = raw ? topoStaleLabel(raw, o.now) : ''
        const label = n.name + '，' + topoStatusText(n.status) + '，' + n.transportLabel + '，' + n.rttLabel + '，' + n.badge
          + (peerBadge ? '，' + peerBadge : '') + (staleText && n.status !== 'stale' ? '，' + staleText : '')
        const act = function (type) { if (dispatch) dispatch({ type: type, id: n.id, label: n.name }) }
        kids.push(h('g', {
          key: 'n-' + n.id,
          className: 'dra-tg-node ' + n.state + (n.status === 'stale' ? ' stale' : '') + (ui.pinned === n.id ? ' pinned' : '') + dim(n.id),
          tabIndex: 0, role: 'button', 'aria-pressed': ui.pinned === n.id, 'aria-label': label,
          onMouseEnter: function () { onHover('node', n.id); act('hover') },
          onMouseLeave: function () { onHover(null, null); if (dispatch) dispatch({ type: 'hover', id: '' }) },
          onFocus: function () { act('focus') },
          onBlur: function () { act('blur') },
          onClick: function () { act('click') },
          onKeyDown: function (ev) {
            const k = ev && ev.key
            if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
              if (ev && typeof ev.preventDefault === 'function') ev.preventDefault()
              if (dispatch) dispatch({ type: 'key', key: k, id: n.id, label: n.name })
            }
          },
        },
          h('title', null, n.name + (n.address ? ' · ' + n.address : '') + ' · ' + n.rttLabel + ' · ' + n.badge),
          pulse ? h('rect', {
            x: n.x - n.w / 2 - pulse.expand, y: n.y - n.h / 2 - pulse.expand,
            width: n.w + pulse.expand * 2, height: n.h + pulse.expand * 2, rx: 10 + pulse.expand,
            className: 'dra-tg-pulse', style: { opacity: pulse.opacity },
          }) : null,
          h('rect', { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h, rx: 8, className: 'dra-tg-card ' + n.state + (n.status === 'stale' ? ' stale' : '') + (ui.pinned === n.id ? ' pinned' : '') }),
          h('text', { x: n.x, y: n.y - (compact ? 2 : 8), className: 'dra-tg-name' }, topoCut(n.name, compact ? 10 : 18)),
          h('text', { x: n.x, y: n.y + (compact ? 10 : 6), className: 'dra-tg-badge' }, topoCut(compact ? n.badgeCompact : n.badge, compact ? 11 : 22)),
          compact ? null : h('text', { x: n.x, y: n.y + 19, className: 'dra-tg-sub' },
            topoCut((n.address ? n.address + ' · ' : '') + n.rttLabel, 24)),
          n.ticks.map(function (tk) {
            return h('circle', {
              key: 'tk-' + tk.taskId, cx: tk.x, cy: tk.y, r: n.tickR,
              className: 'dra-tg-tick st-' + tk.state,
              style: tk.state === 'running' && !m.reduced ? { opacity: m.tick } : undefined,
            })
          }),
          peerBadge ? h('text', { x: n.x + n.w / 2 - 4, y: n.y - n.h / 2 + 11, className: 'dra-mesh-badge' }, peerBadge) : null,
          n.moreTicks > 0 ? h('text', { x: n.x + n.w / 2 + 4, y: n.y - n.h / 2 - 2, className: 'dra-tg-sub' }, '+' + n.moreTicks) : null))
      })
      return h('svg', {
        className: 'dra-tg-svg', viewBox: '0 0 ' + layout.width + ' ' + layout.height,
        preserveAspectRatio: 'xMidYMid meet', width: '100%', height: '100%', role: 'group', 'aria-label': TOPO_TEXT.svgLabel(layout.nodes.length),
      }, kids)
    }

    /* rAF 循环：reduced 时根本不启动。返回停止函数。 */
    function startTopologyLoop(opts) {
      if (!opts || opts.reduced === true || typeof opts.raf !== 'function') return function () {}
      let alive = true
      let start = null
      let id = 0
      const frame = function (ts) {
        if (!alive) return
        if (start === null) start = ts
        opts.onTick((ts - start) / 1000)
        id = opts.raf.call(globalThis, frame)
      }
      id = opts.raf.call(globalThis, frame)
      return function () { alive = false; if (typeof opts.cancel === 'function') opts.cancel.call(globalThis, id) }
    }

    function prefersReducedMotion() {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
    }

    /* 可测的纯渲染：同入参同树。状态（固定/预览/陈旧）由调用方的 reducer 持有，这里只读 ui。 */
    function renderTopologyBoardView(v) {
      const T = TOPO_TEXT
      const nodes = Array.isArray(v.nodes) ? v.nodes : []
      const tasks = Array.isArray(v.tasks) ? v.tasks : []
      const ui = Object.assign({}, TOPO_PIN_INIT, v.ui && typeof v.ui === 'object' ? v.ui : {})
      const dispatch = typeof v.dispatch === 'function' ? v.dispatch : function () {}
      const error = typeof v.error === 'string' ? v.error : ''
      const stale = error !== '' || ui.stale === true
      const relayStatus = v.relayStatus === 'unreachable' || v.relayStatus === 'reachable' ? v.relayStatus : 'unreported'
      const alert = error !== '' ? h('div', { key: 'err', className: 'dra-banner err', role: 'alert' },
        h('div', { className: 'dra-banner-title' }, T.staleData),
        h('div', { className: 'dra-mono dra-wrap' }, error),
        h('div', { className: 'dra-hint' }, T.staleBody)) : null
      if (nodes.length === 0) {
        if (error !== '') return h('div', { className: 'dra-tg-board' }, alert)
        if (v.loading === true) {
          return h('div', { className: 'dra-tg-board dra-tg-skeleton', 'aria-busy': true },
            h('div', { className: 'dra-hint' }, T.loading))
        }
        return h('div', { className: 'dra-empty' }, T.empty0)
      }
      const width = Number.isFinite(v.width) ? v.width : 0
      const mesh = topoMeshModel(v.topology, nodes)
      const fb = topoFallbackMode(nodes.length, mesh.aggregate, width)
      const rawById = {}
      nodes.forEach(function (n) { const id = topoNodeId(n); if (id !== '' && !(id in rawById)) rawById[id] = n })
      const layout = width > 0
        ? topologyLayout({ nodes: nodes, tasks: tasks, relayUnreachable: relayStatus === 'unreachable', width: width, height: v.height })
        : null
      const hover = v.hover || null
      const hl = hover && hover.kind === 'node' ? String(hover.id) : ''
      const onHover = typeof v.onHover === 'function' ? v.onHover : function () {}
      const nameOf = {}
      nodes.forEach(function (n) { nameOf[topoNodeId(n)] = n.name || n.nodeId || n.id })
      const t = Number.isFinite(v.t) ? v.t : 0
      const reduced = v.reduced === true
      const focusId = ui.hover || ui.focus || ui.pinned || ''
      const nv = focusId !== '' ? topoNeighborView(mesh, focusId, { cap: fb.previewCap }) : null
      const nameFor = function (id) { return nameOf[id] || id }
      const rows = nodes.map(topoNodeId).filter(function (id) { return id !== '' }).filter(function (id, i, arr) { return arr.indexOf(id) === i }).sort(topoCmp)
      const countsById = {}
      if (layout) layout.nodes.forEach(function (n) { countsById[n.id] = n })
      const listRows = rows.map(function (id) {
        const raw = rawById[id]
        const lay = countsById[id]
        const status = topoNodeStatus(raw)
        const rtt = lay ? lay.rttLabel : (topoRtt(raw) === null ? '延迟未测' : 'rtt ' + topoRtt(raw) + 'ms')
        const staleText = topoStaleLabel(raw, v.now)
        const open = focusId === id
        return h('li', { key: 'row-' + id, className: 'dra-mesh-row' + (ui.pinned === id ? ' pinned' : '') },
          h('div', { className: 'dra-mesh-rowhead' },
            h('span', { className: 'dra-mesh-name' }, nameFor(id)),
            h('span', { className: 'dra-mesh-status ' + status }, topoStatusText(status)),
            h('span', null, topoTransportLabel(raw)),
            topoHealthOverlay(v.nodeHealth, id),
            h('span', null, rtt),
            h('span', null, lay ? lay.badge : '无任务'),
            h('span', null, mesh.badges[id] === '' ? '' : mesh.badges[id]),
            staleText && status !== 'stale' ? h('span', { className: 'dra-mesh-stale' }, staleText) : null,
            h('button', {
              type: 'button', className: 'dra-btn sm dra-mesh-pin', 'aria-pressed': ui.pinned === id,
              onClick: function () { dispatch({ type: 'click', id: id, label: nameFor(id) }) },
            }, ui.pinned === id ? T.unpin : T.pin)),
          open ? h('ul', { className: 'dra-mesh-neighbors', 'aria-label': nameFor(id) + ' ' + T.received(mesh.degree[id] || 0) },
            topoNeighborView(mesh, id, { cap: fb.previewCap }).full.map(function (nid) {
              const nst = topoNodeStatus(rawById[nid])
              return h('li', { key: 'nb-' + id + '-' + nid, className: 'dra-mesh-neighbor' },
                nameFor(nid), ' ', h('span', { className: 'dra-mesh-status ' + nst }, topoStatusText(nst)))
            })) : null)
      })
      const board = h('div', { className: 'dra-tg-board' + (v.full ? ' full' : '') },
        h('div', { className: 'dra-tg-bar-head' },
          h('span', { className: 'dra-dim' }, nodes.length + ' 台电脑 · ' + tasks.length + ' 个任务'),
          h('span', { className: 'dra-dim dra-mesh-relay' }, T.relay[relayStatus]),
          h('button', { className: 'dra-btn sm', onClick: typeof v.onToggleFull === 'function' ? v.onToggleFull : function () {} }, v.full ? '退出全屏' : '全屏')),
        alert,
        h('div', { className: 'dra-tg-canvas', ref: v.boxRef },
          layout ? renderTopologyScene(layout, tasks, {
            t: t, reduced: reduced, hover: hover, onHover: onHover,
            mesh: mesh, ui: ui, dispatch: dispatch, rawById: rawById, now: v.now,
            previewCap: fb.previewCap, staleData: stale,
          }) : null),
        h('div', { className: 'dra-hint dra-mesh-summary' },
          mesh.band ? mesh.labels.band : mesh.labels.summary,
          mesh.labels.dropped ? ' · ' + mesh.labels.dropped : '',
          nv && nv.overflow > 0 ? ' · ' + nameFor(focusId) + ' ' + T.more(nv.overflow) : '',
          stale ? ' · ' + T.oldData : ''),
        h('div', { className: 'dra-hint dra-mesh-legend' }, T.legend),
        h('section', { className: 'dra-mesh-list', 'aria-label': T.listLabel },
          h('div', { className: 'dra-mesh-live', 'aria-live': 'polite', 'aria-atomic': true }, ui.announce || ''),
          ui.lost ? h('div', { className: 'dra-mesh-lost dra-hint' }, T.lost) : null,
          h('ul', { className: 'dra-mesh-rows' }, listRows)),
        h('div', { className: 'dra-tg-strip' },
          tasks.length === 0 ? h('span', { className: 'dra-dim' }, '暂无任务') : tasks.map(function (task) {
            const st = topoTaskState(task.status)
            const on = hover && ((hover.kind === 'task' && String(hover.id) === String(task.taskId)) || (hl !== '' && String(task.nodeId) === hl))
            const left = reduced ? 0 : (-30 + ((t * 0.7) % 1) * 160)
            return h('div', {
              key: task.taskId,
              className: 'dra-tg-task st-' + st + (on ? ' on' : '') + (hover && !on ? ' dim' : ''),
              onMouseEnter: function () { onHover('task', task.taskId) },
              onMouseLeave: function () { onHover(null, null) },
            },
              h('div', { className: 'dra-tg-task-goal', title: task.goal || '' }, topoCut(task.goal || '(无目标)', 28)),
              h('div', { className: 'dra-tg-task-sub' }, (nameOf[String(task.nodeId)] || '未归属') + ' · ' + (STATUS_LABEL[task.status] || task.status || '')),
              st === 'running' ? h('div', { className: 'dra-tg-prog' }, h('i', { style: { left: left + '%' } })) : null)
          })))
      return board
    }

    function TopologyBoard(props) {
      const nodes = props.nodes || []
      const tasks = props.tasks || []
      const boxRef = React.useRef(null)
      const [size, setSize] = React.useState({ width: 0, height: 0 })
      const [t, setT] = React.useState(0)
      const [hover, setHover] = React.useState(null)
      const [full, setFull] = React.useState(false)
      const [ui, setUi] = React.useState(TOPO_PIN_INIT)
      const reduced = prefersReducedMotion()
      const idsKey = nodes.map(topoNodeId).filter(Boolean).sort(topoCmp).join('\u0000')
      const error = typeof props.error === 'string' ? props.error : ''

      React.useEffect(function () {
        const box = boxRef.current
        if (!box) return undefined
        let timer = 0
        const measure = function () { setSize(topologyFit(box)) }
        const later = function () { clearTimeout(timer); timer = setTimeout(measure, 120) }
        measure()
        let ro = null
        if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(later); ro.observe(box) }
        else if (typeof window !== 'undefined') window.addEventListener('resize', later)
        return function () {
          clearTimeout(timer)
          if (ro) ro.disconnect()
          else if (typeof window !== 'undefined') window.removeEventListener('resize', later)
        }
      }, [full, nodes.length === 0])

      React.useEffect(function () {
        return startTopologyLoop({
          reduced: reduced,
          raf: typeof requestAnimationFrame === 'function' ? function (cb) { return requestAnimationFrame(cb) } : null,
          cancel: typeof cancelAnimationFrame === 'function' ? function (id) { return cancelAnimationFrame(id) } : null,
          onTick: setT,
        })
      }, [reduced])

      /* 每次刷新：固定的节点仍在则保持；消失则清除并提示。请求失败：保留最后一次成功的数据与固定，标陈旧。 */
      React.useEffect(function () {
        setUi(function (prev) {
          return topoPinReducer(prev, error !== '' ? { type: 'error' } : { type: 'refresh', ids: idsKey === '' ? [] : idsKey.split('\u0000') })
        })
      }, [idsKey, error])

      const active = full || ui.pinned !== '' || ui.hover !== '' || ui.focus !== ''
      React.useEffect(function () {
        if (!active) return undefined
        const onKey = function (e) {
          if (!e || e.key !== 'Escape') return
          const next = topoPinReducer(ui, { type: 'escape' })
          setUi(next)
          if (next.exitFullscreen === true) setFull(false)
        }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [active, ui])

      return renderTopologyBoardView({
        nodes: nodes, tasks: tasks, topology: props.topology || null, nodeHealth: props.nodeHealth,
        relayStatus: props.relayStatus || (props.relayDown === true ? 'unreachable' : 'unreported'),
        loading: props.loading === true, error: error,
        width: size.width, height: size.height, t: t, reduced: reduced, now: Date.now(),
        ui: ui, dispatch: function (e) { setUi(function (prev) { return topoPinReducer(prev, e) }) },
        hover: hover, onHover: function (kind, id) { setHover(kind ? { kind: kind, id: id } : null) },
        full: full, onToggleFull: function () { setFull(!full) }, boxRef: boxRef,
      })
    }

    /* 旧版（数组入参）几何：保留给既有 TopologyMap 与测试。 */
    function legacyTopologyLayout(input, { width = 640, height = 200 } = {}) {
      const W = Number.isFinite(width) && width > 0 ? width : 640
      const H = Number.isFinite(height) && height > 0 ? height : 200
      const sorted = (Array.isArray(input) ? input : [])
        .filter(function (n) { return n && typeof n === 'object' && !Array.isArray(n) })
        .slice().sort(function (a, b) {
          const left = typeof a.nodeId === 'string' ? a.nodeId : ''
          const right = typeof b.nodeId === 'string' ? b.nodeId : ''
          return left < right ? -1 : left > right ? 1 : 0
        })
      const rows = Math.ceil(sorted.length / 6)
      const rowStep = rows > 1 ? Math.min(34, Math.max(0, (H - 154) / (rows - 1))) : 0
      const nodes = sorted.map(function (n, i) {
        const row = Math.floor(i / 6)
        const inRow = Math.min(6, sorted.length - row * 6)
        const c = n.connectivity && typeof n.connectivity === 'object' ? n.connectivity : null
        const transport = n.transport === undefined ? c && c.transportMode : n.transport
        const tunnelState = n.tunnelState === undefined ? c && c.tunnelState : n.tunnelState
        return {
          nodeId: typeof n.nodeId === 'string' ? n.nodeId : '',
          x: W / (inRow + 1) * (i % 6 + 1),
          y: 118 + row * rowStep,
          online: n.online === true,
          transport: transport === 'direct' || transport === 'relay' ? transport : null,
          tunnelState: ['ready', 'configured', 'error', 'none'].indexOf(tunnelState) >= 0 ? tunnelState : null,
          peerCapable: n.peerCapable === true,
        }
      })
      const peers = nodes.filter(function (n) { return n.online === true && n.peerCapable === true })
      const peerLinks = []
      for (let i = 0; i < peers.length && peerLinks.length < 60; i += 1) {
        for (let j = i + 1; j < peers.length && peerLinks.length < 60; j += 1) {
          peerLinks.push({ from: peers[i].nodeId, to: peers[j].nodeId,
            x1: peers[i].x, y1: peers[i].y, x2: peers[j].x, y2: peers[j].y })
        }
      }
      return {
        hub: { x: W / 2, y: 34 },
        nodes: nodes,
        hubLinks: nodes.map(function (n) { return { nodeId: n.nodeId, kind: 'hub', transport: n.transport } }),
        peerLinks: peerLinks,
        rows: rows,
      }
    }

    /* ───────────────────────────── 样式 ───────────────────────────── */
    const CSS = [
      /* 设计 token：语义 token ＝ 宿主变量（若存在）→ 内置回退；旧名（s0-3/line/dim/faint）只是别名 */
      '.dra-root{',
      '--dra-bg:var(--dra-host-dark-bg,#05070d);--dra-s0:var(--dra-bg);',
      '--dra-surface-1:var(--dra-host-dark-surface-1,#0b0e18);--dra-surface-2:var(--dra-host-dark-surface-2,#111523);--dra-surface-3:var(--dra-host-dark-surface-3,#171d2e);',
      '--dra-s1:var(--dra-surface-1);--dra-s2:var(--dra-surface-2);--dra-s3:var(--dra-surface-3);',
      '--dra-border:rgba(120,165,255,.14);--dra-line:var(--dra-border);--dra-line2:color-mix(in srgb,var(--dra-accent) 38%,transparent);',
      '--dra-text:var(--dra-host-dark-text,#e0e6f0);--dra-text-dim:var(--dra-host-dark-text-dim,#8a98b5);--dra-text-faint:#3d4860;',
      '--dra-dim:var(--dra-text-dim);--dra-faint:var(--dra-text-faint);',
      '--dra-accent:var(--dra-host-dark-accent,#2ee6ff);--dra-focus:var(--dra-accent);--dra-ok:#25e58c;--dra-danger:#ff4d6e;--dra-warn:#ffb547;--dra-mesh:#a78bfa;',
      '--dra-glow-sm:0 0 10px color-mix(in srgb,var(--dra-accent) 18%,transparent);--dra-glow-md:0 0 20px color-mix(in srgb,var(--dra-accent) 28%,transparent);',
      '--dra-r-sm:8px;--dra-r-md:12px;--dra-r-lg:18px;',
      '--dra-gloss:inset 0 1px 0 rgba(255,255,255,.06);',
      '--dra-shadow-1:0 2px 8px rgba(0,0,0,.4);--dra-shadow-2:0 10px 28px rgba(0,0,0,.55);',
      '--dra-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;',
      '--dra-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      'color:var(--dra-text);background:var(--dra-bg);font-family:var(--dra-sans);font-size:13px;line-height:1.5;',
      'min-height:100%;padding:16px 16px 24px;box-sizing:border-box;overflow-y:auto;',
      '--dra-bg-a:color-mix(in srgb,var(--dra-accent) 7%,transparent);--dra-bg-b:rgba(120,165,255,.06);',
      'background-image:radial-gradient(1200px 380px at 18% -8%,var(--dra-bg-a),transparent 60%),radial-gradient(900px 320px at 92% 0,var(--dra-bg-b),transparent 55%);',
      '}',
      '.dra-root *, .dra-root *::before, .dra-root *::after{box-sizing:border-box}',
      '.dra-light{--dra-accent:var(--dra-host-light-accent,#1b6ef3);--dra-line2:color-mix(in srgb,var(--dra-accent) 45%,transparent);--dra-ok:#1a9e6b;--dra-danger:#c92b4a;--dra-warn:#b87010;--dra-mesh:#6d4fd6;--dra-focus:var(--dra-accent);--dra-bg:var(--dra-host-light-bg,#eef2f8);--dra-surface-1:var(--dra-host-light-surface-1,#ffffff);--dra-surface-2:var(--dra-host-light-surface-2,#f4f7fc);--dra-surface-3:var(--dra-host-light-surface-3,#e9eff8);--dra-border:rgba(30,60,110,.14);--dra-text:var(--dra-host-light-text,#17202f);--dra-text-dim:var(--dra-host-light-text-dim,#4a5a73);--dra-text-faint:#8d9bb0;--dra-glow-sm:none;--dra-glow-md:none;--dra-gloss:inset 0 1px 0 rgba(255,255,255,.7);--dra-shadow-1:0 2px 8px rgba(30,60,110,.12);--dra-shadow-2:0 10px 28px rgba(30,60,110,.18);--dra-bg-a:color-mix(in srgb,var(--dra-accent) 6%,transparent);--dra-bg-b:rgba(60,100,200,.04);}',
      /* 设计 token */
      /* 顶层结构 */
      '.dra-shell-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}',
      '.dra-brand{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:.06em;font-size:13px}',
      '.dra-brand-dot{width:9px;height:9px;border-radius:50%;background:var(--dra-accent);box-shadow:0 0 10px var(--dra-accent)}',
      '.dra-modes{display:flex;gap:8px;flex-wrap:wrap}',
      '.dra-mode-card{display:flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:var(--dra-s1);color:var(--dra-dim);cursor:pointer;transition:all .18s ease;box-shadow:var(--dra-gloss)}',
      '.dra-mode-card:hover{border-color:var(--dra-line2);color:var(--dra-text)}',
      '.dra-mode-card.active{border-color:var(--dra-accent);color:var(--dra-accent);box-shadow:0 var(--dra-glow-sm),var(--dra-glow-md),var(--dra-gloss)}',
      '.dra-mode-icon{font-family:var(--dra-mono);font-size:12px}',
      '.dra-mode-txt{display:flex;flex-direction:column;line-height:1.15}',
      '.dra-mode-txt b{font-size:13px;font-weight:600}',
      '.dra-mode-txt span{font-size:12px;color:var(--dra-dim)}',
      '.dra-tools{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dra-spacer{flex:1}',
      /* 外壳（A2）：焦点环 / 标签 / 屏幕结构 */
      '.dra-root :focus-visible{outline:2px solid var(--dra-focus);outline-offset:2px}',
      '.dra-shell-nav{margin-bottom:12px;border-bottom:1px solid var(--dra-border)}',
      '.dra-tablist{display:flex;gap:4px;overflow-x:auto;scrollbar-width:thin}',
      '.dra-tablist .dra-tab{padding:6px 16px;border:1px solid transparent;border-radius:var(--dra-r-sm) var(--dra-r-sm) 0 0;background:transparent;color:var(--dra-text-dim);font-weight:600;white-space:nowrap;flex:none}',
      '.dra-tablist .dra-tab:hover{color:var(--dra-text);border-color:color-mix(in srgb,var(--dra-accent) 40%,transparent)}',
      '.dra-tablist .dra-tab:active{background:var(--dra-surface-3)}',
      '.dra-tab[aria-selected="true"]{color:var(--dra-text);background:var(--dra-surface-1);box-shadow:inset 0 -2px 0 var(--dra-accent)}',
      '.dra-tab-count{font-family:var(--dra-mono);font-size:12px;font-weight:400;color:var(--dra-text-dim);border:1px solid var(--dra-border);border-radius:999px;padding:0 8px;line-height:1.5}',
      '.dra-shell-status{display:flex;flex-direction:column}',
      '.dra-screen{display:block;min-width:0}',
      '.dra-screen-summary{container:dra-summary/inline-size;margin-bottom:12px}',
      '.dra-screen-title{margin:0;font-size:18px;font-weight:600;line-height:1.3}',
      '.dra-screen-line{margin:4px 0 12px;color:var(--dra-text-dim);font-size:13px}',
      '.dra-screen-body{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}',
      '.dra-screen-primary{flex:2 1 724px;min-width:0;display:flex;flex-direction:column;gap:12px}',
      '.dra-screen-secondary{flex:1 1 362px;min-width:0;display:flex;flex-direction:column;gap:12px}',
      '.dra-shell-foot{margin-top:16px;display:flex;flex-direction:column;gap:8px}',
      '.dra-main-grid>:first-child{flex:2 1 480px;min-width:0}',
      '.dra-main-grid>:last-child{flex:1 1 240px;min-width:0}',
      /* 状态不只靠颜色：图标字形 + 文字 */
      '.dra-banner .dra-banner-title::before{content:"▲ "}',
      '.dra-banner.err .dra-banner-title::before{content:"✕ "}',
      '.dra-banner.ok .dra-banner-title::before{content:"ℹ "}',
      '.dra-badge.ok::before{content:"●"}',
      '.dra-badge.warn::before{content:"▲"}',
      '.dra-badge.bad::before{content:"✕"}',
      /* 旧 JSX 已在用、此前缺规则的类 */
      '.dra-memory,.dra-botform,.dra-botchat{min-width:0}',
      '.dra-mem-row{padding:8px 0;border-bottom:1px solid var(--dra-border)}',
      '.dra-muted{opacity:.5}',
      '.dra-tg-hub{cursor:default}',
      '.dra-mesh-relay{font-size:12px}',
      '.dra-tg-task-goal{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dra-relay-precheck{line-height:1.5}',

      /* 按钮 */
      '.dra-btn,.dra-tab{border:1px solid var(--dra-line);background:var(--dra-s2);color:var(--dra-text);border-radius:var(--dra-r-sm);padding:6px 11px;font-size:13px;cursor:pointer;transition:all .16s ease;font-family:inherit;min-height:32px;min-width:32px;display:inline-flex;align-items:center;justify-content:center;gap:6px}',
      '.dra-btn:hover{box-shadow:var(--dra-glow-sm);border-color:color-mix(in srgb,var(--dra-accent) 40%,transparent)}',
      '.dra-btn:active{background:var(--dra-surface-3)}',
      '.dra-btn:disabled,.dra-btn[aria-disabled="true"],.dra-tab:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}',
      '.dra-btn.primary,.dra-btn-primary{background:color-mix(in srgb,var(--dra-accent) 14%,transparent);border-color:var(--dra-accent);color:var(--dra-accent);font-weight:600}',
      '.dra-btn.primary:hover,.dra-btn-primary:hover{background:color-mix(in srgb,var(--dra-accent) 22%,transparent);box-shadow:var(--dra-glow-md)}',
      '.dra-btn.danger{border-color:rgba(255,77,110,.5);color:var(--dra-danger)}',
      '.dra-btn.danger:hover{background:rgba(255,77,110,.12);box-shadow:0 0 16px rgba(255,77,110,.2)}',
      '.dra-btn.sm{padding:3px 8px;font-size:12px}',
      '.dra-check input{accent-color:var(--dra-accent)}',
      /* 横幅 */
      '.dra-banner .dra-banner-title{font-weight:600;margin-bottom:2px}',
      /* 统计栏 */
      '.dra-statbar{display:grid;margin-bottom:12px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px}',
      '.dra-stat{border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:linear-gradient(180deg,rgba(255,255,255,.025),transparent),var(--dra-s1);padding:9px 12px;box-shadow:var(--dra-gloss),var(--dra-shadow-1);transition:all .18s ease;position:relative;overflow:hidden}',
      '.dra-stat:hover{border-color:var(--dra-line2);box-shadow:var(--dra-gloss),var(--dra-shadow-2)}',
      '.dra-stat-value{font-family:var(--dra-mono);font-size:18px;font-weight:700;line-height:1.15}',
      '.dra-stat-label{font-size:12px;color:var(--dra-dim);letter-spacing:.06em;margin-top:2px}',
      '.dra-stat.ok .dra-stat-value{color:var(--dra-ok)}',
      '.dra-stat.bad .dra-stat-value{color:var(--dra-danger)}',
      '.dra-stat.acc .dra-stat-value{color:var(--dra-accent)}',
      '.dra-stat-tip{display:none;position:absolute;inset:auto 6px 6px 6px;background:var(--dra-s0);border:1px solid var(--dra-line);border-radius:var(--dra-r-sm);padding:5px 7px;font-size:12px;color:var(--dra-dim);z-index:5}',
      '.dra-stat:hover .dra-stat-tip{display:block}',
      /* 主栅格 */
      '.dra-card{border:1px solid var(--dra-line);background:linear-gradient(180deg,rgba(255,255,255,.02),transparent 42%),var(--dra-s1);box-shadow:var(--dra-gloss),var(--dra-shadow-1);overflow:hidden;animation:dra-fade-in .3s ease both;border-radius:var(--dra-r-md)}',
      '.dra-card-head{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--dra-line);padding:12px 16px}',
      '.dra-card-title{font-weight:600;font-size:14px;letter-spacing:.02em}',
      '.dra-card-sub{color:var(--dra-dim);font-size:12px}',
      '.dra-card-body{padding:12px 16px}',
      '.dra-card-head .dra-tools{margin-left:auto;display:flex;gap:6px;align-items:center}',
      /* 节点卡片 */
      '.dra-node-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}',
      '.dra-node-card{position:relative;border:1px solid var(--dra-line);border-left:3px solid var(--dra-faint);border-radius:var(--dra-r-md);background:var(--dra-s2);padding:10px 11px;transition:all .18s ease;box-shadow:var(--dra-gloss)}',
      '.dra-node-card:hover{border-color:var(--dra-line2);box-shadow:var(--dra-shadow-2)}',
      '.dra-node-card.online{border-left-color:var(--dra-accent);box-shadow:var(--dra-glow-sm),var(--dra-gloss)}',
      '.dra-node-card.offline{border-left-color:var(--dra-faint);opacity:.82}',
      '.dra-node-top{display:flex;align-items:center;gap:7px;margin-bottom:7px}',
      '.dra-node-name{font-family:var(--dra-mono);font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dra-node-meta{color:var(--dra-dim);font-size:12px;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap}',
      '.dra-node-actions{display:flex;gap:5px;margin-top:8px;opacity:0;transform:translateY(2px);transition:all .16s ease;pointer-events:none}',
      '.dra-node-card:hover .dra-node-actions{opacity:1;transform:none;pointer-events:auto}',
      '.dra-link-category{color:var(--dra-text-dim);font-size:12px;margin-inline-start:4px}',
      '.dra-link-health{margin-inline-start:4px;vertical-align:middle}',
      '.dra-act{border:1px solid var(--dra-line);background:transparent;color:var(--dra-dim);border-radius:6px;padding:2px 7px;font-size:12px;cursor:pointer;min-height:32px}',
      '.dra-act:hover{color:var(--dra-accent);border-color:var(--dra-line2)}',
      /* 徽章 / 圆点 */
      '.dra-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,currentColor);box-shadow:0 0 8px currentColor;flex:none}',
      '.dra-badge{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dra-line);border-radius:999px;padding:1px 7px;font-size:12px;color:var(--dra-dim);white-space:nowrap;line-height:1.6}',
      '.dra-badge.glow{box-shadow:0 0 8px currentColor}',
      '.dra-badge.acc{color:var(--dra-accent);border-color:color-mix(in srgb,var(--dra-accent) 40%,transparent)}',
      '.dra-badge.ok{color:var(--dra-ok);border-color:rgba(37,229,140,.4)}',
      '.dra-badge.bad{color:var(--dra-danger);border-color:rgba(255,77,110,.4)}',
      '.dra-badge.warn{color:var(--dra-warn);border-color:rgba(255,181,71,.4)}',
      '.dra-badge.soft{background:rgba(120,165,255,.08)}',
      /* 进度条 */
      '.dra-bars{display:grid;gap:4px;margin-top:6px}',
      '.dra-bar-row{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dra-dim)}',
      '.dra-bar{flex:1;height:4px;border-radius:99px;background:var(--dra-s0);overflow:hidden}',
      '.dra-bar-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,color-mix(in srgb,var(--dra-accent) 55%,transparent),var(--dra-accent));box-shadow:var(--dra-glow-sm);transition:width .4s ease}',
      /* 拓扑 */
      '.dra-topo-wrap{position:relative;height:200px;border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:radial-gradient(420px 160px at 50% 0,color-mix(in srgb,var(--dra-accent) 8%,transparent),transparent 70%),var(--dra-s0);overflow:hidden}',
      '.dra-topo-svg{width:100%;height:100%;display:block}',
      '.dra-topo-line{stroke:rgba(120,165,255,.18);stroke-width:1;fill:none}',
      '.dra-topo-line.active{stroke-width:1.6}',
      '.dra-topo-line.flow{animation:dra-flow .8s linear infinite}',
      '.dra-topo-node{fill:var(--dra-s3);stroke:var(--dra-faint);stroke-width:1;transition:all .2s ease}',
      '.dra-topo-node.online{fill:color-mix(in srgb,var(--dra-accent) 16%,transparent);stroke:var(--dra-accent)}',
      '.dra-topo-node.hub{fill:color-mix(in srgb,var(--dra-accent) 22%,transparent);stroke:var(--dra-accent);stroke-width:1.6}',
      '.dra-topo-pulse{fill:none;stroke:var(--dra-accent);stroke-width:1;opacity:0;transform-box:fill-box;transform-origin:center;animation:dra-pulse 1.6s ease-out infinite}',
      '.dra-topo-label{fill:var(--dra-dim);font-size:10px;font-family:var(--dra-mono);text-anchor:middle}',
      '.dra-topo-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--dra-dim)}',
      '.dra-seg{display:inline-flex;border:1px solid var(--dra-line);border-radius:999px;overflow:hidden}',
      '.dra-seg button{border:0;background:transparent;color:var(--dra-dim);padding:3px 12px;font-size:12px;cursor:pointer;min-height:32px}',
      '.dra-seg button.active{background:color-mix(in srgb,var(--dra-accent) 12%,transparent);color:var(--dra-accent)}',
      '.dra-tg-board{display:flex;flex-direction:column;width:100%;min-height:max(420px,70vh);border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:radial-gradient(60% 60% at 50% 45%,color-mix(in srgb,var(--dra-accent) 7%,transparent),transparent 75%),var(--dra-s0);overflow:hidden}',
      '.dra-tg-board.full{position:fixed;inset:0;z-index:60;min-height:0;border-radius:0}',
      '.dra-tg-bar-head{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;font-size:12px}',
      '.dra-tg-canvas{position:relative;flex:1;min-height:0;min-width:0;overflow:hidden}',
      '.dra-tg-svg{display:block;width:100%;height:100%}',
      '.dra-tg-edge{fill:none;stroke:var(--dra-faint)}',
      '.dra-tg-edge.st-running{stroke:var(--dra-accent);stroke-width:2;stroke-dasharray:8 6}',
      '.dra-tg-edge.st-queued{stroke:var(--dra-warn);stroke-dasharray:6 5}',
      '.dra-tg-edge.st-completed{stroke:var(--dra-ok);opacity:.4}',
      '.dra-tg-edge.st-offline{stroke:var(--dra-warn);stroke-dasharray:3 6;opacity:.7}',
      '.dra-tg-edge.st-down{stroke:var(--dra-danger);stroke-dasharray:6 5}',
      '.dra-tg-edge.st-idle.tr-direct,.dra-tg-edge.st-completed.tr-direct{stroke-dasharray:none}',
      '.dra-tg-edge.st-idle.tr-relay,.dra-tg-edge.st-completed.tr-relay{stroke-dasharray:6 4}',
      '.dra-tg-edge.st-idle.tr-unknown,.dra-tg-edge.st-completed.tr-unknown{stroke-dasharray:1 5}',
      '.dra-tg-elabel{fill:var(--dra-dim);font-size:10px;font-family:var(--dra-mono);text-anchor:middle}',
      '.dra-tg-elabel.st-down{fill:var(--dra-danger)}',
      '.dra-tg-elabel.st-offline{fill:var(--dra-warn)}',
      '.dra-tg-dot{fill:var(--dra-accent)}',
      '.dra-tg-glow{fill:var(--dra-accent);opacity:.28}',
      '.dra-tg-hubcore{fill:color-mix(in srgb,var(--dra-accent) 20%,transparent);stroke:var(--dra-accent);stroke-width:1.6}',
      '.dra-tg-hubring{fill:none;stroke:var(--dra-accent);stroke-width:1.2;stroke-dasharray:4 6;opacity:.7}',
      '.dra-tg-hubpulse{fill:none;stroke:var(--dra-accent);stroke-width:1.2}',
      '.dra-tg-hubtext{fill:var(--dra-accent);font-size:11px;text-anchor:middle}',
      '.dra-tg-card{fill:var(--dra-s2);stroke:var(--dra-accent);stroke-width:1.2}',
      '.dra-tg-card.offline{stroke:var(--dra-warn);stroke-dasharray:4 3;fill:rgba(255,180,0,.1)}',
      '.dra-tg-card.stale{stroke:var(--dra-warn);stroke-dasharray:8 3 2 3;fill:rgba(255,180,0,.1)}',
      '.dra-tg-card.pinned{stroke-width:2.6}',
      '.dra-tg-node:focus{outline:none}',
      '.dra-tg-node:focus-visible .dra-tg-card{stroke:var(--dra-text);stroke-width:2.4}',
      '.dra-mesh-band{fill:none;stroke:var(--dra-mesh);stroke-width:1.6;stroke-dasharray:10 4 2 4;opacity:.75;pointer-events:none}',
      '.dra-mesh-edge{stroke:var(--dra-mesh);stroke-width:1;stroke-dasharray:1 4;stroke-linecap:round;opacity:.9;pointer-events:none}',
      '.dra-mesh-edge.old{opacity:.5}',
      '.dra-mesh-badge{fill:var(--dra-mesh);font-size:10px;font-weight:700;text-anchor:end;font-family:var(--dra-mono);paint-order:stroke;stroke:var(--dra-s2);stroke-width:2px}',
      '.dra-mesh-badge-legacy{text-anchor:middle;font-size:10px}',
      '.dra-mesh-summary{padding:2px 10px}',
      '.dra-mesh-legend{padding:0 10px 4px;white-space:normal}',
      '.dra-mesh-list{padding:4px 10px 8px;border-top:1px solid var(--dra-line);max-height:260px;overflow-y:auto}',
      '.dra-mesh-rows{list-style:none;margin:0;padding:0}',
      '.dra-mesh-row{padding:4px 0;border-bottom:1px solid var(--dra-line)}',
      '.dra-mesh-row.pinned{border-left:3px solid var(--dra-mesh);padding-left:6px}',
      '.dra-mesh-rowhead{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;font-size:12px}',
      '.dra-mesh-name{font-weight:600;color:var(--dra-text)}',
      '.dra-mesh-status.stale{color:var(--dra-warn)}',
      '.dra-mesh-status.offline{color:var(--dra-warn)}',
      '.dra-mesh-stale,.dra-mesh-lost{color:var(--dra-warn)}',
      '.dra-mesh-neighbors{list-style:none;padding:0;margin:4px 0 2px 14px;color:var(--dra-dim)}',
      '.dra-mesh-neighbor{display:inline-block;margin-right:12px}',
      '.dra-mesh-pin:focus-visible{outline:2px solid var(--dra-focus);outline-offset:2px}',
      '.dra-mesh-live{min-height:1em;color:var(--dra-dim);font-size:12px}',
      '.dra-tg-skeleton{min-height:max(420px,70vh);opacity:.6}',
      '.dra-tg-pulse{fill:none;stroke:var(--dra-accent);stroke-width:1.2}',
      '.dra-tg-name{fill:var(--dra-text);font-size:11px;text-anchor:middle;font-weight:600}',
      '.dra-tg-badge{fill:var(--dra-dim);font-size:10px;text-anchor:middle}',
      '.dra-tg-sub{font-size:10px;text-anchor:middle;font-family:var(--dra-mono);fill:var(--dra-dim)}',
      '.dra-tg-relaybox{fill:none;stroke:var(--dra-danger);stroke-dasharray:5 4;stroke-width:1.2}',
      '.dra-tg-tick{fill:var(--dra-faint)}',
      '.dra-tg-tick.st-running{fill:var(--dra-accent)}',
      '.dra-tg-tick.st-queued{fill:var(--dra-warn)}',
      '.dra-tg-tick.st-completed{fill:var(--dra-ok);opacity:.55}',
      '.dra-tg-tick.st-failed{fill:var(--dra-danger)}',
      '.dra-tg-node.dim,.dra-tg-edge.dim,.dra-tg-elabel.dim,.dra-tg-packet.dim,.dra-tg-relay.dim{opacity:.22}',
      '.dra-tg-strip{display:flex;gap:8px;overflow-x:auto;padding:8px 10px;border-top:1px solid var(--dra-line);font-size:12px}',
      '.dra-tg-task{position:relative;flex:0 0 auto;min-width:150px;padding:6px 10px;border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:var(--dra-s2);overflow:hidden}',
      '.dra-tg-task.st-running{border-color:var(--dra-accent)}',
      '.dra-tg-task.st-queued{border-color:var(--dra-warn)}',
      '.dra-tg-task.st-completed{opacity:.6}',
      '.dra-tg-task.st-failed{border-color:var(--dra-danger)}',
      '.dra-tg-task.on{box-shadow:0 0 0 1px var(--dra-accent)}',
      '.dra-tg-task.dim{opacity:.35}',
      '.dra-tg-task-sub{color:var(--dra-dim);font-size:12px}',
      '.dra-tg-prog{position:relative;height:4px;margin-top:5px;border-radius:99px;background:var(--dra-s0);overflow:hidden}',
      '.dra-tg-prog i{position:absolute;top:0;bottom:0;width:30%;border-radius:99px;background:linear-gradient(90deg,transparent,var(--dra-accent),transparent)}',
      '@media (prefers-reduced-motion:no-preference){.dra-tg-node,.dra-tg-edge,.dra-tg-task{transition:opacity .2s ease}}',
      /* 任务列表 */
      '.dra-filterbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dra-chip{border:1px solid var(--dra-line);background:transparent;color:var(--dra-dim);border-radius:999px;padding:2px 9px;font-size:12px;cursor:pointer;transition:all .15s ease;min-height:32px}',
      '.dra-chip:hover{color:var(--dra-text);border-color:var(--dra-line2)}',
      '.dra-chip.active{color:var(--dra-accent);border-color:var(--dra-accent);background:color-mix(in srgb,var(--dra-accent) 8%,transparent)}',
      '.dra-tasklist{display:flex;flex-direction:column;max-height:420px;overflow:auto}',
      '.dra-group-label{position:sticky;top:0;z-index:2;padding:6px 13px;background:var(--dra-s1);border-bottom:1px solid var(--dra-line);color:var(--dra-dim);font-size:12px;letter-spacing:.06em}',
      '.dra-task{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:8px 13px;border-bottom:1px solid rgba(120,165,255,.07);cursor:pointer;transition:background .15s ease}',
      '.dra-task:hover{background:color-mix(in srgb,var(--dra-accent) 4%,transparent)}',
      '.dra-task-main{min-width:0}',
      '.dra-task-title{display:flex;align-items:center;gap:7px;min-width:0}',
      '.dra-task-goal{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}',
      '.dra-task-sub{display:flex;gap:9px;flex-wrap:wrap;color:var(--dra-dim);font-size:12px;margin-top:3px}',
      '.dra-task-actions{display:flex;align-items:center;gap:5px;opacity:0;transition:opacity .15s ease}',
      '.dra-task:hover .dra-task-actions{opacity:1}',
      '.dra-progress{color:var(--dra-dim);font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /* 表单 */
      '.dra-input:focus,.dra-textarea:focus,.dra-select:focus{border-color:var(--dra-accent);box-shadow:0 var(--dra-glow-sm)}',
      '.dra-input::placeholder,.dra-textarea::placeholder{color:var(--dra-dim)}',
      '.dra-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dra-mono{font-family:var(--dra-mono);font-size:12px}',
      '.dra-hl{color:var(--dra-accent);font-weight:700}',
      '.dra-copy{border:1px dashed color-mix(in srgb,var(--dra-accent) 40%,transparent);background:transparent;color:var(--dra-accent);border-radius:6px;padding:2px 7px;font-size:12px;cursor:pointer;min-height:32px}',
      '.dra-copy:hover{background:color-mix(in srgb,var(--dra-accent) 8%,transparent)}',
      '.dra-dim{color:var(--dra-dim)}',
      '.dra-ok{color:var(--dra-ok)}',
      '.dra-danger{color:var(--dra-danger)}',
      '.dra-acc{color:var(--dra-accent)}',
      '.dra-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /* 折叠 */
      '.dra-fold{border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:var(--dra-s1);margin-top:10px;overflow:hidden}',
      '.dra-fold>summary{list-style:none;cursor:pointer;padding:8px 13px;color:var(--dra-dim);font-size:12px;display:flex;align-items:center;gap:8px;user-select:none}',
      '.dra-fold>summary::-webkit-details-marker{display:none}',
      '.dra-fold>summary:hover{color:var(--dra-text)}',
      '.dra-fold>summary::before{content:"▸";color:var(--dra-accent);transition:transform .15s ease}',
      '.dra-fold[open]>summary::before{transform:rotate(90deg)}',
      /* 体检 / 工具 / 共享 */
      '.dra-env-item{display:flex;gap:8px;padding:6px 0;border-bottom:1px dashed rgba(120,165,255,.1);align-items:flex-start}',
      '.dra-env-item:last-child{border-bottom:none}',
      '.dra-env-mark{flex:none;width:14px;text-align:center;font-family:var(--dra-mono)}',
      '.dra-tools-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}',
      '.dra-tool{border:1px solid var(--dra-line);border-radius:var(--dra-r-sm);padding:7px 9px;background:var(--dra-s2)}',
      '.dra-tool-name{display:flex;align-items:center;gap:6px;font-weight:600}',
      '.dra-tool-meta{color:var(--dra-dim);font-size:12px;margin-top:3px;line-height:1.5}',
      '.dra-steps{display:grid;gap:5px;margin-top:6px}',
      '.dra-step{display:flex;gap:7px;align-items:baseline;color:var(--dra-dim);font-size:12px}',
      '.dra-step b{font-family:var(--dra-mono);color:var(--dra-accent);font-weight:600}',
      /* 详情抽屉 */
      '.dra-detail{border:1px solid var(--dra-line);border-radius:var(--dra-r-md);background:var(--dra-s1);padding:10px 12px;margin-top:10px}',
      /* 添加副机 */
      '.dra-enroll-btn{width:100%;border:1px dashed color-mix(in srgb,var(--dra-accent) 55%,transparent);background:color-mix(in srgb,var(--dra-accent) 4%,transparent);color:var(--dra-accent)}',
      '.dra-enroll-card{border:1px solid var(--dra-line2);border-radius:var(--dra-r-md);background:color-mix(in srgb,var(--dra-accent) 5%,transparent);padding:10px 11px;margin-top:9px}',
      '.dra-token{font-family:var(--dra-mono);font-size:13px;color:var(--dra-accent);word-break:break-all;margin:4px 0}',
      /* 派发模板行 */
      '.dra-tplrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 6px}',
      '.dra-tplrow .dra-select{flex:1 1 160px;min-width:140px}',
      '.dra-tplrow .dra-btn{flex:0 0 auto;white-space:nowrap}',
      /* 空态 */
      '.dra-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:20px 12px;color:var(--dra-dim);text-align:center;line-height:1.6}',
      /* 动画 */
      '@keyframes dra-fade-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '@keyframes dra-pulse{0%{opacity:.85;transform:scale(1)}70%{opacity:0;transform:scale(1.9)}100%{opacity:0;transform:scale(1.9)}}',
      '@keyframes dra-flow{to{stroke-dashoffset:-20}}',
      '@keyframes dra-glow{0%,100%{box-shadow:var(--dra-glow-sm)}50%{box-shadow:var(--dra-glow-md)}}',
      /* 基础控件 */
      '.dra-form{display:flex;flex-direction:column;gap:8px}',
      '.dra-field{margin-bottom:9px;display:flex;flex-direction:column;gap:3px}',
      '.dra-label{letter-spacing:.04em;font-size:12px;color:var(--dra-dim);font-weight:500}',
      '.dra-select{font-family:inherit;transition:border-color .15s ease,box-shadow .15s ease;background:var(--dra-s2);color:var(--dra-text);border:1px solid var(--dra-line);border-radius:var(--dra-r-sm);padding:5px 8px;font-size:12px;width:100%}',
      '.dra-input{font-family:inherit;transition:border-color .15s ease,box-shadow .15s ease;background:var(--dra-s2);color:var(--dra-text);border:1px solid var(--dra-line);border-radius:var(--dra-r-sm);padding:5px 8px;font-size:12px;width:100%;box-sizing:border-box}',
      '.dra-textarea{font-family:inherit;transition:border-color .15s ease,box-shadow .15s ease;line-height:1.5;background:var(--dra-s2);color:var(--dra-text);border:1px solid var(--dra-line);border-radius:var(--dra-r-sm);padding:5px 8px;font-size:12px;width:100%;box-sizing:border-box;resize:vertical;min-height:56px}',
      '.dra-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dra-dim);cursor:pointer;user-select:none}',
      '.dra-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dra-pre{margin:5px 0 0;border:1px solid var(--dra-line);max-height:190px;overflow:auto;font-family:var(--dra-mono);font-size:13px;white-space:pre-wrap;word-break:break-all;background:var(--dra-s2);border-radius:var(--dra-r-sm);padding:8px;line-height:1.6;color:var(--dra-text)}',
      '.dra-kv{font-size:12px;line-height:1.6;display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0;padding:0}',
      '.dra-kv dt{color:var(--dra-dim);font-size:12px;white-space:nowrap;align-self:start;padding-top:1px}',
      '.dra-kv dd{color:var(--dra-text);font-size:12px;margin:0;word-break:break-all}',
      '.dra-wrap{word-break:break-all;white-space:pre-wrap}',
      '.dra-warn{color:var(--dra-warn)}',
      '.dra-err{color:var(--dra-danger)}',
      '.dra-hint{font-size:12px;color:var(--dra-dim);line-height:1.5}',
      '.dra-hint.dra-warn{color:var(--dra-warn)}',
      '.dra-hint.dra-danger{color:var(--dra-danger)}',
      '.dra-main-grid{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}',
      '.dra-col{min-width:0;display:flex;flex-direction:column;gap:12px}',
      '.dra-sec{font-size:12px;font-weight:600;color:var(--dra-dim);text-transform:uppercase;letter-spacing:.04em;padding:4px 0 2px;display:flex;align-items:center;gap:6px}',
      '.dra-banner{line-height:1.55;background:var(--dra-s2);border:1px solid var(--dra-line);border-radius:var(--dra-r-md);padding:10px 12px;margin-bottom:6px}',
      '.dra-banner.ok{border-left-color:var(--dra-ok);background:rgba(37,229,140,.07);border-color:rgba(37,229,140,.35)}',
      '.dra-banner.err{border-left-color:var(--dra-danger);background:rgba(255,77,110,.08);border-color:rgba(255,77,110,.35)}',
      '.dra-banner-title{font-size:12px;font-weight:600;color:var(--dra-text);margin-bottom:3px}',
      '.dra-k{font-size:12px;color:var(--dra-dim);white-space:nowrap;min-width:70px}',
      '.dra-in{flex:1;background:var(--dra-s2);color:var(--dra-text);border:1px solid var(--dra-line);border-radius:var(--dra-r-sm);padding:4px 7px;font-size:12px}',
      '.dra-tplnote{font-size:12px;color:var(--dra-dim)}',
      '.dra-fold-body{padding:6px 0}',
      '.dra-advanced{margin-top:4px}',
      '.dra-choices{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}',
      /* 响应式 */
      /* 响应式（按容器宽度）、触屏目标、强制颜色 */
      '@container dra-summary (max-width:719px){.dra-statbar{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (pointer:coarse){.dra-btn,.dra-tab,.dra-chip,.dra-act,.dra-copy,.dra-seg button{min-height:40px}}',
      '@media (forced-colors:active){.dra-tab[aria-selected="true"]{border:2px solid Highlight;box-shadow:none}.dra-root :focus-visible{outline-color:Highlight}}',
      '@media (prefers-reduced-motion:reduce){.dra-root *{animation:none !important;transition:none !important}}',
    ]

    /**
     * Root: 所有顶层视图的统一包装组件。
     * 负责：1) 挂载 dra-root 根类；2) 注入主题类（.dra-light）；
     * 这样四个视图（switchRole/worker/setup/hub）只写 Root(theme) 而不会
     * 漏掉任何一个。
     */
    function Root(props) {
      var theme = props.theme === 'light' ? 'light' : 'dark'
      var themeClass = theme === 'light' ? ' dra-light' : ''
      return h('div', { className: 'dra-root' + themeClass, 'data-theme': theme }, props.children)
    }

    /**
     * StyleTag: 静态 bundle 的唯一正确注入方式。
     * ctx.get('styles') 在 window.__ModuleLoader__ 形式下返回 undefined，
     * CSS 永远不会被注入 → 面板退化为无样式。
     * 把 <style> 作为 React 元素渲染，随挂载生效、随卸载移除。
     * apply 里的 styles.insert 保留，仅动态 lane 用。
     */
    function StyleTag() {
      return h('style', { key: 'dra-css' }, CSS)
    }

    /* ───────────────────────────── 请求与工具 ───────────────────────────── */
    function readJson(r) {
      return r.json().catch(function () { return {} }).then(function (b) {
        if (r.ok) return b
        const e = new Error((b && (b.message || b.error)) || ('HTTP ' + r.status))
        e.status = r.status
        e.body = b
        throw e
      })
    }

    function apiGet(p) {
      return fetch(API + p, { cache: 'no-store' }).then(function (r) {
        return r.status === 404 ? fetch(API_FALLBACK + p, { cache: 'no-store' }) : r
      }).then(readJson)
    }

    /* 拉**传入的完整路径**（副机状态 / 引导端点不在 UI 前缀下）。 */
    function apiGetPath(fullPath) {
      return fetch(fullPath, { cache: 'no-store' }).then(readJson)
    }

    function apiPost(p, body) {
      const options = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }
      return fetch(API + p, options).then(function (r) {
        return r.status === 404 ? fetch(API_FALLBACK + p, options) : r
      }).then(readJson)
    }

    function apiPostPath(fullPath, body) {
      return fetch(fullPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function copyText(text) {
      const s = String(text == null ? '' : text)
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(s).then(function () { return true }, function () { return false })
      }
      try {
        const ta = document.createElement('textarea')
        ta.value = s
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return Promise.resolve(ok)
      } catch (e) {
        return Promise.resolve(false)
      }
    }

    function fmtTime(ms) {
      if (!ms || typeof ms !== 'number') return '—'
      const d = new Date(ms)
      const p = function (n) { return n < 10 ? '0' + n : String(n) }
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }

    function fmtDur(ms) {
      if (!ms || typeof ms !== 'number' || ms < 0) return '—'
      const s = Math.floor(ms / 1000)
      if (s < 60) return s + 's'
      const m = Math.floor(s / 60)
      if (m < 60) return m + 'm' + (s % 60) + 's'
      const hh = Math.floor(m / 60)
      return hh + 'h' + (m % 60) + 'm'
    }

    function pct(n) {
      const v = Number(n)
      if (!isFinite(v)) return 0
      return Math.max(0, Math.min(100, Math.round(v)))
    }

    function shortId(id) {
      const s = String(id || '')
      return s.length > 10 ? s.slice(0, 10) : s
    }

    /* 任务的一行进度摘要：优先 progressTail 最后一条，其次 summaryText。 */
    function progressLine(t) {
      if (!t || typeof t !== 'object') return ''
      const tail = Array.isArray(t.progressTail) ? t.progressTail : []
      for (let i = tail.length - 1; i >= 0; i -= 1) {
        const p = tail[i]
        if (p && typeof p.detail === 'string' && p.detail.trim() !== '') return p.detail.trim()
      }
      if (typeof t.summaryText === 'string' && t.summaryText.trim() !== '') return t.summaryText.trim().split('\n')[0]
      return ''
    }

    /* ───────────────────────────── 基础组件 ───────────────────────────── */
    function Dot(props) {
      return h('span', {
        className: 'dra-dot',
        style: { color: props.color || 'var(--dra-accent)' },
        title: props.title || '',
      })
    }

    function Badge(props) {
      const cls = 'dra-badge' + (props.tone ? ' ' + props.tone : '') + (props.glow ? ' glow' : '')
      return h('span', { className: cls, title: props.title || '' }, props.children)
    }

    function Card(props) {
      const head = props.title ? h('div', { className: 'dra-card-head' },
        h('h3', { className: 'dra-card-title', style: { margin: 0 } }, props.title),
        props.sub ? h('span', { className: 'dra-card-sub' }, props.sub) : null,
        props.actions ? h('div', { className: 'dra-tools' }, props.actions) : null,
      ) : null
      return h('section', { className: 'dra-card' + (props.className ? ' ' + props.className : '') },
        head,
        h('div', { className: 'dra-card-body' }, props.children),
      )
    }

    function Fold(props) {
      return h('details', {
        className: 'dra-fold',
        open: props.open === true,
      },
        h('summary', null,
          h('span', null, props.title),
          props.badge ? h('span', { className: 'dra-badge soft' }, props.badge) : null,
        ),
        h('div', { className: 'dra-fold-body' }, props.children),
      )
    }

    const ATTENTION_TEXT = {
      title: '待你处理', idle: '未结束', withExecutor: '已关联执行器', withoutExecutor: '未关联执行器',
    }

    function sortAttentionTickets(rows) {
      const order = { person: 0, working: 1, idle: 2 }
      return rows.filter(function (row) { return row.stage !== 'ended' })
        .sort(function (a, b) { return order[a.stage] - order[b.stage] })
    }

    function AttentionFold(props) {
      const tickets = props?.tickets
      if (!Array.isArray(tickets) || tickets.length === 0) return null
      const rows = sortAttentionTickets(tickets
        .filter(function (ticket) { return typeof ticket?.ticketId === 'string' })
        .map(function (ticket) { return { ticket: ticket, stage: ticketStage(ticket).stage } }))
      const T = ATTENTION_TEXT
      return h(Fold, { title: T.title }, rows.map(function (row) {
        return h('div', { className: 'dra-row', key: row.ticket.ticketId },
          h('span', { className: 'dra-mono' }, row.ticket.ticketId),
          h('span', { className: 'dra-hint' }, T[row.stage]),
          h('span', { className: 'dra-hint' }, row.ticket.hasExecutor === true ? T.withExecutor : T.withoutExecutor),
        )
      }))
    }

    function CopyBtn(props) {
      return h('button', {
        className: 'dra-copy',
        title: props.title || '复制',
        onClick: function (e) {
          e.stopPropagation()
          copyText(props.text).then(function (ok) {
            if (props.onDone) props.onDone(ok)
          })
        },
      }, props.label || '复制')
    }

    /* ───────────────────────────── 工具栏 ───────────────────────────── */
    function Toolbar(props) {
      return h('header', { className: 'dra-shell-head' },
        h('div', { className: 'dra-brand' },
          h('span', { className: 'dra-brand-dot' }),
          h('span', null, 'AI 集群控制'),
        ),
        h('div', { className: 'dra-modes' },
          h('span', { className: 'dra-mode-txt' },
            h('b', null, props.roleLabel || 'AI 集群控制'),
          ),
        ),
        h('div', { className: 'dra-tools' },
          h('label', { className: 'dra-check', title: '每 8 秒自动刷新' },
            h('input', {
              type: 'checkbox',
              checked: props.autoRefresh === true,
              onChange: function (e) { props.onToggleAuto(e.target.checked) },
            }),
            h('span', null, '自动'),
          ),
          h('button', {
            className: 'dra-btn',
            title: props.theme === 'dark' ? '切换到浅色' : '切换到深色',
            'aria-label': props.theme === 'dark' ? '切换到浅色' : '切换到深色',
            onClick: props.onToggleTheme,
          }, props.theme === 'dark' ? '☀' : '☾'),
          h('button', {
            className: 'dra-btn primary',
            onClick: props.onRefresh,
            disabled: props.loading === true,
            'aria-busy': props.loading === true ? 'true' : 'false',
          }, props.loading ? '刷新中…' : '刷新'),
        ),
      )
    }

    /* ───────────────────────────── 统计栏 ───────────────────────────── */
    function StatBar(props) {
      const c = props.counts || {}
      const cell = function (label, value, tone, tip) {
        return h('div', { className: 'dra-stat' + (tone ? ' ' + tone : '') },
          h('div', { className: 'dra-stat-value' }, String(value == null ? 0 : value)),
          h('div', { className: 'dra-stat-label' }, label),
          tip ? h('div', { className: 'dra-stat-tip' }, tip) : null,
        )
      }
      return h('div', { className: 'dra-statbar' },
        cell('节点总数', c.nodes, '', '注册到本 hub 的副机数量'),
        cell('在线', c.online, 'ok', '当前握手在线的副机'),
        cell('任务中', c.active != null ? c.active : c.running, 'acc', '运行中 + 排队 + 待批准'),
        cell('已完成', c.done, 'ok', '历史任务中 status=completed 的数量'),
        cell('失败', c.failed, 'bad', 'failed / aborted / rejected 的数量'),
      )
    }

    /* ───────────────────────────── 节点卡片 ───────────────────────────── */
    function connectivityLine(n) {
      const c = n.connectivity && typeof n.connectivity === 'object' ? n.connectivity : null
      const probes = c && Array.isArray(c.probes) ? c.probes : []
      const seconds = c && Number.isFinite(c.sampledAt) ? Math.max(0, Math.floor((Date.now() - c.sampledAt) / 1000)) : null
      const tunnelLabel = c && ({ ready: '就绪', configured: '已配置', error: '异常', none: '无' })[c.tunnelState] || '未知'
      return c
        ? '链路 ' + (c.transportMode === 'direct' ? '直连' : c.transportMode === 'relay' ? '中继' : '未知')
          + ' · 隧道 ' + tunnelLabel
          + (probes.length ? ' · 探测 ' + probes.filter(function (p) { return p && p.result === 'open' }).length + '/' + probes.length + ' 可达' : '')
          + ' · 采样 ' + (seconds === null ? '未知' : seconds + ' 秒前' + (seconds > 600 ? '（陈旧）' : ''))
        : '链路详情未上报'
    }

    function nodeCardView(node) {
      const n = node && typeof node === 'object' ? node : {}
      const online = n.online === true
      const stale = n.stale === true
      const res = n.resource
      const loadReported = res !== null && typeof res === 'object'
      const num = function (v) { const x = Number(v); return isFinite(x) ? x : null }
      let cpuLabel = '负载未上报'
      let memLabel = '负载未上报'
      let cpuPct = null
      let memPct = null
      if (loadReported) {
        const cpu = num(res.cpuPct)
        const used = num(res.memUsedMb)
        const total = num(res.memTotalMb)
        cpuLabel = cpu === null ? '?' : Math.round(cpu) + '%'
        memLabel = (used === null ? '?' : String(used)) + '/' + (total === null ? '?' : String(total)) + ' MB'
        cpuPct = cpu === null ? 0 : pct(cpu)
        memPct = used !== null && total !== null && total > 0 ? pct((used / total) * 100) : 0
      }
      const statusLines = []
      statusLines.push(online ? '在线' : '离线')
      if (stale) statusLines.push('心跳超时')
      return {
        nodeId: typeof n.nodeId === 'string' ? n.nodeId : '',
        online: online,
        stale: stale,
        loadReported: loadReported,
        cpuLabel: cpuLabel,
        memLabel: memLabel,
        cpuPct: cpuPct,
        memPct: memPct,
        statusLines: statusLines,
      }
    }

    function NodeCard(props) {
      const n = props.node || {}
      const v = nodeCardView(n)
      const modeLabel = n.transportMode === 'direct' ? '直连' : n.transportMode === 'relay' ? '中继' : '未知'
      const badgeText = v.statusLines.filter(function (l) { return l !== '心跳超时' }).map(function (l) {
        return l === '在线' ? '在线（' + modeLabel + '）' : l
      }).join(' · ')
      return h('div', { className: 'dra-node-card ' + (v.online ? 'online' : 'offline') },
        h('div', { className: 'dra-node-top' },
          h(Dot, { color: v.online ? 'var(--dra-accent)' : 'var(--dra-faint)' }),
          h('span', { className: 'dra-node-name', title: n.nodeId }, shortId(n.nodeId)),
          h('span', { style: { marginLeft: 'auto' } },
            h(Badge, { tone: v.online ? 'ok' : '', glow: v.online }, badgeText),
          ),
        ),
        h('div', { className: 'dra-node-meta' },
          h('span', null, (n.os || '?') + '/' + (n.arch || '?')),
          h('span', null, '任务 ' + (n.taskCount || 0)),
          n.agentMode ? h('span', { className: 'dra-acc' }, 'agent') : null,
          n.runnerKind ? h('span', null, n.runnerKind) : null,
          topoHealthOverlay(props.nodeHealth, topoNodeId(n)),
        ),
        h('div', { className: 'dra-node-meta' }, connectivityLine(n)),
        h('div', { className: 'dra-node-meta' },
          typeof n.silentMs === 'number' ? h('span', null, '静默 ' + Math.round(n.silentMs / 1000) + ' 秒') : null,
          v.statusLines.indexOf('心跳超时') >= 0 ? h('span', { className: 'dra-warn' }, '心跳超时') : null,
        ),
        v.loadReported ? h('div', { className: 'dra-bars' },
          h('div', { className: 'dra-bar-row' },
            h('span', { style: { width: 24 } }, 'CPU'),
            h('div', { className: 'dra-bar' }, h('div', { className: 'dra-bar-fill', style: { width: v.cpuPct + '%' } })),
            h('span', { className: 'dra-mono' }, v.cpuLabel),
          ),
          h('div', { className: 'dra-bar-row' },
            h('span', { style: { width: 24 } }, 'MEM'),
            h('div', { className: 'dra-bar' }, h('div', { className: 'dra-bar-fill', style: { width: v.memPct + '%' } })),
            h('span', { className: 'dra-mono' }, v.memLabel),
          ),
        ) : h('div', { className: 'dra-hint', style: { marginTop: 4 } }, v.cpuLabel),
        (n.roots && n.roots.length) ? h('div', {
          className: 'dra-hint dra-ell',
          title: n.roots.join('\n'),
          style: { marginTop: 5 },
        }, '工作区 ' + n.roots.length + ' 个：' + n.roots[0]) : null,
        h('div', { className: 'dra-node-actions' },
          h('button', { className: 'dra-act', onClick: function () { props.onAction(n.nodeId, 'detail') } }, '详情'),
          h('button', { className: 'dra-act', onClick: function () { props.onAction(n.nodeId, 'copy') } }, '复制 ID'),
          h('button', { className: 'dra-act', onClick: function () { props.onAction(n.nodeId, 'purge') } }, '清理'),
        ),
      )
    }

    function NodeCardGrid(props) {
      const nodes = props.nodes || []
      return h(Card, {
        title: '副机节点',
        sub: (props.onlineCount || 0) + '/' + nodes.length + ' 在线',
        actions: props.actions || null,
      },
        nodes.length === 0
          ? h('div', { className: 'dra-empty' }, '暂无副机节点，先在右侧「副机接入」把另一台电脑接进来')
          : h('div', { className: 'dra-node-grid' },
            nodes.map(function (n) {
              return h(NodeCard, { key: n.nodeId, node: n, onAction: props.onAction, nodeHealth: props.nodeHealth })
            }),
          ),
      )
    }

    /* ───────────────────────────── 拓扑动画 ───────────────────────────── */
    function TopologyMap(props) {
      const topology = props.topology && Array.isArray(props.topology.nodes) ? props.topology : null
      const nodes = topology ? topology.nodes : (Array.isArray(props.nodes) ? props.nodes : [])
      const tasks = props.tasks || []
      const { running, pulseCount } = topoActivity(tasks)
      const activeIds = {}
      tasks.forEach(function (t) {
        if (t && t.status === 'running' && t.nodeId) activeIds[t.nodeId] = true
      })
      const W = 640
      const H = Math.max(200, 166 + (Math.ceil(nodes.length / 6) - 1) * 34)
      const layout = legacyTopologyLayout(nodes, { width: W, height: H })
      const pulseNodes = new Set(running && pulseCount
        ? layout.nodes.filter(function (n) { return n.online }).slice(0, pulseCount) : [])
      const positions = new Map(layout.nodes.map(function (n) { return [n.nodeId, n] }))
      const hubLinks = topology && Array.isArray(topology.links)
        ? topology.links.filter(function (l) { return l.from === '@hub' && l.kind === 'hub' }).map(function (l) {
          const n = positions.get(l.to)
          return n ? { nodeId: n.nodeId, kind: 'hub', transport: n.transport } : null
        }).filter(Boolean) : layout.hubLinks
      /* 与新拓扑板同一个候选模型：不再画绿色对等线，也不在服务端没给 peerLinks 时自行配对。 */
      const mesh = topoMeshModel(props.topology, Array.isArray(props.nodes) ? props.nodes : nodes)
      const summary = topology && topology.summary
      const ys = layout.nodes.map(function (n) { return n.y })
      const bandTop = ys.length ? Math.min.apply(null, ys) - 22 : 0
      const bandBottom = ys.length ? Math.max.apply(null, ys) + 34 : 0
      return h(Card, {
        title: '拓扑连接',
        sub: summary ? '直连 ' + summary.direct + ' · 中继 ' + summary.relay + ' · 未知 ' + summary.unknown
          + ' · 隧道就绪 ' + summary.tunnelReady + ' · 服务端对等计数 ' + summary.peerCapable : '链路汇总未上报',
      },
        h('div', { className: 'dra-topo-wrap', style: { height: H } },
          nodes.length === 0 ? h('div', { className: 'dra-topo-empty' }, '暂无副机连接') :
          h('svg', { className: 'dra-topo-svg', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet' },
            mesh.band ? h('rect', {
              key: 'mesh-band', x: 8, y: bandTop, width: W - 16, height: Math.max(0, bandBottom - bandTop), rx: 16, className: 'dra-mesh-band',
            }, h('title', null, mesh.labels.band)) : null,
            hubLinks.map(function (l) {
              const p = positions.get(l.nodeId)
              const active = activeIds[l.nodeId] === true
              return h('line', {
                key: 'l-' + l.nodeId,
                x1: layout.hub.x, y1: layout.hub.y + 14, x2: p.x, y2: p.y - 10,
                className: 'dra-topo-line' + (active ? ' active' : '') + (running && active ? ' flow' : ''),
                style: { stroke: l.transport === 'direct' ? 'var(--dra-accent)' : l.transport === 'relay' ? 'var(--dra-warn)' : 'var(--dra-faint)',
                  strokeDasharray: l.transport === 'direct' ? 'none' : l.transport === 'relay' ? '6 4' : '1 5' },
              })
            }),
            h('circle', { cx: layout.hub.x, cy: layout.hub.y, r: 20, className: 'dra-topo-node hub' }),
            h('text', { x: layout.hub.x, y: layout.hub.y + 4, className: 'dra-topo-label', style: { fill: 'var(--dra-accent)', fontSize: '9px' } }, '中控'),
            layout.nodes.map(function (p) {
              const online = p.online === true
              const badge = mesh.badges[p.nodeId]
              return h('g', { key: 'n-' + p.nodeId },
                pulseNodes.has(p) ? h('circle', { cx: p.x, cy: p.y, r: 10, className: 'dra-topo-pulse' }) : null,
                p.tunnelState === 'error' || p.tunnelState === 'ready'
                  ? h('circle', { cx: p.x, cy: p.y, r: 12, fill: 'none', strokeWidth: 1.5,
                    stroke: p.tunnelState === 'error' ? 'var(--dra-danger)' : 'var(--dra-ok)' }) : null,
                h('circle', {
                  cx: p.x, cy: p.y, r: 8,
                  className: 'dra-topo-node' + (online ? ' online' : ''),
                }),
                h('text', { x: p.x, y: p.y + 24, className: 'dra-topo-label' }, shortId(p.nodeId).slice(0, 8)),
                badge ? h('text', { x: p.x, y: p.y - 14, className: 'dra-mesh-badge dra-mesh-badge-legacy' }, badge) : null,
              )
            }),
          ),
        ),
        h('div', { className: 'dra-hint dra-mesh-summary' }, mesh.band ? mesh.labels.band : mesh.labels.summary,
          mesh.labels.dropped ? ' · ' + mesh.labels.dropped : ''),
        h('div', { className: 'dra-hint dra-mesh-legend', style: { marginTop: 6 } }, TOPO_TEXT.legacyLegend),
      )
    }

    /* ───────────────────────────── 任务列表 ───────────────────────────── */
    /* ───────────── Mesh P1（S2 交办）：取消证据 / 停滞提示 / 取消回执（只读、纯函数） ───────────── */
    const ALPHA_BOT_TURN_NOTE = '机器人回合（bot turn）不记录逐回合状态；hub 重启后，进行中的回合结果未知，此处不追踪也不自动恢复。'

    function cancelEvidenceLabel(t) {
      const ev = t && t.cancelEvidence
      if (!ev || ev.state !== 'aborted') return ''
      return ev.abortedBeforeStart === true ? '已取消（未开始，节点确认）' : '已取消（节点确认）'
    }

    function stallLabel(t) {
      const sh = t && t.stallHint
      if (!sh || sh.stalled !== true) return ''
      if (ACTIVE_STATUSES.indexOf(t.status) < 0) return ''
      return '已 ' + Math.max(1, Math.floor((Number(sh.idleMs) || 0) / 60000)) + ' 分钟无更新（仅提示）'
    }

    const CANCEL_TERMINAL_STATUSES = ['completed', 'failed', 'aborted', 'interrupted', 'rejected']
    /* 回执只描述"这次点击"，不描述任务状态；分类依据点击前的最后已知状态。 */
    function cancelReceipt(args) {
      const before = args && args.before
      const response = args && args.response
      if (before && CANCEL_TERMINAL_STATUSES.indexOf(before.status) >= 0) {
        return { kind: 'terminal', text: '任务已结束，无需取消' }
      }
      if (response && response.requested === true) {
        return { kind: 'requested', text: '已提交取消请求，等待任务状态更新' }
      }
      return { kind: 'notDelivered', text: '取消请求未送达' }
    }

    function TaskRow(props) {
      const t = props.task || {}
      const active = ACTIVE_STATUSES.indexOf(t.status) >= 0
      const tone = t.status === 'completed' ? 'ok' : (t.status === 'failed' || t.status === 'aborted' || t.status === 'rejected') ? 'bad' : (t.status === 'pending_approval' ? 'warn' : 'acc')
      const dur = active
        ? (t.startedAt ? Date.now() - t.startedAt : 0)
        : (t.durationMs || (t.startedAt && t.endedAt ? t.endedAt - t.startedAt : 0))
      const line = progressLine(t)
      return h('div', {
        className: 'dra-task',
        onClick: function () { props.onAction(t.taskId, 'detail') },
      },
        h('div', { className: 'dra-task-main' },
          h('div', { className: 'dra-task-title' },
            h('span', { className: 'dra-task-goal', title: t.goal }, t.goal || '(无目标)'),
            h(Badge, { tone: tone, glow: active }, STATUS_LABEL[t.status] || t.status),
            t.mode ? h(Badge, { tone: 'soft' }, t.mode) : null,
            t.approval === 'manual' && t.status === 'pending_approval' ? h(Badge, { tone: 'warn' }, '需批准') : null,
          ),
          h('div', { className: 'dra-task-sub' },
            h('span', { className: 'dra-mono' }, shortId(t.taskId)),
            h('span', null, shortId(t.nodeId)),
            active ? h('span', { className: 'dra-acc' }, '已跑 ' + fmtDur(dur)) : h('span', null, '耗时 ' + fmtDur(dur)),
            h('span', null, fmtTime(t.updatedAt || t.createdAt)),
            t.changedCount ? h('span', null, '改动 ' + t.changedCount) : null,
          ),
          line ? h('div', { className: 'dra-progress', title: line }, '最近：' + line) : null,
          cancelEvidenceLabel(t) ? h('div', { className: 'dra-hint' }, cancelEvidenceLabel(t)) : null,
          stallLabel(t) ? h('div', { className: 'dra-hint' }, stallLabel(t)) : null,
        ),
        h('div', { className: 'dra-task-actions' },
          h('button', { className: 'dra-act', onClick: function (e) { e.stopPropagation(); props.onAction(t.taskId, 'detail') } }, '详情'),
          active ? h('button', { className: 'dra-act', onClick: function (e) { e.stopPropagation(); props.onAction(t.taskId, 'cancel') } }, '取消') : null,
          t.status === 'pending_approval' ? h('button', { className: 'dra-act', onClick: function (e) { e.stopPropagation(); props.onAction(t.taskId, 'approve') } }, '批准') : null,
          t.status === 'pending_approval' ? h('button', { className: 'dra-act', onClick: function (e) { e.stopPropagation(); props.onAction(t.taskId, 'reject') } }, '拒绝') : null,
          t.status === 'completed' ? h('button', { className: 'dra-act', onClick: function (e) { e.stopPropagation(); props.onAction(t.taskId, 'pull') } }, '拉取') : null,
        ),
      )
    }

    function TaskList(props) {
      const all = props.tasks || []
      const filter = props.filter || 'all'
      const active = all.filter(function (t) { return ACTIVE_STATUSES.indexOf(t.status) >= 0 })
      const history = all.filter(function (t) { return ACTIVE_STATUSES.indexOf(t.status) < 0 })
      const chips = [
        ['all', '全部'], ['running', '运行中'], ['completed', '已完成'], ['failed', '失败'],
      ]
      const head = h('div', { className: 'dra-filterbar' },
        chips.map(function (c) {
          return h('button', {
            key: c[0],
            className: 'dra-chip' + (filter === c[0] ? ' active' : ''),
            onClick: function () { props.onFilter(c[0]) },
          }, c[1] + (c[0] === 'all' ? ' ' + all.length : ''))
        }),
      )
      const body = []
      if (filter === 'all' || filter === 'running') {
        if (active.length) {
          body.push(h('div', { key: 'g-active', className: 'dra-group-label' }, '运行中（' + active.length + '）'))
          active.forEach(function (t) { body.push(h(TaskRow, { key: t.taskId, task: t, onAction: props.onAction })) })
        } else if (filter === 'running') {
          body.push(h('div', { key: 'e-active', className: 'dra-empty' }, '当前没有运行中的任务'))
        }
      }
      const shown = filter === 'completed'
        ? history.filter(function (t) { return t.status === 'completed' })
        : filter === 'failed'
          ? history.filter(function (t) { return t.status === 'failed' || t.status === 'aborted' || t.status === 'rejected' })
          : history
      if (shown.length) {
        if (filter === 'all') body.push(h('div', { key: 'g-hist', className: 'dra-group-label' }, '历史（' + shown.length + '）'))
        shown.forEach(function (t) { body.push(h(TaskRow, { key: t.taskId, task: t, onAction: props.onAction })) })
      } else if (filter !== 'running') {
        body.push(h('div', { key: 'e-hist', className: 'dra-empty' }, '没有匹配的任务'))
      }
      return h(Card, {
        title: '任务',
        sub: all.length + ' 条（保留历史）',
        actions: head,
      },
        h('div', null,
          h('div', { className: 'dra-row', style: { justifyContent: 'space-between', paddingBottom: 4 } },
            h('span', { className: 'dra-hint' }, '点击任务行看详情；hover 显示操作'),
            h('button', {
              className: 'dra-btn sm danger',
              disabled: props.purgeBusy === true,
              onClick: props.onClear,
            }, props.purgeBusy ? '清理中…' : '清理'),
          ),
          h('div', { className: 'dra-tasklist' }, body),
        ),
      )
    }

    /* ───────────────────────────── 接入配置 ───────────────────────────── */
    function ConfigPanel(props) {
      const cfg = props.cfg || {}
      const edit = props.edit || {}
      const isWorker = props.mode === 'worker'
      const val = function (k) {
        return edit[k] != null ? edit[k] : (cfg[k] || '')
      }
      const tm = isWorker ? (val('transportMode') || 'relay') : null
      const isDirect = tm === 'direct'
      const template = function () {
        const lines = [
          '- id: remote-agent',
          '  name: dsh-ai-cluster',
          '  config:',
          '    role: ' + (isWorker ? 'worker' : 'hub'),
        ]
        if (isWorker) {
          if (isDirect) {
            lines.push('    transportMode: direct')
            lines.push('    hubUrl: ' + (val('hubUrl') || '<主机地址:端口>'))
          } else {
            lines.push('    transportMode: relay')
            lines.push('    relayUrl: ' + (val('relayUrl') || '<中继地址>'))
          }
        } else if (val('relayUrl')) {
          lines.push('    relayUrl: ' + val('relayUrl'))
        }
        if (isWorker) {
          lines.push('    enrollToken: ' + (val('enrollToken') || '<enrollToken>'))
        } else {
          lines.push('    nodeToken: ' + (val('hubToken') || '<hubToken>'))
        }
        return lines.join('\n')
      }
      const field = function (key, label, placeholder, type) {
        return h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, label),
          h('input', {
            className: 'dra-input dra-mono',
            type: type || 'text',
            value: val(key),
            placeholder: placeholder,
            onChange: function (e) { props.onEdit(key, e.target.value) },
          }),
        )
      }
      return h(Card, {
        title: '接入与配置',
        sub: isWorker ? 'Worker 模式' : 'Hub 模式',
        actions: h(Badge, { tone: 'soft' }, 'role: ' + (cfg.role || '—')),
      },
        isWorker ? h('div', { className: 'dra-row', style: { gap: 8, marginBottom: 6 } },
          h('div', {
            className: 'dra-mode-card' + (!isDirect ? ' active' : ''),
            onClick: function () { props.onEdit('transportMode', 'relay') },
          }, h('span', null, '中继（relay）')),
          h('div', {
            className: 'dra-mode-card' + (isDirect ? ' active' : ''),
            onClick: function () { props.onEdit('transportMode', 'direct') },
          }, h('span', null, '直连（direct）')),
        ) : h('div', { className: 'dra-field' },
          h('span', { className: 'dra-label' }, '连接方式（在线节点上报）'),
          h('span', null, props.transportSummary ? props.transportSummary.label : '未知（暂无在线节点）'),
        ),
        isDirect
          ? h('div', { className: 'dra-field' },
              h('label', { className: 'dra-label' }, '主机地址（hubUrl）· 必填（直连模式）'),
              h('input', {
                className: 'dra-input dra-mono',
                value: val('hubUrl'),
                placeholder: 'http://<主机IP>:<端口>',
                onChange: function (e) { props.onEdit('hubUrl', e.target.value) },
              }),
            )
          : h('div', { className: 'dra-field' },
              h('label', { className: 'dra-label' }, isWorker ? '中继地址（relayUrl）' : '中继地址（relayUrl）· 可选'),
              h('input', {
                className: 'dra-input dra-mono',
                value: val('relayUrl'),
                placeholder: 'ws://<主机地址>:8890/relay',
                onChange: function (e) { props.onEdit('relayUrl', e.target.value) },
              }),
            ),
        isWorker
          ? field('enrollToken', '接入口令（enrollToken）', 'enr_…')
          : field('hubToken', '主机口令（hubToken）', '留空表示沿用当前口令', 'password'),
        h('div', { className: 'dra-row', style: { justifyContent: 'space-between', marginTop: 2 } },
          h('span', { className: 'dra-hint' },
            isWorker
              ? (cfg.relayTokenSet ? '口令已设置' : '口令未设置')
              : (cfg.nodeTokenSet ? '主机口令已设置' : '主机口令未设置（独立监听只能绑回环，副机连不上）'),
          ),
          h(CopyBtn, { label: '复制配置模板', text: template() }),
        ),
        h('div', { className: 'dra-hint', style: { marginTop: 6 } },
          '以上地址写回 profile 的 cordis.patch.yml 后重启 DSH 生效；面板只做本地编辑与复制。',
        ),
        isWorker ? h('div', { className: 'dra-hint dra-warn', style: { marginTop: 3 } },
          isDirect
            ? '直连模式下副机主动连主机，主机端口需可达；主机在 NAT 后请用中继。'
            : '中继地址请填具体的局域网 / Tailscale IP，不能用 0.0.0.0 或 localhost。',
        ) : null,
      )
    }

    /* ───────────────────────────── 快速派发 ───────────────────────────── */
    function DispatchForm(props) {
      const f = props.form || {}
      const modelCustom = props.modelCustom === true
      const setModelCustom = function (v) { if (typeof props.setModelCustom === 'function') props.setModelCustom(v) }
      const nodes = props.nodes || []
      const onlineNodes = nodes.filter(function (n) { return n.online === true })
      const selNode = nodes.filter(function (n) { return n.nodeId === f.node })[0] || null
      /* 提案 #27：副机上报的模型清单 → 节点视图 → 这里渲染成下拉。
       * 有清单用 select；没清单（旧副机 / 探测失败）退回自由文本。 */
      const modelOptions = []
      const seenModel = {}
      nodes.forEach(function (o) {
        ;(o.models || []).forEach(function (m) {
          const key = (m.provider || '') + '/' + (m.id || '')
          if (seenModel[key]) return
          seenModel[key] = true
          modelOptions.push({ key: key, label: m.name || m.id, nodeId: o.nodeId })
        })
      })
      const hasList = modelOptions.length > 0
      const isCustom = modelCustom || (!!f.model && hasList && !modelOptions.some(function (o) { return o.key === f.model }))
      const set = function (k, v) {
        const patch = {}
        patch[k] = v
        props.onFormChange(patch)
      }
      return h(Card, { title: '快速派发', sub: 'Hub → 选中的副机' },
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '目标节点'),
          h('select', {
            className: 'dra-select',
            value: f.node || '',
            onChange: function (e) { set('node', e.target.value) },
          },
            h('option', { value: '' }, '自动选择（按负载路由）'),
            onlineNodes.map(function (n) {
              return h('option', { key: n.nodeId, value: n.nodeId }, shortId(n.nodeId) + (n.os ? ' · ' + n.os : ''))
            }),
          ),
          h('div', { className: 'dra-hint' }, '机器人级交办本期不可用'),
        ),
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '任务目标'),
          h('textarea', {
            className: 'dra-textarea',
            value: f.goal || '',
            placeholder: '例如：运行测试并修复失败的用例；或执行 npm run build 并汇报结果',
            onChange: function (e) { set('goal', e.target.value) },
          }),
        ),
        h('div', { className: 'dra-row' },
          h('div', { className: 'dra-field', style: { flex: '1 1 120px' } },
            h('label', { className: 'dra-label' }, '执行模式'),
            h('select', {
              className: 'dra-select',
              value: f.mode || 'agent',
              onChange: function (e) { set('mode', e.target.value) },
            },
              h('option', { value: 'agent' }, 'agent · 新开独立会话'),
              h('option', { value: 'exec' }, 'exec · 直接执行命令'),
            ),
          ),
        ),
        h('details', { className: 'dra-fold' },
          h('summary', null, '高级选项'),
          h('div', { className: 'dra-fold-body' },
            h('div', { className: 'dra-field' },
              h('label', { className: 'dra-label' }, '工作区（副机 roots 内）'),
              h('input', {
                className: 'dra-input dra-mono',
                value: f.workspace || '',
                placeholder: selNode && selNode.roots && selNode.roots[0] ? selNode.roots[0] : '留空 = 副机默认工作区',
                list: 'dra-ws-list',
                onChange: function (e) { set('workspace', e.target.value) },
              }),
              h('datalist', { id: 'dra-ws-list' },
                !selNode ? null : (selNode.roots || []).map(function (r) {
                  return h('option', { key: r, value: r })
                }),
              ),
            ),
            h('div', { className: 'dra-field' },
              h('label', { className: 'dra-label' }, '模型'),
              hasList ? h('select', {
                className: 'dra-select',
                value: isCustom ? '__custom__' : (f.model || ''),
                onChange: function (e) {
                  const v = e.target.value
                  if (v === '__custom__') { setModelCustom(true); set('model', ''); return }
                  setModelCustom(false)
                  set('model', v)
                },
              },
                h('option', { value: '' }, '跟随副机默认'),
                modelOptions.map(function (o) {
                  return h('option', { key: o.key, value: o.key }, o.label + ' · ' + o.nodeId)
                }),
                h('option', { value: '__custom__' }, '自定义模型…'),
              ) : h('input', {
                className: 'dra-input dra-mono',
                value: f.model || '',
                placeholder: '没有清单，手动填 provider/model',
                onChange: function (e) { setModelCustom(true); set('model', e.target.value) },
              }),
              isCustom ? h('input', {
                className: 'dra-input dra-mono',
                style: { marginTop: 4 },
                value: f.model || '',
                placeholder: 'provider/model 或 model',
                onChange: function (e) { set('model', e.target.value) },
              }) : null,
            ),
            h('div', { className: 'dra-row' },
              h('div', { className: 'dra-field', style: { flex: '1 1 130px' } },
                h('label', { className: 'dra-label' }, '产出 glob（逗号分隔）'),
                h('input', {
                  className: 'dra-input dra-mono',
                  value: f.outputs || '',
                  placeholder: 'dist/**, *.md',
                  onChange: function (e) { set('outputs', e.target.value) },
                }),
              ),
              h('div', { className: 'dra-field', style: { flex: '0 0 100px' } },
                h('label', { className: 'dra-label' }, '超时（ms）'),
                h('input', {
                  className: 'dra-input dra-mono',
                  value: f.timeoutMs || '',
                  placeholder: '600000',
                  onChange: function (e) { set('timeoutMs', e.target.value) },
                }),
              ),
            ),
            h('label', { className: 'dra-check' },
              h('input', {
                type: 'checkbox',
                checked: f.needApproval === true,
                onChange: function (e) { set('needApproval', e.target.checked) },
              }),
              h('span', null, '需要先审批再派给副机'),
            ),
          ),
        ),
        h('button', {
          className: 'dra-btn primary',
          style: { width: '100%', marginTop: 8, padding: '8px 12px' },
          disabled: props.busy === true,
          onClick: props.onSubmit,
        }, props.busy ? '派发中…' : '派发任务'),
        h('div', { className: 'dra-hint', style: { marginTop: 5 } },
          'agent = 在副机新开独立会话；exec = 直接执行命令。两条路径都由副机本地执行。',
        ),
      )
    }

    /* ───────────────────────────── 副机接入 ───────────────────────────── */
    function StepGuide() {
      const steps = ['重启 DSH', '生成配对码', '在副机上粘贴', '等它连上']
      return h('div', null,
        h('div', { className: 'dra-hint' }, '首次接入按这四步走，不需要手写 YAML：'),
        h('div', { className: 'dra-steps' },
          steps.map(function (s, i) {
            return h('div', { key: s, className: 'dra-step' },
              h('b', null, String(i + 1)),
              h('span', null, s),
            )
          }),
        ),
        h('div', { className: 'dra-hint', style: { marginTop: 5 } },
          '你现在用的这台是主机；副机装好 dsh-ai-cluster 后把配对码贴进它的配置即可。',
        ),
      )
    }

    function PairPanel(props) {
      const pair = props.pair || null
      const codes = (pair && Array.isArray(pair.codes)) ? pair.codes : []
      return h('div', null,
        h('div', { className: 'dra-row', style: { justifyContent: 'space-between' } },
          h('span', { className: 'dra-hint' }, pair && pair.listener ? ('监听 ' + (pair.listener.host || '') + ':' + (pair.listener.port || '')) : '尚未读到监听状态'),
          h('button', { className: 'dra-btn sm', onClick: props.onLoadPair }, '刷新配对码'),
        ),
        props.pairNote ? h('div', { className: 'dra-hint dra-warn', style: { marginTop: 4 } }, props.pairNote) : null,
        codes.length === 0
          ? h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '还没有可用配对码。先确认独立监听已启动（端口默认 19387），再点「刷新配对码」。')
          : codes.map(function (c) {
            const line = 'pair: ' + (c.pairCode || '')
            return h('div', { key: c.address || c.name, className: 'dra-field', style: { marginTop: 7 } },
              h('div', { className: 'dra-row', style: { justifyContent: 'space-between' } },
                h('span', { className: 'dra-label' }, (c.name || 'address') + (c.private ? ' · 内网' : '') + (c.usable ? '' : ' · 不可用')),
                h(CopyBtn, { label: '复制 pair 配置行', text: line }),
              ),
              h('div', { className: 'dra-mono dra-wrap', style: { color: 'var(--dra-accent)' } }, line),
              c.hubUrl ? h('div', { className: 'dra-hint dra-wrap' }, c.hubUrl) : null,
            )
          }),
      )
    }

    function EnrollPanel(props) {
      const e = props.enroll || {}
      return h('div', null,
        h('button', {
          className: 'dra-btn dra-enroll-btn',
          disabled: e.loading === true,
          onClick: props.onEnroll,
        }, e.loading ? '铸造中…' : '+ 添加副机（生成一次性接入口令）'),
        e.error ? h('div', { className: 'dra-hint dra-danger', style: { marginTop: 5 } }, e.error) : null,
        e.data && e.data.token ? h('div', { className: 'dra-enroll-card' },
          h('div', { className: 'dra-row', style: { justifyContent: 'space-between' } },
            h('span', { className: 'dra-label' }, '一次性入网口令'),
            h(CopyBtn, { label: '复制', text: e.data.token }),
          ),
          h('div', { className: 'dra-token' }, e.data.token),
          h('div', { className: 'dra-hint' }, '15 分钟内有效，仅显示这一次'),
        ) : null,
      )
    }

    /* ───────────────────────────── 体检 ───────────────────────────── */
    function EnvPanel(props) {
      const ec = props.envCheck || null
      const items = ec && Array.isArray(ec.items) ? ec.items : []
      const plan = props.fixPlan || null
      return h('div', null,
        h('div', { className: 'dra-row', style: { justifyContent: 'space-between', marginBottom: 6 } },
          h('span', { className: 'dra-hint' },
            ec ? (ec.failed > 0 ? ec.failed + ' 项需要处理' : '全部通过') : '尚未体检',
          ),
          h('div', { className: 'dra-row' },
            h('button', { className: 'dra-btn sm primary', disabled: props.envBusy === true, onClick: props.onRun },
              props.envBusy ? '体检中…' : '体检'),
            h('button', { className: 'dra-btn sm', disabled: props.fixBusy === true, onClick: props.onPreviewFix }, '一键修复预览'),
            plan ? h('button', { className: 'dra-btn sm danger', disabled: props.fixBusy === true, onClick: props.onApplyFix }, '应用修复') : null,
          ),
        ),
        items.length === 0 ? h('div', { className: 'dra-hint' }, '点「体检」检查可达性 / inject / roots / role。') : null,
        items.map(function (it, i) {
          return h('div', { key: it.id || i, className: 'dra-env-item' },
            h('span', { className: 'dra-env-mark ' + (it.ok ? 'dra-ok' : 'dra-danger') }, it.ok ? '✓' : '✗'),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { className: 'dra-row', style: { justifyContent: 'space-between' } },
                h('span', null, it.label || it.id),
                it.autoFix ? h(Badge, { tone: 'warn' }, '可自动修复') : null,
              ),
              it.ok ? null : h('div', { className: 'dra-hint dra-wrap' }, it.detail || ''),
              it.ok ? null : h('div', { className: 'dra-row', style: { marginTop: 3, gap: 6 } },
                h('span', { className: 'dra-hint dra-wrap', style: { flex: 1 } }, it.fix || ''),
                h('button', {
                  className: 'dra-copy',
                  title: '复制这条修法',
                  onClick: function () { copyText(it.fix) },
                }, '复制修法'),
              ),
            ),
          )
        }),
        plan ? h('div', { className: 'dra-pre' }, typeof plan === 'string' ? plan : JSON.stringify(plan, null, 2)) : null,
        props.fixMsg ? h('div', { className: 'dra-hint', style: { marginTop: 6 } }, props.fixMsg) : null,
        h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '一键修复只改托管块并备份，写后校验；不会改动其它插件配置。'),
      )
    }

    /* ───────────────────────────── 外部工具 ───────────────────────────── */
    function ToolPanel(props) {
      const d = props.tools || null
      const tools = d && Array.isArray(d.tools) ? d.tools : []
      return h('div', null,
        h('div', { className: 'dra-row', style: { justifyContent: 'space-between', marginBottom: 6 } },
          h('span', { className: 'dra-hint' }, d ? (d.platform || '') + ' · 缺 ' + ((d.missing || []).length) + ' 项' : '尚未检测'),
          h('button', { className: 'dra-btn sm', disabled: props.busy === true, onClick: props.onRefresh },
            props.busy ? '检测中…' : '检测工具'),
        ),
        tools.length === 0 ? h('div', { className: 'dra-hint' }, '点「检测工具」探测 git / node / rg 等外部工具。') : null,
        h('div', { className: 'dra-tools-grid' },
          tools.map(function (t) {
            return h('div', { key: t.id, className: 'dra-tool' },
              h('div', { className: 'dra-tool-name' },
                h('span', null, t.name || t.id),
                h(Badge, { tone: t.installed ? 'ok' : (t.required ? 'bad' : 'warn') }, t.installed ? (t.version || '已装') : (t.required ? '必需缺失' : '未装')),
              ),
              h('div', { className: 'dra-tool-meta' }, t.why || ''),
              t.installed ? null : h('div', { className: 'dra-tool-meta' },
                h('div', { className: 'dra-mono dra-wrap' }, t.install || ''),
                h('div', { className: 'dra-row', style: { marginTop: 3 } },
                  t.install ? h(CopyBtn, { label: '复制命令', text: t.install }) : null,
                  t.url ? h('a', { className: 'dra-hint', href: t.url, target: '_blank', rel: 'noreferrer' }, '官方链接') : null,
                ),
              ),
            )
          }),
        ),
        h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '只检测并给出安装命令，不会代你下载或执行安装。'),
      )
    }

    /* ───────────────────────────── 工作区共享（SMB）────────────────────────────── */
    function SharePanel(props) {
      const nodes = (props.nodes || []).filter(function (n) { return n.online === true })
      const nodeS = React.useState(nodes.length > 0 ? nodes[0].nodeId : '')
      const nodeId = nodeS[0]
      const setNodeId = nodeS[1]
      function rootsOf(id) {
        const n = nodes.filter(function (x) { return x.nodeId === id })[0]
        const rs = n && Array.isArray(n.roots) ? n.roots.filter(function (r) { return typeof r === 'string' && r !== '' }) : []
        return rs
      }
      const nodeRoots = rootsOf(nodeId)
      const dirS = React.useState(nodeRoots.length > 0 ? nodeRoots[0] : '')
      const shareDir = dirS[0]
      const setShareDir = dirS[1]
      const accessS = React.useState('read')
      const access = accessS[0]
      const setAccess = accessS[1]
      const ackS = React.useState(false)
      const ack = ackS[0]
      const setAck = ackS[1]
      const busyS = React.useState(false)
      const busy = busyS[0]
      const setBusy = busyS[1]
      const noteS = React.useState('')
      const note = noteS[0]
      const setNote = noteS[1]
      const planS = React.useState(null)
      const plan = planS[0]
      const setPlan = planS[1]

      function doPlan() {
        if (!nodeId) { setNote('先选一台在线副机'); return }
        if (!ack) { setNote('请先勾选已知情'); return }
        // dir 必填：副机按设计拒绝空目录，空值不拦只会让用户点了才失败。
        if (shareDir.trim() === '') { setNote('先选择或填写共享目录'); return }
        setBusy(true)
        setPlan(null)
        apiPost('/share', {
          action: 'plan',
          node: nodeId,
          dir: shareDir,
          access: access,
          confirm: 'yes',
        })
          .then(function (r) { setPlan(r || null); setNote('') })
          .catch(function (e) { setNote('生成失败：' + ((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      return h('div', null,
        h('div', { className: 'dra-hint' },
          '把副机的工作区用 SMB 共享出来，主机映射成盘符后用本地 IDE 直接打开。开启后插件 roots / denyPaths 边界失效，.env 与密钥对共享方可见，风险自负。',
        ),
        h('div', { className: 'dra-row', style: { marginTop: 7 } },
          h('div', { className: 'dra-field', style: { flex: '1 1 150px' } },
            h('label', { className: 'dra-label' }, '副机'),
            h('select', {
              className: 'dra-select',
              value: nodeId,
              onChange: function (e) {
                setNodeId(e.target.value)
                const rs = rootsOf(e.target.value)
                setShareDir(rs.length ? rs[0] : '')
                setPlan(null)
              },
            }, nodes.map(function (n) { return h('option', { key: n.nodeId, value: n.nodeId }, shortId(n.nodeId)) })),
          ),
          h('div', { className: 'dra-field', style: { flex: '1 1 170px' } },
            h('label', { className: 'dra-label' }, '共享目录'),
            nodeRoots.length > 0
              ? h('select', {
                className: 'dra-select dra-mono',
                value: shareDir,
                onChange: function (e) { setShareDir(e.target.value); setPlan(null) },
              }, nodeRoots.map(function (r) { return h('option', { key: r, value: r }, r) }))
              : h('input', {
                className: 'dra-input dra-mono',
                value: shareDir,
                placeholder: '副机工作区绝对路径（如 D:\\work），需要先在副机配置 roots',
                onChange: function (e) { setShareDir(e.target.value); setPlan(null) },
              }),
          ),
        ),
        nodeRoots.length === 0
          ? h('div', { className: 'dra-hint', style: { marginTop: 3 } },
            '这台副机没上报 roots —— 请先在副机配置工作区；共享只允许 roots 内的目录。')
          : h('div', { className: 'dra-hint', style: { marginTop: 3 } }, '只共享这一个目录，不要共享整个盘。'),
        h('div', { className: 'dra-row', style: { marginTop: 2 } },
          h('div', { className: 'dra-field', style: { flex: '0 0 110px' } },
            h('label', { className: 'dra-label' }, '权限'),
            h('select', {
              className: 'dra-select',
              value: access,
              onChange: function (e) { setAccess(e.target.value); setPlan(null) },
            },
              h('option', { value: 'read' }, '只读'),
              h('option', { value: 'write' }, '读写'),
            ),
            access === 'write' ? h('div', { className: 'dra-hint dra-warn', style: { marginTop: 3 } }, '读写模式下主机可以修改副机文件（默认只读，最小权限）') : null,
          ),
          h('label', { className: 'dra-check', style: { marginTop: 14 } },
            h('input', { type: 'checkbox', checked: ack, onChange: function (e) { setAck(e.target.checked) } }),
            h('span', null, '我已知情：共享会绕过 roots / denyPaths 边界'),
          ),
        ),
        h('div', { className: 'dra-row', style: { marginTop: 6 } },
          h('button', {
            className: 'dra-btn sm primary',
            disabled: busy || !ack || nodeId === '' || shareDir.trim() === '',
            onClick: doPlan,
          }, busy ? '生成中…' : '生成共享命令'),
        ),
        note ? h('div', { className: 'dra-hint dra-warn', style: { marginTop: 5 } }, note) : null,
        plan ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 7 } }, '在副机（管理员 PowerShell）执行'),
          h('div', { className: 'dra-pre' }, (plan.followUp || []).join('\n') || plan.message || JSON.stringify(plan, null, 2)),
        ) : null,
      )
    }

    /* ───────────────────────────── 任务详情 ───────────────────────────── */
    function finalPathsOf(handoff) {
      const m = handoff && Array.isArray(handoff.manifest) ? handoff.manifest : []
      return m.filter(function (e) { return e && e.role === 'final' }).map(function (e) { return e.path })
    }

    function TaskDetail(props) {
      const d = props.detail || null
      const t = d && d.task ? d.task : null
      const handoff = d && d.handoff ? d.handoff : null
      if (props.loading === true) {
        return h('div', { className: 'dra-detail dra-hint' }, '读取任务详情…')
      }
      if (!t) return null
      const finals = finalPathsOf(handoff)
      return h('div', { className: 'dra-detail' },
        h('div', { className: 'dra-row', style: { justifyContent: 'space-between', marginBottom: 6 } },
          h('div', { className: 'dra-row' },
            h('span', { className: 'dra-card-title' }, '任务详情'),
            h(Badge, { tone: t.status === 'completed' ? 'ok' : (t.status === 'failed' ? 'bad' : 'acc') }, STATUS_LABEL[t.status] || t.status),
          ),
          h('button', { className: 'dra-btn sm', onClick: props.onClose }, '收起'),
        ),
        h('dl', { className: 'dra-kv' },
          h('dt', null, 'taskId'), h('dd', { className: 'dra-mono' }, t.taskId),
          h('dt', null, '节点'), h('dd', { className: 'dra-mono' }, t.nodeId),
          h('dt', null, '模式'), h('dd', null, (t.mode || '—') + (t.approval === 'manual' ? ' · 需审批' : '')),
          h('dt', null, '创建'), h('dd', null, fmtTime(t.createdAt)),
          h('dt', null, '结束'), h('dd', null, fmtTime(t.endedAt)),
          h('dt', null, '耗时'), h('dd', null, fmtDur(t.durationMs || (t.endedAt && t.startedAt ? t.endedAt - t.startedAt : 0))),
          t.exit ? h('dt', null, '退出码') : null,
          t.exit ? h('dd', { className: 'dra-mono ' + (t.exit.code === 0 ? 'dra-ok' : 'dra-danger') },
            String(t.exit.code) + (t.exit.timedOut ? ' · 超时' : '') + (t.exit.aborted ? ' · 中止' : '')) : null,
          cancelEvidenceLabel(t) ? h('dt', null, '任务证据') : null,
          cancelEvidenceLabel(t) ? h('dd', null, cancelEvidenceLabel(t)) : null,
          stallLabel(t) ? h('dt', null, '停滞提示') : null,
          stallLabel(t) ? h('dd', null, stallLabel(t)) : null,
          t.error ? h('dt', null, '错误') : null,
          t.error ? h('dd', { className: 'dra-danger dra-wrap' }, (t.error.code || '') + ' ' + (t.error.message || '')) : null,
        ),
        t.summaryText ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 8 } }, '摘要'),
          h('div', { className: 'dra-pre' }, t.summaryText),
        ) : null,
        (t.changed && t.changed.length) ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 8 } }, '改动（' + t.changedCount + '）'),
          h('div', { className: 'dra-pre' }, t.changed.join('\n')),
        ) : null,
        finals.length ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 8 } }, '成品（' + finals.length + '）'),
          finals.map(function (p) {
            return h('div', { key: p, className: 'dra-row', style: { justifyContent: 'space-between', marginTop: 3 } },
              h('span', { className: 'dra-mono dra-wrap', style: { flex: 1 } }, p),
              h('button', {
                className: 'dra-btn sm',
                onClick: function () { props.onAction(t.taskId, 'pull', p) },
              }, '拉取'),
            )
          }),
        ) : (handoff ? h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '该任务没有 role=final 的成品可拉。') : null),
        (t.progressTail && t.progressTail.length) ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 8 } }, '进度'),
          h('div', { className: 'dra-pre' }, t.progressTail.map(function (p, i) {
            return (i + 1) + '. ' + (typeof p === 'string' ? p : (p.detail || p.message || JSON.stringify(p)))
          }).join('\n')),
        ) : null,
        (t.logTail && t.logTail.length) ? h('div', null,
          h('div', { className: 'dra-label', style: { marginTop: 8 } }, '日志（尾）'),
          h('div', { className: 'dra-pre' }, t.logTail.join('\n')),
        ) : null,
      )
    }

    /* ───────────────────────────── 首次配置 ───────────────────────────── */
    function SetupView(props) {
      const setup = props.setup || {}
      const cur = setup.current || {}
      const switching = props.switching === true
      const [step, setStep] = React.useState('choose')
      const [role, setRole] = React.useState(switching ? (cur.role || 'hub') : '')
      const [hubUrl, setHubUrl] = React.useState(cur.hubUrl || '')
      const [relayUrl, setRelayUrl] = React.useState(cur.relayUrl || '')
      const [hubToken, setHubToken] = React.useState(cur.hubToken || '')
      const [transportMode, setTransportMode] = React.useState(cur.transportMode || 'relay')
      const [nodeId, setNodeId] = React.useState(cur.nodeId || '')
      const [roots, setRoots] = React.useState(Array.isArray(cur.roots) && cur.roots.length ? cur.roots.join('\n') : defaultRootsHint())
      const [pairCode, setPairCode] = React.useState('')
      // 节点 ID 默认取主机名，折叠为高级选项（少一个必读字段）。
      const [showAdv, setShowAdv] = React.useState(false)
      const [listenHost, setListenHost] = React.useState(cur.listenHost || '')
      const [listenPort, setListenPort] = React.useState(cur.listenPort == null ? '' : String(cur.listenPort))
      const [note, setNote] = React.useState('')
      const [conflict, setConflict] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      const [done, setDone] = React.useState(null)

      function defaultRootsHint() {
        // 面板拿不到服务端 os.homedir()，用 userAgent 判平台足够（这是预填提示，不是安全判定）。
        // 必须是具体子目录：roots 是安全边界，不能是整盘或整个家目录。
        try {
          const ua = (navigator && navigator.userAgent) || ''
          if (/Windows/i.test(ua)) return 'D:\\work'
          return '~/work'
        } catch (e) {
          return ''
        }
      }

      /* 配对码：dshra1://<base64(JSON)>，粘贴即填（副机不用手抄地址）。 */
      function parsePair(text) {
        const s = String(text || '').trim()
        if (!/^(dshra1:\/\/)/.test(s)) return null
        try {
          const raw = window.atob(s.slice('dshra1://'.length))
          const d = JSON.parse(raw)
          const n = {}
          n.hubUrl = d.hubUrl
          n.nodeId = d.nodeId
          n.roots = d.roots
          n.relayUrl = d.relayUrl
          // 保留 transportMode；配对码里有 direct 时 hubUrl 就是对端地址
          n.transportMode = d.transportMode || (d.hubUrl && !d.relayUrl ? 'direct' : 'relay')
          return n
        } catch (e) {
          return null
        }
      }

      function applyPair() {
        const d = parsePair(pairCode)
        if (!d) { setErr('配对码格式不对：应以 dshra1:// 开头'); return }
        if (d.hubUrl) setHubUrl(d.hubUrl)
        if (d.relayUrl) setRelayUrl(d.relayUrl)
        if (d.hubToken) setHubToken(d.hubToken)
        if (d.nodeId) setNodeId(d.nodeId)
        if (Array.isArray(d.roots) && d.roots.length) setRoots(d.roots.join('\n'))
        if (d.transportMode) setTransportMode(d.transportMode)
        setErr('')
        setNote('已从配对码填入地址（' + (d.transportMode === 'direct' ? '直连' : '中继') + '），确认后提交')
      }

      function submit(kind, opts) {
        const use = kind || role || 'hub'
        const body = { role: use }
        if (opts && opts.force === true) body.force = true
        // transportMode: always send so setup-routes can write it for both roles
        body.transportMode = transportMode === 'direct' ? 'direct' : 'relay'
        if (transportMode === 'direct') {
          // direct: 副机主动连主机，发 hubUrl，不发 relayUrl
          if (hubUrl.trim()) body.hubUrl = hubUrl.trim()
        } else {
          // relay: 通过中继转发，发 relayUrl；hub 也需要 relayUrl（relay-enroll 用）
          if (relayUrl.trim()) body.relayUrl = relayUrl.trim()
          if (use !== 'worker' && hubUrl.trim()) body.hubUrl = hubUrl.trim()
          // Bug 1 fix: hub 表单提交时发送 hubToken（主机口令）
          if (hubToken.trim()) body.hubToken = hubToken.trim()
        }
        body.listenHost = listenHost.trim()
        body.listenPort = listenPort.trim()
        if (nodeId.trim()) body.nodeId = nodeId.trim()
        const rs = String(roots || '').split(/[\n,]+/).map(function (x) { return x.trim() }).filter(Boolean)
        if (rs.length) body.roots = rs
        setBusy(true)
        setErr('')
        setNote('')
        setConflict('')
        fetch(SETUP_APPLY_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (r) {
            return r.json().catch(function () { return {} }).then(function (b) {
              return { ok: r.ok, status: r.status, body: b || {} }
            })
          })
          .then(function (res) {
            if (!res.ok) {
              const code = String(res.body.code || res.body.error || '')
              if (res.status === 409 || /conflict|exists/i.test(code)) setConflict(res.body.message || '检测到已有配置')
              setErr(res.body.message || res.body.error || ('HTTP ' + res.status))
              return
            }
            setDone(res.body)
            setStep('result')
          })
          .catch(function (e) { setErr(String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      const submitHub = function () { submit('hub', { force: true }) }
      const submitWorker = function () { submit('worker', { force: true }) }
      const submitChoice = function () { submit(role || 'hub', { force: true }) }

      if (step === 'result') {
        return h(Card, { title: '写入完成', sub: '重启后生效' },
          h('div', { className: 'dra-hint' },
            '已写入 ' + (done && (done.patchFile || done.file) ? (done.patchFile || done.file) : '配置文件') + '。',
          ),
          h('div', { className: 'dra-hint dra-ok', style: { marginTop: 6 } }, '重启 DSH 生效：配置改动不会热加载。'),
          h('button', { className: 'dra-btn primary', style: { marginTop: 8 }, onClick: function () { if (props.onDone) props.onDone(done); else if (props.onCancel) props.onCancel() } }, '知道了'),
        )
      }

      if (step === 'choose') {
        return h(Card, { title: switching ? '切换配置' : '首次配置', sub: '先选这台机器的角色' },
          h('div', { className: 'dra-err' }, err || note || ''),
          conflict ? h('div', { className: 'dra-warn' },
            h('span', null, conflict),
            h('button', { className: 'dra-btn sm', onClick: submitChoice }, '替换手写配置'),
          ) : null,
          h('div', { className: 'dra-hint' }, '你现在用的这台是主机还是副机？选错会让一半装机场景是错的。'),
          h('div', { className: 'dra-choices' },
            h('button', { className: 'dra-mode-card', onClick: function () { setRole('hub'); setStep('form') } },
              h('span', { className: 'dra-mode-txt' }, h('b', null, '我是主机'), h('span', null, 'Hub：管副机、派任务')),
            ),
            h('button', { className: 'dra-mode-card', onClick: function () { setRole('worker'); setStep('form') } },
              h('span', { className: 'dra-mode-txt' }, h('b', null, '我是副机'), h('span', null, 'Worker：等任务、回报')),
            ),
            h('button', { className: 'dra-mode-card', onClick: function () { setRole('both'); setStep('form') } },
              h('span', { className: 'dra-mode-txt' }, h('b', null, '同机自测'), h('span', null, 'both：一台机器跑两端')),
            ),
          ),
          switching ? h('button', { className: 'dra-btn', style: { marginTop: 8 }, onClick: props.onCancel }, '取消') : null,
        )
      }

      if (role === 'worker') {
        return h(Card, { title: switching ? '切换为副机' : '副机（Worker）配置', sub: '填中继地址或粘贴配对码' },
          h('div', { className: 'dra-field' },
            h('label', { className: 'dra-label' }, '监听地址 listenHost（空=自动）'),
            h('input', {
              className: 'dra-input dra-mono',
              value: listenHost,
              placeholder: '留空 = 自动选网卡',
              onChange: function (e) { setListenHost(e.target.value) },
            }),
          ),
          h('div', { className: 'dra-field' },
            h('label', { className: 'dra-label' }, '监听端口 listenPort（0–65535，空=自动，0=关闭）'),
            h('input', {
              className: 'dra-input dra-mono',
              value: listenPort,
              placeholder: '19387',
              onChange: function (e) { setListenPort(e.target.value) },
            }),
          ),
          h('div', { className: 'dra-field' },
            h('label', { className: 'dra-label' }, '配对码（dshra1://…，可整段粘贴）'),
            h('div', { className: 'dra-row' },
              h('input', {
                className: 'dra-input dra-mono',
                value: pairCode,
                placeholder: 'dshra1://eyJ...',
                onChange: function (e) { setPairCode(e.target.value) },
              }),
              h('button', { className: 'dra-btn sm', onClick: applyPair }, '解析填入'),
            ),
          ),
          /* 连接方式：中继 / 直连 */
          h('div', { className: 'dra-field' },
            h('label', { className: 'dra-label' }, '连接方式'),
            h('div', { className: 'dra-modes' },
              h('button', {
                className: 'dra-mode-card' + (transportMode === 'relay' ? ' active' : ''),
                onClick: function () { setTransportMode('relay') },
              }, h('span', null, '中继（relay）'), h('span', { className: 'dra-hint' }, '通过中继转发，主机在 NAT 后也可用')),
              h('button', {
                className: 'dra-mode-card' + (transportMode === 'direct' ? ' active' : ''),
                onClick: function () { setTransportMode('direct') },
              }, h('span', null, '直连（direct）'), h('span', { className: 'dra-hint' }, '副机主动连主机，主机端口需可达')),
            ),
          ),
          transportMode === 'direct'
            ? h('div', { className: 'dra-field' },
                h('label', { className: 'dra-label' }, '主机地址（hubUrl）'),
                h('input', {
                  className: 'dra-input dra-mono',
                  value: hubUrl,
                  placeholder: 'ws://主机IP:19387/api/remote-agent/node',
                  onChange: function (e) { setHubUrl(e.target.value) },
                }),
                h('div', { className: 'dra-hint' }, '副机主动连主机，主机端口需可达；主机在 NAT 后请用中继'),
              )
            : h('div', { className: 'dra-field' },
                h('label', { className: 'dra-label' }, '中继地址（relayUrl）'),
                h('input', {
                  className: 'dra-input dra-mono',
                  value: relayUrl,
                  placeholder: 'ws://192.168.1.10:8890/relay',
                  onChange: function (e) { setRelayUrl(e.target.value) },
                }),
              ),
          h('div', { className: 'dra-field' },
            h('label', { className: 'dra-label' }, '工作区 roots（每行一个）'),
            h('textarea', {
              className: 'dra-textarea dra-mono',
              value: roots,
              placeholder: defaultRootsHint(),
              onChange: function (e) { setRoots(e.target.value) },
            }),
          ),
          h('div', { className: 'dra-field' },
            h('label', { className: 'dra-label' },
              h('span', null, '本机标识'),
              h('span', {
                className: 'dra-hint',
                style: { marginLeft: 8, cursor: 'pointer', textDecoration: 'underline' },
                onClick: function () { setShowAdv(!showAdv) },
              }, showAdv ? '收起' : '默认用主机名（点此自定义）'),
            ),
            showAdv
              ? h('input', {
                className: 'dra-input dra-mono',
                value: nodeId,
                placeholder: '留空 = 自动用本机主机名',
                onChange: function (e) { setNodeId(e.target.value) },
              })
              : null,
          ),
          err || note ? h('div', { className: 'dra-err' }, err || note || '') : null,
          conflict ? h('div', { className: 'dra-warn' },
            h('span', null, conflict),
            h('button', { className: 'dra-btn sm', onClick: submitWorker }, '替换手写配置'),
          ) : null,
          h('div', { className: 'dra-row', style: { marginTop: 4 } },
            h('button', { className: 'dra-btn primary', disabled: busy, onClick: function () { submit('worker') } }, busy ? '写入中…' : '确认，写入配置'),
            h('button', { className: 'dra-btn', onClick: function () { setStep('choose') } }, '返回'),
            switching ? h('button', { className: 'dra-btn', onClick: props.onCancel }, '取消') : null,
          ),
          h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '写盘会先备份并校验；重启 DSH 后生效。'),
        )
      }

      return h(Card, { title: switching ? '切换为' + (role === 'both' ? '同机自测' : '主机') : '主机（Hub）配置', sub: '写 profile 的 cordis.patch.yml' },
        /* 连接方式：中继 / 直连 */
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '连接方式'),
          h('div', { className: 'dra-modes' },
            h('button', {
              className: 'dra-mode-card' + (transportMode === 'relay' ? ' active' : ''),
              onClick: function () { setTransportMode('relay') },
            }, h('span', null, '中继（relay）'), h('span', { className: 'dra-hint' }, '通过中继转发，副机在 NAT 后也可用')),
            h('button', {
              className: 'dra-mode-card' + (transportMode === 'direct' ? ' active' : ''),
              onClick: function () { setTransportMode('direct') },
            }, h('span', null, '直连（direct）'), h('span', { className: 'dra-hint' }, '副机主动连主机，主机端口需可达')),
          ),
        ),
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '中继地址（relayUrl，ws://IP:8890/relay）'),
          h('input', {
            className: 'dra-input dra-mono',
            value: relayUrl,
            placeholder: 'ws://192.168.1.10:8890/relay',
            onChange: function (e) { setRelayUrl(e.target.value) },
          }),
        ),
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '监听地址 listenHost（空=自动）'),
          h('input', {
            className: 'dra-input dra-mono',
            value: listenHost,
            placeholder: '留空 = 自动选网卡',
            onChange: function (e) { setListenHost(e.target.value) },
          }),
        ),
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '监听端口 listenPort（0–65535，空=自动，0=关闭）'),
          h('input', {
            className: 'dra-input dra-mono',
            value: listenPort,
            placeholder: '19387',
            onChange: function (e) { setListenPort(e.target.value) },
          }),
        ),
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '本机对外地址（hubUrl，可留空自动推断）'),
          h('input', {
            className: 'dra-input dra-mono',
            value: hubUrl,
            placeholder: 'http://192.168.1.10:19387',
            onChange: function (e) { setHubUrl(e.target.value) },
          }),
        ),
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' },
            h('span', null, '本机标识'),
            h('span', {
              className: 'dra-hint',
              style: { marginLeft: 8, cursor: 'pointer', textDecoration: 'underline' },
              onClick: function () { setShowAdv(!showAdv) },
            }, showAdv ? '收起' : '默认用主机名（点此自定义）'),
          ),
          showAdv
            ? h('input', {
              className: 'dra-input dra-mono',
              value: nodeId,
              placeholder: '留空 = 自动用本机主机名',
              onChange: function (e) { setNodeId(e.target.value) },
            })
            : null,
        ),
        h('div', { className: 'dra-field' },
          h('label', { className: 'dra-label' }, '工作区 roots（每行一个）'),
          h('textarea', {
            className: 'dra-textarea dra-mono',
            value: roots,
            placeholder: defaultRootsHint(),
            onChange: function (e) { setRoots(e.target.value) },
          }),
          h('div', { className: 'dra-hint' }, defaultRootsHint()),
        ),
        err || note ? h('div', { className: 'dra-err' }, err || note || '') : null,
        conflict ? h('div', { className: 'dra-warn' },
          h('span', null, conflict),
          h('button', { className: 'dra-btn sm', onClick: submitHub }, '替换手写配置'),
        ) : null,
        h('div', { className: 'dra-row', style: { marginTop: 4 } },
          h('button', { className: 'dra-btn primary', disabled: busy, onClick: function () { submit('hub') } }, busy ? '写入中…' : '确认，写入配置'),
          h('button', { className: 'dra-btn', onClick: function () { setStep('choose') } }, '返回'),
          switching ? h('button', { className: 'dra-btn', onClick: props.onCancel }, '取消') : null,
        ),
        h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '写盘会先备份并校验；重启 DSH 后生效。'),
      )
    }

    /* ───────────────────────────── 面板主体 ───────────────────────────── */
    /* 机器人屏：按机器分组，机器名 + 在线/离线，每个机器人 name · role · model。 */
    function rosterView(av, ui) {
      if (!av) return h('p', null, '读取中…')
      if (av.kind === 'empty') return h('p', null, '还没有机器人上报')
      if (av.kind === 'error') return h('p', { className: 'dra-warn' }, '读机器人列表失败 ' + (av.reason || av.status))
      return h('div', { className: 'dra-col' }, av.nodes.map(function (n) {
        return h('div', { key: String(n.nodeId), className: 'dra-col' },
          h('div', { className: 'dra-mono' }, String(n.hostname || n.nodeId) + ' · ' + (n.online ? '在线' : '离线（最后一次名册）')),
          (n.bots || []).map(function (b) {
            return h('div', { key: String(b.id), className: 'dra-row' },
              h('span', { className: 'dra-hint' },
                String(b.name || b.id) + ' · ' + String(b.role || '') + ' · ' + String(b.model || '')),
              ui && ui.onOpen ? h('button', { className: 'dra-btn', onClick: function () { ui.onOpen(n, b) } }, '对话') : null,
              ui && ui.onEdit ? h('button', { className: 'dra-btn', onClick: function () { ui.onEdit(n, b) } }, '编辑') : null)
          }))
      }))
    }

    /* 模型屏：按机器分组，机器名 + 在线/离线；每个模型 name (id)，默认标「默认」，思考等级一行。 */
    function modelsView(av) {
      if (!av) return h('p', null, '读取中…')
      if (av.kind === 'empty') return h('p', null, '还没有电脑上报模型')
      if (av.kind === 'error') return h('p', { className: 'dra-warn' }, '读模型列表失败 ' + (av.reason || av.status))
      const none = av.nodes.every(function (n) { return !Array.isArray(n.models) || n.models.length === 0 })
      return h('div', { className: 'dra-col' },
        none ? h('p', null, '所有电脑都没有可用模型') : null,
        av.nodes.map(function (n) {
          const models = Array.isArray(n.models) ? n.models : null
          return h('div', { key: String(n.nodeId), className: 'dra-col' },
            h('div', { className: 'dra-mono' }, String(n.hostname || n.nodeId) + ' · ' + (n.online ? '在线' : '离线')),
            models === null ? h('p', { className: 'dra-hint' }, '尚未上报模型')
              : models.length === 0 ? h('p', { className: 'dra-hint' }, '没有可用模型')
              : models.map(function (m) {
                const isDefault = n.defaultModel != null && m.id === n.defaultModel
                const efforts = Array.isArray(m.efforts) ? m.efforts.map(function (e) { return String(e.id) }).join(' / ') : ''
                return h('div', { key: String(m.id), className: 'dra-row' },
                  h('span', { className: 'dra-mono' + (isDefault ? ' dra-hl' : '') }, String(m.name || m.id) + ' (' + String(m.id) + ')'),
                  isDefault ? h('span', { className: 'dra-hint' }, '默认') : null,
                  h('span', { className: 'dra-hint' }, efforts === '' ? '无思考等级' : '思考等级：' + efforts))
              }))
        }))
    }

    /* 机器人表单：创建 / 编辑共用。纯渲染；失败原文照显，值保留以便重试。 */
    function botFormView(ui) {
      const f = ui.form
      const editing = !!f.botId
      const nodes = (ui.nodes || []).filter(function (n) { return n.online })
      const set = function (k) { return function (e) { const p = {}; p[k] = e.target.value; ui.onChange(p) } }
      return h('div', { className: 'dra-col dra-botform' },
        h('div', { className: 'dra-mono' }, editing ? '编辑机器人 ' + f.botId : '创建机器人'),
        h('select', { className: 'dra-select', value: f.nodeId, disabled: editing, onChange: set('nodeId') },
          h('option', { value: '' }, '选择在线电脑…'),
          nodes.map(function (n) { return h('option', { key: String(n.nodeId), value: String(n.nodeId) }, String(n.hostname || n.nodeId)) })),
        h('input', { className: 'dra-input', placeholder: '名称（必填，≤40）', value: f.name, onChange: set('name') }),
        h('input', { className: 'dra-input', placeholder: '角色（≤24）', value: f.role, onChange: set('role') }),
        h('input', { className: 'dra-input', placeholder: '模型（provider/model）', value: f.modelRef, onChange: set('modelRef') }),
        h('input', { className: 'dra-input', placeholder: '工作目录', value: f.workDir, onChange: set('workDir') }),
        h('textarea', { className: 'dra-textarea', rows: 4, placeholder: '指令', value: f.instructions, onChange: set('instructions') }),
        h('div', { className: 'dra-row' },
          h('button', { className: 'dra-btn dra-btn-primary', disabled: ui.busy, onClick: ui.onSubmit }, ui.busy ? '提交中…' : (editing ? '保存' : '创建')),
          editing ? h('button', { className: 'dra-btn', onClick: ui.onCancel }, '取消编辑') : null),
        ui.note ? h('div', { className: ui.noteOk ? 'dra-hint' : 'dra-warn' }, ui.note) : null)
    }

    /* Bot 详情：该 Bot 自己的会话历史 + 发送框。纯渲染；状态与轮询在 Panel 里。 */
    function botChatView(ui) {
      const hist = ui.history
      const roleLabel = function (r) { return r === 'user' ? '我' : r === 'assistant' ? 'Bot' : String(r || '?') }
      return h('div', { className: 'dra-col dra-botchat' },
        h('div', { className: 'dra-row' },
          h('button', { className: 'dra-btn', onClick: ui.onBack }, '返回'),
          h('span', { className: 'dra-mono' }, String(ui.bot.name || ui.bot.id) + ' @ ' + String(ui.node.hostname || ui.node.nodeId)),
          h('button', { className: 'dra-btn', onClick: ui.onEdit }, '编辑')),
        hist.state === 'loading' ? h('p', null, '加载中…')
          : hist.state === 'error' ? h('p', { className: 'dra-warn' }, '读取失败：' + String(hist.error || 'unknown'))
          : hist.items.length === 0 ? h('p', { className: 'dra-hint' }, '没有对话')
          : h('div', { className: 'dra-col' }, hist.items.map(function (it, i) {
            return h('div', { key: i, className: 'dra-hint' }, roleLabel(it && it.role) + '：' + String((it && (it.text != null ? it.text : it.content)) || ''))
          })),
        ui.turn.state === 'running' ? h('p', { className: 'dra-hint' }, '运行中…') : null,
        ui.turn.state === 'failed' ? h('p', { className: 'dra-warn' }, '失败：' + String(ui.turn.error || 'unknown')) : null,
        ui.turn.state === 'timeout' ? h('p', { className: 'dra-warn' }, '等待超时，结果未返回') : null,
        ui.turn.state === 'done' ? h('p', { className: 'dra-hint' }, 'Bot 回答：' + String(ui.turn.text || '')) : null,
        h('textarea', { className: 'dra-textarea', rows: 3, placeholder: '发给这个 Bot…', value: ui.draft, onChange: function (e) { ui.onDraft(e.target.value) } }),
        h('div', { className: 'dra-row' },
          h('button', { className: 'dra-btn dra-btn-primary', disabled: ui.turn.state === 'running' || String(ui.draft).trim() === '', onClick: ui.onSend },
            ui.turn.state === 'running' ? '运行中…' : '发送')))
    }

    /* 表单的节点下拉 = 名册节点 ∪ 电脑屏（/overview 的 state.nodes）已知在线、但名册里还没有的节点。
     * 后者 bots 为空数组（“还没有机器人”），可选，这样新节点上的第一个 Bot 才建得出来。
     * 名册没采到（empty/error）不等于“没有电脑”；离线节点不会被补进来。不另起轮询，复用现有 overview 数据。 */
    function botNodes(av, overviewNodes) {
      const roster = av && av.kind === 'data' ? av.nodes : []
      const seen = new Set(roster.map(function (n) { return String(n.nodeId) }))
      const extra = (Array.isArray(overviewNodes) ? overviewNodes : []).filter(function (n) {
        return n && n.online === true && n.nodeId != null && !seen.has(String(n.nodeId))
      }).map(function (n) {
        return { nodeId: String(n.nodeId), hostname: n.hostname || String(n.nodeId), online: true, bots: [] }
      })
      return roster.concat(extra)
    }

    function availabilityView(av, emptyText, errorText) {
      if (!av) return h('p', null, '读取中…')
      if (av.kind === 'empty') return h('p', null, emptyText)
      return h('p', { className: 'dra-warn' }, errorText + ' ' + av.status)
    }

    function Panel() {
      /* 全部状态集中在顶部 —— 任何条件 return 之前（fork.14 白板根因）。 */
      const [state, setState] = React.useState({
        loading: true, error: '', mode: '', role: '', nodes: [], tasks: [],
        counts: null, caps: null, connection: null, worker: null, setup: null, transportSummary: null, topology: null, discovery: null,
      })
      const [tick, setTick] = React.useState(0)
      const [pollTick, setPollTick] = React.useState(0)
      const [selected, setSelected] = React.useState('')
      const [detail, setDetail] = React.useState(null)
      const [detailLoading, setDetailLoading] = React.useState(false)
      const [form, setForm] = React.useState({
        goal: '', node: '', mode: 'agent', workspace: '', model: '',
        outputs: '', timeoutMs: '', needApproval: false, templateId: '',
      })
      const [modelCustom, setModelCustom] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [cancelNote, setCancelNote] = React.useState('')
      const [autoRefresh, setAutoRefresh] = React.useState(true)
      const [theme, setTheme] = React.useState(function () {
        let saved = null
        let host = null
        let prefersDark = null
        try { saved = localStorage.getItem('dra-theme') } catch (e) { saved = null }
        try { host = document.documentElement.getAttribute('data-theme') } catch (e) { host = null }
        try { prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches === true } catch (e) { prefersDark = null }
        return themeResolve({ saved: saved, host: host, prefersDark: prefersDark })
      })
      const [cfg, setCfg] = React.useState(null)
      const [cfgEdit, setCfgEdit] = React.useState({})
      const [envCheck, setEnvCheck] = React.useState(null)
      const [sshHosts, setSshHosts] = React.useState([])
      const [sshHostsErr, setSshHostsErr] = React.useState('')
      const [sshProbeResult, setSshProbeResult] = React.useState({})
      const [sshProbeBusy, setSshProbeBusy] = React.useState({})
      const [sshDeployJob, setSshDeployJob] = React.useState({})
      const [sshDeployBusy, setSshDeployBusy] = React.useState({})
      const [sshInstallBusy, setSshInstallBusy] = React.useState({})
      const [sshInstallErr, setSshInstallErr] = React.useState({})
      const [quickRelay, setQuickRelay] = React.useState({ busy: false, err: '', done: false })
      const [envBusy, setEnvBusy] = React.useState(false)
      const [fixPlan, setFixPlan] = React.useState(null)
      const [fixBusy, setFixBusy] = React.useState(false)
      const [fixMsg, setFixMsg] = React.useState('')
      const [tools, setTools] = React.useState(null)
      const [toolsBusy, setToolsBusy] = React.useState(false)
      const [taskFilter, setTaskFilter] = React.useState('all')
      const [purgeBusy, setPurgeBusy] = React.useState(false)
      const [switchRole, setSwitchRole] = React.useState(false)
      const [enroll, setEnroll] = React.useState({ loading: false, data: null, error: '' })
      /* 模板库：只在自己的 effect 里拉，不进 4 秒轮询（否则正在编辑的下拉框会被重建）。 */
      const [tpl, setTpl] = React.useState({ loading: true, list: [], max: 0, degraded: false, reason: '', file: '', error: '' })
      const [tplMsg, setTplMsg] = React.useState('')
      const [pair, setPair] = React.useState(null)
      const [pairNote, setPairNote] = React.useState('')
      const autoChecked = React.useRef(false)
      const autoRef = React.useRef(true)
      const kickRef = React.useRef(true)
      const inflight = React.useRef(false)
      const roleOverride = React.useRef('')
      const [screenData, setScreenData] = React.useState({ bots: null, models: null })
      /* 记忆屏：选中的范围 / 输入框只存在这里，轮询刷新不会重置它们。 */
      const [memScope, setMemScope] = React.useState(JSON.stringify({ kind: 'team' }))
      const [memScopes, setMemScopes] = React.useState({ state: 'loading', data: null, reason: '' })
      const [memView, setMemView] = React.useState({ state: 'loading', data: null, reason: '' })
      const [memDraft, setMemDraft] = React.useState('')
      const [memTopic, setMemTopic] = React.useState('')
      const [memBusy, setMemBusy] = React.useState(false)
      const [memNote, setMemNote] = React.useState('')
      const memSeq = React.useRef(0)
      const memViewInflight = React.useRef(false)
      const memScopesInflight = React.useRef(false)
      const botsInflight = React.useRef(false)
      const modelsInflight = React.useRef(false)
      const BOT_FORM0 = { nodeId: '', botId: '', name: '', role: '', modelRef: '', workDir: '', instructions: '' }
      const [botForm, setBotForm] = React.useState(BOT_FORM0)
      const [botBusy, setBotBusy] = React.useState(false)
      /* 打开的 Bot 只存 {nodeId, botId}；名册 8 秒刷新不会重置它。 */
      const [openBot, setOpenBot] = React.useState(null)
      const [botHist, setBotHist] = React.useState({ state: 'loading', items: [], error: '' })
      const [botTurn, setBotTurn] = React.useState({ state: 'idle', text: '', error: '' })
      const [botDraft, setBotDraft] = React.useState('')
      const botTurnRun = React.useRef(0)
      const [botNote, setBotNote] = React.useState({ text: '', ok: false })
      const activeScreen = selectHubScreen(state)
      React.useEffect(function () {
        function store(name, p, project) {
          const proj = project || screenAvailability
          p.then(function (body) {
            const patch = {}; patch[name] = proj(body, 200)
            setScreenData(function (prev) { return Object.assign({}, prev, patch) })
          }).catch(function (e) {
            const patch = {}; patch[name] = proj(e && e.body, (e && e.status) || 0)
            setScreenData(function (prev) { return Object.assign({}, prev, patch) })
          })
        }
        if (activeScreen === 'bots' && !botsInflight.current) {
          botsInflight.current = true
          store('bots', apiGet('/bots').then(
            function (b) { botsInflight.current = false; return b },
            function (e) { botsInflight.current = false; throw e }
          ))
        }
        if (activeScreen === 'models' && !modelsInflight.current) {
          modelsInflight.current = true
          store('models', apiGet('/models').then(
            function (b) { modelsInflight.current = false; return b },
            function (e) { modelsInflight.current = false; throw e }
          ), modelsAvailability)
        }
      }, [activeScreen, pollTick, tick])

      /* 记忆屏：每次轮询刷新当前范围（in-flight 守卫）；换范围 / 写入后用 memSeq 丢弃过期回包。 */
      function memFail(setter, e) {
        setter({ state: e && e.missing ? 'missing' : 'error', data: null, reason: String((e && e.reason) || (e && e.message) || 'unknown') })
      }
      function memScopeObj() { try { return JSON.parse(memScope) } catch (e) { return { kind: 'team' } } }
      React.useEffect(function () {
        if (activeScreen !== 'memory') return
        if (!memScopesInflight.current) {
          memScopesInflight.current = true
          memoryScopes().then(function (d) { setMemScopes({ state: 'ok', data: d, reason: '' }) }, function (e) { memFail(setMemScopes, e) })
            .then(function () { memScopesInflight.current = false })
        }
        if (!memViewInflight.current) {
          memViewInflight.current = true
          const seq = memSeq.current
          memoryView(memScopeObj()).then(function (v) {
            if (seq === memSeq.current) setMemView({ state: 'ok', data: v, reason: '' })
          }, function (e) {
            if (seq === memSeq.current) memFail(setMemView, e)
          }).then(function () { memViewInflight.current = false })
        }
      }, [activeScreen, pollTick, tick, memScope])

      function memMutate(run) {
        memSeq.current += 1
        setMemBusy(true); setMemNote('')
        run().then(function (v) {
          setMemView({ state: 'ok', data: v, reason: '' })
        }, function (e) {
          setMemNote('写记忆失败：' + String((e && e.reason) || (e && e.message) || 'unknown'))
        }).then(function () { setMemBusy(false) })
      }
      function memAdd() {
        const text = String(memDraft).trim()
        if (text === '') return
        memMutate(function () {
          return memoryAdd(memScopeObj(), text, String(memTopic).trim()).then(function (v) { setMemDraft(''); return v })
        })
      }
      function memForget(row) {
        memMutate(function () { return memoryForget(memScopeObj(), row.text, row.topic) })
      }
      function memPickScope(v) {
        memSeq.current += 1
        memViewInflight.current = false
        setMemView({ state: 'loading', data: null, reason: '' })
        setMemNote('')
        setMemScope(v)
      }

      const setF = function (patch) {
        setForm(function (prev) {
          const next = {}
          Object.keys(prev).forEach(function (k) { next[k] = prev[k] })
          Object.keys(patch).forEach(function (k) { next[k] = patch[k] })
          return next
        })
      }

      function computeCounts(tasks, ov) {
        const list = tasks || []
        const nodes = state.nodes || []
        const done = list.filter(function (t) { return t.status === 'completed' }).length
        const failed = list.filter(function (t) { return t.status === 'failed' || t.status === 'aborted' || t.status === 'rejected' }).length
        const active = list.filter(function (t) { return ACTIVE_STATUSES.indexOf(t.status) >= 0 }).length
        const online = ov && ov.online != null
          ? ov.online
          : nodes.filter(function (n) { return n.online === true }).length
        return {
          nodes: ov && ov.nodes != null ? ov.nodes : nodes.length,
          online: online,
          tasks: list.length,
          running: ov && ov.running != null ? ov.running : active,
          active: active,
          done: done,
          failed: failed,
        }
      }

      function loadPair() {
        const port = (window.location && window.location.port) || ''
        apiGet('/pair-info?port=' + encodeURIComponent(port))
          .then(function (d) {
            setPair(d || null)
            setPairNote(d && d.ok === false ? (d.message || d.code || '配对码读取失败') : '')
          })
          .catch(function (e) { setPairNote('配对码读取失败：' + ((e && e.message) || e)) })
      }

      function autoConfigRelayFromProbe(alias, afterCb) {
        // 从已探测到的 SSH 主机中找中继节点，自动写入 hub 的中继配置
        var relayHost = null
        for (var a in sshProbeResult) {
          var p = sshProbeResult[a]
          if (p && p.isRelay && p.relayUrl) { relayHost = p; break }
        }
        if (!relayHost) {
          window.alert('未在已探测的主机中发现中继服务（8890端口）。请先点「环境检测」找到运行中继的主机，再上桥。')
          return
        }
        setQuickRelay(function (q) { return Object.assign({}, q, { busy: true, err: '', done: false }) })
        apiPost('/relay-autoconfig', {
          relayUrl: relayHost.relayUrl, autoHubToken: relayHost.relayHubToken || '',
        })
          .then(function () {
            setQuickRelay(function (q) { return Object.assign({}, q, { busy: false, done: true, err: '' }) })
            apiGet('/config').then(function (d) {
              setCfg(d && d.config ? d.config : null)
              if (afterCb) afterCb()
            }).catch(function () { if (afterCb) afterCb() })
          })
          .catch(function (e) { setQuickRelay(function (q) { return Object.assign({}, q, { busy: false, err: String((e && e.message) || e) }) }) })
      }
      function loadSshHosts() {
        apiGet('/ssh-hosts').then(function (d) {
          setSshHosts((d && d.hosts) || [])
          setSshHostsErr('')
        }).catch(function (e) {
          setSshHosts([])
          setSshHostsErr(String((e && e.message) || e))
        })
      }
      function runSshProbe(alias) {
        setSshProbeBusy(function (p) { const n = Object.assign({}, p); n[alias] = true; return n })
        apiPost('/ssh-probe', { alias: alias }).then(function (d) {
          setSshProbeResult(function (p) { const n = Object.assign({}, p); n[alias] = d; return n })
        }).catch(function (e) {
          setSshProbeResult(function (p) { const n = Object.assign({}, p); n[alias] = { ok: false, error: String((e && e.message) || e) }; return n })
        }).finally(function () {
          setSshProbeBusy(function (p) { const n = Object.assign({}, p); n[alias] = false; return n })
        })
      }
      function runSshDeploy(alias) {
        var curRelayUrl = (cfg && cfg.relayUrl) ? cfg.relayUrl : ((cfg && cfg.relay && cfg.relay.url) ? cfg.relay.url : '')
        var curRelayTokenSet = !!(cfg && cfg.relayTokenSet)
        if (!curRelayUrl.trim() || !curRelayTokenSet) {
          // Relay not configured — auto-detect from probe results and configure
          autoConfigRelayFromProbe(alias, function () {
            // After auto-config, re-check and proceed if ready
            var newRelayUrl = ''
            apiGet('/config').then(function (d) {
              var nc = d && d.config ? d.config : null
              setCfg(nc)
              var nUrl = nc && nc.relayUrl ? nc.relayUrl : (nc && nc.relay && nc.relay.url ? nc.relay.url : '')
              var nTokenSet = !!(nc && nc.relayTokenSet)
              if (nUrl && nTokenSet) {
                doDeploy(alias)
              } else {
                window.alert('自动配置中继后仍缺少 HubToken，请在配置区手动设置 Hub Token')
              }
            }).catch(function () {})
          })
          return
        }
        doDeploy(alias)
      }
      function doDeploy(alias) {
        setSshDeployBusy(function (p) { const n = Object.assign({}, p); n[alias] = true; return n })
        apiPost('/ssh-deploy', { alias: alias }).then(function (d) {
          const jobId = d && d.jobId
          if (!jobId) return
          setSshDeployJob(function (p) { const n = Object.assign({}, p); n[alias] = { jobId: jobId, steps: [], done: false }; return n })
          function pollJob() {
            apiGet('/ssh-deploy?id=' + jobId).then(function (j) {
              const jobData = j && j.job ? j.job : j
              setSshDeployJob(function (p) { const n = Object.assign({}, p); n[alias] = jobData; return n })
              if (!['done', 'failed'].includes(jobData && jobData.status)) setTimeout(pollJob, 1500)
              else setSshDeployBusy(function (p) { const n = Object.assign({}, p); n[alias] = false; return n })
            }).catch(function () {
              setSshDeployBusy(function (p) { const n = Object.assign({}, p); n[alias] = false; return n })
            })
          }
          setTimeout(pollJob, 800)
        }).catch(function (e) {
          setSshDeployJob(function (p) { const n = Object.assign({}, p); n[alias] = { done: true, error: String((e && e.message) || e), steps: [] }; return n })
          setSshDeployBusy(function (p) { const n = Object.assign({}, p); n[alias] = false; return n })
        })
      }
      function runInstallRuntime(alias) {
        if (!window.confirm('将在 ' + alias + ' 上安装 Node.js LTS + dsh 0.2.2-rc.1，操作耗时约 1-3 分钟，继续？')) return
        setSshInstallBusy(function (p) { const n = Object.assign({}, p); n[alias] = true; return n })
        setSshInstallErr(function (p) { const n = Object.assign({}, p); n[alias] = ''; return n })
        apiPost('/ssh-deploy/install-runtime', { alias: alias, confirm: 'yes' }).then(function (d) {
          setSshInstallBusy(function (p) { const n = Object.assign({}, p); n[alias] = false; return n })
          if (d && d.ok) {
            runSshProbe(alias)
          } else {
            setSshInstallErr(function (p) { const n = Object.assign({}, p); n[alias] = (d && d.error) ? String(d.error) : '安装失败'; return n })
          }
        }).catch(function (e) {
          setSshInstallBusy(function (p) { const n = Object.assign({}, p); n[alias] = false; return n })
          setSshInstallErr(function (p) { const n = Object.assign({}, p); n[alias] = String((e && e.message) || e); return n })
        })
      }
      function runEnvCheck() {
        setEnvBusy(true)
        apiGet('/env-check')
          .then(function (d) { setEnvCheck(d || null) })
          .catch(function (e) { setEnvCheck({ ok: false, items: [], failed: 1, error: String((e && e.message) || e) }) })
          .then(function () { setEnvBusy(false) })
      }

      function afterHub(ov, tk) {
        const tasks = tk && Array.isArray(tk.tasks) ? tk.tasks : []
        setState(function (prev) {
          const next = {}
          Object.keys(prev).forEach(function (k) { next[k] = prev[k] })
          next.loading = false
          next.error = ''
          next.mode = 'hub'
          next.nodes = ov && Array.isArray(ov.nodes) ? ov.nodes : []
          next.transportSummary = ov && ov.transportSummary ? ov.transportSummary : null
          next.topology = ov && ov.topology ? ov.topology : null
          next.tasks = tasks
          next.counts = computeCounts(tasks, ov && ov.counts ? ov.counts : null)
          next.caps = ov && ov.capabilities ? ov.capabilities : null
          next.connection = ov && ov.connection ? ov.connection : null
          next.relay = ov && ov.relay ? ov.relay : null
          next.discovery = ov && ov.discovery ? ov.discovery : null
          next.worker = null
          next.setup = null
          return next
        })
        apiGet('/config').then(function (d) { setCfg(d && d.config ? d.config : null) }).catch(function () {})
        loadPair()
        if (!autoChecked.current) {
          autoChecked.current = true
          runEnvCheck()
          loadSshHosts()
        }
      }

      function savedRoleFrom(setup) {
        if (!setup) return ''
        var cur = setup.current ? setup.current : {}
        var role = String(setup.effectiveRole || cur.role || '').trim().toLowerCase()
        if (role === 'hub' || role === 'worker' || role === 'both') return role
        if (setup.configured === false) return ''
        return 'hub'
      }

      function loadWorker() {
        return apiGetPath(STATUS_PATH)
          .then(function (d) {
            setState(function (prev) {
              return Object.assign({}, prev, { loading: false, error: '', mode: 'worker', worker: d || null, role: 'worker' })
            })
            apiGetPath(SETUP_STATE_PATH).then(function (d) {
              var cur = d && d.current ? d.current : {}
              setCfg({
                transportMode: cur.transportMode || 'relay',
                hubUrl: cur.hubUrl || '',
                relayUrl: cur.relayUrl || '',
                relayTokenSet: cur.tokenSet === true,
                nodeTokenSet: cur.tokenSet === true,
                role: cur.role || 'worker',
              })
            }).catch(function () {})
          })
          .catch(function (err) {
            setState(function (prev) {
              return Object.assign({}, prev, { loading: false, error: String((err && err.message) || err), mode: 'worker', role: 'worker' })
            })
          })
      }

      function loadHub(role) {
        var saved = role === 'both' ? 'both' : 'hub'
        return apiGet('/overview')
          .then(function (ov) {
            return Promise.all([
              apiGet('/tasks'),
              apiGet('/node-status').catch(function () { return null }),
              apiGet('/tickets').catch(function () { return null }),
            ]).then(function (results) {
              const tk = results[0]
              const status = results[1]
              const tickets = results[2]?.tickets
              if (ov && Array.isArray(ov.nodes) && status && Array.isArray(status.nodes)) {
                const byId = new Map(status.nodes.map(function (n) { return [n.nodeId, n] }))
                ov = Object.assign({}, ov, { nodes: ov.nodes.map(function (n) {
                  const row = byId.get(n.nodeId)
                  if (!row) return n
                  const merged = Object.assign({}, n)
                  ;['resource', 'connectivity', 'queue', 'silentMs', 'stale', 'thresholdMs'].forEach(function (key) {
                    if (Object.prototype.hasOwnProperty.call(row, key)) merged[key] = row[key]
                  })
                  return merged
                }) })
              }
              afterHub(ov, tk)
              setState(function (prev) {
                return Object.assign({}, prev, { mode: saved, role: saved, tickets: Array.isArray(tickets) ? tickets : undefined })
              })
              if (saved === 'both') {
                return apiGetPath(STATUS_PATH).then(function (d) {
                  setState(function (prev) { return Object.assign({}, prev, { worker: d || null, mode: 'both', role: 'both' }) })
                }).catch(function () {})
              }
            })
          })
          .catch(function (err) {
            var failed = selectRuntimeView(saved, { overviewOk: false, overviewError: String((err && err.message) || err) })
            setState(function (prev) {
              return Object.assign({}, prev, {
                loading: false,
                error: failed.error || String((err && err.message) || err),
                mode: saved,
                role: saved,
                tickets: undefined,
              })
            })
          })
      }

      function load() {
        if (!autoRef.current && !kickRef.current) return
        kickRef.current = false
        if (inflight.current) return
        inflight.current = true
        const done = function () { inflight.current = false }
        apiGetPath(SETUP_STATE_PATH)
          .then(function (setup) {
            var remembered = roleOverride.current
            var role = remembered || savedRoleFrom(setup)
            if (!role) {
              setState(function (prev) {
                return Object.assign({}, prev, { loading: false, error: '', mode: 'setup', role: '', setup: setup || null })
              })
              return
            }
            if (remembered && savedRoleFrom(setup) === remembered) roleOverride.current = ''
            var plan = selectRuntimeView(role, { overviewOk: true })
            setState(function (prev) { return Object.assign({}, prev, { role: role, setup: setup || null }) })
            if (plan.view === 'worker') return loadWorker()
            return loadHub(role)
          })
          .catch(function (err) {
            setState(function (prev) {
              return Object.assign({}, prev, { loading: false, error: String((err && err.message) || err) })
            })
          })
          .then(done)
      }

      React.useEffect(function () {
        let disposed = false
        load()
        const timer = setInterval(function () {
          if (!shouldPoll(typeof document !== 'undefined' ? document : undefined)) return
          load()
          setPollTick(function (t) { return t + 1 })
        }, POLL_MS)
        return function () {
          disposed = true
          clearInterval(timer)
        }
      }, [setState, state.mode, tick])

      React.useEffect(function () {
        if (!selected) {
          setDetail(null)
          return undefined
        }
        let gone = false
        setDetailLoading(true)
        apiGet('/task?taskId=' + encodeURIComponent(selected))
          .then(function (d) { if (!gone) setDetail(d || null) })
          .catch(function (e) { if (!gone) setDetail({ error: { message: String((e && e.message) || e) } }) })
          .then(function () { if (!gone) setDetailLoading(false) })
        return function () { gone = true }
      }, [selected, tick])

      function loadTemplates() {
        return apiGet('/templates')
          .then(function (d) {
            setTpl({
              loading: false,
              list: (d && d.templates) || [],
              max: (d && d.max) || 0,
              degraded: !!(d && d.degraded),
              reason: (d && d.reason) || '',
              file: (d && d.file) || '',
              error: '',
            })
            return d
          })
          .catch(function (err) {
            setTpl(function (t) { return Object.assign({}, t, { loading: false, error: String((err && err.message) || err) }) })
            return null
          })
      }

      React.useEffect(function () {
        let disposed = false
        apiGet('/templates')
          .then(function (d) {
            if (disposed) return
            setTpl({
              loading: false,
              list: (d && d.templates) || [],
              max: (d && d.max) || 0,
              degraded: !!(d && d.degraded),
              reason: (d && d.reason) || '',
              file: (d && d.file) || '',
              error: '',
            })
          })
          .catch(function (err) {
            if (disposed) return
            setTpl(function (t) { return Object.assign({}, t, { loading: false, error: String((err && err.message) || err) }) })
          })
        return function () { disposed = true }
      }, [setTpl])

      function applyTemplate(id) {
        const t = (tpl.list || []).filter(function (x) { return x.id === id })[0]
        setTplMsg('')
        if (!t) {
          setForm(function (f) { const n = Object.assign({}, f); n.templateId = ''; return n })
          return
        }
        const m = t.model
        const modelStr = !m ? '' : (m.provider ? (m.provider + '/' + (m.model || '')) : (m.model || ''))
        setForm(function (f) {
          const n = Object.assign({}, f)
          n.templateId = t.id
          n.goal = t.goal || ''
          n.mode = t.mode === 'exec' ? 'exec' : 'agent'
          n.workspace = t.workspace || ''
          n.model = modelStr
          n.outputs = (t.outputs || []).join(', ')
          n.timeoutMs = t.timeoutMs ? String(t.timeoutMs) : ''
          return n
        })
        setTplMsg('已填充模板「' + t.name + '」')
      }

      function saveTemplate() {
        if (!form.goal.trim()) { setTplMsg('先填任务目标，再存为模板'); return }
        const suggested = form.goal.trim().split('\n')[0].slice(0, 30)
        const name = window.prompt('模板名（之后在下拉框里选它）', suggested)
        if (name === null) return
        const trimmed = String(name).trim()
        if (trimmed === '') { setTplMsg('模板名不能为空'); return }
        const outputs = String(form.outputs || '').split(/[, \n]+/).map(function (s) { return s.trim() }).filter(Boolean)
        const body = { name: trimmed, goal: form.goal.trim(), mode: form.mode === 'exec' ? 'exec' : 'agent' }
        if (form.workspace.trim()) body.workspace = form.workspace.trim()
        if (form.model.trim()) body.model = form.model.trim()
        if (outputs.length) body.outputs = outputs
        const tmo = Number(form.timeoutMs)
        if (String(form.timeoutMs || '').trim() !== '' && Number.isFinite(tmo)) body.timeoutMs = tmo
        if (form.templateId) body.id = form.templateId
        setTplMsg('保存中…')
        apiPost('/templates/save', body)
          .then(function (r) {
            const t = (r && r.template) || {}
            setForm(function (f) { const n = Object.assign({}, f); n.templateId = t.id || ''; return n })
            setTplMsg(r && r.updated ? ('已更新模板「' + (t.name || '') + '」') : ('已保存模板「' + (t.name || '') + '」'))
            return loadTemplates()
          })
          .catch(function (err) { setTplMsg('保存失败：' + ((err && err.message) || err)) })
      }

      function deleteTemplate() {
        const id = form.templateId
        if (!id) { setTplMsg('先在下拉框里选中一条模板'); return }
        const t = (tpl.list || []).filter(function (x) { return x.id === id })[0]
        if (!window.confirm('删除模板「' + ((t && t.name) || id) + '」？只删这条预设，不影响已派出的任务。')) return
        setTplMsg('删除中…')
        apiPost('/templates/delete', { id: id })
          .then(function () {
            setForm(function (f) { const n = Object.assign({}, f); n.templateId = ''; return n })
            setTplMsg('已删除模板')
            return loadTemplates()
          })
          .catch(function (err) { setTplMsg('删除失败：' + ((err && err.message) || err)) })
      }

      /* mode 切换后让轮询立即重跑。 */
      function switchMode(m) {
        kickRef.current = true
        setState(function (prev) {
          const next = {}
          Object.keys(prev).forEach(function (k) { next[k] = prev[k] })
          next.mode = m
          next.error = ''
          next.loading = true
          return next
        })
        setTick(function (t) { return t + 1 })
      }

      function refresh() {
        kickRef.current = true
        setTick(function (t) { return t + 1 })
      }

      function dispatch() {
        const fv = form
        if (!fv.goal.trim()) { setNote('先填写任务目标'); return }
        const outputs = String(fv.outputs || '').split(/[, \n]+/).map(function (s) { return s.trim() }).filter(Boolean)
        // 超时：空 / 非数字一律不传，让服务端用 defaults.timeoutMs。
        const tmo = Number(fv.timeoutMs)
        const timeoutMs = fv.timeoutMs.trim() !== '' && Number.isFinite(tmo) && tmo > 0 ? tmo : undefined
        const body = {
          goal: fv.goal.trim(),
          node: fv.node || undefined,
          mode: fv.mode || 'agent',
          workspace: fv.workspace.trim() || undefined,
          model: fv.model || undefined,
          outputs: outputs.length ? outputs : undefined,
          timeoutMs: timeoutMs,
          approval: fv.needApproval ? 'manual' : undefined,
        }
        setBusy(true)
        setNote('')
        apiPost('/dispatch', body)
          .then(function (d) {
            setNote('已派发给 ' + shortId(d && d.nodeId) + '（' + shortId(d && d.taskId) + '）')
            setF({ goal: '' })
            refresh()
          })
          .catch(function (e) { setNote('派发失败：' + ((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      /* 读该 Bot 在其节点上的会话历史（oldest→newest 由节点保证）。 */
      function loadBotHistory(ob) {
        setBotHist(function (p) { return { state: 'loading', items: p.items, error: '' } })
        apiGet('/bots/history?nodeId=' + encodeURIComponent(ob.nodeId) + '&botId=' + encodeURIComponent(ob.botId))
          .then(function (d) { return d }, function (e) { return (e && e.body) || { ok: false, error: String((e && e.message) || e) } })
          .then(function (d) {
            if (d && d.ok === true) setBotHist({ state: 'ready', items: Array.isArray(d.items) ? d.items : [], error: '' })
            else setBotHist({ state: 'error', items: [], error: String((d && d.error) || 'unknown') })
          })
      }
      function openBotChat(n, b) {
        const ob = { nodeId: String(n.nodeId), botId: String(b.id) }
        botTurnRun.current += 1
        setOpenBot(ob); setBotTurn({ state: 'idle', text: '', error: '' }); setBotDraft('')
        loadBotHistory(ob)
      }
      function closeBotChat() { botTurnRun.current += 1; setOpenBot(null) }
      /* 发送：POST 只拿 exchangeId，然后每 2 秒轮询，最多 5 分钟；结果没回来就保持运行中直到超时。 */
      function sendBotTurn() {
        const ob = openBot
        const text = botDraft
        if (!ob || String(text).trim() === '') return
        const run = ++botTurnRun.current
        setBotTurn({ state: 'running', text: '', error: '' })
        apiPost('/bots/turn', { nodeId: ob.nodeId, botId: ob.botId, text: text })
          .then(function (d) { return d }, function (e) { return (e && e.body) || { ok: false, error: String((e && e.message) || e) } })
          .then(function (d) {
            if (run !== botTurnRun.current) return
            if (!d || d.ok !== true) { setBotTurn({ state: 'failed', text: '', error: String((d && d.error) || 'unknown') }); return }
            setBotDraft('')
            const deadline = Date.now() + 5 * 60 * 1000
            const poll = function () {
              if (run !== botTurnRun.current) return
              if (Date.now() > deadline) { setBotTurn({ state: 'timeout', text: '', error: '' }); return }
              apiGet('/bots/turn?exchangeId=' + encodeURIComponent(d.exchangeId)).then(function (s) {
                if (run !== botTurnRun.current) return
                if (s && s.state === 'done') { setBotTurn({ state: 'done', text: s.text || '', error: '' }); loadBotHistory(ob) }
                else if (s && (s.state === 'failed' || s.state === 'unknown')) {
                  setBotTurn({ state: 'failed', text: '', error: String(s.error || (s.state === 'unknown' ? 'turn-unknown' : 'unknown')) })
                } else setTimeout(poll, 2000)
              }, function () { setTimeout(poll, 2000) })
            }
            setTimeout(poll, 2000)
          })
      }

      /* 创建 / 编辑机器人：回答以节点真实回执为准；成功后只刷新 /bots，不自造名册行。 */
      function submitBot() {
        const f = botForm
        const editing = !!f.botId
        const body = { nodeId: f.nodeId, name: f.name, role: f.role, modelRef: f.modelRef, workDir: f.workDir, instructions: f.instructions }
        if (editing) body.botId = f.botId
        setBotBusy(true)
        setBotNote({ text: '', ok: false })
        apiPost(editing ? '/bots/update' : '/bots/create', body)
          .then(function (d) { return d }, function (e) { return (e && e.body) || { ok: false, error: String((e && e.message) || e) } })
          .then(function (d) {
            if (d && d.ok === true) {
              setBotNote({ text: (editing ? '已保存' : '已创建') + (d.remoteBotId ? '：' + d.remoteBotId : ''), ok: true })
              if (!editing) setBotForm(BOT_FORM0)
              setPollTick(function (x) { return x + 1 })
            } else {
              setBotNote({ text: '失败：' + String((d && d.error) || 'unknown'), ok: false })
            }
          })
          .then(function () { setBotBusy(false) })
      }

      function clearTasks() {
        const label = '清理'
        if (!window.confirm(label + '已结束的历史任务？运行中的任务会保留。')) return
        setPurgeBusy(true)
        apiPost('/purge', { includeActive: false })
          .then(function (d) { setNote('已清理 ' + (d && d.removed != null ? d.removed : '') + ' 条历史任务（运行中的保留）'); refresh() })
          .catch(function (e) { setNote('清理失败：' + ((e && e.message) || e)) })
          .then(function () { setPurgeBusy(false) })
      }

      function mintEnroll() {
        setEnroll({ loading: true, data: null, error: '' })
        apiPost('/mint-enroll', {})
          .then(function (d) {
            if (!d || typeof d.token !== 'string' || !d.token) throw new Error((d && (d.message || d.error)) || '没有返回口令')
            setEnroll({
              loading: false,
              data: { token: d.token, expiresInMs: d.expiresInMs },
              error: '',
            })
          })
          .catch(function (e) { setEnroll({ loading: false, data: null, error: '铸造失败：' + ((e && e.message) || e) }) })
      }

      function previewFix() {
        setFixBusy(true)
        setFixMsg('')
        apiPost('/fix', { action: 'plan' })
          .then(function (d) { setFixPlan(d || null); if (!d || d.ok === false) setFixMsg((d && (d.message || d.error)) || '读取修复计划失败') })
          .catch(function (e) { setFixMsg('读取修复计划失败：' + ((e && e.message) || e)) })
          .then(function () { setFixBusy(false) })
      }

      function applyFix() {
        setFixBusy(true)
        apiPost('/fix', { action: 'apply', confirm: 'yes' })
          .then(function (d) {
            setFixMsg(d && d.ok === false ? ((d.message || d.error) || '修复失败') : '已应用修复，重启 DSH 生效')
            runEnvCheck()
          })
          .catch(function (e) { setFixMsg('修复失败：' + ((e && e.message) || e)) })
          .then(function () { setFixBusy(false) })
      }

      function probeTools() {
        setToolsBusy(true)
        apiGet('/tools')
          .then(function (d) { setTools(d || null) })
          .catch(function (e) { setTools({ tools: [], missing: [], error: String((e && e.message) || e) }) })
          .then(function () { setToolsBusy(false) })
      }

      function taskAction(taskId, action, path) {
        if (action === 'detail') { setSelected(taskId); return }
        if (action === 'cancel') {
          const beforeTask = tasks.find(function (x) { return x && x.taskId === taskId }) || null
          apiPost('/cancel', { taskId: taskId }).then(function (resp) {
            setCancelNote(cancelReceipt({ response: resp, before: beforeTask }).text)
            refresh()
          }).catch(function (e) { setNote('取消失败：' + ((e && e.message) || e)) })
          return
        }
        if (action === 'approve') {
          apiPost('/approve', { taskId: taskId }).then(function () { refresh() }).catch(function (e) { setNote('批准失败：' + ((e && e.message) || e)) })
          return
        }
        if (action === 'reject') {
          apiPost('/reject', { taskId: taskId }).then(function () { refresh() }).catch(function (e) { setNote('拒绝失败：' + ((e && e.message) || e)) })
          return
        }
        if (action === 'pull') {
          const paths = path ? [path] : finalPathsOf(detail && detail.handoff)
          if (!paths.length) { setNote('该任务没有可拉的 final 产物'); return }
          const dest = window.prompt('拉到本机 uiPullRoot 下的哪个相对子目录？（留空 = 直接放 uiPullRoot）', '')
          apiPost('/pull', { taskId: taskId, paths: paths, dest: dest && dest.trim() ? dest.trim() : undefined })
            .then(function (d) {
              const ok = (d && Array.isArray(d.results) ? d.results : []).filter(function (r) { return r.ok })
              setNote('已拉取 ' + ok.length + '/' + paths.length + ' 个文件到 ' + ((d && d.dest) || '目标目录'))
            })
            .catch(function (e) { setNote('拉取失败：' + ((e && e.message) || e)) })
        }
      }

      function nodeAction(nodeId, action) {
        if (action === 'copy') { copyText(nodeId); setNote('已复制节点 ID'); return }
        if (action === 'purge') {
          apiPost('/purge', { node: nodeId, includeActive: false })
            .then(function (d) { setNote('已清理 ' + shortId(nodeId) + ' 的 ' + ((d && d.removed) || 0) + ' 条历史'); refresh() })
            .catch(function (e) { setNote('清理失败：' + ((e && e.message) || e)) })
          return
        }
        if (action === 'detail') { setSelected(''); setNote('节点 ' + nodeId + '：' + ((state.nodes.filter(function (n) { return n.nodeId === nodeId })[0] || {}).roots || []).join(' · ')) }
      }

      /* ── 派生值 ── */
      const tasks = state.tasks || []
      const nodes = state.nodes || []
      const counts = state.counts || { nodes: 0, online: 0, tasks: 0, running: 0, active: 0, done: 0, failed: 0 }
      const activeTasks = tasks.filter(function (t) { return ACTIVE_STATUSES.indexOf(t.status) >= 0 })
      // themeClass applied by Root wrapper
      const connection = state.connection || null
      const everConnected = connection ? connection.everConnected === true : false
      const connDiag = connection && connection.reachability ? (connection.reachability.hint || '') : ''
      const filteredTasks = taskFilter === 'all'
        ? tasks
        : taskFilter === 'running'
          ? activeTasks
          : taskFilter === 'completed'
            ? tasks.filter(function (t) { return t.status === 'completed' })
            : tasks.filter(function (t) { return t.status === 'failed' || t.status === 'aborted' || t.status === 'rejected' })

      function openSwitch() {
        setSwitchRole(true)
        apiGetPath(SETUP_STATE_PATH).then(function (d) {
          setState(function (prev) { return Object.assign({}, prev, { setup: d || null }) })
        }).catch(function () {})
      }

      function applyWrittenRole(written) {
        var role = written && typeof written.role === 'string' ? written.role.trim().toLowerCase() : ''
        if (role !== 'hub' && role !== 'worker' && role !== 'both') return
        roleOverride.current = role
        setState(function (prev) {
          return Object.assign({}, prev, { role: role, mode: role, loading: true, error: '' })
        })
        kickRef.current = true
        setTick(function (t) { return t + 1 })
      }

      var runtimePlan = selectRuntimeView(state.role || '', {
        overviewOk: state.error === '',
        overviewError: state.error,
        statusError: state.role === 'worker' ? state.error : '',
      })

      /* 已配置后改角色：复用 SetupView（写盘只有一份实现）。 */
      if (switchRole) {
        return h(Root, { theme: theme },
          h(StyleTag),
          h(SetupView, {
            switching: true,
            setup: state.setup,
            onDone: function (written) { setSwitchRole(false); applyWrittenRole(written) },
            onCancel: function () { setSwitchRole(false) },
          }),
        )
      }

      if (state.loading && !state.role && state.mode !== 'setup') {
        return h(Root, { theme: theme },
          h(StyleTag),
          h('div', { className: 'dra-hint' }, '读取本机角色…'),
        )
      }

      /* ── Worker 视图（副机）：只看本机，不显示 hub 专属操作 ── */
      if (runtimePlan.view === 'worker') {
        const w = state.worker || {}
        const wt = w.tasks || {}
        const weak = state.error !== ''
        const workerHint = '任务在主机的「主机面板」上看，本机只负责执行。'
        const workerInfo = [
          ['角色', '副机 Worker'],
          ['节点 ID', w.nodeId || '—'],
          ['连接', w.online === true ? ('在线（' + (w.transportMode === 'direct' ? '直连' : '中继') + '）') : '离线'],
          ['主机地址', w.url || '—'],
          ['执行后端', w.runner || w.agentMode ? (w.runner || 'agent') : '—'],
          ['工作区', Array.isArray(w.roots) && w.roots.length ? w.roots.join('\n') : '—'],
          ['能力', Array.isArray(w.caps) && w.caps.length ? w.caps.join(' · ') : '—'],
          ['任务状态分布', '总数 ' + (wt.total || 0) + ' · 运行 ' + (wt.running || 0) + ' · 排队 ' + (wt.queued || 0) + ' · 活动 ' + (wt.active || 0)],
        ]
        const workerCards = h('div', { className: 'dra-statbar' },
          h('div', { className: 'dra-stat' }, h('div', { className: 'dra-stat-value' }, w.online ? '在线' : '离线'), h('div', { className: 'dra-stat-label' }, '连接状态')),
          h('div', { className: 'dra-stat' }, h('div', { className: 'dra-stat-value' }, String(wt.running || 0)), h('div', { className: 'dra-stat-label' }, '运行中')),
          h('div', { className: 'dra-stat' }, h('div', { className: 'dra-stat-value' }, String(wt.queued || 0)), h('div', { className: 'dra-stat-label' }, '排队中')),
          h('div', { className: 'dra-stat' }, h('div', { className: 'dra-stat-value' }, String(wt.total || 0)), h('div', { className: 'dra-stat-label' }, '任务总数')),
          h('div', { className: 'dra-stat' }, h('div', { className: 'dra-stat-value' }, w.dshVersion || '—'), h('div', { className: 'dra-stat-label' }, 'DSH 版本')),
        )
        /* Worker 也要能改接入配置：relayUrl + enrollToken 可编辑，切换角色复用同一份写盘实现。 */
        const workerCfg = h('div', { className: 'dra-col' },
          h(ConfigPanel, {
            mode: 'worker', cfg: cfg, edit: cfgEdit,
            onEdit: function (k, v) {
              const patch = {}
              patch[k] = v
              setCfgEdit(function (prev) {
                const next = {}
                Object.keys(prev).forEach(function (kk) { next[kk] = prev[kk] })
                Object.keys(patch).forEach(function (kk) { next[kk] = patch[kk] })
                return next
              })
            },
          }),
          h('div', { className: 'dra-row', style: { marginTop: 6 } },
            h('button', { className: 'dra-btn sm', onClick: function () { setSwitchRole(true); openSwitch() } }, '切换角色'),
            h('span', { className: 'dra-hint' }, '改角色或地址复用同一份写盘逻辑'),
          ),
        )
        return h(Root, { theme: theme },
          h(StyleTag),
          h(Toolbar, {
            roleLabel: '副机', autoRefresh: autoRefresh, theme: theme, loading: state.loading,
            onToggleAuto: function (v) { autoRef.current = v; setAutoRefresh(v) },
            onToggleTheme: function () { var next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); try { localStorage.setItem('dra-theme', next) } catch (e) {} },
            onRefresh: refresh,
          }),
          weak ? h('div', { className: 'dra-banner err' },
            h('div', { className: 'dra-banner-title' }, '读不到副机状态'),
            h('div', { className: 'dra-mono dra-wrap' }, state.error),
          ) : null,
          workerCards,
          workerCfg,
          h('div', { className: 'dra-main-grid' },
            h('div', { className: 'dra-col' },
              h(Card, { title: '本机状态', sub: 'Worker 视图' },
                h('dl', { className: 'dra-kv' },
                  workerInfo.map(function (row) {
                    return [h('dt', { key: 'k' + row[0] }, row[0]), h('dd', { key: 'v' + row[0], className: 'dra-wrap' }, row[1])]
                  }),
                ),
                w.lastError ? h('div', { className: 'dra-hint dra-danger', style: { marginTop: 8 } }, '最近错误：' + w.lastError + (w.lastErrorDetail ? ' · ' + w.lastErrorDetail : '')) : null,
              ),
            ),
            h('div', { className: 'dra-col' },
              h(Card, { title: '任务在主机的面板上' },
                h('div', { className: 'dra-hint' }, workerHint + '本机只显示连接与队列计数。'),
                h('div', { className: 'dra-hint', style: { marginTop: 6 } }, '接入地址：' + (w.url || '未连接') + '　工作目录：' + (w.stateDir || '—')),
              ),
            ),
          ),
        )
      }

      /* ── Setup 视图（尚未配置） ── */
      if (state.mode === 'setup') {
        return h(Root, { theme: theme },
          h(StyleTag),
          h(Toolbar, {
            roleLabel: '未配置', autoRefresh: autoRefresh, theme: theme, loading: state.loading,
            onToggleAuto: function (v) { autoRef.current = v; setAutoRefresh(v) },
            onToggleTheme: function () { var next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); try { localStorage.setItem('dra-theme', next) } catch (e) {} },
            onRefresh: () => setTick(function (t) { return t + 1 }),
          }),
          h('div', { className: 'dra-banner' },
            h('div', { className: 'dra-banner-title' }, '本机还没有配置 AI 集群控制'),
            h('div', null, '填一次下面的信息即可；写入后重启 DSH 生效。'),
          ),
          h(SetupView, {
            setup: state.setup,
            onDone: function (written) { applyWrittenRole(written) },
            onCancel: function () {},
          }),
        )
      }

      /* ── Hub 视图（主机） ── */
      const screen = selectHubScreen(state)
      const cfgSection = h('div', null,
        h(ConfigPanel, {
          mode: 'hub', cfg: cfg, edit: cfgEdit, transportSummary: state.transportSummary,
          onEdit: function (k, v) { const patch = {}; patch[k] = v; setCfgEdit(function (prev) { const next = {}; Object.keys(prev).forEach(function (kk) { next[kk] = prev[kk] }); Object.keys(patch).forEach(function (kk) { next[kk] = patch[kk] }); return next }) },
        }),
        h('div', { className: 'dra-row', style: { marginTop: 6 } },
          h('button', { className: 'dra-btn sm', onClick: function () { setSwitchRole(true); openSwitch() } }, '切换角色'),
          h('span', { className: 'dra-hint' }, '已配置后改角色或地址，复用同一份写盘逻辑'),
        ),
      )
      const dispatchForm = h('div', null,
        h('div', { className: 'dra-tplrow' },
          h('select', {
            className: 'dra-select dra-mono',
            value: form.templateId || '',
            title: tpl.error ? ('模板库不可读：' + tpl.error) : (tpl.file ? ('模板存于 ' + tpl.file) : ''),
            onChange: function (e) { applyTemplate(e.target.value) },
          },
            h('option', { value: '' }, tpl.loading
              ? '模板：读取中…'
              : ((tpl.list || []).length === 0 ? '模板：（还没有，可把当前表单存下来）' : '模板：选一个一键填充')),
            (tpl.list || []).map(function (t) {
              return h('option', { key: t.id, value: t.id },
                t.name + (t.mode === 'exec' ? '（exec）' : '') + (t.workspace ? ' · ' + t.workspace : ''))
            }),
          ),
          h('button', {
            className: 'dra-btn sm',
            disabled: busy || !form.goal.trim() || !!tpl.error,
            title: tpl.error ? '模板库不可读' : '把当前表单内容存成模板',
            onClick: saveTemplate,
          }, form.templateId ? '更新模板' : '存为模板'),
          h('button', {
            className: 'dra-btn sm',
            disabled: busy || !form.templateId,
            title: form.templateId ? '删除当前选中的模板' : '先在下拉框里选一条模板',
            onClick: deleteTemplate,
          }, '删除模板'),
          (tpl.max && (tpl.list || []).length >= tpl.max)
            ? h('span', { className: 'dra-hint' }, '模板已达上限 ' + tpl.max + ' 条') : null,
          tpl.degraded
            ? h('span', { className: 'dra-hint dra-warn' }, '模板文件读不出来（' + (tpl.reason || 'unknown') + '）') : null,
          tpl.error
            ? h('span', { className: 'dra-hint dra-warn' }, '模板库不可用：' + tpl.error) : null,
          tplMsg ? h('span', { className: 'dra-hint' }, tplMsg) : null,
        ),
        h(DispatchForm, {
          nodes: nodes, form: form, busy: busy, modelCustom: modelCustom,
          onFormChange: setF,
          setModelCustom: setModelCustom,
          onSubmit: dispatch,
        }),
      )
      const pairSection = h('div', null,
        h(PairPanel, { pair: pair, pairNote: pairNote, onLoadPair: loadPair }),
        h(EnrollPanel, { enroll: enroll, onEnroll: mintEnroll }),
        h(StepGuide),
      )
      const computersMode = state.computersMode === 'topo' ? 'topo' : 'cards'
      const modeSwitch = h('div', { className: 'dra-row' },
        h('div', { className: 'dra-seg' },
          [['cards', '卡片'], ['topo', '拓扑']].map(function (m) {
            return h('button', {
              key: m[0], className: computersMode === m[0] ? 'active' : '',
              onClick: function () { setState(function (prev) { return Object.assign({}, prev, { computersMode: m[0] }) }) },
            }, m[1])
          })))
      const nodeHealth = screen === 'computers' ? topoHealthForRender(setState, nodes) : null
      const hubLeft = screen === 'computers' ? h('div', { className: 'dra-col' },
        modeSwitch,
        computersMode === 'topo'
          ? h(TopologyBoard, {
            nodes: nodes, tasks: tasks, topology: state.topology, nodeHealth: nodeHealth,
            relayStatus: topoRelayStatus(state.connection, state.relay),
            loading: state.loading === true, error: typeof state.error === 'string' ? state.error : '',
          })
          : h(NodeCardGrid, {
            nodes: nodes, onlineCount: counts.online, onAction: nodeAction, nodeHealth: nodeHealth,
            actions: h('button', { className: 'dra-btn sm', onClick: refresh }, '刷新'),
          }),
        computersMode === 'topo' ? null : h(TopologyMap, { topology: state.topology, nodes: nodes, tasks: tasks }),
        computersMode === 'topo' ? null : (function () {
          const dv = discoveryRows(state.discovery, nodes)
          return h(Card, { title: '局域网发现', sub: dv.rows.length + ' 台未配对' },
            !dv.enabled
              ? h('p', { className: 'dra-hint' }, '局域网发现未开启（在设置里打开后这里会列出同网段机器）')
              : dv.rows.length === 0
                ? h('p', { className: 'dra-hint' }, '未发现未配对的机器')
                : dv.rows.map(function (r, i) {
                  return h('div', { key: String(r.node) + ':' + i, className: 'dra-col' },
                    h('div', { className: 'dra-mono' }, r.node),
                    h('span', { className: 'dra-hint' }, String(r.role || '') + ' · ' + String(r.port == null ? '' : r.port)),
                    h('span', { className: 'dra-hint' }, r.addressLabel))
                }))
        })(),
      ) : screen === 'tasks' ? h('div', { className: 'dra-col' },
        h('div', { className: 'dra-hint' }, ALPHA_BOT_TURN_NOTE),
        cancelNote ? h('div', { className: 'dra-hint', role: 'status' }, cancelNote) : null,
        h(TaskList, {
          tasks: filteredTasks, filter: taskFilter, purgeBusy: purgeBusy,
          onFilter: function (f) { setTaskFilter(f) },
          onAction: taskAction, onClear: clearTasks,
        }),
        AttentionFold({ tickets: state.tickets }),
        selected ? h(TaskDetail, {
          detail: detail, loading: detailLoading,
          onClose: function () { setSelected('') },
          onAction: taskAction,
        }) : null,
        dispatchForm,
      ) : screen === 'bots' && openBot && botNodes(screenData.bots).some(function (n) { return String(n.nodeId) === openBot.nodeId }) ? (function () {
        const node = botNodes(screenData.bots).find(function (n) { return String(n.nodeId) === openBot.nodeId })
        const bot = (node.bots || []).find(function (b) { return String(b.id) === openBot.botId }) || { id: openBot.botId }
        return botChatView({
          node: node, bot: bot, history: botHist, turn: botTurn, draft: botDraft,
          onDraft: setBotDraft, onSend: sendBotTurn, onBack: closeBotChat,
          onEdit: function () {
            setBotNote({ text: '', ok: false })
            setBotForm({ nodeId: String(node.nodeId), botId: String(bot.id), name: String(bot.name || ''), role: String(bot.role || ''),
              modelRef: String(bot.model || ''), workDir: '', instructions: '' })
            closeBotChat()
          },
        })
      })() : screen === 'bots' ? h('div', { className: 'dra-col' },
        botFormView({
          form: botForm, nodes: botNodes(screenData.bots, state.nodes), busy: botBusy, note: botNote.text, noteOk: botNote.ok,
          onChange: function (patch) { setBotForm(function (p) { return Object.assign({}, p, patch) }) },
          onSubmit: submitBot,
          onCancel: function () { setBotForm(BOT_FORM0); setBotNote({ text: '', ok: false }) },
        }),
        rosterView(screenData.bots, {
          onOpen: openBotChat,
          onEdit: function (n, b) {
            setBotNote({ text: '', ok: false })
            setBotForm({ nodeId: String(n.nodeId), botId: String(b.id), name: String(b.name || ''), role: String(b.role || ''),
              modelRef: String(b.model || ''), workDir: '', instructions: '' })
          },
        }),
      ) : screen === 'memory' ? memoryScreenView({
        scopes: memScopes, view: memView, options: memoryScopeOptions(memScopes.data), scope: memScope,
        draft: memDraft, topic: memTopic, busy: memBusy, note: memNote,
        onScope: memPickScope, onDraft: setMemDraft, onTopic: setMemTopic, onAdd: memAdd, onForget: memForget,
      }) : screen === 'models' ? h('div', { className: 'dra-col' },
        modelsView(screenData.models),
      ) : h('div', { className: 'dra-col' },
        h('p', null, '未接入'),
      )
      const hubRight = h('aside', { className: 'dra-screen-secondary', 'aria-label': '设置与接入' },
        cfgSection,
        h(Fold, { title: '副机接入', badge: nodes.length === 0 ? '先接一台' : (nodes.length + ' 台'), open: state.nodes.length === 0 },
          pairSection,
        ),
      )

      const screenLabel = (P2_SCREENS.find(function (entry) { return entry[0] === screen }) || ['', ''])[1]
      const listTotal = function (av, key) {
        if (!av || av.kind !== 'data' || !Array.isArray(av.nodes)) return null
        return av.nodes.reduce(function (sum, x) { const a = x && x[key]; return sum + (Array.isArray(a) ? a.length : 0) }, 0)
      }
      const tabCounts = {
        nodes: counts.nodes, online: counts.online, active: counts.active,
        bots: listTotal(screenData.bots, 'bots'), models: listTotal(screenData.models, 'models'),
        memory: memView.state === 'ok' && memView.data && Array.isArray(memView.data.entries) ? memView.data.entries.length : null,
      }
      return h(Root, { theme: theme },
        h(StyleTag),
        h(Toolbar, {
          roleLabel: runtimePlan.view === 'both' ? '同机' : '主机', autoRefresh: autoRefresh, theme: theme, loading: state.loading,
          onToggleAuto: function (v) { autoRef.current = v; setAutoRefresh(v) },
          onToggleTheme: function () { var next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); try { localStorage.setItem('dra-theme', next) } catch (e) {} },
          onRefresh: refresh,
        }),
        h('nav', { className: 'dra-shell-nav', 'aria-label': '主要屏幕' },
          h('div', {
            className: 'dra-tablist', role: 'tablist', 'aria-label': '主要屏幕',
            onKeyDown: function (e) {
              const next = shellTabKey(screen, e && e.key)
              if (!next) return
              e.preventDefault()
              setState(function (prev) { return Object.assign({}, prev, { screen: next }) })
              if (typeof document !== 'undefined' && document && typeof document.getElementById === 'function') {
                setTimeout(function () { const el = document.getElementById('tab-' + next); if (el && el.focus) el.focus() }, 0)
              }
            },
          },
            shellTabModel(screen, tabCounts).map(function (tab) {
              return h('button', {
                key: tab.id, id: tab.tabId, type: 'button', role: 'tab', className: 'dra-tab',
                'aria-selected': tab.selected ? 'true' : 'false', 'aria-controls': tab.panelId, tabIndex: tab.selected ? 0 : -1,
                onClick: function () {
                  setState(function (prev) { return Object.assign({}, prev, { screen: tab.id }) })
                },
              }, tab.label, tab.count == null ? null : h('span', { className: 'dra-tab-count', 'aria-hidden': 'true' }, tab.count))
            }),
          ),
        ),
        h('div', { className: 'dra-shell-status' },
          state.error ? h('div', { className: 'dra-banner err', role: 'alert' },
            h('div', { className: 'dra-banner-title' }, '连接异常'),
            h('div', { className: 'dra-mono dra-wrap' }, state.error),
            h('div', { className: 'dra-row', style: { marginTop: 6 } },
              h('button', { className: 'dra-btn sm', onClick: refresh }, '重试'),
            ),
          ) : null,
          !everConnected && nodes.length > 0 ? h('div', { className: 'dra-banner', role: 'status' },
            h('div', { className: 'dra-banner-title' }, '还没有连上过'),
            h('div', null, '有 ' + nodes.length + ' 个节点登记过，但当前都不在线。检查独立监听、relay 地址与口令；地址不能是 0.0.0.0。' + (connDiag ? ' 诊断：' + connDiag : '')),
          ) : null,
          note ? h('div', { className: 'dra-banner ok', role: 'status' },
            h('div', { className: 'dra-banner-title' }, note),
          ) : null,
        ),
        h('main', { id: 'panel-' + screen, className: 'dra-screen', role: 'tabpanel', 'aria-labelledby': 'tab-' + screen },
          h('section', { className: 'dra-screen-summary', 'aria-label': '概况' },
            h('h2', { className: 'dra-screen-title' }, (runtimePlan.view === 'both' ? '主机 · ' : '') + screenLabel),
            h('p', { className: 'dra-screen-line' }, shellScreenSummary(screen, { counts: counts, bots: screenData.bots, models: screenData.models, memory: memView })),
            h(StatBar, { counts: counts }),
          ),
          h('div', { className: 'dra-screen-body' },
            h('div', { className: 'dra-screen-primary' }, hubLeft),
            hubRight,
          ),
        ),
        h('footer', { className: 'dra-shell-foot', 'aria-label': '工具与高级设置' },
          h(Fold, { title: '环境体检', badge: envCheck ? (envCheck.failed > 0 ? envCheck.failed + ' 项待处理' : '通过') : '未体检', open: Boolean(envCheck && envCheck.failed > 0) },
            h(EnvPanel, {
              envCheck: envCheck, envBusy: envBusy, fixPlan: fixPlan, fixBusy: fixBusy, fixMsg: fixMsg,
              onRun: runEnvCheck, onPreviewFix: previewFix, onApplyFix: applyFix,
            }),
          ),
          h(Fold, { title: '检测工具', badge: tools ? ((tools.missing || []).length + ' 项缺失') : '未检测' },
            h(ToolPanel, { tools: tools, busy: toolsBusy, onRefresh: probeTools }),
          ),
          h(Fold, { title: '工作区共享（SMB）', badge: '高级' },
            h(SharePanel, { nodes: nodes }),
          ),
          h(Fold, { title: '从 SSH 主机部署副机', badge: sshHosts.length > 0 ? sshHosts.length + ' 台' : (sshHostsErr ? '读取失败' : '未配置') },
            (function () {
              var relayConfigured = cfg && cfg.relayUrl && cfg.relayUrl.trim() && cfg.relayTokenSet
              if (relayConfigured) return null
              // Check if any probed host is a relay
              var relayFound = false
              for (var a in sshProbeResult) {
                if (sshProbeResult[a] && sshProbeResult[a].isRelay) { relayFound = true; break }
              }
              return h('div', { className: 'dra-relay-precheck', style: { margin: '8px 12px', padding: '10px 14px', background: 'var(--dra-warn-bg, rgba(255,180,0,0.08))', border: '1px solid var(--dra-warn)', borderRadius: 'var(--dra-r-md)' } },
                h('div', { className: 'dra-row', style: { marginBottom: 4, gap: 8 } },
                  h('span', { style: { color: 'var(--dra-warn)', fontWeight: 600 } }, '⚠ 中继未配置'),
                ),
                quickRelay.busy
                  ? h('span', { className: 'dra-dim', style: { fontSize: 11 } }, '正在自动配置中继…')
                  : quickRelay.done
                    ? h('span', { style: { color: 'var(--dra-ok)' } }, '✔ 中继配置已保存')
                    : quickRelay.err
                      ? h('span', { style: { color: 'var(--dra-danger)', fontSize: 11 } }, quickRelay.err)
                      : h('span', { className: 'dra-dim', style: { fontSize: 11 } },
                          relayFound
                            ? '已探测到中继主机，点「一键上桥」将自动配置中继并部署'
                            : '请先点「环境检测」探测各主机，探测到中继后上桥时自动配置')
              )
            })(),
            sshHostsErr ? h('div', { className: 'dra-warn', style: { padding: '8px 12px' } }, '读取 dsh-ssh.json 失败：' + sshHostsErr) : null,
            sshHosts.length === 0 && !sshHostsErr ? h('div', { className: 'dra-dim', style: { padding: '8px 12px' } }, '未找到 SSH 主机配置，请在 $DSH_HOME/dsh-ssh.json 中添加') : null,
            h('div', { className: 'dra-col', style: { gap: 8 } },
              sshHosts.map(function (host) {
                const alias = host.alias
                const probe = sshProbeResult[alias]
                const job = sshDeployJob[alias]
                const probeBusy = !!sshProbeBusy[alias]
                const deployBusy = !!sshDeployBusy[alias]
                return h('div', { key: alias, className: 'dra-card', style: { padding: '10px 14px' } },
                  h('div', { className: 'dra-row', style: { marginBottom: 6 } },
                    h('span', { style: { fontWeight: 600, color: 'var(--dra-accent)' } }, alias),
                    h('span', { className: 'dra-dim', style: { marginLeft: 8, fontSize: 11 } }, host.user + '@' + host.host + ':' + (host.port || 22)),
                    h('span', { className: 'dra-badge', style: { marginLeft: 8 } }, host.authKind === 'key' ? '密钥' : '密码'),
                    (host.tags || []).map(function (t) { return h('span', { key: t, className: 'dra-badge', style: { marginLeft: 4 } }, t) }),
                    probe && probe.isRelay ? h('span', { className: 'dra-badge ok', style: { marginLeft: 4 } }, '中继') : null,
                    h('span', { className: 'dra-badge' + (!probe ? '' : probe.ok && probe.missing && probe.missing.length > 0 ? ' warn' : probe.ok && (!probe.missing || probe.missing.length === 0) && !job ? ' info' : probe.ok === false ? ' danger' : job && job.status === 'done' ? ' ok' : job && job.status === 'failed' ? ' danger' : job && job.status === 'running' ? ' info' : ''), style: { marginLeft: 8 } },
                      !probe ? '未检测' : probe.ok === false ? '探测失败' : probe.ok && probe.missing && probe.missing.length > 0 ? '缺环境' : probe.ok && (!probe.missing || probe.missing.length === 0) && !job ? '可上桥' : job && job.status === 'running' ? '上桥中' : job && job.status === 'done' ? '已上桥' : job && job.status === 'failed' ? '失败' : '未检测'
                    ),
                    h('div', { style: { flex: 1 } }),
                    h('button', { className: 'dra-btn sm', disabled: probeBusy, onClick: function () { runSshProbe(alias) } }, probeBusy ? '检测中…' : '环境检测'),
                    h('button', { className: 'dra-btn sm accent', disabled: deployBusy || probeBusy, style: { marginLeft: 6 }, onClick: function () { runSshDeploy(alias) } }, deployBusy ? '部署中…' : '一键上桥'),
                  ),
                  probe ? h('div', { style: { fontSize: 11, marginBottom: 6 } },
                    probe.ok ? h('span', { style: { color: 'var(--dra-ok)' } },
                      '✔ ' + [probe.os, probe.node ? 'node ' + probe.node : null, probe.dsh ? 'dsh ' + probe.dsh : '未安装 dsh'].filter(Boolean).join('  ·  ')
                    ) : h('span', { style: { color: 'var(--dra-danger)' } }, '✘ ' + (probe.error || '探测失败')),
                    probe.missing && probe.missing.length > 0 ? h('span', { style: { color: 'var(--dra-warn)', marginLeft: 8 } }, '缺：' + probe.missing.join(', ')) : null,
                    probe.missing && probe.missing.length > 0 ? h('button', {
                      className: 'dra-btn sm',
                      style: { marginLeft: 8 },
                      disabled: !!sshInstallBusy[alias],
                      onClick: function () { runInstallRuntime(alias) }
                    }, sshInstallBusy[alias] ? '安装中…' : '安装运行环境') : null,
                    sshInstallErr[alias] ? h('span', { style: { color: 'var(--dra-danger)', marginLeft: 8, fontSize: 11 } }, sshInstallErr[alias]) : null,
                  ) : null,
                  job ? h('div', { className: 'dra-col', style: { gap: 3 } },
                    (job.steps || []).map(function (s) {
                      return h('div', { key: s.id, style: { fontSize: 11, display: 'flex', gap: 6 } },
                        h('span', { style: { color: s.status === 'done' ? 'var(--dra-ok)' : s.status === 'failed' ? 'var(--dra-danger)' : 'var(--dra-dim)' } },
                          s.status === 'done' ? '✔' : s.status === 'failed' ? '✘' : '○'
                        ),
                        h('span', null, s.label),
                        s.msg ? h('span', { className: 'dra-dim' }, s.msg) : null,
                      )
                    }),
                    job.error ? h('div', { style: { color: 'var(--dra-danger)', fontSize: 11, marginTop: 4 } }, job.error) : null,
                  ) : null,
                )
              }),
            ),
          ),
        ),
        runtimePlan.view === 'both' ? h('div', { className: 'dra-col', style: { marginTop: 8 } },
          h('div', { className: 'dra-banner-title' }, '副机'),
          h(Card, { title: '本机状态', sub: 'Worker 视图' },
            h('div', { className: 'dra-mono' }, (state.worker && state.worker.nodeId) || '副机状态未读到'),
          ),
        ) : null,
      )
    }

    /* ───────────────────────────── 侧栏图标 ───────────────────────────── */
    function PanelIcon() {
      return h('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('circle', { cx: 12, cy: 5, r: 2.4 }),
        h('circle', { cx: 5, cy: 18, r: 2.4 }),
        h('circle', { cx: 19, cy: 18, r: 2.4 }),
        h('path', { d: 'M12 7.4v4.2M12 11.6 6.4 15.8M12 11.6l5.6 4.2' }),
      )
    }

    return {
      inject: ['slots'],
      selectRuntimeView: selectRuntimeView,
      P2_SCREENS: P2_SCREENS,
      selectHubScreen: selectHubScreen,
      ticketStage: ticketStage,
      sortAttentionTickets: sortAttentionTickets,
      cancelReceipt: cancelReceipt,
      cancelEvidenceLabel: cancelEvidenceLabel,
      stallLabel: stallLabel,
      TaskRow: TaskRow,
      TaskDetail: TaskDetail,
      ALPHA_BOT_TURN_NOTE: ALPHA_BOT_TURN_NOTE,
      themeResolve: themeResolve,
      shellTabModel: shellTabModel,
      shellTabKey: shellTabKey,
      shellScreenSummary: shellScreenSummary,
      modelRows: modelRows,
      discoveryRows: discoveryRows,
      nodeCardView: nodeCardView,
      screenAvailability: screenAvailability,
      rosterView: rosterView,
      modelsView: modelsView,
      modelsAvailability: modelsAvailability,
      botFormView: botFormView,
      botNodes: botNodes,
      botChatView: botChatView,
      botApi: botApi,
      botApiOutcome: botApiOutcome,
      memoryScopes: memoryScopes,
      memoryView: memoryView,
      memoryAdd: memoryAdd,
      memoryForget: memoryForget,
      memoryScopeOptions: memoryScopeOptions,
      memoryEntryRows: memoryEntryRows,
      memoryScreenView: memoryScreenView,
      topologyLayout: topologyLayout,
      topologyScale: topologyScale,
      topologyMotion: topologyMotion,
      topologyFit: topologyFit,
      topologyRelayDown: topologyRelayDown,
      topoRelayStatus: topoRelayStatus,
      topoMeshModel: topoMeshModel,
      topoPinReducer: topoPinReducer,
      topoNeighborView: topoNeighborView,
      topoFallbackMode: topoFallbackMode,
      topoStaleLabel: topoStaleLabel,
      renderTopologyBoardView: renderTopologyBoardView,
      TopologyMap: TopologyMap,
      topoTaskState: topoTaskState,
      renderTopologyScene: renderTopologyScene,
      startTopologyLoop: startTopologyLoop,
      TopologyBoard: TopologyBoard,
      POLL_MS: POLL_MS,
      shouldPoll: shouldPoll,
      topoActivity: topoActivity,
      apply: function (ctx) {
        const disposers = []
        const stylesSvc = ctx.get ? ctx.get('styles') : null
        if (stylesSvc && typeof stylesSvc.insert === 'function') disposers.push(stylesSvc.insert(CSS))
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_KEY,
            order: 30,
            label: function () { return 'AI 集群控制' },
          }, PanelIcon)
        })
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_KEY }, Panel)
        })
        return function () {
          for (let i = 0; i < disposers.length; i += 1) {
            try { disposers[i]() } catch (e) { /* 卸载阶段尽力而为 */ }
          }
        }
      },
    }
  },
})
