/**
 * perfBudget.ts — 让「性能预算」这条断言测的是**代码**，而不是**这台机器此刻有多空**
 * （REQ-A850 / F-DEV-106）。
 *
 * 为什么需要它（不是假想，是实测）：本仓原有 22 条形如
 *
 *     const start = performance.now();
 *     <干活>
 *     const duration = performance.now() - start;
 *     expect(duration).toBeLessThan(N);
 *
 * 的断言。它们的问题不在阈值大小，而在**判据本身**：`performance.now()` 的差值是
 * 「干活」**加上**「这段时间里这台机器被别的进程抢走了多少 CPU」之和。
 *
 * 本轮把两台仪器放在**同一次运行、同一份负载**下交替跑同一件活（`encryptMDMData`，
 * 12 组样本，预算 50ms，40 个自旋进程压满 18 核）：
 *
 *     单次计时： min 18.59 / p50 36.04 / max **201.49**ms   ⇒ **4/12 组越过预算**
 *     取 K 次最小：min 10.90 / p50 20.53 / max  **40.90**ms   ⇒ **0/12 组越过预算**
 *
 * 也就是说这条断言当时的**单次翻红概率约三分之一**，红的含义是「刚才有人抢 CPU」，
 * 而不是「代码变慢了」——判决与它声称被测的对象无关。顺带纠正一个我自己先前的误判：
 * 这件活的真实代价是 **~11–21ms**，不是注释里想当然的 ~1ms ⇒ 它对 50ms 预算只有
 * **~2.5 倍**余量，本来就在刀锋上。于是：
 *
 *   * 红 ≠ 代码变慢 ⇒ 这条断言的判决不是关于代码的；
 *   * 于是 `bun run check` **不是确定性的**：绿的不能当证据（可能只是这次机器空），
 *     红的会被当成噪音重跑一遍 —— 而「重跑到绿为止」正是这类断言训练出来的习惯；
 *   * 直觉上的补救是**把 N 调大**，但那是在拿「抓得住真回归」换「不抖」，阈值越大越
 *     测不出东西，最后退化成一条永远绿的断言。
 *
 * 本轮的判据：**取 K 次尝试里的最小值**。理由是可证的，不是玄学：
 * 抢占只会给一次尝试**加上**时间，**永远不会让它变快** ⇒ 每一次尝试的耗时都是真实代价
 * 加上一个非负的噪声项，因此 `min` 随 K 增大**单调逼近**无负载时的真实代价。而真正的
 * 性能回归（比如不小心写成 O(n²)）会让**每一次**尝试都变慢 ⇒ `min` 同样抬起来，照样抓得住。
 *
 * 两个附带好处，都不是巧合：
 *   1. **热身被吸收进来了**：第一次尝试（JIT 还没编译、缓存还冷）本来就是最慢的那一次，
 *      取 min 时天然被丢掉，不需要再单写一个 warm-up 循环；
 *   2. **它只会把红变绿，不会把绿变红**：`min ≤ 任何一次尝试`，所以一条能过的断言调换
 *      成这个判据之后仍然能过 —— 下面的转换因此**不会**引入新的失败，也**没有**放宽
 *      任何阈值（22 条断言的 N 一位都没改）。
 *
 * 反过来说清楚它的**边界**：min-of-K 掩掉的是「小于噪声底」的回归。它把「这次机器忙不忙」
 * 从判据里去掉，但去不掉「这台机器本身比 CI 快/慢」—— 阈值仍然是一台机器上的绝对值。
 * 要跨机器可比，得改成与同一次运行内的基准工作量求比值，那是另一个量级的改动，本轮**未做**。
 *
 * 用法（保持在调用点就近，方便门禁 `perf-budget-scan` 绑定）：
 *
 *     const duration = fastest(PERF_ATTEMPTS, () => { <干活> });
 *     expect(duration).toBeLessThan(N);
 *
 * 若被计时的工作会改状态，把「重置」放进闭包内（见 `pushNotifications.test.ts` 的写法），
 * 这样第 K 次尝试与第 1 次测的是同一件事。
 */

/** 默认尝试次数。5 次足以穿过常见的抢占噪声，又不至于让慢操作把测试拖垮。 */
export const PERF_ATTEMPTS = 5;

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * 跑 K 次 `run`，返回**最快**那一次的毫秒数。
 * `run` 必须是可重复执行的：重复执行只允许改变它自己造出来的局部状态。
 */
export function fastest(attempts: number, run: () => void): number {
  const k = Math.max(1, Math.floor(attempts));
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < k; i++) {
    const start = now();
    run();
    const elapsed = now() - start;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

/** `fastest` 的异步版本：逐次 `await run()`，同样返回最小值。 */
export async function fastestAsync(
  attempts: number,
  run: () => Promise<unknown>,
): Promise<number> {
  const k = Math.max(1, Math.floor(attempts));
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < k; i++) {
    const start = now();
    await run();
    const elapsed = now() - start;
    if (elapsed < best) best = elapsed;
  }
  return best;
}
