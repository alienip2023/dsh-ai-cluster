/**
 * dsh-remote-agent 协议层（零外部依赖）。
 *
 * 设计要点：
 *  - 单向凭证：模型 key / 会话日志 / 插件只存在于各自机器，协议里永远不出现模型凭证。
 *  - 任务幂等：taskId 由 hub 生成，node 按 id 去重，重连重发不重复执行。
 *  - 清单先于字节：产物先回 manifest，hub 显式 pull 才传输字节。
 *  - 版本协商：hello/welcome 里带 protocol，不匹配时 node 主动拒绝而不是半懂半不懂地跑。
 */

export const PROTOCOL_VERSION = 1

export const PEER = Object.freeze({
  HELLO: 'peer/hello',
  WELCOME: 'peer/welcome',
  DIRECTORY: 'peer/directory',
})

export const PEER_BOT_TYPES = Object.freeze(['bot/turn', 'bot/turn-result', 'bot/message'])

/** Only advertise a usable peer endpoint; never propagate credentials in a URL. */
export function normalizePeerUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return ''
  try {
    const url = new URL(raw)
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/api/remote-agent/peer') return ''
    return url.href
  } catch { return '' }
}

/** 帧类型。hub→node 与 node→hub 分列，避免拼写漂移。 */
export const HUB_TO_NODE = Object.freeze({
  WELCOME: 'welcome',
  /**
   * hub 身份帧（P2-11）。direct 模式的身份证明放在 welcome 里；relay 模式
   * 副机的"在线"信号来自中继的 accepted，hub 在握手期对副机静默，只能
   * 在节点上线后**追发**这一帧补上身份证明。副机未验证通过前拒绝执行任务。
   */
  IDENTITY: 'hub/identity',
  /**
   * E2E 密钥交换确认（提案 #1）：hub 对副机的 node/e2e 提议的签名回应。
   * 载荷 { pub, sig, at } —— pub 是 hub 的 X25519 临时公钥，sig 用 hub 持久
   * ed25519 身份签出（绑定双方公钥 + 连接 nonce）。中继只转发，无法伪造。
   */
  E2E_ACK: 'hub/e2e',
  /**
   * 远程文件请求（提案 #25）：hub → node 的只读文件操作（ls/read/grep/tree）。
   * 载荷 { op, ...params }；reqId 用信封 id 本身，node 回 fs/res 时 replyTo 对上。
   * 必须加密（E2E_REQUIRED_TYPES）：目录结构 / 文件内容都是敏感信息。
   */
  FS_REQ: 'fs/req',
  /**
   * 工作区共享请求（2026-10-17）：hub → node 的 SMB 共享操作。
   *
   * 载荷 `{ op: 'probe'|'plan'|'unshare-plan', ...params }`。
   *
   * ⚠ 本帧**只做探测与生成命令**，不执行 `New-SmbShare` —— 那需要管理员，
   * 而 DSH 通常以普通用户运行。执行由用户在提权 PowerShell 里手动做
   * （面板给出可复制的命令）。这个设计是刻意的：Node 里提权失败的表现
   * （静默失败 / 被安全软件拦 / 权限半生效）比让用户手动跑一条命令难排查。
   *
   * 必须加密（E2E_REQUIRED_TYPES）：帧里含工作区绝对路径。
   */
  SHARE_REQ: 'share/req',
  TASK_START: 'task/start',
  TASK_CANCEL: 'task/cancel',
  TASK_QUERY: 'task/query',
  ARTIFACT_LIST: 'artifact/list',
  ARTIFACT_PULL: 'artifact/pull',
  ARTIFACT_CANCEL: 'artifact/cancel',
  PING: 'ping',
  ERROR: 'error',
  /**
   * 名单第 2 步。把一句发话投进副机已有 Bot 会话。
   * 载荷至少 { nodeId, remoteBotId, exchangeId, text }。不进 task/start。
   * 可选 `mode: 'steer' | 'queue'`（能力 bot-turn-mode/1）：忙时 steer = 并入正在跑的回合，
   * queue = 排队等下一回合；缺省按节点原行为。不认识 mode 的旧节点忽略它。
   * 必须加密（E2E_REQUIRED_TYPES）：带会话正文。
   */
  BOT_TURN: 'bot/turn',
  /** 节点 Bot 网络：宿主生成的目录与节点间消息，独立于 bot/turn。 */
  BOT_DIRECTORY: 'bot/directory',
  BOT_MESSAGE: 'bot/message',
  TEAM_ACT: 'team/act',
  TEAM_ACT_RESULT: 'team/act-result',
  REL_FRAME: 'rel/frame',
  REL_ACK: 'rel/ack',
  /**
   * 名单第 3 步。主控在指定 node 上新建一个本地 Bot。
   * 载荷 { nodeId, name, role, requestId }。不进 task/start。
   */
  BOT_CREATE: 'bot/create',
  /** M3: request remote Bot's conversation page */
  BOT_HISTORY: 'bot/history',
  BOT_UPDATE: 'bot/update',
  /**
   * 名单第 5 步。主控删除 joined Bot 时通知节点删除对应本地 Bot。
   * 载荷 { nodeId, remoteBotId, requestId }。不进 task/start。
   */
  BOT_DELETE: 'bot/delete',
  /**
   * Control plane：主控要求节点停掉某个 Bot 正在跑的回合。
   * 载荷 { nodeId, remoteBotId, requestId }。不进 task/start —— 它不执行任务，
   * 只对应节点本地 Bot 的一次 cancel。
   * 必须加密（E2E_REQUIRED_TYPES）：帧里带 Bot 身份。
   */
  BOT_STOP: 'bot/stop',
  /**
   * 用户在 node bot 忙时插队发消息：hub → node，载荷 { nodeId, remoteBotId, exchangeId, text, requestId }。
   * 节点在当前 turn 的下一个工具调用边界注入文本（STEER_CUT 机制）。
   */
  BOT_STEER: 'bot/steer',
  /**
   * 主控替用户对节点 Bot 的界面状态做操作（回答卡片、停止/追问后台任务）。
   * 载荷 { nodeId, remoteBotId, requestId, action, params }。节点回 bot/action-result。
   * 必须加密：params 里有用户的回答原文。
   */
  BOT_ACTION: 'bot/action',
  /**
   * 主控把用户消息里的图片/文件按块送给节点 Bot（能力 bot-attach/1）：hub → node，
   * 载荷 { nodeId, remoteBotId, exchangeId, index, chunk, chunks, data }。data 是 base64（单块 ≤ 1,100,000 字符），
   * index 是本回合第几个附件（0..7），chunk 从 0 起、共 chunks（≤ 40）块。没有结果帧。
   * hub 先发完全部分块，再在同一条链路上发点名它们的 bot/turn（attachments 清单），节点按到达顺序同步交给接收方。
   * 必须加密（E2E_REQUIRED_TYPES）：帧里是用户的图片/文件原文。
   */
  BOT_ATTACH: 'bot/attach',
  /**
   * T9a：主控 → 节点的只读影子名单。载荷 { hubId, level, hostname, bots }。
   * 节点据此建 origin:'peer' 的只读行；不带 nodeId —— 归属由连接身份决定。
   * 必须加密（E2E_REQUIRED_TYPES）：名单暴露主控有哪些 Bot。
   */
  PEER_ROSTER: 'peer/roster',
  /**
   * M2：主控 → 节点的配置下发帧。
   * 载荷 { revision, providers: [{ id, baseURL, apiKey, models, defaultModel }] }。
   * 必须加密（E2E_REQUIRED_TYPES）：帧里含 apiKey 明文。
   */
  CONFIG_PUSH: 'hub/config-push',
  /**
   * 并发上限下发：主控给某台节点设 TaskEngine 的 maxConcurrent。
   * 载荷 { nodeId, maxConcurrent, requestId }，范围 1–64。
   * 不进 task/start —— 它只改队列泵的上限，不执行任务。节点改完立即 pump，
   * 不需要重启节点 DSH。旧节点按未知帧忽略（不回 result），主控据超时标
   * 「节点版本不支持」，不假装已生效。
   * 必须加密（E2E_REQUIRED_TYPES）：与其它控制帧同口径，且帧里带节点身份。
   */
  NODE_CONFIG: 'node/config',
  MODEL_SYNC: 'node/model-sync',
  APPROVAL_ANSWER: 'hub/approval-answer',
  /**
   * Hub pushes updated peer directory including TLS fingerprints and trust info.
   * Payload { peers: [{ nodeId, url, pubKeyB64, secret }] }.
   * Supersedes the old peer/directory frame; nodes that understand this use it
   * to seed their trust store without requiring manual pairing for hub-managed nodes.
   */
  PEER_DIRECTORY_V2: 'peer/directory-v2',
  /**
   * Hub asks a node where a specific Bot is currently running.
   * Payload { botId, requestId }.
   * Node responds with machine/beacon or a bot/locate-result frame.
   */
  BOT_LOCATE: 'bot/locate',
  /**
   * Phase 1 团队目录（hub → node）：主控把机器与 Bot 的全量目录快照下发给节点，
   * 节点据此建立只读缓存（机器列表、Bot identityId → home 映射）。
   * 载荷 { seq, machines: {...}, bots: {...} }。
   * 增量帧用 DIRECTORY_DELTA：{ seq, machines?: {...}, bots?: {...}, deleted?: { machines:[], bots:[] } }。
   * 必须加密（E2E_REQUIRED_TYPES）：目录含 Bot 名称与机器端点信息。
   */
  DIRECTORY_SNAPSHOT: 'directory/snapshot',
  DIRECTORY_DELTA: 'directory/delta',
})

