/**
 * DOM tests for the Svelte 5 device-care screen (DeviceCareApp.svelte).
 *
 * Drives the screen through a fake `devcare_*` bridge so the honesty rules are
 * locked down: no backend ⇒ an explicit "not connected" state (never an empty
 * healthy device); an unobserved report shows "—" (never a vacuous 100); a
 * review-only category cannot be cleaned without the explicit acknowledgement;
 * a clean only ever sends category keys.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import DeviceCareApp from "../src/svelte/DeviceCareApp.svelte";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = () => new Promise((r) => setTimeout(r, 30));
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const q = (h: { container: HTMLElement }, id: string) =>
  h.container.querySelector(`[data-testid="${id}"]`);

const STATUS = {
  available: true,
  backend: "host-fs",
  root: "/tmp/x",
  can_clean: true,
  scanned_items: 2,
  unreadable_dirs: 0,
  last_error: null,
};

const SCAN = {
  status: STATUS,
  report: {
    groups: [
      { kind: "app_cache", count: 1, bytes: 1024 },
      { kind: "log_file", count: 1, bytes: 512 },
    ],
    total_items: 2,
    total_bytes: 1536,
    reclaimable_bytes: 1536,
    review_bytes: 0,
  },
  auto_kinds: ["app_cache", "log_file"],
  review_kinds: [],
};

interface Opts {
  available?: boolean;
  scan?: unknown;
  report?: unknown;
  clean?: unknown;
  apps?: unknown;
  perms?: unknown;
  uninstall?: unknown;
  trail?: unknown;
  memory?: unknown;
  storage?: unknown;
  boostResult?: unknown;
  lastError?: string | null;
}

function installBridge(opts: Opts = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "appstore_installed") return [];
    if (cmd === "devcare_status") {
      const available = opts.available ?? true;
      return { ...STATUS, available, can_clean: available, last_error: opts.lastError ?? null };
    }
    if (cmd === "devcare_scan") return opts.scan === undefined ? SCAN : opts.scan;
    if (cmd === "devcare_clean") {
      return opts.clean === undefined
        ? {
            planned_items: 2,
            planned_bytes: 1536,
            freed_bytes: 1536,
            removed: 2,
            failed: 0,
            partial: false,
            failures: [],
            audit: { recorded: 1, attempted: 1, reason: null },
          }
        : opts.clean;
    }
    if (cmd === "devcare_uninstall") {
      return opts.uninstall === undefined
        ? {
            id: String(args?.id),
            removed: true,
            verdict: "allowed",
            reason_key: null,
            message: "removed",
            audit: { recorded: 1, attempted: 1, reason: null },
          }
        : opts.uninstall;
    }
    if (cmd === "devcare_apps") return opts.apps === undefined ? [] : opts.apps;
    if (cmd === "devcare_permissions") {
      return opts.perms === undefined ? { rows: [], authority: "daemon" } : opts.perms;
    }
    if (cmd === "devcare_trail") {
      return opts.trail === undefined ? { records: [], durable: true } : opts.trail;
    }
    if (cmd === "devcare_memory") {
      return opts.memory === undefined
        ? {
            total_bytes: 8_000,
            available_bytes: 3_000,
            reclaimable: [{ id: "com.example.bg", state: "background" }],
            mode: "balanced",
            governor: true,
          }
        : opts.memory;
    }
    if (cmd === "devcare_storage") {
      return opts.storage === undefined
        ? {
            measured: true,
            total_bytes: 100_000,
            used_bytes: 25_000,
            free_bytes: 75_000,
            used_pct: 25,
            backend: "host-fs",
            groups: [
              { kind: "app_cache", count: 1, bytes: 1024 },
              { kind: "log_file", count: 1, bytes: 512 },
            ],
            reclaimable_bytes: 1536,
            review_bytes: 0,
          }
        : opts.storage;
    }
    if (cmd === "devcare_boost") {
      return opts.boostResult === undefined
        ? {
            requested: ["com.example.bg"],
            reclaimed: 1,
            failures: [],
            available_before: 3_000,
            available_after: 4_000,
            governor: true,
            audit: { recorded: 1, attempted: 1, reason: null },
          }
        : opts.boostResult;
    }
    if (cmd === "devcare_report") {
      return opts.report === undefined
        ? {
            score: 95,
            grade: "a",
            assessed: ["storage"],
            findings: [
              {
                area: "storage",
                severity: "suggestion",
                key: "care.storage.reclaimable",
                detail: "1536",
                reclaimable_bytes: 1536,
              },
            ],
          }
        : opts.report;
    }
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
  return calls;
}

describe("DeviceCareApp.svelte — offline / unavailable", () => {
  test("without a Tauri bridge it shows an honest offline notice", async () => {
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-offline")).toBeTruthy();
    expect(q(h, "devcare-overview")).toBeNull();
  });

  test("a partial report discloses the areas it did NOT measure", async () => {
    installBridge({
      report: { score: 95, grade: "a", assessed: ["storage", "battery"], findings: [] },
    });
    const h = render(DeviceCareApp);
    await settle();
    const seen = q(h, "devcare-areas-observed")?.textContent ?? "";
    expect(seen).toContain("存储");
    expect(seen).toContain("电池");
    // The areas the grade does NOT cover must be flagged, not silently omitted:
    // a partial report that looks fully assessed is "unknown as healthy" (P0-3).
    const missing = q(h, "devcare-areas-missing")?.textContent ?? "";
    expect(missing).toContain("应用");
    expect(missing).toContain("权限");
    expect(missing).not.toContain("存储");
  });

  test("a fully-observed report shows no 'not measured' warning", async () => {
    installBridge({
      report: {
        score: 100,
        grade: "a",
        assessed: ["storage", "apps", "battery", "permissions"],
        findings: [],
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-areas-observed")).toBeTruthy();
    expect(q(h, "devcare-areas-missing")).toBeNull();
  });

  test("an unobserved report shows no area line at all", async () => {
    installBridge({ report: { score: 100, grade: "a", assessed: [], findings: [] } });
    const h = render(DeviceCareApp);
    await settle();
    // Nothing was measured ⇒ no "checked: …" line (and the score is unknown).
    expect(q(h, "devcare-areas")).toBeNull();
    expect(q(h, "devcare-score")?.textContent).toBe("—");
  });

  test("bridged but with no backend it never fabricates a healthy device", async () => {
    installBridge({ available: false });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-unavailable")).toBeTruthy();
    expect(q(h, "devcare-junk")).toBeNull();
    // The score is not a vacuous 100 — it is explicitly unknown.
    expect(q(h, "devcare-score")?.textContent).toBe("—");
  });
});

describe("DeviceCareApp.svelte — scan + clean", () => {
  test("renders the report, the junk groups and a working one-tap clean", async () => {
    const calls = installBridge();
    const h = render(DeviceCareApp);
    await settle();

    expect(q(h, "devcare-score")?.textContent).toBe("95");
    expect(q(h, "devcare-grade")?.textContent).toBe("A");
    expect(q(h, "devcare-backend")?.textContent).toContain("host-fs");
    // Findings are rendered from the report's own i18n keys.
    expect(txt(h)).toContain("有可回收的缓存与残留文件");
    expect(q(h, "devcare-group-app_cache")).toBeTruthy();
    expect(q(h, "devcare-group-log_file")).toBeTruthy();

    await fireEvent.click(q(h, "devcare-clean")!);
    await settle();

    // Only category keys were ever sent — never a path.
    const clean = calls.find((c) => c.cmd === "devcare_clean");
    expect(clean?.args?.kinds).toEqual(["app_cache", "log_file"]);
    expect(clean?.args?.acknowledgeReview).toBe(false);
    expect(q(h, "devcare-notice")?.textContent).toContain("已释放");
    // The audit outcome is surfaced, not assumed.
    expect(q(h, "devcare-audit")?.textContent).toContain("已记录审计 (1/1)");
  });

  test("says so when a clean did not reach the audit trail", async () => {
    installBridge({
      clean: {
        planned_items: 1,
        planned_bytes: 10,
        freed_bytes: 10,
        removed: 1,
        failed: 0,
        partial: false,
        failures: [],
        audit: { recorded: 0, attempted: 1, reason: "AMOS_PRIVACY_PATH unset" },
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    await fireEvent.click(q(h, "devcare-clean")!);
    await settle();
    expect(q(h, "devcare-audit")?.textContent).toContain("审计未记录");
  });

  test("an unobserved report shows unknown instead of a vacuous 100", async () => {
    installBridge({ report: { score: 100, grade: "a", assessed: [], findings: [] } });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-score")?.textContent).toBe("—");
    expect(q(h, "devcare-findings")).toBeNull();
  });

  test("a failed scan is an error, not 'nothing to clean'", async () => {
    installBridge({ scan: null });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-junk-error")).toBeTruthy();
    expect(q(h, "devcare-junk-empty")).toBeNull();
    expect(txt(h)).toContain("扫描失败");
    // And the reclaimable figure is unknown, never a fabricated "0 B".
    expect(q(h, "devcare-junk")?.textContent).not.toContain("0 B");
  });

  test("a backend error is surfaced instead of looking healthy", async () => {
    installBridge({ lastError: "refusing to touch /x: root does not exist" });
    const h = render(DeviceCareApp);
    await settle();
    const err = q(h, "devcare-last-error");
    expect(err).toBeTruthy();
    // The raw diagnostic is preserved on the element (hover), localized above.
    expect(err?.getAttribute("title")).toContain("root does not exist");
    expect(txt(h)).toContain("后端错误");
  });

  test("a clean run does not show a backend error", async () => {
    installBridge();
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-last-error")).toBeNull();
  });

  test("a failed clean is reported as partial, with the failure count", async () => {
    installBridge({
      clean: {
        planned_items: 2,
        planned_bytes: 1536,
        freed_bytes: 1024,
        removed: 1,
        failed: 1,
        partial: true,
        failures: [{ uri: "/x/log", kind: "log_file", message: "locked" }],
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    await fireEvent.click(q(h, "devcare-clean")!);
    await settle();
    expect(q(h, "devcare-notice")?.textContent).toContain("1 项失败");
  });

  test("a failed clean never claims anything was freed", async () => {
    installBridge({ clean: null });
    const h = render(DeviceCareApp);
    await settle();
    await fireEvent.click(q(h, "devcare-clean")!);
    await settle();
    expect(q(h, "devcare-notice")?.textContent).toContain("未释放任何文件");
  });
});

describe("DeviceCareApp.svelte — review-only categories need acknowledgement", () => {
  const reviewScan = {
    status: STATUS,
    report: {
      groups: [
        { kind: "app_cache", count: 1, bytes: 1024 },
        { kind: "stale_download", count: 1, bytes: 2048 },
      ],
      total_items: 2,
      total_bytes: 3072,
      reclaimable_bytes: 1024,
      review_bytes: 2048,
    },
    auto_kinds: ["app_cache"],
    review_kinds: ["stale_download"],
  };

  test("selecting a review-only kind without the ack is refused client-side", async () => {
    const calls = installBridge({ scan: reviewScan });
    const h = render(DeviceCareApp);
    await settle();

    // Only the auto-cleanable kind is pre-selected; the review kind is flagged.
    expect(txt(h)).toContain("需确认");
    expect(q(h, "devcare-ack")).toBeNull();

    await fireEvent.click(q(h, "devcare-group-stale_download")!.querySelector("input")!);
    await settle();
    expect(q(h, "devcare-ack")).toBeTruthy();

    await fireEvent.click(q(h, "devcare-clean")!);
    await settle();
    expect(q(h, "devcare-notice")?.textContent).toContain("该类别需要先确认");
    // The refused request never reached the backend.
    expect(calls.some((c) => c.cmd === "devcare_clean")).toBe(false);
  });

  test("acknowledging the review lets the clean go through", async () => {
    const calls = installBridge({ scan: reviewScan });
    const h = render(DeviceCareApp);
    await settle();

    await fireEvent.click(q(h, "devcare-group-stale_download")!.querySelector("input")!);
    await settle();
    await fireEvent.click(q(h, "devcare-ack")!);
    await settle();
    await fireEvent.click(q(h, "devcare-clean")!);
    await settle();

    const clean = calls.find((c) => c.cmd === "devcare_clean");
    expect(clean?.args?.kinds).toEqual(["app_cache", "stale_download"]);
    expect(clean?.args?.acknowledgeReview).toBe(true);
  });
});

describe("DeviceCareApp.svelte — memory boost", () => {
  test("renders the memory reading and the reclaimable count", async () => {
    installBridge();
    const h = render(DeviceCareApp);
    await settle();
    // 8000 total − 3000 available = 5000 used.
    expect(q(h, "devcare-memory-used")?.textContent).toContain("5 KB / 8 KB");
    expect(q(h, "devcare-memory-reclaimable")?.textContent).toContain("1 个可回收的后台应用");
    expect(q(h, "devcare-memory-nogovernor")).toBeNull();
  });

  test("a boost reports what the governor accepted", async () => {
    const calls = installBridge();
    const h = render(DeviceCareApp);
    await settle();
    await fireEvent.click(q(h, "devcare-boost")!);
    await settle();
    expect(calls.some((c) => c.cmd === "devcare_boost")).toBe(true);
    expect(q(h, "devcare-boost-note")?.textContent).toContain("已回收 1 个应用");
    // A forced stop is audited like clean/uninstall — and the UI says so.
    expect(q(h, "devcare-audit")?.textContent).toContain("已记录审计 (1/1)");
  });

  test("a partial boost says how many failed", async () => {
    installBridge({
      boostResult: {
        requested: ["a", "b"],
        reclaimed: 1,
        failures: [{ id: "b", message: "refused" }],
        available_before: 100,
        available_after: 100,
        governor: true,
        audit: { recorded: 1, attempted: 2, reason: "half" },
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    await fireEvent.click(q(h, "devcare-boost")!);
    await settle();
    expect(q(h, "devcare-boost-note")?.textContent).toContain("已回收 1 个，1 个失败");
    // 1/2 recorded is NOT a complete trail: it must read as "not audited".
    expect(q(h, "devcare-audit")?.textContent).toContain("审计未记录");
  });

  test("a boost that never happened does not pretend to be audited", async () => {
    // The memory view promised a governor, but the boost found none (a race):
    // nothing was requested ⇒ no trail, and the UI must not render one.
    installBridge({
      boostResult: {
        requested: [],
        reclaimed: 0,
        failures: [],
        available_before: null,
        available_after: null,
        governor: false,
        audit: { recorded: 0, attempted: 0, reason: null },
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    await fireEvent.click(q(h, "devcare-boost")!);
    await settle();
    expect(q(h, "devcare-boost-note")?.textContent).toContain("守护进程未连接");
    expect(q(h, "devcare-audit")).toBeNull();
  });

  test("an empty boost still happened — and its honest event is reported", async () => {
    // Race: the memory view listed reclaimable apps, but by boost time the
    // plan came back empty. The bridge still writes the honest
    // `requested=0` success event, so the UI must show the audit line —
    // hiding it would say "nothing happened" about a recorded event.
    installBridge({
      boostResult: {
        requested: [],
        reclaimed: 0,
        failures: [],
        available_before: 100,
        available_after: 100,
        governor: true,
        audit: { recorded: 1, attempted: 1, reason: null },
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    await fireEvent.click(q(h, "devcare-boost")!);
    await settle();
    expect(q(h, "devcare-boost-note")?.textContent).toContain("已回收 0 个应用");
    expect(q(h, "devcare-audit")?.textContent).toContain("已记录审计 (1/1)");
  });

  test("an unreachable governor is not shown as 'nothing to reclaim'", async () => {
    installBridge({
      memory: {
        total_bytes: 8_000,
        available_bytes: 3_000,
        reclaimable: [],
        mode: null,
        governor: false,
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-memory-nogovernor")).toBeTruthy();
    expect(q(h, "devcare-memory-reclaimable")).toBeNull();
    expect(q(h, "devcare-boost")).toBeNull();
    // The reading we *did* get is still shown.
    expect(q(h, "devcare-memory-used")?.textContent).toContain("5 KB / 8 KB");
  });

  test("an unreadable memory view shows unknown, not zero", async () => {
    installBridge({ memory: null });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-memory-unavailable")).toBeTruthy();
    expect(q(h, "devcare-memory-used")?.textContent).toBe("—");
  });

  test("the boost button is disabled when nothing is reclaimable", async () => {
    installBridge({
      memory: {
        total_bytes: 8_000,
        available_bytes: 7_000,
        reclaimable: [],
        mode: "balanced",
        governor: true,
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-memory-reclaimable")?.textContent).toContain("0 个");
    expect((q(h, "devcare-boost") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("DeviceCareApp.svelte — audit trail (read side)", () => {
  const RECORDS = [
    {
      ts: 1_700_000_000,
      op: "app.uninstall",
      resource: "com.android.settings",
      outcome: "rejected",
      details: "protected",
    },
    {
      ts: 1_699_999_000,
      op: "devcare.clean",
      resource: "app_cache",
      outcome: "success",
      details: "freed_bytes=175",
    },
  ];

  test("renders the trail with localized ops + outcomes", async () => {
    installBridge({ trail: { durable: true, records: RECORDS } });
    const h = render(DeviceCareApp);
    await settle();
    expect(h.container.querySelectorAll('[data-testid="devcare-trail-entry"]')).toHaveLength(2);
    expect(txt(h)).toContain("清理垃圾");
    expect(txt(h)).toContain("成功");
    expect(txt(h)).toContain("卸载应用");
    expect(txt(h)).toContain("已拒绝执行");
    // The resource is data (a package id / category list), rendered verbatim.
    expect(txt(h)).toContain("com.android.settings");
    expect(q(h, "devcare-trail-empty")).toBeNull();
  });

  test("a durable daemon with no records says 'no records'", async () => {
    installBridge({ trail: { durable: true, records: [] } });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-trail-empty")).toBeTruthy();
    expect(q(h, "devcare-trail-nosink")).toBeNull();
  });

  test("no durable sink is NOT shown as 'no records'", async () => {
    installBridge({ trail: { durable: false, records: [] } });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-trail-nosink")).toBeTruthy();
    expect(q(h, "devcare-trail-empty")).toBeNull();
    expect(txt(h)).toContain("未启用持久审计");
  });

  test("an unreadable trail is an error, not 'no records'", async () => {
    installBridge({ trail: null });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-trail-error")).toBeTruthy();
    expect(q(h, "devcare-trail-empty")).toBeNull();
    expect(q(h, "devcare-trail-nosink")).toBeNull();
    expect(txt(h)).toContain("无法读取审计记录");
  });

  test("the trail stays visible when no clean backend is attached", async () => {
    // Reading the audit does not depend on the clean backend: hiding it would
    // hide the one thing that still works.
    installBridge({ available: false, trail: { durable: true, records: RECORDS } });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-junk")).toBeNull(); // no backend ⇒ no junk section
    expect(q(h, "devcare-trail")).toBeTruthy();
    expect(h.container.querySelectorAll('[data-testid="devcare-trail-entry"]')).toHaveLength(2);
    expect(txt(h)).toContain("清理垃圾");
  });
});

describe("DeviceCareApp.svelte — apps + permissions", () => {
  test("shows an uninstall action only for allowed apps and explains refusals", async () => {
    installBridge({
      apps: [
        {
          id: "com.example.game",
          name: "Game",
          system: false,
          size_bytes: 10,
          verdict: "allowed",
          reason_key: null,
        },
        {
          id: "com.android.settings",
          name: "Settings",
          system: true,
          size_bytes: 30,
          verdict: "protected",
          reason_key: "care.uninstall.protected",
        },
      ],
    });
    const h = render(DeviceCareApp);
    await settle();

    expect(q(h, "devcare-uninstall-com.example.game")).toBeTruthy();
    expect(q(h, "devcare-uninstall-com.android.settings")).toBeNull();
    expect(q(h, "devcare-verdict-com.android.settings")?.textContent).toContain("已受保护");
  });

  test("uninstalling goes through the policy command and reports refusal + audit", async () => {
    const calls = installBridge({
      apps: [
        {
          id: "com.example.game",
          name: "Game",
          system: false,
          size_bytes: 10,
          verdict: "allowed",
          reason_key: null,
        },
      ],
      uninstall: {
        id: "com.example.game",
        removed: false,
        verdict: "protected",
        reason_key: "care.uninstall.protected",
        message: "protected",
        audit: { recorded: 1, attempted: 1, reason: null },
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    await fireEvent.click(q(h, "devcare-uninstall-com.example.game")!);
    await settle();

    // The manager never calls the raw store uninstall: the policy cannot be
    // bypassed by the UI.
    expect(calls.some((c) => c.cmd === "appstore_uninstall")).toBe(false);
    expect(calls.find((c) => c.cmd === "devcare_uninstall")?.args?.id).toBe("com.example.game");
    // The refusal reason is shown, and the attempt is reported as audited.
    expect(q(h, "devcare-notice")?.textContent).toContain("已受保护");
    expect(q(h, "devcare-audit")?.textContent).toContain("已记录审计");
  });

  test("a launched uninstall is reported as 'waiting for confirmation', not removed", async () => {
    // Android ACTION_DELETE only requests the removal; the app is not gone until
    // the platform confirms, so the copy must not claim success.
    installBridge({
      apps: [
        {
          id: "com.example.game",
          name: "Game",
          system: false,
          size_bytes: 10,
          verdict: "allowed",
          reason_key: null,
        },
      ],
      uninstall: {
        id: "com.example.game",
        removed: false,
        launched: true,
        verdict: "allowed",
        reason_key: null,
        message: "uninstall intent launched",
        audit: { recorded: 1, attempted: 1, reason: null },
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    await fireEvent.click(q(h, "devcare-uninstall-com.example.game")!);
    await settle();

    expect(q(h, "devcare-notice")?.textContent).toContain("已请求卸载");
    expect(q(h, "devcare-notice")?.textContent).not.toContain("已卸载 ");
  });

  test("a long app list lives in a bounded scroll window, with a count", async () => {
    // A device has hundreds of packages: letting every row flow into the page
    // pushes permissions/memory several screens down (device-reported). The list
    // gets its own scroll window, and every row stays reachable inside it.
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `com.example.app${i}`,
      name: `App ${i}`,
      system: false,
      size_bytes: 1024,
      verdict: "allowed",
      reason_key: null,
    }));
    installBridge({ apps: many });
    const h = render(DeviceCareApp);
    await settle();

    const scroll = q(h, "devcare-apps-scroll") as HTMLElement | null;
    expect(scroll).toBeTruthy();
    expect(scroll?.className).toContain("overflow-y-auto");
    expect(scroll?.className).toContain("max-h-72");
    expect(scroll?.querySelectorAll('[data-testid^="devcare-app-"]').length).toBe(30);
    expect(q(h, "devcare-apps-count")?.textContent).toContain("30");
  });

  test("a long permission review also lives in a bounded scroll window", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      app_id: `com.example.p${i}`,
      resources: ["camera"],
    }));
    installBridge({ perms: { authority: "daemon", rows } });
    const h = render(DeviceCareApp);
    await settle();

    const scroll = q(h, "devcare-perms-scroll") as HTMLElement | null;
    expect(scroll).toBeTruthy();
    expect(scroll?.className).toContain("overflow-y-auto");
    expect(scroll?.querySelectorAll('[data-testid^="devcare-perm-"]').length).toBe(25);
    expect(q(h, "devcare-perms-count")?.textContent).toContain("25");
  });

  test("the uninstall preview is bridge-owned (the UI sends no inventory)", async () => {
    const calls = installBridge({
      apps: [
        {
          id: "com.x",
          name: "X",
          system: false,
          size_bytes: null,
          verdict: "allowed",
          reason_key: null,
        },
      ],
    });
    const h = render(DeviceCareApp);
    await settle();

    const call = calls.find((c) => c.cmd === "devcare_apps");
    expect(call).toBeTruthy();
    expect(call?.args).toBeUndefined(); // never a caller-supplied inventory
    // The component no longer reads the store registry directly.
    expect(calls.some((c) => c.cmd === "appstore_installed")).toBe(false);

    // An unknown declared size renders as unknown, never "0 B".
    const row = q(h, "devcare-app-com.x")?.textContent ?? "";
    expect(row).toContain("—");
    expect(row).not.toContain("0 B");
  });

  test("an unreadable inventory is not shown as 'no apps'", async () => {
    // `null` from the bridge means the read failed; rendering the empty state
    // would turn a failure into a silent "nothing to manage".
    installBridge({ apps: null });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-apps-error")).toBeTruthy();
    expect(q(h, "devcare-apps-empty")).toBeNull();
    expect(txt(h)).toContain("无法读取应用清单");
  });

  test("renders the read-only permission review rows from the daemon", async () => {
    installBridge({
      perms: {
        authority: "daemon",
        rows: [{ app_id: "com.example.game", resources: ["camera", "microphone"] }],
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    const row = q(h, "devcare-perm-com.example.game");
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("相机");
    expect(row?.textContent).toContain("麦克风");
    expect(q(h, "devcare-perms-unavailable")).toBeNull();
    expect(q(h, "devcare-perms-empty")).toBeNull();
  });

  test("an unreachable daemon is NOT shown as 'nothing is granted'", async () => {
    // The review's rows are the *authority's* answer: without it, an empty list
    // means "we cannot know", not "nothing is granted".
    installBridge({ perms: { authority: "unavailable", rows: [] } });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-perms-unavailable")).toBeTruthy();
    expect(q(h, "devcare-perms-empty")).toBeNull();
    expect(txt(h)).toContain("守护进程未连接，无法读取权限");
  });

  test("an authoritative review with no grants says so", async () => {
    installBridge({ perms: { authority: "daemon", rows: [] } });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-perms-empty")).toBeTruthy();
    expect(q(h, "devcare-perms-unavailable")).toBeNull();
  });

  test("an unreachable authority is handed to the report as UNOBSERVED, not as zero grants", async () => {
    // Regression: the report used to receive `sensitive_grants: 0` whenever the
    // daemon was unreachable — inventing an observation that marked the permission
    // area as assessed and let the care score certify a healthy permission state.
    // Unknown must stay unknown (P0-3).
    const calls = installBridge({ perms: { authority: "unavailable", rows: [] } });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-overview")).toBeTruthy();
    const report = calls.find((c) => c.cmd === "devcare_report");
    expect(report).toBeTruthy();
    expect(report?.args?.sensitiveGrants).toBeNull();
  });

  test("an authoritative review hands the report its real grant count", async () => {
    const calls = installBridge({
      perms: {
        authority: "daemon",
        rows: [
          { app_id: "com.a", resources: ["camera", "microphone"] },
          { app_id: "com.b", resources: ["location"] },
        ],
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-overview")).toBeTruthy();
    const report = calls.find((c) => c.cmd === "devcare_report");
    expect(report?.args?.sensitiveGrants).toBe(3);
  });
});

describe("DeviceCareApp.svelte — storage overview", () => {
  test("a measured reading renders the totals, percent, and category rows", async () => {
    installBridge();
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-storage")).toBeTruthy();
    expect(q(h, "devcare-storage-error")).toBeNull();
    expect(q(h, "devcare-storage-unknown")).toBeNull();
    expect(q(h, "devcare-storage-pct")?.textContent).toContain("25%");
    expect(q(h, "devcare-storage-app_cache")?.textContent).toContain("1 KB");
    const bar = q(h, "devcare-storage-bar") as HTMLElement | null;
    expect(bar?.getAttribute("style")).toContain("25%");
  });

  test("an unmeasurable backend renders 'unknown', never 0 B", async () => {
    // host-fs cannot read filesystem totals: showing 0 B would be invented data.
    installBridge({
      storage: {
        measured: false,
        total_bytes: null,
        used_bytes: null,
        free_bytes: null,
        used_pct: null,
        backend: "host-fs",
        groups: [],
        reclaimable_bytes: 0,
        review_bytes: 0,
      },
    });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-storage-unknown")).toBeTruthy();
    expect(q(h, "devcare-storage-pct")).toBeNull();
    expect(txt(h)).toContain("无法读取设备存储读数");
    expect(txt(h)).not.toContain("0 B");
  });

  test("a failed storage read is an error, not an empty device", async () => {
    installBridge({ storage: null });
    const h = render(DeviceCareApp);
    await settle();
    expect(q(h, "devcare-storage-error")).toBeTruthy();
    expect(q(h, "devcare-storage-unknown")).toBeNull();
  });
});

