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

function installBridge(catalog: AppManifest[], installedInit: InstalledApp[]) {
  const installed = [...installedInit];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "appstore_catalog") return catalog;
    if (cmd === "appstore_installed") return installed;
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
});
