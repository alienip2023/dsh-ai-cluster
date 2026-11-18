// review-fix A / item 1: the create-Bot node dropdown also offers nodes the computers screen
// (/overview -> state.nodes) already knows are online, even when the /bots roster has none of them.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const clientSrc = fs.readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
function loadClient() {
  let plugin = null
  vm.runInNewContext(clientSrc, {
    console,
    window: { __ModuleLoader__: { load(m) {
      plugin = m.factory(() => ({
        createElement(type, props, ...kids) { return { type, props: props || {}, kids: kids.flat(Infinity) } },
        useState(v) { return [v, () => {}] }, useEffect() {}, useRef(v) { return { current: v } }, useMemo(fn) { return fn() },
      }))
    } } },
  })
  return plugin
}
const walk = (el, fn) => { if (el && typeof el === 'object') { fn(el); for (const k of el.kids || []) walk(k, fn) } }
// The client runs in a vm realm; compare plain copies so prototypes do not matter.
const plain = (x) => JSON.parse(JSON.stringify(x))
const FORM0 = { nodeId: '', botId: '', name: '', role: '', modelRef: '', workDir: '', instructions: '' }

function options(P, nodes) {
  const form = P.botFormView({ form: FORM0, nodes, busy: false, note: '', noteOk: false, onChange() {}, onSubmit() {}, onCancel() {} })
  const opts = []
  walk(form, (e) => { if (e.type === 'option' && e.props.value) opts.push({ value: e.props.value, label: e.kids.join('') }) })
  return opts
}

const overview = [
  { nodeId: 'n-old', hostname: 'OLD', online: true },
  { nodeId: 'n-new', hostname: 'NEW', online: true },
  { nodeId: 'n-off', hostname: 'OFF', online: false },
]

test('online node absent from the roster is offered, with an empty bot list, and is selectable', () => {
  const P = loadClient()
  const av = P.screenAvailability({ ok: true, total: 1, nodes: [{ nodeId: 'n-old', hostname: 'OLD', online: true, bots: [{ id: 'b1' }] }] }, 200)
  const nodes = P.botNodes(av, overview)
  assert.deepEqual(plain(nodes.map((n) => n.nodeId)), ['n-old', 'n-new'])
  assert.deepEqual(plain(nodes.find((n) => n.nodeId === 'n-new').bots), [])
  assert.deepEqual(options(P, nodes), [{ value: 'n-old', label: 'OLD' }, { value: 'n-new', label: 'NEW' }])
})

test('roster total === 0 (kind empty) still offers every online overview node; offline is never offered', () => {
  const P = loadClient()
  const av = P.screenAvailability({ ok: true, total: 0, nodes: [] }, 200)
  assert.equal(av.kind, 'empty', 'the not-collected / none distinction on the roster itself is unchanged')
  const nodes = P.botNodes(av, overview)
  assert.deepEqual(options(P, nodes).map((o) => o.value), ['n-old', 'n-new'])
  assert.ok(!nodes.some((n) => n.nodeId === 'n-off'))
})

test('roster error + no overview data: dropdown is empty, nothing invented', () => {
  const P = loadClient()
  const av = P.screenAvailability({ ok: false, code: 'x' }, 200)
  assert.equal(av.kind, 'error')
  assert.deepEqual(plain(P.botNodes(av, undefined)), [])
  assert.deepEqual(plain(P.botNodes(null, null)), [])
})

test('a roster entry wins over the overview entry (no duplicates)', () => {
  const P = loadClient()
  const av = P.screenAvailability({ ok: true, total: 1, nodes: [{ nodeId: 'n-new', hostname: 'ROSTER', online: true, bots: [{ id: 'b' }] }] }, 200)
  const nodes = P.botNodes(av, overview)
  assert.equal(nodes.filter((n) => n.nodeId === 'n-new').length, 1)
  assert.equal(nodes.find((n) => n.nodeId === 'n-new').hostname, 'ROSTER')
})

test('an offline roster node is still filtered out of the form', () => {
  const P = loadClient()
  const av = P.screenAvailability({ ok: true, total: 1, nodes: [{ nodeId: 'n-r', hostname: 'R', online: false, bots: [] }] }, 200)
  assert.deepEqual(plain(options(P, P.botNodes(av, []))), [])
})

test('the panel feeds the form from the existing overview state, with no second polling loop', () => {
  assert.match(clientSrc, /nodes: botNodes\(screenData\.bots, state\.nodes\)/)
  assert.equal((clientSrc.match(/setInterval\(/g) || []).length, 1, 'still exactly one setInterval')
})
