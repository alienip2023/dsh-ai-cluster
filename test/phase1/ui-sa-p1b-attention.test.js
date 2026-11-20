import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import vm from 'node:vm'

const src = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
const screens = [['computers', '电脑'], ['tasks', '交办'], ['bots', '机器人'], ['models', '模型'], ['memory', '记忆']]
const open = { ticketId: 'tk_open', state: 'open', hasExecutor: true }
const ended = { ticketId: 'tk_ended', state: 'ended', hasExecutor: false }
const interrupted = { ticketId: 'tk_interrupted', state: 'interrupted', hasExecutor: true }
const digest = text => createHash('sha256').update(text).digest('hex')
const plain = value => JSON.parse(JSON.stringify(value))

function loadView({ code = src, initial = {}, fetch } = {}) {
  let plugin, Panel, state, timer, cursor, renderingPanel
  const hooks = []
  const effects = []
  const react = {
    createElement(type, props, ...children) { return { type, props, children } },
    useState(value) {
      const init = () => typeof value === 'function' ? value() : value
      if (!renderingPanel) return [init(), () => {}]
      const slot = cursor++
      if (!(slot in hooks)) hooks[slot] = slot === 0 ? { ...init(), ...initial } : init()
      return [hooks[slot], next => {
        hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next
        if (slot === 0) state = hooks[slot]
      }]
    },
    useRef(value) {
      if (!renderingPanel) return { current: value }
      const slot = cursor++
      return hooks[slot] ??= { current: value }
    },
    useEffect(effect) { if (renderingPanel) effects.push(effect) },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(mod) {
      plugin = mod.factory(id => {
        assert.equal(id, 'react')
        return react
      })
    } } },
    console,
    fetch,
    setInterval(fn) { timer = fn },
    clearInterval() {},
  }
  vm.runInNewContext(code, sandbox, { filename: 'lib/client.js' })
  plugin.apply({ slots: {
    inject(name, register) { if (name === 'main') register() },
    register(_slot, component) { Panel = component },
  } })

  function snapshot(node) {
    if (Array.isArray(node)) return Array.from(node).flat(Infinity).filter(value => value != null && typeof value !== 'boolean').map(snapshot)
    if (node == null || typeof node !== 'object') return node
    const { type, props, children } = node
    if (typeof type === 'function') return snapshot(type({ ...props, children }))
    const attributes = Object.fromEntries(Object.entries(props ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === 'function' ? 'function:' + digest(String(value)) : value]))
    const content = type === 'style' ? [digest(children.join(''))] : snapshot(children)
    return [type, plain(attributes), content]
  }

  return {
    plugin,
    tree() {
      effects.length = 0
      cursor = 0
      renderingPanel = true
      const result = Panel()
      renderingPanel = false
      return snapshot(result)
    },
    mount() { this.tree(); effects.forEach(effect => effect()) },
    poll() { timer() },
    state() { return state },
  }
}

function screenTree(screen, ticketProps = {}, code = src) {
  return loadView({ code, initial: { loading: false, mode: 'hub', role: 'hub', screen, ...ticketProps } }).tree()
}

function* elements(node) {
  if (!Array.isArray(node)) return
  yield node
  for (const child of node[2]) yield* elements(child)
}

function findFolds(tree) {
  return [...elements(tree)].filter(node => node[0] === 'details' &&
    JSON.stringify(node[2][0]).includes('待你处理'))
}

function removeNode(node, removed) {
  if (!Array.isArray(node)) return node
  const [type, props, children] = node
  return [type, props, children.filter(child => child !== removed).map(child => removeNode(child, removed))]
}

// The discovery card has its own rendering contract in ui-p2-discovery.test.js.
function withoutDiscoveryCard(tree) {
  const card = [...elements(tree)].find(node => node[0] === 'section' &&
    node[2][0]?.[2]?.some(child => child[0] === 'h3' && child[2][0] === '局域网发现'))
  return card ? removeNode(tree, card) : tree
}

