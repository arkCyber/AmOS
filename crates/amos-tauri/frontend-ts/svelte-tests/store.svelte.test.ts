/**
 * DOM tests for the Svelte 5 app-store screen (StoreApp.svelte). Offline (no
 * bridge) shows a localized notice; with a fake appstore bridge the catalog
 * renders with install/update/uninstall affordances (pure lib/backend bridge,
 * same as React). Real download/verify/install needs the appstore daemon.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import StoreApp from "../src/svelte/StoreApp.svelte";
import type { AppManifest, AppVersion, InstalledApp } from "../src/lib/backend";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
/** The "Update" *buttons* (the tagline also contains the word 更新). */
const updateButtons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "更新");
const settle = () => new Promise((r) => setTimeout(r, 40));

function mk(id: string, name: string, major: number, minor: number, patch: number): AppManifest {
  const version: AppVersion = { major, minor, patch, pre: null };
  return {
    id,
    name,
    summary: `${name} summary`,
    author: "Acme",
    version,
    category: "tools",
    package: { format: "zip", url: `https://x/${id}.zip`, sha256: null, size_bytes: null },
  };
}

function installBridge(
  catalog: AppManifest[],
  installedInit: InstalledApp[],
  updatableIds: string[] | undefined = undefined,
) {
  const installed = [...installedInit];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "appstore_catalog") return catalog;
    if (cmd === "appstore_installed") return installed;
    // `undefined` ⇒ this (older) host cannot answer → the UI's own comparison is
    // the documented fallback.
    if (cmd === "appstore_updatable") return updatableIds === undefined ? null : updatableIds;
    if (cmd === "appstore_install" || cmd === "appstore_upgrade") {
      const id = String(args?.id);
      const m = catalog.find((a) => a.id === id);
      if (m) {
        const i = installed.findIndex((x) => x.manifest.id === id);
        const app: InstalledApp = { manifest: m, installed_at: 1_700_000_000 };
        if (i >= 0) installed[i] = app;
        else installed.push(app);
      }
      return null;
    }
    if (cmd === "appstore_uninstall") {
      const id = String(args?.id);
      const i = installed.findIndex((x) => x.manifest.id === id);
      if (i >= 0) installed.splice(i, 1);
      return null;
    }
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

describe("StoreApp.svelte", () => {
  test("offline shows the store-unavailable notice", async () => {
    const host = render(StoreApp);
    await settle();
    expect(txt(host)).toContain("商店服务不可用");
  });

  test("bridged catalog shows 获取 for uninstalled and 已安装 for installed", async () => {
    const a = mk("alpha", "Alpha App", 1, 0, 0);
    const b = mk("beta", "Beta App", 2, 0, 0);
    installBridge([a, b], [{ manifest: a, installed_at: 1_700_000_000 }]);
    const host = render(StoreApp);
    await settle();
    await settle();
    expect(txt(host)).toContain("Alpha App");
    expect(txt(host)).toContain("Beta App");
    expect(txt(host)).toContain("已安装"); // alpha is installed
    expect(txt(host)).toContain("获取"); // beta is available to install
    expect(txt(host)).toContain("v1.0.0");
  });

  test("the host's updatable list decides (not the UI's own version compare)", async () => {
    // The catalog carries the SAME version as the installed manifest, so any local
    // comparison says "not updatable" — but the host (which owns the semantic
    // comparison, docs/appstore.md) reports alpha as updatable.
    const a = mk("alpha", "Alpha App", 1, 0, 0);
    const b = mk("beta", "Beta App", 2, 0, 0);
    installBridge([a, b], [{ manifest: a, installed_at: 1_700_000_000 }], ["alpha"]);
    const host = render(StoreApp);
    await settle();
    await settle();
    expect(updateButtons(host)).toHaveLength(1); // store.update — host says so
  });

  test("a host that reports nothing updatable is believed over the local compare", async () => {
    // Catalog is newer than the installed manifest, so the UI's fallback would
    // offer an update — but the host (authoritative) says there is none.
    const a = mk("alpha", "Alpha App", 1, 0, 0);
    const newer = mk("alpha", "Alpha App", 9, 9, 9);
    installBridge([newer], [{ manifest: a, installed_at: 1_700_000_000 }], []);
    const host = render(StoreApp);
    await settle();
    await settle();
    expect(updateButtons(host)).toHaveLength(0);
    expect(txt(host)).toContain("已安装");
  });

  test("falls back to the local compare when the host cannot answer", async () => {
    const a = mk("alpha", "Alpha App", 1, 0, 0);
    const newer = mk("alpha", "Alpha App", 2, 0, 0);
    installBridge([newer], [{ manifest: a, installed_at: 1_700_000_000 }]); // updatable → null
    const host = render(StoreApp);
    await settle();
    await settle();
    expect(updateButtons(host)).toHaveLength(1);
  });
});
