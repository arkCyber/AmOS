/**
 * DOM tests for the Svelte 5 NFC screen (NfcApp.svelte) — the consumer half of the
 * `nfc_*` bridge that had no caller before.
 *
 * What is locked here is the **honesty** of the screen, not its pixels:
 *  • a host with no bridge says "not connected" and offers nothing;
 *  • a *disabled* adapter is never presented as a working reader: the scan button is
 *    disabled and no dispatch is ever requested (negative control);
 *  • `no-hardware` is a different message from `disabled` — the platform's own answer
 *    is shown as given, and **only** it may say the device has no NFC radio;
 *  • `unavailable` (the host could not ask) is a different message again, and is never
 *    worded as a hardware fact (REQ-A775 / F-AND-007);
 *  • a write that fails shows the glue's error string, and a write that succeeds
 *    reports the byte count the host returned — never a rounded-up success;
 *  • a tag only ever appears because the host pushed one on the event channel.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import NfcApp from "../src/svelte/NfcApp.svelte";
import { ndefTextRecord, ndefUriRecord, type NfcTag } from "../src/lib/nfc";
import { zh } from "../src/i18n/locales/zh";

/**
 * The screen renders *translated* copy (the notice is a key that `t()` resolves), so the
 * assertions below go through the dictionary instead of re-spelling a sentence — that way
 * a wording change cannot silently turn a real assertion into a vacuous one.
 */
const T = (key: string): string => (zh as unknown as Record<string, string>)[key] ?? key;
/**
 * A parameterized key's **static prefix**, for keys like `nfc.readFailed` whose dictionary value
 * is `"读取失败：{error}"`: `t()` substitutes the placeholders, so the raw value can never appear
 * in rendered copy and asserting on it would be a vacuous (or falsely red) comparison. The prefix
 * is still dictionary-driven, so a wording change cannot turn the assertion into a tautology.
 */
const Tp = (key: string): string => T(key).split("{")[0];

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = () => new Promise((r) => setTimeout(r, 30));
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const q = (h: { container: HTMLElement }, id: string) =>
  h.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

interface BridgeOpts {
  state?: string;
  available?: boolean;
  /** The host's own reason, carried only when `state` is `unavailable`. */
  detail?: string;
  start?: boolean | null;
  stop?: boolean | null;
  write?: unknown;
  format?: boolean | null;
  /** The read reply. Default: a successful read of **the tag the caller asked about**, which is
   *  what a correct glue answers when the field holds the selected tag. A test that wants the
   *  glue to have read a *different* tag must say so explicitly. */
  read?: unknown;
  /** When true the bridge answers `null` to `nfc_status` (host without the service). */
  statusNull?: boolean;
}

/**
 * `undefined` = "this test did not configure it"; an explicit `null` means the host answered
 * nothing at all, which the old `opts.start ?? true` could not express (it read `null` as
 * "unset" and answered `true`).
 */
const answer = <T,>(v: T | null | undefined, dflt: T): T | null => (v === undefined ? dflt : v);

function installBridge(opts: BridgeOpts = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  let deliverTag: ((e: { payload: unknown }) => void) | null = null;

  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "nfc_status":
        return opts.statusNull
          ? null
          : {
              available: opts.available ?? true,
              state: opts.state ?? "enabled",
              ...(opts.detail === undefined ? {} : { detail: opts.detail }),
            };
      case "nfc_start_dispatch":
        return answer(opts.start, true);
      case "nfc_stop_dispatch":
        return answer(opts.stop, true);
      case "nfc_format_tag":
        return answer(opts.format, true);
      case "nfc_write_message":
        return opts.write === undefined ? { ok: true, bytesWritten: 12 } : opts.write;
      case "nfc_read_bytes":
        return opts.read === undefined
          ? { state: "bytes", tag_id: args?.tagId, hex: "deadbeef" }
          : opts.read;
      default:
        return null;
    }
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
      if (channel === "nfc-tag-discovered") deliverTag = handler;
      return () => {};
    },
  };

  return { calls, tag: (tag: NfcTag) => deliverTag?.({ payload: tag }) };
}

const TEXT_TAG: NfcTag = {
  id: "04a2b1c3",
  technology: "type2",
  ndef: true,
  records: [ndefTextRecord("hello", "en"), ndefUriRecord("https://example.com")],
};

