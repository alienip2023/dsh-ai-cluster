import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../../lib/client.js'), 'utf8')
const screens = ['computers', 'tasks', 'bots', 'models', 'memory']

// Use the discovery test's VM loader, preserving Panel's first state hook across renders.
function loadView(initial = {}) {
  let plugin, Panel
  let panelState
  let readPanelState = false
  const calls = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) {
          plugin = mod.factory(function (id) {
            if (id !== 'react') throw new Error('unexpected require ' + id)
            return {
              createElement(type, props, ...children) {
                const attrs = { ...props, children }
                delete attrs.key
                return typeof type === 'function' ? type(attrs) : { type, props: attrs, children }
              },
              useState(v) {
                if (readPanelState) {
                  readPanelState = false
                  panelState ??= { ...v, loading: false, mode: 'hub', role: 'hub', ...initial }
                  return [panelState, next => {
                    panelState = typeof next === 'function' ? next(panelState) : next
                  }]
                }
                return [typeof v === 'function' ? v() : v, function () {}]
              },
              useEffect() {},
              useRef(v) { return { current: v } },
              useMemo(fn) { return fn() },
            }
          })
        },
      },
    },
    console,
    fetch(url) {
      calls.push(url)
      throw new Error('unexpected fetch ' + url)
    },
  }
  vm.runInNewContext(src, sandbox, { filename: 'lib/client.js' })
  plugin.apply({ slots: {
    inject(name, register) { if (name === 'main') register() },
    register(_slot, component) { Panel = component },
  } })
  return {
    plugin, calls,
    render() {
      readPanelState = true
      return Panel()
    },
  }
}

const elements = tree => Array.isArray(tree) ? Array.from(tree).flatMap(elements)
  : tree && typeof tree === 'object' ? [tree, ...elements(tree.children)] : []
const withClass = (tree, className) => elements(tree).find(e => e.props.className === className)
const button = (tree, label) => elements(tree).find(e => e.type === 'button' &&
  e.children.length === 1 && e.children[0] === label)
const sections = tree => elements(tree).filter(e => e.type === 'section' && e.props['aria-label'] === '设置')
const discoverySwitches = tree => elements(tree).filter(e => e.type === 'button' &&
  e.props.role === 'switch' && e.props['aria-label'] === '局域网发现')

function assertOpenSettings(tree, enabled) {
  const [section, extra] = sections(tree)
  assert.ok(section, 'expected a 设置 section')
  assert.equal(extra, undefined)
  assert.equal(withClass(tree, 'dra-screen-primary').children[0], section)
  assert.ok(button(section, '切换角色'), 'expected the config block inside settings')
  const [toggle, extraToggle] = discoverySwitches(section)
  assert.ok(toggle, 'expected a discovery switch inside settings')
  assert.equal(extraToggle, undefined)
  assert.equal(toggle.children[0], enabled ? '关闭' : '开启')
  assert.equal(toggle.props['aria-checked'], enabled)
  const scan = button(section, '扫描')
  assert.ok(scan, 'expected a scan button inside settings')
  assert.equal(scan.props.disabled, !enabled)
}

test('SETTINGS-BTN', () => {
  const tree = loadView().render()
  const tools = withClass(withClass(tree, 'dra-shell-head'), 'dra-tools')
  const settings = button(tools, '设置')
  assert.ok(settings, 'expected a 设置 button in the hub toolbar')
  assert.equal(settings.props['aria-label'], '设置')
  assert.equal(tools.children[0], settings)
  assert.equal(tools.children[1].children[0].props.type, 'checkbox')
})

test('SETTINGS-OPEN', () => {
  for (const screen of screens) {
    const view = loadView({ screen })
    const closed = view.render()
    assert.equal(sections(closed).length, 0)
    const settings = button(closed, '设置')
    assert.ok(settings, 'expected a 设置 button on ' + screen)
    settings.props.onClick()
    const opened = view.render()
    assertOpenSettings(opened, false)
    assert.equal(discoverySwitches(opened).length, screen === 'computers' ? 2 : 1)
    assert.deepEqual(view.calls, [], 'opening settings must not fetch')
  }
})

test('SETTINGS-TOPO', () => {
  const view = loadView({ computersMode: 'topo', discovery: { enabled: true, peers: [] } })
  const closed = view.render()
  assert.equal(discoverySwitches(closed).length, 0)
  assert.equal(button(closed, '扫描'), undefined)
  const settings = button(closed, '设置')
  assert.ok(settings, 'expected a 设置 button in topology')
  settings.props.onClick()
  const opened = view.render()
  assertOpenSettings(opened, true)
  assert.equal(discoverySwitches(opened).length, 1)
  button(opened, '设置').props.onClick()
  const reclosed = view.render()
  assert.equal(sections(reclosed).length, 0)
  assert.equal(discoverySwitches(reclosed).length, 0)
  button(reclosed, '设置').props.onClick()
  assertOpenSettings(view.render(), true)
  assert.deepEqual(view.calls, [], 'opening and closing settings must not fetch')
})

test('SETTINGS-SCREENS', () => {
  // Merged design: bots, models and memory became sections of one 'team' screen, computers became 'nodes'.
  // `screens` above still lists the legacy ids on purpose: SETTINGS-OPEN checks they all keep rendering the settings
  // button, and selectHubScreen must keep mapping them onto the merged screens.
  const { plugin } = loadView()
  assert.deepEqual(Array.from(plugin.P2_SCREENS, entry => entry[0]), ['nodes', 'tasks', 'team'])
  const mapped = Object.fromEntries(screens.map(id => [id, plugin.selectHubScreen({ screen: id })]))
  assert.deepEqual(mapped, { computers: 'nodes', tasks: 'tasks', bots: 'team', models: 'team', memory: 'team' })
})