// The pinned structural tree is embedded below so the suite runs without a git
// checkout or an environment variable. An explicit pristine client additionally
// allows the embedded tree to be checked against the pin during verification.
const tools = ["div", {"className":"dra-tools"}, [
  ["button", {"type":"button","className":"dra-btn","aria-label":"设置","aria-expanded":false,"onClick":"function:3eafe8cd6a30b708951cd17ab12a73871d9ab7d3cc35f6ced47a3e83012d30fb"}, ["设置"]],
  ["label", {"className":"dra-check","title":"每 8 秒自动刷新"}, [
    ["input", {"type":"checkbox","checked":true,"onChange":"function:1f630a2c2d8692ccb42ca1af3d937be5ee7d7c6a21a282cae73a6717d85fb4c6"}, []],
    ["span", {}, ["自动"]],
  ]],
  ["button", {"className":"dra-btn","title":"切换到浅色","aria-label":"切换到浅色","onClick":"function:ccfd994f6950ebd146b83c0d66ed28595c41b073ee6ee8b6d33d478d06ea1ef7"}, ["☀"]],
  ["button", {"className":"dra-btn primary","onClick":"function:72601786d92a5790a8fb3cf00168b3cdf168d6a35432b4f0289f2921ed50a0ab","disabled":false,"aria-busy":"false"}, ["刷新"]],
]]
const shell_head = ["header", {"className":"dra-shell-head"}, [
  ["div", {"className":"dra-brand"}, [["span", {"className":"dra-brand-dot"}, []], ["span", {}, ["AI 集群控制"]]]],
  ["div", {"className":"dra-modes"}, [["span", {"className":"dra-mode-txt"}, [["b", {}, ["主机"]]]]]],
  tools,
]]
const tab = ["button", {"key":"tasks","id":"tab-tasks","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-tasks","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
  "交办",
  ["span", {"className":"dra-tab-count","aria-hidden":"true"}, ["0"]],
]]
const statbar = ["div", {"className":"dra-statbar"}, [
  ["div", {"className":"dra-stat"}, [
    ["div", {"className":"dra-stat-value"}, ["0"]],
    ["div", {"className":"dra-stat-label"}, ["节点总数"]],
    ["div", {"className":"dra-stat-tip"}, ["注册到本 hub 的副机数量"]],
  ]],
  ["div", {"className":"dra-stat ok"}, [["div", {"className":"dra-stat-value"}, ["0"]], ["div", {"className":"dra-stat-label"}, ["在线"]], ["div", {"className":"dra-stat-tip"}, ["当前握手在线的副机"]]]],
  ["div", {"className":"dra-stat acc"}, [
    ["div", {"className":"dra-stat-value"}, ["0"]],
    ["div", {"className":"dra-stat-label"}, ["任务中"]],
    ["div", {"className":"dra-stat-tip"}, ["运行中 + 排队 + 待批准"]],
  ]],
  ["div", {"className":"dra-stat ok"}, [
    ["div", {"className":"dra-stat-value"}, ["0"]],
    ["div", {"className":"dra-stat-label"}, ["已完成"]],
    ["div", {"className":"dra-stat-tip"}, ["历史任务中 status=completed 的数量"]],
  ]],
  ["div", {"className":"dra-stat bad"}, [
    ["div", {"className":"dra-stat-value"}, ["0"]],
    ["div", {"className":"dra-stat-label"}, ["失败"]],
    ["div", {"className":"dra-stat-tip"}, ["failed / aborted / rejected 的数量"]],
  ]],
]]
const card_body = ["div", {"className":"dra-card-body"}, [
  ["div", {"className":"dra-field"}, [["span", {"className":"dra-label"}, ["连接方式（在线节点上报）"]], ["span", {}, ["未知（暂无在线节点）"]]]],
  ["div", {"className":"dra-field"}, [
    ["label", {"className":"dra-label"}, ["中继地址（relayUrl）· 可选"]],
    ["input", {"className":"dra-input dra-mono","value":"","placeholder":"ws://<主机地址>:8890/relay","onChange":"function:ebbb77aedc3d0d8c67aa2478741e16910f9a899a07b34eda68a10dc4a65a0162"}, []],
  ]],
  ["div", {"className":"dra-field"}, [
    ["label", {"className":"dra-label"}, ["主机口令（hubToken）"]],
    ["input", {"className":"dra-input dra-mono","type":"password","value":"","placeholder":"留空表示沿用当前口令","onChange":"function:339ff2ce1f928b2c70f9217a667f58306b2a382eff8f97c2f022974224a296ca"}, [
    ]],
  ]],
  ["div", {"className":"dra-row","style":{"justifyContent":"space-between","marginTop":2}}, [
    ["span", {"className":"dra-hint"}, ["主机口令未设置（独立监听只能绑回环，副机连不上）"]],
    ["button", {"className":"dra-copy","title":"复制","onClick":"function:73ee2dd680584694d515cb58697161159ac70a0832dead8c29ed8d5faa438219"}, ["复制配置模板"]],
  ]],
  ["div", {"className":"dra-hint","style":{"marginTop":6}}, ["以上地址写回 profile 的 cordis.patch.yml 后重启 DSH 生效；面板只做本地编辑与复制。"]],
]]
const card = ["section", {"className":"dra-card"}, [
  ["div", {"className":"dra-card-head"}, [
    ["h3", {"className":"dra-card-title","style":{"margin":0}}, ["接入与配置"]],
    ["span", {"className":"dra-card-sub"}, ["Hub 模式"]],
    ["div", {"className":"dra-tools"}, [["span", {"className":"dra-badge soft","title":""}, ["role: —"]]]],
  ]],
  card_body,
]]
const div = ["div", {}, [
  card,
  ["div", {"className":"dra-row","style":{"marginTop":6}}, [
    ["button", {"className":"dra-btn sm","onClick":"function:04ffc2d756b88f1fc5cabb75a0159dcf6c993043f348f43e0a2eb1c9b8f94591"}, ["切换角色"]],
    ["span", {"className":"dra-hint"}, ["已配置后改角色或地址，复用同一份写盘逻辑"]],
  ]],
]]
const div3 = ["div", {}, [
  ["div", {"className":"dra-row","style":{"justifyContent":"space-between"}}, [
    ["span", {"className":"dra-hint"}, ["尚未读到监听状态"]],
    ["button", {"className":"dra-btn sm","onClick":"function:a3126cddd669dd8912b6bdcb74da0f0e82968005acc43dcbe3180b13717dcf5c"}, ["刷新配对码"]],
  ]],
  ["div", {"className":"dra-hint","style":{"marginTop":6}}, ["还没有可用配对码。先确认独立监听已启动（端口默认 19387），再点「刷新配对码」。"]],
]]
const steps = ["div", {"className":"dra-steps"}, [
  ["div", {"key":"重启 DSH","className":"dra-step"}, [["b", {}, ["1"]], ["span", {}, ["重启 DSH"]]]],
  ["div", {"key":"生成配对码","className":"dra-step"}, [["b", {}, ["2"]], ["span", {}, ["生成配对码"]]]],
  ["div", {"key":"在副机上粘贴","className":"dra-step"}, [["b", {}, ["3"]], ["span", {}, ["在副机上粘贴"]]]],
  ["div", {"key":"等它连上","className":"dra-step"}, [["b", {}, ["4"]], ["span", {}, ["等它连上"]]]],
]]
const div4 = ["div", {}, [
  ["div", {"className":"dra-hint"}, ["首次接入按这四步走，不需要手写 YAML："]],
  steps,
  ["div", {"className":"dra-hint","style":{"marginTop":5}}, ["你现在用的这台是主机；副机装好 dsh-ai-cluster 后把配对码贴进它的配置即可。"]],
]]
const div2 = ["div", {}, [
  div3,
  ["div", {}, [
    ["button", {"className":"dra-btn dra-enroll-btn","disabled":false,"onClick":"function:7ae37422d9a72f6a3f160ca19f673b6cd577396643d9ab65fb9f87a5aecdedf2"}, ["+ 添加副机（生成一次性接入口令）"]],
  ]],
  div4,
]]
const fold_body = ["div", {"className":"dra-fold-body"}, [div2]]
const fold = ["details", {"className":"dra-fold","open":true}, [["summary", {}, [["span", {}, ["副机接入"]], ["span", {"className":"dra-badge soft"}, ["先接一台"]]]], fold_body]]
const screen_secondary = ["aside", {"className":"dra-screen-secondary","aria-label":"设置与接入"}, [div, fold]]
const row2 = ["div", {"className":"dra-row"}, [
  ["button", {"className":"dra-btn sm primary","disabled":false,"onClick":"function:4c67faf579c5565cde3b40081b4b94b79a2b23378601cbffce9ce7f62b8d9255"}, ["体检"]],
  ["button", {"className":"dra-btn sm","disabled":false,"onClick":"function:e17e8d1ed942057723483114776002615f22a9f8d5e1a4a43d269c0f36bcbc2d"}, ["一键修复预览"]],
]]
const row = ["div", {"className":"dra-row","style":{"justifyContent":"space-between","marginBottom":6}}, [["span", {"className":"dra-hint"}, ["尚未体检"]], row2]]
const div5 = ["div", {}, [row, ["div", {"className":"dra-hint"}, ["点「体检」检查可达性 / inject / roots / role。"]], ["div", {"className":"dra-hint","style":{"marginTop":6}}, ["一键修复只改托管块并备份，写后校验；不会改动其它插件配置。"]]]]
const fold_body2 = ["div", {"className":"dra-fold-body"}, [div5]]
const fold2 = ["details", {"className":"dra-fold","open":false}, [["summary", {}, [["span", {}, ["环境体检"]], ["span", {"className":"dra-badge soft"}, ["未体检"]]]], fold_body2]]
const div6 = ["div", {}, [
  ["div", {"className":"dra-row","style":{"justifyContent":"space-between","marginBottom":6}}, [
    ["span", {"className":"dra-hint"}, ["尚未检测"]],
    ["button", {"className":"dra-btn sm","disabled":false,"onClick":"function:1497c42f491820bf86a3d718138c12686140b34b0e179c099077c10b0bff98b4"}, ["检测工具"]],
  ]],
  ["div", {"className":"dra-hint"}, ["点「检测工具」探测 git / node / rg 等外部工具。"]],
  ["div", {"className":"dra-tools-grid"}, []],
  ["div", {"className":"dra-hint","style":{"marginTop":6}}, ["只检测并给出安装命令，不会代你下载或执行安装。"]],
]]
const fold_body3 = ["div", {"className":"dra-fold-body"}, [div6]]
const fold3 = ["details", {"className":"dra-fold","open":false}, [["summary", {}, [["span", {}, ["检测工具"]], ["span", {"className":"dra-badge soft"}, ["未检测"]]]], fold_body3]]
const field = ["div", {"className":"dra-field","style":{"flex":"1 1 170px"}}, [
  ["label", {"className":"dra-label"}, ["共享目录"]],
  ["input", {"className":"dra-input dra-mono","value":"","placeholder":"副机工作区绝对路径（如 D:\\work），需要先在副机配置 roots","onChange":"function:a77ec4e8360e9553085ba271195da921973cb48bdd70b57ad8e1be2a76cecbf8"}, [
  ]],
]]
const row3 = ["div", {"className":"dra-row","style":{"marginTop":7}}, [
  ["div", {"className":"dra-field","style":{"flex":"1 1 150px"}}, [
    ["label", {"className":"dra-label"}, ["副机"]],
    ["select", {"className":"dra-select","value":"","onChange":"function:2d9bf808bb922f4d0aef76fbf75442384277166415af9e1763684f74bb4ad723"}, []],
  ]],
  field,
]]
const field2 = ["div", {"className":"dra-field","style":{"flex":"0 0 110px"}}, [
  ["label", {"className":"dra-label"}, ["权限"]],
  ["select", {"className":"dra-select","value":"read","onChange":"function:dc8ed57410e22a517d6d323dd06caaa110ece384d834775472a4bb5786b8f2ac"}, [
    ["option", {"value":"read"}, ["只读"]],
    ["option", {"value":"write"}, ["读写"]],
  ]],
]]
const row4 = ["div", {"className":"dra-row","style":{"marginTop":2}}, [
  field2,
  ["label", {"className":"dra-check","style":{"marginTop":14}}, [
    ["input", {"type":"checkbox","checked":false,"onChange":"function:43299ef99fcbb3c443fb79459c0d772bbd24c952de159fb597381001435e8d5b"}, []],
    ["span", {}, ["我已知情：共享会绕过 roots / denyPaths 边界"]],
  ]],
]]
const div7 = ["div", {}, [
  ["div", {"className":"dra-hint"}, ["把副机的工作区用 SMB 共享出来，主机映射成盘符后用本地 IDE 直接打开。开启后插件 roots / denyPaths 边界失效，.env 与密钥对共享方可见，风险自负。"]],
  row3,
  ["div", {"className":"dra-hint","style":{"marginTop":3}}, ["这台副机没上报 roots —— 请先在副机配置工作区；共享只允许 roots 内的目录。"]],
  row4,
  ["div", {"className":"dra-row","style":{"marginTop":6}}, [
    ["button", {"className":"dra-btn sm primary","disabled":true,"onClick":"function:a49e5527430624b4f0c1567e0844a8f7ac11a165f2af735ee77eac6009e29465"}, ["生成共享命令"]],
  ]],
]]
const fold_body4 = ["div", {"className":"dra-fold-body"}, [div7]]
const fold4 = ["details", {"className":"dra-fold","open":false}, [["summary", {}, [["span", {}, ["工作区共享（SMB）"]], ["span", {"className":"dra-badge soft"}, ["高级"]]]], fold_body4]]
const relay_precheck = ["div", {"className":"dra-relay-precheck","style":{"margin":"8px 12px","padding":"10px 14px","background":"var(--dra-warn-bg, rgba(255,180,0,0.08))","border":"1px solid var(--dra-warn)","borderRadius":"var(--dra-r-md)"}}, [
  ["div", {"className":"dra-row","style":{"marginBottom":4,"gap":8}}, [["span", {"style":{"color":"var(--dra-warn)","fontWeight":600}}, ["⚠ 中继未配置"]]]],
  ["span", {"className":"dra-dim","style":{"fontSize":11}}, ["请先点「环境检测」探测各主机，探测到中继后上桥时自动配置"]],
]]
const fold_body5 = ["div", {"className":"dra-fold-body"}, [
  relay_precheck,
  ["div", {"className":"dra-dim","style":{"padding":"8px 12px"}}, ["未找到 SSH 主机配置，请在 $DSH_HOME/dsh-ssh.json 中添加"]],
  ["div", {"className":"dra-col","style":{"gap":8}}, []],
]]
const fold5 = ["details", {"className":"dra-fold","open":false}, [["summary", {}, [["span", {}, ["从 SSH 主机部署副机"]], ["span", {"className":"dra-badge soft"}, ["未配置"]]]], fold_body5]]
const shell_foot = ["footer", {"className":"dra-shell-foot","aria-label":"工具与高级设置"}, [fold2, fold3, fold4, fold5]]
const tab2 = ["button", {"key":"computers","id":"tab-computers","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-computers","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
  "电脑",
  ["span", {"className":"dra-tab-count","aria-hidden":"true"}, ["0/0"]],
]]
const baseline = {
  computers: ["div", {"className":"dra-root","data-theme":"dark"}, [
    ["style", {"key":"dra-css"}, ["1c0c7af62bff68cea7875ac1baf81bada3d1916764e4a791bc75d1e3847c1dce"]],
    shell_head,
    ["nav", {"className":"dra-shell-nav","aria-label":"主要屏幕"}, [
      ["div", {"className":"dra-tablist","role":"tablist","aria-label":"主要屏幕","onKeyDown":"function:754c6a834ecd5b3c6d6dbdfcd5dbb70ad2c4609a62c20461e6fdd35acc7e4260"}, [
        ["button", {"key":"computers","id":"tab-computers","type":"button","role":"tab","className":"dra-tab","aria-selected":"true","aria-controls":"panel-computers","tabIndex":0,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "电脑",
          ["span", {"className":"dra-tab-count","aria-hidden":"true"}, ["0/0"]],
        ]],
        tab,
        ["button", {"key":"bots","id":"tab-bots","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-bots","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "机器人",
        ]],
        ["button", {"key":"models","id":"tab-models","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-models","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "模型",
        ]],
        ["button", {"key":"memory","id":"tab-memory","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-memory","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "记忆",
        ]],
      ]],
    ]],
    ["div", {"className":"dra-shell-status"}, []],
    ["main", {"id":"panel-computers","className":"dra-screen","role":"tabpanel","aria-labelledby":"tab-computers"}, [
      ["section", {"className":"dra-screen-summary","aria-label":"概况"}, [
        ["h2", {"className":"dra-screen-title"}, ["电脑"]],
        ["p", {"className":"dra-screen-line"}, ["0/0 台在线 · 0 个任务运行中"]],
        statbar,
      ]],
      ["div", {"className":"dra-screen-body"}, [
        ["div", {"className":"dra-screen-primary"}, [
          ["div", {"className":"dra-col"}, [
            ["div", {"className":"dra-row"}, [
              ["div", {"className":"dra-seg"}, [
                ["button", {"key":"cards","className":"active","onClick":"function:7d12771c5a6ac59ce27357179e1fbadf9e7c7e430b535171de76a22a1b6960b7"}, ["卡片"]],
                ["button", {"key":"topo","className":"","onClick":"function:7d12771c5a6ac59ce27357179e1fbadf9e7c7e430b535171de76a22a1b6960b7"}, ["拓扑"]],
              ]],
            ]],
            ["section", {"className":"dra-card"}, [
              ["div", {"className":"dra-card-head"}, [
                ["h3", {"className":"dra-card-title","style":{"margin":0}}, ["副机节点"]],
                ["span", {"className":"dra-card-sub"}, ["0/0 在线"]],
                ["div", {"className":"dra-tools"}, [["button", {"className":"dra-btn sm","onClick":"function:72601786d92a5790a8fb3cf00168b3cdf168d6a35432b4f0289f2921ed50a0ab"}, ["刷新"]]]],
              ]],
              ["div", {"className":"dra-card-body"}, [["div", {"className":"dra-empty"}, ["暂无副机节点，先在右侧「副机接入」把另一台电脑接进来"]]]],
            ]],
            ["section", {"className":"dra-card"}, [
              ["div", {"className":"dra-card-head"}, [["h3", {"className":"dra-card-title","style":{"margin":0}}, ["拓扑连接"]], ["span", {"className":"dra-card-sub"}, ["链路汇总未上报"]]]],
              ["div", {"className":"dra-card-body"}, [
                ["div", {"className":"dra-topo-wrap","style":{"height":200}}, [["div", {"className":"dra-topo-empty"}, ["暂无副机连接"]]]],
                ["div", {"className":"dra-hint dra-mesh-summary"}, ["对等候选：未上报", ""]],
                ["div", {"className":"dra-hint dra-mesh-legend","style":{"marginTop":6}}, ["实线 = 经主控直连 · 橙色虚线 = 经主控中继 · 点线 = 未知 · 点划虚线带 = 对等候选组（服务端列出，未验证，不代表可用链路）"]],
              ]],
            ]],
            ["section", {"className":"dra-card"}, [
              ["div", {"className":"dra-card-head"}, [["h3", {"className":"dra-card-title","style":{"margin":0}}, ["局域网发现"]], ["span", {"className":"dra-card-sub"}, ["0 台未配对"]]]],
              ["div", {"className":"dra-card-body"}, [["p", {"className":"dra-hint"}, ["局域网发现未开启（在设置里打开后这里会列出同网段机器）"]]]],
            ]],
          ]],
        ]],
        screen_secondary,
      ]],
    ]],
    shell_foot,
  ]],
  tasks: ["div", {"className":"dra-root","data-theme":"dark"}, [
    ["style", {"key":"dra-css"}, ["1c0c7af62bff68cea7875ac1baf81bada3d1916764e4a791bc75d1e3847c1dce"]],
    shell_head,
    ["nav", {"className":"dra-shell-nav","aria-label":"主要屏幕"}, [
      ["div", {"className":"dra-tablist","role":"tablist","aria-label":"主要屏幕","onKeyDown":"function:754c6a834ecd5b3c6d6dbdfcd5dbb70ad2c4609a62c20461e6fdd35acc7e4260"}, [
        tab2,
        ["button", {"key":"tasks","id":"tab-tasks","type":"button","role":"tab","className":"dra-tab","aria-selected":"true","aria-controls":"panel-tasks","tabIndex":0,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "交办",
          ["span", {"className":"dra-tab-count","aria-hidden":"true"}, ["0"]],
        ]],
        ["button", {"key":"bots","id":"tab-bots","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-bots","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "机器人",
        ]],
        ["button", {"key":"models","id":"tab-models","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-models","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "模型",
        ]],
        ["button", {"key":"memory","id":"tab-memory","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-memory","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "记忆",
        ]],
      ]],
    ]],
    ["div", {"className":"dra-shell-status"}, []],
    ["main", {"id":"panel-tasks","className":"dra-screen","role":"tabpanel","aria-labelledby":"tab-tasks"}, [
      ["section", {"className":"dra-screen-summary","aria-label":"概况"}, [["h2", {"className":"dra-screen-title"}, ["交办"]], ["p", {"className":"dra-screen-line"}, ["0 个任务进行中 · 共 0 个"]], statbar]],
      ["div", {"className":"dra-screen-body"}, [
        ["div", {"className":"dra-screen-primary"}, [
          ["div", {"className":"dra-col"}, [
            ["div", {"className":"dra-hint"}, ["机器人回合（bot turn）不记录逐回合状态；hub 重启后，进行中的回合结果未知，此处不追踪也不自动恢复。"]],
            ["section", {"className":"dra-card"}, [
              ["div", {"className":"dra-card-head"}, [
                ["h3", {"className":"dra-card-title","style":{"margin":0}}, ["任务"]],
                ["span", {"className":"dra-card-sub"}, ["0 条（保留历史）"]],
                ["div", {"className":"dra-tools"}, [
                  ["div", {"className":"dra-filterbar"}, [
                    ["button", {"key":"all","className":"dra-chip active","onClick":"function:27a8450651db8031e45d121c7968fca032b5189eeff1878751341257692e8847"}, ["全部 0"]],
                    ["button", {"key":"running","className":"dra-chip","onClick":"function:27a8450651db8031e45d121c7968fca032b5189eeff1878751341257692e8847"}, ["运行中"]],
                    ["button", {"key":"completed","className":"dra-chip","onClick":"function:27a8450651db8031e45d121c7968fca032b5189eeff1878751341257692e8847"}, ["已完成"]],
                    ["button", {"key":"failed","className":"dra-chip","onClick":"function:27a8450651db8031e45d121c7968fca032b5189eeff1878751341257692e8847"}, ["失败"]],
                  ]],
                ]],
              ]],
              ["div", {"className":"dra-card-body"}, [
                ["div", {}, [
                  ["div", {"className":"dra-row","style":{"justifyContent":"space-between","paddingBottom":4}}, [
                    ["span", {"className":"dra-hint"}, ["点击任务行看详情；hover 显示操作"]],
                    ["button", {"className":"dra-btn sm danger","disabled":false,"onClick":"function:6d79333d19b86cd262a76488b00886adb3284004c9e13a53ace562580c714a42"}, ["清理"]],
                  ]],
                  ["div", {"className":"dra-tasklist"}, [["div", {"key":"e-hist","className":"dra-empty"}, ["没有匹配的任务"]]]],
                ]],
              ]],
            ]],
            ["div", {}, [
              ["div", {"className":"dra-tplrow"}, [
                ["select", {"className":"dra-select dra-mono","value":"","title":"","onChange":"function:a4fb20871bdf63b54796a67021da5310e8ccf3d5ece346d123030e1c35a192db"}, [
                  ["option", {"value":""}, ["模板：读取中…"]],
                ]],
                ["button", {"className":"dra-btn sm","disabled":true,"title":"把当前表单内容存成模板","onClick":"function:822aeb7de85f33683d487e8fef0c59e9ae42b2ca75f8809db2cdc4d0ac512b6b"}, ["存为模板"]],
                ["button", {"className":"dra-btn sm","disabled":true,"title":"先在下拉框里选一条模板","onClick":"function:88865a20aca5626462bdb82c7aeb9cfe3d251839cad194b8d442431eb5a33dbe"}, ["删除模板"]],
              ]],
              ["section", {"className":"dra-card"}, [
                ["div", {"className":"dra-card-head"}, [["h3", {"className":"dra-card-title","style":{"margin":0}}, ["快速派发"]], ["span", {"className":"dra-card-sub"}, ["Hub → 选中的副机"]]]],
                ["div", {"className":"dra-card-body"}, [
                  ["div", {"className":"dra-field"}, [
                    ["label", {"className":"dra-label"}, ["目标节点"]],
                    ["select", {"className":"dra-select","value":"","onChange":"function:005623e0a7c8ebacfc038dfcfc9918c396f81ca2f51a972c3868bb679b82677b"}, [["option", {"value":""}, ["自动选择（按负载路由）"]]]],
                    ["div", {"className":"dra-hint"}, ["机器人级交办本期不可用"]],
                  ]],
                  ["div", {"className":"dra-field"}, [
                    ["label", {"className":"dra-label"}, ["任务目标"]],
                    ["textarea", {"className":"dra-textarea","value":"","placeholder":"例如：运行测试并修复失败的用例；或执行 npm run build 并汇报结果","onChange":"function:6d5129f6491e716d41cae900ec2e49fed5124ff3fe33138a06a5480e627dc359"}, [
                    ]],
                  ]],
                  ["div", {"className":"dra-row"}, [
                    ["div", {"className":"dra-field","style":{"flex":"1 1 120px"}}, [
                      ["label", {"className":"dra-label"}, ["执行模式"]],
                      ["select", {"className":"dra-select","value":"agent","onChange":"function:d05813754ca9efa444eb46be4202b7091e2b1e57f93b26b437429e71ac6a42cc"}, [
                        ["option", {"value":"agent"}, ["agent · 新开独立会话"]],
                        ["option", {"value":"exec"}, ["exec · 直接执行命令"]],
                      ]],
                    ]],
                  ]],
                  ["details", {"className":"dra-fold"}, [
                    ["summary", {}, ["高级选项"]],
                    ["div", {"className":"dra-fold-body"}, [
                      ["div", {"className":"dra-field"}, [
                        ["label", {"className":"dra-label"}, ["工作区（副机 roots 内）"]],
                        ["input", {"className":"dra-input dra-mono","value":"","placeholder":"留空 = 副机默认工作区","list":"dra-ws-list","onChange":"function:f1fc808524edc659d1f9c88e90e8ecef27f9a0403d7b3bad59f3d5cb4351b8b6"}, [
                        ]],
                        ["datalist", {"id":"dra-ws-list"}, []],
                      ]],
                      ["div", {"className":"dra-field"}, [
                        ["label", {"className":"dra-label"}, ["模型"]],
                        ["input", {"className":"dra-input dra-mono","value":"","placeholder":"没有清单，手动填 provider/model","onChange":"function:551c45f57e96b191e3888236c30315dcb02fd00133d809dfbdccf4b647c3db3b"}, []],
                      ]],
                      ["div", {"className":"dra-row"}, [
                        ["div", {"className":"dra-field","style":{"flex":"1 1 130px"}}, [
                          ["label", {"className":"dra-label"}, ["产出 glob（逗号分隔）"]],
                          ["input", {"className":"dra-input dra-mono","value":"","placeholder":"dist/**, *.md","onChange":"function:0dbeed9a9f01f9309bffbf0a7d2f22916776c0f881ccd92842d9a6be1a1fb381"}, []],
                        ]],
                        ["div", {"className":"dra-field","style":{"flex":"0 0 100px"}}, [
                          ["label", {"className":"dra-label"}, ["超时（ms）"]],
                          ["input", {"className":"dra-input dra-mono","value":"","placeholder":"600000","onChange":"function:910d5dac0889e784727331d236799626d866661f54479ec31c3eeaf68dc3d4cd"}, []],
                        ]],
                      ]],
                      ["label", {"className":"dra-check"}, [
                        ["input", {"type":"checkbox","checked":false,"onChange":"function:20e8e0f7161710679873c48a2dff29d8ff13ee69f3b8d49edfa0f71edfacc0b5"}, []],
                        ["span", {}, ["需要先审批再派给副机"]],
                      ]],
                    ]],
                  ]],
                  ["button", {"className":"dra-btn primary","style":{"width":"100%","marginTop":8,"padding":"8px 12px"},"disabled":false,"onClick":"function:44575d0fd6360b3bd5795e009641f762d202c836c7c1bed9e9c342fa472699ac"}, [
                    "派发任务",
                  ]],
                  ["div", {"className":"dra-hint","style":{"marginTop":5}}, ["agent = 在副机新开独立会话；exec = 直接执行命令。两条路径都由副机本地执行。"]],
                ]],
              ]],
            ]],
          ]],
        ]],
        screen_secondary,
      ]],
    ]],
    shell_foot,
  ]],
  bots: ["div", {"className":"dra-root","data-theme":"dark"}, [
    ["style", {"key":"dra-css"}, ["1c0c7af62bff68cea7875ac1baf81bada3d1916764e4a791bc75d1e3847c1dce"]],
    shell_head,
    ["nav", {"className":"dra-shell-nav","aria-label":"主要屏幕"}, [
      ["div", {"className":"dra-tablist","role":"tablist","aria-label":"主要屏幕","onKeyDown":"function:754c6a834ecd5b3c6d6dbdfcd5dbb70ad2c4609a62c20461e6fdd35acc7e4260"}, [
        tab2,
        tab,
        ["button", {"key":"bots","id":"tab-bots","type":"button","role":"tab","className":"dra-tab","aria-selected":"true","aria-controls":"panel-bots","tabIndex":0,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "机器人",
        ]],
        ["button", {"key":"models","id":"tab-models","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-models","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "模型",
        ]],
        ["button", {"key":"memory","id":"tab-memory","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-memory","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "记忆",
        ]],
      ]],
    ]],
    ["div", {"className":"dra-shell-status"}, []],
    ["main", {"id":"panel-bots","className":"dra-screen","role":"tabpanel","aria-labelledby":"tab-bots"}, [
      ["section", {"className":"dra-screen-summary","aria-label":"概况"}, [["h2", {"className":"dra-screen-title"}, ["机器人"]], ["p", {"className":"dra-screen-line"}, ["读取中…"]], statbar]],
      ["div", {"className":"dra-screen-body"}, [
        ["div", {"className":"dra-screen-primary"}, [
          ["div", {"className":"dra-col"}, [
            ["div", {"className":"dra-col dra-botform"}, [
              ["div", {"className":"dra-mono"}, ["创建机器人"]],
              ["select", {"className":"dra-select","value":"","disabled":false,"onChange":"function:55c810fe2c8398bfe60745d09dc20216b274aca1807ad8ab2ebaf6f1134c7812"}, [
                ["option", {"value":""}, ["选择在线电脑…"]],
              ]],
              ["input", {"className":"dra-input","placeholder":"名称（必填，≤40）","value":"","onChange":"function:55c810fe2c8398bfe60745d09dc20216b274aca1807ad8ab2ebaf6f1134c7812"}, []],
              ["input", {"className":"dra-input","placeholder":"角色（≤24）","value":"","onChange":"function:55c810fe2c8398bfe60745d09dc20216b274aca1807ad8ab2ebaf6f1134c7812"}, []],
              ["input", {"className":"dra-input","placeholder":"模型（provider/model）","value":"","onChange":"function:55c810fe2c8398bfe60745d09dc20216b274aca1807ad8ab2ebaf6f1134c7812"}, []],
              ["input", {"className":"dra-input","placeholder":"工作目录","value":"","onChange":"function:55c810fe2c8398bfe60745d09dc20216b274aca1807ad8ab2ebaf6f1134c7812"}, []],
              ["textarea", {"className":"dra-textarea","rows":4,"placeholder":"指令","value":"","onChange":"function:55c810fe2c8398bfe60745d09dc20216b274aca1807ad8ab2ebaf6f1134c7812"}, []],
              ["div", {"className":"dra-row"}, [
                ["button", {"className":"dra-btn dra-btn-primary","disabled":false,"onClick":"function:e50ba88c7e63799dc8f406ff3caee840d00aa1d04e413c75f09b01044bd64f29"}, ["创建"]],
              ]],
            ]],
            ["p", {}, ["读取中…"]],
          ]],
        ]],
        screen_secondary,
      ]],
    ]],
    shell_foot,
  ]],
  models: ["div", {"className":"dra-root","data-theme":"dark"}, [
    ["style", {"key":"dra-css"}, ["1c0c7af62bff68cea7875ac1baf81bada3d1916764e4a791bc75d1e3847c1dce"]],
    shell_head,
    ["nav", {"className":"dra-shell-nav","aria-label":"主要屏幕"}, [
      ["div", {"className":"dra-tablist","role":"tablist","aria-label":"主要屏幕","onKeyDown":"function:754c6a834ecd5b3c6d6dbdfcd5dbb70ad2c4609a62c20461e6fdd35acc7e4260"}, [
        tab2,
        tab,
        ["button", {"key":"bots","id":"tab-bots","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-bots","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "机器人",
        ]],
        ["button", {"key":"models","id":"tab-models","type":"button","role":"tab","className":"dra-tab","aria-selected":"true","aria-controls":"panel-models","tabIndex":0,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "模型",
        ]],
        ["button", {"key":"memory","id":"tab-memory","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-memory","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "记忆",
        ]],
      ]],
    ]],
    ["div", {"className":"dra-shell-status"}, []],
    ["main", {"id":"panel-models","className":"dra-screen","role":"tabpanel","aria-labelledby":"tab-models"}, [
      ["section", {"className":"dra-screen-summary","aria-label":"概况"}, [["h2", {"className":"dra-screen-title"}, ["模型"]], ["p", {"className":"dra-screen-line"}, ["读取中…"]], statbar]],
      ["div", {"className":"dra-screen-body"}, [["div", {"className":"dra-screen-primary"}, [["div", {"className":"dra-col"}, [["p", {}, ["读取中…"]]]]]], screen_secondary]],
    ]],
    shell_foot,
  ]],
  memory: ["div", {"className":"dra-root","data-theme":"dark"}, [
    ["style", {"key":"dra-css"}, ["1c0c7af62bff68cea7875ac1baf81bada3d1916764e4a791bc75d1e3847c1dce"]],
    shell_head,
    ["nav", {"className":"dra-shell-nav","aria-label":"主要屏幕"}, [
      ["div", {"className":"dra-tablist","role":"tablist","aria-label":"主要屏幕","onKeyDown":"function:754c6a834ecd5b3c6d6dbdfcd5dbb70ad2c4609a62c20461e6fdd35acc7e4260"}, [
        tab2,
        tab,
        ["button", {"key":"bots","id":"tab-bots","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-bots","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "机器人",
        ]],
        ["button", {"key":"models","id":"tab-models","type":"button","role":"tab","className":"dra-tab","aria-selected":"false","aria-controls":"panel-models","tabIndex":-1,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "模型",
        ]],
        ["button", {"key":"memory","id":"tab-memory","type":"button","role":"tab","className":"dra-tab","aria-selected":"true","aria-controls":"panel-memory","tabIndex":0,"onClick":"function:cd2866e903dff0c1b933ad967ca33d36cba2db333510c1ad976ed1a764eed5c6"}, [
          "记忆",
        ]],
      ]],
    ]],
    ["div", {"className":"dra-shell-status"}, []],
    ["main", {"id":"panel-memory","className":"dra-screen","role":"tabpanel","aria-labelledby":"tab-memory"}, [
      ["section", {"className":"dra-screen-summary","aria-label":"概况"}, [["h2", {"className":"dra-screen-title"}, ["记忆"]], ["p", {"className":"dra-screen-line"}, ["读取中…"]], statbar]],
      ["div", {"className":"dra-screen-body"}, [
        ["div", {"className":"dra-screen-primary"}, [
          ["div", {"className":"dra-col dra-memory"}, [
            ["select", {"className":"dra-select","value":"{\"kind\":\"team\"}","onChange":"function:e7737b6f22db7440b076aeb3675c129d6ad4389ecdc05dc31bd198c1ba40ea24"}, []],
            ["p", {}, ["读取中…"]],
            ["div", {"className":"dra-row"}, [
              ["input", {"className":"dra-input","placeholder":"记住一件事…","value":"","onChange":"function:9536d9a933a830df850a3e5928117643cdfb4e61f0243833c7fa211281d4f8a9"}, []],
              ["input", {"className":"dra-input","placeholder":"主题（可选）","value":"","onChange":"function:859a7f57b38ea136f2aa73915768ee75cf24fe1be28d26e3fa8a8c7c8bd122c8"}, []],
              ["button", {"className":"dra-btn dra-btn-primary","disabled":true,"onClick":"function:8e2bbf453665573d70cdb2967c01347db8e523f43e6e78cfe3b78de7aebbecff"}, ["记住"]],
            ]],
          ]],
        ]],
        screen_secondary,
      ]],
    ]],
    shell_foot,
  ]],
}

