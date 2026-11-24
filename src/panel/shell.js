/**
 * 面板外壳：角色分流（未配置 / 副机 / 主机 / 同机）、四屏标签、设置抽屉、对话框与提示。
 * 外壳不认识任何屏的内部；屏模块只通过 props 拿 { hub, ui, role, go, refresh }。
 * 顶层标识符一律以 `shell` 开头。
 */
import { coreThemeResolve } from './core.js'

export const shellScreens = [['overview', '总览'], ['machines', '机器'], ['team', '团队'], ['tasks', '任务']]
export const shellPanelKey = 'dsh-ai-cluster'

export function shellScreenId(s) { return shellScreens.some((e) => e[0] === s) ? s : 'overview' }

/** 标签模型：counts 里没有的数不显示。 */
export function shellTabs(screen, counts) {
  const c = counts && typeof counts === 'object' ? counts : {}
  const cur = shellScreenId(screen)
  const countOf = { machines: c.nodes != null ? (c.online != null ? c.online + '/' + c.nodes : c.nodes) : null, tasks: c.active }
  return shellScreens.map((e) => ({
    id: e[0], label: e[1], selected: e[0] === cur, tabId: 'dra-tab-' + e[0], panelId: 'dra-panel-' + e[0],
    count: countOf[e[0]] == null ? null : countOf[e[0]],
  }))
}

/** 方向键 / Home / End 的目标标签；不处理的键返回 null。 */
export function shellTabKey(screen, key) {
  const ids = shellScreens.map((e) => e[0])
  const i = ids.indexOf(shellScreenId(screen))
  if (key === 'ArrowRight') return ids[(i + 1) % ids.length]
  if (key === 'ArrowLeft') return ids[(i + ids.length - 1) % ids.length]
  if (key === 'Home') return ids[0]
  if (key === 'End') return ids[ids.length - 1]
  return null
}

/** 角色 → 要读哪些数据、显示哪套界面。 */
export function shellRolePlan(role) {
  const r = String(role || '').trim().toLowerCase()
  return { hub: r === 'hub' || r === 'both', worker: r === 'worker' || r === 'both', both: r === 'both', view: r === 'worker' ? 'worker' : (r === 'hub' || r === 'both') ? 'hub' : 'none' }
}

/**
 * @param core   createCore() 的结果
 * @param data   createData(core) 的结果
 * @param css    已拼好的整段样式字符串（stylesBase + 各屏 css）
 * @param mods   { fleet: {Overview, Machines}, team: {Screen}, tasks: {Screen}, settings: {Setup, WorkerView, Drawer} }
 */
