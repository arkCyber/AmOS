# AmOS PWA 索引与 `amos-app://` 网关

`amos-app://` 是 AmOS System UI 唯一的**系统资产私有协议**：WebView 里 `fetch('amos-app://index/apps.json')` 拿到的不是本地文件路径，而是一份由 Rust 编译出来的声明式索引。本页讲清楚它**是什么、为什么这样设计、以及哪里还没做**。

> 状态：**协议网关 + 声明式索引（`amos-app.toml` v0.1）+「Web 应用」前端消费方已实现并单测覆盖**（2026-09-13）。仍未做：把声明**启动**起来（远程站点 / 真 origin 运行时宿主），见文末[路线图](#路线图)。

---

## 1. 两个命名空间

`register_asynchronous_uri_scheme_protocol`（Tauri 2 的真实 API，本仓 `crates/amos-tauri/src/lib.rs`）注册了一个 scheme，`crates/amos-appstore/src/host.rs` 的 `serve_uri` 把它分成两个命名空间：

| URI | 内容 | 跨域 | 来源 |
|---|---|---|---|
| `amos-app://index/apps.json` | 编译后的 PWA 索引（JSON） | **允许**（`Access-Control-Allow-Origin: *`） | `pwa::serve_index` |
| `amos-app://index/icons/<file>` | 索引图标（PNG/SVG…） | 允许 | `<AMOS_PWA_INDEX_DIR>/icons/` |
| `amos-app://<app-id>/<path>` | 某个**已安装** web-bundle 的文件 | **不允许** | `<AMOS_APPSTORE_INSTALL_DIR>/<id>/` |

三点是刻意的：

* **`index` 是保留的 netloc。** `index` 本身是合法的 app slug，所以 `serve_uri` 在碰安装根目录**之前**就把它路由到索引——这类 app 因此永远打不开，这个保留名只在 `host::INDEX_NETLOC` 定义一次。
* **索引是公开的，bundle 不是。** 给 bundle 加 `*` 会让任何一个沙箱里的第三方应用用 `fetch` 读光另一个应用的文件；同源（应用自己的页面）读取不需要任何头。
* **`X-Content-Type-Options: nosniff` 永远设。** 第三方 bundle 永远不能被嗅探成 HTML/JS。
* **索引目录只放行 `icons/`。** manifest 本身永远是被**编译**进 `apps.json` 的，从不原样送出——公开面因此是一份 JSON 加一批图片，一个读者能一眼记住。

### ⚠️ 调用方（前端）必须知道的一件事：URL 形态**逐平台不同**

上表的写法是**处理器看到的**形态。**发起请求的 JS 不能照抄它**——自定义协议在 Windows/Android 上不存在原生支持，wry 用了一个改写（`wry-0.55.1/src/custom_protocol_workaround.rs`）：

```
{protocol}://…     ⇄     {http_or_https}://{protocol}.…
```

也就是说：

| 平台 | 你在 JS 里**必须**写的 | 处理器收到的（被还原后） |
|---|---|---|
| macOS / iOS / Linux | `amos-app://index/apps.json` | `amos-app://index/apps.json` |
| Windows / Android | `http://amos-app.index/apps.json` | `amos-app://index/apps.json` |

**两边的处理器形态是一样的**（`webview2/mod.rs` 的 `prepare_request` 在把 URI 交给处理器前调用了 `revert_uri_work_around`），所以 Rust 侧只有一条路径；**差异全部落在调用方**。在 Android/Windows 上用 `amos-app://…` 去 `fetch` 不会走到这个处理器——那个 scheme 不是 `http(s)`，WebView2 的过滤器（`http://amos-app.*`）收不到它。

`<AMOS_APPSTORE_INSTALL_DIR>` 下 bundle 的页面本身也是同理：它的真 origin 在 macOS 是 `amos-app://<id>`，在 Windows/Android 是 `http://amos-app.<id>`（Tauri 自己的 `tauri://localhost` 也遵循同一映射，见 `docs/devcare.md` 的真机日志 `webview url=http://tauri.localhost/`）。

> 这条现在**已被消费**：前端不自己拼 URL，而是问 Rust 的 `pwa_index_url` 命令（`crates/amos-tauri/src/appstore.rs`），用它拉起 `lib/pwaIndex.ts` 的 `fetchPwaIndex()`，「Web 应用」屏幕（`PwaHubApp.svelte`）就是它的唯一界面。Rust 侧 `index_base_url_for(bool)` 是纯函数，两种形态在**同一条机器**上都有单测。

---

## 2. `amos-app.toml`（v0.1）

一个预装 PWA 就是几百字节的声明。目录约定：

```
<index dir>/
  apps/org.amos.demo.odds.toml     # 文件名必须等于 app id
  icons/org.amos.demo.odds.png
```

```toml
[app]
id = "org.amos.demo.odds"          # 必填，仓库既有 slug 规则 [a-z0-9]+([._-][a-z0-9]+)*
name = "Open Odds"                 # 必填，非空
version = "1.0.0"                  # 必填，major.minor.patch[-pre]
description = "去中心化全球预测市场平台"

[display]
url = "https://odds.example.org"   # 必填，只接受 http/https
icon = "icons/org.amos.demo.odds.png"  # 可选，相对索引目录的路径
mode = "fullscreen"                # 可选：fullscreen | minimal-ui | standalone（默认 standalone）
orientation = "portrait"           # 可选：portrait | landscape | any（默认 any）
theme_color = "#0F172A"            # 可选，#rgb 或 #rrggbb

[[mcp_tools]]
name = "query_market_odds"         # 必填：[a-z][a-z0-9_]*，且全索引唯一
description = "查询全球实时事件的最新预测胜率或赔率。"

    [mcp_tools.inputSchema]
    type = "object"
    required = ["event_keywords"]

    [mcp_tools.inputSchema.properties.event_keywords]
    type = "string"
    description = "用户想要查询的事件关键词"

    [mcp_tools.execution]
    action = "url_redirect"
    url_template = "https://odds.example.org/search/{event_keywords}"

[permissions.network]
allowed_domains = ["odds.example.org", "cdn.odds.example.net"]
```

### 为什么校验这么严

`[[mcp_tools]]` 就是喂给本地模型的**工具字典**，所以一个坏 schema 不是排版问题，而是一个模型永远调不对的工具。每条规则都对应一种"静默没用"：

| 规则 | 它挡住的那个沉默故障 |
|---|---|
| `required` 必须是已声明的 property | 模型被要求永远提供一个 schema 里不存在的参数 |
| `url_template` 里的 `{x}` 必须是已声明的 property | 这条 URL 永远填不满 |
| **必填** property 必须出现在 `url_template` 里 | 模型老老实实给了参数，拼 URL 时被无声丢掉 |
| `url_template` 里的 `{x}` 必须在 authority **结束之后**（前置部分要含 `/`、`?` 或 `#`） | 值落在 host 位置就能**改写主机名**（`https://ok.example.org` + `@evil.test/x` ⇒ host 变 `evil.test`）——即"跳转助手"变成开放重定向 |
| tool `name` 全索引唯一 | 模型的路由键有歧义，同一个名字两个应用 |
| 文件名 == app id | 改个文件名忘改 id → 同一个应用两个真源 |
| 全表 `deny_unknown_fields` | 写了系统不实现的键，却以为它生效了 |

`amos-app://index/apps.json` 的输出形状：`{ "schema": 1, "apps": [ … ] }`，`apps` 按 id 排序（同一目录永远编译出同样的字节，可 diff、可缓存）。

---

## 3. 环境变量

| 变量 | 作用 |
|---|---|
| `AMOS_PWA_INDEX_DIR` | 索引目录（`apps/*.toml` + `icons/`）。**不设**时只提供构建期内嵌的 manifest（目前为空），并如实返回 `{"schema":1,"apps":[]}` |
| `AMOS_APPSTORE_INSTALL_DIR` | 已安装 web-bundle 的落盘根目录；不设时索引照常服务，但 `amos-app://<app-id>/…` 会**点名**这个变量缺失 |

本地跑通：

```bash
export AMOS_PWA_INDEX_DIR=/tmp/amos-index
mkdir -p /tmp/amos-index/apps /tmp/amos-index/icons
cp <上面的示例> /tmp/amos-index/apps/org.amos.demo.odds.toml
# 启动 System UI 后，在 WebView 控制台：
#   await (await fetch('amos-app://index/apps.json')).json()
```

---

## 4. 诚实边界

这一节是**规范的一部分**，不是免责声明。v0.1 刻意**拒绝**下面这些键，而不是收下再无视——因为一个"声明了 `biometric = true` 并拿回 `true`"的应用，已经被系统骗了。

**v0.1 会直接报错、并点出键名的：**

| 写法 | 为什么拒绝 |
|---|---|
| `action = "eval_js"` | AmOS 没有 JS 执行器，也没有为它准备审计链。serde 报 `unknown variant ... expected url_redirect` |
| `[permissions] wallet_sign = true` | `amos-web3` / `amos-identity` 有签名原语，但**没有**从 PWA 到签名的受审路径 |
| `[permissions] biometric = true` | 全仓没有任何生物识别代码（`grep` 为空），桌面/Android 都没有执行点 |
| `[permissions] p2p_network = true` | 仓内没有 `libp2p`（`Cargo.lock` 里没有），BP 里的说法目前是愿景 |
| `[permissions] location_access = "mock"` | 有 GNSS 读取（`sensor_host`，Android `LocationManager`），但**没有**位置伪装注入器 |
| `[display] js_heap_limit_mb = 10` | WebView 的 JS 堆上限不是 Tauri/WebKit/WebView2 提供的旋钮，没有任何代码能执行它 |

**收了但尚未强制的（写清楚，不装作已生效）：**

* `[permissions.network].allowed_domains` —— 语法的**唯一真源**是 `amos-network-guard::policy::domain_matches`：只接受**裸主机名**（`host.tld`），它匹配该主机**及其所有子域**（点边界安全：`example.com` 不会匹配 `notexample.com`）。**没有通配符形式** —— `*.host.tld` 在那个匹配器里**永远匹配不到任何主机名**，因此发布期就**拒绝**它（并提示改写为裸域名）；这条一致性由 `pwa::tests::the_domain_grammar_is_what_the_guard_matcher_implements` **直接对真实匹配器**钉住，而不是靠注释。

  **强制（2026-09-13 起）**：同一份文法现在有两个被执行的落点，见 [`appstore.md`](./appstore.md) §4.10 —— **已安装的 bundle** 在自己的 `amos-app.json` 里声明域名，宿主把它折进该 bundle **每个响应的 `Content-Security-Policy`**（`connect-src` / `form-action`），由 WebView 逐文档强制。**但索引里的预装声明（本页格式）仍未被强制**：那些条目今天根本不能启动（没有外部站点能力），所以它们的 `allowed_domains` 只是声明。逐 uid 的 `amos-network-guard` 规则**不能**用于隔离一个 web bundle —— 它与壳**同进程同 uid**，包过滤器无法区分（这条已写进代码注释，避免有人再承诺一个不可能的东西）。

* **「Web 应用」屏幕只呈现声明，不启动应用。** `[display].url` 是一个**远程站点**，而 AmOS 今天没有任何「打开 URL」的能力（全仓无 `window.open`、无 opener 插件、无远程 URL webview）。屏幕因此如实写出这一点，而不是放一个按下去没反应的按钮——那和 `Shell.svelte` 在 `isExtId` 分支上写「运行时宿主未建成」是同一条规矩。要让那一格真的能打开，需要的是**新能力**（外部浏览器 intent 或远程 webview + 出口放行），那是一个安全决策，不是画面的事。

要让上面任何一行变成"接受"，需要的不是一个字段，而是**那个 Rust 收口点**（enforce 的地方）。加字段而没加收口点，正是本仓审计反复抓的"死字段"。

---

## 5. 路线图

- [x] **`amos-appstore::pwa`**：`amos-app.toml` 解析 + 硬校验 + `apps.json` 编译（`PwaIndex::from_dir` / `to_json_pretty`），15 条单测（含一条**对真实匹配器**的 `allowed_domains` 文法一致性测试）。
- [x] **`amos-appstore::host::serve_uri`**：保留 netloc 路由 + 索引/图标服务 + 路径逃逸拒绝。
- [x] **Tauri 网关**：`register_asynchronous_uri_scheme_protocol("amos-app", …)`（`lib.rs`），响应整形（状态/MIME/nosniff/CORS）在 `appstore::serve_protocol_uri` + `protocol_response` 里，可离线单测。
- [x] **前端消费方**：`lib/pwaIndex.ts`（向 Rust 要 base URL → `fetch` → 全量 normalizer，永不抛错）+「Web 应用」屏幕 `PwaHubApp.svelte`（内置第 28 个应用 `pwa`，📦）。它渲染瓦片网格，**并展示每个应用声明的 `[[mcp_tools]]`** —— 这是仓库里唯一一处「系统对外宣称了哪些智能体工具」的人可见视图。未知 `schema` 会**拒绝解读**（不是猜），三种失败（`offline` / `unreachable` / `unreadable`）与「索引真的是空的」是**四种不同的文案**。
- [x] **把真实 bundle 走协议（运行时宿主）**：新增 Tauri `appstore_bundle_entry(id)`（证明 id 合法 / 已安装 / 入口可服务 → 返回**平台正确**的入口 URL）+ `svelte/ExtAppHost.svelte`，由 `Shell.svelte` 的 `store:<id>` 分支挂载。第三方应用因此运行在**自己的真 origin** 上，多页 / ESM / 自身 `fetch` 可用；`sandbox` 保留 `allow-scripts allow-same-origin allow-forms`、**不给** `allow-top-navigation`/`allow-popups`/`allow-modals`。旧的 `srcdoc` 内联路径（`lib/bundle.ts`）随之失去唯一消费者，已在 allow-list 里写明身份（见 `appstore.md` §4.10）。
- [ ] **把「预装声明」也启动起来**：`tile → 打开`。今天「Web 应用」屏幕**只呈现声明**并如实说明原因 —— AmOS 既没有外部浏览器能力，也没有「远程 URL 的 webview」，而这两个都是**新能力 + 安全决策**，不该由一个画面单方面假装。详见 §4 的诚实边界。（注意：**已安装**的 bundle 不在此列 —— 它已经能跑了。）
- [ ] **MCP 工具注入**：把 `PwaIndex::tool_dictionary()` 变成 `amos-ai` 推理请求里的工具字典——注意 `inference/real.rs` 的 `parse_hermes_token` 目前把 `tool_use` 帧当控制事件**丢弃**，这一步要连它一起改。
- [x] **`allowed_domains` 的强制（已安装 bundle）**：bundle 在自己的 `amos-app.json` 里声明 `allowed_domains`（与索引**同一份文法**），宿主把它折进该 bundle 每个响应的 `Content-Security-Policy` —— 声明→承诺的闭环由 WebView 逐文档执行（见 [`appstore.md`](./appstore.md) §4.10）。**索引里的预装声明仍未强制**（那些条目还不能启动）。

## 6. 相关文档

- [`appstore.md`](./appstore.md) —— 应用商店领域内核、发布契约、web-bundle 安装器。
- [`permissions-sandbox-audit-plan.md`](./permissions-sandbox-audit-plan.md) —— 沙箱能力申请与 `perm_authorize` 单一收口点。
- [`semantic-ui.md`](./semantic-ui.md) —— 语义层与 UI 的结合。
