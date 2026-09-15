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
| `AMOS_MODEL_PATH` | path | - | `→ ggml-skip` | GGML 模型文件路径 |
| `AMOS_GGML_BIN` | path | - | `→ ggml-skip` | GGML 二进制路径 |
| `AMOS_GGML_MODEL` | path | - | `→ ggml-skip` | GGML 模型 |
| `AMOS_GGML_STRICT` | bool | `0` | `→ best-effort` | 设为 `1` 时,真实引擎不可用即**拒绝启动**,不降级到 mock |
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
| `AMOS_UDS_PEER` | enum | `enforce` | `→ warn` | UDS peer 凭据校验:`enforce`(默认)/`warn`/`require` |
| `AMOS_MAX_SESSIONS` | int | `16` | `→ 16` | 生成准入池容量(`GenerationPool`,0 不可表示) |
| `AMOS_GEN_POOL_WAIT_MS` | int | `0` | `→ fail-fast` | 池满时是否等待(0 = fail-fast) |
| `AMOS_RESPONSE_CACHE` | bool | `0` | `→ disabled` | 是否启用响应缓存(进程内,重启即空) |
| `AMOS_SESSION_TIMEOUT_SECS` | int | `3600` | `→ 3600` | 会话超时 |
| `AMOS_SESSIONS_PATH` | path | (回退) | - | 会话持久化文件 |
| `AMOS_RATE_LIMIT_RPS` | int | `10` | `→ 10` | 每客户端请求速率上限 |
| `AMOS_RATE_LIMIT_TPH` | int | `1000` | `→ 1000` | 每客户端每小时配额 |
| `AMOS_BREAKER` | bool | `1` | `→ enabled` | 后端熔断器开关 |
| `AMOS_BREAKER_FAILS` | int | `5` | `→ 5` | 熔断器失败阈值 |
| `AMOS_BREAKER_COOLDOWN_SECS` | int | `30` | `→ 30` | 熔断器冷却时间 |
| `AMOS_PRIVACY_PATH` | path | `~/.amos/privacy.jsonl` | `→ mkdir-p` | 隐私审计落盘 |
| `AMOS_AUDIT_PATH` | path | `~/.amos/audit.jsonl` | `→ mkdir-p` | 通用审计落盘 |
| `AMOS_AUDIT_MAX_BYTES` | int | `5_000_000` | `→ 5MB` | 单个审计文件上限 |
| `AMOS_AUDIT_KEEP` | int | `3` | `→ 3` | 审计文件保留数 |
| `AMOS_AUDIT_MAX_ENTRIES` | int | `10000` | `→ 10000` | 审计条目上限 |

---

## 3. 守护进程日志(amos-ai)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_LOG` | enum | `info` | `→ info` | tracing level:`off`/`0`/`debug`/`info`/`warn`/`error` |
| `AMOS_LOG_DIR` | path | `~/.amos/logs` | `→ mkdir-p` | 日志落盘目录;设为 `off`/`none`/`0` 关闭文件 sink |
| `AMOS_LOG_MAX_BYTES` | int | `5_242_880` | `→ 5MB` | 单文件大小上限(行边界才轮转) |
| `AMOS_LOG_KEEP` | int | `3` (max 64) | `→ 3` | 保留历史日志数 |

---

## 4. 推理性能监控(amos-ai)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_METRICS_INTERVAL_SECS` | int | `10` | `→ 10` | 性能指标采样间隔 |
| `AMOS_ENERGY_LEVEL_PCT` | int | (none) | `→ probe` | 电池电量阈值(%) |
| `AMOS_ENERGY_POWER_MW` | int | (none) | `→ probe` | 功率阈值(mW) |
| `AMOS_ENERGY_TEMP_C` | int | (none) | `→ probe` | 温度阈值(°C) |
| `AMOS_ENERGY_CHARGING` | bool | (none) | `→ probe` | 是否在充电 |
| `AMOS_ENERGY_SCREEN_ON` | bool | (none) | `→ probe` | 屏幕是否点亮 |
| `AMOS_ENERGY_FOREGROUND_HEAVY` | bool | (none) | `→ probe` | 是否前台重负载 |
| `AMOS_ENERGY_INFERENCE_ACTIVE` | bool | (none) | `→ probe` | 是否正在推理 |

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
| `AMOS_ASR_BACKEND` | enum | (none) | `→ mock` | ASR 后端 |
| `AMOS_ASR_ENDPOINT` | url | (none) | `→ mock` | ASR 服务地址 |
| `AMOS_ASR_MODEL` | string | (none) | `→ mock` | ASR 模型 |
| `AMOS_ASR_API_KEY` | secret | - | `→ no-auth` | ASR 鉴权 |

---