export function createShell(core, data, mods, css) {
  const { React, h, Banner } = core

  function Root(p) {
    return h('div', { className: 'dra-root' + (p.theme === 'light' ? ' dra-light' : ''), 'data-theme': p.theme }, h('i', { className: 'dra-aurora', 'aria-hidden': 'true' }), p.children)
  }

  function Dialog(p) {
    const d = p.dialog
    const [draft, setDraft] = React.useState('')
    React.useEffect(() => { setDraft(d ? d.def : '') }, [d])
    if (!d) return null
    const cancel = () => p.onAnswer(d.kind === 'confirm' ? false : null)
    return h('div', { className: 'dra-dialog-overlay', onClick: (e) => { if (e.target === e.currentTarget) cancel() } },
      h('div', { className: 'dra-dialog', role: 'dialog', 'aria-modal': 'true' },
        h('p', { className: 'dra-dialog-msg' }, d.msg),
        d.kind === 'prompt' ? h('input', {
          className: 'dra-input', type: 'text', value: draft, autoFocus: true,
          onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') p.onAnswer(draft) },
        }) : null,
        h('div', { className: 'dra-dialog-actions' },
          d.kind === 'alert' ? null : h('button', { className: 'dra-btn', onClick: cancel }, '取消'),
          h('button', { className: 'dra-btn primary', onClick: () => p.onAnswer(d.kind === 'prompt' ? draft : true) }, '确定'))))
  }

  function Panel() {
    /* 所有 hook 在任何条件 return 之前。 */
    const { boot, reload, applyRole } = data.useBoot()
    const plan = shellRolePlan(boot.role)
    const [autoRefresh, setAutoRefresh] = React.useState(true)
    const { hub, refresh: refreshHub } = data.useHub(boot.state === 'ready' && plan.hub, autoRefresh)
    const { worker, refresh: refreshWorker } = data.useWorker(boot.state === 'ready' && plan.worker, autoRefresh)
    const [screen, setScreen] = React.useState('overview')
    /* 访问过的屏保持挂载（只隐藏），切标签不丢草稿、聊天、已选范围。 */
    const [visited, setVisited] = React.useState({ overview: true })
    const goScreen = (s) => { const id = shellScreenId(s); setScreen(id); setVisited((v) => (v[id] ? v : Object.assign({}, v, { [id]: true }))) }
    const [settingsOpen, setSettingsOpen] = React.useState(false)
    const [switching, setSwitching] = React.useState(false)
    const [note, setNote] = React.useState(null)
    const [dialog, setDialog] = React.useState(null)
    const [theme, setTheme] = React.useState(() => {
      let saved
      let host
      let prefersDark
      try { saved = localStorage.getItem('dra-theme') } catch { /* 无存储 */ }
      try { host = document.documentElement.getAttribute('data-theme') } catch { /* 无 DOM 属性 */ }
      try { prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches === true } catch { /* 无 matchMedia */ }
      return coreThemeResolve({ saved, host, prefersDark })
    })

    const ask = (kind, msg, def) => new Promise((resolve) => setDialog({ kind, msg, def: String(def || ''), resolve }))
    const ui = {
      confirm: (msg) => ask('confirm', msg),
      alert: (msg) => { ask('alert', msg) },
      prompt: (msg, def) => ask('prompt', msg, def),
      notify: (text, tone) => setNote(text ? { text: String(text), tone: tone || 'ok' } : null),
    }
    const answer = (val) => { if (dialog) dialog.resolve(val); setDialog(null) }
    const refresh = () => { if (plan.hub) refreshHub(); if (plan.worker) refreshWorker() }
    const toggleTheme = () => {
      const next = theme === 'dark' ? 'light' : 'dark'
      setTheme(next)
      try { localStorage.setItem('dra-theme', next) } catch { /* 无存储就不记 */ }
    }
    const roleLabel = plan.both ? '同机' : plan.view === 'worker' ? '副机' : plan.view === 'hub' ? '主机' : '未配置'

    const Toolbar = () => {
      return h('header', { key: 'tb', className: 'dra-head' },
        h('div', { className: 'dra-brand' }, h('i'), 'AI 集群控制'),
        h('span', { className: 'dra-badge acc' }, roleLabel),
        h('span', { className: 'dra-spacer' }),
        boot.state === 'ready' ? h('label', { className: 'dra-check' },
          h('input', { type: 'checkbox', checked: autoRefresh, onChange: (e) => setAutoRefresh(e.target.checked) }), '自动刷新') : null,
        boot.state === 'ready' ? h('button', { className: 'dra-btn sm', onClick: refresh }, '刷新') : null,
        h('button', { className: 'dra-btn sm', onClick: toggleTheme, 'aria-label': '切换明暗主题' }, theme === 'dark' ? '浅色' : '深色'),
        boot.state === 'ready' ? h('button', { className: 'dra-btn sm', onClick: () => setSettingsOpen(true) }, '设置') : null)
    }

    const frame = (children) => h(Root, { theme },
      h('style', null, css),
      children,
      h(Dialog, { dialog, onAnswer: answer }))

    if (switching || boot.state === 'setup') {
      return frame([
        Toolbar(),
        boot.state === 'setup' ? h(Banner, { key: 'bn', title: '本机还没有配置 AI 集群控制' }, '填一次下面的信息即可；写入后重启 DSH 生效。') : null,
        h(mods.settings.Setup, {
          key: 'setup', switching, setup: boot.setup, ui,
          onDone: (written) => { setSwitching(false); applyRole(written && written.role) },
          onCancel: () => setSwitching(false),
        }),
      ])
    }
    if (boot.state === 'loading') return frame(h('div', { className: 'dra-hint' }, '读取本机角色…'))
    if (boot.state === 'error') {
      return frame([Toolbar(),
        h(Banner, { key: 'e', tone: 'err', title: '读不到本机角色', actions: h('button', { className: 'dra-btn sm', onClick: reload }, '重试') }, boot.error)])
    }

    const common = { hub, ui, role: boot.role, go: goScreen, refresh }
    const cur = shellScreenId(screen)
    const screenOf = { overview: mods.fleet.Overview, machines: mods.fleet.Machines, team: mods.team.Screen, tasks: mods.tasks.Screen }

    const hubBody = [
      h('nav', { key: 'nav', className: 'dra-tabs', role: 'tablist', 'aria-label': '主要屏幕',
        onKeyDown: (e) => {
          const next = shellTabKey(cur, e && e.key)
          if (!next) return
          e.preventDefault()
          goScreen(next)
          setTimeout(() => { const el = document.getElementById('dra-tab-' + next); if (el && el.focus) el.focus() }, 0)
        } },
      shellTabs(cur, { nodes: hub.counts.nodes, online: hub.counts.online, active: hub.counts.active }).map((t) => h('button', {
        key: t.id, id: t.tabId, type: 'button', role: 'tab', className: 'dra-tab', tabIndex: t.selected ? 0 : -1,
        'aria-selected': t.selected ? 'true' : 'false', 'aria-controls': t.panelId, onClick: () => goScreen(t.id),
      }, t.label, t.count == null ? null : h('span', { className: 'dra-tab-count' }, t.count)))),
      hub.error ? h(Banner, { key: 'err', tone: 'err', title: '连接异常', actions: h('button', { className: 'dra-btn sm', onClick: refresh }, '重试') }, hub.error) : null,
      h('div', { key: 'main', className: 'dra-screens' }, shellScreens.map((e) => (visited[e[0]] || e[0] === cur)
        ? h('main', { key: e[0], id: 'dra-panel-' + e[0], className: 'dra-screen', role: 'tabpanel', 'aria-labelledby': 'dra-tab-' + e[0], hidden: e[0] !== cur },
          h(screenOf[e[0]], Object.assign({}, common, { active: e[0] === cur })))
        : null)),
    ]
    const workerBody = h(mods.settings.WorkerView, { ui, worker, onSwitchRole: () => setSwitching(true), refresh })

    return frame([
      Toolbar(),
      note ? h(Banner, { key: 'note', tone: note.tone, actions: h('button', { className: 'dra-btn sm', onClick: () => setNote(null) }, '知道了') }, note.text) : null,
      plan.view === 'worker' ? workerBody : hubBody,
      settingsOpen ? h(mods.settings.Drawer, {
        key: 'drawer', role: boot.role, hub, worker, ui, refresh, plan,
        onClose: () => setSettingsOpen(false), onSwitchRole: () => { setSettingsOpen(false); setSwitching(true) },
      }) : null,
    ])
  }

  function PanelIcon() {
    return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      h('circle', { cx: 12, cy: 5, r: 2.4 }), h('circle', { cx: 5, cy: 18, r: 2.4 }), h('circle', { cx: 19, cy: 18, r: 2.4 }),
      h('path', { d: 'M12 7.4v4.2M12 11.6 6.4 15.8M12 11.6l5.6 4.2' }))
  }

  return { Panel, PanelIcon, Root, Dialog }
}
