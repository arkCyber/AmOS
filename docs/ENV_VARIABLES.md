# AmOS — 环境变量中央索引

> 单一可信源(single source of truth),所有运行时配置入口
>
> 状态:**机读自动生成** — 由 `scripts/env-doc-gen.mjs` 从代码扫描导出
>
> 适用范围:全部 47 个 workspace crate 与二进制
>
> **约定**:
> - `*` 标记无默认值的"必选"项(运行时若未设置则回退到文档默认值或拒绝启动)
> - 类型列: `path`(文件路径) / `url` / `int` / `duration`(如 `30s`/`5m`) / `bool`(`1`/`0`/`true`/`false`) / `enum` / `string`
> - **失效语义**:标注设置无效或缺失时的行为(`→ default` / `→ refuse-start` / `→ degrade`)

---

## 1. 推理后端 (amos-ai)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_BACKEND` | enum | (启动探测) | `→ mock` | 推理后端选择:`mock`/`api`/`ollama`/`hermes`/`ggml`。非 mock 后端若不可达 ⇒ 记 `degraded` 而**不**假装 mock |
| `AMOS_MODEL` | string | (后端相关) | `→ backend-default` | 模型标识(如 `gpt-4o-mini`、`deepseek-chat`) |
| `AMOS_MODEL_PATH` | path | - | `→ ggml-skip` | GGML 模型文件路径(模型解析链**第一**顺位:操作者覆盖) |
| `AMOS_BUNDLE_ASSETS_DIR` | path | (none) | `→ 内置根回退` | 随镜像打包的资源根;模型解析链**第二**顺位(`{dir}/models/<file>`)。未设时回退到固定内置根 `/data/amos`、`/system/share/amos`、`/system/etc/amos` |
| `AMOS_USER_MODELS_DIR` | path | (none) | `→ ~/.amos/models` | 用户安装模型目录;解析链**第三**顺位(`{dir}/<file>`)。未设时回退 `~/.amos/models`。任一 env 值超过 `MAX_MODEL_PATH_BYTES = 4096` 或为空白 ⇒ 记 warn 并**忽略**(不截断成意外路径) |
| `AMOS_GGML_BIN` | path | - | `→ ggml-skip` | GGML 二进制路径 |
| `AMOS_GGML_MODEL` | path | - | `→ ggml-skip` | GGML 模型 |
| `AMOS_GGML_STRICT` | bool | `0` | `→ best-effort`（集合外值告警一次后回退） | 真实引擎不可用时是否**拒绝启动**而不降级到 mock。truthy `1`/`true`/`yes`/`on`,off `0`/`false`/`no`/`off`;未设静默;拼错 ∕ 空白 ∕ 非 Unicode 报告一次后按 best-effort(REQ-A1990) |
| `AMOS_API_KEY` | secret | - | `→ mock` | 云端 API key(OpenAI/DeepSeek/Anthropic) |
| `AMOS_API_ENDPOINT` | url | - | `→ mock` | OpenAI 兼容 endpoint |
| `AMOS_HERMES_ENDPOINT` | url | - | `→ mock` | Hermes-Rust agent endpoint |
| `AMOS_OLLAMA_HOST` | url | `http://localhost:11434` | `→ ollama-fail` | Ollama 服务地址 |
| `AMOS_OLLAMA_API_KEY` | secret | - | `→ no-auth` | Ollama /v1 token 鉴权(可选) |
| `AMOS_GPU_LAYERS` | int | `0` | `→ cpu-only` | GGML GPU offload 层数 |
| `AMOS_ACCEL` | enum | (SoC 自动探测) | `→ cpu-fallback` | 加速器后端:`cpu`/`nnapi`/`vulkan`/`metal`/`qnn`/`neuropilot` |

---