if (process.env.P1B_BASELINE_CLIENT) {
  const pinned = readFileSync(process.env.P1B_BASELINE_CLIENT, 'utf8')
  const observed = Object.fromEntries(screens.map(([screen]) => [screen, screenTree(screen, {}, pinned)]))
  assert.deepEqual(baseline, observed)
}

test('ticketStage maps fixture stages', () => {
  const { ticketStage } = loadView().plugin
  // Fixture-proof only. Live GET /tickets supplies no executorState.
  for (const kind of ['answer', 'review', 'blocked', 'failed']) {
    assert.deepEqual(plain(ticketStage(open, { attention: { kind }, running: true })), { stage: 'person', reason: kind })
  }
  assert.deepEqual(plain(ticketStage(open, { running: true })), { stage: 'working' })
  for (const malformed of [null, undefined, false, 7, 'open', { state: 'other' }]) {
    assert.deepEqual(plain(ticketStage(malformed, { running: true })), { stage: 'idle' })
  }
  assert.deepEqual(plain(ticketStage(open, { attention: { kind: 'unknown' } })), { stage: 'idle' })
  assert.deepEqual(plain(ticketStage(open)), { stage: 'idle' })
  for (const ticket of [ended, interrupted]) {
    assert.deepEqual(plain(ticketStage(ticket, { attention: { kind: 'answer' }, running: true })), { stage: 'ended' })
  }
})

