# G-β-1 · Control Center 屏幕亮度滑杆（仅桌面 WebView 内容）

> 接 [G-α · macOS Overlay Title Bar](./DESKTOP_TITLEBAR_G_ALPHA.md)、
> [G-γ · 桌面通知 Banner](./DESKTOP_NOTIFICATION_BANNER_G_GAMMA.md)、
> [G-DesktopShell · 桌面背景 fallback](./DESKTOP_SHELL_BACKGROUND.md)
> 之后：补 Control Center 的「屏幕亮度」滑杆 —— **但** WebView 没有控制系统亮度的 API，
> 所以这是一个**显示降亮（display dimming）** 滑杆，不是真 macOS 系统亮度。

---

## 1. 现状（Why）

### 1.1 macOS 真机行为

- 控制中心第一行是「显示器」面板：亮度滑杆 + True Tone 开关
- 调整是**系统级**，影响所有屏幕内容（WebView、原生 chrome、外部显示器）
- 持久化在 macOS 自己的 `com.apple.preferences` 数据库里

### 1.2 仓内现状

`ControlCenter.svelte` line 13-15 自己写的 disclaimer：

> What it deliberately does NOT have: display-brightness and sound-level sliders.
> macOS puts them here, but **this shell has no brightness backend** and no system
> volume the policy reaches, and **a slider that moves a number nothing else reads is
> exactly the decorative control this repo keeps removing**.

**当前状态**：G6 「控制中心没有屏幕亮度与音量滑杆……不摆装饰性滑杆」。

### 1.3 缺口（What）

仓内 WebView **没有任何**屏幕亮度 / 降亮机制。

- macOS 真机的系统亮度在 web app 内**不可控**（没有 Web API 也没有 Tauri 2 API）
- macOS 上的 `WebviewWindow` 不暴露 `screen.brightness` / `NSScreen.brightness`
- **用户可以感知**：晚上用 AmOS 想降亮 —— 没有入口

### 1.4 G-β-1 的实质

**做一个**有**真实效果**的「显示降亮」滑杆 —— **但**必须诚实标注**它是什么**：

- **不是什么**：macOS 系统亮度（控制不了原生 chrome / 外部显示器）
- **是什么**：WebView 内容之上的黑色透明遮罩层（CSS `background: rgba(0,0,0,X)`）
- **效果范围**：仅本桌面 WebView 内的内容（不覆盖原生 chrome、不影响应用窗口外的桌面）
- **持久化**：写到 `amos.brightness` store，重启后保留

---

## 2. 目标（Goals）

### 2.1 必须

1. **Control Center 加一个滑杆** —— 与现有 dark / dnd 同一布局族
2. **诚实 UI 标注**：slider 上方或下方一行小字「仅桌面内容」 / "Desktop content only"
3. **持久化**到 `amos.brightness` store（百分比）
4. **生效范围**：覆盖整个 WebView 内容（root 容器 + 子内容）
5. **不动**：
   - 原生 chrome（顶栏、Tauri Title Bar）
   - 应用窗口（独立 WebviewWindow 不受 WebView 容器 overlay 影响）
6. **不抢事件**：`pointer-events: none` —— 用户仍能正常点击下面的内容

### 2.2 不做（Explicit Non-Goals）

- **不做**「真系统亮度」—— WebView 内做不到；任何尝试都退化为 F-SH-001 装饰控件
- **不做** True Tone / Night Shift / 暖色温 —— 这些需要 `CGDisplayIOService` / `ColorSync` API
- **不做**键盘快捷键（macOS 键盘上的 `Brightness Up/Down` 键）—— 它们走的是 OS 自己的快捷键
- **不做**外部显示器单独调节 —— `NSScreen.brightness` 在 web app 内不可达
- **不做**键盘可达性之外的任何 a11y —— slider 本身就是 a11y 友好的（HTML `<input type="range">`）

### 2.3 收益面

- 用户撞到频率：低 —— 但一旦撞到「晚上屏幕太亮」是 100% 撞到的（OLED 用户尤其敏感）
- 修复成本：1 个新 store key + 1 个新组件 + 1 个新 helper 函数 + i18n，2 天可落

---

## 3. 设计（Design）

### 3.1 数据模型

新 store key `BRIGHTNESS_KEY = "amos.brightness"`，存 `BrightnessSettings`：

```typescript
/** 0..100，0 = 完全黑遮罩、100 = 不降亮。默认 100（不降亮）。 */
export interface BrightnessSettings {
  pct: number;
}
```

