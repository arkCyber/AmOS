/**
 * numericField.ts — 「这一个数字框接受什么」的唯一判据（REQ-A821）
 *
 * 为什么这个文件存在：企业面板里每一个数字输入都写着 `parseInt(value) || <默认值>`。
 * 它把**三种不同的输入**折成同一个后果：
 *
 *   * 输入 `0` —— `parseInt("0")` 是 `0`，`0 || 1000` 是 `1000`：用户打了一个合法的
 *     `0`（在「重试次数」上这是**最该被接受**的值），模型里却被塞进默认值；
 *   * 输入空串 / `abc` —— `NaN || 1000` ⇒ 同样静默变成 `1000`；
 *   * 输入超过声明的 `max` —— 原样写入，**越界的值直接进模型并落盘**（声明了上限却
 *     没有一处强制它）。
 *
 * 三者的共同点是**屏幕上不出现任何字**：输入框用 `value={…}`（非 `bind:`）渲染，所以
 * 它继续显示用户打的那串字符，而系统持有的、会被保存的、会被下发到设备的是另一个数。
 * 用户看到 `0`、系统执行 `1000`，中间没有一句话。
 *
 * 这是**同一个家族**的老形状：一个面（这里是数字输入框）做出了代码兑现不了的声明
 * （「你输入的数就是生效的数」）。同族的今日先例是 REQ-A819（两个「测试连接」按钮）
 * 与 REQ-A806（`saveConfig`）。
 *
 * 判据是**判别式**而不是 boolean：界面要说清「为什么不收」，所以三种拒绝必须能分开。
 *
 * 取值范围**不在这里新写一遍**：`API_NUMERIC_RANGES`／`MDM_NUMERIC_RANGES` 是各面板
 * `min`／`max` 属性的**来源**，标记与判据读的是同一张表 —— 一个改了另一个不可能不变。
 */

/** 一个数字字段声明的取值范围（同时是 `min`／`max` 属性的来源）。 */
export interface NumericRange {
  readonly min: number;
  readonly max: number;
}

/** 「这个字段收下了吗」——不收的三个理由必须能分开，界面要逐个说清。 */
export type NumericFieldVerdict =
  | { ok: true; value: number }
  | { ok: false; reason: "not-integer"; range: NumericRange }
  | { ok: false; reason: "below-min"; range: NumericRange }
  | { ok: false; reason: "above-max"; range: NumericRange };

/**
 * 读一个数字框的内容。**只在完全合规时才收下**，任何其它情况都不给替代值
 * ——替代值正是原实现的病：用户打的字被换成一个他没写的数，且不留痕迹。
 *
 * 只收十进制整数：`1e5`／`0x10`／`12abc`／空串／`-` 都算 `not-integer`
 * （`type="number"` 的框允许前两种被键入或被粘贴）。前导 `+` 与前后空白照收。
 */
export function readBoundedInt(raw: string, range: NumericRange): NumericFieldVerdict {
  const text = raw.trim();
  if (!/^[+-]?\d+$/.test(text)) return { ok: false, reason: "not-integer", range };
  const value = Number.parseInt(text, 10);
  if (value < range.min) return { ok: false, reason: "below-min", range };
  if (value > range.max) return { ok: false, reason: "above-max", range };
  return { ok: true, value };
}

/**
 * API 面板三个数字字段的范围 —— 与 `APISettings.svelte` 里那三行 `min`／`max` **同一个
 * 来源**（标记读这张表渲染，判据读这张表校验）。原来的默认值（`|| 30000`／`|| 3`／
 * `|| 2000`）**不是**范围，只是「无效时偷偷换成什么」，故不在此表里出现。
 */
export const API_NUMERIC_RANGES = {
  timeout: { min: 1000, max: 120000 },
  retryCount: { min: 0, max: 5 },
  retryDelay: { min: 500, max: 10000 },
} as const satisfies Record<string, NumericRange>;

/** MDM 面板「使用限制」四个数字字段的范围（同上，与标记同源）。 */
export const MDM_NUMERIC_RANGES = {
  maxShortcutsPerUser: { min: 1, max: 1000 },
  maxActionsPerShortcut: { min: 1, max: 200 },
  maxExecutionsPerDay: { min: 1, max: 10000 },
  /**
   * 单次执行最长秒数（REQ-A824）。上限 3600 秒是**面板能填的上限**，不是引擎的上限：
   * 引擎自己的保命上限是 `LIMITS.MAX_EXECUTION_TIME_MS`（300 秒），策略只能比它更紧，
   * 填得更大的值会被 `min()` 吃掉。这里仍允许填到 3600，是为了让「策略比引擎宽」
   * 这件事在界面上是**可表达**的（而不是被界面悄悄改写成 300）。
   */
  maxExecutionTime: { min: 1, max: 3600 },
} as const satisfies Record<string, NumericRange>;

export type APINumericKey = keyof typeof API_NUMERIC_RANGES;
export type MDMNumericKey = keyof typeof MDM_NUMERIC_RANGES;
