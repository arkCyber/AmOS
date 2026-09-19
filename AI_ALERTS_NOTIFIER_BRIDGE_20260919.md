# AI 服务告警接通 amos-notifier (REQ-A449)

**会话**: 2026-09-19
**标准**: DO-178C (适航软件) + Aerospace-grade honesty
**状态**: ✅ 完成, 已提交 (24bc9703)

---

## 完成内容

### 缺陷

`amos-ai` 的 `alerts::AlertTracker` 只能算出"现在哪些条件成立", 但**没有外发路径**
(`alerts.rs` 模块文档明写 "there is **no delivery**"); 阈值告警对操作员**完全不可见**,
除非操作员在轮询 `get_status.alerts`。同一族缺陷的另一半已在 REQ-A444 (supervisor) 中
用 `amos-notifier` 接通了 —— AI 服务侧仍是空白。

### 修法 (三层)

1. **`notifier_bridge`** (值类型, 默认 build): `AlertBridge` 跟踪"上次活跃集", 仅在
   **状态转换** 时触发一次 sink —— 1 Hz 轮询 ≠ 1 Hz 告警。严重度映射
   `Error → P0` / `Warn → P1` 写在 `severity_to_p_level` 一处。
2. **`notifier_sink`** (`feature = "notifier"`): `NotifierSink` 把 bridge 与
   `amos_notifier::Dispatcher` 桥接, 同时附 `amos_severity` 标签保留**两端视角**
   (P-level 与 daemon 自身的 severity), 升级时操作员不丢上下文。
3. **`AiAgentService`** 接入: 新增 `with_notifier_bridge()`, `alerts_now()` 在现有
   `tracing!` 之外**额外**调用 `bridge.observe(&active)`, log 与 sink 不可能走偏。

### 测试覆盖 (24 个测试套件, 全部 0 失败)

| 测试层 | 文件 | 用例数 |
|--------|------|--------|
| 单元 | `notifier_bridge::tests` | 8 |
| 单元 | `notifier_sink::tests` (feature) | 3 |
| 端到端 | `tests/notifier_alerts_e2e.rs` | 8 |
| 集成 | `server::tests::get_status_drives_the_attached_*` | 1 |

`breaker.rs` 新增 `force_state_for_test` (`#[cfg(test)]`) 让恢复路径在测试里不需
等 wall-clock cooldown。

### 默认构建不增依赖

`notifier` feature 默认**仍关**; bridge 在 sink 为 `None` 时**纯 no-op**
(`debug_assert!(self.sink.is_some() || fired == 0)` 守门)。
默认 daemon 不拉 `amos-notifier`。

---

## 验收指标

| 指标 | 数值 |
|------|------|
| `cargo test -p amos-ai` lib (默认) | **321 / 321 通过** |
| `cargo test -p amos-ai` 全套件 (默认) | 24 套件 0 失败 |
| `cargo test -p amos-ai --features notifier` lib | **324 / 324 通过** |
| `cargo test -p amos-ai --features notifier` 全套件 | 24 套件 0 失败 |
| `cargo check -p amos-ai --lib` | 净, 0 警告 |
| `cargo check -p amos-ai --lib --features notifier` | 净, 0 警告 |
| FMEA 检查 | 147 条 (新增 F-AI-014/015) |

---

## FMEA 新增

- **F-AI-014**: AI 服务阈值告警只到 wire ⇒ 操作员不知 — 已收口 (RPN 27)。
- **F-AI-015**: 告警规则覆盖不全 ⇒ 治理动作无人察觉 — **登记为缺口**, 下一轮单独排查。

---

## 如实记录 (未做 / 边界)

1. **`with_notifier_bridge` 目前只在测试里调**, `main.rs` / `serve()` 仍未自动按
   `AMOS_NOTIFIER=1` 接通 —— "接线骨架已有, 自动布线仍是登记缺口" (同 REQ-A444
   supervisor 的 (b) 步同形)。
2. **`severity_to_p_level` 是**唯一**的 P-level 映射点**, `notifier_sink` **再抄一遍**
   (`p0` / `p1` 构造函数 + `amos_severity` 标签), 两边必须同步 —— 没有跨测断言钉这件事。
3. **真实告警通道 (webhook / SMTP) 的部署配置**仍由操作员完成 —— 本轮接通的是 bridge 这半。
4. **没有真机验证** (单元 + 集成 + 真实二进制路径, 不是操作员在环)。
5. `amos-supervisor` 与 `amos-ai` 的告警接线**两端各有 "no-op sink" 的机会**,
   `with_*` / 启动 wiring 仍需在 deploy 脚本里拨通。
