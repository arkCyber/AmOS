/**
 * customGroups.test.ts — `lib/customGroups.ts`：App Library 的自定义分组（REQ-A406）。
 *
 * 为什么现在才写：这个模块**没有任何 lib 级测试** —— `getCustomGroups` / `addCustomGroup` /
 * `setGroupApps` / `renameCustomGroup` / `setGroupIcon` / `removeCustomGroup` 一条都没被调用过
 * （覆盖率名单里 34.8%，全仓最低）。唯一碰过它的是 `svelte-tests/custom-groups.svelte.test.ts`
 * 的**组件**测试，而组件测的是它自己那层：分组的读写契约（读侧清洗、落盘、id 来源）无人守。
 *
 * 纯批次（不注册 happy-dom）：`amosStore` 只用到一个 DOM 面 —— `window.localStorage` —— 所以
 * 给它一个内存实现 + 一个"写失败"开关即可。这个桩**只在本文件生命周期内存在**
 * （`beforeAll` 装、`afterAll` 还原）：纯批次是一个进程跑所有文件，漏一个 `window` 给后面的
 * 文件就会改变它们的行为（`webman-persistence.test.ts` 同一条教训）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CUSTOM_GROUPS_KEY,
  addCustomGroup,
  getCustomGroups,
  removeCustomGroup,
  renameCustomGroup,
  setGroupApps,
  setGroupIcon,
  type CustomGroup,
} from "../lib/customGroups";

// ── 内存 localStorage（+ 可切换的写失败）──────────────────────────────────────
const memory = new Map<string, string>();
let failWrites = false;

const stub = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error("QuotaExceededError");
      memory.set(key, String(value));
    },
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
    key: (i: number) => [...memory.keys()][i] ?? null,
    get length() {
      return memory.size;
    },
  },
  dispatchEvent: () => true,
};

const globals = globalThis as Record<string, unknown>;
const previousWindow = globals.window;

beforeAll(() => {
  globals.window = stub;
});
afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
});
beforeEach(() => {
  memory.clear();
  failWrites = false;
});

/** 落盘内容按模块自己的读法读回来。 */
function stored(): CustomGroup[] | null {
  const raw = memory.get(CUSTOM_GROUPS_KEY);
  return raw == null ? null : JSON.parse(raw);
}

const g = (id: string, name: string, apps: string[] = [], icon?: string): CustomGroup => {
  const out: CustomGroup = { id, name, apps };
  if (icon !== undefined) out.icon = icon;
  return out;
};


// ── 读侧 ──────────────────────────────────────────────────────────────────────
describe("getCustomGroups — 只交回能解释的行（坏档不崩、不静默变形）", () => {
  test("没有 store / 空数组 ⇒ 空列表", () => {
    expect(getCustomGroups()).toEqual([]);
    memory.set(CUSTOM_GROUPS_KEY, "[]");
    expect(getCustomGroups()).toEqual([]);
  });

  test("不是数组的 store（数字 / 对象 / null）⇒ 空列表，不抛", () => {
    for (const garbage of ["5", "{}", "null", '"x"']) {
      memory.set(CUSTOM_GROUPS_KEY, garbage);
      expect([garbage, getCustomGroups()]).toEqual([garbage, []]);
    }
  });

  test("丢掉认不出的行（缺 id / 缺 name / 非对象 / null）", () => {
    memory.set(
      CUSTOM_GROUPS_KEY,
      JSON.stringify([
        g("ok", "保留"),
        { name: "缺 id" },
        { id: "no-name" },
        { id: 7, name: "id 不是字符串" },
        { id: "x", name: 9 },
        null,
        42,
        "字符串不是分组",
      ]),
    );
    expect(getCustomGroups()).toEqual([g("ok", "保留")]);
  });

  test("规范化：apps 不是数组 ⇒ []，icon 不是字符串 ⇒ 不保留", () => {
    memory.set(
      CUSTOM_GROUPS_KEY,
      JSON.stringify([
        { id: "a", name: "缺 apps" },
        { id: "b", name: "apps 坏", apps: "nope", icon: 42 },
        { id: "c", name: "空的", apps: [] },
        { id: "d", name: "都好", apps: ["notes"], icon: "📁" },
      ]),
    );
    expect(getCustomGroups()).toEqual([
      g("a", "缺 apps"),
      g("b", "apps 坏", [], undefined),
      g("c", "空的", []),
      g("d", "都好", ["notes"], "📁"),
    ]);
  });

  test("apps 里的非字符串元素不进入结果（store 是用户可编辑的 localStorage）", () => {
    // 读侧已经严格校验 `id`/`name`（认不出就丢行），却把 `apps` 原样透传 ——
    // 一个 `[1, "notes"]` 会变成"分组里有一个 id=1 的成员"，UI 只能渲染一个不存在的瓦片。
    memory.set(
      CUSTOM_GROUPS_KEY,
      JSON.stringify([{ id: "a", name: "混合", apps: [1, "notes", null, "reminders"] }]),
    );
    expect(getCustomGroups()).toEqual([g("a", "混合", ["notes", "reminders"])]);
  });

  test("坏 JSON ⇒ 空列表（quarantine 由 amosStore 负责，这里只要求不崩）", () => {
    memory.set(CUSTOM_GROUPS_KEY, "{ not json");
    expect(getCustomGroups()).toEqual([]);
  });
});

