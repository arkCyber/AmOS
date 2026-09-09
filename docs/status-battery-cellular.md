# 状态栏 / 系统监控：真实电量 + 诚实蜂窝（status-battery-cellular）

设计原则与仓库一致：**读数要么来自真实来源，要么如实"unknown"——从不造假。**
本文件说明电量与蜂窝状态"从哪来、在哪显示、怎么接真源"。

## 1. 电量：分层真实来源

状态栏（及系统监控 About/SystemPanel/Monitor）显示的电池，按权威度取第一个**真有电平**的来源：

| 优先级 | 来源 | 什么时候有值 |
|---|---|---|
| 1 | daemon `system_health.battery_level_pct`（`amos-monitor`） | Android/Linux **真机**（设备电池权威） |
| 2 | Tauri `system_host_battery`（`amos-tauri/src/host_battery.rs`） | 桌面**宿主**：macOS `pmset -g batt`、Linux `/sys/class/power_supply` |
| 3 | 浏览器 `navigator.getBattery()`（`watchHostBattery`） | Chrome 系 webview/开发浏览器 |
| — | 无 → 空框 + "—" | 无电池台式机等（诚实 unknown） |

实现：纯函数 `lib/batteryStatus.ts` 的 `firstBattery([...])` 按序取第一个有限电平；
`lib/system.ts::systemStatusWithHostBattery()` 给 daemon 无电量的桌面补宿主电量。
状态栏图标 `sysIcons.batterySvg(percent, cls?, tone)`：充电绿 / ≤20 低电黄 / ≤10 临界红 / unknown 空框。

> 接入两根顶栏：`svelte/StatusBar.svelte`（生产）与 `components/StatusBar.tsx`（dev 回退）同源。

## 2. 蜂窝：诚实服务态（绝不伪造信号/运营商）

本机（尤其桌面/浏览器）**没有真实 modem**。iOS 语义：无 SIM 即不显示信号条。
因此规则是——**无真源 = 不显示 / 明确"未接入蜂窝网络"，绝不画假信号条**。

纯逻辑在 `lib/cellularService.ts`：
`no-radio`（无 SIM/modem）→ `off`（蜂窝数据关）→ `no-signal`（有源无信号）→ `connected`（有源且真有信号，需接线真机）。

### 显示位置
- Settings「蜂窝网络」页（`settings/CellularPage.svelte`）「服务状态」行
- Settings「关于本机」（`settings/AboutPage.svelte`）蜂窝行
- 控制中心（`svelte/NotificationCenter.svelte`）：**受控**——仅当真实 modem 源在场时渲染蜂窝模块

### 受控 seam（怎么接真机）
`svelte/cellularRadio.ts` 提供响应式 `RadioSignal` 存储，默认 `absent`。
未来 Android telephony 信号源接入时调用：

```ts
setCellularRadio({ present: true, signal: 3 /* 0..4 真实值 */ });
```

之后控制中心蜂窝模块会如实出现，并随蜂窝数据开关/信号如实变化；
置 `clearCellularRadio()`（或默认）即回到"无蜂窝不显示"。

> 未接入真源前，顶栏蜂窝区域保持空白是**正确行为**（与 iOS 无 SIM 一致），不是缺陷。

## 3. 验证命令

```bash
# Rust（host_battery 含 pmset/sysfs 解析单测）
cargo test -p amos-tauri --offline --lib host_battery
cargo clippy -p amos-tauri --offline -- -D warnings
# 前端
cd crates/amos-tauri/frontend-ts
bun run typecheck && bun run typecheck:svelte && bun run test
bunx vitest run --config vitest.config.ts
```