export const NODE_TO_HUB = Object.freeze({
  HELLO: 'hello',
  /** 重连后主动上报本机全部任务状态 —— 任务状态的真身在副机，不在 hub。 */
  TASK_SYNC: 'task/sync',
  TASK_ACCEPT: 'task/accept',
  TASK_PROGRESS: 'task/progress',
  TASK_SUMMARY: 'task/summary',
  TASK_END: 'task/end',
  ARTIFACT_MANIFEST: 'artifact/manifest',
  ARTIFACT_CHUNK: 'artifact/chunk',
  ARTIFACT_DONE: 'artifact/done',
  /** 资源遥测（CPU/内存/负载，~30s 一次）：派发前先看节点负载。尽力而为，字段可缺。 */
  RESOURCE: 'node/resource',
  CONNECTIVITY: 'node/connectivity',
  /** Detached long-running process ledger, independent of task/start. */
  JOBS: 'node/jobs',
  /**
   * 仓库清单上报（提案 #13）：副机把 roots 下扫到的 git 仓库（名字/远端
   * url/本机路径）报给 hub，hub 建 repo→node 索引供 remote_task 的 repo:
   * 参数路由。接入后与每 10min 各发一次；尽力而为，旧 hub 会按未知帧忽略。
   */
  REPOS: 'node/repos',
  /**
   * E2E 密钥交换提议（提案 #1）：副机上线后发一次，载荷 { pub, nonce } ——
   * pub 是副机的一次性 X25519 公钥。hub 用持久身份签名确认（hub/e2e）。
   * 旧 hub 按未知帧忽略 → 协商不成就继续明文（混跑安全）。
   */
  E2E_OFFER: 'node/e2e',
  /**
   * 远程文件响应（提案 #25）：node → hub 的 fs/req 结果。载荷
   * { replyTo, ok, result?, code?, message? }。加密发送（node→hub 默认封密）。
   */
  FS_RES: 'fs/res',
  /**
   * 工作区共享响应（2026-10-17）：node → hub 的 share/req 结果。
   * 载荷 `{ replyTo, ok, result?, code?, message? }`。加密发送。
   */
  SHARE_RES: 'share/res',
  PONG: 'pong',
  ERROR: 'error',
  /**
   * 副机 DS-Bot 名单（设计第 1 步）。不进 hello。
   * 载荷 { nodeId, hostname, bots: [{ id, name, role, model?, clusterBotId?, tasks?, cards? }], skills?, trimmed? }。
   *   - tasks：该 Bot 正在跑的后台任务摘要（id/title/status/startedAt，最多 8 条）；
   *   - cards（能力 roster-cards/1）：该 Bot 等人回答的卡片（审批 / 提问 / 技能提议…），每个 Bot 最多 8 张、
   *     正文 2000 字，答复走 bot/action(card-answer)；
   *   - 整帧序列化后不超过 512 KiB（超过 4 MiB 的 ws 帧会断开链路）：超出时按
   *     「卡片正文 → 技能正文 → 最旧任务 → 卡片」依次裁，永不丢 Bot，并在 `trimmed` 里列出裁了什么；
   *   - 内容未变的名册 30 秒内不重发（宿主每 5 秒重报一次）。
   * 不含 type === remote-worker，避免影子再被报上去。
   */
  ROSTER: 'roster/report',
  /**
   * 副机把同一 exchangeId 的回答送回主控。
   * 载荷至少 { nodeId, remoteBotId, exchangeId, text }。
   * 链路断开时副机按退避重发约 30 分钟（lib/bot-turn.js）；主控侧该回合保持 running 并标
   * linkLost，晚到的结果照常结算（硬超时 2 小时才判失败并审计），不会因掉线就当作失败。
   */
  BOT_TURN_RESULT: 'bot/turn-result',
  BOT_MESSAGE: 'bot/message',
  TEAM_ACT: 'team/act',
  TEAM_ACT_RESULT: 'team/act-result',
  REL_FRAME: 'rel/frame',
  REL_ACK: 'rel/ack',
  /**
   * Machine beacon report: a node sends its LAN beacon data up to the hub so the
   * hub can maintain a full network topology view without sniffing UDP traffic.
   * Payload { machineId, peerUrl, pubKeyB64, hostname, caps, ts }.
   * Best-effort; old hubs ignore unknown frames.
   */
  MACHINE_BEACON: 'machine/beacon',
  /**
   * Pairing notification: a node completed a peer pairing and tells the hub so the
   * hub can update its peer directory for other nodes.
   * Payload { peerId, peerPubKeyB64, peerUrl }.
   */
  PEER_PAIRED: 'peer/paired',
  /**
   * Node response to hub/bot/locate.
   * Payload { requestId, botId, nodeId, found, machineId?, pubKeyB64?, sig? }.
   * sig is the Bot's ed25519 signature over the requestId so the hub can verify
   * the Bot is genuinely running here (not spoofed). Old hubs ignore unknown frames.
   */
  BOT_LOCATE_RESULT: 'bot/locate-result',
  /**
   * 名单第 3 步。副机返回 bot/create 的结果。
   * 载荷 { requestId, remoteBotId, name, role } 或 { requestId, ok: false, error }。
   */
  BOT_CREATE_RESULT: 'bot/create-result',
  /** M3: response to bot/history */
  BOT_HISTORY_RESULT: 'bot/history-result',
  BOT_UPDATE_RESULT: 'bot/update-result',
  /**
   * 名单第 5 步。节点回复 bot/delete 的结果。
   * 载荷 { requestId, ok: boolean, error?: string }。
   */
  BOT_DELETE_RESULT: 'bot/delete-result',
  /**
   * Control plane：节点回复 bot/stop 的结果。
   * 载荷 { requestId, ok: boolean, stopped: boolean, error?: string }。
   * stopped=false 且 ok=true 表示「本来就没在跑」，不是失败。
   */
  BOT_STOP_RESULT: 'bot/stop-result',
  /** bot/action 的回执。载荷 { requestId, ok: boolean, error?: string, detail?: string }。 */
  BOT_ACTION_RESULT: 'bot/action-result',
  /**
   * 节点 Bot 一个回合里的思考过程与工具步骤（能力 bot-trace/1），节点 → 主控，让主控的页面像本地 Bot 一样显示它们。
   * 载荷 { nodeId, remoteBotId, exchangeId, roomId?, seq, final?, items, omitted?, clipped? }：
   *   - seq：同一 exchangeId 内严格递增的批号（节点 AC 分配）；
   *   - items：追加式日志，每条带回合内单调递增的序号 i（从 1 起）：
   *     { i, t: 'a', think?, calls?: [{ id, name, args }], end? }  一条助手消息（end：没有工具调用的那条，正文在 bot/turn-result 里）；
   *     { i, t: 'r', id, ok, out? }                                      一个工具结果；
   *     主控按 i 去重、按 i 排序，重复帧与乱序帧不会写两遍；
   *   - final:true 的那一帧在 bot/turn-result 之前发出，带本回合全部步骤（有上限），用来修补丢掉的中间帧；
   *   - 文本字段有长度上限，超出时节点在文末写「…[已截断 N 字]」；条数或字节超限时丢弃的数量记在 omitted / clipped，不静默。
   * 帧里有推理与工具参数/输出正文，必须加密（E2E_REQUIRED_TYPES 与 E2E_REQUIRED_UPLINK_TYPES）。
   * 旧主控不认识这个帧：节点只在 hub 的 welcome 宣告 bot-trace/1 后才发。
   */
  BOT_TRACE: 'bot/trace',
  /**
   * M2：节点请求主控推送最新配置（重连后发，带上已应用的 revision）。
   * 载荷 { appliedRevision }。明文帧（握手阶段还没 E2E）。
   */
  CONFIG_SYNC_REQUEST: 'hub/config-sync-request',
  /**
   * M2：节点回执配置应用结果。
   * 载荷 { ok, appliedRevision?, error?, rollbackRevision? }。加密发送。
   */
  CONFIG_ACK: 'hub/config-ack',
  /**
   * 并发上限回执。载荷 { requestId, nodeId, ok, maxConcurrent, error? }。
   * ok:true 时 maxConcurrent 是**实际生效**的值；ok:false 时 error 说明
   * 拒绝原因（超出 1–64、nodeId 与连接不符）。
   */
  NODE_CONFIG_RESULT: 'node/config-result',
  MODEL_SYNC_RESULT: 'node/model-sync-result',
  APPROVAL_REQUEST: 'node/approval-request',
  APPROVAL_SETTLED: 'node/approval-settled',
})

/** 中继层信封（relay 只做寻址与转发，不理解业务帧）。 */
/**
 * M4 记忆联邦（S2）：独立的 `mem/*` 通道。
 *
 * 不复用 config-sync —— 后者是 hub→node 的配置面，带 revision/apply/rollback
 * 语义；记忆是两端都可能发起的用户内容，生命周期不同。传输复用现有
 * registry/relay 连接，但帧、校验、状态都独立。
 */
export const MEMORY_CAPS = 'memory-sync/1'
/** Node supports LAN UDP discovery (lib/discovery.js). */
export const LAN_DISCOVERY_CAP = 'lan-discovery/1'
/** Node supports the pairing-code flow and persistent trust store. */
export const PAIRING_CAP = 'pairing/1'
/** Node has a persistent machine identity (not tied to nodeToken). */
export const MACHINE_IDENTITY_CAP = 'machine-identity/1'
/** Node answers bot/locate with a Bot-signed proof (lib/node/dispatch.js). */
export const BOT_LOCATE_CAP = 'bot-locate/1'
/**
 * 两端都认识 bot/trace（节点 Bot 的思考过程与工具步骤）。节点 hello 带它 = 节点会发；
 * hub welcome 带它 = hub 收得下。节点只在 hub 宣告后才发，旧 hub 不会收到它不认识的帧。
 */
export const BOT_TRACE_CAP = 'bot-trace/1'
/**
 * 两端都认识 bot/stream（节点 Bot 的流式文本增量）。节点 hello 带它 = 节点会发；
 * hub welcome 带它 = hub 收得下。节点只在 hub 宣告后才发，旧 hub 不会收到。
 */
/** hub 在 welcome 里宣告的能力；节点凭它决定要不要发 mem/* 与 bot/trace/bot/stream 帧。 */
export const HUB_CAPS = Object.freeze([MEMORY_CAPS, BOT_TRACE_CAP])
/**
 * 节点能在 `bot/update` 里接住 `memoryConfig`（M4 S6 补片）。
 *
 * 老节点（ra < 0.10.1-fork.76）的 validateBotUpdate 要求 model/effort/instructions/
 * workDir 至少一个非 null，只改记忆后端的帧会被它整帧拒掉，hub 只能等超时。
 * hub 凭这条 cap 决定：有它才发 memoryConfig；没有就丢掉该字段、只发其余字段，
 * 而只想改后端时直接给出可读错误，不假装成功也不干等 30 秒。
 */
export const BOT_MEMORY_UPDATE_CAP = 'bot-memory-update/1'
/** Profile-only updates require a node that preserves these fields through validation. */
export const BOT_PROFILE_UPDATE_CAP = 'bot-profile-update/1'
/** The node takes `mode` (steer | queue) on bot/turn and joins a steer into the running turn. */
export const BOT_TURN_MODE_CAP = 'bot-turn-mode/1'
/** The node has a bot/action receiver (answer a card, stop / follow up / start a task). */
export const BOT_ACTION_CAP = 'bot-action/1'
/** The node takes bot/attach chunks and a `bot/turn.attachments` manifest (images and files from the hub). */
export const BOT_ATTACH_CAP = 'bot-attach/1'
/** The node writes a model's capabilities (input, contextWindow, maxTokens, reasoningEfforts) from a config push, validated against pi-ai. */
export const CONFIG_MODELS_CAP = 'config-models/1'
/** The node reports the cards its Bots wait on (approvals, questions, proposals) in its roster. */
export const ROSTER_CARDS_CAP = 'roster-cards/1'
/** Phase 5: the node supports Bot migration (move_bot / epoch-based lease handoff). */
export const BOT_MOVE_CAP = 'bot-move/1'

/**
 * 节点 hello 的能力清单：协议能力（fs/exec/artifact/agent）+ 传输与同步能力。
 * 两处 hello 组装（握手与状态视图）都走这里，避免其中一处漏掉新能力。
 */
export function nodeCaps(baseCaps, platform = process.platform) {
  return [
    ...baseCaps,
    'file-transfer', 'selfcheck', 'config-sync/2', 'peer/v1', MEMORY_CAPS, BOT_MEMORY_UPDATE_CAP, BOT_PROFILE_UPDATE_CAP,
    BOT_TURN_MODE_CAP, BOT_ACTION_CAP, ROSTER_CARDS_CAP, BOT_TRACE_CAP, BOT_ATTACH_CAP, CONFIG_MODELS_CAP,
    LAN_DISCOVERY_CAP, PAIRING_CAP, MACHINE_IDENTITY_CAP, BOT_LOCATE_CAP, BOT_MOVE_CAP,
    ...(platform === 'win32' ? ['desktop', 'gui'] : []),
  ]
}
/** 单帧上限：快照 32KB 正文 + JSON 包装的余量。超限整帧丢弃，不截字段。 */
export const MAX_MEMORY_FRAME_BYTES = 64 * 1024

export const MEMORY = Object.freeze({
  HELLO: 'mem/hello',
  SNAPSHOT: 'mem/snapshot',
  READ: 'mem/read',
  READ_RESULT: 'mem/read-result',
  WRITE: 'mem/write',
  WRITE_RESULT: 'mem/write-result',
  ACK: 'mem/ack',
})

const MEMORY_TYPES = new Set(Object.values(MEMORY))
/** hub→node 的正文帧：E2E 未建立时节点必须拒收。 */
export const MEMORY_INBOUND_BODY = Object.freeze([MEMORY.SNAPSHOT, MEMORY.READ_RESULT, MEMORY.WRITE_RESULT])
/** node→hub 的正文帧：同样只允许在 E2E 会话内发送/接收。 */
export const MEMORY_NODE_BODY = Object.freeze([MEMORY.READ, MEMORY.WRITE])

export function isMemoryFrameType(type) {
  return typeof type === 'string' && MEMORY_TYPES.has(type)
}

