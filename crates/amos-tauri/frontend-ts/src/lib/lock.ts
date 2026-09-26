/**
 * 锁屏密码的**边界**（REQ-A1131）—— 写在这里，因为这一条决定了下一步该往哪走。
 *
 * `LockCfg.pin` 存的是**明文口令**，而这是刻意的，不是欠账。两个看似"加固"的方向都被拒绝：
 *
 * 1. **存摘要（salt + hash / KDF）—— 是表演，不是加固。**
 *    ①本仓没有任何**同源的低权限读取方**：第三方应用跑在 `amos-app://<id>` 的 iframe 里、WebMan
 *    的远程页 iframe 刻意不带 `allow-same-origin`，所以没有"能读 store 但不能读别处"的攻击者；
 *    ②`amos.lock` 是 `SYNC_STORES` **之外**的配置键（见 `scripts/store-allowlist.json` 的
 *    `configuration` 一档），不进备份、不出本机；③能改这个键的攻击者只要写
 *    `{enabled:false}` 就进门了，摘要拦不住他；④4–6 位数字只有 10⁴–10⁶ 种，对任何非 KDF 的
 *    摘要都是瞬间穷举 —— 真正的 KDF 又会把锁屏变成每次开机几百毫秒的等待。所以摘要在这里
 *    只增加一件事：这份代码的解释成本。
 * 2. **错误次数锁定 / 退避 —— 在这里是危险的，不是安全。**
 *    本机**没有任何找回密码的途径**（没有任何写入 `amos.lock` 的重置路径，也没有恢复出厂），
 *    所以忘了密码的用户本来就只剩两条路：看着锁屏，或者清掉应用数据。加一个**无界**锁定就等于
 *    把"看着锁屏"也去掉，把门禁变成对用户自己数据的永久拒绝服务。把加固做成砖比不加固更坏。
 *
 * 于是这一层的确切定位是：**界面门禁**（挡住随手拿起设备的人），**不是保密边界**（本机不加密）。
 * 这句话必须由用户读到的界面自己说出来 —— `lock.passcodeHint`（LockPage）与
 * `src/__tests__/lock.test.ts` 的边界钉共同钉住它；`svelte-tests/lock-page-boundary.svelte.test.ts`
 * 盯着文案真的出现在页面上。
 */
export interface LockCfg {
  enabled: boolean;
  pin?: string;
}

export const LOCK_KEY = "amos.lock";

/** Lock-screen passcode policy (4–6 digits). */
export const PIN_MIN = 4;
export const PIN_MAX = 6;

/** Keep only digits, capped (default 6). */
export function sanitizePin(raw: string, max = PIN_MAX): string {
  return raw.replace(/\D/g, "").slice(0, max);
}

/** A typed PIN is acceptable only when it meets the 4–6 digit policy. */
export function validPin(raw: string): boolean {
  const n = sanitizePin(raw).length;
  return n >= PIN_MIN && n <= PIN_MAX;
}

/**
 * Build the config to persist from the toggle + entered digits + previous pin.
 *
 * Policy (aerospace-grade): the lock is only ever *enabled* with a usable
 * 4–6 digit passcode. Enabling without one (empty or too-short input and no
 * previous pin) is refused rather than producing an unlockable-less enabled
 * lock. Empty input keeps the previous valid pin.
 */
export function makeLock(enabled: boolean, pinRaw: string, prev: LockCfg): LockCfg {
  if (!enabled) return { enabled: false };
  const typed = sanitizePin(pinRaw);
  if (typed) {
    if (!validPin(typed)) {
      // Invalid new/changed pin: refuse the enable/change (keep current state).
      return prev.enabled && prev.pin ? { enabled: true, pin: prev.pin } : { enabled: false };
    }
    return { enabled: true, pin: typed };
  }
  // Nothing typed: reuse the previous pin if there was a valid one.
  if (prev.enabled && prev.pin) return { enabled: true, pin: prev.pin };
  // Enabling with no pin and no previous pin would leave the lock un-unlockable.
  return { enabled: false };
}
