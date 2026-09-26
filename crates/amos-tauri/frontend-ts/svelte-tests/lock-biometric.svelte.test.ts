/**
 * LockPage 的生物识别半边（REQ-A528）。
 *
 * 这一页此前只有密码，而索引的搜索别名一直写着「面容」—— 搜索把用户送到这里，页面却什么都不给。
 * 这些用例逐条钉住**不撒谎**的三件事：
 *   1. `biometricAvailable()` 返回 `null`（无桥 / 桌面）或"有硬件未登记"时，**不画按钮** ——
 *      画一个按了必然失败的按钮就是 REQ-A468 那种缺陷；
 *   2. 四种非成功结果各有各的话：`fallback`（用户选了设备密码）、`cancelled`（**不是失败**）、
 *      `unavailable`、以及错误串**原样显示**（不吞成"按了没反应"）；
 *   3. 文案说清这一项**只验证身份、不放行任何操作**。
 *
 * 只 mock 两个异步桥函数；`biometricReady` / `biometricNeedsEnrollment` / `biometricLabel` 这些
 * 纯函数保持真实实现（页面正是靠它们判断状态，mock 掉就等于在测 mock）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import LockPage from "../src/svelte/settings/LockPage.svelte";
import { t } from "../src/svelte/locale.svelte";
import * as biometric from "../src/lib/biometric";

vi.mock("../src/lib/biometric", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/biometric")>();
  return {
    ...actual,
    biometricAvailable: vi.fn(),
    biometricAuthenticate: vi.fn(),
  };
});

const available = vi.mocked(biometric.biometricAvailable);
const authenticate = vi.mocked(biometric.biometricAuthenticate);

/** 等页面把 `biometricAvailable()` 的结果渲染出来（`$effect` 里的一次 await）。 */
async function settle() {
  await tick();
  await Promise.resolve();
  await tick();
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LockPage — 生物识别半边（REQ-A528）", () => {
  test("回答到达之前说\"正在检查\"，不说\"不支持\"（首帧的话也是话）", async () => {
    let resolveAvail: (v: null) => void = () => {};
    available.mockReturnValue(
      new Promise((res) => {
        resolveAvail = res as (v: null) => void;
      }),
    );
    const host = render(LockPage);
    await settle();

    const checking = host.getByTestId("lock-biometric").textContent ?? "";
    expect(checking).toContain(t("lock.biometricChecking"));
    expect(checking).not.toContain(t("lock.biometricUnsupported"));
    expect(host.queryByRole("button", { name: /verify|验证/i })).toBeNull();

    resolveAvail(null);
    await settle();
    expect(host.getByTestId("lock-biometric").textContent).toContain(t("lock.biometricUnknown"));
  });

  test("无桥（桌面/宿主）时承认自己不知道，并且不画按钮", async () => {
    available.mockResolvedValue(null);
    const host = render(LockPage);
    await settle();

    const text = host.getByTestId("lock-biometric").textContent ?? "";
    // REQ-A779：没有桥是**我们**不知道，不是"这台设备没有生物识别"。桌面版此前说的正是
    // 后一句 —— 那是替一台从未被问过的机器回答。
    expect(text).toContain(t("lock.biometricUnknown"));
    expect(text).not.toContain(t("lock.biometricUnsupported"));
    // 没有按钮 = 没有"按了不会成功"的入口
    expect(host.queryByRole("button", { name: /verify|验证/i })).toBeNull();
  });

  test("有硬件但没登记时指向系统设置，并且不画按钮", async () => {
    available.mockResolvedValue({
      state: "not-enrolled",
      can_authenticate: 11,
      kind: "none",
      label: "",
      enrolled: false,
      hardware_present: true,
    });
    const host = render(LockPage);
    await settle();

    expect(host.getByTestId("lock-biometric").textContent).toContain(
      t("lock.biometricNeedsEnrollment"),
    );
    expect(host.queryByRole("button", { name: /verify|验证/i })).toBeNull();
  });

  test("设备报告没有传感器时说\"没有传感器\"，不说\"去登记\"（REQ-A779 的对换缺陷）", async () => {
    // 这一档就是交换后的错误答案：`BIOMETRIC_ERROR_NO_HARDWARE`(12) 曾经落在"有硬件"那条
    // 分支上，于是没有传感器的手机被指去登记指纹。
    available.mockResolvedValue({
      state: "no-hardware",
      can_authenticate: 12,
      kind: "none",
      label: "",
      enrolled: false,
      hardware_present: false,
    });
    const host = render(LockPage);
    await settle();

    const text = host.getByTestId("lock-biometric").textContent ?? "";
    expect(text).toContain(t("lock.biometricUnsupported"));
    expect(text).not.toContain(t("lock.biometricNeedsEnrollment"));
    expect(host.queryByRole("button", { name: /verify|验证/i })).toBeNull();
  });

  test("平台没回答时把宿主自己的原话显示出来，不编一个原因（REQ-A779）", async () => {
    available.mockResolvedValue({
      state: "unavailable",
      can_authenticate: null,
      kind: "none",
      label: "",
      enrolled: false,
      hardware_present: null,
      detail: "java.lang.SecurityException: ...",
    });
    const host = render(LockPage);
    await settle();

    const text = host.getByTestId("lock-biometric").textContent ?? "";
    expect(text).toContain("java.lang.SecurityException");
    expect(text).not.toContain(t("lock.biometricUnsupported"));
    expect(host.queryByRole("button", { name: /verify|验证/i })).toBeNull();
  });

  test("可用时按钮用宿主报的名字，点击后带着 reason 调用，并说\"已验证\"", async () => {
    available.mockResolvedValue({
      state: "enrolled",
      can_authenticate: 0,
      kind: "face",
      label: "Face ID",
      enrolled: true,
      hardware_present: true,
    });
    authenticate.mockResolvedValue({ ok: true, result: "authenticated" });
    const host = render(LockPage);
    await settle();

    const btn = host.getByRole("button", { name: t("lock.biometricVerify", { label: "Face ID" }) });
    await fireEvent.click(btn);
    await settle();

    expect(authenticate).toHaveBeenCalledWith(t("lock.biometricReason"));
    expect(host.getByTestId("lock-biometric").textContent).toContain(t("lock.biometricOk"));
  });

  test("回退到设备密码不是\"已验证\"，取消也不是失败", async () => {
    available.mockResolvedValue({
      state: "enrolled",
      can_authenticate: 0,
      kind: "fingerprint",
      label: "",
      enrolled: true,
      hardware_present: true,
    });
    const host = render(LockPage);
    await settle();
    const btn = () =>
      host.getByRole("button", {
        name: t("lock.biometricVerify", { label: t("lock.biometricKindFingerprint") }),
      });

    authenticate.mockResolvedValue({ ok: true, result: "fallback" });
    await fireEvent.click(btn());
    await settle();
    const afterFallback = host.getByTestId("lock-biometric").textContent ?? "";
    expect(afterFallback).toContain(t("lock.biometricFallback"));
    expect(afterFallback).not.toContain(t("lock.biometricOk"));

    authenticate.mockResolvedValue({ ok: true, result: "cancelled" });
    await fireEvent.click(btn());
    await settle();
    const afterCancel = host.getByTestId("lock-biometric").textContent ?? "";
    expect(afterCancel).toContain(t("lock.biometricCancelled"));
    expect(afterCancel).not.toContain(t("lock.biometricError", { error: "" }));
  });

  test("not_enrolled / locked_out / 未知错误各有各的话，未知错误原样显示", async () => {
    available.mockResolvedValue({
      state: "enrolled",
      can_authenticate: 0,
      kind: "iris",
      label: "虹膜",
      enrolled: true,
      hardware_present: true,
    });
    const host = render(LockPage);
    await settle();
    const btn = () =>
      host.getByRole("button", { name: t("lock.biometricVerify", { label: "虹膜" }) });

    authenticate.mockResolvedValue({ ok: false, error: "not_enrolled" });
    await fireEvent.click(btn());
    await settle();
    expect(host.getByTestId("lock-biometric").textContent).toContain(t("lock.biometricNotEnrolled"));

    authenticate.mockResolvedValue({ ok: false, error: "locked_out" });
    await fireEvent.click(btn());
    await settle();
    expect(host.getByTestId("lock-biometric").textContent).toContain(t("lock.biometricLockedOut"));

    authenticate.mockResolvedValue({ ok: false, error: "vendor boom" });
    await fireEvent.click(btn());
    await settle();
    expect(host.getByTestId("lock-biometric").textContent).toContain(
      t("lock.biometricError", { error: "vendor boom" }),
    );
  });

  test("页面说明它只验证身份、不放行任何操作", async () => {
    available.mockResolvedValue(null);
    const host = render(LockPage);
    await settle();
    expect(host.getByTestId("lock-biometric").textContent).toContain(t("lock.biometricHint"));
  });
});
