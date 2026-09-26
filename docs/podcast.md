# Amos 播客（Podcasts）

**Amos Podcasts** 是 Amos「订阅内容播放」的**领域核心**：定义「一个 feed 是什么」「一集是什么」「订阅、播放进度、离线下载如何持久化」。UI 只负责画，规则全在这里。

本模块按仓库一贯的四层拆分落地（参考 `amos-appstore` / `amos-mail`）：**领域内核 → CLI → Tauri 桥接 → Svelte 前端**。

> 状态：**领域内核 + CLI + Tauri 桥接 + Svelte 前端已实现**（2026-09-25）。
> Rust 侧：`crates/amos-podcast`（真 XML 解析器 + `FeedProvider` seam + mock + 四个有界存储）与其终端前端 `crates/amos-podcast-cli`；连接层 `crates/amos-tauri/src/podcast.rs`（managed `PodcastBridge` + `podcast_*` 命令）；前端 `frontend-ts/src/lib/podcast.ts`（typed 桥接 + 纯格式化规则）与 `frontend-ts/src/svelte/PodcastsApp.svelte`（「播客」应用页）。默认后端是**离线确定性 mock**，真实 HTTP 抓取在 `live`/`podcast-live` feature 之后，默认不编。

---

## 1. 为什么需要它

播客这个问题域真正的难点不在「把 XML 读成列表」，而在**「我们到底知道什么」**。一个 feed 可以**不给时长**、**不给发布日期**、**根本没有音频 enclosure**；一个订阅可以**从未成功抓取过**；一集可以**从未被播放过**。这些「不知道」如果被展示成 `0:00` / 纪元时间 / 空列表，用户看到的就是一个**系统替他编造的事实**。

所以本模块存在的唯一理由可以浓缩成一条规则，它贯穿 Rust 的 `Option` 直到屏幕上的 `—`：

> **一个未知，永远不被折叠成一个「测量到的零」。**

这条规则和 `amos-appstore` 的「只信 provider 的取、不信它的判」是同一类工程纪律：把「哪些是已知的」当成领域模型的一部分，而不是渲染时临时猜。

---

## 2. 分层与架构

```
[ Svelte PodcastsApp ]  ← 只画；文案里的「不知道」由下列规则决定
        │  经 frontend-ts/src/lib/podcast.ts 的 typed 桥接
        ▼
[ Tauri PodcastBridge (crates/amos-tauri/src/podcast.rs) ]
        │  tokio::sync::Mutex<PodcastManager<Box<dyn FeedProvider>>>
        ▼
[ PodcastManager<P> 引擎 (manager.rs) ]   ← 订阅 / 刷新 / 播放进度 / 下载
        ├── SubscriptionStore (store.rs)   有界、超限**拒绝**
        ├── EpisodeLibrary    (library.rs) 有界、LRU 淘汰
        ├── ProgressStore     (progress.rs)有界、淘汰最旧
        └── DownloadRegistry  (download.rs)下载状态机 + 重试策略
        │  通过 FeedProvider seam 取 feed 字节
        ▼
[ FeedProvider trait (provider.rs) ]
        ├── MockFeedProvider   （确定性、离线、默认）✓
        └── HttpFeedProvider   （真实 HTTP，feature `live`，默认不编）✓
```

- **`feed.rs`**：RSS 2.0 / Atom 解析器（`quick-xml`），**不是字符串匹配**。频道级字段（`title` / `description` / `link` / `author`）只从**频道元素的直接子节点**读取：RSS 2.0 **规定** `<image>` 自带 `<url>` / `<title>` / `<link>`，`<textInput>` 自带 `<title>` / `<description>` / `<name>` / `<link>` —— 这些名字与频道自身的字段**同名**，只按「祖辈里有 channel」判定就会让 `<image><title>封面图</title>` 顶掉节目名（进而在 `display_title` → `mark_subscription` 之后变成订阅列表里的名字）。例外有两处，各自有理由：`image_url` 恰恰**来自** `<image>` 内部（`channel` 祖先判定正确），Atom 的 `<author><name>` 合法地嵌在 `<author>` 里（按父节点是 `author` 判定）。
- **`model.rs`**：领域类型 + 总归一化器 + 上界常量。**「诚实缺失」的 `Option` 定义在这里**。
- **`provider.rs`**：唯一对外接缝，领域**自身不做任何网络 I/O**。
- **`manager.rs`**：把上面几个存储折叠成 CLI / 桥接所驱动的那些操作。
- **`persist.rs`**：四个存储共用的**原子** JSON I/O（同目录临时文件 + `fsync` + `rename`）。

