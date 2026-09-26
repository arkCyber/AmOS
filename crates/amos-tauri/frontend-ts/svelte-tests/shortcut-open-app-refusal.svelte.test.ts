/**
 * shortcut-open-app-refusal.svelte.test.ts — 「打开 App」把宿主**拒绝**的那一次当成成功收掉
 * （REQ-A1193 / FMEA F-SH-481）。
 *
 * `shortcuts.ts::open_app` 是快捷指令里唯一一条向宿主**开窗**的动作。它调
 * `invoke<WmWindowsSnapshot>("wm_open", { label: appId })`，然后把答案折成一句话：
 *
 *     const opened = await invoke<WmWindowsSnapshot>("wm_open", { label: appId });
 *     if (opened === null) logger.warn("shortcuts", `open_app: wm_open(${appId}) not bridged`);
 *     return input;
 *
 * 三件事同时不对，而且互相掩护：
 *
 *  1. **判决被读成了另一个事实。** `lib/backend::invoke` 从不 reject —— 它把理由记进
 *     per-command 账本（`noteDiag`）再答 `null`。`null` 因此同时代表两件事：
 *     「这里根本没有宿主」（`kind:"not-bridged"`，浏览器预览 / 单测 —— 诚实的答案）与
 *     「宿主答了，它说不」（`kind:"command-failed"`，带 `code`）。这一行把**两者都说成前者**
 *     （`not bridged`），于是会读到这句话的人被告知了错误的理由。
 *  2. **动作无论如何都 `return input`**，于是 `executeShortcut` 这一趟以
 *     `success: true` 收尾、`runCount` 加一、`appendExecutionLog` 记一条成功 ——
 *     「宿主拒绝了」与「打开成功」走出**同一扇门**。这就是 F-SH-447（REQ-A1140）已经
 *     判定为缺陷的那一类：`executeShortcut` 的失败是一条**返回值**，只有按返回值判才看得见。
 *  3. **就在这个 case 上方，上一轮（REQ-A555）新写下的注释断言「不假装打开了」** ——
 *     一句代码不满足的话。同一趟改动只把类型注解从 `unknown` 换成 `WmWindowsSnapshot`，
 *     行为一个字没动，却补上了一条把现状描述得更好的注释。
 *
 * 可达性：`open_app` 的 `app` 参数是**必填**而类型 `app`，上一轮（REQ-A1190）刚给这个
 * 参数补上控件，所以用户自此能把任意 id —— 包括手打的、装完又卸掉的、写错的 —— 填进这一步。
 * 宿主拒绝 `wm_open` 的理由都是用户到得了的：身份模型不认识的 id、不是首实例的 label、
 * 该类的 `multi_window` 上限。
 *
 * 判据（这个家族一贯的那条）：**看`executeShortcut`答了什么**，不看它有没有抛。
 * 第三条用例是**反向守卫** —— 「这里没有宿主」不是这条指令的失败，修法不许把它一起判红。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  executeShortcut,
  saveShortcuts,
  type ActionInstance,
  type Shortcut,
} from "../src/lib/shortcuts";

const seed = (actions: ActionInstance[]): Shortcut => ({
  id: "sc-open-app",
  name: "打开番茄钟",
  icon: "⚡",
  color: "#007AFF",
  description: "",
  actions,
  quickActions: [],
  triggers: [],
  createdAt: 0,
  updatedAt: 0,
  runCount: 0,
  runOnLockScreen: false,
  requiresConfirmation: false,
  tags: [],
});

const openApp = (app: string): ActionInstance => ({
  id: "act-1",
  actionTypeId: "open_app",
  parameters: { app },
  position: 1,
});

/** A host that is present and **answers** `wm_open` with a typed refusal (Tauri 2: an
 *  `Err` from a `#[tauri::command]` rejects the JS promise). */
function installRefusingHost(code: string): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (cmd: string) => {
      if (cmd === "wm_open") return Promise.reject({ code, message: "the window class is at its cap" });
      return Promise.resolve(null);
    },
    listen: async () => () => {},
  };
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

describe("open_app — the host's refusal is a failure of the run, not a success", () => {
  test("a refused wm_open does not report the shortcut as succeeded", async () => {
    installRefusingHost("amos.wm.window_cap");
    saveShortcuts([seed([openApp("store:org.amos.pomodoro")])]);

    const result = await executeShortcut("sc-open-app");

    expect(
      result.success,
      "the app did not open — the run must not be recorded as a success",
    ).toBe(false);
  });

  test("the reason names the app that could not be opened", async () => {
    installRefusingHost("amos.wm.window_cap");
    saveShortcuts([seed([openApp("store:org.amos.pomodoro")])]);

    const result = await executeShortcut("sc-open-app");

    expect(result.error ?? "", "a refusal has to say what was refused").toContain(
      "store:org.amos.pomodoro",
    );
    // The honest diagnosis: the host answered. "not bridged" is a *different* fact.
    expect(result.error ?? "", "a host that answered is not a missing host").not.toMatch(
      /not bridged|未桥接/,
    );
  });

  test("with no host at all the run still succeeds — a browser is not a refusal", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    saveShortcuts([seed([openApp("notes")])]);

    const result = await executeShortcut("sc-open-app");

    expect(
      result.success,
      "there is nothing to open with, so this step has no verdict to give — " +
        "the fix must not turn 'no host' into a failure",
    ).toBe(true);
  });
});