test('attention tickets sort before working tickets', () => {
  const { ticketStage, sortAttentionTickets } = loadView().plugin
  // Fixture-proof only. No live task/approval join feeds these states.
  const rows = [{ running: true }, { attention: { kind: 'review' } }, undefined].map(state => ticketStage(open, state))
  assert.deepEqual(Array.from(sortAttentionTickets(rows), row => row.stage), ['person', 'working', 'idle'])
  assert.deepEqual(Array.from(rows, row => row.stage), ['working', 'person', 'idle'])
})

test('ended tickets never appear in the attention list', () => {
  const [fold] = findFolds(screenTree('tasks', { tickets: [ended, open, interrupted] }))
  assert.ok(fold)
  assert.doesNotMatch(JSON.stringify(fold), /tk_ended|tk_interrupted/, 'ended 不应出现在待处理区')
  assert.match(JSON.stringify(fold), /tk_open/)
  assert.equal(findFolds(screenTree('tasks', { tickets: [ended] })).length, 1)
})

test('fold null for absent undefined null and empty props keeps five-screen trees equal to baseline', () => {
  for (const props of [{}, { tickets: undefined }, { tickets: null }, { tickets: [] }]) {
    for (const [screen] of screens) {
      assert.deepEqual(withoutDiscoveryCard(screenTree(screen, props)), withoutDiscoveryCard(baseline[screen]),
        '折叠区缺省时其他区域应与基线一致')
    }
  }
})

