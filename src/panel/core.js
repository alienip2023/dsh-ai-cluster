/**
 * 面板核心：请求封装、格式化、基础组件。无状态、无业务。
 * 构建脚本会把本文件原样并入 lib/client.js（去掉 export 关键字）；测试直接 import。
 * 规则：顶层标识符一律以 `core` 开头；用到 React 的东西都在 createCore 里。
 */

export const coreApi = '/api/ai-cluster/ui'
export const coreApiLegacy = '/api/remote-agent/ui'

/* ── 纯函数 ────────────────────────────────────────────────────────── */

export function coreFmtTime(ms) {
  if (!ms || typeof ms !== 'number') return '—'
  const d = new Date(ms)
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

export function coreFmtDur(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm' + (s % 60) + 's'
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm'
}

export function coreFmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

export function corePct(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0
}

export function coreShortId(id, n = 10) {
  const s = String(id || '')
  return s.length > n ? s.slice(0, n) : s
}

/** 把请求失败统一成 { ok:false, error, status }；后端「预期内拒绝」本来就回 200 {ok:false,error}。 */
export function coreFailure(e) {
  const body = e && e.body && typeof e.body === 'object' ? e.body : null
  return {
    ok: false,
    status: (e && e.status) || 0,
    error: String((body && (body.error || body.message)) || (e && e.message) || 'unknown'),
    body,
  }
}

/** 稳定错误码 → 一句人话。未知码原样显示（不吞原文）。 */
export const coreErrorText = {
  'node-offline': '这台机器当前不在线',
  'bot-stop-timeout': '机器没有在时限内回应',
  'bot-create-timeout': '机器没有在时限内回应',
  'bot-update-timeout': '机器没有在时限内回应',
  'bot-history-timeout': '机器没有在时限内回应',
  'bot-turn-busy': '正在跑的对话太多，稍后再试',
  'bot-locate-unavailable': '这台主控不支持按身份定位',
}
export function coreExplain(code) {
  const c = String(code || '')
  return coreErrorText[c] ? coreErrorText[c] + '（' + c + '）' : c
}

/** 版本比较：'0.4.36' >= '0.4.34'。缺失或不可解析返回 null（调用方显示「版本未知」，不是旧）。 */
export function coreVersionAtLeast(version, min) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''))
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const a = parse(version)
  const b = parse(min)
  if (!a || !b) return null
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}
/** 0.4.34 起 Bot 协作走新协议；更早的节点要提示升级。 */
export const coreMinNodeVersion = '0.4.34'

export function coreThemeResolve(input) {
  const o = input && typeof input === 'object' ? input : {}
  const ok = (v) => v === 'light' || v === 'dark'
  if (ok(o.saved)) return o.saved
  if (ok(o.host)) return o.host
  if (o.prefersDark === true) return 'dark'
  if (o.prefersDark === false) return 'light'
  return 'dark'
}

export const coreActiveStatuses = ['running', 'queued', 'pending_approval']
export const coreFailedStatuses = ['failed', 'aborted', 'rejected']

/* ── 组件工厂 ──────────────────────────────────────────────────────── */