export const RELAY_FRAME = Object.freeze({
  UP: 'up', // node → relay → hub
  DOWN: 'down', // hub → relay → node
  NODE_ONLINE: 'node/online',
  NODE_OFFLINE: 'node/offline',
  NODE_LIST: 'node/list',
  HELLO_NODE: 'hello/node',
  HELLO_HUB: 'hello/hub',
  // 中继级错误（鉴权失败、nodeId 冲突、目标离线、被吊销）。
  // 早期版本漏定义此常量，而 relay.js 有 8 处 sendJson(conn, RELAY_FRAME.ERROR, ...)：
  // t 为 undefined → JSON.stringify 丢弃该字段 → 对端 decodeFrame 报 missing-type，
  // 于是**所有中继错误帧都送不到**，transport.js / node-registry.js 的 ERROR 分支
  // 也因 `frame.t === undefined` 永假而永不触发。
  ERROR: 'error',
})

export const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  /** 两阶段审批（提案 #2）：hub 已受理但**尚未派给副机**，等面板批准。 */
  PENDING_APPROVAL: 'pending_approval',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
  INTERRUPTED: 'interrupted',
  /** 两阶段审批终态：面板拒绝 / 审批超时 / 挂起期间被取消。 */
  REJECTED: 'rejected',
})

export const TERMINAL_STATUS = new Set([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.ABORTED,
  TASK_STATUS.INTERRUPTED,
  TASK_STATUS.REJECTED,
])

export const TASK_MODE = Object.freeze({
  /** 副机本机起一个真实 DSH agent 会话，独立模型上下文，任务在副机持久运行。 */
  AGENT: 'agent',
  /** 副机直接执行一段命令（调试 / 简单活）。 */
  EXEC: 'exec',
})

export const ARTIFACT_ROLE = Object.freeze({
  /** 成品：允许 hub 显式 pull。 */
  FINAL: 'final',
  /** 中间产物：只在副机留存，仅上报元数据。 */
  INTERMEDIATE: 'intermediate',
  /** 未归类：上报元数据，默认不可 pull。 */
  OTHER: 'other',
})

export const ARTIFACT_KIND = Object.freeze({
  FILE: 'file',
  DIR: 'dir',
  DIFF: 'diff',
  REPORT: 'report',
  MEDIA: 'media',
})

export const ERROR_CODE = Object.freeze({
  PEER_AUTH_FAILED: 'peer-auth-failed',
  PROTOCOL_MISMATCH: 'protocol-mismatch',
  UNAUTHORIZED: 'unauthorized',
  DUPLICATE_NODE: 'duplicate-node',
  TASK_DUPLICATE: 'task-duplicate',
  TASK_UNKNOWN: 'task-unknown',
  WORKSPACE_DENIED: 'workspace-denied',
  ARTIFACT_DENIED: 'artifact-denied',
  ARTIFACT_MISSING: 'artifact-missing',
  ARTIFACT_TOO_LARGE: 'artifact-too-large',
  HASH_MISMATCH: 'hash-mismatch',
  /** 远程文件请求超时（提案 #25）：node 未在时限内回 fs/res。 */
  FS_TIMEOUT: 'fs-timeout',
  /** hub 身份验证失败：指纹不匹配 / 签名无效 / nonce 对不上 / 时间戳超窗。 */
  HUB_IDENTITY_MISMATCH: 'hub-identity-mismatch',
  /** relay 模式下 hub 身份帧尚未到达（宽限窗口内），任务暂不执行。 */
  HUB_IDENTITY_PENDING: 'hub-identity-pending',
  /**
   * E2E 会话丢失（提案 #1）：hub 侧没有该节点的会话（典型：hub 重启而中继
   * 与副机的连接还活着）。副机收到后重新走 node/e2e 握手。必须走明文 ERROR
   * 帧 —— 此时双方已无共享密钥可言。
   */
  E2E_RESET: 'e2e-reset',
  /** 副机侧拒绝未加密的业务帧（会话已建立却收到明文 = 伪造或 hub 丢会话）。 */
  E2E_REQUIRED: 'e2e-required',
  INTERNAL: 'internal',
})

export const DEFAULT_HEARTBEAT_MS = 15_000
export const DEFAULT_ACK_TIMEOUT_MS = 60_000
export const DEFAULT_PULL_TIMEOUT_MS = 30 * 60 * 1000
/** 单帧二进制分块上限：256 KiB（base64 回退时约 341 KiB）。 */
export const ARTIFACT_CHUNK_BYTES = 256 * 1024
/** 中继/控制帧的单帧文本上限，防止畸形帧吃内存。 */
export const MAX_CONTROL_FRAME_BYTES = 4 * 1024 * 1024
export const MAX_ARTIFACT_FRAME_BYTES = 8 * 1024 * 1024

let counter = 0

/** 生成一个短小、无依赖、可读的 id。 */
export function newId(prefix = 'x') {
  counter = (counter + 1) & 0xffffff
  const t = Date.now().toString(36)
  const r = Math.floor(Math.random() * 0x10000).toString(36)
  return `${prefix}-${t}${r}${counter.toString(36)}`
}

export function newTaskId() {
  return newId('t')
}

export function newPullId() {
  return newId('p')
}

/** 构造一个协议信封。 */
export function envelope(type, data, opts = {}) {
  const frame = { v: PROTOCOL_VERSION, t: type, id: opts.id ?? newId('m'), d: data ?? {} }
  if (opts.replyTo) frame.r = opts.replyTo
  return frame
}

export function encodeFrame(frame) {
  return JSON.stringify(frame)
}

/**
 * 二进制帧：`[u16 BE 头部长度][头部 JSON][净荷字节]`。
 *
 * 为什么不用 base64 塞进 JSON：产物分块是纯字节流，base64 有 33% 膨胀，
 * 而且中继必须能只读头部就完成路由 —— 净荷一个字节都不该被解码。
 */
export function encodeBinaryFrame(header, payload) {
  const head = Buffer.from(JSON.stringify(header), 'utf8')
  if (head.length > 0xffff) throw new RemoteAgentError('binary frame header too large', ERROR_CODE.INTERNAL)
  const out = Buffer.allocUnsafe(2 + head.length + payload.length)
  out.writeUInt16BE(head.length, 0)
  head.copy(out, 2)
  payload.copy(out, 2 + head.length)
  return out
}

/** 解析二进制帧。失败返回 {ok:false}，绝不抛。 */
export function decodeBinaryFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return { ok: false, error: 'binary-frame-too-short' }
  const headLen = buf.readUInt16BE(0)
  if (buf.length < 2 + headLen) return { ok: false, error: 'binary-frame-header-truncated' }
  let header
  try {
    header = JSON.parse(buf.subarray(2, 2 + headLen).toString('utf8'))
  } catch {
    return { ok: false, error: 'binary-frame-header-malformed' }
  }
  if (!header || typeof header !== 'object') return { ok: false, error: 'binary-frame-header-not-object' }
  return { ok: true, header, payload: buf.subarray(2 + headLen) }
}

/**
 * 把二进制编解码器注入传输层，避免 ws.js ↔ transport.js 的模块初始化期循环依赖。
 * 在 node/transport.js 加载时自动完成；单独使用 protocol.js 时不需要调用。
 */
export function bindBinaryCodecInto(transportModule) {
  transportModule.bindBinaryCodec(encodeBinaryFrame, decodeBinaryFrame)
}

/**
 * 解析并校验一个信封。
 * @returns {{ok:true, frame:object} | {ok:false, error:string}}
 */
export function decodeFrame(raw) {
  let parsed
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
  } catch {
    return { ok: false, error: 'malformed-json' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'malformed-envelope' }
  }
  if (typeof parsed.t !== 'string' || parsed.t === '') {
    return { ok: false, error: 'missing-type' }
  }
  if (parsed.v !== PROTOCOL_VERSION) {
    return { ok: false, error: ERROR_CODE.PROTOCOL_MISMATCH }
  }
  return { ok: true, frame: parsed }
}

/** 一个协议错误，携带稳定 code，便于上层映射到工具错误。 */
export class RemoteAgentError extends Error {
  constructor(message, code = ERROR_CODE.INTERNAL, details = undefined) {
    super(message)
    this.name = 'RemoteAgentError'
    this.code = code
    this.details = details
  }
}

/**
 * 校验 hello 帧。node 与 hub 共用，保证双方对"什么是合法节点"理解一致。
 * @returns {{ok:true, hello:object} | {ok:false, error:string}}
 */
export function validateHello(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: 'hello-missing' }
  if (typeof d.nodeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(d.nodeId)) {
    return { ok: false, error: 'hello-nodeId-invalid' }
  }
  if (d.protocol !== PROTOCOL_VERSION) {
    return { ok: false, error: ERROR_CODE.PROTOCOL_MISMATCH }
  }
  const os = d.os === 'windows' || d.os === 'linux' || d.os === 'darwin' ? d.os : undefined
  if (!os) return { ok: false, error: 'hello-os-invalid' }
  return {
    ok: true,
    hello: {
      nodeId: d.nodeId,
      protocol: d.protocol,
      os,
      arch: typeof d.arch === 'string' ? d.arch : 'unknown',
      hostname: typeof d.hostname === 'string' ? d.hostname : d.nodeId,
      dshVersion: typeof d.dshVersion === 'string' ? d.dshVersion : '',
      // The AC version this node runs (0.4.28+): lets the hub say which node is behind what ds-bot needs.
      acVersion: typeof d.acVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,24})?$/.test(d.acVersion) ? d.acVersion : '',
      shells: Array.isArray(d.shells) ? d.shells.filter((s) => typeof s === 'string') : [],
      roots: Array.isArray(d.roots) ? d.roots.filter((s) => typeof s === 'string') : [],
      caps: Array.isArray(d.caps) ? d.caps.filter((s) => typeof s === 'string') : [],
      profile: typeof d.profile === 'string' ? d.profile : '',
      agentMode: d.agentMode === true,
      transportMode: d.transportMode === 'direct' || d.transportMode === 'relay' ? d.transportMode : undefined,
      ...(normalizePeerUrl(d.peerUrl) ? { peerUrl: normalizePeerUrl(d.peerUrl) } : {}),
      // P2-11：本次连接的挑战随机数（hex）。hub 把它签进 welcome/hub-identity
      // 的身份证明，副机核对一致 —— 防"录一帧旧 welcome 重放给新连接"。
      // 缺失（旧版副机）时为空串，hub 退化成自拟 nonce + 时间戳窗口。
      nonce: typeof d.nonce === 'string' && /^[0-9a-f]{16,128}$/.test(d.nonce) ? d.nonce : '',
      time: typeof d.time === 'number' ? d.time : Date.now(),
    },
  }
}

/**
 * 归一化 `artifactRules`，**含内层形状校验**。
 *
 * 合法形状：`{ final?: string[], intermediate?: string[], caseInsensitive?: boolean }`
 * （见 lib/artifacts.js 的 `classify()` —— 它读 `rules.intermediate?.length` /
 * `rules.final?.length` 后交给 `compileRules`，后者要求数组）。
 *
 * 为什么必须校验内层：`typeof x === 'object'` 只挡住 null/undefined/数字/布尔，
 * **字符串与数组也能通过**。而 `'dist/**'.length` 是真值，于是：
 *   - 传 `{ final: 'dist/**' }` → `rules.final?.length` 为 7（真）→
 *     `compileRules('dist/**')` 把字符串按可迭代对象处理 → 逐字符编译成规则，
 *     得到 `["d","i","s","t","/","*","*"]` 这类垃圾。
 *   - 实测后果：单字符文件被误判为可 pull 的 final，而真正的 `dist/app.js`
 *     反而漏掉，**无异常、无日志**。
 *
 * 非数组一律丢弃（与 outputs / denyPaths 的处理方式一致），而不是静默透传。
 * `caseInsensitive` 只接受真正的布尔。
 */
