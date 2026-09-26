# AmOS 缺失功能 - 执行摘要

> ⚠️ **本文件已被取代（superseded）。** 它是一份历史快照，其数字与「缺失」结论**已与仓库现状不符**；保留它是因为它记录了当时的判断，而不是因为它现在正确。**请以代码与现行台账为准**（`TABLET_OS_COMPLETION_20260920.md`、`docs/FMEA.md`、`docs/TRACEABILITY_MATRIX.md`）。
>
> 2026-09-23 复核并确认**已交付**的条目（括号内是现行实现位置）：
>
> | 本文称「缺失」 | 现状 |
> | --- | --- |
> | Safari / 浏览器 | 已交付 —— `crates/amos-tauri/frontend-ts/src/svelte/WebManApp.svelte`（WebMan，Tauri WebView） |
> | 推送通知服务 | 已交付 —— `crates/amos-notifier/`（`dispatcher.rs` ∕ `webhook.rs` ∕ `smtp.rs` ∕ `throttle.rs`，含真实 HTTP webhook 端到端测试）＋ 设置内 `settings/PushManagementPage.svelte` ＋ `svelte/osPushWatcher.ts` |
> | 语音输入与 Siri | **部分** —— `svelte/ai/**` 的对话与 ASR 链路已存在；系统级语音助手仍未做 |
> | iCloud Drive / 云同步 | **部分** —— `amos-files` 的云快照与设置内的备份页；跨设备同步仍未做 |
> | 定位服务完善 | **部分** —— 据现行审计仍受设备侧精度限制 |
>
> 另已复核**存在**、但本文未记入 29 个应用之列的：快捷指令（`ShortcutsApp.svelte`、`lib/shortcuts.ts`、`osShortcutTriggers.ts`、`ShortcutHud.svelte`）、指南针（`CompassApp.svelte`）、隔空播放（`AirPlayPanel.svelte`）、测距仪（`MeasureApp.svelte`）、热角（`settings/HotCornersPage.svelte`）、专注模式（`settings/FocusPage.svelte`）。
>
> **内建应用数现为 36**（`crates/amos-tauri/frontend-ts/src/lib/appMeta.ts::APP_META`），不是 29。
>
> **本文仍然成立的部分**（据 `TABLET_OS_COMPLETION_20260920.md` §60.5 的现行审计，仍未交付）：外接显示器 ∕ 第二屏、系统级手写笔、触控板 ∕ 指针层、AirDrop ∕ Handoff ∕ 通用控制；以及仅苹果生态才有的 Apple Pay ∕ Health ∕ Wallet 等服务。
>
> **2026-09-25 更正**——本条此前把下面两项列为「未交付」，两项都不再成立：
>
> | 本文称「缺失」 | 现状 |
> | --- | --- |
> | Stage Manager 式自由窗口 | **已交付**。原判读取了「没有自由拖拽的多窗」，而**自由拖拽 + 缩放早已存在**（`crates/amos-tauri/src/wm.rs` 的桌面形态 `.resizable(policy.free_resize)`，`LayoutPolicy::of(Desktop).free_resize == true`；自绘标题栏逐元素 `data-tauri-drag-region`，见 `svelte/DesktopAppWindow.svelte`）。真正缺的是 Stage Manager 的**语义**——常驻窗口栏（`StageRail.svelte`）、舞台分组（`stage_park` ∕ `stage_bring`）、一键整理（`stage_arrange`）——已在 `crates/amos-wm/src/stage.rs`、`crates/amos-tauri/src/stage.rs` 交付 |
> | 系统级录屏 | **已交付（macOS 已实测；Android 设备侧未验证）**。macOS 走 `ffmpeg -f avfoundation`（`crates/amos-tauri/src/screen_record.rs`，端到端测试真录并用 `ffprobe` 读出时长），Android 走 `MediaProjection` + `MediaRecorder` glue（`android-glue/.../ScreenRecordGlue.kt`，**仅在主机上类型检查过，没有设备跑过**） |

**对比基准**: iOS 17 / macOS Sonoma  
**当前状态**（**本文写作当时**，已过时）: AmOS 已实现 **29 个核心应用**，功能完整度 **68%**

---

## ✅ 已实现 (29 个应用)

### 核心功能 100% ✅
- **通信**: 电话、短信、联系人、邮件
- **生产力**: 备忘录、提醒事项、日历、时钟、计算器
- **多媒体**: 相机、照片、音乐、播放器
- **系统**: 设置 (28 页面)、Spotlight、控制中心、通知中心
- **扩展**: Android 容器、AI 助手、终端

---

## ❌ 主要缺失功能 (按优先级)

### 🔴 P0 - 核心系统 (必须实现)

#### 1. **Safari / 浏览器** ⭐⭐⭐⭐⭐
```
影响: 无法浏览网页，严重影响用户体验
实施: 使用 Tauri WebView，7 天可完成基础版本
优先级: 最高 - 移动 OS 必备
```

#### 2. **推送通知服务** ⭐⭐⭐⭐⭐
```
影响: 应用无法后台推送消息
实施: 设计推送架构，15 天
优先级: 最高 - 应用生态基础
```

#### 3. **语音输入与 Siri** ⭐⭐⭐⭐
```
影响: 缺少语音交互能力
实施: Web Speech API + TTS，10 天
优先级: 高 - 现代 OS 标配
```

#### 4. **iCloud Drive / 云同步** ⭐⭐⭐⭐
```
影响: 无法跨设备同步文件
实施: 扩展现有备份系统，15 天
优先级: 高 - 多设备体验基础
```

