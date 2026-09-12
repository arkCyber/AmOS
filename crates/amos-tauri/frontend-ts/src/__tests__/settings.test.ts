import { describe, expect, test } from "bun:test";
import { flipQuick, flipRadio, flipLocation, locationEnabled, dndActive, removeNotif, addNotif, newestAddedNotif, seedNotifs, countForApp, removeAppNotifs, normalizeQuick, normalizeNotifs, NOTIF_CAP, flipFlashlight, torchOn, normalizeFlashlight, type Notif, type FlashlightStore } from "../lib/settings";
import {
  BACKUP_VERSION,
  SETTINGS_KEY,
  SYNC_STORES,
  parseBackup,
  readCloud,
  restoreStores,
  setCloudPrefs,
  snapshotStores,
  summarizeBackup,
} from "../lib/cloud";
import { FILES_FAV_KEY } from "../lib/files";
import { CONV_KEY } from "../lib/messages";
import { NOTES_KEY } from "../lib/notes";
import { CONTACTS_KEY } from "../lib/contacts";
import { CALENDAR_KEY, CALENDARS_KEY } from "../lib/calendar";
import { ALARM_KEY } from "../lib/alarmCore";
import { CALLLOG_KEY } from "../lib/calllog";
import { VMEMOS_KEY } from "../lib/voiceMemos";
import { CAPTURES_KEY } from "../lib/cameraCapture";
import { DRAFT_KEY } from "../lib/smsDrafts";
import { INTERP_LOG_KEY } from "../lib/interp";
import { WIFI_KEY } from "../lib/wifi";
import { PERMISSIONS_KEY } from "../lib/permissions";

