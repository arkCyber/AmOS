import { describe, expect, test } from "bun:test";
import {
  CALL_RINGTONE_IDS,
  RINGTONE_KEY,
  incomingRingPlan,
  makeCallRingSamples,
  normalizeCallRingtoneId,
  normalizeRingtonePrefs,
  type CallRingtoneId,
} from "../lib/callRingtone";

describe("callRingtone — the「来电铃声与振动」page's vocabulary", () => {
  test("the five ids are exactly what the settings page lists, and the key is durable", () => {
    expect(CALL_RINGTONE_IDS).toEqual(["classic", "modern", "piano", "guitar", "bell"]);
    expect(RINGTONE_KEY).toBe("amos.ringtone");
  });

  test("only a shipped id survives; junk and retired ids fall back to the default", () => {
    for (const id of CALL_RINGTONE_IDS) expect(normalizeCallRingtoneId(id)).toBe(id);
    expect(normalizeCallRingtoneId("nokia")).toBe("classic");
    expect(normalizeCallRingtoneId(42)).toBe("classic");
    expect(normalizeCallRingtoneId(null)).toBe("classic");
    expect(normalizeCallRingtoneId(undefined)).toBe("classic");
  });

  test("the legacy JSON-string blob is read through, vibrate bit included", () => {
    // The page wrote `JSON.stringify({selected, vibrate})`; an existing choice must
    // not be silently reset by the schema change.
    const legacy = JSON.stringify({ selected: "guitar", vibrate: false });
    expect(normalizeRingtonePrefs(legacy, true)).toEqual({ selected: "guitar", vibrate: false });
    // The same shape arriving already parsed.
    expect(normalizeRingtonePrefs({ selected: "piano", vibrate: true }, false)).toEqual({
      selected: "piano",
      vibrate: true,
    });
  });

  test("a blob without a vibrate bit takes the alert policy's bit (one truth source)", () => {
    expect(normalizeRingtonePrefs({ selected: "bell" }, false).vibrate).toBe(false);
    expect(normalizeRingtonePrefs({ selected: "bell" }, true).vibrate).toBe(true);
  });

  test("corrupt / missing blobs degrade to the default, never throw", () => {
    for (const raw of [null, undefined, "{not json", "[1,2]", 7, "nul"]) {
      expect(normalizeRingtonePrefs(raw, true)).toEqual({ selected: "classic", vibrate: true });
    }
    expect(normalizeRingtonePrefs({ selected: "x", vibrate: "yes" }, false)).toEqual({
      selected: "classic",
      vibrate: false,
    });
  });

  test("every id has an audible, clamped, non-empty motif — and they differ", () => {
    const rendered = CALL_RINGTONE_IDS.map((id) => makeCallRingSamples(id));
    for (const s of rendered) {
      expect(s.length).toBeGreaterThan(0);
      expect(s.some((v) => Math.abs(v) > 1e-4)).toBe(true); // not silence
      for (const v of s) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1);
      }
    }
    expect(new Set(rendered.map((s) => s.join())).size).toBe(CALL_RINGTONE_IDS.length);
  });

  test("an unknown id sounds the default motif, and a corrupt rate cannot poison it", () => {
    const classic = makeCallRingSamples("classic");
    const junk = makeCallRingSamples("nope");
    expect(junk.length).toBe(classic.length);
    expect(junk.join()).toBe(classic.join());
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = makeCallRingSamples("bell", rate);
      expect(s.length).toBeGreaterThan(0);
      for (const v of s) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("incomingRingPlan — the one decision the ringer asks for", () => {
  test("carries the chosen id, the haptic bit, and that id's samples", () => {
    const plan = incomingRingPlan(JSON.stringify({ selected: "bugle", vibrate: true }), true);
    expect(plan.id).toBe("classic"); // not a shipped id → default
    const bell = incomingRingPlan({ selected: "bell" }, false);
    expect(bell.id).toBe("bell");
    expect(bell.vibrate).toBe(false);
    expect(bell.samples.join()).toBe(makeCallRingSamples("bell").join());
  });

  test("vibration requires BOTH the alert policy and any legacy override to say so", () => {
    // No stored preference: the policy decides (it is the shared bit with SoundPage).
    expect(incomingRingPlan(null, true).vibrate).toBe(true);
    expect(incomingRingPlan(null, false).vibrate).toBe(false);
    // A legacy blob overrides the policy until the page migrates it.
    expect(incomingRingPlan(JSON.stringify({ vibrate: false }), true).vibrate).toBe(false);
  });

  test("never throws on hostile input", () => {
    for (const raw of [null, undefined, {}, [], 0, "{", Symbol.iterator]) {
      const plan = incomingRingPlan(raw, true);
      expect(CALL_RINGTONE_IDS).toContain(plan.id as CallRingtoneId);
      expect(plan.samples.length).toBeGreaterThan(0);
    }
  });
});