export function normalizeArtifactRules(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const pick = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === 'string' && p !== '') : undefined)
  const out = {}
  const final = pick(raw.final)
  const intermediate = pick(raw.intermediate)
  if (final !== undefined) out.final = final
  if (intermediate !== undefined) out.intermediate = intermediate
  if (typeof raw.caseInsensitive === 'boolean') out.caseInsensitive = raw.caseInsensitive
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 归一化一个模型选择（可选）。
 *
 * 接受三种写法（对小白最友好到最精确）：
 *   - `'gpt-4o'`                  → `{ model: 'gpt-4o' }`（provider 用副机默认）
 *   - `'openai/gpt-4o'`           → `{ provider: 'openai', model: 'gpt-4o' }`
 *   - `{ provider, model, reasoningEffort? }` → 逐字段过滤后原样保留
 *
 * 其他输入（数字 / 数组 / 空串 / 字段类型不对）一律返回 undefined，
 * 与 outputs / denyPaths 的处理方式一致 —— 宁可丢掉一个坏参数回到
 * "副机默认模型"，也不能把垃圾透传给 runner。
 *
 * 注意：这里只传**选择**，不传凭证 —— 模型 key 始终在副机（核心不变式 1）。
 * 副机拿到选择后用自己的 provider 配置去跑；指定的 provider/model 在副机
 * 不存在时，错误会经 agent/error 监听如实进入 handoff（2026-10-15 修复后
 * 错误不再被静默吞掉）。
 */
export function normalizeModelSelection(raw) {
  if (raw === undefined || raw === null) return undefined

  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === '') return undefined
    // 'provider/model'：provider 段不含 '/'，model 段允许再带（如 openrouter 的 org/model）
    const slash = s.indexOf('/')
    if (slash > 0 && slash < s.length - 1) {
      return { provider: s.slice(0, slash).slice(0, 64), model: s.slice(slash + 1).slice(0, 128) }
    }
    return { model: s.slice(0, 128) }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  if (typeof raw.provider === 'string' && raw.provider !== '') out.provider = raw.provider.slice(0, 64)
  if (typeof raw.model === 'string' && raw.model !== '') out.model = raw.model.slice(0, 128)
  if (typeof raw.reasoningEffort === 'string' && raw.reasoningEffort !== '') {
    out.reasoningEffort = raw.reasoningEffort.slice(0, 32)
  }
  // 没有 model 的选择不是合法选择（provider 必须配 model，单独 provider 无效）——
  // 与 outputs / denyPaths 一致：坏参数丢掉，回到副机默认。
  if (out.model === undefined) return undefined
  return out
}

/**
 * 校验 task/start 帧。
 * @returns {{ok:true, spec:object} | {ok:false, error:string}}
 */
export function validateTaskStart(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: 'task-missing' }
  if (typeof d.taskId !== 'string' || d.taskId === '') return { ok: false, error: 'task-taskId-missing' }
  if (typeof d.goal !== 'string' || d.goal.trim() === '') return { ok: false, error: 'task-goal-missing' }
  const mode = d.mode === TASK_MODE.EXEC ? TASK_MODE.EXEC : TASK_MODE.AGENT
  const c = d.constraints && typeof d.constraints === 'object' ? d.constraints : {}
  return {
    ok: true,
    spec: {
      taskId: d.taskId,
      goal: d.goal,
      workspace: typeof d.workspace === 'string' && d.workspace ? d.workspace : undefined,
      mode,
      model: normalizeModelSelection(d.model),
      constraints: {
        timeoutMs: Number.isFinite(c.timeoutMs) ? Math.max(1000, c.timeoutMs) : 60 * 60 * 1000,
        maxBytesWritten: Number.isFinite(c.maxBytesWritten) ? c.maxBytesWritten : 2 * 1024 * 1024 * 1024,
        allowNetwork: c.allowNetwork !== false,
        denyPaths: Array.isArray(c.denyPaths) ? c.denyPaths.filter((p) => typeof p === 'string') : [],
        extraEnv: c.extraEnv && typeof c.extraEnv === 'object' ? c.extraEnv : {},
      },
      outputs: Array.isArray(d.outputs) ? d.outputs.filter((p) => typeof p === 'string') : [],
      // 两阶段审批（提案 #2）：'manual' = hub 挂起待面板批准，只在调用方显式
      // 要求时才启用；缺省（含坏值）一律 'auto'。AC 是用户自己的集群，派给
      // 副机的任务不该默认卡在"待审批"里（exec 曾默认 manual，已改）。
      approval: d.approval === 'manual' ? 'manual' : 'auto',
      artifactRules: normalizeArtifactRules(d.artifactRules),
      summaryPolicy: d.summaryPolicy === 'stream' ? 'stream' : 'on-complete',
      requestedAt: typeof d.requestedAt === 'number' ? d.requestedAt : Date.now(),
      origin: typeof d.origin === 'string' ? d.origin : 'hub',
    },
  }
}

function requiredTurnId(value, code) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, error: code }
  return { ok: true, value: value.trim() }
}

function botNetworkString(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
}

function botNetworkIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!botNetworkString(value.id, 200) || !botNetworkString(value.name, 80) || !botNetworkString(value.nodeId, 80)) return null
  const identity = { id: value.id, name: value.name, nodeId: value.nodeId }
  // A Bot's portable id (16 hex, ed25519 fingerprint): the key every machine knows the Bot by.
  if (typeof value.identityId === 'string' && /^[0-9a-f]{16}$/.test(value.identityId)) identity.identityId = value.identityId
  return identity
}

/** 校验并重建 bot/message；坏帧抛出稳定错误，不透传未知字段。 */
export function validateBotMessage(d) {
  const invalid = () => { throw new RemoteAgentError('invalid bot/message payload', 'bot-message-invalid') }
  if (!d || typeof d !== 'object' || Array.isArray(d)) invalid()
  const from = botNetworkIdentity(d.from)
  const to = botNetworkIdentity(d.to)
  if (!botNetworkString(d.exchangeId, 200) || !['ask', 'reply'].includes(d.kind) || !from || !to ||
    typeof d.text !== 'string' || d.text.length > 65536 || !Number.isInteger(d.depth) || d.depth < 0 || d.depth > 3) invalid()
  return { exchangeId: d.exchangeId, kind: d.kind, from, to, text: d.text, depth: d.depth }
}

/** rel/frame 内层载荷的 JSON 上限。 */
export const REL_DATA_MAX = 262_144
const REL_TYPE_RE = /^[a-z][a-z0-9_-]{0,31}\/[a-z][a-z0-9_/-]{0,62}$/

/**
 * 校验 rel/frame：可靠通道的一条消息（lib/reliable-link.js）。rid 全局唯一；type 是内层帧类型；
 * to 只在节点经主控转发时出现；from 只由主控填（接收方以链路事实为准）。
 */
export function validateRelFrame(d) {
  const invalid = () => { throw new RemoteAgentError('invalid rel/frame payload', 'rel-invalid') }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !botNetworkString(d.rid, 200) || typeof d.type !== 'string' || !REL_TYPE_RE.test(d.type)) invalid()
  const data = d.data === undefined ? {} : d.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid()
  let size = 0
  try { size = JSON.stringify(data).length } catch { invalid() }
  if (size > REL_DATA_MAX) invalid()
  const out = { rid: d.rid, type: d.type, data }
  if (d.to !== undefined) { if (!botNetworkString(d.to, 80)) invalid(); out.to = d.to }
  if (d.from !== undefined) { if (!botNetworkString(d.from, 80)) invalid(); out.from = d.from }
  return out
}

/** 校验 rel/ack。 */
export function validateRelAck(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !botNetworkString(d.rid, 200)) throw new RemoteAgentError('invalid rel/ack payload', 'rel-invalid')
  return { rid: d.rid }
}

/** team/act 携带的工具参数（JSON 文本）上限。 */
export const TEAM_ACT_ARGS_MAX = 32_768
const TEAM_ACT_TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/

/**
 * 校验 team/act：节点上的 Bot 请主控代为执行一个团队管理工具（建 Bot、建群等）。
 * actor 用全队通用 id；args 是工具参数的 JSON 文本。主控决定是否允许，传输层不判断。
 */
export function validateTeamAct(d) {
  const invalid = () => { throw new RemoteAgentError('invalid team/act payload', 'team-act-invalid') }
  if (!d || typeof d !== 'object' || Array.isArray(d)) invalid()
  const actor = botNetworkIdentity(d.actor)
  if (!actor || !botNetworkString(d.requestId, 200) || typeof d.tool !== 'string' || !TEAM_ACT_TOOL_RE.test(d.tool) ||
    typeof d.args !== 'string' || d.args.length > TEAM_ACT_ARGS_MAX) invalid()
  return { requestId: d.requestId, actor, tool: d.tool, args: d.args }
}

/** 校验 team/act-result：主控执行结果（工具返回的文本）。 */
export function validateTeamActResult(d) {
  const invalid = () => { throw new RemoteAgentError('invalid team/act-result payload', 'team-act-invalid') }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !botNetworkString(d.requestId, 200) || typeof d.ok !== 'boolean' ||
    typeof d.text !== 'string') invalid()
  return { requestId: d.requestId, ok: d.ok, text: d.text.slice(0, 65536) }
}



/** bot/directory 里 Bot 的状态：空闲 / 干活中 / 等人 / 离线。 */
export const BOT_DIRECTORY_STATES = Object.freeze(['available', 'working', 'waiting', 'offline'])
/** bot/directory 里机器列表的上限（主控 + 节点）。 */
export const BOT_DIRECTORY_MAX_MACHINES = 64

function directoryText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * 全队目录（主控 → 节点）：Bot 最多 500 项，坏条目丢弃，身份上限与 bot/message 一致，role 可省略或为空；
 * 每个 Bot 可带 identityId / hostname / online / state / model；machines 是全队机器列表。
 */
export function validateBotDirectory(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.bots) || d.bots.length > 500) {
    throw new RemoteAgentError('invalid bot/directory payload', 'bot-directory-invalid')
  }
  const bots = []
  for (const raw of d.bots) {
    const identity = botNetworkIdentity(raw)
    if (!identity || (raw.role != null && typeof raw.role !== 'string')) continue
    const bot = { ...identity, role: raw.role ?? '' }
    const hostname = directoryText(raw.hostname, 80)
    if (hostname !== '') bot.hostname = hostname
    if (typeof raw.online === 'boolean') bot.online = raw.online
    if (BOT_DIRECTORY_STATES.includes(raw.state)) bot.state = raw.state
    const model = directoryText(raw.model, 120)
    if (model !== '') bot.model = model
    bots.push(bot)
  }
  const rooms = []
  for (const raw of Array.isArray(d.rooms) ? d.rooms.slice(0, 100) : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !botNetworkString(raw.id, 200) ||
      (raw.name !== undefined && typeof raw.name !== 'string') ||
      (raw.members !== undefined && (!Number.isInteger(raw.members) || raw.members < 0))) continue
    const room = { id: raw.id }
    if (raw.name !== undefined) room.name = raw.name.trim().slice(0, 80)
    if (raw.members !== undefined) room.members = raw.members
    rooms.push(room)
  }
  const out = { bots, rooms, at: Number.isFinite(d.at) ? d.at : Date.now() }
  if (!Array.isArray(d.machines)) return out
  const machines = []
  for (const raw of d.machines.slice(0, BOT_DIRECTORY_MAX_MACHINES)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !botNetworkString(raw.nodeId, 80)) continue
    const machine = { nodeId: raw.nodeId, hostname: directoryText(raw.hostname, 80) || raw.nodeId, online: raw.online === true }
    const os = directoryText(raw.os, 40)
    if (os !== '') machine.os = os
    const acVersion = directoryText(raw.acVersion, 40)
    if (acVersion !== '') machine.acVersion = acVersion
    if (['hub', 'both', 'worker'].includes(raw.role)) machine.role = raw.role
    if (Number.isFinite(raw.lastSeen) && raw.lastSeen >= 0) machine.lastSeen = raw.lastSeen
    if (Number.isFinite(raw.rttMs) && raw.rttMs >= 0) machine.rttMs = Math.round(raw.rttMs)
    machines.push(machine)
  }
  out.machines = machines
  return out
}

