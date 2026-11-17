/** xfer 内部路径助手：逐字复制自 src/fsbox（glob.js normalizePath/isAbsolutePath、index.js isDenied）。
 * 原因：slice 4 指挥官更正 #3 只允许从 wire/store/caps 导入。fsbox 开放后应改为直接导入并删除本文件。 */
const SEP_RE = /[\\/]+/g

/**
 * 归一化为匹配用的规范形式：`/` 分隔、去尾分隔。
 *
 * UNC 处理（D1-1 修复）：`\\server\share\x` 统一折叠成 `/server/share/x`。
 * 早期版本这里写 `if (/^\/\//.test(s)) s = '/' + s.replace(/^\/+/, '')` ——
 * 那是个**空操作**（正则匹配的 `//` 先被 `SEP_RE` 折成 `/`，所以条件永远不成立），
 * 但注释声称"保留 UNC 前缀的双斜杠"，与行为不符。
 *
 * 选择折叠而不是保留，理由是 `isInside` 用在**安全边界**上：
 *   - 折叠后 `/server/share` 与 POSIX 路径同形，前缀比较语义一致且可预测
 *   - 若保留双斜杠，`//server/share` 与 `/server/share` 会成为两个不同的字符串，
 *     同一条路径两种写法可能绕过前缀比较 —— 那才是真正的安全隐患
 * 所以注释改为与行为一致，并明确这是刻意的折叠。
 */
export function normalizePath(p, { caseInsensitive = false } = {}) {
  if (typeof p !== 'string') return ''
  let s = p.replace(SEP_RE, '/')
  // 折叠后可能留下多重前导斜杠（如 `\\?\C:\x` 或 `////x`），统一成一个
  if (s.length > 1 && s.startsWith('/')) s = `/${s.replace(/^\/+/, '')}`
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '')
  if (caseInsensitive) s = s.toLowerCase()
  return s
}

/** 判断是否绝对路径（POSIX / 盘符 / UNC）。 */
export function isAbsolutePath(p) {
  if (typeof p !== 'string' || p === '') return false
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)
}

/**
 * 判断路径是否被 denyPaths 拦下。
 *
 * 两种写法都必须生效（与 artifacts.js 的 walk 同一条规则）：
 *   - 绝对条目：直接与 absPath 比前缀
 *   - 相对条目：在 absPath 的**任意段边界**上做连续段匹配
 *
 * 为什么相对条目要单独处理：本函数的真实调用方（task-engine.snapshotWorkspace）
 * 传进来的 absPath 是绝对路径，而 cfg.denyPaths / 任务 constraints.denyPaths 都是
 * 任意字符串。相对条目与绝对路径永不相等 → 相对 denyPaths 被**静默忽略** ——
 * 与 artifacts.js 修过的 D1 完全同类（"有时管用"最危险）。方向取保守：
 * 宁可多拒一条变更记录，也不能让被禁路径的内容照常上报给 hub。
 */
export function isDenied(absPath, denyPaths, { caseInsensitive = false } = {}) {
  const p = normalizePath(absPath, { caseInsensitive })
  if (p === '') return false
  for (const raw of denyPaths ?? []) {
    // 非字符串 / 空串条目必须**显式跳过**，不能交给 normalizePath 兜。
    // 历史缺陷：normalizePath('') / (null) / (42) 都返回 ''，而空条目的比对是
    // `p === '' || p.startsWith('/')` ——
    //   POSIX：归一化结果是 '/etc/passwd'，startsWith('/') 恒真 → 一个空条目
    //          把整张 deny 表变成"全部拒绝"（变更报告静默变空）
    //   Windows：归一化结果是 'c:/work/a'，不以 '/' 开头 → 同一个空条目变成
    //          "什么都不拒"（禁路径静默失效）
    // 同一个非法输入在两种平台上给出相反的极端行为，且两边都是静默的。
    if (typeof raw !== 'string') continue
    if (raw.trim() === '') continue
    const nd = normalizePath(raw, { caseInsensitive })
    // ⚠ 这一行（L3）是**行为不可观测**的纵深防御，不是可被测试证明的守卫。
    //
    // 穷举 928 组输入逐层移除的实测结论（captain + verifier 各自独立得出）：
    //   L1 `typeof` 守卫   → 可观测（移除后 180 处行为差异）
    //   L2 `trim()` 守卫   → 可观测（移除后 6 处差异；`'   '` 是唯一只有它能拦的形态，
    //                        因为 normalizePath **不做 trim**）
    //   L3 本行           → **不可观测**：所有能让 nd === '' 的输入，要么已被 L1 拦下，
    //                        要么会在紧接着的 `if (segs.length === 0) continue` 被拦。
    //
    // 所以：**任何测试都无法证明本行存在**（删掉它测试仍全绿）。保留它是为了在
    // "normalizePath 将来改了行为"或"上面几层被调整"时仍有兜底。请勿以"测试全过"
    // 当作它有效的证据 —— 也不要因为它删掉不掉测试而误判它是死代码就移除。
    if (nd === '') continue

    if (isAbsolutePath(raw)) {
      // 根路径：deny '/' 就该拒掉一切，否则 '/etc/passwd' 因 '//' 前缀比不中而漏过
      if (nd === '/') return true
      if (p === nd || p.startsWith(`${nd}/`)) return true
      continue
    }

    const segs = nd.split('/').filter(Boolean)
    if (segs.length === 0) continue
    const pSegs = p.split('/').filter(Boolean)
    for (let start = 0; start + segs.length <= pSegs.length; start += 1) {
      let same = true
      for (let i = 0; i < segs.length; i += 1) {
        if (pSegs[start + i] !== segs[i]) {
          same = false
          break
        }
      }
      if (same) return true
    }
  }
  return false
}
