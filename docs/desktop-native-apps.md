# 桌面原生应用（Wine / XDG）——「非 WebView 的应用」怎么进 AmOS

> 状态：**已接线并单测覆盖**（2026-09-15，REQ-A254）。相关：`docs/multi-window.md`（窗口层）、
> `docs/pwa-index.md`（Web/声明式应用）、`docs/appstore.md`（F-Droid/APK 通道）、
> `docs/android-compat.md`（Android 容器）。本页讲的是**第五种应用形态**：宿主机自己
> 已经装好的原生程序。

## 1. 为什么需要这一层

AmOS 的桌面形态此前只有三类应用：内置 Svelte 屏、已安装 web-bundle（真 origin）、以及
Android 容器里的 APK。**用户机器上早就装好的程序**（Windows 程序跑在 Wine 上、Linux 的
XDG `.desktop` 应用）一个都进不来——而 FydeOS 这类系统的生态优势恰恰在这里：它们让
「这台机器上已经有的东西」直接成为系统的一部分。

这一层把两种宿主能力变成同一条产品线：

| 形态 | 发现方式 | 运行方式 | 命令 |
|---|---|---|---|
| Windows 程序（Wine） | Wine 前缀里 `Start Menu/Programs/**/*.desktop` | `wine <exe>` | `wine_apps` / `wine_launch` / `wine_is_available` |
| Linux 桌面应用 | XDG `applications/*.desktop`（三处根目录） | `Exec=` 的 argv | `linux_apps` / `linux_launch` / `linux_is_available` |

两者共用同一个**纯解析器** `crates/amos-tauri/src/desktop_entry.rs`（freedesktop
`.desktop` 格式），界面共用一张屏幕 `frontend-ts/src/svelte/NativeAppsApp.svelte`
（应用 id `nativeapps`，「原生应用」）。

## 2. 数据流

```
[ 宿主 Rust ]                                   [ WebView ]
  desktop_entry::scan_desktop_files(roots)         NativeAppsApp.svelte
     └ 显式工作列表（BFS，深度/文件数有界）            │ onMount
  desktop_entry::parse(&text) → DesktopEntry         │
  desktop_entry::argv(exec) → program + args         │
     │                                               ▼
     ├── wine_apps()   → Vec<WineApp{id,name,exePath,…}>  ─────► 渲染两个分组
     └── linux_apps()  → Vec<LinuxApp{id,name,exec,args,…}>      （Windows / Linux）
                                                          │ 点「启动」
                                                          ▼
                                       nativeLaunch(kind, id) → invoke("wine_launch"|"linux_launch", { id })
                                                          │
     list_apps() 重新枚举 ──► app_by_id(id) ──► spawn（stdio 分离）
```

**关键点：`id` 是唯一可寻址的东西。** 界面**从不把路径发回宿主**，宿主也不接受路径。

## 3. 信任边界（这一层的核心设计）

第一版把启动做成 `wine_launch(exe_path: String)` / `linux_launch(exec: String)`，也就是
**WebView 说什么就跑什么**。任何一个第三方 web-bundle（它运行在自己的 WebView 里、拿得到
`invoke`）都能让宿主执行任意路径——这与 `[permissions]` 那一整套收口点背道而驰。现在：

* 命令参数是 **`id`**，只可能来自宿主自己的枚举；
* `app_by_id` 重新枚举一遍再查找（不缓存用户可写的状态），未知 id ⇒ 具名拒绝
  （`no Linux app with id 'x' is installed`），屏幕把这句话原样显示；
* id 经过**字符白名单 + 长度上界**（`[A-Za-z0-9._-]`，≤ 64 字符）后才可能回显；
* 前端只提交 `{ id }`，`NativeAppsApp` 的测试甚至断言「载荷里不出现行内显示的 `.exe` 路径」。

这条边界的镜像在 `frontend-ts/src/lib/nativeApps.ts` 的模块注释里，两侧都写了同一句话。

## 4. 诚实边界（规范的一部分）

