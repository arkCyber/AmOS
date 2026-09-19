/**
 * shortcuts-automation.test.ts — 自动化补齐后的契约（src/lib/shortcuts.ts）。
 *
 * 覆盖四块：
 * 1. **变量系统** —— 整串引用（保留类型）/ 嵌入插值 / 递归 / `add_to_variable`；
 * 2. **控制流** —— `if`/`else`、`repeat`、`for_each`、`stop_shortcut`、嵌套深度与
 *    迭代次数护栏、`actionsTotal` 递归计数；
 * 3. **真动作** —— `open_url`（校验 + 可替换出口）、`show_notification`（写进
 *    `amos.notifications`）、剪贴板 / 振动在无宿主时**安静降级**、列表/文本/数学/日期；
 * 4. **触发器** —— 纯判定（时间/应用/Wi-Fi/电池/位置/NFC/飞行模式/通知）+ 运行时的
 *    分钟去重、`requiresConfirmation` 跳过、执行日志。
 */
import { describe, test as it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  createShortcut,
  evaluateCondition,
  executeShortcut,
  haversineMeters,
  isoWeekday,
  loadExecutionLog,
  resolveValue,
  saveShortcuts,
  ShortcutTriggerRuntime,
  timeTriggerMatches,
  triggerMatches,
  type ActionInstance,
  type ExecutionContext,
  type ExecutionResult,
  type Shortcut,
  type Trigger,
  type TriggerEvent,
} from "../shortcuts";
import { NOTIF_KEY, type Notif } from "../settings";
import { readStoreValue } from "../amosStore";

const storageMap = new Map<string, string>();
const mockStorage: Storage = {
  getItem: (key) => storageMap.get(key) ?? null,
  setItem: (key, value) => void storageMap.set(key, value),
  removeItem: (key) => void storageMap.delete(key),
  clear: () => storageMap.clear(),
  key: (index) => [...storageMap.keys()][index] ?? null,
  get length() {
    return storageMap.size;
  },
};
const globals = globalThis as Record<string, unknown>;
const prevWindow = globals.window;
const prevLocalStorage = globals.localStorage;

beforeAll(() => {
  globals.window = { localStorage: mockStorage, dispatchEvent: () => true };
  globals.localStorage = mockStorage;
});

afterAll(() => {
  if (prevWindow === undefined) delete globals.window;
  else globals.window = prevWindow;
  if (prevLocalStorage === undefined) delete globals.localStorage;
  else globals.localStorage = prevLocalStorage;
});

let seq = 0;
const action = (
  actionTypeId: string,
  parameters: Record<string, unknown> = {},
  children?: ActionInstance[],
  elseChildren?: ActionInstance[]
): ActionInstance => {
  const a: ActionInstance = { id: `act-${++seq}`, actionTypeId, parameters, position: seq };
  if (children) a.children = children;
  if (elseChildren) a.elseChildren = elseChildren;
  return a;
};

function ctx(vars: Record<string, unknown> = {}, input?: unknown): ExecutionContext {
  return {
    shortcutId: "sc-test",
    variables: new Map(Object.entries(vars)),
    input,
    output: input,
    fromSiri: false,
    fromAutomation: false,
    startTime: Date.now(),
  };
}

function ctxWithOutput(vars: Record<string, unknown>, input: unknown): ExecutionContext {
  const c = ctx(vars, input);
  c.output = `output-of:${String(input)}`;
  return c;
}

beforeEach(() => {
  storageMap.clear();
  saveShortcuts([]);
  delete (globals as { open?: unknown }).open;
});

/** Install a fake `open` for the open_url tests (the real one is the WebView's). */
function stubOpen(): string[] {
  const seen: string[] = [];
  globals.open = (url: string) => void seen.push(url);
  return seen;
}

// ============================================================================
// 1. 变量系统
// ============================================================================