CLI（`crates/amos-podcast-cli`）与 Tauri 桥接驱动**同一个** `PodcastManager`。这里修好的 bug，两端同时修好。

---

## 3. 唯一贯穿始终的规则：诚实缺失

Rust 侧一切「可能没有」都建模为 `Option`，并且**每一个归一化器都保留这个区分**：

| 字段 | 类型 | `None` / `null` 的含义 | 绝不能被渲染成 |
|---|---|---|---|
| `Episode::duration_secs` | `Option<u64>` | feed 没给时长 ⇒ **长度未知** | `0:00` |
| `Episode::published` | `Option<i64>` | feed 没给日期 ⇒ **日期未知** | 纪元 / 今天 |
| `Episode::audio_url` | `Option<String>` | feed 没有 enclosure ⇒ **无可播放的东西** | 一个点了没反应的按钮 |
| `Subscription::last_refreshed` | `Option<i64>` | **从未成功抓取** | 纪元时间 |
| `EpisodeProgress::position_secs` | `Option<f64>` | **从未播放过** | `0s` |
| `Episode::observed_duration_secs`（前端 `EpisodeView`） | `Option<f64>` | 播放器**没测量过** | 与 feed 声称的时长混为一个数 |

两条推论同样是规则的一部分：

- **部分和不是总和。** 前端 `feedTotals` 的总时长是 `number | null`：只要有一集没有时长，整条总时长就**扣住不给**（配 `runtimeCovering` / `runtimeUnknown` 说明覆盖了几集），而不是把缺的当 `0` 加进去。
- **一次未测量的进度不是「未开始」。** `progress_fraction` 对「时长未知」返回 `None`，对「已知长度为零」（直播流）返回 `Some(0)` —— 这两个是不同的事实，走不同的分支。

---

## 4. 领域模型与上界

### 4.1 类型

- **`Feed`**：一个 feed 快照 —— `title` / `author` / `description` / `link` / `image_url: Option` / `truncated` / `episodes: Vec<Episode>`。
- **`Episode`**：见上表；外加 `id`（feed 给了就用，没给就用 `synthetic_episode_id` 由索引+标题摘要派生）。
- **`Subscription`**：`feed_id`（归一化后的 URL）/ `url` / `title`（**feed 自己的名字**，在 fetch 前等于 URL）/ `custom_title: Option`（用户在 `add` 时自己起的名字）/ `last_refreshed: Option<i64>` / `subscribed_at`。两个标题字段是**两个事实**：`title` 由 feed 决定、任何一次 refresh 都可能被改写，`custom_title` 由用户决定、refresh 绝不动它。`Subscription::display_title()` 是唯一的取舍点 —— 有 `custom_title` 就用它，否则退回 `title`；CLI 的四处显示与前端 `subTitle` 都镜像这条规则。（`custom_title` 带 `#[serde(default)]`：老的行没有这个键，缺字段会被 `normalize_subscription` 折成 `Corrupt`，把整个订阅列表读空。）**重新 `add` 一个已订阅的 feed 只改 `custom_title`，绝不用 URL 占位去覆盖 feed 已知的 `title`**（`add_subscription` 造的行的 `title` 就是 URL，若合并放行就会把 refresh 学到的名字抹成 URL）；`add_subscription` 返回的是**存储后的行**（`subs.get`），不是它刚构造的那份 —— 否则调用方看到的名字和列表里的不是同一个。CLI 侧 `--title` 只在 `add` 上被读取，`subscribe --title` 是**具名拒绝**（`subscribe does not take --title`），不是静默丢弃（`--duration` 同理只属于 `play`）。
- **`DownloadState`**：`Absent` / `Queued` / `Downloading { received, total: Option }` / `Done { bytes, path }` / `Failed { reason }` —— 由 `download.rs` 的 `enqueue`/`start`/`progress`/`finish`/`fail`/`remove` 驱动。**这组写入是幂等且全定义（total）的，不是「非法迁移报错」**：`enqueue` 对已经 `Done`/`Downloading`/`Queued` 的 uid 返回 `Ok(false)`（拒绝，不是静默覆盖 —— 不去重抓已有的字节、不重复排队）；`progress` 对一个本注册表没开始过的 uid、以及对已经 `Done`/`Failed` 的记录都是 no-op（一次乱序回调不该凭空造出一条 `Absent` —— 那是屏幕会画的状态 —— 也不该把已完成的记录复活成 `Downloading`）；`start`/`finish`/`fail` 则是全定义的 —— 拿到任何 uid 都直接写目标状态（注册表没见过就造一条默认记录），唯一的 `Err` 来自落盘失败。所以「乱序 / 陌生 uid 的迁移」在这个领域里的答案是不报错。排队入口是 `PodcastManager::enqueue_download`（CLI 与 Tauri 桥接都走它，不再直接摸 `downloads_mut()`）：缓存里没有这一集、或它没有 enclosure URL 时返回 `NoAudio`（新码 `amos.podcast.no_audio`），**而不是**记一条永远排不下去的 `Queued`；屏幕对没有音频的一集也不再提供排队按钮（仍可「忘记」已有记录）。

