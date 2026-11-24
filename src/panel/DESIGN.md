# 面板设计语言：Aurora Glass

给 `src/panel/*.js` 里所有样式用。基础 token 和组件在 `styles.js`，各模块只补自己的类（前缀见各模块），**不写死颜色**（设置模块的测试甚至禁止出现 `#`）。

## 一句话
深空靛蓝底上浮着半透明的毛玻璃面，边缘有极光（青 → 蓝紫 → 洋红）的光；东西是扁平的，但有真实的高光、接触阴影和分层的高度，像 visionOS / macOS 的面板。**唯一的主角是拓扑图**：一个活着的星座。其余界面安静、克制，动效只在「正在发生」和「你刚刚操作过」的地方出现。

## 配色（深 / 浅两套，都在 `.dra-root` / `.dra-root.dra-light` 里）
| 角色 | 深色 | 浅色 | token |
|---|---|---|---|
| 底 | #070816 | #eceffc | `--dra-bg` |
| 面 1/2/3 | #0f1130 / #171a3c / #202552 | #fff / #f5f6fe / #e8ebfa | `--dra-surface-1/2/3` |
| 字 / 次字 | #eef0ff / #a9afdb | #14162e / #4a5080 | `--dra-text` / `--dra-text-dim` |
| 强调（青 / 蓝） | #46e0ff | #1d57ee | `--dra-accent` |
| 极光二 / 三 | #8b7bff / #ff6bd6 | #7a4dff / #d935b4 | `--dra-accent-2` / `--dra-accent-3` |
| 状态 | ok #3df2b0 warn #ffc552 danger #ff6b88 mesh #b99cff | 对应加深 | `--dra-ok/warn/danger/mesh` |
| 链路类别 | 局域网青 / 直连蓝 / 中继紫 / 隧道洋红 | 对应加深 | `--dra-link-lan/direct/relay/tunnel` |

渐变用 `var(--dra-aurora)`（文字、细线、光点），主按钮用 `var(--dra-primary)` + `var(--dra-on-primary)`。`--dra-text-faint` **不得**承载文字。要半透明就用 `color-mix(in srgb, var(--dra-xxx) 30%, transparent)`，不要写 rgba 常量。

## 高度（立体）= 高光 + 接触阴影 + 环境阴影
- 面：`background: var(--dra-sheen), var(--dra-glass)`，加 `backdrop-filter: blur(18px) saturate(1.5)`（同时写 `-webkit-`），边 `1px solid var(--dra-border)`，`box-shadow: var(--dra-hl), var(--dra-shadow)`。
- 悬浮层（抽屉、对话框）：`--dra-glass-strong` + `--dra-elev-3`。
- 悬停：亮边 / 光晕（`--dra-glow`、`--dra-border-strong`），**不位移（不要 translateY）**，不放大到挤开布局。按下：`transform: scale(.96)`，用 `var(--dra-spring)` 回弹。
- 内凹（输入框、分段控件底槽）：`box-shadow: inset 0 1px 3px rgba(3,4,24,.4)`。
- 不要给每一层都套同一个灰阴影：外层大块用 `--dra-shadow`，被强调的才用 `--dra-elev-2`。

## 圆角（按层级，不是一刀切）
`--dra-r-xs` 6（小标签、代码块）· `--dra-r-sm` 10（按钮、输入）· `--dra-r-md` 16（统计块、内嵌面板、横幅）· `--dra-r-lg` 22（卡片、折叠块）· `--dra-r-xl` 28（抽屉、对话框）· `--dra-r-pill`（徽章、分段控件、标签条、小按钮、头像）。嵌套时内圆角 = 外圆角 − 间距。

## 字
单一字族：苹果系统字（`--dra-sans`，中文回落苹方），数字用 `font-variant-numeric: tabular-nums`，id / 地址 / 代码用 `--dra-mono`。层级靠字重和大小，不靠全大写、不靠额外的小标题。标题 15px/600/-.01em，正文 13px，辅助 12px，**不小于 10px**。