/**
 * bot/attach 与 bot/turn.attachments 清单的上限（hub 发图片/文件给节点 Bot，能力 bot-attach/1）。
 * 附件按块经 bot/attach 先到，随后的 bot/turn 用 attachments 清单点名它们。
 */
export const BOT_ATTACH_LIMITS = Object.freeze({
  maxAttachments: 8,
  maxChunks: 40,
  maxChunkChars: 1_100_000,
  maxNameChars: 200,
  maxMediaTypeChars: 64,
  maxBytes: 20 * 1024 * 1024,
})

const BASE64_CHARSET = /^[A-Za-z0-9+/]*={0,2}$/
const SHA256_HEX = /^[0-9a-f]{64}$/

function boundedInteger(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/**
 * 校验 bot/attach：hub → 节点的一块附件字节。同一 exchangeId 的第 index 个附件分 chunks 块，
 * chunk 从 0 起。没有结果帧；校验失败由处理方回 error 帧。
 * @returns {{ok:true, attach:object} | {ok:false, error:string}}
 */
export function validateBotAttach(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-attach-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-attach-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-attach-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const exchangeId = requiredTurnId(d.exchangeId, 'bot-attach-exchangeId-missing')
  if (!exchangeId.ok) return exchangeId
  const limits = BOT_ATTACH_LIMITS
  if (!boundedInteger(d.index, 0, limits.maxAttachments - 1)) return { ok: false, error: 'bot-attach-index-invalid' }
  if (!boundedInteger(d.chunks, 1, limits.maxChunks)) return { ok: false, error: 'bot-attach-chunks-invalid' }
  if (!boundedInteger(d.chunk, 0, d.chunks - 1)) return { ok: false, error: 'bot-attach-chunk-invalid' }
  if (typeof d.data !== 'string' || d.data === '') return { ok: false, error: 'bot-attach-data-missing' }
  if (d.data.length > limits.maxChunkChars) return { ok: false, error: 'bot-attach-data-too-large' }
  if (!BASE64_CHARSET.test(d.data)) return { ok: false, error: 'bot-attach-data-invalid' }
  return {
    ok: true,
    attach: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      exchangeId: exchangeId.value,
      index: d.index,
      chunk: d.chunk,
      chunks: d.chunks,
      data: d.data,
    },
  }
}

/**
 * bot/turn 的 attachments 清单。缺省 / null / 空数组 = 没有附件（返回 []）；
 * 任何一条不合格都返回 null，调用方整帧拒绝，绝不悄悄丢掉某一条。
 */
function cleanBotAttachments(raw) {
  if (raw === undefined || raw === null) return []
  const limits = BOT_ATTACH_LIMITS
  if (!Array.isArray(raw) || raw.length > limits.maxAttachments) return null
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    if (!boundedInteger(item.index, 0, limits.maxAttachments - 1) || seen.has(item.index)) return null
    if (typeof item.name !== 'string') return null
    const name = item.name.trim()
    if (name === '' || name.length > limits.maxNameChars) return null
    if (item.kind !== 'image' && item.kind !== 'file') return null
    if (item.mediaType !== undefined && (typeof item.mediaType !== 'string' || item.mediaType.length > limits.maxMediaTypeChars)) return null
    if (!boundedInteger(item.bytes, 1, limits.maxBytes)) return null
    if (typeof item.sha256 !== 'string' || !SHA256_HEX.test(item.sha256)) return null
    if (!boundedInteger(item.chunks, 1, limits.maxChunks)) return null
    seen.add(item.index)
    out.push({
      index: item.index,
      name,
      kind: item.kind,
      ...(typeof item.mediaType === 'string' && item.mediaType !== '' ? { mediaType: item.mediaType } : {}),
      bytes: item.bytes,
      sha256: item.sha256,
      chunks: item.chunks,
    })
  }
  return out
}

/**
 * 校验 bot/turn。缺 nodeId / remoteBotId / exchangeId / text 即拒绝。
 * 不读 mode，不改写成 agent，不调用 validateTaskStart。
 * @returns {{ok:true, turn:object} | {ok:false, error:string}}
 */
export function validateBotTurn(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-turn-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-turn-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-turn-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const exchangeId = requiredTurnId(d.exchangeId, 'bot-turn-exchangeId-missing')
  if (!exchangeId.ok) return exchangeId
  if (typeof d.text !== 'string') return { ok: false, error: 'bot-turn-text-missing' }
  const sender = {}
  for (const field of ['senderBotId', 'senderName']) {
    if (!Object.hasOwn(d, field)) continue
    if (typeof d[field] !== 'string' || d[field].trim() === '') return { ok: false, error: 'bot-turn-sender-invalid' }
    const value = d[field].trim()
    if (value.length > 80) return { ok: false, error: 'bot-turn-sender-too-long' }
    sender[field] = value
  }
  const room = {}
  for (const [field, limit] of [['roomId', 200], ['roomName', 80]]) {
    if (!Object.hasOwn(d, field)) continue
    if (typeof d[field] !== 'string' || d[field].trim() === '') return { ok: false, error: 'bot-turn-room-invalid' }
    const value = d[field].trim()
    if (value.length > limit) return { ok: false, error: 'bot-turn-room-invalid' }
    room[field] = value
  }
  // How the sender wants a busy Bot to take it: 'steer' joins the turn in flight, 'queue' waits for
  // it. Anything else is read as not given (the node then queues, as it always did).
  const mode = d.mode === 'steer' || d.mode === 'queue' ? { mode: d.mode } : {}
  // Images / files the hub put on the link as bot/attach chunks just before this turn (bot-attach/1).
  // One bad entry rejects the whole turn: an attachment is never dropped on the way.
  const attachmentList = cleanBotAttachments(d.attachments)
  if (attachmentList === null) return { ok: false, error: 'bot-turn-attachments-invalid' }
  const attachments = attachmentList.length > 0 ? { attachments: attachmentList } : {}
  return {
    ok: true,
    turn: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      exchangeId: exchangeId.value,
      text: d.text,
      ...sender,
      ...room,
      ...mode,
      ...attachments,
    },
  }
}

/**
 * 校验 bot/turn-result。正文可为空字符串；缺身份字段拒绝。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
/**
 * 校验 bot/create。缺 nodeId / name / requestId 即拒绝。
 * @returns {{ok:true, create:object} | {ok:false, error:string}}
 */
function cleanMemoryConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  if (typeof input.backend !== 'string') return null
  const backend = input.backend.trim()
  if (backend === '' || backend.length > 32) return null
  return { backend }
}

/**
 * `bot/update` 的 memoryConfig：出现即必须是 `{backend: 非空字符串 ≤32}`。
 *
 * 与 create 的宽松读法不同 —— update 是显式改后端，坏形状整帧拒绝，
 * 不能静默读成「没给」然后回一个 ok。backend 是否属于记忆后端枚举由节点上的
 * ds-bot roster 判（这里只管形状，未知枚举值由 roster 丢弃，不拒帧）。
 */
function parseMemoryConfig(input) {
  if (input === undefined || input === null) return { ok: true, value: null }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false }
  if (typeof input.backend !== 'string') return { ok: false }
  const backend = input.backend.trim()
  if (backend === '' || backend.length > 32) return { ok: false }
  return { ok: true, value: { backend } }
}

export function validateBotCreate(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-create-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-create-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const requestId = requiredTurnId(d.requestId, 'bot-create-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.name !== 'string' || d.name.trim() === '') return { ok: false, error: 'bot-create-name-missing' }
  // Only the hub may claim a Bot; an unknown marker is refused, never read as "not given",
  // because losing it would silently turn fail-closed model selection back into a fallback.
  if (d.managedBy !== undefined && d.managedBy !== null && d.managedBy !== 'hub') {
    return { ok: false, error: 'bot-create-managedBy-invalid' }
  }
  return {
    ok: true,
    create: {
      nodeId: nodeId.value,
      requestId: requestId.value,
      name: d.name.trim().slice(0, 40),
      role: typeof d.role === 'string' ? d.role.trim().slice(0, 24) : '',
      // The spec the main sent for the Bot itself. A field of the wrong type is read as
      // "not given" (null) rather than refusing the frame; the receiver validates the values
      // (model served, workDir inside the node's roots). No length cut here: the instructions
      // limit (8000 bytes) is enforced once, on the sending side.
      modelRef: stringOrNull(d.modelRef),
      effort: stringOrNull(d.effort),
      // The hub's level when the creator named none (≤64, as the hub sends it) and the
      // ownership marker a later turn reads to fail closed instead of falling back.
      defaultEffort: typeof d.defaultEffort === 'string' && d.defaultEffort !== '' ? d.defaultEffort.slice(0, 64) : null,
      managedBy: d.managedBy === 'hub' ? 'hub' : null,
      workDir: stringOrNull(d.workDir),
      instructions: stringOrNull(d.instructions),
      // M4 S4: the memory backend the main picked for this Bot (`{backend:'federation'}`).
      // The node's own roster validates the value against MEMORY_BACKENDS; here it only
      // has to arrive as a small object, and a wrong shape reads as "not given".
      memoryConfig: cleanMemoryConfig(d.memoryConfig),
    },
  }
}

/**
 * Validate bot/history request from hub.
 * @returns {{ok:true, hist:object} | {ok:false, error:string}}
 */
export function validateBotHistory(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-history-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-history-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const requestId = requiredTurnId(d.requestId, 'bot-history-requestId-missing')
  if (!requestId.ok) return requestId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-history-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  return {
    ok: true,
    hist: {
      nodeId: nodeId.value,
      requestId: requestId.value,
      remoteBotId: remoteBotId.value,
      cursor: d.cursor != null && typeof d.cursor === 'object' ? d.cursor : null,
    },
  }
}

/**
 * Validate bot/history-result from node.
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotHistoryResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-history-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-history-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (d.ok === false) {
    return { ok: true, result: { requestId: requestId.value, ok: false, error: typeof d.error === 'string' ? d.error : 'bot-history-failed' } }
  }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: true,
      sessionId: typeof d.sessionId === 'string' ? d.sessionId : '',
      items: Array.isArray(d.items) ? d.items : [],
      cursor: d.cursor != null ? d.cursor : null,
    },
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 校验 bot/create-result。缺 requestId 即拒绝；失败时 ok:false + error。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotCreateResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-create-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-create-result-requestId-missing')
  if (!requestId.ok) return requestId
  const success = d.ok !== false
  if (success) {
    const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-create-result-remoteBotId-missing')
    if (!remoteBotId.ok) return remoteBotId
    return {
      ok: true,
      result: {
        requestId: requestId.value,
        ok: true,
        remoteBotId: remoteBotId.value,
        name: typeof d.name === 'string' ? d.name.trim().slice(0, 40) : '',
        role: typeof d.role === 'string' ? d.role.trim().slice(0, 24) : '',
      },
    }
  }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: false,
      error: typeof d.error === 'string' && d.error !== '' ? d.error : 'bot-create-failed',
    },
  }
}

export function validateBotTurnResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-turn-result-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-turn-result-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-turn-result-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const exchangeId = requiredTurnId(d.exchangeId, 'bot-turn-result-exchangeId-missing')
  if (!exchangeId.ok) return exchangeId
  if (d.text !== undefined && typeof d.text !== 'string') return { ok: false, error: 'bot-turn-result-text-invalid' }
  if (d.seq === undefined || typeof d.seq !== 'number' || !Number.isInteger(d.seq))
    return { ok: false, error: 'bot-turn-result-seq-missing' }
  if (d.seq < 0)
    return { ok: false, error: 'bot-turn-result-seq-invalid' }
  const room = {}
  if (Object.hasOwn(d, 'roomId')) {
    if (typeof d.roomId !== 'string' || d.roomId.trim() === '' || d.roomId.trim().length > 200)
      return { ok: false, error: 'bot-turn-result-room-invalid' }
    room.roomId = d.roomId.trim()
  }
  return {
    ok: true,
    result: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      exchangeId: exchangeId.value,
      text: typeof d.text === 'string' ? d.text : '',
      ok: d.ok !== false,
      seq: d.seq,
      ...(typeof d.error === 'string' && d.error !== '' ? { error: d.error } : {}),
      ...room,
    },
  }
}

/**
 * bot/trace 的上限。节点与 hub 两边都按这张表裁；文本超长时在文末写明截掉了多少字，
 * 条数 / 字节超限丢掉的数量记在 clipped（帧内）与 omitted（节点自报），不静默。
 */
export const BOT_TRACE_LIMITS = Object.freeze({
  /** 一个回合的步骤总数（final 帧）。 */
  maxItems: 400,
  /** 一个实时帧里的步骤数。 */
  maxBatchItems: 64,
  think: 6000,
  args: 1500,
  out: 3000,
  name: 120,
  callId: 200,
  /** 一条助手消息里的工具调用数。 */
  calls: 16,
  /** 一帧 items 序列化后的字节上限（ws 帧 4 MiB 上限之内留足余量）。 */
  frameBytes: 384 * 1024,
})

function traceClip(value, max, stats) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= max) return value
  let end = max
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  stats.clipped += 1
  return `${value.slice(0, end)}…[已截断 ${value.length - end} 字]`
}

