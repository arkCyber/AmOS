import { describe, expect, test } from "bun:test";
import {
  JUNK_KINDS,
  SENSITIVE_RESOURCES,
  areaLabelKey,
  auditComplete,
  careAreaSplit,
  junkKindLabelKey,
  normalizeApps,
  normalizeAudit,
  normalizeClean,
  normalizeJunkReport,
  normalizeMemory,
  normalizeBoost,
  memUsedBytes,
  memUsedPct,
  normalizePermRows,
  normalizePermReview,
  permReviewAuthoritative,
  normalizeReport,
  normalizeScan,
  normalizeStorage,
  normalizeStatus,
  normalizeTrail,
  normalizeUninstall,
  opLabelKey,
  outcomeLabelKey,
  hhmm,
  reportHasData,
  resourceLabelKey,
  severityLabelKey,
  validateCleanRequest,
} from "../lib/devcare";

/**
 * Pure contract tests for the device-care bridge module (src/lib/devcare.ts).
 *
 * The normalizers must be **total** — a malformed payload degrades to an
 * empty/unknown view, never a throw — and the honesty rules of the Rust kernel
 * must survive the wire (empty `assessed` ⇒ `reportHasData` false, so the screen
 * cannot show a vacuous "100").
 */
describe("devcare — normalizers are total", () => {
  test("normalizeStatus degrades a malformed payload to the honest default", () => {
    expect(normalizeStatus(null)).toEqual({
      available: false,
      backend: "none",
      root: null,
      can_clean: false,
      scanned_items: 0,
      unreadable_dirs: 0,
      last_error: null,
    });
    expect(normalizeStatus("nope").available).toBe(false);
    expect(
      normalizeStatus({
        available: true,
        backend: "host-fs",
        root: "/tmp/x",
        can_clean: true,
        scanned_items: 3,
        unreadable_dirs: 1,
        last_error: "boom",
      }),
    ).toEqual({
      available: true,
      backend: "host-fs",
      root: "/tmp/x",
      can_clean: true,
      scanned_items: 3,
      unreadable_dirs: 1,
      last_error: "boom",
    });
    // Wrong types are dropped, not coerced into a fake reading.
    const bad = normalizeStatus({ available: "yes", scanned_items: "9", root: 42 });
    expect(bad.available).toBe(false);
    expect(bad.scanned_items).toBe(0);
    expect(bad.root).toBeNull();
  });

  test("normalizeJunkReport keeps only nameable groups", () => {
    const r = normalizeJunkReport({
      groups: [
        { kind: "app_cache", count: 2, bytes: 100 },
        "junk",
        { kind: 1 },
        {},
        null,
        { kind: "future_kind", count: 1, bytes: 5 },
      ],
      total_items: 2,
      total_bytes: 100,
      reclaimable_bytes: 100,
      review_bytes: 0,
    });
    // A structurally broken entry is dropped …
    expect(r.groups.map((g) => g.kind)).toEqual(["app_cache", "future_kind"]);
    // … while a well-formed but unrecognized tag survives (labelled "other").
    expect(r.groups[1]).toEqual({ kind: "future_kind", count: 1, bytes: 5 });
    expect(junkKindLabelKey("future_kind")).toBe("care.junk.unknown");
    expect(r.total_items).toBe(2);
    expect(r.reclaimable_bytes).toBe(100);
    expect(normalizeJunkReport(undefined).groups).toEqual([]);
  });

  test("normalizeScan returns null when the scan did not happen", () => {
    expect(normalizeScan(null)).toBeNull();
    expect(normalizeScan([])).toBeNull();
    const v = normalizeScan({
      status: { available: true, backend: "host-fs" },
      report: { groups: [], total_items: 0, total_bytes: 0 },
      auto_kinds: ["app_cache", 7],
      review_kinds: "stale_download",
    });
    expect(v).not.toBeNull();
    expect(v!.auto_kinds).toEqual(["app_cache"]); // non-strings dropped
    expect(v!.review_kinds).toEqual([]); // a non-array is empty, not a guess
    expect(v!.status.available).toBe(true);
  });

  test("normalizeClean reports a partial clean honestly", () => {
    expect(normalizeClean(undefined)).toBeNull();
    const c = normalizeClean({
      planned_items: 3,
      planned_bytes: 300,
      freed_bytes: 100,
      removed: 1,
      failed: 2,
      partial: true,
      failures: [{ uri: "/x/a", kind: "log_file", message: "locked" }, 5],
    });
    expect(c!.partial).toBe(true);
    expect(c!.freed_bytes).toBe(100);
    expect(c!.failures).toEqual([{ uri: "/x/a", kind: "log_file", message: "locked" }]);
  });

  test("normalizeApps / normalizePermRows drop malformed entries", () => {
    const apps = normalizeApps([
      { id: "a", name: "A", verdict: "allowed", size_bytes: 10 },
      { name: "no id" },
      null,
    ]);
    expect(apps).toHaveLength(2);
    expect(apps[0]!.verdict).toBe("allowed");
    expect(normalizeApps("nope")).toEqual([]);

    const rows = normalizePermRows([{ app_id: "a", resources: ["camera", 1] }, 3]);
    expect(rows).toEqual([{ app_id: "a", resources: ["camera"] }]);
    expect(normalizePermRows(null)).toEqual([]);
  });

  test("normalizeApps keeps an unknown package size unknown", () => {
    const apps = normalizeApps([
      { id: "a", size_bytes: null, verdict: "allowed" },
      { id: "b", size_bytes: 10, verdict: "allowed" },
      { id: "c", verdict: "allowed" },
      { id: "d", size_bytes: "10", verdict: "allowed" },
    ]);
    expect(apps[0]!.size_bytes).toBeNull();
    expect(apps[1]!.size_bytes).toBe(10);
    // Absent or wrongly-typed ⇒ unknown, never a fabricated 0.
    expect(apps[2]!.size_bytes).toBeNull();
    expect(apps[3]!.size_bytes).toBeNull();
  });

  test("reportHasData is false for an unobserved report (no vacuous 100)", () => {
    expect(reportHasData(null)).toBe(false);
    const empty = normalizeReport({ score: 100, grade: "a", findings: [], assessed: [] });
    expect(empty.score).toBe(100);
    expect(reportHasData(empty)).toBe(false);

    const seen = normalizeReport({
      score: 95,
      grade: "a",
      assessed: ["storage"],
      findings: [{ area: "storage", severity: "suggestion", key: "care.storage.reclaimable" }],
    });
    expect(reportHasData(seen)).toBe(true);
    expect(seen.findings[0]!.key).toBe("care.storage.reclaimable");
    expect(seen.findings[0]!.severity).toBe("suggestion");
  });

  test("careAreaSplit names the observed and the unobserved areas in domain order", () => {
    const report = (assessed: string[]) =>
      normalizeReport({ score: 90, grade: "a", findings: [], assessed });

    // Everything observed ⇒ nothing missing (and no warning is rendered).
    const all = careAreaSplit(report(["permissions", "battery", "apps", "storage"]));
    expect(all.observed).toEqual(["storage", "apps", "battery", "permissions"]);
    expect(all.missing).toEqual([]);

    // A partial report: the grade only certifies what was seen, so the rest must
    // be nameable as "not measured" instead of looking healthy (aerospace P0-3).
    const partial = careAreaSplit(report(["storage"]));
    expect(partial.observed).toEqual(["storage"]);
    expect(partial.missing).toEqual(["apps", "battery", "permissions"]);

    // A key this build does not model is neither observed nor missing — it is not
    // invented into a list.
    const odd = careAreaSplit(report(["storage", "telepathy"]));
    expect(odd.observed).toEqual(["storage"]);
    expect(odd.missing).toEqual(["apps", "battery", "permissions"]);

    // No report at all: nothing observed, everything unmeasured.
    expect(careAreaSplit(null).observed).toEqual([]);
    expect(careAreaSplit(null).missing).toEqual(["storage", "apps", "battery", "permissions"]);
  });
});