### 4.2 有界性（恶意 / 误配置输入不能耗尽资源）

| 存储 / 解析 | 上界 | 超限行为 |
|---|---|---|
| XML 文档大小 | `MAX_XML_BYTES` = 8 MiB | 解析**拒绝** |
| XML 嵌套深度 | `MAX_XML_DEPTH` = 64 | 解析**拒绝**（不是无界栈） |
| 单 feed 集数 | `MAX_EPISODES_PER_FEED` = 2000 | **标记 `truncated`**，绝不静默截断 |
| 订阅列表 | `MAX_SUBSCRIPTIONS` = 500 | **拒绝**（订阅是用户数据，不是缓存） |
| 抓取缓存 | `MAX_CACHED_FEEDS` = 500 | LRU **淘汰** |
| 播放进度 | `MAX_PROGRESS_RECORDS` = 5000 | 淘汰最旧 |
| 下载记录 | `MAX_DOWNLOAD_RECORDS` = 2000 | 有界 |
| 各字段文本 | `MAX_ID_BYTES` / `MAX_TITLE_BYTES` / `MAX_TEXT_BYTES` / `MAX_URL_BYTES` / `MAX_AUTHOR_BYTES` | 归一化时按**字符边界**截断 |

「拒绝 vs 淘汰」的选择是有意的：**订阅**若被静默淘汰，用户的收藏就凭空消失，所以宁可不加；**缓存 / 进度**是可由重抓 / 重播重建的派生状态，淘汰更友好。

### 4.3 URL 规则

`normalize_feed_url` 只接受 **`http` / `https`**：其余协议（`file:`、`ftp:` …）返回 `UrlSchemeUnsupported`。理由写在该错误变体的文档注释里 —— 订阅 URL 来自分享面板或粘贴链接，是**可被攻击者影响**的；放行 `file:` 就等于让一条 feed 引用变成一次本地文件读取。

---

## 5. 抓取前置：fetch-before-store

`PodcastManager::subscribe` **先抓取、成功后才写入订阅列表**，因此订阅列表里永远不会出现一个「从未能到达」的 feed。`add_subscription`（CLI 的 `add`）是显式的「先存、后抓」路径，它存下的行 `last_refreshed` 为 `None`，界面照 §3 的规则显示为**「从未刷新」**，而不是一个空 feed。

「一个死 feed 不拖累其它 feed」同样是契约：`refresh`（无参数）刷新每一个订阅并**逐个报告结果**；失败是被命名的数据，且不丢弃已成功的那些。桥接侧的 `kept_previous_cache` 字段因此被**在抓取前**快照：只有「本来有快照」**且**这次失败发生在 fetch/parse 阶段（不是「可能正是写盘那一步」的 store 失败）时，才敢说「上一份缓存保留了」。

