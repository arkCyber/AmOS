# Amos 语义 UI 协议（Semantic UI / Structured Cards）

> 让底层 AI Agent **直接驱动界面**，而非只返回文本 —— 即参考架构中的
> "语义中枢 → 像素表面"。本文记录协议、数据流、扩展方式与安全约束。

## 一、为什么需要它

传统 App 的 UI 是写死的。在本架构里，AI Agent 在底层处理完本地数据 / Web3
信息后，需要以**结构化、可预测**的方式让前端刷新界面。我们定义了一个最小的
**结构化卡片协议**：AI 返回 `UiCard` 描述，前端按 `kind` 动态渲染成交互卡片。

当前实现基于确定性关键词意图引擎（`amos-ai/src/semantic.rs`）。将来接入真实
模型时，只需把 `detect()` 换成模型的 function-calling / JSON 输出，**协议与前
端完全不用改**。

## 二、数据流

```
[用户输入 AI 助手]
   │  chat_agent(prompt)
   ▼
[amos-ai daemon: Chat/StreamChat]
   ├─ semantic::detect(prompt) → Option<UiCard>
   ├─ 命中: 流式一句"✨ 已识别意图…" + 终止帧携带 UiCard
   └─ 未命中: 普通 token 流（card 为空）
   ▼  gRPC over UDS
[Tauri 桥 ai_bridge.rs]
   ├─ 终止帧含 card → 发事件 "ai-card-received" (CardPayload)
   └─ done → 发 "ai-session-complete" / "ai-chat-complete"
   ▼  Tauri 事件
[frontend-ts App.tsx / AiApp 订阅]  →  [AiApp: onAiCard → patchCur]
   ▼
[AiCardView(card)]  →  动态渲染交互卡片
```

## 三、协议定义（proto/ai_agent.proto）

```proto
message UiCard {
  string kind = 1;          // "weather" | "media" | "note" | "wallet" | "action" | ...
  string title = 2;
  string subtitle = 3;
  repeated UiField fields = 4;   // 键值行
  repeated string actions = 5;   // 动作按钮文案
}
message UiField { string key = 1; string value = 2; }

message AgentChunk {
  // ...
  UiCard card = 5;   // 终止帧上可携带一张结构化卡片（向后兼容新增）
}
```

`UiCard` 是向后兼容的新增字段：旧客户端忽略它，新客户端可选消费。

## 四、意图 → 卡片映射（semantic.rs 当前 MVP）

| 触发词（含） | 卡片 kind | 示例动作 |
|--------------|-----------|----------|
| 天气 / 气温 / 温度 | `weather` | 打开地图 |
| 播放 / 音乐 / 放歌 / 歌 | `media` | 打开音乐 |
| 笔记 / 记事 / 总结 | `note` | 打开笔记 |
| 钱包 / 余额 / 资产 / web3 | `wallet` | 打开设置 |
| 打开 / 启动 … | `action` | 打开音乐/地图/相机/相册… |

未命中 → `None` → 走普通文本流。

## 五、前端如何渲染（frontend-ts `AiCardView`）

- 按 `kind` 从 `CARD_COLORS` 选头部渐变色，渲染：标题 + 副标题 + 键值字段 + 动作按钮。
- 动作按钮显示为 chips（AI 输出即展示，不拉起系统应用）。
- 未知 `kind` 走通用样式兜底；`cardOf(payload)` 解析失败则不渲染。
- 新增卡片类型只需在 `frontend-ts/src/components/BackendApps.tsx` 的 `CARD_COLORS`
  加一个 `kind` 色值即可，无需改协议。

## 六、安全约束（重要）

- **XSS 安全**：卡片内容来自 daemon，前端统一用 `textContent`（`A.el` 追加
  字符串）渲染，**不拼接 innerHTML**。因此即使 daemon 返回 `<script>` 之类的
  文本，也只会被当作文本显示，不会执行。
- 动作按钮文案是白名单式映射到内置应用，不执行任意代码。
- 卡片本身经 `SecurityManager` 的请求级限流/审计（与普通 chat 相同）。

## 七、如何扩展一个新卡片类型

1. **后端**：在 `semantic.rs` 增加一个意图匹配 + 卡片构造函数（返回 `UiCard`）。
2. **前端**：在 `BackendApps.tsx` 的 `CARD_COLORS` 加一个 `kind` 色值（通用结构自动生效）；
   若需要专属动作，在 `runAction` 加映射。
3. **测试**：后端加 `semantic::tests` 单测 + `tests/*` 集成测试；前端加
   `frontend-ts` bun test 的卡片渲染断言。

## 八、测试覆盖

- 后端单测：`semantic::tests`（weather/media/wallet/action/None）。
- 集成测试：`chat_test.rs::bidi_chat_semantic_intent_returns_ui_card`、
  `rpc_test.rs::stream_chat_semantic_intent_returns_ui_card`（双向流 + 单向流）。
- 前端：`AiCardView` 动态渲染、AI 应用把收到的卡片渲染进对话流（`stream.ts cardOf`）。
