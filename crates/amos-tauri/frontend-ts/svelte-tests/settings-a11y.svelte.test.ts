/**
 * settings-a11y.svelte.test.ts — the **DOM-level** half of the Settings label↔field audit
 * (REQ-A283).
 *
 * `scripts/a11y-scan.mjs` is a text heuristic: it can see that a page writes a visual label
 * and a control, not whether the control ends up **named**. This suite mounts the fourteen
 * Settings surfaces the audit flagged and asserts the association on the real DOM:
 *
 *   • explicit cases — `getByRole(role, { name })` runs the same accessible-name computation
 *     (`dom-accessibility-api`) a screen reader follows, so a green line here means "the
 *     visible label IS the control's name" (WCAG 2.5.3 Label in Name), not "there is an aria
 *     attribute somewhere";
 *   • a sweep — every `input`/`textarea`/`select`/`[role=switch]`/`[role=radiogroup]` in those
 *     pages must resolve a name through one of the three mechanisms the audit accepts
 *     (`aria-label`, `aria-labelledby`, `<label for=…>`), so a *new* control nobody labels
 *     fails here even though no explicit case mentions it.
 *
 * The three defects this suite was written against (all in the flagged pages):
 *   1. `DisplayPage` / `LanguagePage` named their `<Segmented>` rows with the English slug —
 *      `aria="appearance"` / `aria="auto-screen-off"` / `aria="language"` — while the visible
 *      text is Chinese: a screen reader read a string no sighted user can see;
 *   2. `AiPage`'s three cloud fields (model / endpoint / API key) were captioned by a plain
 *      `<span>` and had no label at all — only a placeholder, which is not a name;
 *   3. `LockPage`'s passcode field was likewise placeholder-only.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { t } from "../src/svelte/locale.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { SETTINGS_KEY, normalizeQuick, type QuickSettings } from "../src/lib/settings";
import AccountPage from "../src/svelte/settings/AccountPage.svelte";
import AiPage from "../src/svelte/settings/AiPage.svelte";
import CellularPage from "../src/svelte/settings/CellularPage.svelte";
import ChoiceRow from "../src/svelte/settings/ChoiceRow.svelte";
import DisplayPage from "../src/svelte/settings/DisplayPage.svelte";
import FocusPage from "../src/svelte/settings/FocusPage.svelte";
import DockPage from "../src/svelte/settings/DockPage.svelte";
import HotCornersPage from "../src/svelte/settings/HotCornersPage.svelte";
import HotspotPage from "../src/svelte/settings/HotspotPage.svelte";
import ImePage from "../src/svelte/settings/ImePage.svelte";
import LanguagePage from "../src/svelte/settings/LanguagePage.svelte";
import LockPage from "../src/svelte/settings/LockPage.svelte";
import NetGuardPage from "../src/svelte/settings/NetGuardPage.svelte";
import NotificationsPage from "../src/svelte/settings/NotificationsPage.svelte";
import RadioPage from "../src/svelte/settings/RadioPage.svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import SoundPage from "../src/svelte/settings/SoundPage.svelte";
import ToggleRow from "../src/svelte/settings/ToggleRow.svelte";

afterEach(cleanup);

const qs = (over: Record<string, unknown> = {}): QuickSettings =>
  normalizeQuick({ wifi: true, bluetooth: true, hotspot: false, airplane: false, ...over });

type Host = { container: HTMLElement };

const CONTROLS = 'input, textarea, select, [role="switch"], [role="radiogroup"]';

/**
 * The three name sources the audit wires, resolved straight off the DOM: `aria-label`,
 * `aria-labelledby` (→ the referenced element's text), or an associated `<label for=…>`.
 *
 * Deliberately *not* a full accname implementation (no `aria-hidden` pruning, no name-from-
 * content): its job is to answer "did the row bind anything to this control at all?" — the
 * explicit `getByRole(…, { name })` cases below prove the name is the *right* one.
 */
function nameOf(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label && label.trim()) return label.trim();
  const ref = el.getAttribute("aria-labelledby");
  if (ref) {
    const text = ref
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  const id = el.id;
  if (id) {
    const bound = el.ownerDocument.querySelector(`label[for="${id}"]`);
    const text = (bound?.textContent ?? "").trim();
    if (text) return text;
  }
  return "";
}

/** Every control in the mounted surface must have a name — whichever row renders it. */
function expectEveryControlNamed(host: Host, page: string) {
  const controls = [...host.container.querySelectorAll(CONTROLS)].filter(
    (el) => el.getAttribute("aria-hidden") !== "true",
  );
  expect(controls.length, `${page}: expected at least one control to check`).toBeGreaterThan(0);
  const unnamed = controls.filter((el) => nameOf(el) === "");
  expect(
    unnamed.map((el) => el.outerHTML.slice(0, 120)),
    `${page}: control(s) with no accessible name`,
  ).toEqual([]);
}