---

## 6. Tauri 桥接与前端契约

### 6.1 命令面（`crates/amos-tauri/src/podcast.rs`）

`podcast_backend_name` · `podcast_subscriptions` · `podcast_subscribe` · `podcast_add` · `podcast_refresh` · `podcast_feed` · `podcast_unsubscribe` · `podcast_set_position` · `podcast_set_speed` · `podcast_set_played` · `podcast_enqueue_download` · `podcast_download_state` · `podcast_remove_download`。

其中 12 条有屏幕调用者；`podcast_download_state` 目前**没有** —— 每一集的 `DownloadState` 已经随 `podcast_feed` 的 `EpisodeView.download` 一起到达，`doToggleDownload` 在入队 ∕ 忘记后重读整份 feed，所以没有哪一屏会单独问一集的下载状态。它作为一个**保留的接缝**注册着（桥接方法本身有单测），留给将来「逐行进度轮询」：`Downloading { received, total }` 只有在两次 feed 快照之间被轮询才看得出在推进。记录在 `scripts/tauri-command-allowlist.json`。

seam 遵守 「**接缝让位给领域规则**」（REQ-A732/F-SH-190）：桥接的 `validate_feed_id` 委托 `amos_podcast::normalize_feed_url`，`validate_episode_id` 委托 `MAX_ID_BYTES`，**不重新实现**领域规则。

锁用 `tokio::sync::Mutex`：`subscribe` / `refresh` 会在 `.await` 期间持有 `&mut`，而 `std::sync::MutexGuard` **不是 `Send`**，用它会让每个命令 future 都不可用。tokio 的锁**不毒化** —— 这不重要（领域 crate 受 P0-1 门禁、锁下不会 panic），但文档里如实写明。

### 6.2 前端规约

`frontend-ts/src/lib/podcast.ts` 的 `invoke<T>` 返回 `T | null`：**`null` 同时意味着「没有宿主」和「被拒绝」**。两者靠**逐命令诊断账本** `bridgeDiag(cmd)` 区分（`{ok:true}` vs `{ok:"command-failed"}`，REQ-A296）—— 这正是 `PodcastsApp.svelte` 把「订阅了但从未抓取」与「读取失败」画成两张不同卡片所依据的唯一信息。

### 6.3 「无数据」是三个不同的事实，不是一张空白

`PodcastsApp.svelte` 的详情区任何时候都落在下面之一，**不允许把任意两个折叠**：

1. **从未抓取**：`podcast_feed` **成功返回 `null`** ⇒ 我们根本没看过 ⇒ 显示「尚未获取」卡片。
2. **读取失败**：调用**被拒绝** ⇒ 我们看了、但失败了 ⇒ 显示拒绝文案（带 `code`→文案映射）。
3. **真的没有**：快照存在且集数为零 ⇒ 显示「没有单集」。

订阅列表同理：**离线**显示离线提示（`podcast-offline`），而**不是**画成一个空库（「读不到」不等于「你没有」）。

### 6.4 边界：这一屏只**记录**状态

`PodcastsApp.svelte` **没有播放按钮**。仓库里没有任何跨应用的「交给播放器」交接通道，所以放一个播放按钮就等于一个点了什么都不发生的控件 —— 这本身就是一次「系统替用户编造事实」。页面用 `podcast.boundary` 一句**明说**：它只记录订阅 / 进度 / 下载状态，不解码、不播放、不下载字节。

### 6.5 两个「值在线上」的形状

**`EpisodeView.download` 是带标签的** `**对象**，不是裸的变体名。`DownloadState` 是内部标签枚举（`#[serde(tag = "state", rename_all = "snake_case")]`），所以线上是 `{"state":"absent"}` ∕ `{"state":"downloading","received":5,"total":null}` ∕ `{"state":"failed","reason":"…"}`。前端的 `DownloadState` 类型按这个形状建模（可辨识联合），`hasDownloadRecord(state)` 是「有没有记录」这一问的**唯一**答案处 —— 按钮的文案、它执行的动作、以及那一行状态文字三者必须给出同一个答案。