const PLAIN_TAG: NfcTag = {
  id: "04ff00",
  technology: "iso14443",
  ndef: false,
  records: null,
};

describe("NfcApp — host without the system service", () => {
  test("no bridge: shows the offline state and offers no action", async () => {
    const h = render(NfcApp);
    await settle();
    expect(q(h, "nfc-offline")).not.toBeNull();
    expect(q(h, "nfc-toggle-scan")).toBeNull();
    expect(txt(h)).not.toContain("nfc.");
  });
});

describe("NfcApp — adapter state is the platform's own answer", () => {
  test("enabled: registers foreground dispatch on mount", async () => {
    const b = installBridge({ state: "enabled", start: true });
    const h = render(NfcApp);
    await settle();
    expect(b.calls.some((c) => c.cmd === "nfc_start_dispatch")).toBe(true);
    expect(q(h, "nfc-nohw-hint")).toBeNull();
    expect(q(h, "nfc-disabled-hint")).toBeNull();
    expect(q(h, "nfc-toggle-scan")).not.toBeNull();
  });

  test("dispatched=false is reported, not hidden", async () => {
    const b = installBridge({ state: "enabled", start: false });
    const h = render(NfcApp);
    await settle();
    expect(b.calls.some((c) => c.cmd === "nfc_start_dispatch")).toBe(true);
    // The registration was refused, so the list must say "not reading" — rendering the
    // "waiting for a tag" state would claim a scan that never started.
    const empty = q(h, "nfc-empty")?.textContent ?? "";
    expect(empty).toContain(T("nfc.notScanning"));
    expect(empty).not.toContain(T("nfc.waiting"));
  });

  test("disabled: hint shown, scan refused locally and never requested", async () => {
    const b = installBridge({ state: "disabled" });
    const h = render(NfcApp);
    await settle();
    expect(q(h, "nfc-disabled-hint")).not.toBeNull();
    const toggle = q(h, "nfc-toggle-scan") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    await fireEvent.click(toggle);
    expect(b.calls.some((c) => c.cmd === "nfc_start_dispatch")).toBe(false);
    expect(b.calls.some((c) => c.cmd === "nfc_stop_dispatch")).toBe(false);
  });

  test("no-hardware: its own message, and every action disabled", async () => {
    const b = installBridge({ state: "no-hardware", available: false });
    const h = render(NfcApp);
    await settle();
    expect(q(h, "nfc-nohw-hint")).not.toBeNull();
    expect(q(h, "nfc-disabled-hint")).toBeNull();
    expect(q(h, "nfc-unavailable-hint")).toBeNull();
    expect((q(h, "nfc-format") as HTMLButtonElement).disabled).toBe(true);
    expect((q(h, "nfc-write-btn") as HTMLButtonElement).disabled).toBe(true);
    expect(b.calls.some((c) => c.cmd === "nfc_start_dispatch")).toBe(false);
  });

  test("unavailable: the host could not ask — never worded as a hardware fact", async () => {
    // REQ-A775 / F-AND-007. This is the state an undeclared `android.permission.NFC`
    // produces (a `SecurityException` out of the NFC service). Before this test the
    // wire had no such state at all: it arrived as `no_hardware`, so the screen told
    // the user their phone had no NFC radio.
    const b = installBridge({
      state: "unavailable",
      available: false,
      detail: "java.lang.SecurityException: NFC permission not granted",
    });
    const h = render(NfcApp);
    await settle();
    const hint = q(h, "nfc-unavailable-hint");
    expect(hint).not.toBeNull();
    // The two hardware-shaped sentences must not appear for an unread adapter.
    expect(q(h, "nfc-nohw-hint")).toBeNull();
    expect(q(h, "nfc-disabled-hint")).toBeNull();
    expect(txt(h)).toContain(T("nfc.unavailableHint"));
    expect(txt(h)).not.toContain(T("nfc.noHardwareHint"));
    // The host's own reason is surfaced, so a bug report can tell an unbound glue from
    // a refused call instead of the user guessing.
    expect(q(h, "nfc-unavailable-detail")?.textContent).toContain("SecurityException");
    // Nothing is actionable, exactly as for the other non-enabled states.
    expect((q(h, "nfc-toggle-scan") as HTMLButtonElement).disabled).toBe(true);
    expect(b.calls.some((c) => c.cmd === "nfc_start_dispatch")).toBe(false);
  });

  test("the unavailable wording is not the no-hardware wording", async () => {
    // The ratchet: the two sentences exist to be different, so pin the text and not
    // just the branches — a copy-paste that made `unavailableHint` repeat
    // `noHardwareHint` would restore the defect while every branch above still passed.
    expect(T("nfc.unavailableHint")).not.toBe(T("nfc.noHardwareHint"));
    expect(T("nfc.state.unavailable")).not.toBe(T("nfc.state.noHardware"));
    for (const k of [
      "nfc.state.unavailable",
      "nfc.unavailableHint",
      "nfc.noHardwareHint",
    ] as const) {
      expect(T(k), `${k} must be in the zh dictionary`).not.toBe(k);
    }
  });

  test("a null status is 'not connected', not 'no hardware'", async () => {
    // REQ-A1518 / F-SH-760. The screen states this rule twice in its own prose — the
    // state alias (`null` = the bridge did not answer, "which is NOT 'no hardware'") and
    // `stateKey`'s doc, which records that an unread adapter used to print
    // 「本机没有 NFC 硬件」 on a phone with an NFC radio. Both were written for the
    // *label*; the hint under it still took `status === null` into the `no-hardware`
    // arm, so the card said 「未连接系统服务」 and, one line below, 「这台设备没有 NFC
    // 硬件」 — the exact sentence `stateKey`'s doc says must be unreachable except from
    // the platform's own `no-hardware`. This test used to assert only the disabled
    // toggle; its name claimed an invariant nothing checked.
    installBridge({ statusNull: true });
    const h = render(NfcApp);
    await settle();
    // A non-answer never becomes a success state: nothing is actionable.
    expect((q(h, "nfc-toggle-scan") as HTMLButtonElement).disabled).toBe(true);
    // …and it never becomes a claim about the user's device either.
    expect(q(h, "nfc-nohw-hint")).toBeNull();
    expect(txt(h)).not.toContain(T("nfc.noHardwareHint"));
    // The refused read gets the sentence written for exactly this case — the one that
    // says 「读不到」 and explicitly not 「手机没有 NFC 硬件」.
    expect(q(h, "nfc-status-unanswered")).not.toBeNull();
    expect(txt(h)).toContain(T("nfc.unavailableHint"));
  });

  test("the no-hardware hint belongs to the platform's own answer alone", async () => {
    // Paired arm: an answered `no-hardware` must still say so. Kills a "fix" that just
    // deletes the hint (or the sentence) instead of re-pointing it.
    installBridge({ state: "no-hardware", available: false });
    const h = render(NfcApp);
    await settle();
    expect(q(h, "nfc-nohw-hint")).not.toBeNull();
    expect(txt(h)).toContain(T("nfc.noHardwareHint"));
    expect(q(h, "nfc-status-unanswered")).toBeNull();
  });

  test("an unread adapter is not called a hardware fact before the read lands", async () => {
    // The same fold, one moment earlier: `status` starts `null`, so the first paint
    // (before `onMount`'s awaited probe resolves) hit the same arm. A flag set only by a
    // read that *landed* as `null` keeps 「还没问」 from flashing a hardware claim.
    const b = installBridge({ state: "enabled" });
    const h = render(NfcApp);
    // No `settle()`: this is the first render, probe still in flight.
    expect(b.calls.some((c) => c.cmd === "nfc_status")).toBe(true);
    expect(txt(h)).not.toContain(T("nfc.noHardwareHint"));
    expect(q(h, "nfc-nohw-hint")).toBeNull();
    await settle();
    expect(q(h, "nfc-nohw-hint")).toBeNull();
    expect(q(h, "nfc-status-unanswered")).toBeNull();
  });
});

