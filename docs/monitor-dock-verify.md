# dock「系统监控」真机验收对照表

> 系统 UI 内置 dock App「系统监控」(id `monitor`) 的真机验收清单。覆盖：入口可达性、
> 实时读数、空态与自动恢复、明细/电源调控档、可访问性、返回/主屏手势。
> 前端实现与设计见 [`docs/system-monitor.md`](./system-monitor.md) 与 CHANGELOG
> （2026-09-07 dock「系统监控」App）。

## 前置

- 已跑通 `amos-ai` daemon 且能采样（CPU/内存来自真机 `/proc`；电量/功耗镜像 energy 块）。
- System UI 为含本屏的构建（`cargo tauri android dev --features android --target aarch64`
  或已装入的 arm64 debug 包）。真机构建/安装细节见仓库 bring-up 文档。
- 想要「**默认上 dock**」：仅对无持久化主屏布局的首启成立。已持久化过布局的设备，
  新 App 由 `getLayout` 合到主页**末页**；如要放 dock，在「编辑主屏」里从网格拖入 dock
  （或清除 `amos.home.layout` 走默认布局）。这是诚实边界，非缺陷。

## 走查表

| # | 操作 | 预期结果 |
|---|---|---|
| A1 | 主屏（新装机/重置后）查看底部 dock | dock 出现「系统监控 📈」图标 |
| A2 | 点击「系统监控」图标 | 打开**独立 app 屏**：顶部 ‹ 返回 + 标题「系统监控」+ ⌂ 主屏键；启动器退到后台 |
| A3 | daemon 在线、宿主可采样 | 顶部总览条出现三块读数：**CPU %**、**内存 % · 已用/总量**、**电量 %**（+ 充电中/实时功耗 mW）；三者下方有进度条 |
| A4 | 点总览右上角「刷新」 | 读数刷新（daemon 当前值） |
| A5 | daemon 停（kill amos-ai） | 屏不白屏：显示 🔌「未连接系统服务」+ 提示 + 「重试」 |
| A6 | daemon 恢复在线 | **≤5s 内自动恢复**为总览（无需手点）；或点「重试」立即恢复 |
| A7 | 有管控进程时看下方明细 | SystemPanel（进程档 / 电源调控 DVFS…）与 TaskManager（应用生命周期 action / 计划任务）各卡片出现，可操作 freeze/stop/kill/cancel |
| A8 | 无障碍（TalkBack 读屏） | 三条进度条以 `progressbar` 读出，`aria-valuenow` 为当前 0–100（CPU/内存/电量 label 本地化） |
| A9 | app 屏点 ⌂ 或上推 | 回主屏 dock；再点开可重进并重新取数 |
| A10 | 切深色 / 不同语言 | 观感与「设置」同款卡片一致；标题与 label 随 en/zh 切换 |

## 判据

- A1–A9 全部通过视为本屏验收通过；A8 视无障碍复核环境可选（有 TalkBack 才做）。
- macOS dev（无 `/proc`）如实 unknown → A3 显示「暂无系统数据」空态而非假数据——属
  预期（诚实边界），**不**作为失败；请在真机/可采样 Linux 上判 A3。
