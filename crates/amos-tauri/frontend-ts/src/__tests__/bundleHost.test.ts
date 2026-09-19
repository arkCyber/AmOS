import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BUNDLE_ENTRY_COMMAND,
  BUNDLE_FRAME_SANDBOX,
  bundleFailureFromDiag,
  fetchBundleEntry,
  isFrameableBundleUrl,
  normalizeBundleEntry,
} from "../lib/bundleHost";

/**
 * Pure contract tests for the web-bundle host's decisions (no DOM, no bridge —
 * the bridge/fetch half lives in `svelte-tests/ext-app-host.test.ts`).
 *
 * Two of these are load-bearing security decisions rather than formatting:
 * which URLs may go into an iframe `src`, and which sandbox flags a third-party
 * bundle gets.
 */
describe("bundleHost — what may be framed", () => {
  test("accepts both platform forms of the app's own origin", () => {
    // macOS/iOS/Linux form…
    expect(isFrameableBundleUrl("amos-app://org.amos.demo/index.html")).toBe(true);
    expect(isFrameableBundleUrl("amos-app://org.amos.demo/assets/app.js")).toBe(true);
    // …and the Windows/Android form wry rewrites to.
    expect(isFrameableBundleUrl("http://amos-app.org.amos.demo/index.html")).toBe(true);
    expect(isFrameableBundleUrl("https://amos-app.org.amos.demo/index.html")).toBe(true);
    // A *slug-shaped* netloc is legitimate in both forms — `amos-app.<id>` is
    // exactly the workaround rewrite of `amos-app://<id>`, and the id grammar
    // allows dots. So a name that merely *reads* like a public domain
    // (`amos-app.evil.test`) is still the on-device origin of app `evil.test`.
    // The guard is "is this our scheme+prefix", not "does this look friendly" —
    // the net is wry's `http://amos-app.*` interception, not this regex.
    expect(isFrameableBundleUrl("amos-app://evil.test/index.html")).toBe(true);
    expect(isFrameableBundleUrl("http://amos-app.evil.test/index.html")).toBe(true);
  });

  test("refuses anything that is not the protocol's own origin", () => {
    for (const bad of [
      "",
      "   ",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "https://evil.test/",
      "http://not-amos-app.x/y", // the prefix must be exactly `amos-app.`
      "http://amos-app/x",       // …and must be followed by a `.`
      "https://amos-app.evil.test", // no path: a bare origin is not a document
      "amos-app://",             // no id
      "amos-app://org.amos.demo", // no path
      "amos-app://org.amos.demo/a b.html",
    ]) {
      expect(isFrameableBundleUrl(bad)).toBe(false);
    }
  });

  test("an un-frameable host reply is refused, never half-read", () => {
    expect(normalizeBundleEntry({ url: "amos-app://a.b/index.html", start: "index.html" })).toEqual({
      url: "amos-app://a.b/index.html",
      start: "index.html",
    });
    for (const bad of [
      null,
      undefined,
      "string",
      [],
      {},
      { url: "javascript:alert(1)", start: "index.html" },
      { url: "amos-app://a.b/index.html" }, // no start
      { url: "amos-app://a.b/index.html", start: 7 },
    ]) {
      expect(normalizeBundleEntry(bad)).toBeNull();
    }
  });

  test("the sandbox keeps the frame's own origin but not the shell's", () => {
    // These three are required for a bundle to be a working web app at all.
    expect(BUNDLE_FRAME_SANDBOX).toContain("allow-scripts");
    expect(BUNDLE_FRAME_SANDBOX).toContain("allow-same-origin");
    expect(BUNDLE_FRAME_SANDBOX).toContain("allow-forms");
    // …and these are what would let it escape the frame.
    for (const forbidden of [
      "allow-top-navigation",
      "allow-top-navigation-by-user-activation",
      "allow-popups",
      "allow-modals",
      "allow-pointer-lock",
      "allow-presentation",
    ]) {
      expect(BUNDLE_FRAME_SANDBOX).not.toContain(forbidden);
    }
  });
});