describe("NfcApp — tags arrive only from the host", () => {
  test("the list starts empty and is not seeded", async () => {
    installBridge({ state: "enabled" });
    const h = render(NfcApp);
    await settle();
    expect(q(h, "nfc-empty")).not.toBeNull();
    expect(q(h, "nfc-detail")).toBeNull();
  });

  test("a pushed tag is listed, auto-selected, and its records decoded", async () => {
    const b = installBridge({ state: "enabled" });
    const h = render(NfcApp);
    await settle();
    b.tag(TEXT_TAG);
    await settle();
    expect(q(h, "nfc-tag-04a2b1c3")).not.toBeNull();
    expect(q(h, "nfc-detail-id")?.textContent).toContain("04a2b1c3");
    expect(q(h, "nfc-record-0")?.textContent ?? "").toContain("hello");
    expect(q(h, "nfc-record-1")?.textContent ?? "").toContain("https://example.com");
  });

  test("a tag without NDEF says so instead of showing an empty record list", async () => {
    const b = installBridge({ state: "enabled" });
    const h = render(NfcApp);
    await settle();
    b.tag(PLAIN_TAG);
    await settle();
    expect(q(h, "nfc-no-records")).not.toBeNull();
    expect(q(h, "nfc-record-0")).toBeNull();
  });

  test("the same tag held twice is not duplicated, and clear empties the list", async () => {
    const b = installBridge({ state: "enabled" });
    const h = render(NfcApp);
    await settle();
    b.tag(TEXT_TAG);
    b.tag(TEXT_TAG);
    await settle();
    expect(h.container.querySelectorAll('[data-testid^="nfc-tag-"]').length).toBe(1);
    await fireEvent.click(q(h, "nfc-clear") as HTMLElement);
    await settle();
    expect(q(h, "nfc-empty")).not.toBeNull();
  });
});


