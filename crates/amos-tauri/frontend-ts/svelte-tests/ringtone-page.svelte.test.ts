/**
 * ringtone-page.svelte.test.ts — the 「来电铃声与振动」page's controls actually
 * write what the ringer reads.
 *
 * The page's own copy promises three things: 「来电时播放的铃声」 (the chosen tone
 * plays for a call), 「来电时同时振动」 (it vibrates too) and 「播放当前选择的铃声」
 * (the preview sounds the pick). Before REQ-A993 / F-SH-314 the page wrote a private
 * `{selected, vibrate}` blob nothing read — so the ringer played one fixed file, no
 * code ever vibrated for a call, and the preview played the notification chime.
 *
 * The library layer (`lib/callRingtone`, `lib/sound`) is unit-tested; this pins the
 * **wiring**: which durable key each control writes, and that a legacy blob does not
 * silently re-enable a vibration the user turned off.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import RingtonePage from "../src/svelte/settings/RingtonePage.svelte";
import { RINGTONE_KEY, incomingRingPlan, normalizeRingtonePrefs } from "../src/lib/callRingtone";
import { SOUND_KEY, loadSound } from "../src/lib/sound";
import { readStoreValue } from "../src/lib/amosStore";

if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async () => null,
    listen: async () => () => {},
  };
}

/**
 * Only `amos.sound` — the key the migration *moves the bit into* — refuses `setItem`.
 * That is the asymmetry the migration has to survive: the strip of the retired record
 * rewrites a **shorter** JSON string (it drops a field), while the move writes a whole
 * new policy. `writeJson` refuses per `setItem` and quota is size-dependent, so the two
 * writes to two keys can disagree.
 */
let refuseSoundWrites = false;
let restoreStorage: (() => void) | null = null;

function installRefusingStorage(): void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (refuseSoundWrites && k === SOUND_KEY) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  restoreStorage = () => {
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
  };
}

/** The legacy record this page reads through once, plus a policy that still says ON. */
const seedLegacyOff = () => {
  window.localStorage.setItem(RINGTONE_KEY, JSON.stringify({ selected: "guitar", vibrate: false }));
  window.localStorage.setItem(SOUND_KEY, JSON.stringify({ ring: true, vibrate: true, volume: 1 }));
};

const blob = (key: string): Record<string, unknown> => {
  const raw = window.localStorage.getItem(key);
  const parsed: unknown = raw == null ? {} : JSON.parse(raw);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
};

/** The page writes its blob as a JSON *string* (the legacy shape), so read it back through. */
const ringtonePrefs = () =>
  normalizeRingtonePrefs(readStoreValue<unknown>(RINGTONE_KEY, null), true);

const rawRingtone = (): Record<string, unknown> => {
  const v = readStoreValue<unknown>(RINGTONE_KEY, null);
  const parsed: unknown = typeof v === "string" ? JSON.parse(v) : v;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
};

const option = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLElement>(`[data-testid="ringtone-option-${id}"]`)!;
const checked = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLElement>(`[data-testid="ringtone-option-${id}"] [data-testid="ringtone-selected"]`) !==
  null;
const switchEl = (c: HTMLElement) => c.querySelector<HTMLElement>('[role="switch"]')!;

beforeEach(() => {
  refuseSoundWrites = false;
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  restoreStorage?.();
  restoreStorage = null;
});

describe("RingtonePage.svelte — the pick reaches the durable key the ringer reads", () => {
  test("choosing a tone persists its id (and moves the ✓ marker with it)", async () => {
    const { container } = render(RingtonePage);
    await tick();
    expect(checked(container, "classic")).toBe(true); // default

    await fireEvent.click(option(container, "bell"));
    await tick();

    expect(ringtonePrefs().selected).toBe("bell");
    expect(checked(container, "bell")).toBe(true);
    expect(checked(container, "classic")).toBe(false);
  });

  test("the written blob carries the tone id and nothing else (the vibrate bit has one owner)", async () => {
    const { container } = render(RingtonePage);
    await tick();
    await fireEvent.click(option(container, "guitar"));
    await tick();
    expect(Object.keys(rawRingtone())).toEqual(["selected"]);
  });
});

describe("RingtonePage.svelte — the vibrate toggle writes the ONE shared policy bit", () => {
  test("flipping it writes lib/sound's amos.sound.vibrate, not a private blob", async () => {
    window.localStorage.setItem(SOUND_KEY, JSON.stringify({ ring: true, vibrate: true, volume: 1 }));
    const { container } = render(RingtonePage);
    await tick();
    expect(switchEl(container).getAttribute("aria-checked")).toBe("true");

    await fireEvent.click(switchEl(container));
    await tick();

    expect(switchEl(container).getAttribute("aria-checked")).toBe("false");
    expect(blob(SOUND_KEY).vibrate).toBe(false);
    // The tone blob never grows a vibrate bit — that is the whole point of the split.
    expect(blob(RINGTONE_KEY).vibrate).toBeUndefined();
    expect(readStoreValue<unknown>(SOUND_KEY, null)).not.toBeNull();
  });
});