// ── 写侧 ──────────────────────────────────────────────────────────────────────
describe("addCustomGroup / setGroupApps / renameCustomGroup / setGroupIcon / removeCustomGroup", () => {
  test("addCustomGroup：名字 trim、空名回落到「未命名分组」、追加在末尾并落盘", () => {
    const first = addCustomGroup([], "  工作  ");
    expect(first.created.name).toBe("工作");
    expect(first.groups).toHaveLength(1);
    expect(stored()).toEqual(first.groups);

    const second = addCustomGroup(first.groups, "   ");
    expect(second.created.name).toBe("未命名分组");
    expect(second.groups.map((x) => x.name)).toEqual(["工作", "未命名分组"]);
    expect(second.created.id).not.toBe(first.created.id);
  });

  test("addCustomGroup：新分组是空的（成员由 setGroupApps 添加）", () => {
    expect(addCustomGroup([], "空组").created.apps).toEqual([]);
  });

  test("setGroupApps：只改目标分组，并把数组复制一份", () => {
    const groups = [g("a", "A"), g("b", "B")];
    const input = ["notes"];
    const next = setGroupApps(groups, "a", input);
    expect(next.map((x) => x.apps)).toEqual([["notes"], []]);
    // 复制：调用方之后改自己的数组，不应改变已保存的分组。
    input.push("reminders");
    expect(next[0]!.apps).toEqual(["notes"]);
    expect(stored()).toEqual(next);
  });

  test("setGroupApps：未知 id ⇒ 内容不变（不是「清空成员」）", () => {
    const groups = [g("a", "A", ["notes"])];
    expect(setGroupApps(groups, "nope", [])).toEqual(groups);
  });

  test("renameCustomGroup：trim 后改名；空名 ⇒ 原样返回且**不落盘**", () => {
    memory.set(CUSTOM_GROUPS_KEY, JSON.stringify([g("a", "旧名")]));
    const renamed = renameCustomGroup([g("a", "旧名")], "a", "  新名 ");
    expect(renamed[0]!.name).toBe("新名");
    expect(stored()).toEqual(renamed);

    memory.set(CUSTOM_GROUPS_KEY, JSON.stringify([g("a", "旧名")]));
    const untouched = [g("a", "旧名")];
    expect(renameCustomGroup(untouched, "a", "   ")).toEqual(untouched);
    expect(stored()).toEqual([g("a", "旧名")]); // 没有写盘
  });

  test("setGroupIcon：空字符串清除图标，未知 id 不动", () => {
    const groups = [g("a", "A", [], "📁"), g("b", "B")];
    expect(setGroupIcon(groups, "a", "").map((x) => x.icon)).toEqual([undefined, undefined]);
    expect(setGroupIcon(groups, "a", "⭐").map((x) => x.icon)).toEqual(["⭐", undefined]);
    expect(setGroupIcon(groups, "nope", "⭐")).toEqual(groups);
  });

  test("removeCustomGroup：删掉目标、其余保持顺序；未知 id 内容不变", () => {
    const groups = [g("a", "A"), g("b", "B"), g("c", "C")];
    expect(removeCustomGroup(groups, "b").map((x) => x.id)).toEqual(["a", "c"]);
    expect(removeCustomGroup(groups, "zzz")).toEqual(groups);
  });

  test("写入被存储拒绝时不会假装成功（读回来还是旧内容）", () => {
    const groups = addCustomGroup([], "先存一个").groups;
    failWrites = true;
    addCustomGroup(groups, "存不进去");
    expect(getCustomGroups().map((x) => x.name)).toEqual(["先存一个"]);
  });
});

// ── id 来源（REQ-A401）─────────────────────────────────────────────────────────
describe("分组 id 的来源：优先平台 UUID，否则回落到共享 localId", () => {
  /** 临时替换全局 `crypto`（描述符可配置 ⇒ 能逐字节还原）。 */
  function withCrypto<T>(value: unknown, fn: () => T): T {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
    try {
      Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
      return fn();
    } finally {
      Object.defineProperty(globalThis, "crypto", desc);
    }
  }

  test("WebView 有 randomUUID 时用它（uuid 形状，两次不同）", () => {
    const a = addCustomGroup([], "A").created.id;
    const b = addCustomGroup([], "B").created.id;
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  test("没有 randomUUID（老 WebView）⇒ 回落到 localId，仍然唯一、非空", () => {
    const ids = withCrypto({}, () => [
      addCustomGroup([], "A").created.id,
      addCustomGroup([], "B").created.id,
    ]);
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(2);
  });

  test("randomUUID 抛错 ⇒ 同样回落（catch 路径），且全局 crypto 被还原", () => {
    const ids = withCrypto(
      {
        randomUUID: () => {
          throw new Error("hardened webview");
        },
      },
      () => [addCustomGroup([], "A").created.id, addCustomGroup([], "B").created.id],
    );
    expect(new Set(ids).size).toBe(2);
    // 别的文件/别的用例还要用真的 crypto：这条断言把「还原」也钉住。
    expect(typeof crypto.randomUUID).toBe("function");
  });
});