describe("NfcApp — write / format / read are reported as they happened", () => {
  test("write is disabled with an empty payload and enabled once text is typed", async () => {
    installBridge({ state: "enabled" });
    const h = render(NfcApp);
    await settle();
    expect((q(h, "nfc-write-btn") as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(q(h, "nfc-write-value") as HTMLElement, { target: { value: "hi" } });
    await settle();
    expect((q(h, "nfc-write-btn") as HTMLButtonElement).disabled).toBe(false);
  });

  test("a successful write reports the host's byte count", async () => {
    const b = installBridge({ state: "enabled", write: { ok: true, bytesWritten: 7 } });
    const h = render(NfcApp);
    await settle();
    await fireEvent.input(q(h, "nfc-write-value") as HTMLElement, { target: { value: "hi" } });
    await fireEvent.click(q(h, "nfc-write-btn") as HTMLElement);
    await settle();
    const call = b.calls.find((c) => c.cmd === "nfc_write_message");
    expect(call).toBeDefined();
    expect((call?.args?.records as unknown[]).length).toBe(1);
    expect(q(h, "nfc-notice")?.textContent).toContain("7");
  });

  test("a refused write surfaces the glue's error and claims nothing", async () => {
    installBridge({ state: "enabled", write: { ok: false, error: "writeNdefMessage refused" } });
    const h = render(NfcApp);
    await settle();
    await fireEvent.input(q(h, "nfc-write-value") as HTMLElement, { target: { value: "hi" } });
    await fireEvent.click(q(h, "nfc-write-btn") as HTMLElement);
    await settle();
    expect(q(h, "nfc-notice")?.textContent).toContain("writeNdefMessage refused");
  });

  test("URI mode composes an RTD_URI record", async () => {
    const b = installBridge({ state: "enabled" });
    const h = render(NfcApp);
    await settle();
    await fireEvent.click(q(h, "nfc-mode-uri") as HTMLElement);
    await fireEvent.input(q(h, "nfc-write-value") as HTMLElement, {
      target: { value: "https://example.com" },
    });
    await fireEvent.click(q(h, "nfc-write-btn") as HTMLElement);
    await settle();
    const records = b.calls.find((c) => c.cmd === "nfc_write_message")?.args?.records as {
      type: string;
    }[];
    expect(records[0]?.type.toLowerCase()).toBe("55"); // "U"
  });

  test("a read of the selected tag shows its hex and reports success", async () => {
    const b = installBridge({ state: "enabled" });
    const h = render(NfcApp);
    await settle();
    b.tag(TEXT_TAG);
    await settle();
    await fireEvent.click(q(h, "nfc-read") as HTMLElement);
    await settle();
    expect(b.calls.find((c) => c.cmd === "nfc_read_bytes")?.args?.tagId).toBe(TEXT_TAG.id);
    expect(q(h, "nfc-read-hex")?.textContent).toContain("deadbeef");
    // Nothing belongs to another tag, so that card must not be there at all.
    expect(q(h, "nfc-read-other")).toBeNull();
    expect(q(h, "nfc-notice")?.textContent).toContain(T("nfc.readOk"));
  });

  test("a tag that was read and holds nothing is not reported as a failed read", async () => {
    // (b) of the fold: the tag was read fine, it simply carries no NDEF message. Before
    // REQ-A781 this was the same `null` as "the read threw", so the screen printed
    // `nfc.readFailed` — "the system returned no tag bytes" — about a read that succeeded.
    const b = installBridge({ state: "enabled", read: { state: "empty", tag_id: TEXT_TAG.id } });
    const h = render(NfcApp);
    await settle();
    b.tag(TEXT_TAG);
    await settle();
    await fireEvent.click(q(h, "nfc-read") as HTMLElement);
    await settle();
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain(T("nfc.readNoPayload"));
    expect(notice).not.toContain(Tp("nfc.readFailed"));
    // The honest display copy — unreachable while the reply was `string | null`.
    expect(q(h, "nfc-read-hex")?.textContent).toContain(T("nfc.readEmpty"));
  });

  test("a zero-length payload reads as empty, not as a failure", async () => {
    const b = installBridge({ state: "enabled", read: { state: "bytes", tag_id: TEXT_TAG.id, hex: "" } });
    const h = render(NfcApp);
    await settle();
    b.tag(TEXT_TAG);
    await settle();
    await fireEvent.click(q(h, "nfc-read") as HTMLElement);
    await settle();
    expect(q(h, "nfc-read-hex")?.textContent).toContain(T("nfc.readEmpty"));
    expect(q(h, "nfc-notice")?.textContent).toContain(T("nfc.readOk"));
    expect(q(h, "nfc-notice")?.textContent).not.toContain(T("nfc.readNoPayload"));
  });

  test("nothing in the field is its own sentence, not a failed read", async () => {
    const b = installBridge({ state: "enabled", read: { state: "no-tag" } });
    const h = render(NfcApp);
    await settle();
    b.tag(TEXT_TAG);
    await settle();
    await fireEvent.click(q(h, "nfc-read") as HTMLElement);
    await settle();
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain(T("nfc.readNoTag"));
    expect(notice).not.toContain(Tp("nfc.readFailed"));
    expect(q(h, "nfc-read-hex")).toBeNull();
  });

  test("a read that threw shows the glue's own error, never a made-up one", async () => {
    const b = installBridge({
      state: "enabled",
      read: { state: "failed", tag_id: TEXT_TAG.id, detail: "TagLostException" },
    });
    const h = render(NfcApp);
    await settle();
    b.tag(TEXT_TAG);
    await settle();
    await fireEvent.click(q(h, "nfc-read") as HTMLElement);
    await settle();
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain("TagLostException");
    expect(notice).toContain(Tp("nfc.readFailed"));
  });

  test("a host that could not ask says so, and never blames the tag", async () => {
    // (d) of the fold: no binding, a JNI error, or a plain browser. The sentence must be
    // about **this app's reach** — `nfc.readFailed` claimed the system returned no bytes.
    const b = installBridge({
      state: "enabled",
      read: { state: "unavailable", detail: "this build has no Android NFC glue" },
    });
    const h = render(NfcApp);
    await settle();
    b.tag(TEXT_TAG);
    await settle();
    await fireEvent.click(q(h, "nfc-read") as HTMLElement);
    await settle();
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain(Tp("nfc.readUnavailable"));
    expect(notice).toContain("this build has no Android NFC glue");
    expect(notice).not.toContain(Tp("nfc.readFailed"));
    expect(notice).not.toContain(T("nfc.readNoPayload"));
  });

  test("bytes the glue read from another tag are not shown as the selected tag's", async () => {
    // The glue reads `lastTag` and takes no argument, so a read can answer about a tag the
    // user did not select. Showing that hex inside the selected tag's card is the defect.
    const b = installBridge({
      state: "enabled",
      read: { state: "bytes", tag_id: PLAIN_TAG.id, hex: "c0ffee" },
    });
    const h = render(NfcApp);
    await settle();
    b.tag(TEXT_TAG);
    await settle();
    await fireEvent.click(q(h, "nfc-read") as HTMLElement);
    await settle();
    // Not under the selected tag's name …
    expect(q(h, "nfc-read-hex")).toBeNull();
    // … but shown, labelled with the tag that actually answered.
    expect(q(h, "nfc-read-other-id")?.textContent).toContain(PLAIN_TAG.id);
    expect(q(h, "nfc-read-other-hex")?.textContent).toContain("c0ffee");
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain(Tp("nfc.readOtherTag"));
    expect(notice).toContain(PLAIN_TAG.id);
  });

  test("a bridge that says nothing at all is its own sentence, not the host's `unavailable`", async () => {
    // REQ-A1337: `null` (the host never answered) and `unavailable` (the host answered, in its
    // own words, that it could not ask) are two facts. The old wrapper folded the first into
    // the second and invented `detail: "not bridged"` to fill the slot — an English string this
    // module made up, rendered onto a Chinese screen. The test above pins the spoken case; this
    // one pins the silent case, and both must be about reach rather than about the tag.
    const b = installBridge({ state: "enabled", read: null });
    const h = render(NfcApp);
    await settle();
    b.tag(TEXT_TAG);
    await settle();
    await fireEvent.click(q(h, "nfc-read") as HTMLElement);
    await settle();
    expect(q(h, "nfc-read-hex")).toBeNull();
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain(Tp("nfc.readUnanswered"));
    expect(notice).not.toContain(Tp("nfc.readFailed"));
    expect(notice).not.toContain(Tp("nfc.readUnavailable"));
    // Nothing this side invented may reach the screen.
    expect(notice).not.toContain("not bridged");
  });

  test("selecting another tag clears bytes that belonged to the previous one", async () => {
    const b = installBridge({ state: "enabled" });
    const h = render(NfcApp);
    await settle();
    b.tag(TEXT_TAG);
    await settle();
    await fireEvent.click(q(h, "nfc-read") as HTMLElement);
    await settle();
    expect(q(h, "nfc-read-hex")).not.toBeNull();
    b.tag(PLAIN_TAG);
    await settle();
    // The newly pushed tag is selected, and the old tag's hex must not be attributed to it.
    expect(q(h, "nfc-read-hex")).toBeNull();
    expect(q(h, "nfc-read-other")).toBeNull();
  });

  test("format reaches the host and reports the accepted answer", async () => {
    const b = installBridge({ state: "enabled", format: true });
    const h = render(NfcApp);
    await settle();
    await fireEvent.click(q(h, "nfc-format") as HTMLElement);
    await settle();
    expect(b.calls.some((c) => c.cmd === "nfc_format_tag")).toBe(true);
    expect(q(h, "nfc-notice")?.textContent).toContain(T("nfc.formatOk"));
  });

  test("a refused format is not reported as success", async () => {
    installBridge({ state: "enabled", format: false });
    const h = render(NfcApp);
    await settle();
    await fireEvent.click(q(h, "nfc-format") as HTMLElement);
    await settle();
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain(T("nfc.formatFailed"));
    expect(notice).not.toContain(T("nfc.formatOk"));
  });
});

describe("NfcApp — lifetime", () => {
  test("unmounting releases the adapter it registered", async () => {
    const b = installBridge({ state: "enabled", start: true, stop: true });
    const h = render(NfcApp);
    await settle();
    h.unmount();
    await settle();
    expect(b.calls.some((c) => c.cmd === "nfc_stop_dispatch")).toBe(true);
  });
});

/**
 * REQ-A1337 / REQ-A1341 — "the host did not answer" is a fact of its own, and every direction
 * gets the sentence about the direction the user asked for.
 *
 * Two defects live here. (1) `?? false` merged "no answer" into "the platform refused", so the
 * screen named the **system** (dispatch), the **card** (format) or the **glue** (write, via an
 * English `"not bridged"` cause this module invented) as the refuser of a command nobody ran.
 * (2) `toggleScan` printed `nfc.scanFailed` — 「系统拒绝**启动**前台派发」 — in *both*
 * directions, so a refused stop announced a start, and it also cleared `broadcasting`, leaving
 * the screen reading 「尚未开始读取」 while the adapter was still registered.
 */
describe("NfcApp — 宿主没作答（REQ-A1337 / REQ-A1341）", () => {
  /** The three sentences that name a subject other than this app. None may be reached from
   *  an unanswered command. */
  const blames = ["nfc.scanFailed", "nfc.formatFailed", "nfc.readUnavailable"] as const;

  const assertNoBlame = (notice: string) => {
    for (const k of blames) {
      expect(notice, `「${T(k)}」names a subject this side never asked`).not.toContain(Tp(k));
    }
    expect(notice).not.toContain("not bridged");
  };

  test("宿主没答 start ⇒ 说「宿主没有回应」，绝不指名系统，且仍是未开始", async () => {
    installBridge({ state: "enabled", start: null });
    const h = render(NfcApp);
    await settle();
    await fireEvent.click(q(h, "nfc-toggle-scan") as HTMLElement);
    await settle();
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain(T("nfc.scanUnanswered"));
    expect(notice).not.toContain(T("nfc.scanFailed"));
    expect(notice).not.toContain(T("nfc.scanStarted"));
    assertNoBlame(notice);
    // No acknowledgement ⇒ no dispatch: the button must still offer to start.
    expect((q(h, "nfc-toggle-scan") as HTMLElement).textContent).toContain(T("nfc.startScan"));
  });

  test("宿主没答 stop ⇒ 不说「已停止」，读取仍是打开的", async () => {
    installBridge({ state: "enabled", start: true, stop: null });
    const h = render(NfcApp);
    await settle();
    // onMount registered dispatch, so the toggle now asks to stop.
    expect((q(h, "nfc-toggle-scan") as HTMLElement).textContent).toContain(T("nfc.stopScan"));
    await fireEvent.click(q(h, "nfc-toggle-scan") as HTMLElement);
    await settle();
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain(T("nfc.scanUnanswered"));
    expect(notice).not.toContain(T("nfc.scanStopped"));
    // Still dispatching: a stop that was never carried out changed nothing.
    expect((q(h, "nfc-toggle-scan") as HTMLElement).textContent).toContain(T("nfc.stopScan"));
  });

  test("系统拒绝 stop ⇒ 说的是「停止」没有成功，且不把读取画成已关闭", async () => {
    // The direction defect, reachable with the honest `false`: the old expression answered
    // `nfc.scanFailed` (a sentence about *starting*) for a request that asked to stop.
    installBridge({ state: "enabled", start: true, stop: false });
    const h = render(NfcApp);
    await settle();
    await fireEvent.click(q(h, "nfc-toggle-scan") as HTMLElement);
    await settle();
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain(T("nfc.stopFailed"));
    expect(notice).not.toContain(T("nfc.scanFailed"));
    expect(notice).not.toContain(T("nfc.scanStopped"));
    expect((q(h, "nfc-toggle-scan") as HTMLElement).textContent).toContain(T("nfc.stopScan"));
  });

  test("被拒绝的停止不清空「正在读取」——适配器还注册着", async () => {
    // Isolated from the sentence rule above: only the flag is read here, so a fix that words
    // the refusal correctly but still forgets the live dispatch fails this and not that one.
    installBridge({ state: "enabled", start: true, stop: false });
    const h = render(NfcApp);
    await settle();
    await fireEvent.click(q(h, "nfc-toggle-scan") as HTMLElement);
    await settle();
    const label = (q(h, "nfc-toggle-scan") as HTMLElement).textContent ?? "";
    expect(label).toContain(T("nfc.stopScan"));
    expect(label).not.toContain(T("nfc.startScan"));
    // …and the list must not claim "not reading" either.
    expect(q(h, "nfc-empty")?.textContent ?? "").not.toContain(T("nfc.notScanning"));
  });

  test("宿主没答 format ⇒ 不把卡片说成拒绝者，也不说格式化成功", async () => {
    installBridge({ state: "enabled", format: null });
    const h = render(NfcApp);
    await settle();
    await fireEvent.click(q(h, "nfc-format") as HTMLElement);
    await settle();
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain(T("nfc.formatUnanswered"));
    expect(notice).not.toContain(T("nfc.formatFailed"));
    expect(notice).not.toContain(T("nfc.formatOk"));
    assertNoBlame(notice);
  });

  test("宿主没答 write ⇒ 不说写入失败，也不把「not bridged」给用户看", async () => {
    installBridge({ state: "enabled", write: null });
    const h = render(NfcApp);
    await settle();
    await fireEvent.input(q(h, "nfc-write-value") as HTMLElement, { target: { value: "hi" } });
    await fireEvent.click(q(h, "nfc-write-btn") as HTMLElement);
    await settle();
    const notice = q(h, "nfc-notice")?.textContent ?? "";
    expect(notice).toContain(T("nfc.writeUnanswered"));
    expect(notice).not.toContain(Tp("nfc.writeFailed"));
    expect(notice).not.toContain(T("nfc.writeOk"));
    assertNoBlame(notice);
  });
});