#### 5. **定位服务完善** ⭐⭐⭐
```
影响: GPS 功能受限，无"查找"功能
实施: 完善 GPS 桥接，7-10 天
优先级: 中高 - 需要真实硬件
```

---

### 🟡 P1 - 重要增值 (半年内)

- ❌ Apple Pay / 支付系统 (30+ 天，需金融合规)
- ❌ 健康 (Health) (15-20 天)
- ❌ 健身 (Fitness) (10-15 天)
- ❌ 播客 (Podcasts) (5-7 天)
- ❌ 图书 (Books) (7-10 天)
- ❌ 钱包 (Wallet) (10-15 天)
- ❌ 股市 (Stocks) (3-5 天)

---

### 🟢 P2 - 增强体验 (一年内)

#### 强烈推荐: **快捷指令** ⭐⭐⭐⭐⭐
```
影响: 极大提升系统可玩性和自动化能力
实施: 工作流引擎 + 可视化编辑器，20-30 天
优先级: 中 - 但用户价值极高
```

其他 P2 功能:
- ❌ 屏幕使用时间 (7-10 天)
- ❌ 家庭共享 (15-20 天)
- ❌ AirDrop (10-15 天)
- ❌ AirPlay (10-15 天)
- ❌ 测距仪 (7-10 天，需 AR)
- ❌ 指南针 (2-3 天) ⭐ 易实现
- ❌ 热角 (2-3 天) ⭐ 易实现

---

### 🔵 P3 - 桌面增强 (逐步完善)

#### Finder 高级功能 ⚠️ 部分实现
```
已有: 基础文件浏览
缺失: 多视图、快速查看、标签、智能文件夹
实施: 15-20 天
```

#### Dock 高级功能 ⚠️ 部分实现
```
已有: 应用固定、运行指示器
缺失: 文件堆栈、最小化到 Dock
实施: 5-7 天
```

#### 应用菜单栏 ❌
```
缺失: File/Edit/View 等应用菜单
实施: 10-15 天
```

---

## 🎯 推荐实施路线图

### Q1 (3 个月) - 核心补全
```
Week 1-2:   浏览器 (7 天) ⭐⭐⭐⭐⭐
Week 3-4:   语音输入 (10 天) ⭐⭐⭐⭐
Week 5-8:   推送服务 (15 天) ⭐⭐⭐⭐⭐
Week 9-12:  云同步 (15 天) ⭐⭐⭐⭐

总计: 47 天工作量
交付: 4 个核心功能
完成度: 68% → 78%
```

### Q2 (3 个月) - 增值功能
```
Week 1-4:   快捷指令 (20 天) ⭐⭐⭐⭐⭐
Week 5-7:   Finder 增强 (15 天)
Week 8-12:  健康 + 健身 (20 天)

总计: 55 天工作量
交付: 3 个重要功能
完成度: 78% → 85%
```

### Q3-Q4 (6 个月) - 生态完善
```
- 播客、图书、股市
- AirDrop、AirPlay
- 屏幕使用时间
- 更多桌面增强

完成度: 85% → 90%+
```

---

## 💡 快速提升建议 (短期可实现)

### 1 周内可完成:
1. **指南针** (2-3 天) - DeviceOrientation API
2. **热角** (2-3 天) - 鼠标事件监听

### 2 周内可完成:
3. **浏览器基础版** (7 天) - Tauri WebView 封装
4. **股市** (3-5 天) - API 调用 + 图表

### 1 个月内可完成:
5. **语音输入** (10 天) - Web Speech API
6. **Dock 堆栈** (5-7 天)
7. **播客** (5-7 天) - RSS 订阅

---

## 📊 功能完整度

### 当前: **68%**
```
✅ 通信类:     100%
✅ 生产力:     100%
✅ 多媒体:     100%
⚠️ 系统工具:   85%
❌ 网络服务:   20%
❌ 语音交互:   30%
❌ 健康健身:   0%
❌ 内容消费:   30%
❌ 自动化:     0%
⚠️ 桌面增强:   60%
```

### 目标 (一年后): **90%+**

---

## 🎯 核心建议

### 立即实施 (最重要)
1. ⭐⭐⭐⭐⭐ **浏览器** - 移动 OS 必备，使用频率极高
2. ⭐⭐⭐⭐⭐ **推送服务** - 应用生态基础设施
3. ⭐⭐⭐⭐ **语音输入** - 现代交互标配
4. ⭐⭐⭐⭐ **云同步** - 多设备无缝体验

### 中期目标
5. ⭐⭐⭐⭐⭐ **快捷指令** - 极大提升系统可玩性
6. ⭐⭐⭐⭐ **Finder 增强** - 桌面端核心体验
7. ⭐⭐⭐ **健康功能** - 用户价值明确

### 暂缓实施
- Apple Pay (需金融合规)
- Apple Watch 配套 (无硬件生态)
- Face ID (需专用硬件)

---

## 🚀 结论

**AmOS 已建立坚实的基础** (29 个核心应用，功能完整度 68%)

**主要短板**: 
- 网络服务层 (浏览器/推送/云同步)
- 高级交互 (语音/快捷指令)
- 桌面端增强 (Finder/菜单栏)

**建议**: 
- Q1 优先补全 4 个 P0 功能 (浏览器/推送/语音/云同步)
- Q2 实施 3 个高价值功能 (快捷指令/Finder/健康)
- 一年内达到 90% 功能完整度

**预估工作量**: 
- Q1: 47 天
- Q2: 55 天
- 总计: 约 4-5 个月全职开发

---

**对比日期**: 2026年9月17日  
**对比对象**: iOS 17 / macOS Sonoma  
**分析人**: Claude (Cursor Agent)
