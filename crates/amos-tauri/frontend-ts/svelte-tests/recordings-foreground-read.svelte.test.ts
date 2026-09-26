/**
 * recordings-foreground-read.svelte.test.ts — REQ-A1398 / F-SH-657 —
 * 「读录音账本是前景窗口才有的权利，而这一屏从前把**被拒**画成**读不出**」。
 *
 * 宿主侧 `recordings_list` 现在走 `require_recordings_foreground`（与 `clipboard_read`、
 * 短信读取、信箱读取、录音开关同一条规则，`crate::clipboard::require_foreground`）；而 `refresh`
 * 从前把 `recordings_list` 的 `null` 一律画成 `recordings.unreadable` —— 那是一句关于**账本**
 * 的话，而被拒根本不是账本的事：这一屏自己的读都在自己窗口里发生，只有「发出之后、宿主执行
 * 之前换走了焦点」才会落地为拒（`invoke` 是异步的）。所以这一轮把三种 `null` 分开：
 * 没有桥 → 读不出；宿主答 `amos.recordings.foreground_required` → 「未读取，回来时补上」并记
 * 一笔欠读；账本真的读不出来（`amos.recordings.read_failed`）→ 读不出，且不重试。
 *
 * 从**组件之外**派发 `window` 的 focus（真实用户在窗口之间切回来时浏览器做的事），然后数宿主
 * 被问了几次 —— 既有套件看不到这个缺陷，因为那些用例都跑在「窗口一直有焦点」的世界里，那里的
 * `null` 只可能来自没有桥。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import RecordingsPage from "../src/svelte/settings/RecordingsPage.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const FOREGROUND_CODE = "amos.recordings.foreground_required";

const REC_A = {
  call_id: "tel_a",
  peer: "13800138000",
  started_at: 1726560000,
  duration_sec: 65,
  file_size_bytes: 1_500_000,
};
const REC_B = {
  call_id: "tel_b",
  peer: "10086",
  started_at: 1726563600,
  duration_sec: 3725,
  file_size_bytes: 300,
};

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const focus = () => window.dispatchEvent(new Event("focus"));

/**
 * A device bridge whose `recordings_list` fails until `allowReads()` — and it fails the way the
 * host fails: the command **rejects**, `invoke` folds that into `null` and keeps the payload in
 * `bridgeDiag("recordings_list").detail`, which is where the caller reads *which* refusal it was.
 * `refusal` is what the host sends: the typed recordings envelope, or a plain read error.
 */
function installHost(refusal: { code?: string; message?: string }) {
  const calls: string[] = [];
  let allow = false;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "recordings_list") {
        if (!allow) throw refusal;
        return [REC_A, REC_B];
      }
      if (cmd === "recordings_capture_status") return { available: true, reason: "" };
      return null;
    },
    listen: async () => () => {},
  };
  return {
    reads: () => calls.filter((c) => c === "recordings_list").length,
    allowReads: () => {
      allow = true;
    },
  };
}

beforeEach(() => setLocale("zh"));
afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("RecordingsPage — 读录音账本要用户正在看着这个窗口", () => {
  test("被前景规则拒绝：不画成读不出，回到这个窗口时补上这次读", async () => {
    const host = installHost({
      code: FOREGROUND_CODE,
      message:
        "[amos.recordings.foreground_required] recordings read refused: 'settings' is not the foreground window",
    });
    const view = render(RecordingsPage);
    await vi.waitFor(() => expect(txt(view)).toContain(zh["recordings.readRefused"]));

    // Not a claim about the ledger: "unreadable" would be a fact about this device's storage, and
    // the ledger is fine — the host refused *this window*.
    expect(txt(view)).not.toContain(zh["recordings.unreadable"]);
    expect(txt(view)).not.toContain("13800138000");

    // Coming back is the moment the owed read is paid.
    const before = host.reads();
    host.allowReads();
    focus();
    await vi.waitFor(() => expect(txt(view)).toContain("13800138000"));
    expect(host.reads()).toBeGreaterThan(before);
    expect(txt(view)).not.toContain(zh["recordings.readRefused"]);
  });

  test("账本真的读不出来：说读不出，且不去重试（那不是欠读）", async () => {
    const host = installHost({
      code: "amos.recordings.read_failed",
      message: "could not read the recording index: corrupt",
    });
    const view = render(RecordingsPage);
    await vi.waitFor(() => expect(txt(view)).toContain(zh["recordings.unreadable"]));

    expect(txt(view)).not.toContain(zh["recordings.readRefused"]);

    const before = host.reads();
    focus();
    await new Promise((r) => setTimeout(r, 20));
    expect(host.reads()).toBe(before);
    expect(txt(view)).toContain(zh["recordings.unreadable"]);
  });

  test("没有桥：照旧是读不出那一句，聚焦不会把它变成一次读", async () => {
    const view = render(RecordingsPage);
    await vi.waitFor(() => expect(txt(view)).toContain(zh["recordings.unreadable"]));
    expect(txt(view)).not.toContain(zh["recordings.readRefused"]);

    // No bridge at all: there is nothing to re-read, and nothing was owed.
    focus();
    await new Promise((r) => setTimeout(r, 20));
    expect(txt(view)).toContain(zh["recordings.unreadable"]);
  });
});