> 这里曾经错成 `"Absent"`（字符串联合）：于是 `ep.download === "Absent"` 对每一行都为假，同一条行上出现「取消缓存」按钮压着「未记录下载」状态文字，点下去删的是一条从不存在的记录 —— 而组件测试用的是自己手写的同名 fixture，全线绿。钉住它的有两处：桥接侧 `the_view_carries_the_download_state_the_screen_reads`（把三种变体的 JSON 逐字钉死）与组件侧「按钮跟随它真正持有的记录」一例。

**速度选择器能表示引擎真正持有的速率。** 引擎对速率是**夹取**（`clamp`）而非**吸附**：CLI 的 `speed <feed> <episode> 1.1` 会合法地存下 `1.1`。`<select>` 的 `value` 匹配不到任何 `<option>` 时渲染为「什么都没选中」，所以 `speedOptions(stored)` 会把列表里没有的、有限的 `stored` 插进有序选项中 —— 屏幕不会因为选项表而说不出口引擎持有的值。

### 6.6 一部剧只有一个名字

`PodcastFeedView.title` 送的是**显示名**（`amos_podcast::feed::display_title`）：从缓存里那条**原始** `title` 剥掉标记（缓存刻意保留 feed 原文 —— `display_title` 存在就是为了剥），名字为空时回落 `feed_id`。这与订阅行用的 `Subscription::display_title` 是**同一条派生**，所以侧栏那一行和详情页头不可能对「这部剧叫什么」给出两个答案。

> 这里曾经把缓存字段直接送上屏：`<b>Rust</b> &amp; Friends` 的 feed 在侧栏读作 `Rust & Friends`，详情头却逐字画出 `<b>Rust</b> & Friends`。钉住它的是桥接侧 `the_view_names_the_feed_the_way_the_subscription_does`（断言 `view.title == sub.title`）。

这条规则按**名字**扫，不按文件扫 —— 同一个洞里还掉着 CLI 的 `episodes`：它的表头打 `cached.feed.title`（原文），而同一份输出里的 `subscriptions` / `subscribe` / `add` 三处都走 `display_title`。钉住它的是 `episodes_names_the_feed_the_way_subscriptions_does`。顺带：`label_for`（`display_title` 的同义包装）与 `validate_url`（`normalize_feed_url` 的同义包装）两个公开导出**零消费者**，且 `validate_url` 的文档写着「the Tauri bridge and CLI share」—— 而两者都直接调 `normalize_feed_url`（桥接的 `validate_feed_id` 文件里明说了这一点）。同一条规则有两个入口就是漂移的入口，两个包装已删除。

**边界：单集标题不在这条规则内。** `normalize_episode` 对单集标题只解码实体、不剥标记 —— 单集标题是**身份材料**（feed 没给 `<guid>` 时 `synthetic_episode_id` 由规范化后的标题构造），换成一个「显示形状」的过滤器去改写它，会让既有播放进度记录的 key 集体漂移。

---

## 7. 快速上手

### 7.1 Rust（领域内核）

```rust
use amos_podcast::{MockFeedProvider, PodcastManager, PodcastPaths};

// 离线 mock；paths 全 None = 纯内存
let mut mgr = PodcastManager::new(MockFeedProvider::new(), PodcastPaths::default());

let sub = mgr.subscribe("https://feeds.amos.dev/rust-weekly.xml", 1_700_000_000).await?;
let feed = mgr.episodes(&sub.feed_id).expect("fetched before stored");
// 时长未知的那一集：format_duration(None) == None，界面画「—」，不是 0:00
for ep in &feed.feed.episodes {
    println!("{} {}", ep.title, amos_podcast::format_duration(ep.duration_secs).unwrap_or_else(|| "—".into()));
}
```

### 7.2 CLI

```bash
cargo run -p amos-podcast-cli -- subscribe https://feeds.amos.dev/rust-weekly.xml
cargo run -p amos-podcast-cli -- episodes  https://feeds.amos.dev/rust-weekly.xml
cargo run -p amos-podcast-cli -- play      https://feeds.amos.dev/rust-weekly.xml rw-3 600 --duration 2755
cargo run -p amos-podcast-cli -- refresh
cargo run -p amos-podcast-cli -- unsubscribe https://feeds.amos.dev/rust-weekly.xml
```