## 2. 守护进程资源门(amos-ai)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_SOCKET` | path | `/tmp/amos-ai.sock` | `→ default-path` | UDS socket 路径 |
| `AMOS_TCP_ADDR` | url | (空 ⇒ 走 UDS) | `→ refuse-start` | 真机 TCP 桥接地址(必须为环回) |
| `AMOS_TCP_ALLOW_REMOTE` | bool | `0` | `→ refuse-non-loopback` | 设为 `1` 才允许绑定非环回地址 |
| `AMOS_TCP_TOKEN` | secret | (空) | `→ warn-no-auth` | TCP 通道 token;空 ⇒ 启动 warn 明示"无认证",**仍服务** |
| `AMOS_UDS_PEER` | enum | `enforce` | `→ enforce`（集合外值告警一次后回退） | UDS peer 凭据校验:`enforce`(默认)/`warn`/`require`（未设静默；拼错 ∕ 空白 ∕ 非 Unicode 报告一次） |
| `AMOS_MAX_SESSIONS` | int | `16` | `→ 16` | 生成准入池容量(`GenerationPool`,0 不可表示) |
| `AMOS_GEN_POOL_WAIT_MS` | int | `0` | `→ fail-fast` | 池满时是否等待(0 = fail-fast) |
| `AMOS_RESPONSE_CACHE` | bool | `0` | `→ disabled` | 是否启用响应缓存(进程内,重启即空) |
| `AMOS_SESSION_TIMEOUT_SECS` | int | `3600` | `→ 3600` | 会话超时 |
| `AMOS_SESSIONS_PATH` | path | (回退) | - | 会话持久化文件 |
| `AMOS_RATE_LIMIT_RPS` | int | `10` | `→ 10`（非 Unicode 告警一次后回退） | 每客户端请求速率上限 |
| `AMOS_RATE_LIMIT_TPH` | int | `100000` | `→ 100000`（非 Unicode 告警一次后回退） | 每客户端每小时配额 |
| `AMOS_BREAKER` | bool | `1` | `→ enabled`（集合外值告警一次后回退 enabled） | 后端熔断器开关（未设静默；拼错 ∕ 空白 ∕ 非 Unicode 报告一次） |
| `AMOS_BREAKER_FAILS` | int | `3` | `→ 3`（非 Unicode 告警一次后回退） | 熔断器失败阈值（未设 ∕ 不可解析 ∕ <1 静默回退默认） |
| `AMOS_BREAKER_COOLDOWN_SECS` | int | `30` | `→ 30`（非 Unicode 告警一次后回退） | 熔断器冷却时间（未设 ∕ 不可解析 ∕ <1 静默回退默认） |
| `AMOS_PRIVACY_PATH` | path | `~/.amos/privacy.jsonl` | `→ mkdir-p` | 隐私审计落盘 |
| `AMOS_AUDIT_PATH` | path | `~/.amos/audit.jsonl` | `→ mkdir-p` | 通用审计落盘 |
| `AMOS_AUDIT_MAX_BYTES` | int | `5_000_000` | `→ 5MB` | 单个审计文件上限 |
| `AMOS_AUDIT_KEEP` | int | `3` | `→ 3` | 审计文件保留数 |
| `AMOS_AUDIT_MAX_ENTRIES` | int | `10000` | `→ 10000`（非 Unicode 告警一次后回退） | 审计条目上限 |

---

## 3. 守护进程日志(amos-ai)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_LOG` | enum | `info` | `→ info` | tracing level:`off`/`0`/`debug`/`info`/`warn`/`error` |
| `AMOS_LOG_DIR` | path | `~/.amos/logs` | `→ mkdir-p` | 日志落盘目录;设为 `off`/`none`/`0` 关闭文件 sink |
| `AMOS_LOG_MAX_BYTES` | int | `5_242_880` | `→ 5MB` | 单文件大小上限(行边界才轮转) |
| `AMOS_LOG_KEEP` | int | `3` (max 64) | `→ 3` | 保留历史日志数 |
| `AMOS_LOG_JSON` | bool | (未设置) | `→ sink-off` | JSON 行 sink 的**显式 opt-in**；未设置 / `0` / `false` ⇒ **关闭**（第二个 sink 把事件悄悄发到远端＝本项目专门审计的隐形外泄形状）。路径仍随 `AMOS_LOG_DIR` |
| `AMOS_LOG_SERVICE` | string | `amos-ai` | `→ amos-ai` | 每条 JSON 记录上的 `service` 标签（截断到 128 B；空串按未设置处理） |
| `AMOS_LOG_HOST` | string | `gethostname()` | `→ gethostname` | 可选的 hostname / pod 名覆盖（截断到 128 B；取不到主机名时为 `unknown`） |

---