describe("the row primitives bind the visible label to the control (REQ-A283)", () => {
  test("ToggleRow: the name is the visible text, and clicking the label still toggles", async () => {
    let flipped = 0;
    const host = render(ToggleRow, {
      props: { label: "自动息屏", on: false, ontoggle: () => flipped++ },
    });
    // `getByRole({ name })` = the real accname computation: the visible text is the name.
    const sw = host.getByRole("switch", { name: "自动息屏" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    // `<label for>` on a `<button>` (a labelable element) forwards the click to the switch.
    const label = host.container.querySelector("label") as HTMLLabelElement;
    expect(label.getAttribute("for")).toBe(sw.id);
    expect(sw.id).not.toBe("");
    await fireEvent.click(label);
    expect(flipped).toBe(1);
  });

  test("ChoiceRow: the radiogroup is named by the visible label, not by a slug", () => {
    const host = render(ChoiceRow, {
      props: {
        label: "外观",
        options: [
          { value: "light", label: "浅色" },
          { value: "dark", label: "深色" },
        ],
        value: "light",
        onpick: () => {},
      },
    });
    const group = host.getByRole("radiogroup", { name: "外观" });
    // The label hands out both ids: `for` (inert for a composite widget) and the `labelledby`
    // target that actually names the group — the two can never drift because Field mints both.
    const label = host.container.querySelector("label") as HTMLLabelElement;
    expect(group.getAttribute("aria-labelledby")).toBe(label.id);
    expect(label.getAttribute("for")).toBe(group.id);
  });
});


describe("every flagged Settings surface names its controls (REQ-A283)", () => {
  test("AccountPage — the iCloud switch", () => {
    const host = render(AccountPage);
    expect(host.getByRole("switch", { name: t("settings.icloud") })).toBeTruthy();
    expectEveryControlNamed(host, "AccountPage");
  });

  test("CellularPage — data + roaming", () => {
    const host = render(CellularPage);
    expect(host.getByRole("switch", { name: t("settings.cellularData") })).toBeTruthy();
    expect(host.getByRole("switch", { name: t("settings.cellularRoaming") })).toBeTruthy();
    expectEveryControlNamed(host, "CellularPage");
  });

  test("DisplayPage — 外观 / 自动息屏 are named by their CHINESE labels, not by a slug", () => {
    const host = render(DisplayPage);
    expect(host.getByRole("radiogroup", { name: t("settings.appearance") })).toBeTruthy();
    expect(host.getByRole("radiogroup", { name: t("settings.autoOff") })).toBeTruthy();
    expect(host.getByRole("switch", { name: t("settings.wakeHome") })).toBeTruthy();
    // The pre-fix names were `appearance` / `auto-screen-off`: assert they are gone, so a
    // regression back to a slug fails instead of merely being a different green.
    expect(host.queryByRole("radiogroup", { name: "appearance" })).toBeNull();
    expect(host.queryByRole("radiogroup", { name: "auto-screen-off" })).toBeNull();
    expectEveryControlNamed(host, "DisplayPage");
  });

  test("LanguagePage — the 语言 row is named by the visible text", () => {
    const host = render(LanguagePage);
    expect(host.getByRole("radiogroup", { name: t("settings.language") })).toBeTruthy();
    expect(host.queryByRole("radiogroup", { name: "language" })).toBeNull();
    expectEveryControlNamed(host, "LanguagePage");
  });

  test("FocusPage — 勿扰 + the intent scenarios", () => {
    const host = render(FocusPage);
    expect(host.getByRole("switch", { name: t("settings.focusDnd") })).toBeTruthy();
    expect(host.getByRole("switch", { name: t("settings.focusWork") })).toBeTruthy();
    expect(host.getByRole("switch", { name: t("settings.focusSleep") })).toBeTruthy();
    expectEveryControlNamed(host, "FocusPage");
  });

  test("DockPage — 位置/开关/滑块各自有可见名（REQ-A386）", () => {
    const host = render(DockPage);
    // 位置是一**组**按钮 ⇒ 由 `role="group"` + `aria-labelledby` 命名整组。
    const group = host.container.querySelector('[role="group"]');
    expect(group).toBeTruthy();
    expect(group?.getAttribute("aria-labelledby")).toBeTruthy();
    // 自动隐藏开关由**可见标题**命名（不是 aria-label 抄一遍）。
    expect(host.getByRole("switch", { name: t("settings.dock.autoHide") })).toBeTruthy();
    // 两个滑块由各自的可见标签命名。
    expect(host.getByRole("slider", { name: t("settings.dock.magnification") })).toBeTruthy();
    expect(host.getByRole("slider", { name: t("settings.dock.iconSize") })).toBeTruthy();
    expectEveryControlNamed(host, "DockPage");
  });

  test("HotCornersPage — 每个角落的三处控件都有自己的可见名（REQ-A386）", () => {
    const host = render(HotCornersPage);
    // 四个角落各有一个动作选择器；它们的名字就是该角落的可见标题。
    const selects = host.container.querySelectorAll("select");
    expect(selects.length).toBeGreaterThanOrEqual(4);
    // 每一个 select 都能被它的 `label[for]` 命名（id 与 for 真的对上了）。
    for (const sel of selects) {
      const id = sel.getAttribute("id");
      expect(id, "HotCornersPage: a select without an id cannot be named").toBeTruthy();
      const label = host.container.querySelector(`label[for="${id}"]`);
      expect(label?.textContent?.trim()).toBeTruthy();
    }
    expectEveryControlNamed(host, "HotCornersPage");
  });

  test("NotificationsPage — the 勿扰 switch", () => {
    const host = render(NotificationsPage);
    expect(host.getByRole("switch", { name: t("settings.dnd") })).toBeTruthy();
    expectEveryControlNamed(host, "NotificationsPage");
  });

  test("SoundPage — both switches and the volume slider", () => {
    const host = render(SoundPage);
    expect(host.getByRole("switch", { name: t("settings.notifySound") })).toBeTruthy();
    expect(host.getByRole("switch", { name: t("settings.haptics") })).toBeTruthy();
    expect(host.getByRole("slider", { name: t("settings.notifyVolume") })).toBeTruthy();
    expectEveryControlNamed(host, "SoundPage");
  });

  test("LockPage — the enable switch, and the passcode field is not placeholder-only", async () => {
    const host = render(LockPage);
    const enable = host.getByRole("switch", { name: t("lock.enable") });
    await fireEvent.click(enable);
    const pin = host.getByRole("textbox", { name: t("lock.pin") }) as HTMLInputElement;
    // This field's only visible affordance is its placeholder, so its name is the aria-label
    // carrying exactly that string — the placeholder is no longer the *only* thing naming it.
    expect(pin.getAttribute("aria-label")).toBe(t("lock.pin"));
    expect(pin.getAttribute("placeholder")).toBe(t("lock.pin"));
    expectEveryControlNamed(host, "LockPage");
  });

  test("ImePage — the keyboard switch", () => {
    const host = render(ImePage);
    expect(host.getByRole("switch", { name: t("settings.imeKeyboard") })).toBeTruthy();
    expectEveryControlNamed(host, "ImePage");
  });

  test("NetGuardPage — the guard switch (the 🛡️ glyph is decoration, never part of the name)", () => {
    const host = render(NetGuardPage);
    expect(host.getByRole("switch", { name: t("settings.guard") })).toBeTruthy();
    expectEveryControlNamed(host, "NetGuardPage");
  });

  test("AiPage — the cloud fields are named by their captions", () => {
    writeStoreValue(SETTINGS_KEY, { aiProvider: "deepseek" });
    const host = render(AiPage);
    expect(host.getByRole("textbox", { name: t("settings.aiModel") })).toBeTruthy();
    expect(host.getByRole("textbox", { name: t("settings.aiEndpoint") })).toBeTruthy();
    // A password field carries no ARIA role, so the API-key row is asserted structurally.
    const key = host.container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(host.container.querySelector(`label[for="${key.id}"]`)?.textContent?.trim()).toBe(
      t("settings.aiKey"),
    );
    expectEveryControlNamed(host, "AiPage");
  });

  test("HotspotPage — the switch + the three segmented rows + both text fields", () => {
    const host = render(HotspotPage, { props: { qs: qs(), onToggle: () => {} } });
    expect(host.getByRole("switch", { name: t("settings.hotspot") })).toBeTruthy();
    expect(host.getByRole("textbox", { name: t("settings.hotspotName") })).toBeTruthy();
    expect(host.getByRole("radiogroup", { name: t("settings.hotspotBand") })).toBeTruthy();
    expect(host.getByRole("radiogroup", { name: t("settings.hotspotSecurity") })).toBeTruthy();
    expect(host.getByRole("radiogroup", { name: t("settings.hotspotMaxClients") })).toBeTruthy();
    expectEveryControlNamed(host, "HotspotPage");
  });

  test("RadioPage — Wi-Fi and Bluetooth", () => {
    const wifi = render(RadioPage, { props: { which: "wifi", qs: qs(), onToggle: () => {} } });
    expect(wifi.getByRole("switch", { name: t("settings.wifi") })).toBeTruthy();
    expectEveryControlNamed(wifi, "RadioPage(wifi)");
    cleanup();

    const bt = render(RadioPage, { props: { which: "bluetooth", qs: qs(), onToggle: () => {} } });
    expect(bt.getByRole("switch", { name: t("settings.bluetooth") })).toBeTruthy();
    expect(bt.getByRole("switch", { name: t("settings.btDiscoverable") })).toBeTruthy();
    // The rename field already carried an `aria-label` — it must stay named.
    expect(bt.getByRole("textbox", { name: t("settings.btRename") })).toBeTruthy();
    expectEveryControlNamed(bt, "RadioPage(bluetooth)");
  });

  test("SettingsApp — the index switch rows + the search field", () => {
    const host = render(SettingsApp);
    expect(host.getByRole("searchbox", { name: t("settings.searchPlaceholder") })).toBeTruthy();
    // The index renders one switch per `switch` row of SECTIONS; each must be named.
    const switches = host.getAllByRole("switch");
    expect(switches.length).toBeGreaterThan(0);
    for (const sw of switches) {
      expect(sw.getAttribute("aria-labelledby") ?? sw.getAttribute("aria-label")).toBeTruthy();
    }
    expectEveryControlNamed(host, "SettingsApp");
  });
});