// 工具参数是模型给的原始 JSON 串。超长时仍给一个合法 JSON，页面解析它不会出错。
function traceArgs(value, max, stats) {
  const raw = typeof value === 'string' ? value : ''
  if (raw.length <= max) return raw
  stats.clipped += 1
  const head = raw.slice(0, 300)
  return JSON.stringify({ _truncated: `${head}…[已截断 ${raw.length - head.length} 字]` })
}

function cleanTraceItem(raw, limits, stats) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Number.isSafeInteger(raw.i) || raw.i < 1) return null
  if (raw.t === 'a') {
    const item = { i: raw.i, t: 'a' }
    const think = traceClip(raw.think, limits.think, stats)
    if (think !== '') item.think = think
    if (Array.isArray(raw.calls)) {
      const calls = []
      for (const call of raw.calls.slice(0, limits.calls)) {
        if (!call || typeof call !== 'object' || typeof call.id !== 'string' || call.id.trim() === '' || call.id.length > limits.callId
          || typeof call.name !== 'string' || call.name.trim() === '') { stats.clipped += 1; continue }
        calls.push({ id: call.id, name: call.name.slice(0, limits.name), args: traceArgs(call.args, limits.args, stats) })
      }
      stats.clipped += Math.max(0, raw.calls.length - limits.calls)
      if (calls.length > 0) item.calls = calls
    }
    if (raw.end === true) item.end = true
    return item
  }
  if (raw.t === 'r') {
    if (typeof raw.id !== 'string' || raw.id.trim() === '' || raw.id.length > limits.callId) return null
    const item = { i: raw.i, t: 'r', id: raw.id, ok: raw.ok !== false }
    const out = traceClip(raw.out, limits.out, stats)
    if (out !== '') item.out = out
    return item
  }
  return null
}

/**
 * 校验 bot/trace。缺身份 / seq / items 整帧拒绝；单条步骤不合法只丢那一条并记入 clipped。
 * @returns {{ok:true, trace:object} | {ok:false, error:string}}
 */
export function validateBotTrace(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-trace-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-trace-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-trace-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const exchangeId = requiredTurnId(d.exchangeId, 'bot-trace-exchangeId-missing')
  if (!exchangeId.ok) return exchangeId
  if (typeof d.seq !== 'number' || !Number.isInteger(d.seq)) return { ok: false, error: 'bot-trace-seq-missing' }
  if (d.seq < 1) return { ok: false, error: 'bot-trace-seq-invalid' }
  if (!Array.isArray(d.items)) return { ok: false, error: 'bot-trace-items-missing' }
  const room = {}
  if (Object.hasOwn(d, 'roomId')) {
    if (typeof d.roomId !== 'string' || d.roomId.trim() === '' || d.roomId.trim().length > 200) return { ok: false, error: 'bot-trace-room-invalid' }
    room.roomId = d.roomId.trim()
  }
  const limits = BOT_TRACE_LIMITS
  const final = d.final === true
  const cap = final ? limits.maxItems : limits.maxBatchItems
  const stats = { clipped: Math.max(0, d.items.length - cap) }
  const seen = new Set()
  const items = []
  let bytes = 0
  for (const raw of d.items.slice(0, cap)) {
    const item = cleanTraceItem(raw, limits, stats)
    if (item === null || seen.has(item.i)) { stats.clipped += 1; continue }
    bytes += Buffer.byteLength(JSON.stringify(item), 'utf8')
    if (bytes > limits.frameBytes) { stats.clipped += 1; continue }
    seen.add(item.i)
    items.push(item)
  }
  items.sort((a, b) => a.i - b.i)
  const omitted = Number.isSafeInteger(d.omitted) && d.omitted > 0 ? d.omitted : 0
  return {
    ok: true,
    trace: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      exchangeId: exchangeId.value,
      seq: d.seq,
      ...(final ? { final: true } : {}),
      items,
      ...(omitted > 0 ? { omitted } : {}),
      ...(stats.clipped > 0 ? { clipped: stats.clipped } : {}),
      ...room,
    },
  }
}



/**
 * 校验 bot/update。至少一个字段非 null；类型不对按 null，不整帧拒绝。
 * @returns {{ok:true, update:object} | {ok:false, error:string}}
 */
export function validateBotUpdate(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-update-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-update-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-update-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const requestId = requiredTurnId(d.requestId, 'bot-update-requestId-missing')
  if (!requestId.ok) return requestId
  const model = stringOrNull(d.model)
  const effort = stringOrNull(d.effort)
  const instructions = stringOrNull(d.instructions)
  const workDir = stringOrNull(d.workDir)
  const profile = cleanBotUpdateProfile(d)
  const memory = parseMemoryConfig(d.memoryConfig)
  if (!memory.ok) return { ok: false, error: 'bot-update-memoryConfig-invalid' }
  if (model === null && effort === null && instructions === null && workDir === null && memory.value === null
    && Object.values(profile).every(value => value === null)) {
    return { ok: false, error: 'bot-update-all-null' }
  }
  return {
    ok: true,
    update: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      requestId: requestId.value,
      model,
      effort,
      instructions,
      workDir,
      ...profile,
      // 只改记忆后端时其余字段全 null：这条帧是新节点才认的形状，老节点会以
      // bot-update-all-null 拒掉，所以 hub 靠 BOT_MEMORY_UPDATE_CAP 决定发不发。
      memoryConfig: memory.value,
    },
  }
}

/**
 * 校验 bot/update-result。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotUpdateResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-update-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-update-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'bot-update-result-ok-missing' }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: d.ok,
      error: stringOrNull(d.error),
      model: stringOrNull(d.model),
      effort: stringOrNull(d.effort),
      instructions: stringOrNull(d.instructions),
      workDir: stringOrNull(d.workDir),
      ...cleanBotUpdateProfile(d),
      // 节点应用后的后端（null = 这帧没带 memoryConfig，或旧节点不认识该字段）。
      memoryConfig: cleanMemoryConfig(d.memoryConfig),
    },
  }
}

function cleanBotUpdateProfile(d) {
  return {
    name: typeof d.name === 'string' && d.name.trim() !== '' ? d.name.trim().slice(0, 40) : null,
    role: typeof d.role === 'string' ? d.role.trim().slice(0, 24) : null,
    color: typeof d.color === 'string' && d.color.trim().length <= 32 ? d.color.trim() : null,
    avatar: cleanBotUpdateAvatar(d.avatar),
  }
}

function cleanBotUpdateAvatar(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  // null means no change on the wire; an empty object explicitly resets the avatar.
  if (Object.keys(value).length === 0) return {}
  const avatar = {}
  if (value.shape !== undefined) {
    if (typeof value.shape !== 'string' || !/^[a-z][\w-]{0,31}$/.test(value.shape)) return null
    avatar.shape = value.shape
  }
  if (value.image !== undefined) {
    if (typeof value.image !== 'string' || value.image.length > 160_000
      || !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value.image)) return null
    avatar.image = value.image
  }
  return Object.keys(avatar).length > 0 ? avatar : null
}

/**
 * 校验 bot/delete。缺 nodeId / remoteBotId / requestId 即拒绝。
 * @returns {{ok:true, del:object} | {ok:false, error:string}}
 */
export function validateBotDelete(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-delete-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-delete-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-delete-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const requestId = requiredTurnId(d.requestId, 'bot-delete-requestId-missing')
  if (!requestId.ok) return requestId
  return {
    ok: true,
    del: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      requestId: requestId.value,
    },
  }
}

/**
 * 校验 bot/delete-result。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotDeleteResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-delete-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-delete-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'bot-delete-result-ok-missing' }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: d.ok,
      error: stringOrNull(d.error),
    },
  }
}

/**
 * 校验 bot/stop。缺 nodeId / remoteBotId / requestId 即拒绝。
 * @returns {{ok:true, stop:object} | {ok:false, error:string}}
 */
export function validateBotStop(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-stop-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-stop-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-stop-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const requestId = requiredTurnId(d.requestId, 'bot-stop-requestId-missing')
  if (!requestId.ok) return requestId
  return {
    ok: true,
    stop: {
      nodeId: nodeId.value,
      remoteBotId: remoteBotId.value,
      requestId: requestId.value,
    },
  }
}

/**
 * 校验 bot/stop-result。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotStopResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-stop-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-stop-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'bot-stop-result-ok-missing' }
  if (typeof d.stopped !== 'boolean') return { ok: false, error: 'bot-stop-result-stopped-missing' }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: d.ok,
      stopped: d.stopped,
      error: stringOrNull(d.error),
    },
  }
}

/** bot/action 允许的操作。未知操作整帧拒绝，不静默忽略。 */
export const BOT_ACTIONS = Object.freeze(['card-answer', 'task-stop', 'task-send', 'task-start'])

/**
 * 校验 bot/action。缺 nodeId / remoteBotId / requestId 或操作未知即拒绝。
 * params 逐字段过滤：只留 cardId / choice / text / taskId / relation 五个字符串，其余丢弃。
 * @returns {{ok:true, action:object} | {ok:false, error:string}}
 */
export function validateBotAction(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-action-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'bot-action-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const remoteBotId = requiredTurnId(d.remoteBotId, 'bot-action-remoteBotId-missing')
  if (!remoteBotId.ok) return remoteBotId
  const requestId = requiredTurnId(d.requestId, 'bot-action-requestId-missing')
  if (!requestId.ok) return requestId
  if (!BOT_ACTIONS.includes(d.action)) return { ok: false, error: 'bot-action-unknown' }
  const raw = d.params && typeof d.params === 'object' && !Array.isArray(d.params) ? d.params : {}
  const params = {}
  for (const [field, limit] of [['cardId', 200], ['choice', 64], ['text', 4000], ['taskId', 64], ['relation', 16]]) {
    if (typeof raw[field] === 'string' && raw[field] !== '') params[field] = raw[field].slice(0, limit)
  }
  if (d.action === 'card-answer' && (params.cardId === undefined || (params.choice === undefined && params.text === undefined))) {
    return { ok: false, error: 'bot-action-card-answer-incomplete' }
  }
  if ((d.action === 'task-stop' || d.action === 'task-send') && params.taskId === undefined) return { ok: false, error: 'bot-action-taskId-missing' }
  if (d.action === 'task-send' && params.text === undefined) return { ok: false, error: 'bot-action-text-missing' }
  if (d.action === 'task-start' && params.text === undefined) return { ok: false, error: 'bot-action-text-missing' }
  return { ok: true, action: { nodeId: nodeId.value, remoteBotId: remoteBotId.value, requestId: requestId.value, action: d.action, params } }
}

/**
 * 校验 bot/action-result。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotActionResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-action-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-action-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'bot-action-result-ok-missing' }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      ok: d.ok,
      error: stringOrNull(typeof d.error === 'string' ? d.error.slice(0, 200) : null),
      detail: typeof d.detail === 'string' ? d.detail.slice(0, 500) : null,
    },
  }
}

/**
 * 校验 hub/bot/locate（hub → node，查询某 Bot 是否在此节点运行）。
 * Payload { botId, requestId }.
 * @returns {{ok:true, locate:object} | {ok:false, error:string}}
 */