## 4. 推理性能监控(amos-ai)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_METRICS_INTERVAL_SECS` | int | `10` | `→ 10` | 性能指标采样间隔 |
| `AMOS_ENERGY_LEVEL_PCT` | int | (none) | `→ probe` | 电池电量阈值(%) |
| `AMOS_ENERGY_POWER_MW` | int | (none) | `→ probe` | 功率阈值(mW) |
| `AMOS_ENERGY_TEMP_C` | int | (none) | `→ probe` | 温度阈值(°C) |
| `AMOS_ENERGY_CHARGING` | bool | `false`(保守) | `→ on-battery` | 是否在充电。**严格读**：`1`/`true`/`yes`/`on`=真,`0`/`false`/`no`/`off`=假,**其余(含空串与笔误)一律视为未设置**并 `WARN` 一次(REQ-A533) |
| `AMOS_ENERGY_SCREEN_ON` | bool | `true`(保守) | `→ screen-on` | 屏幕是否点亮。同上的严格读;`AMOS_SCREEN_STATE_PATH` 的文件契约优先于本开关 |
| `AMOS_ENERGY_FOREGROUND_HEAVY` | bool | `false` | `→ no-hint` | 是否前台重负载。同上的严格读 |
| `AMOS_ENERGY_INFERENCE_ACTIVE` | bool | `false` | `→ no-hint` | 是否正在推理。同上的严格读 |

---

## 5. 电源与 DVFS(amos-power)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_CPUFREQ_ROOT` | path | `/sys/devices/system/cpu/cpufreq` | `→ kernel-default` | cpufreq 暴露路径(用于写 `scaling_max_freq`) |
| `AMOS_CPUFREQ_NPU_NODES` | path | (none) | `→ skip-npu-cap` | NPU frequency 节点路径 |
| `AMOS_CPUFREQ_NPU_MAX_KHZ` | int | (none) | `→ skip` | NPU 上限频率 |
| `AMOS_SOC_VENDOR` | enum | (auto) | `→ generic` | SoC 厂商标识:`qcom`/`mediatek`/`unisoc`/... |

---

## 6. 翻译后端(amos-translate)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_TRANSLATE_SOCKET` | path | `/tmp/amos-translate.sock` | `→ default` | 翻译 daemon UDS 路径 |
| `AMOS_TRANSLATE_BACKEND` | enum | `mock` | `→ mock` | 翻译后端选择 |
| `AMOS_TRANSLATE_HOST` | url | (none) | `→ backend-default` | 翻译 API 地址 |
| `AMOS_TRANSLATE_MODEL` | string | (none) | `→ backend-default` | 翻译模型 |
| `AMOS_TRANSLATE_API_KEY` | secret | - | `→ no-auth` | 翻译 API 鉴权 |
| `AMOS_TRANSLATE_SOURCE` | lang | (none) | `→ auto` | 源语言 |
| `AMOS_TRANSLATE_TARGET` | lang | (none) | `→ auto` | 目标语言 |

---

## 7. 语音(amos-asr / amos-tts)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_SHERPA_MODEL_DIR` | path | (none) | `→ no-sherpa` | sherpa-onnx 模型目录 |
| `AMOS_PIPER_MODEL_DIR` | path | (none) | `→ no-piper` | Piper TTS 模型目录 |
| `AMOS_ASR_BACKEND` | enum | (none) | `→ 默认识别器`（集合外值告警一次后回退） | ASR 后端:`off`/`none`/`disabled`/`sherpa`/`mock`（未设静默；拼错 ∕ 空白 ∕ 非 Unicode 报告一次） |
| `AMOS_ASR_ENDPOINT` | url | (none) | `→ mock` | ASR 服务地址 |
| `AMOS_ASR_MODEL` | string | (none) | `→ mock` | ASR 模型 |
| `AMOS_ASR_API_KEY` | secret | - | `→ no-auth` | ASR 鉴权 |

---

## 8. 机器人中间件(amos-link)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_LINK_PEER` | string | `amos-node`（`bench`/`watch`/`motor` 各有默认） | `→ cli-default` | 本节点 peer 标识(仅 CLI 读取, `--peer` 优先) |
| `AMOS_LINK_ENDPOINT` | url 列表 | (none) | `→ no-address` | **本节点广播的地址**(逗号分隔; 仅 `watch`/`discover --lan\|--bus` 读取, `--endpoint` 优先)。留空 = 不广播地址; 界与信标同源(≤8 项、每项 ≤128 字节、整帧 ≤512 字节), 越界在启动期拒绝 |
| `AMOS_LINK_BEACON_ADDR` | url | `239.255.42.99:7446` | `→ default-mcast` | UDP 多播发现地址 |
| `AMOS_LINK_BEACON_IFACE` | string | (none) | `→ kernel-pick` | 绑定多播的网卡接口(多 NIC 必填) |
| `AMOS_LINK_BEACON_LOOP` | bool | (平台默认, 通常开) | `→ kernel-default` | 是否启用多播回环(开发期 `0` 关; 关掉会让**本机所有进程**都收不到自己的信标) |
| `AMOS_LINK_ZENOH_ENDPOINT` | url | (none) | `→ bus-only` | Zenoh inter-board 端点 |

