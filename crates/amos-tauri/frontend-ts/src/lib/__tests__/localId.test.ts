/**
 * __tests__/localId.test.ts — `localId.ts` 的唯一性契约（REQ-A390）
 *
 * 这个文件存在的理由就是那次失败：`enterprise-audit.test.ts` 的并发用例断言 10 个日志
 * id 唯一，而旧写法（`Date.now() + Math.random().toString(36).substr(2, 9)`）在
 * JavaScriptCore 下后缀可能只有一两个字符 ⇒ 同一毫秒内撞 id。这里把"必须唯一"钉在
 * 最严的两个条件下：**冻结时钟**（同一毫秒）与**紧循环 20,000 次**。
 *
 * 不导入 happy-dom（保持 pure 批次，覆盖率计入 P2-1）。
 */
import { describe, test, expect } from "bun:test";
import { localId } from "../localId";

describe("localId", () => {
  test("形状仍是 <prefix>-<time36>-<seq36>-<7 位随机尾>，前缀可断言", () => {
    const id = localId("audit");
    const parts = id.split("-");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("audit");
    expect(parts[3]).toHaveLength(7);
  });

  test("紧循环 20,000 个 id 全唯一", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(localId("audit"));
    expect(seen.size).toBe(20000);
  });

  test("**同一毫秒**内创建的 id 也唯一（计数器兜底，不靠运气）", () => {
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000; // 冻结时钟：随机尾之外只剩计数器在区分
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 5000; i++) seen.add(localId("audit"));
      expect(seen.size).toBe(5000);
    } finally {
      Date.now = realNow;
    }
  });

  test("不同前缀互不干扰（同一进程里两个模块各生成自己的 id）", () => {
    const a = localId("webhook");
    const b = localId("event");
    expect(a).not.toBe(b);
    expect(a.startsWith("webhook-")).toBe(true);
    expect(b.startsWith("event-")).toBe(true);
  });
});
