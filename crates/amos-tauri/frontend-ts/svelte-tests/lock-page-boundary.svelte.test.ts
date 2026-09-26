/**
 * LockPage 的**密码边界**（REQ-A1131）。
 *
 * 「启用锁屏密码」这句话把一台设备说成"锁上了"，而这一页从头到尾只说密码的**位数**
 * （`lock.pin` = 「4-6 位数字密码」），从不说它到底挡住了什么。一处机制、三处事实，必须
 * 一起说出来 —— 否则用户形成的信念比机制强，而这正是本仓反复记账的那一类缺陷
 * （`lock.biometricHint` 的 REQ-A528 是同一种形状：一项能力必须把它**不做**的事写在用户
 * 形成信念的那一页）：
 *
 *   1. 本机数据**不加密** —— 能读到本机存储的人仍然看得到内容；
 *   2. 密码本身以**明文**留在本机设置里（`lib/lock.ts` 刻意不存摘要：没有同源的低权限
 *      读取方，而 4–6 位数字的口令空间对任何非 KDF 摘要都是一秒内的事 —— 摘要只是表演）；
 *   3. **没有**"错误次数过多"锁定，而且这是刻意的：本机没有任何找回密码的途径，
 *      锁死会把数据一起锁在外面（把"加固"做成砖，比不加固更坏）。
 *
 * 这条用例把这段话钉在页面上，并且**要求键真的解析**：`translate()` 对未知键回落成键名
 * 本身，所以 `toContain(t(key))` 在键缺失时会自证 —— 下面那句 `not.toContain(键名)` 才是
 * 真正会红的那一半。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import LockPage from "../src/svelte/settings/LockPage.svelte";
import { t } from "../src/svelte/locale.svelte";

vi.mock("../src/lib/biometric", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/biometric")>();
  return {
    ...actual,
    biometricAvailable: vi.fn().mockResolvedValue(null),
    biometricAuthenticate: vi.fn(),
  };
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("LockPage — 密码的边界（REQ-A1131）", () => {
  test("页面说清密码不是「本机加密」：明文保存、不加密数据、刻意不设锁定", async () => {
    const host = render(LockPage);
    await tick();
    const text = host.container.textContent ?? "";
    expect(text).toContain(t("lock.passcodeHint"));
    // 键真的解析了（否则上面那句等于自证）。
    expect(text).not.toContain("lock.passcodeHint");
  });
});
