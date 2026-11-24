# AI Cluster Control

[简体中文](README.md)

`dsh-ai-cluster` 0.4.33 is a DSH plugin. The hub uses the AI Cluster Control panel to view nodes and assign tasks. Workers run tasks in their own workspaces and send back the results. The protocol version remains **1**.

## 1. Quick start

Install the plugin from the 0.4.30 `.tgz` on the hub and worker machines running DSH:

```sh
dsh plugin install <tgz>
```

1. Enable the hub. In its panel, open the worker onboarding card and copy the `pair` configuration line.
2. Enable the worker, enter the pairing code, and set `roots` to the local directories it can access. Check that the worker appears online in the hub’s Computers tab.
3. In the Assignments tab, choose a node and task type, then enter the task. For agent tasks, you can specify a model with `model`.

Use `bin/dsh-remote-setup.js` (command name `dsh-remote-setup`) to generate configuration, or run it with `--doctor` to check your configuration. On Windows, double-click `bin/setup.cmd` to open the wizard. See the [deployment guide](profiles/README.md) for full configuration instructions.

## 2. Pairing and connection paths

- A `dshra1://` pairing code contains connection credentials. Treat it like a password. Set `roots` on the worker itself. Explicit configuration takes precedence, so `hubUrl`, for example, can override the address in the code.
- Workers using DSH’s native agent runner can declare `inject: ['tools', 'agentLoop', 'sessions']` to give the agent access to DSH services. The `tools` service provides access to the corresponding DSH tools.
- The worker verifies the hub’s identity. The pairing code can carry the hub fingerprint, or you can specify it with `pinnedHubFingerprint`. The worker stores its trust-on-first-use (TOFU) record in `hub-pin.json`.
- See the [deployment guide](profiles/README.md) for fallback paths between direct and relay connections. Use `wss://` with a TLS reverse proxy for public endpoints. See the [relay templates](deploy/relay-vps/). When `relayE2E` is enabled and negotiation succeeds, the relay sees only ciphertext. The implementation is in `lib/e2e.js`.

## 3. Panel and LAN discovery

The hub panel has five tabs for computers, assignments, bots, models, and memory. The Settings button in the toolbar opens configuration and discovery controls. You can turn LAN discovery on or off and manually scan for nearby nodes. Discovery lists candidates, and workers still need to pair to join. Enable discovery only on trusted LANs.

## 4. Connections and transfers

- The hub counts transferred bytes per node. Incoming bytes count accepted artifact chunks, and outgoing bytes count file upload chunks that were sent successfully.
- Node cards show a frame RTT (round-trip time) trend for direct links with samples.
- The worker collects connectivity information. When it reads a valid `frpc` local port, it runs a TCP probe against its own `127.0.0.1:<localPort>` to check whether the listener is reachable.

## 5. Dispatch and assignment ledger

The hub can dispatch `agent` and `exec` tasks. Both `exec` and `agent` dispatch automatically by default (`approval:"auto"`, since 0.4.19). Pass `approval:"manual"` to hold a task for approval in the panel; a manual approval that times out rejects the task.

The standalone hub’s assignment ledger keeps the 200 most recent task-end records by default, including task ID, node, status, and timestamps. With a state directory configured, the ledger persists across restarts and task-list pruning. Use `GET /api/ai-cluster/ui/assignments` to filter by node. The legacy prefix `/api/remote-agent/ui/assignments` also works. The plugin has no daily quota.

## 6. Tool reference (26 tools)

This count covers the primary tools. Use `remote_nodes` to list nodes, `remote_task` or `remote_task_batch` to dispatch work, and `remote_status` to track it. Use `remote_handoff`, `remote_manifest`, and `remote_pull` for result summaries and artifacts. The worker’s `roots` and `denyPaths` constrain file operations.

## 7. Configuration repair

Preview the repair before confirming the write. The repair tool handles issues it can determine from configuration, such as roles and listen addresses, and backs up the DSH configuration before writing. Review the proposed changes before confirming.

## 8. External tool checks

The panel checks for local tools and identifies missing ones. You choose what to install, where to get it, and when to install it.

## 9. File writes and process diagnostics

File writes and process termination can change the worker’s state. File writes are constrained by `roots` and `denyPaths` and require `confirm: "yes"`. Use `remote_ps` and `remote_port` for read-only diagnostics. `remote_kill` requires explicit confirmation and protects the plugin process, its parent, and critical system processes.

## 10. Environment self-checks before dispatch

`remote_selfcheck` checks the worker’s workspace and runtime capabilities. Workers that support self-checks can be checked again before dispatch. Blocking failures prevent the task from being dispatched.

## 11. Background agents and session controls

Use `remote_agents` to view background agents and `remote_interrupt` to request an interruption. When the session gate is enabled, `/remote-agent on` and `/remote-agent off` control access to remote tools in the session.

## 12. Two-way file transfer and screenshots

`remote_file` transfers files between authorized directories. The limit is 512 MiB per file, with 256 KiB chunks and SHA256 verification. Uploads require confirmation. If the worker supports desktop capture, you can request a screenshot with `remote_screenshot`.

## 13. Wire frames and capabilities (pairing with ds-bot)

The protocol version remains **1**. These are the frames ds-bot and AC use together; `lib/protocol.js` (live) and `src/wire/*` (source copy, kept identical by a drift test) are the reference for fields.

