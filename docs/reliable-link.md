# 可靠通道（reliable link，W0）

主控 ↔ 节点之间「恰好处理一次」的消息通道。给宿主（ds-bot）的协作工作帧用（W3 起 `work/*`、`team/*`），
取代「`send()` 返回 true 就当送到」的做法——那只代表写进了 socket，断线即丢。

代码：`lib/reliable-link.js`（纯逻辑）、`lib/reliable-wire.js`（接到主控 registry 与节点 transport 上）。
测试：`test/reliable-link.test.js`（REL-1..8）、`test/reliable-integration.test.js`（REL-INT-1..4，真实主控 ingest + 真实节点分发）。

## 帧

| 帧 | 方向 | 载荷 |
|---|---|---|
| `rel/frame` | 双向 | `{ rid, type, data, to?, from? }`：`type`/`data` 是内层消息 |
| `rel/ack` | 双向 | `{ rid }` |

两种帧都在三份 E2E 必加密清单里（`lib/node/transport.js`、`src/link/transport.js`、`src/wire/session-framing.js`），
校验函数 `validateRelFrame` / `validateRelAck` 在 `lib/protocol.js` 与 `src/wire/validate.js` 中逐字相同（DRIFT-3）。
`data` 上限 256 KiB。

## 规则

- **一跳一条链路**：主控 ↔ 每个节点。`rid` 是 UUID。
- **先落盘再发**：未确认的消息与已处理过的 `rid` 存在 `<stateDir>/reliable-hub.json`（主控）或
  `<stateDir>/reliable-node.json`（节点），原子写（临时文件 + rename），0600。进程重启不丢。
- **收到 ack 才删**。
- **接收方去重**：见过的 `rid` 只回 ack，不再处理。`seen` 保留 7 天、上限 20 000 条。
- **处理失败不 ack**：内层处理函数抛错或尚无处理函数（AC 先于 ds-bot 加载）→ 不 ack，发送方之后重发。
- **何时重发**：对端就绪时立刻全部重发——主控侧是 `e2eEstablished` 事件，节点侧是 transport 的 `online` 与 `e2e:'ok'`；
  另每 5 s 扫一次，未确认且到了退避时间的重发（10 s 起 ×2，封顶 2 min）。**对端不就绪时不发、不计次、不计时**。
- **内层类型白名单**：`work/`、`team/`、`test/` 前缀。不在白名单的：ack 并丢弃（不会被无限重发）。
- **发送方身份取链路事实**：主控收到的消息，`from` 就是来的那个节点；帧里自称的 `from` 只在主控转发给节点时由主控填写。

## 节点 → 节点（主控存转）

节点 `post(type, data, { to: 'node010' })` → 主控收下后把它记成自己发往 node010 的未确认消息（沿用同一 `rid`）→ 回 ack 给来源节点
→ node010 就绪时送达。目标离线多久都留在主控，没有超时、没有 bounce。

## 宿主接口（bot-network 服务上）

主控：`post(nodeId, type, data)`、`onReliable(type, handler)`、`reliablePending(peer?)`。
节点：`post(type, data, { to? })`、`onReliable(type, handler)`、`reliablePending()`。
`handler({ type, data, from, rid })` 可返回 Promise；reject 即视为处理失败。

## 一起修的主控丢帧（W0-1..5，`test/w0-fixes.test.js`）

- 节点**确定重连过**（节点自己发了 hello，或中继通知节点重新上线）后，新 E2E 会话建好之前，需加密的帧不再用旧会话密钥发出，
  `sendViaHub` 返回 false；`send()` 对 `bot/turn`、`bot/attach` 用同一判断（`e2eReady`）。
  主控自己与中继重连后的**目录回放**不算节点重连（节点很可能还持有会话），照常加密发送；节点若确实丢了会话会回 `e2e-not-ready`，随后重新协商，可靠通道在 `e2eEstablished` 后补发。
- 节点丢弃加密的 `bot/turn` 时，bridge-down 结果按信封 id 找回真正的 exchangeId（LRU 512）。
- `bot/assign` 转发失败退回发送方（`reason: 'send-failed'`），W3 删除 `bot/assign` 前的止血。
