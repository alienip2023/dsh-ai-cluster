# 安装窗口的同名回退包

## 这是什么

`dsh-remote-agent-0.10.1-fork.98.tgz` 是本仓库当前代码的本地回退包。
`.96` 早于 0.2.x headless 参数和 `--json` 事件解析修复，已由包含这两项修复的 `.98` 取代。
它沿用旧包名 `dsh-remote-agent`，供桌面已有的依赖键继续使用。
运行代码仍来自当前 `lib/`，没有另建旧版分支，也没有恢复历史实现。
暂存 manifest 只改 `name` 和 `version`，其他字段保持不变。
其中 `dsh.bundle.patch`、`main`、`exports` 和 `files` 都保持原值。

暂存时还会改写 `dsh.bundle.patch` 指向的文件：`insert:` 中插件入口的
`name` 必须等于回退包名 `dsh-remote-agent`，因为 loader 将它作为模块说明符
（module specifier）解析并导入；回退安装中没有 `dsh-ai-cluster` 包，保留该名称会加载失败。
入口的 `id` 仍为 `remote-agent`，因为 profile 的用户层按 id 覆盖配置。
注释、`role: auto`、`inject:` 和其余字节保持不变，仓库原始 patch 不改。
`0.10.1-fork.95` 的 tarball 存在此入口名错误，已被取代，禁止使用。

这不是正式 release，也不代表旧包恢复发布。
真实包仍是 `dsh-ai-cluster@0.2.0`。
禁止将此回退包发布到任何 registry，禁止为它打 tag。

## 什么时候使用

首次安装新包时，profile 会新增 `dsh-ai-cluster` 依赖键。
只有在新增该键后出现以下情况，才进入这个回退流程：

- 桌面拒绝启动；
- 或日志显示安装失败、registry 解析失败。

此时利用 profile 已有的 `dsh-remote-agent` 键加载同一份代码。
正常启动时继续使用真实包，无须切换到回退包。

## 安装窗口的三行操作

1. 将 `dsh-remote-agent-0.10.1-fork.98.tgz` 放到桌面可读取的固定位置。
2. 将 profile 的 `dsh-remote-agent` dependency 和对应 override 都指向该 tgz 的同一绝对路径。
3. 保存 profile 后重启桌面，确认启动日志不再出现该依赖的安装或 registry 错误。

dependency 与 override 使用现有 profile 支持的本地 tarball 写法。
两处必须指向同一个文件，避免 override 又将解析导回 registry。
回退时撤回本次新增的 `dsh-ai-cluster` 依赖键，避免继续触发失败的解析。
这是安装窗口中的人工操作；打包脚本不会修改任何运行中的 profile。
安装窗口只需取用预先生成的 tgz，无须运行 CLI。

## 维护者重建

先确认 `lib/index.js` 和 `lib/plugin/index.js` 已经生成。
若缺失，维护者须先运行 `node scripts/build-plugin-entry.mjs`。
回退脚本不会自行构建，也不会修改仓库的 manifest 或 `lib/`。

```sh
node scripts/pack-fallback.mjs /absolute/path/to/existing-output-directory
```

输出目录必须事先存在；脚本在系统临时目录暂存，退出时清理。
产物固定为该目录中的 `dsh-remote-agent-0.10.1-fork.98.tgz`。
脚本检查归档内的名称、版本、patch 入口名、两个入口及其语法，并拒绝 `src/`、`test/`。
最后输出产物绝对路径、字节数和 SHA-256，供交接时核对。

真实包仍由 `node scripts/check-packaging.mjs`（`check:packaging`）约束。
回退包验证通过不能替代真实包检查，也不改变正式发布流程。