test('nonempty fold is exactly one closed details with a summary', () => {
  const folds = findFolds(screenTree('tasks', { tickets: [open] }))
  assert.equal(folds.length, 1)
  const [fold] = folds
  assert.equal(fold[1].open, false)
  const nodes = [...elements(fold)]
  assert.equal(nodes.filter(node => node[0] === 'details').length, 1)
  assert.equal(nodes.filter(node => node[0] === 'summary').length, 1)
  assert.equal(nodes.some(node => node[0] === 'button' || Object.keys(node[1]).some(key => /^on[A-Z]/.test(key))), false)
  assert.match(JSON.stringify(fold), /未结束.*已关联执行器/)
})

test('deleting the fold subtree restores the baseline tasks tree', () => {
  for (const [screen] of screens) {
    const tree = screenTree(screen, { tickets: [open] })
    const folds = findFolds(tree)
    assert.equal(folds.length, screen === 'tasks' ? 1 : 0)
    const withoutFold = screen === 'tasks' ? removeNode(tree, folds[0]) : tree
    assert.deepEqual(withoutDiscoveryCard(withoutFold), withoutDiscoveryCard(baseline[screen]))
  }
})

test('five screens literal unchanged', () => {
  assert.deepEqual(plain(loadView().plugin.P2_SCREENS), screens)
  assert.ok(src.includes("const P2_SCREENS = [['computers','电脑'],['tasks','交办'],['bots','机器人'],['models','模型'],['memory','记忆']]"))
})