export function createCore(React) {
  const h = React.createElement

  function readJson(r) {
    return r.json().catch(() => ({})).then((b) => {
      if (r.ok) return b
      const e = new Error((b && (b.message || b.error)) || ('HTTP ' + r.status))
      e.status = r.status
      e.body = b
      throw e
    })
  }
  const jsonPost = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })

  /** UI 前缀下的接口：新前缀 404 时退回旧前缀。 */
  const api = {
    get(p) {
      return fetch(coreApi + p, { cache: 'no-store' })
        .then((r) => (r.status === 404 ? fetch(coreApiLegacy + p, { cache: 'no-store' }) : r)).then(readJson)
    },
    post(p, body) {
      return fetch(coreApi + p, jsonPost(body))
        .then((r) => (r.status === 404 ? fetch(coreApiLegacy + p, jsonPost(body)) : r)).then(readJson)
    },
    /** 完整路径（副机状态、引导端点、ds-bot 的 /api/bot 都不在 UI 前缀下）。 */
    getPath(full) { return fetch(full, { cache: 'no-store' }).then(readJson) },
    postPath(full, body) { return fetch(full, jsonPost(body)).then(readJson) },
  }

  /** 失败也 resolve 成 { ok:false, error }，调用方不必到处 try/catch。 */
  const safe = (promise) => promise.then((d) => d, coreFailure)

  function copyText(text) {
    const s = String(text == null ? '' : text)
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s).then(() => true, () => false)
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
    } catch {
      return Promise.resolve(false)
    }
  }

  /* 基础组件。状态不只靠颜色：Badge/Dot 带字形（见 styles.js）。 */
  function Dot(p) {
    return h('span', { className: 'dra-dot' + (p.tone ? ' ' + p.tone : ''), title: p.title || '', role: 'img', 'aria-label': p.label || p.title || '' })
  }
  function Badge(p) {
    return h('span', { className: 'dra-badge' + (p.tone ? ' ' + p.tone : ''), title: p.title || '' }, p.children)
  }
  function Card(p) {
    return h('section', { className: 'dra-card' + (p.className ? ' ' + p.className : ''), 'aria-label': typeof p.title === 'string' ? p.title : undefined },
      (p.title || p.actions) ? h('header', { className: 'dra-card-head' },
        h('div', { className: 'dra-card-titles' },
          p.title ? h('h3', { className: 'dra-card-title' }, p.title) : null,
          p.sub ? h('div', { className: 'dra-card-sub' }, p.sub) : null),
        p.actions ? h('div', { className: 'dra-card-actions' }, p.actions) : null) : null,
      h('div', { className: 'dra-card-body' }, p.children))
  }
  /** 折叠块。用 <details>，浏览器自带键盘与无障碍；open 只作初值。 */
  function Fold(p) {
    return h('details', { className: 'dra-fold', open: p.open === true ? true : undefined },
      h('summary', { className: 'dra-fold-sum' }, h('span', null, p.title), p.badge != null ? h('span', { className: 'dra-fold-badge' }, p.badge) : null),
      h('div', { className: 'dra-fold-body' }, p.children))
  }
  function Banner(p) {
    return h('div', { className: 'dra-banner' + (p.tone ? ' ' + p.tone : ''), role: p.tone === 'err' ? 'alert' : 'status' },
      h('div', { className: 'dra-banner-title' }, p.title),
      p.children ? h('div', { className: 'dra-banner-body' }, p.children) : null,
      p.actions ? h('div', { className: 'dra-row' }, p.actions) : null)
  }
  function Stat(p) {
    return h('div', { className: 'dra-stat' + (p.tone ? ' ' + p.tone : ''), title: p.title || '' },
      h('div', { className: 'dra-stat-value' }, p.value),
      h('div', { className: 'dra-stat-label' }, p.label))
  }
  /** 分段选择：[ [id,label], ... ]。 */
  function Seg(p) {
    return h('div', { className: 'dra-seg', role: 'group', 'aria-label': p.label || '' },
      p.options.map((o) => h('button', {
        key: o[0], type: 'button', className: p.value === o[0] ? 'active' : '', 'aria-pressed': p.value === o[0] ? 'true' : 'false',
        onClick: () => p.onChange(o[0]),
      }, o[1])))
  }
  /** 表单项：label 包住控件，点标签聚焦控件。 */
  function Field(p) {
    return h('label', { className: 'dra-field' + (p.wide ? ' wide' : '') },
      h('span', { className: 'dra-field-label' }, p.label),
      p.children,
      p.hint ? h('span', { className: 'dra-hint' }, p.hint) : null)
  }
  function Empty(p) { return h('div', { className: 'dra-empty' }, p.children) }
  function CopyBtn(p) {
    const [done, setDone] = React.useState(false)
    return h('button', {
      type: 'button', className: 'dra-btn sm', title: p.title || '复制',
      onClick: () => { copyText(p.text).then((ok) => { setDone(ok); setTimeout(() => setDone(false), 1500) }) },
    }, done ? '已复制' : (p.label || '复制'))
  }

  return { React, h, api, safe, copyText, readJson, Dot, Badge, Card, Fold, Banner, Stat, Seg, Field, Empty, CopyBtn }
}