describe("devcare — label key mapping", () => {
  test("maps every known tag to an i18n key", () => {
    for (const k of JUNK_KINDS) expect(junkKindLabelKey(k).startsWith("care.junk.")).toBe(true);
    for (const r of SENSITIVE_RESOURCES) expect(resourceLabelKey(r).startsWith("perm.cap.")).toBe(true);
    expect(areaLabelKey("storage")).toBe("care.area.storage");
    expect(severityLabelKey("critical")).toBe("care.severity.critical");
  });

  test("unknown tags fall back instead of leaking a raw tag into the UI", () => {
    expect(junkKindLabelKey("who_knows")).toBe("care.junk.unknown");
    expect(resourceLabelKey("gps")).toBe("perm.cap.unknown");
    expect(areaLabelKey("cpu")).toBe("care.area.unknown");
    expect(severityLabelKey("fatal")).toBe("care.severity.unknown");
  });
});

describe("devcare — validateCleanRequest mirrors the Rust policy", () => {
  test("rejects an empty selection", () => {
    expect(validateCleanRequest([], false)).toBe("care.err.noSelection");
  });

  test("rejects an unknown category tag", () => {
    expect(validateCleanRequest(["app_cache", "nope"], false)).toBe("care.err.unknownKind");
    // A path is not a category — the same hardening the Rust side enforces.
    expect(validateCleanRequest(["/etc/passwd"], false)).toBe("care.err.unknownKind");
  });

  test("requires the acknowledgement for review-only categories", () => {
    expect(validateCleanRequest(["stale_download"], false)).toBe("care.err.needsReview");
    expect(validateCleanRequest(["stale_download"], true)).toBeNull();
  });

  test("accepts a well-formed auto-cleanable request", () => {
    expect(validateCleanRequest(["app_cache", "log_file"], false)).toBeNull();
  });
});