test('loadHub tolerates /tickets failure', async () => {
  const broken = new Error('ticket fetch failed')
  let reply = { tickets: [open] }
  const requests = []
  const panel = loadView({ initial: { screen: 'tasks' }, async fetch(url, options) {
    requests.push([url, options.method ?? 'GET'])
    let body = {}
    if (url.endsWith('/setup/state')) body = { effectiveRole: 'hub' }
    if (url.endsWith('/tickets')) {
      if (reply === broken) throw broken
      body = reply
    }
    return { ok: true, status: 200, json: async () => body }
  } })
  panel.mount()
  await setImmediate()
  assert.deepEqual(panel.state().tickets, [open])
  assert.equal(findFolds(panel.tree()).length, 1)
  for (const absent of [broken, null, {}, { tickets: null }, { tickets: {} }, { tickets: [] }]) {
    reply = absent
    panel.poll()
    await setImmediate()
    assert.equal(panel.state().error, '')
    assert.equal(panel.state().tickets?.length ?? 0, 0)
    assert.equal(findFolds(panel.tree()).length, 0)
  }
  assert.equal(requests.filter(([url]) => url.endsWith('/tickets')).length, 7)
  assert.ok(requests.filter(([url]) => url.endsWith('/tickets')).every(([, method]) => method === 'GET'))
})

test('client.js has no write call in the fold', () => {
  const fold = src.match(/^ {4}function AttentionFold\(props\) \{[\s\S]+?^ {4}\}/m)?.[0]
  assert.ok(fold)
  assert.doesNotMatch(fold, /\b(?:apiPost\w*|fetch)\s*\(/)
})