---

## 9. Android 集成(amos-android / amos-tauri)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_ANDROID_RUNTIME` | enum | `mock` | `→ mock` | Android 运行时:`mock`/`waydroid`/`real` |
| `AMOS_ANDROID_CACHE_SIZE` | int | `256` | `→ 256` | APK 缓存条目数 |
| `AMOS_ANDROID_ICON_CACHE_SIZE` | int | `512` | `→ 512` | 图标缓存条目数 |
| `AMOS_ANDROID_ICON_TIMEOUT` | duration | `30s` | `→ 30s` | 图标提取超时 |
| `AMOS_ANDROID_INSTALL_TIMEOUT` | duration | `180s` | `→ 180s` | APK 安装超时 |
| `AMOS_ANDROID_LAUNCH_TIMEOUT` | duration | `30s` | `→ 30s` | APK 启动超时 |
| `AMOS_ANDROID_LIST_TIMEOUT` | duration | `30s` | `→ 30s` | APK 列表超时 |
| `AMOS_DEVCARE_ROOT` | path | (none) | `→ refuse-clean` | DevCare 主机根目录(root 部署时) |
| `AMOS_HOST_FS_ROOT` | path | (none) | `→ refuse-all` | `host_fs_*` 命令允许的根目录(启动期取一次、强校验)。未设/空 ⇒ 每个命令都 `amos.host_fs.root_not_configured`(最常见的失败,不是「路径太短」);设置了但不存在 ⇒ `root_not_found`;设置成非目录 ⇒ `root_not_a_dir` |
| `AMOS_SCREEN_STATE_PATH` | path | (none) | `→ in-memory` | 屏幕状态文件(amoS-display) |
| `AMOS_STATE_FILE` | path | (none) | `→ in-memory` | 通用状态文件 |
| `AMOS_GUEST_CLIPBOARD_SOCKET` | path | (none) | `→ no-guest-link`（非 Unicode 告警一次后按 inert） | 容器剪贴板通道;未设 ∕ 空白静默 inert;设了但读不回(非 Unicode)报告一次后仍 inert——状态据此区分「未设置」与「设了但读不回」(REQ-A1995) |

---