## 8. 机器人中间件(amos-link)

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_LINK_PEER` | string | (随机生成) | `→ random` | 本节点 peer 标识 |
| `AMOS_LINK_BEACON_ADDR` | url | `239.0.0.1:7447` | `→ default-mcast` | UDP 多播发现地址 |
| `AMOS_LINK_BEACON_IFACE` | string | (none) | `→ kernel-pick` | 绑定多播的网卡接口(多 NIC 必填) |
| `AMOS_LINK_BEACON_LOOP` | bool | `1` | `→ kernel-default` | 是否启用多播回环(开发期 `0` 关) |
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
| `AMOS_SCREEN_STATE_PATH` | path | (none) | `→ in-memory` | 屏幕状态文件(amoS-display) |
| `AMOS_STATE_FILE` | path | (none) | `→ in-memory` | 通用状态文件 |
| `AMOS_GUEST_CLIPBOARD_SOCKET` | path | (none) | `→ no-guest-link` | 容器剪贴板通道 |

---

## 10. 容器与应用商店

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_APPSTORE_REGISTRY` | url | (none) | `→ empty` | App 仓库注册表 URL |
| `AMOS_APPSTORE_CATALOG` | path | (none) | `→ no-catalog` | 本地 catalog JSON |
| `AMOS_APPSTORE_INSTALL_DIR` | path | (none) | `→ refuse-install` | APK 安装目录 |
| `AMOS_PWA_INDEX_DIR` | path | (none) | `→ no-pwa` | PWA 索引目录 |
| `AMOS_EXPORT_DIR` | path | (none) | `→ refuse-export` | F-Droid 导出目录 |

---

## 11. 媒体与系统

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_MEDIA_ROOT` | path | (none) | `→ empty` | 媒体文件根目录 |
| `AMOS_MAIL_STORE` | path | (none) | `→ empty` | 邮件存储路径 |
| `AMOS_FORM_FACTOR` | enum | `auto` | `→ auto` | 形态因子:`auto`/`desktop`/`mobile` |
| `AMOS_ROOT` | path | (none) | `→ cwd` | 应用根目录 |

---

## 12. 网络与守护

| 变量 | 类型 | 默认 | 失效语义 | 说明 |
|------|------|------|----------|------|
| `AMOS_NTP_SERVER` | url | `pool.ntp.org` | `→ best-effort` | NTP 校时服务器 |
| `AMOS_TIMESYNC` | enum | (none) | `→ best-effort` | 时间同步策略 |
| `AMOS_TIMESYNC_STATE` | path | (none) | `→ in-memory` | 时间同步状态文件 |
| `AMOS_TIMESYNC_INTERVAL_SECS` | int | `600` | `→ 600` | 时间同步间隔 |
| `AMOS_NETGUARD_STATE_PATH` | path | (none) | `→ in-memory` | 网络守卫状态 |
| `AMOS_NETGUARD_ALLOW_INJECT` | bool | `0` | `→ observed-only` | 是否允许注入 netguard 状态 |
| `AMOS_SPY_IFACE` | string | (none) | `→ all-ifaces` | 抓包接口 |
| `AMOS_SPY_LAYER3` | bool | (none) | `→ L2-default` | 抓包是否下沉到 L3(`rmnet`-style IPv4 接口);未设置按 L2 处理 |
| `AMOS_SPY_IDS` | string | (none) | `→ match-nothing` | 间谍关注 ID 列表(逗号分隔) |
| `AMOS_SPY_ALLOW_INJECT` | bool | `0` | `→ observed-only` | 是否允许注入遥测事件 |

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
| `AMOS_RAG_STATE` | path | (none) | `→ in-memory` | 向量索引持久化路径 |
| `AMOS_RAG_DIM` | int | `384` | `→ 384` | 嵌入维度 |
| `AMOS_RAG_EMBEDDER` | enum | `mock` | `→ mock` | 嵌入器:`mock`/`ollama` |
| `AMOS_RAG_EMBED_BASE` | url | (none) | `→ fail` | Ollama embed URL |
| `AMOS_RAG_EMBED_MODEL` | string | (none) | `→ fail` | 嵌入模型名 |

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

## 18. 使用说明

### 17.1 透明度原则

- **未设置 ≠ 0 / false**:很多变量"未设置"意为"自动探测",**不应被解读为关闭**
- **`true`/`1`**:接受 Rust 标准布尔解析
- **持续时间**:`30s`/`5m`/`1h` 等,内部以 `humantime` 或 `Duration` 直接解析
- **路径相对性**:相对路径以 `cwd` 为基准,生产部署建议使用绝对路径

### 17.2 安全相关(高敏感)

下列变量涉及**认证或权限**,改动前需明确**新的失效语义**:

- `AMOS_TCP_TOKEN` — 改空 ⇒ 服务**仍开放**但启动 warn
- `AMOS_UDS_PEER` — 改 `require` ⇒ 异用户/无法问到的连接**直接拒绝**
- `AMOS_TCP_ALLOW_REMOTE` — 设为 `1` ⇒ 可绑定非环回,**唯一保护 = token**
- `AMOS_CRED_FILE` — 改路径 ⇒ 旧路径下的 0600 文件**不会被自动清理**
- `AMOS_API_KEY` / `AMOS_ASR_API_KEY` / `AMOS_OLLAMA_API_KEY` — 出现在云端请求,**切勿写入日志**

### 17.3 自动生成

本文档由 `scripts/env-doc-gen.mjs` 从代码扫描生成。运行时行为以代码为准。
