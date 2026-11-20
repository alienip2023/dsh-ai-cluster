# AI 集群控制

[English](README.en.md)

`dsh-ai-cluster` 0.4.6 是一个 DSH 插件。主机（hub）通过「AI 集群控制」面板查看节点并分配任务，副机（worker）在自己的工作区执行任务并回传结果。协议版本仍为 **1**。

## 一、五分钟上手

在运行 DSH 的主机和副机上，用 0.4.6 的 `.tgz` 安装插件：

```sh
dsh plugin install <tgz>
```

1. 在主机启用 hub，打开面板的「副机接入」卡片，复制 `pair` 配置行。
2. 在副机启用 worker，填入配对码并配置本机允许访问的目录 `roots`。启用后回到主机的「电脑」页，确认副机在线。
3. 在「交办」页选择节点和任务类型，填写任务内容。派发 agent 任务时可指定模型（`model`）。

可使用 `bin/dsh-remote-setup.js`（命令名 `dsh-remote-setup`）生成配置，或用 `--doctor` 检查配置。Windows 可双击 `bin/setup.cmd` 打开向导。完整配置见[部署指南](profiles/README.md)。

## 二、配对与接入路径

- `dshra1://` 配对码包含连接凭证，请按口令保管。`roots` 不在配对码里，由副机配置。显式配置优先，例如 `hubUrl` 可覆盖码内地址。
- 用 DSH 原生 agent runner 的副机可声明 `inject: ['tools', 'agentLoop', 'sessions']`，使 agent 能使用 DSH 服务。缺少 `tools` 时，agent 没有对应的 DSH 工具。
- 副机校验主机身份。配对码可携带主机指纹，也可通过 `pinnedHubFingerprint` 显式指定。首次信任（TOFU）的记录保存在副机的 `hub-pin.json`。
- 直连和中继的降级链见[部署指南](profiles/README.md)。公网入口使用 `wss://` 和 TLS 反向代理，配置示例见[中继部署模板](deploy/relay-vps/)。开启 `relayE2E` 且成功协商时，中继只见密文（实现见 `lib/e2e.js`）。

## 三、面板与局域网发现

主机面板有「电脑」「交办」「机器人」「模型」「记忆」五个页面。工具栏的「设置」按钮打开配置和发现控件，可以开启或关闭局域网发现，也可以手动扫描附近节点。发现用于列出候选节点，正式接入仍需配对。建议只在可信局域网开启发现。

## 四、链路与传输

- 主机按节点累计传输字节。接收计数来自已接收的产物分块，发送计数来自成功发出的文件上传分块。
- 节点卡在直连链路有测量值时显示帧 RTT（往返时间）趋势。
- 副机会采集连通性。读到有效的 `frpc` 本地端口配置时，会对副机自己的 `127.0.0.1:<localPort>` 做 TCP 探测，检查监听是否可达。

## 五、派单与分配台账

主机可派发 `agent` 或 `exec` 任务。通过 `remote_task` 派单时，`exec` 默认等待人工批准，`agent` 默认自动派发。手动审批超时会拒绝该任务。

独立 hub 的分配台账默认保留最近 200 条任务结束记录，包含任务 ID、节点、状态和时间。配置状态目录后，台账落盘，可在重启和清理任务列表后查阅。通过 `GET /api/ai-cluster/ui/assignments` 可按节点筛选，旧前缀 `/api/remote-agent/ui/assignments` 同样可用。插件没有每日配额。

## 六、工具速查（共 26 个）

这里按主工具计数。用 `remote_nodes` 查看节点，用 `remote_task` / `remote_task_batch` 派单，用 `remote_status` 查看进度。结果摘要和产物可分别通过 `remote_handoff`、`remote_manifest` 和 `remote_pull` 读取。副机的 `roots` 和 `denyPaths` 限定文件操作范围。

## 七、一键修复

先预览，再确认写入。修复器处理能从配置判定的问题，例如角色和监听地址，并在写入前备份 DSH 配置。确认修改前，请检查预览中列出的变更。

## 八、外部工具检测

面板可以检查本机工具并提示缺项。**为什么不代下载？** 安装来源、版本和时机由操作者确认。

## 九、文件写入与进程诊断

写文件和终止进程会主动放宽边界。文件写入受 `roots` 和 `denyPaths` 限制，并要求 `confirm: "yes"`。`remote_ps` 和 `remote_port` 用于只读诊断。`remote_kill` 有三道护栏：显式确认、保护插件及其父进程、保护关键系统进程。

## 十、真实环境自检与派单前门禁

`remote_selfcheck` 检查副机工作区和运行能力。支持自检的节点在派单前可重新检查环境，阻断项会拦下任务。

## 十一、后台代理管理与会话级开关

用 `remote_agents` 查看后台代理，用 `remote_interrupt` 请求中断。启用会话门禁后，可在会话内用 `/remote-agent on` 或 `/remote-agent off` 控制远程工具入口。

## 十二、双向文件互传与桌面截图

`remote_file` 可在授权目录之间互传文件，单文件上限为 512MiB，按 256KiB 分块并做 SHA256 校验。上传需确认。副机有桌面捕获能力时，可用 `remote_screenshot` 请求截图。

进一步阅读：[部署指南](profiles/README.md)、[已知问题](KNOWN-ISSUES.md)、[安全说明](SECURITY.md)、[更新日志](CHANGELOG.md)和 [MIT 许可证](LICENSE)。