## 10. 容器与应用商店

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_APPSTORE_REGISTRY` | url | (none) | `→ empty` | App 仓库注册表 URL |
| `AMOS_APPSTORE_CATALOG` | path | (none) | `→ no-catalog` | 本地 catalog JSON |
| `AMOS_APPSTORE_INSTALL_DIR` | path | (none) | `→ refuse-install` | APK 安装目录 |
| `AMOS_PWA_INDEX_DIR` | path | (none) | `→ no-pwa` | PWA 索引目录 |
| `AMOS_PWA_REMOTE_ALLOW` | list | (none) | `→ refuse-remote` | 远程 PWA 清单允许的主机白名单（逗号分隔、全限定小写、无通配符；未设 = 不放行任何主机） |
| `AMOS_EXPORT_DIR` | path | (none) | `→ refuse-export` | F-Droid 导出目录 |

---

## 11. 媒体与系统

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_MEDIA_ROOT` | path | (none) | `→ empty` | 媒体文件根目录 |
| `AMOS_MAIL_STORE` | path | (none) | `→ empty` | 邮件存储路径 |
| `AMOS_FORM_FACTOR` | enum | `auto` | `→ auto` | 形态因子:`auto`/`desktop`/`mobile` |
| `AMOS_ROOT` | path | (none) | `→ cwd` | 应用根目录 |
| `AMOS_DESKTOP_SHORTCUTS` | enum | `enabled` | `→ enabled` | 系统快捷键(`⌘W` / `⌘M` / `⌘H` / `⌘,`)作用于焦点窗口的开关:`enabled`(默认)/`disabled`(也接受 `shortcuts` 列表写法)。`disabled` ⇒ `DesktopShell.handleSystemShortcut` 与 `DesktopWindowKeys` 直接返回,焦点窗口仍可关,但**前端不抢键**(适合 WebView/宿主 OS 已经接管的场景,如 macOS 真机上的 `⌘H`)。**读取方是宿主**(`crates/amos-tauri/src/desktop_features.rs`,启动时解析并在 boot 日志里如实上报);UI 侧的答案缓存是 **per-WebView 的模块状态**,所以**每一个桌面壳面各自取一次**(启动器 `DesktopShell`、应用窗口 `DesktopAppWindow` —— REQ-A453 修掉的就是「只有启动器问过」⇒ 该开关在应用窗口里曾经完全不生效) —— WebView 里没有环境变量可读(REQ-A287),每个变量只管自己那一个能力,把另一个能力键写进来不会生效但在 boot 日志里有 warning | 
| `AMOS_DOCK_CONTEXT_MENU` | enum | `enabled` | `→ enabled` | Dock 右键菜单开关:`enabled`(默认)/`disabled`(也接受 `dock-context-menu` 列表写法)。`disabled` ⇒ Dock 的 `oncontextmenu` 不弹 `DockContextMenu`(调试 / 自动化截图时用)。读取方/上报方式同上(REQ-A287) |
| `AMOS_WEBMAN_DOWNLOAD_DIR` | path | (none) | `→ 平台 Downloads` | WebMan(浏览器)下载落盘目录覆盖。空串按**未设置**处理(不落 `""`);未设时 `dirs::download_dir()` → `$HOME/Downloads` → `temp_dir/amos-downloads`。读取点:`crates/amos-tauri/src/webman_download.rs::download_dir` |
| `AMOS_WEBMAN_PROFILE` | path | (none) | `→ 平台 data_dir/amos/webman` | WebMan cookie jar 持久化目录覆盖。空串按**未设置**处理;未设时 `dirs::data_dir()/amos/webman` → `temp_dir/amos-webman`。读取点:`crates/amos-tauri/src/webman_download.rs::profile_dir` |
| `AMOS_OTA_MANIFEST_PATH` | path | (none) | `→ unconfigured` | 系统更新(OTA)清单 JSON 文件路径。**未设置 ⇒ 桥接处于未配置态**,`ota_check` 如实返回 `kind:"unconfigured"`(不是伪造的"已是最新");文件不可读/超 4 MiB/非法 JSON ⇒ `kind:"unreachable"`。读取点:`crates/amos-tauri/src/ota.rs::Source::from_env` |
| `AMOS_OTA_CHANNEL` | enum | `stable` | `→ stable` | 更新通道:`stable`/`beta`(未知值按 `stable`)。决定策略(`UpdatePolicy`)与清单里可选的包。读取点:`crates/amos-tauri/src/ota.rs::channel_from_env` |
| `AMOS_OTA_DEVICE_ID` | string | `amos-device` | `→ amos-device` | 本机灰度 id(cohort 分桶)。空串/未设 ⇒ 用确定性的默认 id。读取点:`crates/amos-tauri/src/ota.rs::device_id_from_env` |
| `AMOS_OTA_IMAGE_PATH` | path | (none) | `→ failed("no update image configured …")` | 本机可**下载并校验**的更新镜像文件路径(REQ-A1455)。未设置 ⇒ `ota_install` 不伪造成功:状态落 `failed`、`fail_reason` 点名本变量。文件不可读/超过包体积上界(8 GiB) ⇒ 同上 `failed`。镜像实长与清单 `size_bytes` 不符 ⇒ 如实区分「截断」与「超长」两种原因。**落点是 `staged`(已下载并校验,重启后生效),不是「已安装」**——写入镜像与重启仍由运行时负责。读取点:`crates/amos-tauri/src/ota.rs::Source::from_env` / `FileUpdateProvider::fetch_package` |
| `AMOS_OTA_TRUST_KEYS` | list | (none) | `→ 全不信任` | 本机信任的签名 key id,逗号分隔(REQ-A1455)。仅用于记录签名结论;**不是**安装闸门——是否要求签名由清单策略(`require_signature`)决定。**这是弱的一半**:只有 id ⇒ 走策略型校验(`TrustingVerifier`,只比对 id 与签名形状、**不做密码学**)。读取点:`crates/amos-tauri/src/ota.rs::trust_from_env` → `TrustConfig::parse` |
| `AMOS_OTA_TRUST_KEY_HEX` | list | (none) | `→ 退化为仅按 id 匹配` | 受信 Ed25519 **公钥**,`key_id:公钥hex` 逗号分隔(REQ-A1496)。**设了 ≥1 对 ⇒ 真验签**(RFC 8032),`OtaSignatureReport.verified_by` 报 `ed25519`;否则报 `policy`(只比对 id、无密码学,`amos-ota` 明写 not a security boundary)。`trusted` 的含义随此字段而变,故它随裁决一起上信道。格式错(无冒号/hex 非法)⇒ 安装落 `idle` 并在 `detail` 点名本变量,**绝不**静默退化到 `policy`——那正是本变量要防住的过度声称。读取点:`crates/amos-tauri/src/ota.rs::trust_from_env` → `TrustConfig::{parse,verifier}` |

