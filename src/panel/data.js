/**
 * 面板数据层：本机角色、主机轮询、副机状态。屏幕模块只读这里给的快照，自己的附加数据自己拉。
 * 顶层标识符一律以 `data` 开头。
 */
import { coreActiveStatuses, coreFailedStatuses } from './core.js'

export const dataStatusPath = '/api/remote-agent/status'
export const dataSetupStatePath = '/api/remote-agent/setup/state'
export const dataPollMs = 8000
export const dataActivePollMs = 3000

export function dataPollDelay(activeTasks) { return activeTasks > 0 ? dataActivePollMs : dataPollMs }
export function dataShouldPoll(doc) { return !doc || doc.hidden !== true }

/** 已保存的角色：hub / worker / both；还没配置返回 ''。 */
export function dataSavedRole(setup) {
  if (!setup) return ''
  const cur = setup.current ? setup.current : {}
  const role = String(setup.effectiveRole || cur.role || '').trim().toLowerCase()
  if (role === 'hub' || role === 'worker' || role === 'both') return role
  return setup.configured === false ? '' : 'hub'
}

/** /node-status 的遥测并进 /overview 的节点行（只并这几个字段）。 */
export function dataMergeNodes(ov, status) {
  if (!ov || !Array.isArray(ov.nodes) || !status || !Array.isArray(status.nodes)) return ov
  const byId = new Map(status.nodes.map((n) => [n.nodeId, n]))
  const keys = ['resource', 'connectivity', 'queue', 'silentMs', 'stale', 'thresholdMs']
  return Object.assign({}, ov, {
    nodes: ov.nodes.map((n) => {
      const row = byId.get(n.nodeId)
      if (!row) return n
      const merged = Object.assign({}, n)
      for (const k of keys) if (Object.prototype.hasOwnProperty.call(row, k)) merged[k] = row[k]
      return merged
    }),
  })
}

export function dataCounts(tasks, ov) {
  const list = Array.isArray(tasks) ? tasks : []
  const nodes = ov && Array.isArray(ov.nodes) ? ov.nodes : []
  const oc = ov && ov.counts ? ov.counts : {}
  const active = list.filter((t) => coreActiveStatuses.indexOf(t.status) >= 0).length
  return {
    nodes: oc.nodes != null ? oc.nodes : nodes.length,
    online: oc.online != null ? oc.online : nodes.filter((n) => n.online === true).length,
    tasks: list.length,
    running: oc.running != null ? oc.running : active,
    active,
    done: list.filter((t) => t.status === 'completed').length,
    failed: list.filter((t) => coreFailedStatuses.indexOf(t.status) >= 0).length,
  }
}

/** 可靠通道积压并回节点行：n.link = { pending, oldestMs, maxTries, types } | null。 */
export function dataAttachLink(nodes, link) {
  const rows = link && Array.isArray(link.nodes) ? link.nodes : []
  const byId = new Map(rows.map((r) => [r.nodeId, r]))
  return (nodes || []).map((n) => {
    const r = byId.get(n.nodeId)
    return r ? Object.assign({}, n, { link: { pending: r.pending, oldestMs: r.oldestMs, maxTries: r.maxTries, types: r.types } }) : n
  })
}

/** 首屏空快照：屏幕不必判断 null。 */
export const dataEmptyHub = Object.freeze({
  loading: true, error: '', at: 0, tick: 0,
  nodes: [], tasks: [], counts: { nodes: 0, online: 0, tasks: 0, running: 0, active: 0, done: 0, failed: 0 },
  caps: null, connection: null, relay: null, topology: null, discovery: null, transportSummary: null,
  tickets: undefined, goals: undefined, botAudit: undefined,
  link: { available: false, total: 0, nodes: [] },
})