export function validateBotLocate(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-locate-missing' }
  const botId = requiredTurnId(d.botId, 'bot-locate-botId-missing')
  if (!botId.ok) return botId
  const requestId = requiredTurnId(d.requestId, 'bot-locate-requestId-missing')
  if (!requestId.ok) return requestId
  return { ok: true, locate: { botId: botId.value, requestId: requestId.value } }
}

/**
 * 校验 bot/locate-result（node → hub）。nodeId 不取载荷，以认证连接为准。
 * found:true 时必须带 pubKeyB64 与 sig（Bot 私钥对 requestId 的签名），由 hub 验签。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateBotLocateResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'bot-locate-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'bot-locate-result-requestId-missing')
  if (!requestId.ok) return requestId
  const botId = requiredTurnId(d.botId, 'bot-locate-result-botId-missing')
  if (!botId.ok) return botId
  if (typeof d.found !== 'boolean') return { ok: false, error: 'bot-locate-result-found-missing' }
  if (!d.found) return { ok: true, result: { requestId: requestId.value, botId: botId.value, found: false } }
  const short = (value, max) => (typeof value === 'string' && value !== '' && value.length <= max ? value : undefined)
  const pubKeyB64 = short(d.pubKeyB64, 200)
  const sig = short(d.sig, 200)
  if (pubKeyB64 === undefined || sig === undefined) return { ok: false, error: 'bot-locate-result-proof-missing' }
  return {
    ok: true,
    result: { requestId: requestId.value, botId: botId.value, found: true, pubKeyB64, sig, machineId: short(d.machineId, 200) ?? '' },
  }
}

// ── Phase 1: Team Directory ───────────────────────────────────────────────────

const IDENTITY_ID_RE = /^[0-9a-f]{16}$/
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_MACHINES = 64
const MAX_BOTS = 512

function validateMachineRecord(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined
  const machineId = typeof m.machineId === 'string' && NODE_ID_RE.test(m.machineId) ? m.machineId : undefined
  if (!machineId) return undefined
  return {
    machineId,
    name: (typeof m.name === 'string' ? m.name.slice(0, 80) : machineId),
    os: ['windows', 'linux', 'darwin'].includes(m.os) ? m.os : 'unknown',
    hostname: (typeof m.hostname === 'string' ? m.hostname.slice(0, 80) : machineId),
    caps: Array.isArray(m.caps) ? m.caps.filter(c => typeof c === 'string' && c.length <= 80) : [],
    acVersion: (typeof m.acVersion === 'string' ? m.acVersion.slice(0, 20) : ''),
    online: m.online !== false,
    lastSeen: typeof m.lastSeen === 'number' ? m.lastSeen : 0,
  }
}

function validateBotDirectoryRecord(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return undefined
  if (!IDENTITY_ID_RE.test(b.identityId ?? '')) return undefined
  const home = b.home && typeof b.home === 'object' ? b.home : {}
  return {
    identityId: b.identityId,
    name: (typeof b.name === 'string' ? b.name.slice(0, 40) : ''),
    role: (typeof b.role === 'string' ? b.role.slice(0, 24) : ''),
    home: {
      machineId: (typeof home.machineId === 'string' && NODE_ID_RE.test(home.machineId) ? home.machineId : null),
      epoch: (typeof home.epoch === 'number' ? home.epoch : 1),
      leaseUntil: (typeof home.leaseUntil === 'number' ? home.leaseUntil : 0),
    },
    status: ['online', 'offline', 'away', 'moving'].includes(b.status) ? b.status : 'online',
    ...(typeof b.model === 'string' && b.model !== '' ? { model: b.model.slice(0, 200) } : {}),
  }
}

export function validateDirectorySnapshot(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'directory-snapshot-missing' }
  if (typeof d.seq !== 'number') return { ok: false, error: 'directory-snapshot-seq-missing' }
  const rawMachines = d.machines && typeof d.machines === 'object' && !Array.isArray(d.machines) ? d.machines : {}
  const rawBots = d.bots && typeof d.bots === 'object' && !Array.isArray(d.bots) ? d.bots : {}
  if (Object.keys(rawMachines).length > MAX_MACHINES) return { ok: false, error: 'directory-snapshot-too-many-machines' }
  if (Object.keys(rawBots).length > MAX_BOTS) return { ok: false, error: 'directory-snapshot-too-many-bots' }
  const machines = {}
  for (const [k, v] of Object.entries(rawMachines)) {
    const rec = validateMachineRecord(v)
    if (rec) machines[k] = rec
  }
  const bots = {}
  for (const [k, v] of Object.entries(rawBots)) {
    const rec = validateBotDirectoryRecord(v)
    if (rec && rec.identityId === k) bots[k] = rec
  }
  return { ok: true, snapshot: { seq: d.seq, machines, bots } }
}

export function validateDirectoryDelta(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'directory-delta-missing' }
  if (typeof d.seq !== 'number') return { ok: false, error: 'directory-delta-seq-missing' }
  const machines = {}
  if (d.machines && typeof d.machines === 'object' && !Array.isArray(d.machines)) {
    for (const [k, v] of Object.entries(d.machines)) {
      const rec = validateMachineRecord(v)
      if (rec) machines[k] = rec
    }
  }
  const bots = {}
  if (d.bots && typeof d.bots === 'object' && !Array.isArray(d.bots)) {
    for (const [k, v] of Object.entries(d.bots)) {
      const rec = validateBotDirectoryRecord(v)
      if (rec && rec.identityId === k) bots[k] = rec
    }
  }
  const deleted = {
    machines: Array.isArray(d.deleted?.machines) ? d.deleted.machines.filter(id => typeof id === 'string' && id !== '') : [],
    bots: Array.isArray(d.deleted?.bots) ? d.deleted.bots.filter(id => IDENTITY_ID_RE.test(id ?? '')) : [],
  }
  return { ok: true, delta: { seq: d.seq, machines, bots, deleted } }
}

/**
 * 校验 node/model-sync（hub → node 的模型同步帧）。
 * scope='default' 只带 modelRef；'bot' 带 modelRef + botId；'all' 带 modelRef。
 * effort 可选。旧节点（无此 case）按未知帧忽略，不回 result；hub 超时后标「不支持」。
 * @returns {{ok:true, sync:object} | {ok:false, error:string}}
 */
export function validateModelSync(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'model-sync-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'model-sync-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const requestId = requiredTurnId(d.requestId, 'model-sync-requestId-missing')
  if (!requestId.ok) return requestId
  const SCOPES = new Set(['default', 'bot', 'all'])
  if (typeof d.scope !== 'string' || !SCOPES.has(d.scope)) return { ok: false, error: 'model-sync-scope-invalid' }
  if (typeof d.modelRef !== 'string' || d.modelRef.trim() === '') return { ok: false, error: 'model-sync-modelRef-missing' }
  const modelRef = d.modelRef.trim().slice(0, 256)
  if (d.scope === 'bot') {
    if (typeof d.botId !== 'string' || d.botId.trim() === '') return { ok: false, error: 'model-sync-botId-missing' }
  }
  const effort = typeof d.effort === 'string' && d.effort.trim() !== '' ? d.effort.trim().slice(0, 64) : undefined
  const botId = d.scope === 'bot' ? d.botId.trim().slice(0, 256) : undefined
  return { ok: true, sync: { nodeId: nodeId.value, requestId: requestId.value, scope: d.scope, modelRef, ...(botId !== undefined ? { botId } : {}), ...(effort !== undefined ? { effort } : {}) } }
}

/**
 * 校验 node/model-sync-result（node → hub 的模型同步回执）。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateModelSyncResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'model-sync-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'model-sync-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'model-sync-result-ok-missing' }
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      nodeId: stringOrNull(d.nodeId),
      ok: d.ok,
      applied: Array.isArray(d.applied) ? d.applied.map(s => String(s).slice(0, 256)).slice(0, 64) : [],
      error: stringOrNull(d.error),
    },
  }
}

/** peer/roster 允许的联邦级别，顺序即强弱：off < roster < dispatch < groups。 */
export const PEER_LEVELS = Object.freeze(['off', 'roster', 'dispatch', 'groups'])

/** hubId 由 host 生成：短、稳定、能出现在 id 里（不用 nodeId，节点可能连多个 hub）。 */
const PEER_HUB_ID = /^[A-Za-z0-9._-]+$/

/**
 * 校验主控下发的 peer/roster（T9a）。
 *
 * 名单是**另一台机器的自述**，hub 侧只按形状收；身份归属由连接 nodeId 决定，
 * 不在这里出现。重复 botId 只留第一条（同一帧里后者视为噪声），空 bots 合法
 * （`off` 清场帧就带空的）。
 *
 * @returns {{ok:true, value:{hubId:string,level:string,hostname:string,bots:object[]}} | {ok:false,error:string}}
 */
export function validatePeerRoster(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'peer-roster-missing' }
  if (typeof d.hubId !== 'string') return { ok: false, error: 'peer-roster-hubId-missing' }
  const hubId = d.hubId.trim()
  if (hubId.length < 1 || hubId.length > 64 || !PEER_HUB_ID.test(hubId)) {
    return { ok: false, error: 'peer-roster-hubId-invalid' }
  }
  if (typeof d.level !== 'string' || !PEER_LEVELS.includes(d.level)) {
    return { ok: false, error: 'peer-roster-level-invalid' }
  }
  const hostname = typeof d.hostname === 'string' ? d.hostname.trim().slice(0, 80) : ''
  if (!Array.isArray(d.bots)) return { ok: false, error: 'peer-roster-bots-missing' }
  if (d.bots.length > 64) return { ok: false, error: 'peer-roster-bots-too-many' }

  const bots = []
  const seen = new Set()
  for (const raw of d.bots) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'peer-roster-bot-invalid' }
    if (typeof raw.id !== 'string' || raw.id.trim() === '') return { ok: false, error: 'peer-roster-bot-id-missing' }
    const id = raw.id.trim()
    if (id.length > 80) return { ok: false, error: 'peer-roster-bot-id-invalid' }
    if (seen.has(id)) continue
    seen.add(id)
    if (typeof raw.name !== 'string' || typeof raw.role !== 'string') {
      return { ok: false, error: 'peer-roster-bot-invalid' }
    }
    const bot = { id, name: raw.name.slice(0, 40), role: raw.role.slice(0, 24) }
    if (typeof raw.main === 'boolean') bot.main = raw.main
    if (typeof raw.model === 'string' && raw.model !== '') bot.model = raw.model.slice(0, 120)
    bots.push(bot)
  }
  return { ok: true, value: { hubId, level: d.level, hostname, bots } }
}

/**
 * 校验 node/config（hub → node 的并发上限下发）。
 * maxConcurrent 必须是 1–64 的整数；不合法即整帧拒绝，绝不夹到边界后假装成功。
 * @returns {{ok:true, config:object} | {ok:false, error:string}}
 */
export function validateNodeConfig(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'node-config-missing' }
  const nodeId = requiredTurnId(d.nodeId, 'node-config-nodeId-missing')
  if (!nodeId.ok) return nodeId
  const requestId = requiredTurnId(d.requestId, 'node-config-requestId-missing')
  if (!requestId.ok) return requestId
  if (!Number.isInteger(d.maxConcurrent) || d.maxConcurrent < 1 || d.maxConcurrent > 64) {
    return { ok: false, error: 'node-config-maxConcurrent-invalid' }
  }
  return { ok: true, config: { nodeId: nodeId.value, requestId: requestId.value, maxConcurrent: d.maxConcurrent } }
}