---

## 12. 网络与守护

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_NTP_SERVER` | url | (未设置) | `→ 离线 HostClock` | NTP 校时服务器。**未设置 ⇒ 用离线 `HostClock`**(只记宿主时间、不做校准),**不是**某个公共池;设了才走真实 SNTP(特性 `ntp`)。读取点:`crates/amos-supervisor/src/lib.rs::TimeSyncConfig::from_env` |
| `AMOS_TIMESYNC` | bool | (未设置) | `→ off` | 是否武装周期校时(特性 `timesync`)。truthy `1`/`true`/`yes`/`on`,falsy `0`/`false`/`no`/`off`;未设与 falsy **静默** off,**两集之外的存在值** ⇒ off 且 `warn!` 一次(与 `energy::parse_flag` ∕ 播客 live 闸同一约定)。读取点:`…::decide_enabled` |
| `AMOS_TIMESYNC_STATE` | path | `~/.amos/timesync.json` | `→ 同默认` | 上次校准偏移的落盘位置(`$HOME/.amos/timesync.json`;无 `HOME` 时 `.amos-timesync.json`),并导出给被监管的子进程。**不是**内存态。读取点:`…::default_state_file` |
| `AMOS_TIMESYNC_INTERVAL_SECS` | int | `3600` | `→ 3600` | 两次校准的间隔(秒),默认 **1 小时**(`DEFAULT_INTERVAL`)。非数值 ∕ 非 Unicode ⇒ `warn!` 后回落 3600;`0` 被夹到下限 `1s`(**不是**回落到默认 —— 「太小」的答案是下限)。读取点:`…::decide_interval` |
| `AMOS_NETGUARD_STATE_PATH` | path | (none) | `→ in-memory`（空白 ∕ 非 Unicode 告警一次后回退） | 网络守卫 armed 意图 + 声明注册表的落盘路径（未设 ⇒ 纯内存，静默；空白 ∕ 非 Unicode 报告一次）。读取点:`crates/amos-ai/src/netguard_service.rs::state_path_from_env` |
| `AMOS_NETGUARD_ALLOW_INJECT` | bool | `0` | `→ observed-only`（集合外值告警一次后回退） | 是否允许注入 netguard 状态（未设静默；拼错 ∕ 空白 ∕ 非 Unicode 报告一次） |
| `AMOS_SPY_IFACE` | string | (none) | `→ all-ifaces` | 抓包接口 |
| `AMOS_SPY_LAYER3` | bool | (none) | `→ L2-default` | 抓包是否下沉到 L3(`rmnet`-style IPv4 接口);**严格读**:truthy `1`/`true`/`yes`/`on`、off `0`/`false`/`no`/`off`;未设置按 L2 处理(静默),两个集合之外的值(含空串与笔误)**按 L2 处理并 `warn!`** —— 它不只是开关,还是 L2/L3 取帧的选择,无声读成 L2 会让抓包恰好漏掉操作员要的那些包(REQ-A1903) |
| `AMOS_SPY_IDS` | string | (none) | `→ match-nothing` | 间谍关注 ID 列表(逗号分隔) |
| `AMOS_SPY_ALLOW_INJECT` | bool | `0` | `→ observed-only`（集合外值告警一次后回退） | 是否允许注入遥测事件（未设静默；拼错 ∕ 空白 ∕ 非 Unicode 报告一次） |

---

## 13. 端到端测试 ENV(`tests/` 与 `examples/`)

> 这些 ENV 只在 e2e 测试与示例代码中读取,**不进入产品二进制**。
> 它们用于本地/CI 端的真后端联调,**未设置时默认跳过**对应测试。

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_GGML_E2E_MODEL` | path | (空) | `→ skip` | 真机 GGML e2e 用的 GGUF 模型路径;为空则跳过 `ggml_command_e2e` |
| `AMOS_OLLAMA_E2E_MODEL` | string | (空) | `→ skip` | 真机 Ollama e2e 用的 chat 模型 id;为空则跳过 `ollama_*_e2e` |

---