| 事实 | 系统怎么做 |
|---|---|
| 没有装 Wine | `wine_is_available() = false`；屏幕显示「本机没有安装 Wine」，**不是**「没有应用」 |
| 宿主不是 Linux | `linux_is_available() = false`；屏幕显示「Linux 应用只存在于它们的 `.desktop` 文件所在之处」 |
| 装了什么都没有 | 屏幕显示**第三种**文案（「Wine 已安装，但前缀里没有可启动的应用」） |
| 桥都不在（不在 AmOS 里跑） | 第四种文案；不显示任何分组，也**不假装**「本机没有应用」 |
| 入口读不了（超过 64 KiB / 目录不可读 / 深度或文件数触顶） | 计数并 `info!` 上报（`unreadable_dirs` / `skipped_depth` / `skipped_cap` / `skipped_entries`），**不静默少列** |
| 条目声明了 `NoDisplay`/`Hidden`/`Type=Link` | 不列出（它不是可启动的 Application） |
| 条目里找不到 `.exe`（Wine）或 `Exec=` 没有程序 | 不列出，计入 `skipped_entries` |
| `Exec=` 带 `%U`/`%f` 等字段码 | 丢弃字段码（宿主没有文件/URL 可替换）；`%%` 保留为字面 `%` |
| `Exec=env VAR=v prog` | **原样**交给 `env` 运行，变量不丢（Wine 的条目就写成这样） |
| 反斜杠 | 只有 `\\` 是转义；`C:\Program Files\…` 原样保留（第一版把分隔符吃掉了，被自己的测试抓住） |

**未做（登记给后续轮次）**：
1. **图标**：Linux 条目带 `Icon=`（名字或路径），界面目前只显示名字与程序，不解析图标主题；
   索引里的 `iconPath` 也未接线。
2. **进程生命周期**：启动后不跟踪 PID（无法「从 AmOS 关闭它」），也不做「已运行」指示。
3. **`env` 的选项**：`Exec=env -i …` 这类带选项的条目保持原样，于是**启动会失败并如实报错**
   （不做半应用）。
4. **Workdir / 启动提示**：`.desktop` 的 `Path=`、`StartupWMClass`、`Terminal=` 未读。
5. **真机验收**：本仓库的 CI 机器上既没有 Wine 也没有 Linux 会话，所以上面每一条都由
   **单元测试 + 假宿主**证明；真机观感（真的弹出窗口、真的进 Dock）属设备侧清单。

## 5. 验证

| 层 | 证据 |
|---|---|
| 解析器（纯） | `cargo test -p amos-tauri --lib desktop_entry::` — 7 例：本地化键忽略、组边界、字段码、`env` 前缀、有界读、**有界 BFS（深度上限与计数）** |
| Wine 发现/启动 | `cargo test -p amos-tauri --lib wine::` — 6 例：`.exe` token 的两种写法、id 白名单与长度、有界去重、**路径不是 id** |
| Linux 发现/启动 | `cargo test -p amos-tauri --lib linux_apps::` — 6 例：program+args、`env` 变量保留、拒绝不可运行条目、**路径不是 id**、非 Linux 宿主如实报错 |
| 桥 + 忠实降级 | `bun test src/__tests__/nativeApps.test.ts` — 11 例（含畸形载荷不抛、空 id 不出网、宿主拒绝语句保留） |
| 屏幕 | `vitest run svelte-tests/native-apps.svelte.test.ts` — 4 例：**四种状态互不混淆**、启动载荷只有 id（断言不含路径）、拒绝原因上屏 |
| 门禁 | `tauri-command-scan`（6 条命令均已注册且被消费，allow-list 从 20 收缩到 18）、`tauri-args-scan`、`rust-recursion-scan`（0 递归）、`rust-discard-scan`、`rust-unwired-scan` |

## 6. 相关文档

- [`multi-window.md`](./multi-window.md) —— 桌面壳层与多窗口协议（`wm_open` 等）。
- [`pwa-index.md`](./pwa-index.md) —— 声明式 Web 应用（与「原生应用」互为对照：一个还没法启动，一个已经能运行）。
- [`appstore.md`](./appstore.md) —— web-bundle 安装器与 F-Droid 通道。