/** Strict all-or-nothing validation; only ledger display fields cross the wire. */
export function validateJobsFrame(d) {
  const invalid = { ok: false, error: 'jobs-invalid' }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Number.isFinite(d.at) || d.at < 0 || !Array.isArray(d.jobs)) return invalid
  if (d.jobs.length > 200) return { ok: false, error: 'jobs-too-many' }
  const jobs = []
  const ids = new Set()
  for (const job of d.jobs) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) return invalid
    for (const key of ['id', 'name', 'cwd']) {
      if (typeof job[key] !== 'string' || !job[key].trim() || job[key].length > (key === 'id' ? 256 : 4096)) return invalid
    }
    if (ids.has(job.id) || !Number.isSafeInteger(job.pid) || job.pid < 1 ||
        !Number.isFinite(job.startedAt) || job.startedAt < 0 || !['running', 'done', 'lost'].includes(job.status)) return invalid
    ids.add(job.id)
    const clean = { id: job.id, name: job.name, pid: job.pid, cwd: job.cwd, startedAt: job.startedAt, status: job.status }
    if (Object.hasOwn(job, 'progressLines')) {
      if (!Number.isSafeInteger(job.progressLines) || job.progressLines < 0) return invalid
      clean.progressLines = job.progressLines
    }
    if (Object.hasOwn(job, 'duplicateOf')) {
      if (typeof job.duplicateOf !== 'string' || !job.duplicateOf.trim() || job.duplicateOf.length > 256 || job.duplicateOf === job.id) return invalid
      clean.duplicateOf = job.duplicateOf
    }
    jobs.push(clean)
  }
  return { ok: true, jobs: { at: d.at, jobs } }
}

/**
 * 校验 node/config-result（node → hub 的并发上限回执）。
 * @returns {{ok:true, result:object} | {ok:false, error:string}}
 */
export function validateNodeConfigResult(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'node-config-result-missing' }
  const requestId = requiredTurnId(d.requestId, 'node-config-result-requestId-missing')
  if (!requestId.ok) return requestId
  if (typeof d.ok !== 'boolean') return { ok: false, error: 'node-config-result-ok-missing' }
  const maxConcurrent = Number.isInteger(d.maxConcurrent) && d.maxConcurrent >= 1 && d.maxConcurrent <= 64
    ? d.maxConcurrent
    : null
  return {
    ok: true,
    result: {
      requestId: requestId.value,
      nodeId: stringOrNull(d.nodeId),
      ok: d.ok,
      maxConcurrent,
      error: stringOrNull(d.error),
    },
  }
}


/* ─────────────────────────── M4：mem/* 校验器 ─────────────────────────── */

/**
 * 四个 validator 的统一契约（契约 §3.1）：任何输入都不抛；不合法返回 `null`，
 * 合法返回**清洗后的新对象**。调用方只判 `=== null`，绝不假设异常。
 *
 * 不合法包括：null / 字符串 / 数组 / 超大对象 / 缺必填字段 / 类型不对 /
 * 越界值。上限在这里按字段收（文本 8KB、query 512B、topic 64B…），单帧
 * 总上限在 transport/ingest 层用 MAX_MEMORY_FRAME_BYTES 再兜一次。
 */
const MEMORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MEMORY_SCOPES = new Set(['team', 'node', 'bot', 'own'])
const MEMORY_OPS = new Set(['add', 'replace', 'forget'])
const MEMORY_TEXT_BYTES = 8 * 1024

function memPlain(d) {
  return d && typeof d === 'object' && !Array.isArray(d) ? d : null
}

function memId(v) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return MEMORY_ID_RE.test(t) ? t : null
}

function memBounded(v, max) {
  if (typeof v !== 'string') return null
  return Buffer.byteLength(v, 'utf8') <= max ? v : null
}

function memText(v, max = MEMORY_TEXT_BYTES) {
  if (typeof v !== 'string' || v.length === 0) return null
  return Buffer.byteLength(v, 'utf8') <= max ? v : null
}

function memOptional(obj, key, read) {
  if (obj[key] === undefined) return { ok: true, absent: true }
  const value = read(obj[key])
  return value === null ? { ok: false } : { ok: true, value }
}

/**
 * mem/read：`{requestId, remoteBotId, scope, query?, topic?, limit?}`。
 * scope 只接受 team/node/bot/own；真正的权限在 hub（S3）按连接身份判。
 */
export function validateMemRead(d) {
  const o = memPlain(d)
  if (!o) return null
  const requestId = memId(o.requestId)
  if (requestId === null) return null
  const remoteBotId = memId(o.remoteBotId)
  if (remoteBotId === null) return null
  if (typeof o.scope !== 'string' || !MEMORY_SCOPES.has(o.scope)) return null
  const out = { requestId, remoteBotId, scope: o.scope }
  const query = memOptional(o, 'query', (v) => memText(v, 512))
  if (!query.ok) return null
  if (!query.absent) out.query = query.value
  const topic = memOptional(o, 'topic', (v) => memText(v, 64))
  if (!topic.ok) return null
  if (!topic.absent) out.topic = topic.value
  if (o.limit !== undefined) {
    if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 50) return null
    out.limit = o.limit
  }
  return out
}

/**
 * mem/write：`{requestId, remoteBotId, op, scope, text?, replace?, topic?, until?, pin?, always?}`。
 * team 写在这里是**语法合法**的——拒绝由 hub 的权限层给出明确 code，
 * 协议层不替业务做决定。
 */
export function validateMemWrite(d) {
  const o = memPlain(d)
  if (!o) return null
  const requestId = memId(o.requestId)
  if (requestId === null) return null
  const remoteBotId = memId(o.remoteBotId)
  if (remoteBotId === null) return null
  if (typeof o.op !== 'string' || !MEMORY_OPS.has(o.op)) return null
  if (typeof o.scope !== 'string' || !MEMORY_SCOPES.has(o.scope)) return null
  const out = { requestId, remoteBotId, op: o.op, scope: o.scope }
  if (o.text !== undefined) {
    const text = memText(o.text)
    if (text === null) return null
    out.text = text
  }
  if (o.op !== 'forget' && out.text === undefined) return null
  if (o.op === 'forget' && out.text === undefined && o.replace === undefined) return null
  if (o.replace !== undefined) {
    const replace = memText(o.replace, 512)
    if (replace === null) return null
    out.replace = replace
  }
  if (o.topic !== undefined) {
    const topic = memText(o.topic, 64)
    if (topic === null) return null
    out.topic = topic
  }
  if (o.until !== undefined) {
    const until = typeof o.until === 'string' && o.until.length <= 32 ? o.until : null
    if (until === null) return null
    out.until = until
  }
  for (const key of ['pin', 'always']) {
    if (o[key] === undefined) continue
    if (typeof o[key] !== 'boolean') return null
    out[key] = o[key]
  }
  return out
}

/**
 * mem/snapshot（hub→node）：全量渲染文本，按 bot 分段。
 * 单段 64KB 上限只是防御；真正的 32KB 预算由 hub 渲染层（S3）执行。
 */
export function validateMemSnapshot(d) {
  const o = memPlain(d)
  if (!o) return null
  if (!Number.isInteger(o.seq) || o.seq < 0) return null
  const team = memBounded(o.team ?? '', 64 * 1024)
  const node = memBounded(o.node ?? '', 64 * 1024)
  if (team === null || node === null) return null
  const botsRaw = memPlain(o.bots ?? {})
  if (botsRaw === null) return null
  const keys = Object.keys(botsRaw)
  if (keys.length > 64) return null
  const bots = {}
  for (const key of keys) {
    const id = memId(key)
    if (id === null) return null
    const raw = botsRaw[key]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const text = memBounded(raw.text ?? '', 64 * 1024)
    if (text === null) return null
    const bot = { text }
    if (raw.truncated !== undefined) {
      if (typeof raw.truncated !== 'boolean') return null
      bot.truncated = raw.truncated
    }
    bots[id] = bot
  }
  const out = { seq: o.seq, team, node, bots }
  // groups (memory-sync, AC 0.4.34+): the hub group memory of the rooms this node's Bots are in, with the
  // node-local ids of the members, so a node shows a room's memory only to that room's members.
  if (o.groups !== undefined) {
    const groupsRaw = memPlain(o.groups)
    if (groupsRaw === null) return null
    const roomIds = Object.keys(groupsRaw)
    if (roomIds.length > 32) return null
    const groups = {}
    for (const key of roomIds) {
      const roomId = memId(key)
      if (roomId === null) return null
      const raw = groupsRaw[key]
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const text = memBounded(raw.text ?? '', 64 * 1024)
      if (text === null || !Array.isArray(raw.members) || raw.members.length > 64) return null
      const members = []
      for (const member of raw.members) {
        const id = memId(member)
        if (id === null) return null
        members.push(id)
      }
      const group = { text, members }
      if (raw.truncated !== undefined) {
        if (typeof raw.truncated !== 'boolean') return null
        group.truncated = raw.truncated
      }
      groups[roomId] = group
    }
    out.groups = groups
  }
  if (o.truncated !== undefined) {
    if (typeof o.truncated !== 'boolean') return null
    out.truncated = o.truncated
  }
  if (o.truncatedAt !== undefined) {
    if (!Number.isInteger(o.truncatedAt) && typeof o.truncatedAt !== 'string') return null
    out.truncatedAt = o.truncatedAt
  }
  return out
}

/** mem/ack：`{seq}`；seq 必须是既有的非负整数，绝不接受 NaN/字符串。 */
export function validateMemAck(d) {
  const o = memPlain(d)
  if (!o) return null
  if (!Number.isInteger(o.seq) || o.seq < 0) return null
  return { seq: o.seq }
}

export function validateApprovalRequest(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'approval-request-missing' }
  for (const f of ['approvalId', 'nodeId', 'botId', 'tool', 'fingerprint']) {
    if (typeof d[f] !== 'string' || d[f].trim() === '') return { ok: false, error: `approval-request-${f}-missing` }
  }
  if (!Number.isFinite(d.at)) return { ok: false, error: 'approval-request-at-missing' }
  const detail = d.detail && typeof d.detail === 'object' && !Array.isArray(d.detail) ? d.detail : {}
  return {
    ok: true,
    req: {
      approvalId: String(d.approvalId).trim().slice(0, 128),
      nodeId: String(d.nodeId).trim().slice(0, 64),
      botId: String(d.botId).trim().slice(0, 128),
      roomId: typeof d.roomId === 'string' && d.roomId.trim() !== '' ? d.roomId.trim().slice(0, 128) : undefined,
      tool: String(d.tool).trim().slice(0, 128),
      reason: typeof d.reason === 'string' ? d.reason.slice(0, 500) : '',
      detail: {
        text: typeof detail.text === 'string' ? detail.text.slice(0, 2000) : undefined,
        code: typeof detail.code === 'string' ? detail.code.slice(0, 1000) : undefined,
      },
      at: d.at,
      fingerprint: String(d.fingerprint).slice(0, 128),
    },
  }
}

export function validateApprovalAnswer(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'approval-answer-missing' }
  for (const f of ['requestId', 'nodeId', 'approvalId']) {
    if (typeof d[f] !== 'string' || d[f].trim() === '') return { ok: false, error: `approval-answer-${f}-missing` }
  }
  const CHOICES = new Set(['allow', 'reject', 'cancel'])
  if (!CHOICES.has(d.choice)) return { ok: false, error: 'approval-answer-choice-invalid' }
  return {
    ok: true,
    answer: {
      requestId: String(d.requestId).trim().slice(0, 128),
      nodeId: String(d.nodeId).trim().slice(0, 64),
      approvalId: String(d.approvalId).trim().slice(0, 128),
      choice: d.choice,
    },
  }
}

export function validateApprovalSettled(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'approval-settled-missing' }
  for (const f of ['approvalId', 'nodeId']) {
    if (typeof d[f] !== 'string' || d[f].trim() === '') return { ok: false, error: `approval-settled-${f}-missing` }
  }
  const OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled'])
  if (!OUTCOMES.has(d.outcome)) return { ok: false, error: 'approval-settled-outcome-invalid' }
  return {
    ok: true,
    settled: {
      approvalId: String(d.approvalId).trim().slice(0, 128),
      nodeId: String(d.nodeId).trim().slice(0, 64),
      outcome: d.outcome,
    },
  }
}