- **`bot/turn`** (hub to node): puts one message into an existing Bot session on the node. It may carry `mode`: `steer` (join the running turn) or `queue` (wait for the next turn). This needs the node capability `bot-turn-mode/1`; an older node ignores `mode`. It may also carry an `attachments` manifest (at most 8 entries, each `{ index, name, kind: 'image'|'file', mediaType?, bytes, sha256, chunks }`) naming the `bot/attach` chunks that arrived just before it for the same `exchangeId`; one bad entry rejects the whole turn (`bot-turn-attachments-invalid`), an attachment is never silently dropped.
- **`bot/attach`** (hub to node, capability `bot-attach/1`): puts the images and files of a message to a node Bot on the link in chunks. Payload `{ nodeId, remoteBotId, exchangeId, index, chunk, chunks, data }` (`index` 0..7 is which attachment of the turn, `chunk` counts from 0 and `chunks` is at most 40, `data` is base64 with at most 1,100,000 characters per chunk; one attachment is at most 20 MiB). There is no result frame. The hub sends every chunk, then the `bot/turn` that names them on the **same link**; the node hands each chunk to the receiver `remote-agent:bot-attach` synchronously in the same tick as the frame, so the chunks are registered before the turn is dispatched. A `bot/turn` that carries attachments takes the hub link (not the peer-direct one) so it travels behind its chunks on one connection. The frame is encrypted and a plaintext copy is refused by the node. A frame that fails validation answers an `error` frame (`bot-attach-*`).
- **`bot/turn-result`** (node to hub): the answer of a turn. If the link drops, the node retries with backoff for about 30 minutes; on the hub the turn stays `running` with a `linkLost` flag (visible to panel polling), a late result still settles it, and only after 2 hours without a result is it failed and audited. A result that fails validation is never silent: the hub audits it and, when it can tell which turn it was, answers with an explicit failure result.
- **`bot/action`** (hub to node) and **`bot/action-result`**: act on a node Bot's UI state for the user. `action` is `card-answer`, `task-stop`, `task-send` or `task-start`. Needs capability `bot-action/1`; encrypted; a receipt that fails validation settles the requester at once as a failure.
- **`bot/trace`** (node to hub, capability `bot-trace/1`): the thinking and tool steps of a node Bot's turn, so the hub's page shows them like a local Bot's page. Payload `{ nodeId, remoteBotId, exchangeId, seq, final?, items, omitted? }`: `items` is an append-only log (`{ i, t:'a', think?, calls?, end? }` one model step, `{ i, t:'r', id, ok, out? }` one tool result); the hub dedupes and orders by the step index `i`. Steps go out in throttled batches while the turn runs, and once more as a `final:true` frame, before `bot/turn-result`, carrying every step, which repairs a lost batch. Text fields have caps (an overlong one ends with `…[已截断 N 字]`); steps dropped for the count or byte cap are counted in `omitted` / `clipped`, never silently; the frame is encrypted. A node sends it only once the hub's welcome carries `bot-trace/1`, so an older hub never receives it.
- **`roster/report`** (node to hub): the node's Bot roster, with each Bot's running-task summary and the **cards** it waits on someone to answer (`cards`, capability `roster-cards/1`; at most 8 per Bot, 2000 characters per body). The whole frame stays within 512 KiB: when over, it trims card bodies, then skill content, then the oldest tasks, then cards, never a Bot, and lists what it trimmed in `trimmed`. An unchanged roster is not resent within 30 seconds.
- **Capabilities** (`caps` in the node hello): `bot-turn-mode/1`, `bot-action/1`, `roster-cards/1`, `bot-trace/1`, `bot-attach/1` (reported by the node only; the hub's welcome does not carry it); the hub's welcome `caps` carry `memory-sync/1` and `bot-trace/1`. ds-bot reads these capabilities from the node hello before using a feature: a node without one falls back to what it can do and the panel says which node needs AC 0.4.21; unknown capabilities (node not connected, or an older AC that does not report them) count as able, and the node's own refusal is shown as is.
- **Encryption**: once an E2E session exists, a node's uplink conversation and control frames must be encrypted; the hub drops plaintext ones, audits them and answers `e2e-required` (except `hello`, `ping`, `pong`, `error`, the handshake frames and telemetry).

### Matching ds-bot and AC versions

The hub and every node need the matching pair. ds-bot reads the capabilities and `acVersion` in the node hello; a node whose AC is too old is marked "needs an update" in the Bot list, with what it lacks.

| ds-bot | AC needed (hub and nodes) | What this release depends on |
| --- | --- | --- |
| 0.3.10-fork.99–100 | 0.4.19 | the frames that make a node Bot the same as a hub Bot (`bot/action`, `bot/turn` `mode`, roster cards) |
| 0.3.10-fork.101–102 | 0.4.21 | `bot/trace` (thinking and tool steps) |
| 0.3.10-fork.103–106 | 0.4.26 | `bot/attach` (images and files); from 0.4.26 attachments are never sent unencrypted, never overtaken by a later turn, and never silently dropped by an old ds-bot |
| 0.3.10-fork.107 | 0.4.27 | a node writes a model's capabilities (a node model can read images); nodes have no Main Bot |
| 0.3.10-fork.108 | 0.4.30 | the node reports `acVersion` and `config-models/1`, so the hub can tell exactly which node's AC is behind |

Further reading includes the [deployment guide](profiles/README.md), [known issues](KNOWN-ISSUES.md), [security notes](SECURITY.md), [changelog](CHANGELOG.md), and [MIT license](LICENSE).
