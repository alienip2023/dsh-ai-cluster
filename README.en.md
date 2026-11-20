# AI Cluster Control

[简体中文](README.md)

`dsh-ai-cluster` 0.4.5 is a DSH plugin. The hub uses the AI Cluster Control panel to view nodes and assign tasks. Workers run tasks in their own workspaces and send back the results. The protocol version remains **1**.

## 1. Quick start

Install the plugin from the 0.4.5 `.tgz` on the hub and worker machines running DSH:

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

The hub can dispatch `agent` and `exec` tasks. With `remote_task`, `exec` waits for manual approval by default, and `agent` dispatches automatically by default. A manual approval timeout rejects the task.

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

Further reading includes the [deployment guide](profiles/README.md), [known issues](KNOWN-ISSUES.md), [security notes](SECURITY.md), [changelog](CHANGELOG.md), and [MIT license](LICENSE).