## 14. RAG(amos-vector-db)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_RAG_STATE` | path | (none) | `→ in-memory`（空 ∕ 非 Unicode 值告警一次后同样回退） | 向量索引持久化路径 |
| `AMOS_RAG_DIM` | int | `384` | `→ 384` | 嵌入维度 |
| `AMOS_RAG_EMBEDDER` | enum | `mock` | `→ mock`（集合外值告警一次后回退） | 嵌入器:`mock`/`ollama`/`api`（未设静默；拼错 ∕ 空 ∕ 非 Unicode 报告一次） |
| `AMOS_RAG_EMBED_BASE` | url | `https://api.openai.com/v1` | `→ https://api.openai.com/v1`（空 ∕ 非 Unicode 值告警一次后回退） | `api` 嵌入器基址(OpenAI 兼容 `/embeddings`) |
| `AMOS_RAG_EMBED_MODEL` | string | `bge-m3` ∕ `text-embedding-3-small` | `→ bge-m3` ∕ `→ text-embedding-3-small`（空 ∕ 非 Unicode 值告警一次后回退） | 嵌入模型名(`ollama` ∕ `api`) |
| `AMOS_OLLAMA_HOST` | url | `http://localhost:11434` | `→ http://localhost:11434`（RAG:空 ∕ 非 Unicode 值告警一次后回退） | RAG `ollama` 嵌入器复用该地址 |
| `AMOS_OLLAMA_API_KEY` | secret | - | `→ no-auth`（空 ∕ 非 Unicode 值告警一次后不发送） | RAG `ollama` 嵌入器复用该 token |
| `AMOS_API_KEY` | secret | - | `→ 空串`（非 Unicode 值告警一次） | RAG `api` 嵌入器的 bearer |

---

## 15. 系统治理(governor)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_GOVERNOR_CPU_KINDS` | string | (none) | `→ treat-uniform` | CPU kind 列表(逗号分隔) |
| `AMOS_GOVERNOR_MEMORY_PRESSURE` | int | (none) | `→ kernel-default` | 内存压力阈值(%) |
| `AMOS_GOVERNOR_MAINTENANCE` | enum | `off` | `→ off` | 维护窗口:`off`/`daily`/`weekly` |

---

## 16. 安全凭据

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_CRED_FILE` | path | `~/.amos/ai.key` | `→ mkdir-p` | 云端 AI key 落盘路径(0600) |

---

## 17. 其他(由 Rust crate 引用)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `RUST_LOG` | enum | (none) | `→ info` | tracing 级别(env_logger / tracing-subscriber 标准) |

---

## 18. 告警与分层配置(amos-notifier / amos-config)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_NOTIFIER` | bool | (未设置) | `→ sink-off` | 告警 sink 的**显式 opt-in**。truthy 集**恰好**是 `1`/`true`/`yes`/`on`(大小写无关、前后空白 trim)；off 集是 `0`/`false`/`no`/`off`。**未设置**与**两个集合内的值**都静默；**存在但两个集合之外**的值(笔误 `tru`/`enable`/`2`、空串或全空白、非 Unicode)一律**不 arm 且 `warn!`** —— 打错字不会意外开门,也**不再**把「操作员以为开了」读成无声的关闭(REQ-A1903)。读取点:`crates/amos-ai/src/notifier_sink.rs` |
| `AMOS_NOTIFIER_WEBHOOK` | list | - | `→ stderr-only` | 逗号分隔的 webhook URL 列表(空白 trim、空项跳过)。`https://` 与坏 scheme 的项被**拒绝并 warn**,不影响 daemon 启动；没有任何有效 URL 时仍装 stderr 兜底,所以「一个 `AMOS_NOTIFIER=1` 但没有 URL 的机器」也会落一行 |
| `AMOS_FEATURE_FLAGS_FILE` | path | `~/.amos/feature-flags.json` | `→ empty-set` | 运行时 feature flag 的本地文件。非空即覆盖默认路径；路径解析不出 / 文件缺失 / 文件损坏 ⇒ **空集**(fail-closed,绝不 fail-open)。读取点:`FeatureFlagSet::from_local()`(`AMOS_FEATURE_FLAGS_FILE` → `from_file`) |
| `AMOS_CONFIG_SYSTEM` | path | 平台默认(`/etc/amos/config.json`；macOS 为 `/Library/Application Support/amos/config.json`；Windows 为 `%ProgramData%\amos\config.json`) | `→ platform-default` | 分层配置的**系统层**文件路径覆盖 |
| `AMOS_CONFIG_USER` | path | `~/.amos/config.json` | `→ layer-absent` | 分层配置的**用户层**文件路径覆盖；`$HOME` 未设置或为空 ⇒ 该层**不存在**(不是空值) |
| `AMOS_CONFIG_RELOAD_SECS` | int | `60` | `→ 60s` | 热重载 worker 的 tick 间隔(秒)。非法 / 负数 / `0` 一律**拒绝并 warn** 后回落 60 —— 零间隔不是「更快重载」而是**无界忙循环**。读取点:`reload::interval_from_env()`(嵌入方把它交给 `Worker::spawn`) |
| `AMOS_INSTALL_ID` | string | (未设置) | `→ $AMOS_SOCKET → pid-<pid>` | 本机的 **per-install 标识**,用于把进程放进百分比发布(percent rollout)环。解析链:`AMOS_INSTALL_ID` → `AMOS_SOCKET` → `pid-<pid>`;**每段都 trim,空段跳过**(设成 `""` 不构成一个标识 —— 否则所有此类设备会落进同一个桶,而这正是该入口要避免的)。链尾保证返回非空,故 `percent` 规则总有一个桶可放。读取点:`amos-config/src/feature_flag.rs::default_install_id`(经 `FlagContext::for_this_process`) |