`play` 记录的是「播放器**观察到** `--duration`」，它不测量；一封不给时长的 feed 的集，`episodes` 与 `progress` 都打 `—`。

`--duration` 缺席时打的百分比**回退到记录里已有的那次测量**（`observed_duration_secs`），不是只认本次参数：`ProgressStore::set_position` 在传入 `None` 时**保留**上一次的 `observed_duration_secs`（`observed_duration_is_not_erased_by_a_later_update_without_one` 把这条钉住了），所以第二次 `play … 150`（不带 `--duration`）仍然能算 `50% of the measured duration`。只有在记录里**也确实没有**测量值时，才回落到「no duration known yet, so no percentage — pass --duration <SECS>」这句。这条规则在前端是 `effectiveDurationSecs = observed_duration_secs ?? duration_secs`，两边同一条：一次新测量（`--duration`）压过旧测量，旧测量压过「不知道」，从不把「不知道」折成 0。


### 7.3 持久化与环境变量

四个存储的路径由环境变量解析（`PodcastPaths::from_env`）：

- `AMOS_PODCAST_DIR` —— 把四个文件放进同一目录；
- `AMOS_PODCAST_SUBSCRIPTIONS` / `_LIBRARY` / `_PROGRESS` / `_DOWNLOADS` —— 逐个覆盖。

**两者都没有时，所有存储只在内存中**（不会未经请求就往用户磁盘写东西）。CLI 的 `--dir` 等价于设 `AMOS_PODCAST_DIR`。

### 7.4 接真实 HTTP（feature `live` / `podcast-live`）

```bash
# 领域内核
cargo test -p amos-podcast --features live
# 让 Tauri 进程真的走网络：既要编进 podcast-live，运行时还要设开关
AMOS_PODCAST_LIVE=1 cargo run -p amos-tauri --features podcast-live
```

未编 `live` 时，选择 `HttpFeedProvider` 的环境变量**被忽略**、仍用 mock —— 默认构建无法意外触网。这是与 `amos-appstore` 的 `live` 完全同形的门控。

---

## 8. 测试

```bash
cargo test -p amos-podcast            # 领域内核
cargo test -p amos-podcast-cli        # CLI
cargo clippy -p amos-podcast -p amos-podcast-cli --all-targets -- -D warnings
cargo fmt  -p amos-podcast -p amos-podcast-cli -- --check
```

前端两套 runner 各管一半：`frontend-ts/src/__tests__/podcast.test.ts`（bun + happy-dom，覆盖纯规则）与 `frontend-ts/svelte-tests/podcasts-app.svelte.test.ts`（vitest + svelte，覆盖组件行为）。桥接侧 `crates/amos-tauri/src/podcast.rs` 有一个 `#[cfg(test)]` 模块，用可注入的 provider 钉住「四存储 join + wire 形状」里**默认 catalog 表达不了**的那些（例如「一次成功抓取之后再失败」）。

测试的写法本身遵守 §3：每个「缺失」用例旁必有一个**正向对照**（一个真实的 `0`、一个真实的时间点），否则「永远答 `null`」或「永远答 `0`」都能蒙混过关。

---

## 9. 诚实边界（明说做不到的）

