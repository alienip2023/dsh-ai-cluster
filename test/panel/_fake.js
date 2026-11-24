// 面板测试工具：假 React + 把组件树展开成宿主节点，便于断言文字与结构。
// useState 只返回初值（想测某个状态分支，用 opts.state 按调用顺序塞值）；useEffect 不执行。
import { createCore } from '../../src/panel/core.js'

export function makeReact(opts = {}) {
  const queue = [...(opts.state || [])]
  const R = {
    createElement(type, props, ...kids) {
      const p = props || {}
      const flat = kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)
      return { type, props: p, kids: flat }
    },
    Fragment: 'fragment',
    useState(v) { const init = queue.length ? queue.shift() : v; return [typeof init === 'function' ? init() : init, () => {}] },
    useEffect() {}, useLayoutEffect() {}, useRef(v) { return { current: v } }, useMemo(fn) { return fn() }, useCallback(fn) { return fn },
  }
  return R
}

export function makeCore(opts) { return createCore(makeReact(opts)) }

/** 展开函数组件，返回只含宿主节点（字符串 type）的树。 */
export function expand(el) {
  if (el === null || el === undefined || el === false) return null
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return { type: 'fragment', props: {}, kids: el.map(expand).filter((x) => x !== null) }
  if (typeof el.type === 'function') return expand(el.type({ ...el.props, children: el.kids.length <= 1 ? el.kids[0] : el.kids }))
  return { type: el.type, props: el.props, kids: el.kids.map(expand).filter((x) => x !== null) }
}

export function texts(el, out = []) {
  if (typeof el === 'string') out.push(el)
  else if (el && typeof el === 'object') for (const k of el.kids || []) texts(k, out)
  return out
}
export const textOf = (el) => texts(expand(el)).join('')

export function findAll(el, pred, out = []) {
  if (!el || typeof el !== 'object') return out
  if (pred(el)) out.push(el)
  for (const k of el.kids || []) findAll(k, pred, out)
  return out
}
export const findByClass = (el, cls) => findAll(expand(el), (n) => typeof n.props?.className === 'string' && n.props.className.split(/\s+/).includes(cls))
export const findButtons = (el, label) => findAll(expand(el), (n) => n.type === 'button' && texts(n).join('').includes(label))