describe("变量系统", () => {
  it("整串 `$name` 保留类型，未定义时回落成本身（旧契约不回退）", () => {
    const c = ctx({ n: 42, list: [1, 2, 3] });
    expect(resolveValue("$n", c)).toBe(42);
    expect(resolveValue("$list", c)).toEqual([1, 2, 3]);
    expect(resolveValue("$nope", c)).toBe("$nope");
  });

  it("整串 `${name}` 与内建引用（input / output / date / time）", () => {
    const c = ctxWithOutput({ greet: "hi" }, "IN");
    expect(resolveValue("${greet}", c)).toBe("hi");
    expect(resolveValue("{greet}", c)).toBe("hi");
    expect(resolveValue("${input}", c)).toBe("IN");
    expect(resolveValue("${output}", c)).toBe("output-of:IN");
    expect(String(resolveValue("${date}", c))).toMatch(/\d/);
    expect(String(resolveValue("${time}", c))).toMatch(/\d/);
  });

  it("嵌入插值把值转成文本；`$5` 这类普通文本不被吃掉", () => {
    const c = ctx({ total: 42, who: "AmOS" });
    expect(resolveValue("总计 ${total} 元", c)).toBe("总计 42 元");
    expect(resolveValue("{who} 你好", c)).toBe("AmOS 你好");
    expect(resolveValue("仅售 $5", c)).toBe("仅售 $5");
    // 变量刚好是字符串时，未定义的引用保持原样（与整串契约一致）
    expect(resolveValue("a ${nope} b", c)).toBe("a ${nope} b");
  });

  it("数组与对象递归解析", () => {
    const c = ctx({ x: "X" });
    expect(resolveValue(["${x}", "plain"], c)).toEqual(["X", "plain"]);
    expect(resolveValue({ a: "$x", b: { c: "${x}!" } }, c)).toEqual({
      a: "X",
      b: { c: "X!" },
    });
  });

  it("内建引用优先于同名变量", () => {
    const c = ctx({ input: "shadowed" }, "real-input");
    expect(resolveValue("${input}", c)).toBe("real-input");
  });

  it("变量动作：set / add（标量拼接）/ get", async () => {
    const sc = createShortcut(`变量-${++seq}`, {
      actions: [
        action("text", { text: "a" }),
        action("set_variable", { name: "acc", value: "a" }),
        action("add_to_variable", { name: "acc", value: "b" }),
        action("add_to_variable", { name: "acc", value: 1 }),
        action("get_variable", { name: "acc" }),
      ],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(true);
    expect(r.output).toBe("ab1");
  });

  it("get_variable 对未定义变量给空串（不写出 \"undefined\"）", async () => {
    const sc = createShortcut(`变量-未定义-${++seq}`, {
      actions: [action("get_variable", { name: "ghost" }), action("trim_text", { text: "$input" })],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.output).toBe("");
  });

  it("add_to_variable 对列表做追加（不是字符串拼接）", async () => {
    const sc = createShortcut(`变量-列表-${++seq}`, {
      actions: [
        action("list", { items: "x\ny", separator: "\n" }),
        action("set_variable", { name: "l", value: "$input" }),
        action("add_to_variable", { name: "l", value: "z" }),
        // 改变量**不改管道**（与 iOS 一致）：要拿新值得显式读一次
        action("get_variable", { name: "l" }),
        action("count_items"),
      ],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.output).toBe(3);
  });
});

// ============================================================================
// 2. 控制流
// ============================================================================

describe("控制流", () => {
  it("evaluateCondition 六种运算符 + 真值兜底", () => {
    expect(evaluateCondition({ condition: "3", operator: "==", value: 3 }, undefined)).toBe(true);
    expect(evaluateCondition({ condition: "3", operator: "!=", value: 4 }, undefined)).toBe(true);
    expect(evaluateCondition({ condition: 5, operator: ">", value: 4 }, undefined)).toBe(true);
    expect(evaluateCondition({ condition: 5, operator: "<", value: 4 }, undefined)).toBe(false);
    expect(
      evaluateCondition({ condition: "abcdef", operator: "contains", value: "cd" }, undefined)
    ).toBe(true);
    expect(evaluateCondition({ condition: [], operator: "empty" }, undefined)).toBe(true);
    expect(evaluateCondition({ condition: "", operator: "empty" }, undefined)).toBe(true);
    expect(evaluateCondition({}, 0)).toBe(false);
    expect(evaluateCondition({}, "x")).toBe(true);
  });

  it("if / else 走对分支（含嵌套 if）", async () => {
    const thenSc = createShortcut(`if-then-${++seq}`, {
      actions: [
        action("text", { text: "yes" }),
        action(
          "if",
          { condition: "$input", operator: "contains", value: "y" },
          [action("text", { text: "T" }), action("if", {}, [action("text", { text: "TT" })])],
          [action("text", { text: "F" })]
        ),
      ],
    })!;
    expect((await executeShortcut(thenSc.id)).output).toBe("TT");

    const elseSc = createShortcut(`if-else-${++seq}`, {
      actions: [
        action("text", { text: "no" }),
        action(
          "if",
          { condition: "$input", operator: "contains", value: "y" },
          [action("text", { text: "T" })],
          [action("text", { text: "F" })]
        ),
      ],
    })!;
    expect((await executeShortcut(elseSc.id)).output).toBe("F");
  });

  it("repeat 跑 N 次并暴露 repeatIndex", async () => {
    const sc = createShortcut(`repeat-${++seq}`, {
      actions: [
        action("text", { text: "seed" }),
        action("repeat", { count: 3 }, [
          action("combine_text", { text1: "${repeatIndex}", text2: "$input", separator: "-" }),
        ]),
      ],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.output).toBe("3-2-1-seed");
  });

  it("repeat 非有限 / 负数都被夹住（不会冻死）", async () => {
    const run = async (count: unknown) => {
      const sc = createShortcut(`repeat-clamp-${++seq}`, {
        actions: [
          action("text", { text: "t" }),
          action("repeat", { count }, [action("text", { text: "x" })]),
        ],
      })!;
      return (await executeShortcut(sc.id)).output;
    };
    expect(await run("nope")).toBe("t");
    expect(await run(-5)).toBe("t");
    expect(await run(2)).toBe("x");
  });

  it("for_each 遍历列表并暴露 item/index，输出每轮结果", async () => {
    const sc = createShortcut(`for-each-${++seq}`, {
      actions: [
        action("list", { items: "a,b,c", separator: "," }),
        action("for_each", {}, [
          action("combine_text", { text1: "${index}:", text2: "${item}", separator: "" }),
        ]),
      ],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.output).toEqual(["1:a", "2:b", "3:c"]);
  });

  it("for_each 空输入得到空数组（不伪造一轮）", async () => {
    const sc = createShortcut(`for-each-empty-${++seq}`, {
      actions: [
        action("list", { items: "", separator: "," }),
        action("for_each", { itemName: "row", indexName: "i" }, [
          action("text", { text: "${row}" }),
        ]),
      ],
    })!;
    expect((await executeShortcut(sc.id)).output).toEqual([]);
  });

  it("stop_shortcut 提前结束但**记为成功**，输出是当时管道值", async () => {
    const sc = createShortcut(`stop-${++seq}`, {
      actions: [
        action("text", { text: "first" }),
        action("repeat", { count: 2 }, [
          action("text", { text: "loop" }),
          action("stop_shortcut"),
        ]),
        action("text", { text: "never" }),
      ],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(true);
    expect(r.output).toBe("loop");
    expect(r.actionsCompleted).toBeLessThan(r.actionsTotal);
  });

  it("actionsTotal 递归计数，容器自己也算一个", async () => {
    const sc = createShortcut(`count-${++seq}`, {
      actions: [
        action("text", { text: "a" }),
        action(
          "if",
          {},
          [action("text", { text: "b" }), action("text", { text: "c" })],
          [action("text", { text: "d" })]
        ),
      ],
    })!;
    const r = await executeShortcut(sc.id);
    // 实际跑过：顶层 2 + then 分支 2 = 4；总数按整棵树 = 5（不走的 else 也在树上）
    expect(r.actionsCompleted).toBe(4);
    expect(r.actionsTotal).toBe(5);
  });

  it("控制流嵌套超深被拒（护栏真的会拦）", async () => {
    // 每一层条件都为真，所以递归真的会一路走下去 —— 不是靠"条件假"侥幸停下
    let inner = action("text", { text: "deep" });
    for (let i = 0; i < 12; i++) inner = action("if", { condition: true }, [inner]);
    const sc = createShortcut(`deep-${++seq}`, { actions: [inner] })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(false);
    expect(r.error).toContain("控制流嵌套");
  });

  it("刚好到上限的嵌套仍然能跑", async () => {
    let inner = action("text", { text: "ok" });
    for (let i = 0; i < 10; i++) inner = action("if", { condition: true }, [inner]);
    const sc = createShortcut(`deep-ok-${++seq}`, { actions: [inner] })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(true);
    expect(r.output).toBe("ok");
  });
});

// ============================================================================
// 3. 真动作（以前是 `logger.info + return input`）
// ============================================================================

describe("系统集成动作", () => {
  it("open_url 校验并调用宿主出口；危险 URL 让指令失败", async () => {
    const seen = stubOpen();

    const ok = createShortcut(`url-ok-${++seq}`, {
      actions: [action("open_url", { url: "https://example.com/a" })],
    })!;
    expect((await executeShortcut(ok.id)).success).toBe(true);
    expect(seen).toEqual(["https://example.com/a"]);

    const bad = createShortcut(`url-bad-${++seq}`, {
      actions: [action("open_url", { url: "javascript:alert(1)" })],
    })!;
    const r = await executeShortcut(bad.id);
    expect(r.success).toBe(false);
    expect(r.error).toContain("URL 无效");
    expect(seen).toHaveLength(1); // 危险 URL 一次都没送出去
  });

  it("宿主没有 open（无头/纯浏览器）时 open_url 不抛，只记警告", async () => {
    const sc = createShortcut(`url-no-host-${++seq}`, {
      actions: [action("text", { text: "k" }), action("open_url", { url: "https://example.com" })],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(true);
    expect(r.output).toBe("k");
  });

  it("show_notification / show_alert 写进 amos.notifications（不是控制台日志）", async () => {
    const sc = createShortcut(`notif-${++seq}`, {
      actions: [
        action("show_notification", { title: "标题", body: "正文" }),
        action("show_alert", { title: "警告", message: "注意" }),
      ],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(true);
    const list = readStoreValue<Notif[]>(NOTIF_KEY, []);
    expect(list).toHaveLength(2);
    expect(list[0]?.title).toBe("警告");
    expect(list[0]?.icon).toBe("⚠️");
    expect(list[1]?.title).toBe("标题");
    expect(list[0]?.app).toBe("快捷指令");
  });

  it("open_app 在无桥（纯 bun）时如实降级、不假装打开、也不抛", async () => {
    const sc = createShortcut(`open-app-${++seq}`, {
      actions: [action("text", { text: "k" }), action("open_app", { app: "settings" })],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(true);
    expect(r.output).toBe("k");

    const missing = createShortcut(`open-app-bad-${++seq}`, {
      actions: [action("open_app", {})],
    })!;
    expect((await executeShortcut(missing.id)).success).toBe(false);
  });

  it("vibrate / copy_to_clipboard / get_clipboard 无宿主时安静降级", async () => {
    const sc = createShortcut(`device-${++seq}`, {
      actions: [
        action("text", { text: "v" }),
        action("vibrate", { pattern: "medium" }),
        action("copy_to_clipboard", { text: "$input" }),
        action("get_clipboard"),
      ],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(true);
    // 桥不在 → 剪贴板读写都拿不到东西，指令仍然跑完（不是失败）
    expect(r.output).toBe("");
  });

  it("列表 / 文本 / 数学 / 日期动作的真实语义", async () => {
    const sc = createShortcut(`pure-${++seq}`, {
      actions: [
        action("split_text", { text: "a,b,c", separator: "," }),
        action("get_list_item", { index: -1 }),
        action("text_case", { text: "$input", mode: "upper" }),
        action("trim_text", { text: "  ${input}  " }),
        action("round_number", { number: 3.14159, places: 2 }),
        action("adjust_date", {
          date: "2026-01-31T00:00:00.000Z",
          amount: 1,
          unit: "months",
        }),
        action("format_date", { date: "$input", format: "short" }),
      ],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(true);
    // 2026-01-31 + 1 月（日历语义 = 3 月 3 日）后按短日期格式化：只要不是 Invalid 就说明
    // adjust_date / format_date 这条链真的通了
    expect(String(r.output)).not.toBe("Invalid Date");
  });

  it("get_list_item 越界返回空串而不是 undefined", async () => {
    const sc = createShortcut(`item-oob-${++seq}`, {
      actions: [
        action("list", { items: "a,b", separator: "," }),
        action("get_list_item", { index: 99 }),
        action("combine_text", { text1: "[", text2: "$input", separator: "" }),
      ],
    })!;
    expect((await executeShortcut(sc.id)).output).toBe("[");
  });

  it("random_number 落在区间内（含两端）、参数反了也能跑", async () => {
    const run = async (min: number, max: number) => {
      const sc = createShortcut(`rand-${++seq}`, {
        actions: [action("random_number", { min, max })],
      })!;
      return Number((await executeShortcut(sc.id)).output);
    };
    expect(await run(3, 3)).toBe(3);
    const flipped = await run(10, 1);
    expect(flipped).toBeGreaterThanOrEqual(1);
    expect(flipped).toBeLessThanOrEqual(10);
  });

  it("count_items / join_list 对非列表输入不炸", async () => {
    const sc = createShortcut(`list-safe-${++seq}`, {
      actions: [
        action("text", { text: "solo" }),
        action("count_items"),
        action("join_list", { separator: "|" }),
      ],
    })!;
    // "solo" 是一个单元素列表 → 计数 1 → 合并回 "1"（不伪造，也不抛）
    expect((await executeShortcut(sc.id)).output).toBe("1");
  });

  it("join_list 按分隔符合并真列表", async () => {
    const sc = createShortcut(`join-real-${++seq}`, {
      actions: [
        action("list", { items: "a\nb", separator: "\n" }),
        action("join_list", { separator: "-" }),
      ],
    })!;
    expect((await executeShortcut(sc.id)).output).toBe("a-b");
  });
});

// ============================================================================
// 4. 门禁（确认 / 锁屏）与执行日志
// ============================================================================

describe("运行门禁与执行日志", () => {
  it("requiresConfirmation 没有确认时不跑；confirmed 才跑", async () => {
    const sc = createShortcut(`确认-${++seq}`, {
      actions: [action("text", { text: "ran" })],
      requiresConfirmation: true,
    })!;
    const denied = await executeShortcut(sc.id);
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("确认");

    const allowed = await executeShortcut(sc.id, undefined, { confirmed: true });
    expect(allowed.success).toBe(true);
    expect(allowed.output).toBe("ran");
  });

  it("锁屏下 runOnLockScreen=false 被拒；=true 放行", async () => {
    const lockedOut = createShortcut(`锁屏-${++seq}`, {
      actions: [action("text", { text: "x" })],
      runOnLockScreen: false,
    })!;
    expect((await executeShortcut(lockedOut.id, undefined, { locked: true })).success).toBe(false);

    const allowed = createShortcut(`锁屏-允许-${++seq}`, {
      actions: [action("text", { text: "x" })],
      runOnLockScreen: true,
    })!;
    expect((await executeShortcut(allowed.id, undefined, { locked: true })).success).toBe(true);
  });

  it("执行日志：成功与失败都落一条，最新在前", async () => {
    const ok = createShortcut(`日志-ok-${++seq}`, {
      actions: [action("text", { text: "a" })],
    })!;
    await executeShortcut(ok.id, undefined, { triggerId: "trg-1" });
    const afterOk = loadExecutionLog();
    expect(afterOk).toHaveLength(1);
    expect(afterOk[0]?.shortcutId).toBe(ok.id);
    expect(afterOk[0]?.triggerId).toBe("trg-1");
    expect(afterOk[0]?.success).toBe(true);

    const bad = createShortcut(`日志-bad-${++seq}`, {
      actions: [action("replace_text", { text: "a", find: "[", replace: "x" })],
    })!;
    await executeShortcut(bad.id);
    const afterBad = loadExecutionLog();
    expect(afterBad).toHaveLength(2);
    expect(afterBad[0]?.success).toBe(false);
    expect(typeof afterBad[0]?.error).toBe("string");
  });
});

// ============================================================================
// 5. 触发器判定（纯）与运行时
// ============================================================================

const trig = (
  type: Trigger["type"],
  config: Record<string, unknown> = {},
  enabled = true
): Trigger => ({
  id: `trg-${++seq}`,
  type,
  enabled,
  config,
});

const tzEvent = (at: number): TriggerEvent => ({ type: "time", at });

describe("触发器判定（纯函数）", () => {
  it("isoWeekday 周日是 7（不是 0）", () => {
    expect(isoWeekday(new Date(2026, 0, 5))).toBe(1); // 2026-01-05 周一
    expect(isoWeekday(new Date(2026, 0, 11))).toBe(7); // 2026-01-11 周日
  });

  it("time：命中分钟、按星期过滤、非法配置不匹配", () => {
    const monday = new Date(2026, 0, 5, 8, 0, 30);
    expect(timeTriggerMatches({ time: "08:00" }, monday)).toBe(true);
    expect(timeTriggerMatches({ time: "8:0" }, monday)).toBe(false); // 分钟必须两位
    expect(timeTriggerMatches({ time: "08:01" }, monday)).toBe(false);
    expect(timeTriggerMatches({ time: "25:00" }, monday)).toBe(false);
    expect(timeTriggerMatches({ time: "08:00", days: [1, 2] }, monday)).toBe(true);
    expect(timeTriggerMatches({ time: "08:00", days: [6, 7] }, monday)).toBe(false);
    expect(timeTriggerMatches({}, monday)).toBe(false);
  });

  it("app / wifi / bluetooth：按名字与连接方向过滤", () => {
    const openSafari: TriggerEvent = { type: "app", at: 0, data: { appId: "safari", event: "open" } };
    expect(triggerMatches(trig("app", { appId: "safari" }), openSafari)).toBe(true);
    expect(triggerMatches(trig("app", { appId: "notes" }), openSafari)).toBe(false);
    expect(triggerMatches(trig("app", { appId: "safari", event: "close" }), openSafari)).toBe(false);

    const wifiUp: TriggerEvent = { type: "wifi", at: 0, data: { ssid: "Home", connected: true } };
    expect(triggerMatches(trig("wifi"), wifiUp)).toBe(true);
    expect(triggerMatches(trig("wifi", { ssid: "Home" }), wifiUp)).toBe(true);
    expect(triggerMatches(trig("wifi", { ssid: "Cafe" }), wifiUp)).toBe(false);
    expect(triggerMatches(trig("wifi", { event: "disconnect" }), wifiUp)).toBe(false);
    expect(triggerMatches(trig("bluetooth"), wifiUp)).toBe(false); // 类型不串门

    const btDown: TriggerEvent = {
      type: "bluetooth",
      at: 0,
      data: { deviceName: "Buds", connected: false },
    };
    expect(
      triggerMatches(trig("bluetooth", { deviceName: "Buds", event: "disconnect" }), btDown)
    ).toBe(true);
  });

  it("battery：阈值与充电状态必须同时满足；无条件的触发器什么都不匹配", () => {
    const low: TriggerEvent = { type: "battery", at: 0, data: { levelPct: 15, charging: false } };
    expect(triggerMatches(trig("battery", { levelBelow: 20 }), low)).toBe(true);
    expect(triggerMatches(trig("battery", { levelBelow: 10 }), low)).toBe(false);
    expect(triggerMatches(trig("battery", { levelBelow: 20, charging: true }), low)).toBe(false);
    expect(triggerMatches(trig("battery", { levelAbove: 10, charging: false }), low)).toBe(true);
    expect(triggerMatches(trig("battery"), low)).toBe(false);
    // 读数未知时阈值条件一律不成立（不猜）
    expect(triggerMatches(trig("battery", { levelBelow: 20 }), { type: "battery", at: 0, data: {} })).toBe(
      false
    );
  });

  it("location：半径内/外与 arrive/leave；haversine 距离可信", () => {
    const here: TriggerEvent = {
      type: "location",
      at: 0,
      // 纬度 +0.001° ≈ 111 m
      data: { latitude: 39.9052, longitude: 116.4074 },
    };
    expect(haversineMeters(39.9042, 116.4074, 39.9042, 116.4074)).toBe(0);
    expect(
      triggerMatches(trig("location", { latitude: 39.9042, longitude: 116.4074, radius: 200 }), here)
    ).toBe(true);
    expect(
      triggerMatches(trig("location", { latitude: 39.9042, longitude: 116.4074, radius: 50 }), here)
    ).toBe(false);
    expect(
      triggerMatches(
        trig("location", { latitude: 39.9042, longitude: 116.4074, radius: 50, action: "leave" }),
        here
      )
    ).toBe(true);
    expect(triggerMatches(trig("location", {}), { type: "location", at: 0, data: {} })).toBe(false);
  });

  it("airplane / nfc / notification：按配置匹配，缺条件就不猜", () => {
    const planeOn: TriggerEvent = { type: "airplane", at: 0, data: { enabled: true } };
    expect(triggerMatches(trig("airplane", { enabled: true }), planeOn)).toBe(true);
    expect(triggerMatches(trig("airplane", { enabled: false }), planeOn)).toBe(false);
    expect(triggerMatches(trig("airplane", {}), planeOn)).toBe(false);

    const tag: TriggerEvent = { type: "nfc", at: 0, data: { tagId: "TAG-9" } };
    expect(triggerMatches(trig("nfc"), tag)).toBe(true);
    expect(triggerMatches(trig("nfc", { tagId: "TAG-9" }), tag)).toBe(true);
    expect(triggerMatches(trig("nfc", { tagId: "TAG-1" }), tag)).toBe(false);

    const notif: TriggerEvent = {
      type: "notification",
      at: 0,
      data: { app: "信息", title: "小安", body: "到家了" },
    };
    expect(triggerMatches(trig("notification", { contains: "到家" }), notif)).toBe(true);
    expect(triggerMatches(trig("notification", { contains: "到家", app: "邮件" }), notif)).toBe(false);
    expect(triggerMatches(trig("notification", {}), notif)).toBe(true);
  });

  it("禁用的触发器永不命中；时间触发器认 event.at 而不是当前时刻", () => {
    const mondayEight = new Date(2026, 0, 5, 8, 0, 0).getTime();
    expect(triggerMatches(trig("time", { time: "08:00" }, false), tzEvent(mondayEight))).toBe(false);
    expect(triggerMatches(trig("time", { time: "08:00" }), tzEvent(mondayEight))).toBe(true);
  });
});

describe("触发器运行时", () => {
  const at = (h: number, m: number) => new Date(2026, 0, 5, h, m, 0).getTime();

  it("tick 只在命中分钟内触发一次（分钟去重）", async () => {
    const sc = createShortcut(`触发-时间-${++seq}`, {
      actions: [action("text", { text: "go" })],
      triggers: [trig("time", { time: "08:00", days: [1] })],
    })!;
    const calls: string[] = [];
    const rt = new ShortcutTriggerRuntime({
      load: (): Shortcut[] => [sc],
      execute: async (id) => {
        calls.push(id);
        return { success: true, duration: 0, actionsCompleted: 1, actionsTotal: 1 };
      },
    });

    expect(await rt.tick(at(8, 0))).toEqual([sc.id]);
    expect(await rt.tick(at(8, 0))).toEqual([]); // 同一分钟不重复
    expect(calls).toHaveLength(1);
    expect(await rt.tick(at(8, 1))).toEqual([]); // 不在配置分钟
    expect(await rt.tick(new Date(2026, 0, 6, 8, 0).getTime())).toEqual([]); // 周二不匹配 days
    expect(await rt.tick(new Date(2026, 0, 12, 8, 0).getTime())).toEqual([sc.id]); // 下周一再来
  });

  it("fire 把非时间事件按类型分派，且不做分钟去重", async () => {
    const wifiSc = createShortcut(`触发-wifi-${++seq}`, {
      actions: [action("text", { text: "w" })],
      triggers: [trig("wifi", { ssid: "Home" })],
    })!;
    const appSc = createShortcut(`触发-app-${++seq}`, {
      actions: [action("text", { text: "a" })],
      triggers: [trig("app", { appId: "safari" })],
    })!;
    const calls: string[] = [];
    const rt = new ShortcutTriggerRuntime({
      load: (): Shortcut[] => [wifiSc, appSc],
      execute: async (id) => {
        calls.push(id);
        return { success: true, duration: 0, actionsCompleted: 1, actionsTotal: 1 };
      },
    });

    const up: TriggerEvent = { type: "wifi", at: 0, data: { ssid: "Home", connected: true } };
    expect(await rt.fire(up)).toEqual([wifiSc.id]);
    expect(await rt.fire(up)).toEqual([wifiSc.id]); // 两次连上同一网络 = 两件事
    expect(await rt.fire({ type: "app", at: 0, data: { appId: "safari", event: "open" } })).toEqual([
      appSc.id,
    ]);
    expect(calls).toHaveLength(3);
  });

  it("requiresConfirmation 的指令在自动化里被跳过（不是静默失败）", async () => {
    const sc = createShortcut(`触发-确认-${++seq}`, {
      actions: [action("text", { text: "x" })],
      triggers: [trig("app", { appId: "safari" })],
      requiresConfirmation: true,
    })!;
    let called = false;
    const rt = new ShortcutTriggerRuntime({
      load: (): Shortcut[] => [sc],
      execute: async () => {
        called = true;
        return { success: true, duration: 0, actionsCompleted: 1, actionsTotal: 1 };
      },
    });
    expect(await rt.fire({ type: "app", at: 0, data: { appId: "safari" } })).toEqual([]);
    expect(called).toBe(false);
  });

  it("锁屏状态被传进执行器（由 runOnLockScreen 决定成败）", async () => {
    const sc = createShortcut(`触发-锁屏-${++seq}`, {
      actions: [action("text", { text: "x" })],
      triggers: [trig("app", { appId: "safari" })],
      runOnLockScreen: false,
    })!;
    const seen: boolean[] = [];
    const rt = new ShortcutTriggerRuntime({
      load: (): Shortcut[] => [sc],
      isLocked: () => true,
      execute: async (_id, options) => {
        seen.push(options.locked === true);
        return { success: true, duration: 0, actionsCompleted: 1, actionsTotal: 1 };
      },
    });
    await rt.fire({ type: "app", at: 0, data: { appId: "safari" } });
    expect(seen).toEqual([true]);
  });

  it("执行器抛异常不会拖垮运行时；sync 清掉去重记忆后可重试", async () => {
    const sc = createShortcut(`触发-异常-${++seq}`, {
      actions: [action("text", { text: "x" })],
      triggers: [trig("time", { time: "08:00" })],
    })!;
    let attempts = 0;
    const rt = new ShortcutTriggerRuntime({
      load: (): Shortcut[] => [sc],
      execute: async () => {
        attempts++;
        throw new Error("executor exploded");
      },
    });
    expect(await rt.tick(at(8, 0))).toEqual([]); // 抛了 → 不算触发成功，也不冒泡
    expect(await rt.tick(at(8, 0))).toEqual([]); // 已记住这一分钟，不会重试风暴
    expect(attempts).toBe(1);
    rt.sync();
    await rt.tick(at(8, 0));
    expect(attempts).toBe(2); // sync 之后同一分钟可以再次尝试
  });

  it("两路时间触发（心跳 tick + Rust 轮询的 fire）在同一分钟只跑一次", async () => {
    // `osShortcutTriggers` 有两条路报同一个到点分钟：`ShortcutTriggerRuntime.start()` 的
    // 15 s 心跳走 `tick()`，Rust 账本的轮询走 `fire({type:"time"})`。整个文件的安全性
    // 依赖「两路共用一份分钟账本 ⇒ 只跑一次」，而此前只有两条独立的单路测试（tick 去重 /
    // fire 不去重），没有任何东西**钉住**这个跨路不变量 —— 谁把 `tick()` 里的 `markFired`
    // 挪走，套件仍然全绿。REQ-A412 把它钉在这里。
    const sc = createShortcut(`触发-双路-${++seq}`, {
      actions: [action("text", { text: "go" })],
      triggers: [trig("time", { time: "08:00" })],
    })!;
    const calls: string[] = [];
    const executor = async (id: string): Promise<ExecutionResult> => {
      calls.push(id);
      return { success: true, duration: 0, actionsCompleted: 1, actionsTotal: 1 };
    };
    const minute = at(8, 0);

    // 心跳先到，Rust 轮询后到：第二路是空的（不是第二次运行）。
    const heartbeatFirst = new ShortcutTriggerRuntime({
      load: (): Shortcut[] => [sc],
      execute: executor,
    });
    expect(await heartbeatFirst.tick(minute)).toEqual([sc.id]);
    expect(await heartbeatFirst.fire({ type: "time", at: minute })).toEqual([]);
    expect(calls).toHaveLength(1);

    // 反过来：Rust 先报，这一拍的 WebView 心跳不再重跑。
    const pollFirst = new ShortcutTriggerRuntime({
      load: (): Shortcut[] => [sc],
      execute: executor,
    });
    expect(await pollFirst.fire({ type: "time", at: minute })).toEqual([sc.id]);
    expect(await pollFirst.tick(minute)).toEqual([]);
    expect(calls).toHaveLength(2);

    // 下一分钟是**新**的一分钟：两路都还可能触发（去重不是"每条指令一辈子一次"）。
    const nextMinute = at(8, 1);
    const nextSc = createShortcut(`触发-双路-次分-${++seq}`, {
      actions: [action("text", { text: "go" })],
      triggers: [trig("time", { time: "08:01" })],
    })!;
    const next = new ShortcutTriggerRuntime({
      load: (): Shortcut[] => [nextSc],
      execute: executor,
    });
    expect(await next.tick(nextMinute)).toEqual([nextSc.id]);
    expect(calls).toHaveLength(3);
  });

  it("start / stop 可以被反复调用而不泄漏定时器", () => {
    const rt = new ShortcutTriggerRuntime({ load: (): Shortcut[] => [], intervalMs: 10_000 });
    rt.start();
    rt.start(); // 第二次是 no-op
    rt.stop();
    rt.stop(); // 第二次也是 no-op
  });
});
