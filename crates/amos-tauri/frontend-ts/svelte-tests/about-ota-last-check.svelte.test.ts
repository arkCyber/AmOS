/**
 * AboutPage.svelte — 「上次检查」 must quote the check the page just took.
 *
 * The row **was** fed by `readOtaCheckRecord()`, taken **once** at component construction,
 * and that record was written by exactly one producer: the shell's background poller
 * (`osOtaWatcher`). The check button below it (`checkForUpdate`) asks the host live and
 * renders the fresh verdict in its own headline — but never records the check it took. So
 * the page's own gesture is invisible to the row that exists to answer "when did we last
 * check for updates?": after pressing 「检查更新」 the headline describes a check taken now
 * while the row directly above it still quotes an older one — or 「尚未检查」, on a device
 * whose background poller has not landed yet. One fact (a check happened at T), two faces,
 * and the stale face is the one the user reads as "the last time".
 *
 * Three leaves, and the last two are what make the first mean something:
 *  • a check taken here is recorded and the row follows it;
 *  • a **host that did not answer** records nothing and stamps nothing — 「尚未检查」 stands,
 *    because "the host said nothing" is not a check result (the rule `osOtaWatcher` states
 *    for its own tick, applied to the button);
 *  • a **seeded** older record is *replaced*, which is what tells "the row reads the store
 *    at mount" apart from "the row follows the last check".
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AboutPage from "../src/svelte/settings/AboutPage.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";
import { writeStoreValueChecked } from "../src/lib/amosStore";
import { OTA_CHECK_KEY, type OtaCheckRecord } from "../src/lib/ota";
import { readOtaCheckRecord } from "../src/svelte/osOtaWatcher";

const NEVER = zh["settings.updateNeverChecked"];

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const settle = () => new Promise((r) => setTimeout(r, 40));
const byTest = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);
const rowText = (c: HTMLElement) => byTest(c, "update-last-check")?.textContent ?? "";

const UP_TO_DATE = {
  kind: "up_to_date",
  current_version: "0.1.0",
  channel: "stable",
  version: null,
  package_uri: null,
  package_bytes: null,
  reason_code: null,
  detail: null,
};
const ELIGIBLE = { ...UP_TO_DATE, kind: "eligible", version: "1.1.0" };

/** A bridge whose `ota_check` answer the test can swap (`null` = the host never answered). */
function checkBridge(answer: unknown) {
  let current = answer;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "system_health") return { battery_level_pct: 75, battery_charging: false };
      if (cmd === "ota_status") {
        return { current_version: "0.1.0", channel: "stable", configured: true, source: "/tmp/m.json" };
      }
      if (cmd === "ota_check") return current;
      return null;
    },
    listen: async () => () => {},
  };
  return { setAnswer: (a: unknown) => (current = a) };
}

const pressCheck = async (getByRole: (r: string, o: { name: string }) => HTMLElement) => {
  await fireEvent.click(getByRole("button", { name: zh["settings.updateCheck"] }));
  await tick();
  await settle();
};

describe("AboutPage.svelte — 「上次检查」 quotes the check just taken (REQ-A1530 ∕ F-SH-773)", () => {
  test("a check taken on this page is recorded, and the row follows it", async () => {
    checkBridge(UP_TO_DATE);
    const { container, getByRole } = render(AboutPage);
    await tick();
    await settle();

    expect(rowText(container)).toContain(NEVER);

    const before = Date.now();
    await pressCheck(getByRole);

    // The verdict landed…
    expect(byTest(container, "update-outcome")?.textContent ?? "").toContain(
      zh["settings.updateOutcome_uptodate"],
    );
    // …so the row that answers "when did we last check?" must not still say we never have.
    expect(rowText(container)).not.toContain(NEVER);

    const recorded = readOtaCheckRecord();
    expect(recorded, "the check taken here is a check — it is the record the row quotes").not.toBeNull();
    expect(recorded?.kind).toBe("up_to_date");
    expect(recorded?.at ?? 0).toBeGreaterThanOrEqual(before);
  });

  test("a host that did not answer records nothing and leaves 「尚未检查」 standing", async () => {
    checkBridge(null);
    const { container, getByRole } = render(AboutPage);
    await tick();
    await settle();

    expect(rowText(container)).toContain(NEVER);

    await pressCheck(getByRole);

    // No answer is no news: the verdict says so, and nothing may be stamped as a check.
    expect(byTest(container, "update-outcome")?.textContent ?? "").toContain(
      zh["settings.updateOutcome_offline"],
    );
    expect(rowText(container)).toContain(NEVER);
    expect(readOtaCheckRecord()).toBeNull();
  });

  test("a seeded older record is replaced by the check taken here", async () => {
    // 90 minutes back, not a whole day: the row renders only the *time of day*, so
    // a 24 h-old seed would print the same string as "now" and the negative control
    // below could never pass.
    const OLD_AT = Date.now() - 90 * 60 * 1000;
    const seeded: OtaCheckRecord = {
      at: OLD_AT,
      outcome: "up-to-date",
      kind: "up_to_date",
      version: null,
      reason_code: null,
    };
    expect(writeStoreValueChecked(OTA_CHECK_KEY, seeded)).toBe(true);

    checkBridge(ELIGIBLE);
    const { container, getByRole } = render(AboutPage);
    await tick();
    await settle();

    // At mount the row quotes the seeded (older) check.
    expect(rowText(container)).toContain(new Date(OLD_AT).toLocaleTimeString());
    expect(rowText(container)).not.toContain(NEVER);

    await pressCheck(getByRole);

    const recorded = readOtaCheckRecord();
    expect(recorded?.kind, "the row must describe the check just taken, not the seeded one").toBe(
      "eligible",
    );
    expect(rowText(container)).toContain(new Date(recorded!.at).toLocaleTimeString());
    expect(rowText(container)).not.toContain(new Date(OLD_AT).toLocaleTimeString());
  });
});