describe("devcare — audit trail normalizers", () => {
  test("normalizeTrail is total and keeps 'no sink' distinct from 'empty'", () => {
    expect(normalizeTrail(null)).toEqual({ entries: [], durable: false });
    const t = normalizeTrail({
      durable: true,
      records: [
        { ts: 1, op: "devcare.clean", resource: "app_cache", outcome: "success", details: "d" },
        5,
        null,
      ],
    });
    expect(t.durable).toBe(true);
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0]).toEqual({
      ts: 1,
      op: "devcare.clean",
      resource: "app_cache",
      outcome: "success",
      details: "d",
    });
    // A malformed outcome degrades to `unknown` (never a fabricated success).
    expect(normalizeTrail({ records: [{ op: "x" }] }).entries[0]!.outcome).toBe("unknown");
  });

  test("op/outcome label keys fall back instead of leaking a raw tag", () => {
    expect(opLabelKey("devcare.clean")).toBe("care.op.clean");
    expect(opLabelKey("devcare.clean.item")).toBe("care.op.cleanItem");
    expect(opLabelKey("app.uninstall")).toBe("care.op.uninstall");
    expect(opLabelKey("devcare.boost")).toBe("care.op.boost");
    expect(opLabelKey("devcare.boost.item")).toBe("care.op.boostItem");
    expect(opLabelKey("mystery.op")).toBe("care.op.unknown");
    expect(outcomeLabelKey("rejected")).toBe("care.outcome.rejected");
    expect(outcomeLabelKey("nope")).toBe("care.outcome.unknown");
  });

  test("hhmm renders a zero/invalid stamp as empty", () => {
    expect(hhmm(0)).toBe("");
    expect(hhmm(Number.NaN)).toBe("");
    expect(hhmm(1_700_000_000)).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("devcare — memory + boost normalizers", () => {
  test("normalizeMemory is total and drops unnameable apps", () => {
    expect(normalizeMemory(null)).toEqual({
      total_bytes: null,
      available_bytes: null,
      reclaimable: [],
      mode: null,
      governor: false,
    });
    const m = normalizeMemory({
      total_bytes: 1000,
      available_bytes: 400,
      reclaimable: [{ id: "com.bg", state: "background" }, 7, { state: "cached" }],
      mode: "power_save",
      governor: true,
    });
    expect(m.total_bytes).toBe(1000);
    expect(m.governor).toBe(true);
    expect(m.mode).toBe("power_save");
    expect(m.reclaimable).toEqual([{ id: "com.bg", state: "background" }]);
    // Wrong types never become a fabricated zero.
    expect(normalizeMemory({ total_bytes: "1000" }).total_bytes).toBeNull();
  });

  test("memUsedBytes / memUsedPct are null when the reading is incomplete", () => {
    expect(memUsedBytes(null)).toBeNull();
    expect(memUsedBytes({ total_bytes: null, available_bytes: 1, reclaimable: [], mode: null, governor: true })).toBeNull();
    expect(memUsedPct({ total_bytes: 1000, available_bytes: 400, reclaimable: [], mode: null, governor: true })).toBe(60);
    // A nonsense total is not divided by.
    expect(memUsedPct({ total_bytes: 0, available_bytes: 0, reclaimable: [], mode: null, governor: true })).toBeNull();
  });

  test("normalizeBoost reports a partial boost honestly", () => {
    expect(normalizeBoost(undefined)).toEqual({
      requested: [],
      reclaimed: 0,
      failures: [],
      available_before: null,
      available_after: null,
      governor: false,
      audit: { recorded: 0, attempted: 0, reason: null },
    });
    const b = normalizeBoost({
      requested: ["a", 7],
      reclaimed: 1,
      failures: [{ id: "b", message: "refused" }, null],
      available_before: 100,
      available_after: 200,
      governor: true,
      audit: { recorded: 2, attempted: 2, reason: null },
    });
    expect(b.requested).toEqual(["a"]);
    expect(b.failures).toEqual([{ id: "b", message: "refused" }]);
    expect(b.available_before).toBe(100);
    expect(b.available_after).toBe(200);
    expect(b.audit).toEqual({ recorded: 2, attempted: 2, reason: null });
    // A missing audit status degrades to "nothing attempted", never a fake trail.
    expect(normalizeBoost({ governor: true }).audit).toEqual({
      recorded: 0,
      attempted: 0,
      reason: null,
    });
    // A degradation reason survives normalization — the UI shows WHY it is
    // "not audited" (tooltip), so losing it would hide the honest explanation.
    expect(
      normalizeBoost({
        governor: true,
        audit: { recorded: 1, attempted: 2, reason: "AMOS_PRIVACY_PATH unset" },
      }).audit,
    ).toEqual({ recorded: 1, attempted: 2, reason: "AMOS_PRIVACY_PATH unset" });
    // A malformed audit payload is "nothing attempted", not a fabricated trail.
    expect(normalizeBoost({ governor: true, audit: "yes" }).audit).toEqual({
      recorded: 0,
      attempted: 0,
      reason: null,
    });
  });

  test("auditComplete separates a full boost trail from a partial one", () => {
    const full = normalizeBoost({
      governor: true,
      audit: { recorded: 1, attempted: 1, reason: null },
    });
    const partial = normalizeBoost({
      governor: true,
      audit: { recorded: 1, attempted: 2, reason: "half" },
    });
    const none = normalizeBoost({ governor: false });
    expect(auditComplete(full.audit)).toBe(true);
    expect(auditComplete(partial.audit)).toBe(false);
    // A zero status (no boost happened) is not a complete trail either.
    expect(auditComplete(none.audit)).toBe(false);
    expect(auditComplete(null)).toBe(false);
  });
});

describe("devcare — permission review authority", () => {
  test("normalizePermReview is total and defaults to 'unavailable'", () => {
    expect(normalizePermReview(null)).toEqual({ rows: [], authority: "unavailable" });
    expect(
      normalizePermReview({
        authority: "daemon",
        rows: [{ app_id: "a", resources: ["camera"] }],
      }),
    ).toEqual({ rows: [{ app_id: "a", resources: ["camera"] }], authority: "daemon" });
    // A missing authority is NOT authoritative (never assume the daemon answered).
    expect(normalizePermReview({ rows: [] }).authority).toBe("unavailable");
    expect(normalizePermReview({}).authority).toBe("unavailable");
  });

  test("permReviewAuthoritative is false unless the daemon answered", () => {
    expect(permReviewAuthoritative(null)).toBe(false);
    expect(permReviewAuthoritative(undefined)).toBe(false);
    expect(permReviewAuthoritative({ rows: [], authority: "unavailable" })).toBe(false);
    expect(permReviewAuthoritative({ rows: [], authority: "daemon" })).toBe(true);
  });
});

describe("devcare — audit + uninstall normalizers", () => {
  test("normalizeAudit is total and degrades to 'nothing recorded'", () => {
    expect(normalizeAudit(null)).toEqual({ recorded: 0, attempted: 0, reason: null });
    expect(normalizeAudit({ recorded: 2, attempted: 3, reason: "offline" })).toEqual({
      recorded: 2,
      attempted: 3,
      reason: "offline",
    });
    // Wrong types never become a fake success.
    expect(normalizeAudit({ recorded: "1", attempted: null })).toEqual({
      recorded: 0,
      attempted: 0,
      reason: null,
    });
  });

  test("auditComplete is false unless every record was persisted", () => {
    expect(auditComplete(null)).toBe(false);
    expect(auditComplete(undefined)).toBe(false);
    expect(auditComplete({ recorded: 0, attempted: 0, reason: null })).toBe(false);
    expect(auditComplete({ recorded: 1, attempted: 2, reason: "x" })).toBe(false);
    expect(auditComplete({ recorded: 2, attempted: 2, reason: null })).toBe(true);
  });

  test("normalizeClean carries the audit status (and degrades without one)", () => {
    const c = normalizeClean({
      freed_bytes: 5,
      audit: { recorded: 1, attempted: 1, reason: null },
    });
    expect(c!.audit).toEqual({ recorded: 1, attempted: 1, reason: null });
    expect(auditComplete(c!.audit)).toBe(true);
    // A payload with no audit block is honestly "nothing attempted".
    expect(normalizeClean({ freed_bytes: 5 })!.audit).toEqual({
      recorded: 0,
      attempted: 0,
      reason: null,
    });
  });

  test("normalizeUninstall is total and defaults to not-removed", () => {
    expect(normalizeUninstall(null)).toEqual({
      id: "",
      removed: false,
      launched: false,
      verdict: "unknown",
      reason_key: null,
      message: "",
      audit: { recorded: 0, attempted: 0, reason: null },
    });
    const u = normalizeUninstall({
      id: "com.x",
      removed: true,
      verdict: "allowed",
      reason_key: null,
      message: "removed",
      audit: { recorded: 1, attempted: 1, reason: null },
    });
    expect(u.removed).toBe(true);
    expect(u.launched).toBe(false);
    expect(auditComplete(u.audit)).toBe(true);
  });

  test("a launched uninstall is not reported as removed", () => {
    // Android ACTION_DELETE only *requests* the removal; claiming `removed`
    // would be a lie until the platform confirms.
    const u = normalizeUninstall({
      id: "com.x",
      removed: false,
      launched: true,
      verdict: "allowed",
      message: "uninstall intent launched",
    });
    expect(u.removed).toBe(false);
    expect(u.launched).toBe(true);
    expect(u.message).toBe("uninstall intent launched");
  });

  test("normalizeStorage keeps an unmeasured reading unknown, never zero", () => {
    expect(normalizeStorage(null)).toBeNull();
    // A backend that cannot measure must not render as `0 B`.
    const unknown = normalizeStorage({
      measured: false,
      total_bytes: 0,
      used_bytes: 0,
      free_bytes: 0,
      used_pct: 0,
      backend: "host-fs",
    })!;
    expect(unknown.measured).toBe(false);
    expect(unknown.total_bytes).toBeNull();
    expect(unknown.used_bytes).toBeNull();
    expect(unknown.free_bytes).toBeNull();
    expect(unknown.used_pct).toBeNull();
    expect(unknown.backend).toBe("host-fs");
  });

  test("normalizeStorage carries the totals and category rows when measured", () => {
    const s = normalizeStorage({
      measured: true,
      total_bytes: 1000,
      used_bytes: 250,
      free_bytes: 750,
      used_pct: 25,
      backend: "android",
      groups: [{ kind: "app_cache", count: 2, bytes: 4096 }],
      reclaimable_bytes: 4096,
      review_bytes: 0,
    })!;
    expect(s.measured).toBe(true);
    expect(s.total_bytes).toBe(1000);
    expect(s.used_bytes).toBe(250);
    expect(s.free_bytes).toBe(750);
    expect(s.used_pct).toBe(25);
    expect(s.backend).toBe("android");
    expect(s.groups).toEqual([{ kind: "app_cache", count: 2, bytes: 4096 }]);
    expect(s.reclaimable_bytes).toBe(4096);
  });
});