---

## 19. 播客(amos-podcast ∕ amos-tauri)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_PODCAST_LIVE` | bool | (未设置) | `→ offline-mock` | 真实 HTTP 抓取的**显式 opt-in**,且**只在** `podcast-live` 特性构建里被读取(默认构建忽略它,故默认 UI 构建触不到网络)。truthy 集**恰好**是 `1`/`true`/`yes`/`on`(大小写无关、前后空白 trim)、off 集是 `0`/`false`/`no`/`off`;未设置与两个集合内的值都静默,**存在但两个集合之外**的值(笔误 `enable`/`2`、空串或全空白、非 Unicode)一律**不 arm 且 `warn!`** —— 打错字或写 `false` 都不会意外把真实网络打开(REQ-A1906)。读取点:`crates/amos-tauri/src/podcast.rs::provider()` |
| `AMOS_PODCAST_DIR` | path | (未设置) | `→ 内存态` | 把该进程的**四个** store 同置此目录。未设置且无逐 store 覆盖 ⇒ 全部 store 只在内存(不写用户磁盘,除非被要求)。读取点:`amos-podcast/src/manager.rs::PodcastPaths::from_env`(经 `pick` 闭包读取,故本表由 REQ-A1906 补登记) |
| `AMOS_PODCAST_SUBSCRIPTIONS` | path | (未设置) | `→ ${AMOS_PODCAST_DIR}/subscriptions.json` | 订阅 store 的逐文件路径覆盖(优先于 `AMOS_PODCAST_DIR`) |
| `AMOS_PODCAST_LIBRARY` | path | (未设置) | `→ ${AMOS_PODCAST_DIR}/library.json` | 剧集库 store 的逐文件路径覆盖 |
| `AMOS_PODCAST_PROGRESS` | path | (未设置) | `→ ${AMOS_PODCAST_DIR}/progress.json` | 播放进度 store 的逐文件路径覆盖 |
| `AMOS_PODCAST_DOWNLOADS` | path | (未设置) | `→ ${AMOS_PODCAST_DIR}/downloads.json` | 下载登记 store 的逐文件路径覆盖 |

---

## 20. 使用说明

### 20.1 透明度原则

- **未设置 ≠ 0 / false**:很多变量"未设置"意为"自动探测",**不应被解读为关闭**
- **`true`/`1`**:接受 Rust 标准布尔解析
- **持续时间**:`30s`/`5m`/`1h` 等,内部以 `humantime` 或 `Duration` 直接解析
- **路径相对性**:相对路径以 `cwd` 为基准,生产部署建议使用绝对路径

### 20.2 安全相关(高敏感)

下列变量涉及**认证或权限**,改动前需明确**新的失效语义**:

- `AMOS_TCP_TOKEN` — 改空 ⇒ 服务**仍开放**但启动 warn
- `AMOS_UDS_PEER` — 改 `require` ⇒ 异用户/无法问到的连接**直接拒绝**
- `AMOS_TCP_ALLOW_REMOTE` — 设为 `1` ⇒ 可绑定非环回,**唯一保护 = token**
- `AMOS_CRED_FILE` — 改路径 ⇒ 旧路径下的 0600 文件**不会被自动清理**
- `AMOS_API_KEY` / `AMOS_ASR_API_KEY` / `AMOS_OLLAMA_API_KEY` — 出现在云端请求,**切勿写入日志**

### 20.3 自动生成

本文档由 `scripts/env-doc-gen.mjs` 从代码扫描生成。运行时行为以代码为准。
