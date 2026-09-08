import { describe, expect, test } from "bun:test";
import {
  confidenceKey,
  isHigh,
  kindKey,
  kindLabel,
  SPY_HIT_EVENT,
  spyNotif,
  toSpyHit,
  type SpyHitPayload,
} from "../lib/telemetrySpy";
import { translate } from "../i18n";
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";

const HIT: SpyHitPayload = {
  ts_ms: 123,
  iface: "rmnet_data0",
  src_ip: "10.0.0.2",
  src_port: 53000,
  dst_ip: "203.0.113.9",
  dst_port: 53,
  protocol: "udp",
  hits: [{ kind: "imei", occurrences: 1, confidence: "high" }],
  payload_bytes: 40,
  severity: "high",
  confidence: "high",
};

describe("telemetry-spy egress audit bridge (pure helpers)", () => {
  test("event name matches the Rust bridge const", () => {
    expect(SPY_HIT_EVENT).toBe("telemetry-spy-hit");
  });

  test("toSpyHit accepts a well-shaped hit and preserves optional ports", () => {
    const h = toSpyHit(HIT);
    expect(h).not.toBeNull();
    expect(h!.ts_ms).toBe(123);
    expect(h!.iface).toBe("rmnet_data0");
    expect(h!.hits[0]!.kind).toBe("imei");
    expect(h!.protocol).toBe("udp");
    // absent ports normalize to null
    const noPorts = toSpyHit({ ...HIT, src_port: null, dst_port: null });
    expect(noPorts!.src_port).toBeNull();
    expect(noPorts!.dst_port).toBeNull();
  });

  test("toSpyHit rejects garbage and empty hits", () => {
    expect(toSpyHit(null)).toBeNull();
    expect(toSpyHit("nope")).toBeNull();
    expect(toSpyHit({ ts_ms: "x" })).toBeNull();
    expect(toSpyHit({ ts_ms: 1, iface: "en0", hits: [] })).toBeNull();
  });

  test("kindLabel renders a readable label", () => {
    expect(kindLabel("imei")).toBe("IMEI");
    expect(kindLabel("cell_id")).toBe("cell ID");
    expect(kindLabel("bogus")).toBe("unknown identifier");
  });

  test("isHigh only for high severity", () => {
    expect(isHigh(HIT)).toBe(true);
    expect(isHigh({ ...HIT, severity: "info" })).toBe(false);
  });

  test("spyNotif is durable and never echoes the identifier value", () => {
    const n = spyNotif(HIT, 999);
    expect(n.id).toBe("spy:123:rmnet_data0:imei");
    expect(n.time).toBe(999);
    expect(n.app).toBe("Telemetry spy");
    expect(n.title).toContain("IMEI");
    expect(n.body).toContain("203.0.113.9:53");
    // Must NOT contain the leaked identifier's numeric value anywhere.
    expect(JSON.stringify(n)).not.toContain("490154203237518");
    // No raw serial/imei/cell-id value is carried on the payload either.
    expect(JSON.stringify(HIT)).not.toContain("490154203237518");
  });

  test("spyNotif ids are distinct across repeated hits", () => {
    const a = spyNotif({ ...HIT, ts_ms: 1 }, 1);
    const b = spyNotif({ ...HIT, ts_ms: 2 }, 2);
    expect(a.id).not.toBe(b.id);
  });

  test("kindKey/confidenceKey map to the i18n key surface", () => {
    expect(kindKey("imei")).toBe("spy.kind.imei");
    expect(kindKey("cell_id")).toBe("spy.kind.cellId");
    expect(kindKey("serial")).toBe("spy.kind.serial");
    expect(kindKey("bogus")).toBe("spy.kind.unknown");
    expect(confidenceKey("high")).toBe("spy.conf.high");
    expect(confidenceKey("bogus")).toBe("spy.conf.unknown");
  });

  test("spyNotif localizes copy via a translator without echoing the value", () => {
    const tOf = (dict: typeof zh) => (k: string, p?: Record<string, string | number>) =>
      translate(dict, k, p);
    const nZh = spyNotif(HIT, 999, tOf(zh));
    expect(nZh.app).toBe("外发泄漏审计");
    expect(nZh.title).toContain("外发泄漏风险");
    expect(nZh.title).toContain("IMEI");
    const nEn = spyNotif(HIT, 999, tOf(en));
    expect(nEn.app).toBe("Telemetry Spy");
    expect(nEn.title).toBe("Outbound leak risk: IMEI");
    expect(nEn.body).toContain("evidence confidence: high");
    // Even localized, the notification never carries the identifier's numeric value.
    expect(JSON.stringify(nZh)).not.toContain("490154203237518");
    expect(JSON.stringify(nEn)).not.toContain("490154203237518");
  });
});