describe("RingtonePage.svelte — a legacy blob does not silently re-enable vibration", () => {
  test("a stored {vibrate:false} migrates into the policy bit and shows as off", async () => {
    // The page's old format: `{selected, vibrate}` under amos.ringtone, while the
    // policy still says vibrate ON. The user turned vibration OFF; the page must not
    // snap it back on from the default.
    window.localStorage.setItem(
      RINGTONE_KEY,
      JSON.stringify({ selected: "guitar", vibrate: false }),
    );
    window.localStorage.setItem(SOUND_KEY, JSON.stringify({ ring: true, vibrate: true, volume: 1 }));

    const { container } = render(RingtonePage);
    await tick();

    expect(switchEl(container).getAttribute("aria-checked")).toBe("false");
    expect(checked(container, "guitar")).toBe(true);
    // The legacy bit was lifted into the single owner.
    expect(blob(SOUND_KEY).vibrate).toBe(false);
  });

  test("once migrated, the retired bit stops shadowing the policy — turning it ON rings with vibration (REQ-A1076)", async () => {
    // The old record keeps its `vibrate` field after the migration unless the page
    // retires it. `normalizeRingtonePrefs` reads that field through *once*, so a
    // stale `false` sits in front of the live policy forever: the toggle reads ON,
    // `amos.sound.vibrate` is true, and yet the ringer is handed `vibrate:false`.
    window.localStorage.setItem(
      RINGTONE_KEY,
      JSON.stringify({ selected: "guitar", vibrate: false }),
    );
    window.localStorage.setItem(SOUND_KEY, JSON.stringify({ ring: true, vibrate: true, volume: 1 }));

    const { container } = render(RingtonePage);
    await tick();
    // The old bit is gone from the retired record — it has one owner now.
    expect(rawRingtone().vibrate).toBeUndefined();

    await fireEvent.click(switchEl(container)); // the user turns vibration ON
    await tick();
    expect(blob(SOUND_KEY).vibrate).toBe(true);

    // `callTone.playIncomingRing` decides with exactly this call.
    const plan = incomingRingPlan(readStoreValue<unknown>(RINGTONE_KEY, null), loadSound().vibrate);
    expect(plan.vibrate).toBe(true);
  });
});

/**
 * REQ-A1452 ∕ FMEA F-SH-703 — the migration's two writes are ordered by their verdicts.
 *
 * Moving the retired bit into its single owner is a **two-store** write: the bit is lifted
 * into `amos.sound`, and then the legacy field is deleted from `amos.ringtone`. That second
 * half is destructive and holds the *only* copy of the user's choice, so it may not run
 * until the first half landed — and `saveSound`'s verdict, which says whether it did, used
 * to be dropped on the floor. A refused move therefore destroyed the preference for good
 * (next launch reads the field's absence and falls back to the default), while the switch
 * was painted from the in-memory `migrated` value and so showed a vibrate state nothing had
 * taken. The same file already reads that verdict for the user's own toggle (F-SH-638); the
 * mount-time path was the sibling left behind.
 */
describe("RingtonePage.svelte — a refused migration loses neither the bit nor the truth", () => {
  test("a refused move leaves the legacy bit in place and shows the policy the ringer will use", async () => {
    seedLegacyOff();
    installRefusingStorage();
    refuseSoundWrites = true;

    const { container } = render(RingtonePage);
    await tick();

    // The authority (`amos.sound.vibrate`) never took the move, so the switch must not say
    // it did — the ringer is handed `loadSound().vibrate`, not this page's intent.
    expect(loadSound().vibrate).toBe(true);
    expect(switchEl(container).getAttribute("aria-checked")).toBe("true");
    // And the retired record keeps the field: it is the only copy of the user's choice.
    expect(rawRingtone().vibrate).toBe(false);
  });

  test("with writes accepted again, the next mount completes the same migration", async () => {
    seedLegacyOff();
    installRefusingStorage();
    refuseSoundWrites = true;
    render(RingtonePage);
    await tick();
    cleanup(); // leave the page with the migration still pending

    refuseSoundWrites = false;
    const { container } = render(RingtonePage);
    await tick();

    expect(blob(SOUND_KEY).vibrate).toBe(false);
    expect(rawRingtone().vibrate).toBeUndefined();
    expect(switchEl(container).getAttribute("aria-checked")).toBe("false");
  });
});
