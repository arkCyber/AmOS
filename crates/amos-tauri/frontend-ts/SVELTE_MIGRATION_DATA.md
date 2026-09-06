# Svelte 迁移 · 立项数据支撑（bundle + 帧率）

Measured on the current branch. Regenerate anytime with:

```bash
cd crates/amos-tauri/frontend-ts
npm run bundle:report   # vite build + node scripts/bundle-report.mjs
```

## 当前实测（2026 生产构建，dist/assets）

| 分类 | 文件 | raw kB | gzip kB |
|---|---|---|---|
| React main (js) | `index-*.js` | 494.27 | 150.64 |
| React main (css) | `index-*.css` | 48.92 | 8.81 |
| Svelte shared | `locale.svelte-*.js`（响应式 i18n） | 8.99 | 3.92 |
| Svelte app | `ContactsApp-*.js` | 8.22 | 3.21 |
| Svelte app | `PermissionsApp-*.js` | 4.46 | 1.93 |
| Svelte app | `CalculatorApp-*.js` | 4.02 | 1.97 |
| Svelte app | `WeatherApp-*.js` | 3.76 | 1.76 |
| Svelte shared | `store-*.js`（createStoreValue） | 1.41 | 0.76 |

汇总：
- **React main（一次性加载）**：gzip ≈ **160.3 kB**（10 屏的 React 体仍保留作 bun 回退，故未降——删除后一次性下降）。
- **Svelte 按需（懒加载，仅打开对应屏才下载）**：gzip ≈ **36.0 kB**，含 10 屏（Calculator/Weather/Contacts/Permissions/Clock/Messages/Music/Notes/Files/Photos）+ 共享 locale/store。
- 单个屏 gzip ≈ 1.7–4.6 kB，仅开该屏才加载。

## 怎么读这些数字（务必诚实）

1. **当前是"加法期"**：四个已迁屏的 **React 实现体仍在 React 主包里**（作为 bun 测试回退保留），所以上面 React main 数字没有变小——Svelte 屏是额外的、按需的。
2. **真正的"减法"在后一阶段**：等 Svelte 版在真机确认后删除这些 React 体（以及它们的 happy-dom DOM 测试），一次性移除的成本 ≈ 这些 React 屏在主包里的那部分字节。届时再用 `bundle:report` 复测即可量化净节省。
3. **Svelte 按需的价值**：受限/低端 Android WebView 上，用户常用到哪个屏才加载哪个屏的 ~2–3 kB（gzip）代码，而不是把整屏 UI 代码一开始就放进主 bundle 解析。解析字节少 → 启动/切屏更快。

## 真机验收 / A-B（设备已连接；下面命令请在设备侧执行）

前置：前端在 `crates/amos-tauri/frontend-ts`：
```bash
npm run build               # 本分支：8 屏走 Svelte
# React 基线包（A/B 用）：
#   临时把 src/apps.tsx 的 svelteEnabled() 改成 () => false → npm run build
```

**① 逐个屏过一遍（Svelte 版）并记录**：Calculator / Weather / Contacts / Permissions / Clock / Messages / Music / Notes
- 打开、切标签/交互、返回——确认无白屏/无报错；
- 改语言（设置里切中/英）→ 屏内文案应**原地更新**；
- 切深/浅色 → 屏内 UI 跟随；
- 关掉再开同一屏 → 数据仍在（store 持久化）。

**② 硬件/后端类功能（后续迁完的屏在此验收）**：camera / ai / interpreter / android / magnifier / vmemos / maps / store。

**③ 帧率 / 体积 A-B**（Svelte vs React，各 ≥5 次取中位）：
```bash
adb shell dumpsys gfxinfo <pkg> framestats      # 起止期间
# 或 chrome://inspect → Performance/Rendering（FPS、dropped frames、主线程长任务）
# 体积：npm run bundle:report
```
指标：首开 load/compile、交互到稳定帧、掉帧、主线程长任务。

> 我在本环境无 adb/对设备的访问，无法代跑。请你在设备侧执行上述清单，把结果（尤其帧率 A/B 与各屏是否异常）发我，我据此继续迁移剩余屏或修问题。

