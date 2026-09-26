/**
 * buildIdentity.test.ts — `lib/buildIdentity.ts`（REQ-A695 / F-SH-155）。
 *
 * 这个模块把审计记录上的「构建版本」与「操作主体」两个字段收敛到**唯一真源**：
 * 版本读 `AMOS_UI_VERSION`（不再有 `audit.ts` 里那份会腐烂的第二份字面量），
 * 主体缺席时如实写 `unattributed`（不再伪造 "Default User"）。
 * 下面每条断言都钉住其中一个界：漂移、host 覆盖、以及"缺席不冒充真人"。
 *
 * 与 `enterprise-templates.test.ts` 同款：不注册 happy-dom（导入会被 `bun-iso-test.mjs` 判为 DOM 文件），
 * `amosStore` 只需要一个 `window.localStorage` 内存桩；桩在本文件生命周期内装、`afterAll` 还原。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  APP_VERSION_KEY,
  USER_ID_KEY,
  USER_NAME_KEY,
  USER_EMAIL_KEY,
  UNATTRIBUTED_USER_ID,
  UNATTRIBUTED_USER_NAME,
  currentAppVersion,
  resolveAuditIdentity,
} from "../buildIdentity";
import { readStoreValue } from "../amosStore";
import { AMOS_UI_VERSION } from "../version";

const memory = new Map<string, string>();
const stub = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, String(value)),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  },
};
const globals = globalThis as Record<string, unknown>;
const previousWindow = globals.window;

beforeAll(() => {
  globals.window = { localStorage: stub.localStorage };
});
afterAll(() => {
  globals.window = previousWindow;
});
beforeEach(() => {
  memory.clear();
});

describe("buildIdentity 的 store 键", () => {
  test("四个键都是各自不同的 amos.* 键（一个键一处拼写）", () => {
    const keys = [APP_VERSION_KEY, USER_ID_KEY, USER_NAME_KEY, USER_EMAIL_KEY];
    expect(keys).toEqual(["amos.app.version", "amos.user.id", "amos.user.name", "amos.user.email"]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("currentAppVersion —— 版本只有一个真源", () => {
  test("store 为空时读真实构建常量，而不是第二份字面量", () => {
    // 这条是缺陷的判别断言：修前 `audit.ts` 用自己的 `"0.1.0"`；若有人把版本升到 0.2.0 而忘了这里，
    // 只有"回落 == AMOS_UI_VERSION"能红。
    expect(currentAppVersion()).toBe(AMOS_UI_VERSION);
  });

  test("host 写过值时以 host 为准（覆盖常量）", () => {
    memory.set(APP_VERSION_KEY, JSON.stringify("9.9.9-device"));
    expect(currentAppVersion()).toBe("9.9.9-device");
  });

  test("空白串不算 host 值（回落常量）", () => {
    memory.set(APP_VERSION_KEY, JSON.stringify("   "));
    expect(currentAppVersion()).toBe(AMOS_UI_VERSION);
  });
});

describe("resolveAuditIdentity —— 缺席的主体如实标记，绝不冒充真人", () => {
  test("三者皆空 ⇒ userId/userName 是 unattributed 标记，email 为 undefined", () => {
    expect(resolveAuditIdentity()).toEqual({
      userId: UNATTRIBUTED_USER_ID,
      userName: UNATTRIBUTED_USER_NAME,
      userEmail: undefined,
    });
    expect(UNATTRIBUTED_USER_ID).toBe("unattributed");
    expect(UNATTRIBUTED_USER_NAME).toBe("Unattributed");
  });

  test("store 里有真实身份时原样带出", () => {
    memory.set(USER_ID_KEY, JSON.stringify("user-42"));
    memory.set(USER_NAME_KEY, JSON.stringify("Ada Lovelace"));
    memory.set(USER_EMAIL_KEY, JSON.stringify("ada@example.com"));
    expect(resolveAuditIdentity()).toEqual({
      userId: "user-42",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
    });
  });

  test("只有 id 时，name 仍是 unattributed（逐字段独立判定）", () => {
    memory.set(USER_ID_KEY, JSON.stringify("user-7"));
    expect(resolveAuditIdentity()).toEqual({
      userId: "user-7",
      userName: UNATTRIBUTED_USER_NAME,
      userEmail: undefined,
    });
  });

  test("空白值视同缺席", () => {
    memory.set(USER_ID_KEY, JSON.stringify("   "));
    memory.set(USER_NAME_KEY, JSON.stringify(""));
    expect(resolveAuditIdentity().userId).toBe(UNATTRIBUTED_USER_ID);
    expect(resolveAuditIdentity().userName).toBe(UNATTRIBUTED_USER_NAME);
  });
});

describe("版本单一真源（把「两份实现」的反例钉死）", () => {
  test("currentAppVersion 与 readStoreValue 的回落语义一致：空 store 不改写任何键", () => {
    currentAppVersion();
    resolveAuditIdentity();
    // 读操作绝不应写 store —— 否则审计只是被查询就会"落下"一个版本值。
    expect(readStoreValue(APP_VERSION_KEY, "")).toBe("");
    expect(readStoreValue(USER_ID_KEY, "")).toBe("");
  });
});
