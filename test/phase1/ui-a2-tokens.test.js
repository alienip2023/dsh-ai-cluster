/**
 * A2 视觉 token / CSS 规则验收（BOOK-ui-redesign §4.2–§4.4、§4.7 #3 #4 #5 #6 #7 #12）。
 *
 * tokenAudit 只存在于本测试：解析生产代码里真实的 CSS 数组（vm 求值，不靠源码字符串猜测），
 * 报告重复选择器 / JSX 用到但缺规则的 dra-* 类 / 语义 token 暗浅两套 / 文字对比度。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../../lib/client.js'), 'utf8')
const code = src.replace(/\/\*[\s\S]*?\*\//g, '')

function load() {
  let plugin = null
  const sandbox = {
    window: { __ModuleLoader__: { load(mod) { plugin = mod.factory(() => ({
      createElement(type, props, ...kids) { return { type, props: props || {}, kids: kids.flat(Infinity) } },
      useState(v) { return [v, function () {}] }, useEffect() {}, useRef(v) { return { current: v } }, useMemo(fn) { return fn() },
    })) } } },
    console,
  }
  vm.runInNewContext(src, sandbox, { filename: 'lib/client.js' })
  return plugin
}

/* ───────────── tokenAudit（测试内辅助，不是生产代码） ───────────── */
function cssText() {
  const start = code.indexOf('const CSS = [')
  const end = code.indexOf('\n    ]', start)
  assert.ok(start >= 0 && end > start, 'CSS array must exist')
  return vm.runInNewContext('(' + code.slice(start + 'const CSS = '.length, end + 6) + ')').join('\n')
}
/** 把 CSS 切成顶层规则与 at-rule 块（简单括号计数，足够本文件的 CSS）。 */
function splitTop(css) {
  const top = []
  const at = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const head = css.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++ }
    const body = css.slice(open + 1, j - 1)
    if (head.startsWith('@')) at.push({ head, body })
    else top.push({ selector: head, body })
    i = j
  }
  return { top, at }
}
function tokenAudit(css) {
  const { top, at } = splitTop(css)
  const count = {}
  for (const r of top) for (const s of r.selector.split(',').map((x) => x.trim())) count[s] = (count[s] || 0) + 1
  const duplicates = Object.keys(count).filter((s) => count[s] > 1)
  const allRules = top.concat(at.flatMap((a) => (a.head.startsWith('@keyframes') ? [] : splitTop(a.body).top)))
  const hasRuleFor = (cls) => allRules.some((r) => new RegExp('\\.' + cls + '(?![a-z0-9-])').test(r.selector))
  // JSX 里 className 值中出现的 dra-* 类
  const outside = code.slice(0, code.indexOf('const CSS = [')) + code.slice(code.indexOf('\n    ]', code.indexOf('const CSS = [')))
  const used = new Set()
  for (const m of outside.matchAll(/className:\s*([^\n]*)/g)) {
    const seg = m[1].split(/,\s*(?:[a-zA-Z'"][\w'"-]*\s*:|key\b)/)[0]
    for (const lit of seg.matchAll(/'([^']*)'/g)) for (const t of lit[1].matchAll(/(?:^|\s)(dra-[a-z0-9-]+)/g)) used.add(t[1])
  }
  const missingRules = [...used].filter((c) => !hasRuleFor(c)).sort()
  const ruleBody = (sel) => (top.find((r) => r.selector === sel) || {}).body || ''
  const tokens = (sel) => {
    const out = {}
    for (const m of ruleBody(sel).matchAll(/(--dra-[a-z0-9-]+)\s*:\s*([^;]+)/g)) out[m[1]] = m[2].trim()
    return out
  }
  const dark = tokens('.dra-root')
  const light = tokens('.dra-light')
  const hex = (v) => { const m = /#[0-9a-f]{6}\b/i.exec(v || ''); return m ? m[0] : null }
  const lum = (h) => {
    const c = [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const contrast = []
  for (const [name, set] of [['dark', dark], ['light', light]]) {
    for (const fg of ['--dra-text', '--dra-text-dim']) {
      for (const bg of ['--dra-bg', '--dra-surface-1', '--dra-surface-2', '--dra-surface-3']) {
        const f = hex(set[fg]); const b = hex(set[bg])
        contrast.push({ theme: name, fg, bg, f, b, ratio: f && b ? ratio(f, b) : 0 })
      }
    }
  }
  return { top, at, allRules, duplicates, used, missingRules, dark, light, contrast, ruleBody, hex }
}

const CSS = cssText()
const audit = tokenAudit(CSS)
const SEMANTIC = ['--dra-bg', '--dra-surface-1', '--dra-surface-2', '--dra-surface-3', '--dra-border', '--dra-text', '--dra-text-dim',
  '--dra-text-faint', '--dra-accent', '--dra-ok', '--dra-warn', '--dra-danger', '--dra-mesh', '--dra-focus']

/* ───────────── #3 ───────────── */
test('tokens: 选中类必有 CSS 规则', () => {
  assert.ok(audit.used.has('dra-btn-primary'), 'JSX 仍使用 dra-btn-primary（主操作按钮）')
  assert.ok(audit.used.has('dra-tab'), '屏幕标签使用 dra-tab')
  assert.deepEqual(audit.missingRules, [], 'JSX 里用到的每个 dra-* 类都必须有 CSS 规则：' + audit.missingRules.join(' '))
  // 选中态：屏幕标签以 aria-selected 表达，且有底部 2px 条（不只靠颜色）
  const sel = audit.allRules.find((r) => /\.dra-tab\[aria-selected="true"\]/.test(r.selector) && !/:hover|:focus/.test(r.selector))
  assert.ok(sel, '必须有 .dra-tab[aria-selected="true"] 规则')
  assert.match(sel.body, /box-shadow:inset 0 -2px 0 var\(--dra-accent\)|border-bottom:2px solid/, '选中态必须有底部 2px 条')
  assert.ok(audit.allRules.some((r) => r.selector.split(',').map((s) => s.trim()).includes('.dra-btn-primary')), '.dra-btn-primary 必须有规则')
})

/* ───────────── #4 ───────────── */
test('tokens: 无重复选择器', () => {
  for (const s of ['.dra-main-grid', '.dra-col', '.dra-hint', '.dra-banner']) {
    const n = audit.top.filter((r) => r.selector.split(',').map((x) => x.trim()).includes(s)).length
    assert.equal(n, 1, s + ' 只能定义一次（当前 ' + n + ' 次）')
  }
  assert.deepEqual(audit.duplicates, [], '顶层选择器不得重复：' + audit.duplicates.join(' | '))
})

/* ───────────── #5 ───────────── */
test('tokens: 浅色回退完整', () => {
  for (const t of SEMANTIC) {
    assert.ok(t in audit.dark, '暗色（.dra-root）缺 ' + t)
    assert.ok(t in audit.light, '浅色（.dra-light）缺 ' + t)
  }
  // 暗色定义的每个 --dra-* token（除纯尺寸/字体/别名外）在浅色也有定义
  const themeless = /^--dra-(r-|mono|sans|s[0-3]$|line$|dim$|faint$|space-|fs-|lh-)/
  const missing = Object.keys(audit.dark).filter((k) => !themeless.test(k) && !(k in audit.light))
  assert.deepEqual(missing, [], '浅色缺少：' + missing.join(' '))
  // 精确值（§4.2 表）
  const want = {
    '--dra-bg': ['#05070d', '#eef2f8'], '--dra-surface-1': ['#0b0e18', '#ffffff'], '--dra-surface-2': ['#111523', '#f4f7fc'],
    '--dra-surface-3': ['#171d2e', '#e9eff8'], '--dra-text': ['#e0e6f0', '#17202f'], '--dra-text-dim': ['#8a98b5', '#4a5a73'],
    '--dra-accent': ['#2ee6ff', '#1b6ef3'], '--dra-ok': ['#25e58c', '#1a9e6b'], '--dra-warn': ['#ffb547', '#b87010'],
    '--dra-danger': ['#ff4d6e', '#c92b4a'], '--dra-mesh': ['#a78bfa', '#6d4fd6'],
  }
  for (const [k, [d, l]] of Object.entries(want)) {
    assert.equal(audit.hex(audit.dark[k]), d, k + ' 暗色')
    assert.equal(audit.hex(audit.light[k]), l, k + ' 浅色')
  }
  assert.match(audit.dark['--dra-border'], /rgba\(120,165,255,\.14\)/)
  assert.match(audit.light['--dra-border'], /rgba\(30,60,110,\.14\)/)
  assert.equal(audit.dark['--dra-focus'], 'var(--dra-accent)')
  assert.equal(audit.light['--dra-focus'], 'var(--dra-accent)')
  // 宿主变量（若存在）→ 内置回退
  for (const t of ['--dra-bg', '--dra-text', '--dra-accent']) {
    assert.match(audit.dark[t], /^var\(--dra-host-[a-z0-9-]+,\s*#[0-9a-f]{6}\)$/i, t + ' 暗色必须先查宿主变量再回退')
    assert.match(audit.light[t], /^var\(--dra-host-[a-z0-9-]+,\s*#[0-9a-f]{6}\)$/i, t + ' 浅色必须先查宿主变量再回退')
  }
  // 去掉写死的青色 rgba：一律走 token / color-mix
  assert.doesNotMatch(CSS, /rgba\(46,230,255/, 'CSS 不得写死青色 rgba')
  // 浅色关闭发光
  assert.equal(audit.light['--dra-glow-sm'], 'none')
  assert.equal(audit.light['--dra-glow-md'], 'none')
})

/* ───────────── #6 ───────────── */
test('theme: 保存值＞宿主＞prefers＞暗色', () => {
  const { themeResolve } = load()
  assert.equal(typeof themeResolve, 'function')
  const vals = [undefined, null, '', 'light', 'dark', 'bogus']
  const prefs = [undefined, null, true, false]
  for (const saved of vals) for (const host of vals) for (const prefersDark of prefs) {
    const want = saved === 'light' || saved === 'dark' ? saved
      : host === 'light' || host === 'dark' ? host
        : prefersDark === true ? 'dark' : prefersDark === false ? 'light' : 'dark'
    assert.equal(themeResolve({ saved, host, prefersDark }), want, JSON.stringify({ saved, host, prefersDark }))
  }
  assert.equal(themeResolve(), 'dark')
  assert.equal(themeResolve(null), 'dark')
  assert.equal(themeResolve({ saved: 'dark', host: 'light', prefersDark: false }), 'dark')
  assert.equal(themeResolve({ saved: 'light', host: 'dark', prefersDark: true }), 'light')
  assert.equal(themeResolve({ host: 'light', prefersDark: true }), 'light')
})

/* ───────────── #7 ───────────── */
test('contrast: 正文/次要文字≥4.5:1', () => {
  assert.equal(audit.contrast.length, 16)
  for (const c of audit.contrast) {
    assert.ok(c.f && c.b, 'token 必须有可解析的十六进制回退：' + JSON.stringify(c))
    assert.ok(c.ratio >= 4.5, `${c.theme} ${c.fg}(${c.f}) on ${c.bg}(${c.b}) = ${c.ratio.toFixed(2)}:1 < 4.5:1`)
  }
  for (const c of audit.contrast.filter((x) => x.fg === '--dra-text')) assert.ok(c.ratio >= 7, '正文 ≥7:1')
  // --dra-text-faint 仅作装饰：任何规则都不得把它作为文字颜色
  const bad = audit.allRules.filter((r) => /(^|;)\s*color:var\(--dra-(text-)?faint\)/.test(r.body)).map((r) => r.selector)
  assert.deepEqual(bad, [], 'faint 不得承载文字：' + bad.join(' | '))
})

/* ───────────── #12 ───────────── */
test('a11y: 焦点环/最小目标尺寸/状态不只靠颜色', () => {
  const focus = audit.top.find((r) => r.selector === '.dra-root :focus-visible')
  assert.ok(focus, '必须有全局 .dra-root :focus-visible 规则')
  assert.match(focus.body, /outline:2px solid var\(--dra-focus\)/)
  assert.match(focus.body, /outline-offset:2px/)
  // 最小目标尺寸 32px，触屏 40px
  const target = audit.top.find((r) => /\.dra-btn\b/.test(r.selector) && /\.dra-tab\b/.test(r.selector) && /min-height:32px/.test(r.body))
  assert.ok(target, '按钮与标签最小 32px')
  assert.match(target.body, /min-width:32px/)
  const coarse = audit.at.find((a) => /pointer:\s*coarse/.test(a.head))
  assert.ok(coarse && /min-height:40px/.test(coarse.body), '触屏紧凑下 40px')
  // hover 不位移；disabled = .45 + not-allowed
  const hover = audit.top.filter((r) => /:hover/.test(r.selector) && /transform:translateY/.test(r.body)).map((r) => r.selector)
  assert.deepEqual(hover, [], 'hover 不得位移：' + hover.join(' | '))
  const dis = audit.top.find((r) => /\.dra-btn:disabled/.test(r.selector))
  assert.match(dis.body, /opacity:\.45/)
  assert.match(dis.body, /cursor:not-allowed/)
  // 状态不只靠颜色：横幅与状态徽章带图标字形
  for (const s of ['.dra-banner.err .dra-banner-title::before', '.dra-banner.ok .dra-banner-title::before', '.dra-badge.ok::before', '.dra-badge.warn::before', '.dra-badge.bad::before']) {
    const r = audit.top.find((x) => x.selector.split(',').map((y) => y.trim()).includes(s))
    assert.ok(r && /content:"[^"]+"/.test(r.body), s + ' 必须带图标字形')
  }
  // 强制颜色：选中用边框；减少动效保留
  const forced = audit.at.find((a) => /forced-colors:\s*active/.test(a.head))
  assert.ok(forced && /\.dra-tab\[aria-selected="true"\][^{]*\{[^}]*border/.test(forced.body), '强制颜色模式用边框表达选中')
  assert.ok(audit.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a.head) && /animation:none !important/.test(a.body)))
  // 响应式按容器宽度（不用视口宽度）：主/次栏 flex 换行，基准 724+362+12=1098 ≤ 1100 → ≥1100 两栏、比例恒为 2:1，更窄时次栏折到主栏下
  assert.ok(!audit.at.some((a) => /@media \([^)]*width/.test(a.head)), '不再用视口宽度断点')
  assert.match(audit.ruleBody('.dra-screen-body'), /display:flex/)
  assert.match(audit.ruleBody('.dra-screen-body'), /flex-wrap:wrap/)
  assert.match(audit.ruleBody('.dra-screen-body'), /gap:12px/)
  assert.match(audit.ruleBody('.dra-screen-primary'), /flex:2 1 724px/)
  assert.match(audit.ruleBody('.dra-screen-secondary'), /flex:1 1 362px/)
  // <720：摘要 2 列、tablist 横向滚动（容器查询挂在不含 fixed 后代的摘要区上）
  assert.match(audit.ruleBody('.dra-screen-summary'), /container:dra-summary\/inline-size/)
  const narrow = audit.at.find((a) => /@container dra-summary \(max-width:719px\)/.test(a.head))
  assert.ok(narrow && /\.dra-statbar\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/.test(narrow.body), '<720 摘要 2 列')
  assert.match(audit.ruleBody('.dra-tablist'), /overflow-x:auto/)
  // A1 全屏拓扑是 position:fixed：外壳根与主区不得建立容器/包含块
  for (const s of ['.dra-root', '.dra-screen', '.dra-screen-body', '.dra-screen-primary']) {
    assert.doesNotMatch(audit.ruleBody(s), /container|contain:|transform|filter/, s + ' 不得成为 fixed 后代的包含块')
  }
  // 字阶：正文 13/1.5；SVG 文字最小 10px
  assert.match(audit.ruleBody('.dra-root'), /font-size:13px/)
  const tiny = []
  for (const r of audit.allRules) for (const m of r.body.matchAll(/font-size:([\d.]+)px/g)) if (Number(m[1]) < 10) tiny.push(r.selector + ' ' + m[1])
  assert.deepEqual(tiny, [], 'CSS 文字不得小于 10px：' + tiny.join(' | '))
})