describe("bundleHost — telling the failure apart", () => {
  test("no bridge is 'offline', a rejected command keeps the host's own words", () => {
    expect(bundleFailureFromDiag({ ok: false, kind: "not-bridged", command: "x" })).toEqual({
      reason: "offline",
      detail: "no Tauri bridge",
    });
    // The host's rejection text is the whole point: it names the knob to set.
    expect(
      bundleFailureFromDiag({
        ok: false,
        kind: "command-failed",
        command: "appstore_bundle_entry",
        detail: "no web install dir (set AMOS_APPSTORE_INSTALL_DIR)",
      }),
    ).toEqual({
      reason: "unavailable",
      detail: "no web install dir (set AMOS_APPSTORE_INSTALL_DIR)",
    });
  });

  test("an Error detail is unwrapped; a missing one is not left blank", () => {
    expect(
      bundleFailureFromDiag({
        ok: false,
        kind: "command-failed",
        command: "x",
        detail: new Error("boom"),
      }).detail,
    ).toBe("boom");
    expect(
      bundleFailureFromDiag({ ok: false, kind: "command-failed", command: "x", detail: "  " })
        .detail,
    ).toBe("command failed");
    expect(
      bundleFailureFromDiag({ ok: false, kind: "command-failed", command: "x" }).detail,
    ).toBe("command failed");
  });

  test("a successful call that produced nothing is not framed", () => {
    expect(bundleFailureFromDiag({ ok: true })).toEqual({
      reason: "blocked",
      detail: "host returned no entry",
    });
  });
});

/**
 * REQ-A407 — `fetchBundleEntry` 的**桥接侧**（15 行，此前只有纯函数被测）。这一半是"用户按了
 * 打开某个商店应用"时要面对的四种结局：守护进程不在 / 宿主拒了（带它自己的原因）/ 宿主答了
 * 但没内容 / 宿主给了一个我们**拒绝内联**的 URL —— 每一种都必须说清是哪一种，因为 UI 要照着
 * 翻译成用户能懂的话（"没装"、"宿主没配安装目录"…）。假宿主同 `backend-bridge.test.ts`。
 */
let respond: (command: string, args?: Record<string, unknown>) => unknown = () => null;
const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];

function installBundleBridge(): void {
  calls.length = 0;
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return respond(command, args);
      },
    },
  };
}

beforeEach(() => {
  installBundleBridge();
  respond = () => null;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("bundleHost — fetchBundleEntry 的四种结局（REQ-A407）", () => {
  test("空 / 只有空白的 app id ⇒ 连宿主都不问（blocked: empty app id）", async () => {
    for (const mid of ["", "   "]) {
      expect([mid, await fetchBundleEntry(mid)]).toEqual([
        mid,
        { kind: "failed", reason: "blocked", detail: "empty app id" },
      ]);
    }
    expect(calls).toEqual([]); // 没必要的桥调用一条都不发
  });

  test("id 前后空白被 trim 掉再发给宿主", async () => {
    respond = () => ({ url: "amos-app://org.amos.demo/index.html", start: "index.html" });
    const result = await fetchBundleEntry("  org.amos.demo  ");
    expect(calls).toEqual([{ command: BUNDLE_ENTRY_COMMAND, args: { id: "org.amos.demo" } }]);
    expect(result.kind).toBe("ok");
  });

  test("宿主答了但没内容（null）⇒ blocked / host returned no entry", async () => {
    respond = () => null;
    expect(await fetchBundleEntry("org.amos.demo")).toEqual({
      kind: "failed",
      reason: "blocked",
      detail: "host returned no entry",
    });
  });

  test("宿主拒了这次调用（抛错）⇒ unavailable + 宿主自己的话", async () => {
    respond = () => {
      throw new Error("no web install dir (set AMOS_APPSTORE_INSTALL_DIR)");
    };
    const result = await fetchBundleEntry("org.amos.demo");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("unavailable");
      expect(result.detail).toContain("AMOS_APPSTORE_INSTALL_DIR");
    }
  });

  test("未桥接 ⇒ offline / no Tauri bridge（不是「宿主拒绝」）", async () => {
    delete (globalThis as { window?: unknown }).window;
    expect(await fetchBundleEntry("org.amos.demo")).toEqual({
      kind: "failed",
      reason: "offline",
      detail: "no Tauri bridge",
    });
  });

  test("宿主给了一个我们拒绝内联的 URL ⇒ blocked / refused to frame the host's URL", async () => {
    respond = () => ({ url: "https://evil.test/index.html", start: "index.html" });
    expect(await fetchBundleEntry("org.amos.demo")).toEqual({
      kind: "failed",
      reason: "blocked",
      detail: "refused to frame the host's URL",
    });
  });

  test("好应答 ⇒ 原样落地成 { kind: ok, entry }", async () => {
    respond = () => ({ url: "amos-app://org.amos.demo/index.html", start: "index.html" });
    expect(await fetchBundleEntry("org.amos.demo")).toEqual({
      kind: "ok",
      entry: { url: "amos-app://org.amos.demo/index.html", start: "index.html" },
    });
  });
});