新增 `lib/brightness.ts`（与 `lib/magnifier.ts` 同形）：

```typescript
export const BRIGHTNESS_KEY = "amos.brightness";
export const MIN_BRIGHTNESS_PCT = 0;
export const MAX_BRIGHTNESS_PCT = 100;
export const DEFAULT_BRIGHTNESS_PCT = 100;
/** 把任意 unknown 规范成合法 BrightnessSettings（absent/corrupt → 默认） */
export function normalizeBrightness(raw: unknown): BrightnessSettings;
/** 把 pct 转成 CSS alpha：100 → 0（透明）、0 → 1（完全黑） */
export function brightnessToAlpha(pct: number): number;
```

### 3.2 组件契约

**ControlCenter.svelte** 加一个 slider（与 dark / dnd 同一区，**但** slider 是范围控件不是 toggle）：

```svelte
<div class="mt-2 space-y-1">
  <div class="flex items-center justify-between px-1">
    <span class="flex items-center gap-2 text-[12px] font-medium text-white/80">
      <span data-icon="brightness" class="grid h-5 w-5 place-items-center">
        {@html iconSvg(quickIcon("brightness"), "h-5 w-5")}
      </span>
      {t("cc.brightness")}
    </span>
    <span class="text-[10px] tabular-nums text-white/50">
      {brightnessPct}%  ·  {t("cc.brightnessScope")}
    </span>
  </div>
  <input
    type="range"
    min={0}
    max={100}
    step={1}
    value={brightnessPct}
    oninput={(e) => setBrightnessPct(Number((e.target as HTMLInputElement).value))}
    aria-label={t("cc.brightness")}
    data-testid="cc-brightness"
    class="h-1 w-full appearance-none rounded-full bg-white/30 accent-white"
  />
  <!-- 诚实标注：仅桌面内容（不控制系统亮度） -->
  <p class="px-1 text-[10px] leading-tight text-white/40">
    {t("cc.brightnessHint")}
  </p>
</div>
```

**DesktopShell.svelte** 加一个 `<div class="brightness-overlay">`：

```svelte
<!-- G-β-1 · 屏幕降亮遮罩（仅 WebView 内容；不控制系统亮度） -->
{#if brightnessAlpha > 0}
  <div
    class="pointer-events-none fixed inset-0 z-[80] bg-black"
    style="opacity: {brightnessAlpha}"
    data-testid="brightness-overlay"
    aria-hidden="true"
  ></div>
{/if}
```

z=80 序关系：
- stage / topbar / dock ≤ 30
- 通知 banner = 90
- 浮层 = 100+
- **brightness overlay = 80**（在 banner 之下、浮层之下 —— 用户开 Mission Control 时不被暗化）

### 3.3 i18n

新键 zh + en 各 3 条：
- `cc.brightness` = "屏幕亮度" / "Display"
- `cc.brightnessScope` = "仅桌面" / "Desktop only"
- `cc.brightnessHint` = "WebView 内降亮，不控制系统亮度" / "Dims WebView content only; does not control system brightness"

### 3.4 图标

`lib/sysIcons.ts` 加 `brightness` id（取自 `lucide` 的 `sun` 或 `brightness` 图标），与既有 `quickIcon` 接入。

### 3.5 负面控制（Negative Controls）

| 负控 | 移除/篡改 | 期望 FAILED 的测试 |
|---|---|---|
| 把 slider 删掉 | 删除 `<input type="range">` | `slider_is_present_when_controlCenter_opens` |
| 把 overlay z-index 改到 100 | z=100 | `overlay_sits_below_floating_overlays_but_above_stage` |
| 把 `pointer-events: none` 去掉 | 删除 class | `overlay_does_not_steal_pointer_events` |
| 把 store key 改回内联常量 | 替换 `BRIGHTNESS_KEY` 为字面 | `BRIGHTNESS_KEY_is_the_single_source_of_truth` |
| 把 alpha 计算改回内联 `1 - pct / 100` | 改用 `opacity: {1 - pct/100}` | `brightnessToAlpha_is_pure_and_called_from_DOM` |
| 把「仅桌面」标签删了 | 删除 `cc.brightnessScope` i18n 键 | `slider_says_desktop_only_honest_about_scope` |

---

## 4. 测试矩阵（先于实现）