- **这个 crate 不是播放器。** 它建模播放*进度*；解码与出声是平台播放器（Tauri `PlayerApp`）的事。同理 `PodcastsApp.svelte` 没有播放按钮（见 §6.4）。
- **下载的字节由调用方搬运。** `DownloadRegistry` 只记录状态与调度/重试*策略*，它自己不开 socket、不写文件。策略分两半，成熟度不同：**重试**那半（`MAX_DOWNLOAD_ATTEMPTS` = 3、`should_retry` / `retry_delay` 的指数退避）有读者（CLI 的 `download-status` 逐条报「还能重试几次 / 下次隔多久」）；**并发**那半（`next_to_start` + `MAX_CONCURRENT_DOWNLOADS` = 2）目前**没有任何生产者调用方** —— 它是被单测钉住的纯调度策略，但没有代码真的用它来节流「同时开几个下载」，所以「同时最多 2 个在跑」现在是**意图而非保证**。它和 `podcast_download_state` 一样是登记过的接缝：接上真正搬字节的执行器时即刻生效，现在删掉反而把已经定好的确定性排序（`updated_at` 平局按 uid 破）丢掉。
- **`unsubscribe` 不删已下载的文件。** 它清掉订阅、抓取缓存与播放进度；`Done` 下载所指向的文件是调用方的事。
- **`podcast_unsubscribe` 的回报里没有「到底删没删掉那一行」。** 未订阅的 feed 是**具名拒绝**（`amos.podcast.unknown_feed`，与 `podcast_feed` 和 CLI 的 `require_subscription` 同一条），所以 `PodcastUnsubscribe` 只在「确实删掉了」时被构造一次 —— 领域里的 `removed_subscription` 就不必再过线：一个恒为 `true` 的 `bool` 正是让「什么都没做」被渲染成「已取消订阅」的那个形状。回报只带两个能出现差异的事实：`dropped_cached_episodes`（`podcast_add` 存下但从未抓取的订阅没有缓存可丢）与 `cleared_progress_records`。
- **时间戳由调用方给。** 每个存储都接受 `now: i64` 而不读时钟，所以测试能断言 `last_refreshed` 而无需 sleep。
- **真实 HTTP 默认关。** 见 §7.4。
- **两个领域错误变体目前只有映射、没有生产者。** `StoreReadFailed` / `DownloadFailed` 在 `amos-podcast` 里从不被构造（读盘的失败被 `persist.rs` 折成 `LoadOutcome::Corrupt`，下载的字节按上一节归调用方搬运），它们与 `podcast_download_state` 一样是**登记过的接缝**：`map_error` 为它们各自留了独立错误码，将来那条路径落地即生效，现在删掉反而会把已经想清楚的区分丢掉。
- **前端有三个算出来但没有读者的字段。** `FeedTotals.started`、`FeedTotals.runtimeUnknown`、`RefreshSummary.codes` 由 `lib/podcast.ts` 的纯规则算出并被单测钉住，但 `PodcastsApp` 的 header 画的是 `episodes` / `played` / `knownRuntimeSecs` / `runtimeCovering`，刷新卡片画的是 `anyFailed` / `ok` / `total` / `keptCache`。它们是留给「更细的状态条 / 逐条失败原因」的接缝，保留而不是删除；`started` 按 `position_secs !== null` 计数（含 `0`），与 `episodeState` 的「in-progress 需要 `> 0`」不是同一条规则，所以**在有人真的画它之前**不要直接把它当成进度状态数。
- **真机未验收。** 组件测试只覆盖「我们这一侧」的判定（画了哪张卡片、哪句文案）；真实网络抓取与真机 WebView 的端到端不在本轮证据范围内。

---

## 路线图

- [x] **领域内核 `amos-podcast`**（2026-09-25）：RSS 2.0 / Atom 解析 + `FeedProvider` seam + mock + 四个有界存储 + 诚实缺失规则。
- [x] **CLI `amos-podcast-cli`**（2026-09-25）：subscribe / add / refresh / episodes / progress / play / speed / played / download 系列 / unsubscribe，`--dir` / `--live`。
- [x] **Tauri 桥接**（2026-09-25）：`PodcastBridge` + 13 个 `podcast_*` 命令。
- [x] **Svelte 前端**（2026-09-25）：`lib/podcast.ts` 纯规则 + `PodcastsApp.svelte` 三态无数据页，中/英 i18n 齐全。
- [ ] **真实播放器交接**：让 `PodcastsApp` 能把一集交给平台播放器（跨应用通话），之后才谈「播放按钮」。在它落地前，本节保持为「只记录状态」。
- [ ] **真实下载执行器**：把 `DownloadRegistry` 的状态机接到一个真正搬字节的组件，并实现 §9 里「文件归调用方」的删除约定。
- [ ] **`live` HTTP 抓取的真机端到端**：环回测试之外的、对真实 feed 的 `#[ignore]` 门控用例。
