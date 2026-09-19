# G-DesktopShell · 桌面背景 fallback（死黑 → macOS 中性灰）

> 状态：✅ **已实现**（2026-09-18）。本页是这条工作的**设计记录**，内容与代码/门禁一一对应；
> 每一条判断后面都跟着可以自己跑一遍的命令或文件位置。
>
> 这一页此前**不存在**：`docs/DESKTOP_BRIGHTNESS_SLIDER_G_BETA_1.md` 从写下那天起就链接到
> `./DESKTOP_DESKTOP_SHELL_BACKGROUND.md`（多了一个前缀的错名），而真正的文件从未落地 ——
> `node scripts/docs-link-scan.mjs` 因此长期报一条 FAIL。文件名定为
> `DESKTOP_SHELL_BACKGROUND.md`（与 `DESKTOP_TITLEBAR_G_ALPHA.md` /
> `DESKTOP_NOTIFICATION_BANNER_G_GAMMA.md` 同一套命名），链接同轮改正。

---

## 1. 缺陷（Why）

`DesktopShell.svelte` 的根容器把 fallback 颜色写成了内联的 **`background: #1a1a1a`**。
它的本意是"壁纸加载前的一帧底色"，但那行字面值在**任何**壁纸未绘制的时候都会生效：

| 时机 | 用户看到的 |
|---|---|
| 首帧（Backdrop 还没挂载） | 整屏死黑 |
| 壁纸图加载失败（离线 / 路径错） | 整屏死黑 |
| 从 app 切回桌面的一瞬间 | 整屏死黑 → 突然出现壁纸 |

两个理由让它成为缺陷，而不是口味问题：

* macOS 真机的 `NSColor.windowBackgroundColor` ≈ **`#1e1e1e`**（dark）/ **`#ececec`**（light）——
  是**中性灰**，不是黑；
* Apple HIG 明文 *avoid pure black*（纯黑在 OLED 上有 letterbox 伪影，且会让壁纸看起来像被裁掉）。

## 2. 修法（What）

### 2.1 颜色字面值的唯一真源

`frontend-ts/src/lib/wallpaper.ts::wallpaperFallbackColor(dark: boolean): string`
返回 `#1e1e1e`（dark）/ `#ececec`（light）。这是仓内**唯一**允许出现这两个桌面 fallback
字面值的地方；`DesktopShell.svelte` 与 Backdrop 都必须 `import` 它——与
`lib/desktopLayout.ts::TOPBAR_HEIGHT` 的"唯一真源"纪律同源。

### 2.2 根容器读它，不写第二份

`DesktopShell.svelte` 的根容器（`data-testid="desktop-shell-root"`）：
`style="background: {wallpaperFallbackColor(true)}"` —— Svelte 把它渲染成
`background: #1e1e1e`；light 值在组件的 `<style>` 块里用 `@media (prefers-color-scheme: light)`
覆盖，即"跟随 **OS 级**偏好"（Backdrop 跟随的是**用户**主题偏好，两者是两件事，不重复计算）。

## 3. 证据（可自跑）

```bash
cd crates/amos-tauri/frontend-ts
bun test src/__tests__/wallpaper.test.ts                        # 5 例：返回值不是死黑/死白、两种模式不同、dark 亮度 < light
npx vitest run svelte-tests/orig-test.test.ts -t "G-DesktopShell"  # 2 例 DOM：根容器的 inline background == wallpaperFallbackColor(true)
```

**两条结构性负控**（这才是这条纪律能被守住的原因，而不是靠人记得）：

* `wallpaper.test.ts` 里有一条**全仓 grep**：production 的 `.ts`/`.svelte` 里**不得**再出现
  `#1a1a1a` 作为桌面背景色 —— 谁把它"恢复"回去，这条立刻红；
* 上面那两条 DOM 用例断言根容器的 `style.background` **等于函数的返回值**（而不是等于某个
  抄来的字面值），于是"函数变了、容器没跟上"也会红。

## 4. 诚实边界（登记，不假装）

1. **不做用户主题跟随**：根容器跟 `prefers-color-scheme`（OS 偏好），Backdrop 跟 `themeDark()`
   （用户偏好）。macOS 上两者同源，所以实际不会分歧；在"用户偏好 ≠ OS 偏好"的配置下会有一帧
   时序差 —— 这是**有意的权衡**（shell 不为此再起一个 watcher），不是 bug。
2. **Backdrop 组件本身未改**：它加载失败时是透明的，漏到根容器的中性灰。若将来撞到"Backdrop
   漏白"，需要在 Backdrop 的 wrapper 上加 fallback —— 与本轮是互补关系，不是替代。
3. **未做真机肉眼复核**：dark 下 `#1a1a1a` → `#1e1e1e` 只差 4 级亮度（人眼几乎无法分辨），
   light 下 `#1a1a1a` → `#ececec` 差异巨大（这才是用户会立刻看到的那个）。
