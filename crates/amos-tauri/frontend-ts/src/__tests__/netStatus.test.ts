import { describe, expect, test } from "bun:test";
import { statusIcons, wifiConnState } from "../lib/netStatus";
import { en } from "../i18n/locales/en";
import { zh } from "../i18n/locales/zh";

// The clarifications are i18n KEYS, not English sentences: the status bar renders
// them in the active locale (this module used to build "Wi‑Fi · SSID · no internet"
// in code — user-visible English copy in a zh+en OS; see REQ-A180).
const KEYS = Object.keys(zh);

describe("netStatus", () => {
  test("every key it can emit exists in BOTH dictionaries", () => {
    const emitted = [
      ...statusIcons({ wifi: true, airplane: true, bluetooth: true }, true, "X").map(
        (i) => i.titleKey,
      ),
      ...statusIcons({ wifi: true, bluetooth: true }, true, "X").map((i) => i.titleKey),
      ...statusIcons({ wifi: true, bluetooth: true }, false, "X").map((i) => i.titleKey),
      ...statusIcons({ wifi: true, bluetooth: true }, false, null).map((i) => i.titleKey),
      wifiConnState({ enabled: true, online: true, joinedSsid: null }).detailKey,
      wifiConnState({ enabled: true, online: false, joinedSsid: null }).detailKey,
    ].filter((k): k is string => typeof k === "string");
    expect(emitted.length).toBeGreaterThan(4);
    for (const k of emitted) {
      expect(KEYS).toContain(k);
      expect(Object.keys(en)).toContain(k);
    }
  });

  test("wifiConnState: connected when enabled AND online, key + joined SSID", () => {
    expect(wifiConnState({ enabled: true, online: true, joinedSsid: "AmOS-5G" })).toEqual({
      connected: true,
      detailKey: "a11y.wifiWithSsid",
      detailSsid: "AmOS-5G",
    });
    expect(wifiConnState({ enabled: true, online: true, joinedSsid: null })).toEqual({
      connected: true,
      detailKey: "a11y.wifi",
    });
  });

  test("wifiConnState: joined an AP but no internet is still connected (no bars invented)", () => {
    expect(wifiConnState({ enabled: true, online: false, joinedSsid: "Home-2.4G" })).toEqual({
      connected: true,
      detailKey: "a11y.wifiNoInternet",
      detailSsid: "Home-2.4G",
    });
  });

  test("wifiConnState: enabled but nothing joined + offline → searching (not connected)", () => {
    expect(wifiConnState({ enabled: true, online: false, joinedSsid: null })).toEqual({
      connected: false,
      detailKey: "a11y.wifiNoConnection",
    });
  });

  test("wifiConnState: radio off → not connected, no detail", () => {
    expect(wifiConnState({ enabled: false, online: true, joinedSsid: null })).toEqual({
      connected: false,
      detailKey: null,
    });
  });

  test("statusIcons: airplane mode supersedes every other radio", () => {
    expect(statusIcons({ airplane: true, wifi: true, bluetooth: true }, true, "X")).toEqual([
      { kind: "airplane", on: true, titleKey: "a11y.airplaneMode" },
    ]);
  });

  test("statusIcons: wifi lit + SSID title when connected; bluetooth from toggle", () => {
    expect(statusIcons({ wifi: true, bluetooth: true }, true, "Cafe_Free")).toEqual([
      { kind: "wifi", on: true, titleKey: "a11y.wifiWithSsid", titleSsid: "Cafe_Free" },
      { kind: "bluetooth", on: true, titleKey: "a11y.bluetooth" },
    ]);
  });

  test("statusIcons: wifi dims (searching) when on but offline with nothing joined", () => {
    const icons = statusIcons({ wifi: true, bluetooth: true }, false, null);
    expect(icons[0]).toEqual({ kind: "wifi", on: false, titleKey: "a11y.wifiNoConnection" });
    expect(icons[1]).toEqual({ kind: "bluetooth", on: true, titleKey: "a11y.bluetooth" });
  });

  test("statusIcons: everything off → both glyphs present but dimmed, no title (matches legacy layout)", () => {
    const icons = statusIcons({}, true, null);
    expect(icons).toEqual([
      { kind: "wifi", on: false },
      { kind: "bluetooth", on: false },
    ]);
  });
});