## 动效
一律 CSS（`@keyframes` / `transition` / SVG 的 `<animate*>`），**不写 JS 动画循环**。缓动：`--dra-ease`（出场）、`--dra-spring`（回弹）。
- 常驻（克制）：极光背景慢漂（已由外壳提供）、在线圆点呼吸（`.dra-dot.ok/acc`，已有）、拓扑图（见下）。
- 状态驱动：正在运行的东西用 `.dra-live`（旋转的极光描边）或 `.dra-shimmer`（扫光）；新出现的横幅 / 弹层用 `.dra-pop`（回弹进入）；折叠块箭头回弹旋转。
- 一次性：首屏统计块依次升起（已有）。**不要**给每个区块都加淡入上滑，也不要给每张卡片加悬停动画。
- **必须**尊重 `prefers-reduced-motion`：`styles.js` 里已有 `.dra-root * { animation:none!important; transition:none!important }`，模块里不要用 `!important` 去覆盖它；动画停了界面也要完整可读（SVG 里的 `<animate>` 需要你自己在 JS 里按 `matchMedia('(prefers-reduced-motion: reduce)')` 不渲染，或者只用 CSS 类驱动动画，让上面那条规则生效）。

## 无障碍底线（测试会查）
- 状态不只靠颜色：徽章 / 横幅 / 圆点带字形或文字。
- 焦点环 `2px solid var(--dra-accent)`，已在 `.dra-root :focus-visible`。
- 触屏最小 40px、强制颜色模式、减少透明度（`prefers-reduced-transparency`）在 `styles.js` 里已处理；你新增的可点击元素要用 `.dra-btn` 或自己满足这些。
- 不用视口宽度媒体查询，栅格靠 `auto-fit`；`.dra-root` / `.dra-screen` 不得有 `transform|filter|contain|container`（会让 `position:fixed` 的抽屉失效）。
- 文字对比度 ≥ 4.5:1（正文 ≥ 7:1）。

## 拓扑图（总览屏的主角，`fleet.js`）
一个活着的星座，用 SVG + CSS 动画，不用 JS 循环，数据和交互（固定 / 悬停 / 键盘 / 表格兜底）保持不变。
- **舞台**：深色下是极暗的蓝紫径向渐变 + 稀疏的静态星点（约 60 个，少数缓慢闪烁）；浅色下是通透的磨砂白 + 淡彩光斑。
- **主控**：中央的发光核心——球体质感（径向渐变 + 高光），外面三圈细轨道环（不同半径、不同方向缓慢旋转，其中一圈虚线），一圈呼吸的光晕，一束慢速旋转的雷达扫描扇面（`conic-gradient` 或渐隐楔形）。
- **节点**：玻璃球（半透明填充 + 内高光 + 细环），在线节点沿环缓慢浮动（极小幅度）并带一圈脉冲；离线灰暗、虚线环、不动；心跳超时的节点环断开并闪烁一次。状态字形（●/▲/✕）保留。名称和版本标签用玻璃胶囊。
- **链路**：从主控到节点的贝塞尔曲线（不是直线），颜色按类别（`--dra-link-*`）；在线链路上有**流动的光**（`stroke-dasharray` + `stroke-dashoffset` 动画，方向主控 → 节点）；运行中的任务在链路上有**沿路径飞行的光点**（`<animateMotion>` 或 CSS `offset-path`），排队的光点停在节点前；可靠通道积压显示为停在节点旁的琥珀色光点并带数字；中继不可达是红色断续线 + 中继盒子；离线链路是灰色静止虚线。
- **交互**：悬停 / 聚焦 / 固定的节点放大一档、亮起轨道环、其余节点和链路压暗到约 45%；固定时出现持续的瞄准环（旋转的四角括号）。
- **规模**：动画元素总数要有上限（节点多时自动降级：只对前 N 个在线节点做飞行光点），不要有性能问题；窄容器自动退回表格。
- **减少动效**：所有动画停止，画面是同一幅静态图，信息一个不少。
- 表格兜底（`fleetNodeModel`）继续保留。

## 各屏的落点
- **机器**：节点卡片是玻璃卡，顶部一条该节点链路类别颜色的细光条；资源条（CPU/内存）是圆角进度槽 + 渐变填充；SSH 部署的步骤是竖直时间线，当前步骤有扫光。
- **团队**：Bot 头像是由名称 / 身份 id 确定性生成的渐变圆（同一 Bot 永远同一个），在线的有呼吸环；聊天气泡圆角 `--dra-r-md`、回弹进入、运行中的回合有三点跳动 / 扫光；身份短码是等宽小胶囊。
- **任务**：运行中的任务行用 `.dra-live`；进度条是圆角槽 + 扫光；象限是四块大玻璃块；台账是时间线；派发按钮是主按钮。
- **设置**：向导的步骤条是胶囊进度（当前步有光）；角色选择是三块大选择卡；体检结果逐项出现、通过的打勾回弹；设置抽屉的分区像 iOS 的分组列表（圆角 `--dra-r-md` 的内嵌组，行之间细分隔线）。