export function createData(core) {
  const { React, api, safe } = core

  /** 本机角色。refresh() 重读；applyRole(role) 在写盘后立刻切换，等下一次读取确认。 */
  function useBoot() {
    const [boot, setBoot] = React.useState({ state: 'loading', role: '', setup: null, error: '' })
    const override = React.useRef('')
    const load = React.useCallback(() => {
      return api.getPath(dataSetupStatePath).then((setup) => {
        const saved = dataSavedRole(setup)
        const role = override.current || saved
        if (override.current && saved === override.current) override.current = ''
        setBoot({ state: role ? 'ready' : 'setup', role, setup: setup || null, error: '' })
      }, (e) => setBoot((p) => ({ state: p.role ? 'ready' : 'error', role: p.role, setup: p.setup, error: String((e && e.message) || e) })))
    }, [])
    React.useEffect(() => { load() }, [load])
    return {
      boot,
      reload: load,
      applyRole(role) {
        const r = String(role || '').trim().toLowerCase()
        if (r !== 'hub' && r !== 'worker' && r !== 'both') return
        override.current = r
        setBoot((p) => ({ state: 'ready', role: r, setup: p.setup, error: '' }))
        load()
      },
    }
  }

  /** 主机快照轮询。enabled=false 时不请求。活跃任务 3s，空闲 8s，页面隐藏时暂停。 */
  function useHub(enabled, autoRefresh) {
    const [hub, setHub] = React.useState(dataEmptyHub)
    const [kick, setKick] = React.useState(0)
    const inflight = React.useRef(false)
    const active = hub.counts.active

    const pull = React.useCallback(() => {
      if (inflight.current) return Promise.resolve()
      inflight.current = true
      return api.get('/overview').then((ov0) => {
        return Promise.all([
          api.get('/tasks'),
          safe(api.get('/node-status')),
          safe(api.get('/tickets')),
          safe(api.get('/goals')),
          safe(api.get('/bot-audit')),
          safe(api.get('/link-status')),
        ]).then((r) => {
          const ov = dataMergeNodes(ov0, r[1] && r[1].ok !== false ? r[1] : null)
          const tasks = r[0] && Array.isArray(r[0].tasks) ? r[0].tasks : []
          const link = r[5] && r[5].ok === true ? r[5] : { available: false, total: 0, nodes: [] }
          setHub((prev) => ({
            loading: false, error: '', at: Date.now(), tick: prev.tick + 1,
            nodes: dataAttachLink(ov && Array.isArray(ov.nodes) ? ov.nodes : [], link),
            tasks,
            counts: dataCounts(tasks, ov),
            caps: ov && ov.capabilities ? ov.capabilities : null,
            connection: ov && ov.connection ? ov.connection : null,
            relay: ov && ov.relay ? ov.relay : null,
            topology: ov && ov.topology ? ov.topology : null,
            discovery: ov && ov.discovery ? ov.discovery : null,
            transportSummary: ov && ov.transportSummary ? ov.transportSummary : null,
            tickets: r[2] && Array.isArray(r[2].tickets) ? r[2].tickets : undefined,
            goals: r[3] && Array.isArray(r[3].goals) ? r[3].goals : undefined,
            botAudit: r[4] && Array.isArray(r[4].entries) ? r[4].entries : undefined,
            link,
          }))
        })
      }).catch((e) => {
        setHub((prev) => Object.assign({}, prev, { loading: false, error: String((e && e.message) || e) }))
      }).then(() => { inflight.current = false })
    }, [])

    React.useEffect(() => {
      if (!enabled) return undefined
      let gone = false
      pull()
      if (autoRefresh === false) return undefined
      const timer = setTimeout(() => {
        if (gone) return
        if (dataShouldPoll(typeof document !== 'undefined' ? document : undefined)) pull().then(() => { if (!gone) setKick((k) => k + 1) })
        else setKick((k) => k + 1)
      }, dataPollDelay(active))
      return () => { gone = true; clearTimeout(timer) }
    }, [enabled, autoRefresh, kick, active])

    return { hub, refresh() { setKick((k) => k + 1); return pull() } }
  }

  /** 副机本机状态（/api/remote-agent/status）+ 接入配置只读视图。 */
  function useWorker(enabled, autoRefresh) {
    const [w, setW] = React.useState({ loading: true, error: '', status: null })
    const [kick, setKick] = React.useState(0)
    React.useEffect(() => {
      if (!enabled) return undefined
      let gone = false
      /* 首次、以及用户点刷新（kick 变了但页面可见）才读；页面隐藏时不请求，只续约定时器。 */
      if (kick === 0 || dataShouldPoll(typeof document !== 'undefined' ? document : undefined)) {
        api.getPath(dataStatusPath).then(
          (d) => { if (!gone) setW({ loading: false, error: '', status: d || null }) },
          (e) => { if (!gone) setW((p) => ({ loading: false, error: String((e && e.message) || e), status: p.status })) })
      }
      if (autoRefresh === false) return () => { gone = true }
      const timer = setTimeout(() => { if (!gone) setKick((k) => k + 1) }, dataPollMs)
      return () => { gone = true; clearTimeout(timer) }
    }, [enabled, autoRefresh, kick])
    return { worker: w, refresh() { setKick((k) => k + 1) } }
  }

  return { useBoot, useHub, useWorker }
}
