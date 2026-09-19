/**
 * localId.ts — 给"应用按 id 索引的记录"用的、抗碰撞的本地 id。
 *
 * 为什么有这个东西：有 7 个模块各自手写过
 * `` `audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` ``。在 JavaScriptCore
 * （Bun 的引擎）里 `Math.random().toString(36)` 输出的是**最短表示**，于是那个后缀可能只有
 * 一两个字符 —— 同一毫秒里创建的 10 条记录就会**撞 id**。
 * 实测（2026-09-17，REQ-A390）：`src/lib/__tests__/enterprise-audit.test.ts` 的
 * 「并发安全 > 应该处理并发日志记录」在整批运行时失败，原因就是两条审计记录共用一个 id，
 * 而账本的身份假设（id 唯一）被破坏。它不是偶发：机器一有负载就复现。
 *
 * 形状与原来一致（`<prefix>-<time36>-…`），所以断言前缀的调用方不受影响；真正保证唯一的是
 * 后面两段：
 *   1. **进程内单调计数器**（`seq`，回绕在 2^30，base36）—— 同一毫秒内也不可能重复；
 *   2. 零填充的随机尾巴（有 `crypto.getRandomValues` 就用它）。
 *
 * REQ-A401（2026-09-18）把它变成**这一族唯一的所有者**：联系人 / 测距 / 录像的 media key /
 * 浏览器 / 推送通知 / 自定义分组 / 快捷指令 / AI 会话与消息 / 通知中心行 / 快捷指令动作这 11 处
 * 全部委托给它（此前各自手写公式）。因为"时间 + 一把随机数字"的**唯一性只是算术运气**：
 * 冻结时钟下 5 位 base36 尾巴在 20,000 次紧循环里撞 3 次（实测，种子可复算），而撞了以后
 * **没有任何东西会报错**（录像字节被覆盖、通知按 id 去重后消失、流式 token 落进另一个气泡）。
 * 现在有两条门看着这一族：`scripts/idgen-scan.mjs` 的 R1（每个 `Math.random` 都要有写明理由的
 * 条目）与 R2（"id = 时钟 + 随机"一律失败、不可豁免），以及 `src/__tests__/idUniqueness.test.ts`
 * （冻结时钟 + 固定种子下每个生成器 2 万次，含"退役公式必须撞"的负控）。登记为 **F-DA-006**。
 *
 * REQ-A402（2026-09-18）把**另一半**也收了回来：`notes` / `reminders` / `calendar` / `voiceMemos` /
 * `time` 闹钟 / `messages` 会话这 6 处当时走的是 `${time36}-${seq}` —— 时间戳加一个**进程内**计数器，
 * **熵为零**。两个上下文在同一毫秒铸 id 会得到同一个字符串（实测：两个真进程 + 冻结时钟都产出
 * `loyw3v28-1`，而 `localId` 因下面第 2 段的 7 位随机尾而不同）—— 本仓的壳是多窗口共享一个 store
 * （`svelte/store.ts` 镜像主机的 `store-updated`），所以"进程内计数器"不是"store 内"的保证。
 * 撞了的后果全是静默的：`normalizeVoiceMemos` 丢行（录音消失、字节成孤儿）、
 * `normalizeConversations` 曾对同 id 不查重（删一个会话删掉两个）、`normalizeNotes`/`normalizeEvents`
 * 改名（引用全失效）。这 6 处现在也走这里；`idgen-scan` 的 **R3**（`id-from-clock`，不可豁免，
 * 按名豁免本文件）负责不让这一族再长出新成员。登记为 **F-DA-007**。
 *
 * 注意两者分工：**新记录的 id** 走这里（要新鲜、由构造唯一）；`normalize*` 里的**回填/修复 id**
 * 仍是"时间 + 序号"（要跨加载稳定），R3 明确不管它们。
 */
let seq = 0;

/** `crypto.getRandomValues` 可用就用它，否则退回 `Math.random`（都做零填充）。 */
function randomTail(): string {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0]!.toString(36).padStart(7, "0");
  }
  return Math.floor(Math.random() * 0xfffffff)
    .toString(36)
    .padStart(7, "0");
}

export function localId(prefix: string): string {
  seq = (seq + 1) % 0x40000000;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}-${randomTail()}`;
}
