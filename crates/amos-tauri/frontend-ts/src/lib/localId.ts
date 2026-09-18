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
