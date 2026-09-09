import { describe, expect, test } from "bun:test";
import { statusIcons, wifiConnState } from "../lib/netStatus";

describe("netStatus", () => {
  test("wifiConnState: connected when enabled AND online, shows joined SSID", () => {
    expect(
      wifiConnState({ enabled: true, online: true, joinedSsid: "AmOS-5G" }),
    ).toEqual({ connected: true, detail: "Wi‑Fi · AmOS-5G" });
    expect(wifiConnState({ enabled: true, online: true, joinedSsid: null })).toEqual({
      connected: true,
      detail: "Wi‑Fi",
    });
  });

  test("wifiConnState: joined an AP but no internet is still connected (no bars invented)", () => {
    expect(
      wifiConnState({ enabled: true, online: false, joinedSsid: "Home-2.4G" }),
    ).toEqual({
      connected: true,
      detail: "Wi‑Fi · Home-2.4G · no internet",
    });
  });

  test("wifiConnState: enabled but nothing joined + offline → searching (not connected)", () => {
    expect(
      wifiConnState({ enabled: true, online: false, joinedSsid: null }),
    ).toEqual({ connected: false, detail: "Wi‑Fi: no connection" });
  });

  test("wifiConnState: radio off → not connected, no detail", () => {
    expect(wifiConnState({ enabled: false, online: true, joinedSsid: null })).toEqual({
      connected: false,
      detail: null,
    });
  });

  test("statusIcons: airplane mode supersedes every other radio", () => {
    expect(statusIcons({ airplane: true, wifi: true, bluetooth: true }, true, "X")).toEqual([
      { kind: "airplane", on: true, title: "Airplane mode" },
    ]);
  });

  test("statusIcons: wifi lit + SSID title when connected; bluetooth from toggle", () => {
    expect(statusIcons({ wifi: true, bluetooth: true }, true, "Cafe_Free")).toEqual([
      { kind: "wifi", on: true, title: "Wi‑Fi · Cafe_Free" },
      { kind: "bluetooth", on: true, title: "Bluetooth" },
    ]);
  });

  test("statusIcons: wifi dims (searching) when on but offline with nothing joined", () => {
    const icons = statusIcons({ wifi: true, bluetooth: true }, false, null);
    expect(icons[0]).toEqual({ kind: "wifi", on: false, title: "Wi‑Fi: no connection" });
    expect(icons[1]).toEqual({ kind: "bluetooth", on: true, title: "Bluetooth" });
  });

  test("statusIcons: everything off → both glyphs present but dimmed (matches legacy layout)", () => {
    const icons = statusIcons({}, true, null);
    expect(icons).toEqual([
      { kind: "wifi", on: false, title: undefined },
      { kind: "bluetooth", on: false, title: undefined },
    ]);
  });
});
