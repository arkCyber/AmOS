/**
 * REQ-A1493 / F-SH-733 — a recording whose audio bytes are gone is not "no host".
 *
 * A `recorded` memo names its bytes by id in the MediaStore; the row can outlive the blob
 * (an evicted store, a device migration, the refused-index-write orphan REQ-A1264 catches).
 * When that happens both of the app's *audio-consuming* verbs looked at `defaultMediaStore().get(id)`,
 * saw nothing, and rendered the **host** sentence:
 *
 *   • 保存到「录音」目录 → `outcome: "offline"` → 「没有系统宿主，无法写入系统录音」
 *   • 转写             → `{kind:"error", message:"offline"}` → 「没有系统宿主，无法进行转写」
 *
 * Neither path ever asked the host anything — no `media_save`, no `transcribe_audio` — so
 * 「没有系统宿主」 is a cause the code never established. The tell is the third verb that
 * consumes the same bytes: `saveTrim` says 「音频数据不可用」 (`vm.trimErr.offline`) for the
 * identical condition, and `exportLabel` already carries an arm for it (`vm.exportEmpty`,
 * 「这条备忘录没有可写入的音频数据」) that no code path could reach.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import VoiceMemosApp from "../src/svelte/VoiceMemosApp.svelte";
import { defaultMediaStore } from "../src/lib/mediaStore";
import { zh } from "../src/i18n/locales/zh";

afterEach(cleanup);

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttonsByAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll(`button[aria-label="${aria}"]`)] as HTMLButtonElement[];

/** A `recorded` row whose blob was never written to (or is gone from) the MediaStore. */
const LOST = {
  id: "rec-lost",
  title: "丢失的录音",
  createdAt: 1,
  durationMs: 3000,
  audio: { kind: "recorded" },
  sizeBytes: 3,
  mime: "audio/ogg",
};

/** A host that would happily answer — so a "no host" claim is provably not what happened. */
function installHost() {
  const calls: string[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "media_save") return { id: "saved-1", name: "x.wav" };
      if (cmd === "transcribe_audio") return { text: "你好世界", recognized: true };
      return null;
    },
    listen: async () => () => {},
  };
  return calls;
}

afterEach(async () => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  await defaultMediaStore().del(LOST.id);
});

describe("VoiceMemosApp — a recording whose audio bytes are missing (REQ-A1493)", () => {
  test("exporting it says the audio is missing, not that there is no system host", async () => {
    window.localStorage.setItem("amos.vmemos", JSON.stringify([LOST]));
    const calls = installHost();
    const host = render(VoiceMemosApp);
    await fireEvent.click(buttonsByAria(host, zh["vm.export"]!)[0]!);
    await new Promise((r) => setTimeout(r, 20));

    expect(
      txt(host),
      "the memo has rows but no bytes — that is what to say",
    ).toContain(zh["vm.exportEmpty"]!);
    expect(
      txt(host),
      "the host was never asked, so it must not be blamed",
    ).not.toContain(zh["vm.exportOffline"]!);
    expect(calls.filter((c) => c === "media_save")).toHaveLength(0);
  });

  test("transcribing it says the audio is missing, not that there is no system host", async () => {
    window.localStorage.setItem("amos.vmemos", JSON.stringify([LOST]));
    const calls = installHost();
    const host = render(VoiceMemosApp);
    await fireEvent.click(
      host.container.querySelector(`button[aria-label="${LOST.title}"]`) as HTMLButtonElement,
    );
    await fireEvent.click(buttonsByAria(host, zh["vm.transcribe"]!)[0]!);
    await new Promise((r) => setTimeout(r, 20));

    expect(txt(host)).toContain(zh["vm.transcribeErr.audio"]!);
    expect(txt(host)).not.toContain(zh["vm.transcribeErr.offline"]!);
    expect(calls.filter((c) => c === "transcribe_audio")).toHaveLength(0);
  });

  // Companion leaf: the honest sentence must not be bought by saying it whenever a memo
  // is exported. With the bytes actually present the host is asked and its answer is drawn.
  test("a memo that does have bytes still exports through the host (control)", async () => {
    window.localStorage.setItem("amos.vmemos", JSON.stringify([LOST]));
    await defaultMediaStore().put(LOST.id, new Blob([new Uint8Array([1, 2, 3])]));
    installHost();
    const host = render(VoiceMemosApp);
    await fireEvent.click(buttonsByAria(host, zh["vm.export"]!)[0]!);
    let until = Date.now() + 500;
    while (Date.now() < until && !txt(host).includes(zh["vm.exportSaved"]!)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(txt(host)).toContain(zh["vm.exportSaved"]!);
    expect(txt(host)).not.toContain(zh["vm.exportEmpty"]!);
  });
});