describe("settings / NC helpers", () => {
  test("flipQuick toggles immutably", () => {
    const s0 = { wifi: false };
    const s1 = flipQuick(s0, "wifi");
    expect(s1.wifi).toBe(true);
    expect(s0.wifi).toBe(false);
    expect(flipQuick(s1, "wifi").wifi).toBe(false);
  });

  test("location master defaults ON; flipLocation toggles it OFF first", () => {
    expect(locationEnabled({})).toBe(true); // unset → enabled
    expect(locationEnabled({ location: true })).toBe(true);
    expect(locationEnabled({ location: false })).toBe(false);

    // first tap turns it OFF (unset was treated as ON)
    expect(flipLocation({})).toEqual({ location: false });
    // second tap turns it back ON
    expect(flipLocation({ location: false })).toEqual({ location: true });
    expect(flipLocation({ location: true })).toEqual({ location: false });
  });

  test("dndActive is OFF by default, ON only when explicitly set", () => {
    expect(dndActive({})).toBe(false);
    expect(dndActive({ dnd: false })).toBe(false);
    expect(dndActive({ dnd: true })).toBe(true);
  });

  test("flipRadio toggles wifi/bt independently when airplane is off", () => {
    const s0 = {};
    const wifiOn = flipRadio(s0, "wifi");
    expect(wifiOn.wifi).toBe(true);
    expect(wifiOn.airplane).toBeUndefined();
    const btOn = flipRadio(s0, "bluetooth");
    expect(btOn.bluetooth).toBe(true);
    // toggling back off
    expect(flipRadio(wifiOn, "wifi").wifi).toBe(false);
  });

  test("flipRadio airplane ON cascades wifi + bluetooth off", () => {
    const before = { wifi: true, bluetooth: true };
    const next = flipRadio(before, "airplane");
    expect(next.airplane).toBe(true);
    expect(next.wifi).toBe(false);
    expect(next.bluetooth).toBe(false);
    // input untouched
    expect(before.wifi).toBe(true);
    expect(before.bluetooth).toBe(true);
  });

  test("flipRadio airplane OFF only clears airplane (no auto re-enable)", () => {
    const next = flipRadio({ airplane: true }, "airplane");
    expect(next.airplane).toBe(false);
    expect(next.wifi).toBeUndefined();
  });

  test("flipRadio gates wifi/bt while airplane is on (no-op)", () => {
    const gated = { airplane: true, wifi: false };
    expect(flipRadio(gated, "wifi")).toBe(gated); // unchanged reference
    expect(flipRadio(gated, "bluetooth").bluetooth).toBeUndefined();
  });

  test("newestAddedNotif reports only newly-added ids, newest time wins", () => {
    const prev = [
      { id: "a", app: "X", time: 1 },
      { id: "b", app: "Y", time: 2 },
    ];
    expect(newestAddedNotif(prev, prev)).toBeNull(); // nothing new
    expect(newestAddedNotif(prev, [])).toBeNull(); // shrink/clear → no arrival

    const curr = [
      ...prev,
      { id: "c", app: "Z", time: 5 },
      { id: "d", app: "W", time: 4 },
    ];
    const added = newestAddedNotif(prev, curr);
    expect(added?.id).toBe("c"); // newest by time

    // a removal of an existing id isn't an arrival
    const removed = [prev[0]!];
    expect(newestAddedNotif(prev, removed)).toBeNull();
  });

  test("notifications seed and dismiss", () => {
    const list = seedNotifs(1000);
    expect(list.length).toBe(3);
    const after = removeNotif(list, list[0]!.id);
    expect(after.length).toBe(2);
  });

  test("addNotif prepends newest-first and caps at NOTIF_CAP", () => {
    const base: Notif[] = [{ id: "a", time: 1 }];
    const n2: Notif = { id: "b", time: 2 };
    const next = addNotif(base, n2);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(n2); // newest on top
    // cap
    let many: Notif[] = [];
    for (let i = 0; i < NOTIF_CAP + 5; i++) many = addNotif(many, { id: `x${i}`, time: i });
    expect(many.length).toBe(NOTIF_CAP);
  });

  test("badge counts and clearing per app", () => {
    const list = seedNotifs(1000); // includes app 信息
    expect(countForApp(list, "信息")).toBe(1);
    const read = removeAppNotifs(list, "信息");
    expect(read.length).toBe(2);
    expect(countForApp(read, "信息")).toBe(0);
  });

  test("cloud prefs read/write round-trip and tolerate garbage", () => {
    expect(readCloud(null)).toEqual({ enabled: false, lastSync: 0 });
    expect(readCloud(undefined)).toEqual({ enabled: false, lastSync: 0 });
    const on = setCloudPrefs({}, { enabled: true, lastSync: 5 });
    expect(on.iCloudSync).toBe(true);
    expect(readCloud(on)).toEqual({ enabled: true, lastSync: 5 });
    expect(readCloud({ iCloudSync: "yes", cloudLast: "nope" })).toEqual({
      enabled: false,
      lastSync: 0,
    });
    expect(SETTINGS_KEY).toBe("amos.settings");
    // write entry must tolerate a non-object blob without crashing or leaking keys
    const fromNull = setCloudPrefs(null as unknown as Record<string, unknown>, {
      enabled: true,
      lastSync: 1,
    });
    expect(fromNull).toEqual({ iCloudSync: true, cloudLast: 1 });
    const fromArray = setCloudPrefs(["x"] as unknown as Record<string, unknown>, {
      enabled: false,
    });
    expect(fromArray).toEqual({ iCloudSync: false });
  });

  test("snapshotStores is deterministic and fixed-ordered", () => {
    const stores: Record<string, unknown> = {
      "amos.photos": [{ id: "p1" }],
      "amos.notes": [{ text: "hi" }],
      "amos.reminders": [{ id: "r1", title: "写周报" }],
      "amos.reminderLists": [{ id: "inbox", custom: false, color: "blue" }],
      [FILES_FAV_KEY]: ["/notes/a.txt"],
      [CONV_KEY]: [{ id: "c:xiaoan", name: "小安", msgs: [] }],
      "amos.other-not-synced": undefined, // non-listed key is ignored entirely
    };
    const a = snapshotStores(stores, 1_700_000_000_000);
    const b = snapshotStores({ ...stores }, 1_700_000_000_000);
    expect(a).toBe(b); // same fixed key order (and explicit `at`) → same JSON every time
    // The blob carries its own metadata: format version + when it was taken, so
    // "when was this backup made?" is a property of the backup, not a side pref.
    const env = JSON.parse(a) as { v?: number; at?: number; stores?: Record<string, unknown> };
    expect(env.v).toBe(BACKUP_VERSION);
    expect(env.at).toBe(1_700_000_000_000);
    expect(Object.keys(env.stores ?? {})).toContain("amos.notes");
    expect(a).toContain('"amos.photos"');
    expect(a).toContain('"amos.notes"');
    expect(a).toContain('"amos.reminders"'); // reminders are user data → backed up
    expect(a).toContain('"amos.reminderLists"');
    // The list uses the SAME exported constants the stores are written under: a
    // stale literal once dropped file favourites and every message thread from
    // the backup (`amos.files.fav` ≠ FILES_FAV_KEY, `amos.messages` ≠ CONV_KEY).
    expect(SYNC_STORES).toContain(FILES_FAV_KEY);
    expect(SYNC_STORES).toContain(CONV_KEY);
    expect(SYNC_STORES).not.toContain("amos.files.fav");
    expect(SYNC_STORES).not.toContain("amos.messages");
    expect(a).toContain(`"${FILES_FAV_KEY}"`);
    expect(a).toContain(`"${CONV_KEY}"`);
    // Round 50: the list was **incomplete** — contacts, calendar events, alarms, the
    // call log, voice memos, captures, SMS drafts and the interpreter transcript are
    // user content too, and the Settings hint promises "data is snapshotted".
    for (const key of [
      CONTACTS_KEY,
      CALENDAR_KEY,
      CALENDARS_KEY,
      ALARM_KEY,
      CALLLOG_KEY,
      VMEMOS_KEY,
      CAPTURES_KEY,
      DRAFT_KEY,
      INTERP_LOG_KEY,
    ]) {
      expect(SYNC_STORES as readonly string[]).toContain(key);
      expect(snapshotStores({ [key]: ["x"] }, 1)).toContain(`"${key}"`);
    }
    // …while configuration / device state is classified, not backed up: restoring a
    // backup must not move a device toggle or re-grant a capability.
    expect(SYNC_STORES).not.toContain(WIFI_KEY);
    expect(SYNC_STORES).not.toContain(PERMISSIONS_KEY);
    expect(a).not.toContain("other-not-synced"); // non-sync store omitted
    const parsed = JSON.parse(a) as Record<string, unknown>;
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
  });

  test("parseBackup keeps only backup-eligible keys; a corrupt blob is null", () => {
    const blob = JSON.stringify({
      [NOTES_KEY]: [{ id: "n1", text: "hi", ts: 1 }],
      [PERMISSIONS_KEY]: { camera: ["camera"] }, // config ledger — not content
      "amos.nope": 1, // an invented key
    });
    // Only SYNC_STORES keys survive the decode, in snapshot order.
    expect(Object.keys(parseBackup(blob) ?? {})).toEqual([NOTES_KEY]);
    expect(parseBackup(JSON.stringify({}))).toEqual({}); // valid but carries nothing
    // Corrupt / absent / wrong-shape blobs decode to `null` (never to "empty").
    expect(parseBackup("")).toBeNull();
    expect(parseBackup("   ")).toBeNull();
    expect(parseBackup("{not json")).toBeNull();
    expect(parseBackup("[]")).toBeNull();
    expect(parseBackup("null")).toBeNull();
    expect(parseBackup(undefined)).toBeNull();
    expect(parseBackup(42)).toBeNull();
    // An already-parsed object is accepted too (the shared store may hand one back).
    expect(parseBackup({ [NOTES_KEY]: ["x"] })).toEqual({ [NOTES_KEY]: ["x"] });
    // Envelope form (v1+): the stores live under `stores`, and the whitelist applies
    // to that inner map — a forged `amos.permissions` inside it is dropped as well.
    const v1 = JSON.stringify({
      v: BACKUP_VERSION,
      at: 1_700_000_000_000,
      stores: { [NOTES_KEY]: [{ id: "n1" }], [PERMISSIONS_KEY]: { camera: ["camera"] } },
    });
    expect(Object.keys(parseBackup(v1) ?? {})).toEqual([NOTES_KEY]);
    // Decoding is not the version guard (restore is): a *newer* blob still summarizes.
    const newer = JSON.stringify({ v: BACKUP_VERSION + 1, at: 1, stores: { [NOTES_KEY]: ["x"] } });
    expect(parseBackup(newer)).toEqual({ [NOTES_KEY]: ["x"] });
    // A blob whose `stores` is not an object is treated as a legacy bare map, not as
    // an envelope, so a malformed envelope cannot masquerade as an empty backup.
    expect(parseBackup(JSON.stringify({ v: 1, at: 1, stores: [] }))).toEqual({});
  });

  test("summarizeBackup counts how many stores hold content (empty default excluded)", () => {
    const AT = 1_700_000_000_000;
    // What `syncNow` actually writes: every store present, untouched ones as `[]`.
    const fresh = snapshotStores(
      Object.fromEntries(SYNC_STORES.map((k) => [k, [] as unknown])),
      AT,
    );
    expect(summarizeBackup(fresh)).toEqual({
      stores: SYNC_STORES.length,
      filled: 0,
      total: SYNC_STORES.length,
      at: AT,
      v: BACKUP_VERSION,
    });
    const withData = snapshotStores(
      {
        [NOTES_KEY]: [{ id: "n1", text: "hi", ts: 1 }],
        [CONTACTS_KEY]: [{ id: "c1", name: "小安" }],
        [CALLLOG_KEY]: [] as unknown, // empty → not "filled"
      },
      AT,
    );
    expect(summarizeBackup(withData)).toEqual({
      stores: 3,
      filled: 2,
      total: SYNC_STORES.length,
      at: AT,
      v: BACKUP_VERSION,
    });
    // A legacy (pre-envelope) blob still summarizes — but claims no timestamp/version.
    expect(summarizeBackup(JSON.stringify({ [NOTES_KEY]: ["x"] }))).toEqual({
      stores: 1,
      filled: 1,
      total: SYNC_STORES.length,
      at: null,
      v: null,
    });
    // A non-positive/absent `at` is not a timestamp (never renders "synced at 1970").
    expect(summarizeBackup(JSON.stringify({ v: BACKUP_VERSION, at: 0, stores: {} }))).toEqual({
      stores: 0,
      filled: 0,
      total: SYNC_STORES.length,
      at: null,
      v: BACKUP_VERSION,
    });
    // A corrupt/absent blob has no summary at all — the UI shows no restore then.
    expect(summarizeBackup("nope")).toBeNull();
    expect(summarizeBackup("")).toBeNull();
  });

  test("restoreStores writes back content stores in snapshot order, and writes NOTHING on a corrupt blob", () => {
    const written: Array<[string, unknown]> = [];
    const sink = (k: string, v: unknown) => {
      written.push([k, v]);
      return true;
    };
    const blob = JSON.stringify({
      [NOTES_KEY]: [{ id: "n1", text: "hi", ts: 1 }],
      [CONTACTS_KEY]: [{ id: "c1" }],
    });
    const ok = restoreStores(blob, sink);
    expect(ok).toEqual({ ok: true, restored: [NOTES_KEY, CONTACTS_KEY], failed: [], refused: [] });
    // Snapshot order, not blob order (the blob listed notes first here, but the
    // guarantee is the fixed SYNC_STORES order — same as `snapshotStores`).
    expect(written.map(([k]) => k)).toEqual([NOTES_KEY, CONTACTS_KEY]);
    expect(written[0]![1]).toEqual([{ id: "n1", text: "hi", ts: 1 }]);

    // Hardening: a crafted backup cannot re-grant a capability, move a radio, or
    // invent a store — those keys are reported and left untouched.
    const crafted: Array<[string, unknown]> = [];
    const report = restoreStores(
      JSON.stringify({
        [NOTES_KEY]: ["kept"],
        [PERMISSIONS_KEY]: { camera: ["camera"] },
        [WIFI_KEY]: { on: true },
        "amos.evil": 1,
      }),
      (k, v) => {
        crafted.push([k, v]);
        return true;
      },
    );
    expect(report.restored).toEqual([NOTES_KEY]);
    expect(report.refused).toEqual([PERMISSIONS_KEY, WIFI_KEY, "amos.evil"].sort());
    expect(crafted).toEqual([[NOTES_KEY, ["kept"]]]);

    // A corrupt blob must not blank the user's stores ("restore" ≠ "wipe").
    const untouched: Array<[string, unknown]> = [];
    for (const bad of ["", "{oops", "[]", "null"]) {
      expect(
        restoreStores(bad, (k, v) => {
          untouched.push([k, v]);
          return true;
        }),
      ).toEqual({
        ok: false,
        restored: [],
        failed: [],
        refused: [],
        reason: "malformed",
      });
    }
    expect(untouched).toEqual([]);

    // Envelope blobs restore the same way, through their inner `stores` map.
    const env: Array<[string, unknown]> = [];
    const envReport = restoreStores(
      JSON.stringify({ v: BACKUP_VERSION, at: 1_700_000_000_000, stores: { [NOTES_KEY]: ["v1"] } }),
      (k, v) => {
        env.push([k, v]);
        return true;
      },
    );
    expect(envReport).toEqual({ ok: true, restored: [NOTES_KEY], failed: [], refused: [] });
    expect(env).toEqual([[NOTES_KEY, ["v1"]]]);

    // A blob from a *newer* format is refused rather than guessed at — applying a
    // future shape would write mismatched data over live stores.
    const tooNew: Array<[string, unknown]> = [];
    const newer = restoreStores(
      JSON.stringify({ v: BACKUP_VERSION + 1, at: 1, stores: { [NOTES_KEY]: ["future"] } }),
      (k, v) => {
        tooNew.push([k, v]);
        return true;
      },
    );
    expect(newer).toEqual({
      ok: false,
      restored: [],
      failed: [],
      refused: [],
      reason: "unsupported-version",
    });
    expect(tooNew).toEqual([]);
    // …while a blob with no version at all is a **legacy** shape, not a newer one,
    // and still restores (shipping the envelope must not brick an existing backup).
    const legacy = restoreStores(JSON.stringify({ [NOTES_KEY]: ["old"] }), () => true);
    expect(legacy.ok).toBe(true);
    expect(legacy.restored).toEqual([NOTES_KEY]);
  });

  test("a restore the store rejected is reported as failed, never counted as restored", () => {
    const blob = JSON.stringify({
      [NOTES_KEY]: [{ id: "n1" }],
      [CONTACTS_KEY]: [{ id: "c1" }],
      [CALLLOG_KEY]: [{ id: "x" }],
    });
    // Only the writer knows whether a value landed: here storage refuses one key.
    const attempted: string[] = [];
    const report = restoreStores(blob, (k) => {
      attempted.push(k);
      return k !== CONTACTS_KEY;
    });
    expect(attempted).toEqual([NOTES_KEY, CONTACTS_KEY, CALLLOG_KEY]); // still snapshot order
    expect(report.ok).toBe(true);
    expect(report.restored).toEqual([NOTES_KEY, CALLLOG_KEY]);
    expect(report.failed).toEqual([CONTACTS_KEY]);

    // Every write rejected ⇒ nothing restored, so the UI cannot claim any store back.
    const all = restoreStores(blob, () => false);
    expect(all.ok).toBe(true); // the blob was valid; the *storage* is the problem
    expect(all.restored).toEqual([]);
    expect(all.failed).toEqual([NOTES_KEY, CONTACTS_KEY, CALLLOG_KEY]);
  });

  test("normalizeQuick keeps only known boolean toggles", () => {
    const v = { wifi: true, dnd: false, darkmode: true, other: 1, nested: { x: 1 } };
    expect(normalizeQuick(v)).toEqual({ wifi: true, dnd: false, darkmode: true });
    expect(normalizeQuick([1, 2])).toEqual({});
    expect(normalizeQuick(null)).toEqual({});
    expect(normalizeQuick("x")).toEqual({});
  });

  test("normalizeNotifs keeps valid entries, dedups, tolerates garbage", () => {
    const corrupt = [
      { id: "a", app: "信息", time: 1 },
      { id: "a", app: "天气", time: 2 }, // dup id → dropped
      { id: "b", body: "no time" }, // missing numeric time → dropped
      null,
      3,
    ];
    const out = normalizeNotifs(corrupt);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual({ id: "a", app: "信息", time: 1 });
    expect(normalizeNotifs(null)).toEqual([]);
  });

  test("normalizeNotifs caps a pathologically large store at NOTIF_CAP (keeps newest)", () => {
    const big = Array.from({ length: NOTIF_CAP + 40 }, (_, i) => ({ id: `id${i}`, app: "信息", time: i }));
    const out = normalizeNotifs(big);
    expect(out.length).toBe(NOTIF_CAP);
    expect(out[0]!.id).toBe("id40"); // oldest id0..id39 evicted
    expect(out[out.length - 1]!.id).toBe(`id${NOTIF_CAP + 39}`); // newest tail intact
  });

  test("flashlight helpers flip/torch/guard are consistent and immutable", () => {
    const off: FlashlightStore = { on: false, torch_present: true };
    const on = flipFlashlight(off);
    expect(on.on).toBe(true);
    expect(on.torch_present).toBe(true); // presence never invented by a flip
    expect(off.on).toBe(false); // immutable

    expect(torchOn({ on: true, torch_present: true })).toBe(true);
    expect(torchOn({ on: false, torch_present: true })).toBe(false);
    // Cannot be "lit" when no torch exists, even if the bit says on.
    expect(torchOn({ on: true, torch_present: false })).toBe(false);
  });

  test("normalizeFlashlight defaults to a present-but-dark torch on garbage/absent", () => {
    const d: FlashlightStore = { on: false, torch_present: true };
    expect(normalizeFlashlight(null)).toEqual(d);
    expect(normalizeFlashlight("nope")).toEqual(d);
    expect(normalizeFlashlight([1, 2])).toEqual(d);
    expect(normalizeFlashlight({ on: true, torch_present: true })).toEqual({ on: true, torch_present: true });
    // Non-boolean bits fall back conservatively.
    expect(normalizeFlashlight({ on: 1, torch_present: "yes" })).toEqual(d);
    expect(normalizeFlashlight({ on: false, torch_present: false })).toEqual({ on: false, torch_present: false });
  });
});