新文件 `src/lib/__tests__/brightness.test.ts`（纯函数）+ 扩展 `svelte-tests/desktop-shell.svelte.test.ts`（DOM）+ `svelte-tests/control-center.svelte.test.ts`（如果有就扩展，没有就新增）。

### 4.1 纯函数（5 条）

1. `DEFAULT_BRIGHTNESS_PCT = 100`（不降亮是默认）
2. `normalizeBrightness(undefined) === { pct: 100 }`
3. `normalizeBrightness({pct: 50}) === { pct: 50 }`
4. `normalizeBrightness({pct: 150}) === { pct: 100 }`（clamp 上界）
5. `normalizeBrightness({pct: -1}) === { pct: 0 }`（clamp 下界）
6. `brightnessToAlpha(100) === 0`（默认 → 透明）
7. `brightnessToAlpha(0) === 1`（完全黑）
8. `brightnessToAlpha(50) ≈ 0.5`（线性）

### 4.2 结构性负控（2 条）

9. `BRIGHTNESS_KEY` 这个名字在仓内只 export 一次
10. `brightnessToAlpha` 字面值 0.5 / 1.0 不出现在 production code（只能由函数算）

### 4.3 DOM（4 条）

11. Control Center 打开时 slider 存在
12. 拖动 slider 写入 store
13. `brightness-overlay` 在 `pct = 100` 时**不渲染**
14. `brightness-overlay` 在 `pct = 0` 时渲染且 `pointer-events: none`
15. slider 上有「仅桌面」标签

### 4.4 i18n（2 条）

16. `cc.brightness` / `cc.brightnessScope` / `cc.brightnessHint` 在 zh + en 各存在
17. i18n-scan 不报 stale key

**合计 17 条测试，全部先于实现写出**。

---

## 5. 文件清单（落地范围）

| 文件 | 改动 | 行数（估） |
|---|---|---|
| `docs/DESKTOP_BRIGHTNESS_SLIDER_G_BETA_1.md` | 新增 | 200 |
| `frontend-ts/src/lib/brightness.ts` | **新文件** | +50 |
| `frontend-ts/src/lib/sysIcons.ts` | 加 `brightness` 图标 id | +5 |
| `frontend-ts/src/svelte/ControlCenter.svelte` | 加 slider 区块 | +30 |
| `frontend-ts/src/svelte/DesktopShell.svelte` | 加 brightness overlay div | +15 |
| `frontend-ts/src/lib/sysIcons.ts`（图标 SVG） | 加 sun 图标 | +10 |
| `frontend-ts/src/i18n/locales/{zh,en}.ts` | +3 键 × 2 语言 | +12 |
| `frontend-ts/src/lib/__tests__/brightness.test.ts` | **新测试** | +120 |
| `frontend-ts/svelte-tests/control-center.svelte.test.ts` | +5 用例 | +80 |
| `frontend-ts/svelte-tests/desktop-shell.svelte.test.ts` | +2 用例 | +40 |
| `CHANGELOG.md` | 一条完整变更记录 | +55 |

总计：**净增 ~615 行 / 删除 0 行**。

---

## 6. 真机复核清单（Self-Review Checklist）

- [ ] 打开控制中心，看到 brightness slider 默认在 100%
- [ ] 拖到 50% → 整个 WebView 内容变暗（顶栏 / Dock / DesktopStage 都变暗）
- [ ] 应用窗口（独立 WebviewWindow）**不变暗**（验证它真的是 WebView 内的效果，不是系统级）
- [ ] 开 Mission Control 浮层 → 浮层**不变暗**（z 序对）
- [ ] 关掉控制中心 → slider 值**保留**在 store 里
- [ ] 重启 → 滑杆位置**恢复**到上次值
- [ ] macOS: 真机检查应用窗口外部的桌面区域**不变暗**（这正是诚实边界要确认的）

---

## 7. 不做清单（Explicitly Out of Scope）

- 控制系统级亮度（macOS `NSScreen.brightness`、Windows WMI、Linux xrandr —— WebView 不可达）
- True Tone / Night Shift / 色温调节（需要 CoreGraphics / ColorSync）
- 键盘 `Brightness Up/Down` 键绑定（OS 自己消费）
- 外部显示器单独调节
- 多显示器不同亮度（WebView 不能区分多显示器边界）
- 降亮动画（snap-to-value，无 transition —— 减少视觉噪音）

---

**Status**: 设计稿已就绪，等待「立刻落代码（负控先行）」授权。
