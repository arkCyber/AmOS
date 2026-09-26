/**
 * sms-refusal-envelope.test.ts — REQ-A1756 / F-TEL-044 —
 * 「普通安装下收件箱永远报『短信暂不可用』：宿主明明回了权限不足，前端却把它读成了
 * `[object Object]`，于是『授予短信权限』按钮永远不出现」。
 *
 * `smsFolderSnapshot` 用 `/permission|denied|not granted/i` 判断这次读取失败是不是
 * **权限**问题，而它扫的字符串来自 `String(diag.detail)`。可是 `invoke` 记录的
 * `detail` 在真机上是 Tauri 抛出的 `AmosError` **信封对象** ——
 * `{ code, message, cause: [...] }`（`crates/amos-tauri/src/error.rs`）——
 * `String({…})` 恒为 `"[object Object]"`，正则一个字都匹配不到。
 *
 * 后果正是 REQ-A1577 想修的那件事：拒读时 `denied` 结构性地恒为 `false`，
 * `MessagesApp` 于是打印「短信暂不可用」，而唯一能补救的按钮（`{#if smsDenied}`）
 * 从不渲染。REQ-A1577 的 svelte 测试之所以是绿的，是因为它的桩抛的是
 * `new Error("READ_SMS permission denied")` —— 一个字符串友好的形状，真机从不产生。
 *
 * 本文件把**信封形状**钉在宿主侧：`error.rs` 的 `SmsProviderRejected` 文档写明
 * 「用户可见原因在 `message`，SmsError 种类在 `cause[0]`」，`sms.rs` 的
 * `assert_eq!(v["cause"][0], "permission denied")` 就是那一行。
 */
import { afterEach, beforeEach, describe, expect, test as it } from "bun:test";
import * as backend from "../backend";

let thrown: unknown;
let thrownKind: "envelope" | "string" = "envelope";

/** The exact envelope `AmosError::with_cause` serialises (`error.rs:695-722`). */
const providerEnvelope = (cause: string) => ({
  code: "amos.sms.provider_rejected",
  message: "amos.sms.provider_rejected",
  cause: [cause],
});

function installBridge() {
  const m = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => void m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        if (command === "sms_snapshot") {
          if (thrownKind === "string") throw new Error(String(thrown));
          throw thrown;
        }
        return null;
      },
      listen: async () => () => {},
    },
    localStorage,
  };
}

beforeEach(() => {
  thrown = providerEnvelope("SMS permission denied: READ_SMS not granted");
  thrownKind = "envelope";
  installBridge();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("smsFolderSnapshot —— 从宿主信封里读出「权限被拒」", () => {
  it("真机的信封形状：cause[0] 说权限不足 ⇒ denied=true（于是申请按钮才会出现）", async () => {
    const r = await backend.smsFolderSnapshot("inbox");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.denied).toBe(true);
    expect(r.notBridged).toBe(false);
    // The words survive the fold — not the object's type name.
    expect(r.error).toContain("SMS permission denied");
    expect(r.error).not.toBe("[object Object]");
  });

  it("反向控制：信封说的是「不可用」而不是权限 ⇒ denied=false，绝不把两件事折成一件", async () => {
    thrown = providerEnvelope("SMS provider unavailable: no telephony service");
    const r = await backend.smsFolderSnapshot("inbox");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.denied).toBe(false);
  });

  it("字符串形状（JS 层抛出，测试桩/宿主 bug）仍能读出权限", async () => {
    thrown = "READ_SMS permission denied";
    thrownKind = "string";
    const r = await backend.smsFolderSnapshot("inbox");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.denied).toBe(true);
  });

  it("commandFailureText 把信封的三个字段都摊开；非字符串字段不冒充原因", () => {
    expect(
      backend.commandFailureText({
        code: "amos.sms.provider_rejected",
        message: "m",
        cause: ["c1", "c2"],
      }),
    ).toBe("amos.sms.provider_rejected m c1 c2");
    // A live `cause` may carry non-strings (a JSON number from another subsystem):
    // they are dropped rather than stringified into a reason nobody wrote.
    expect(backend.commandFailureText({ code: "x", cause: [7, "c"] })).toBe("x c");
    // Nothing to say → the raw value is better than silence.
    expect(backend.commandFailureText({})).toBe("[object Object]");
    expect(backend.commandFailureText(null)).toBe("");
  });
});
