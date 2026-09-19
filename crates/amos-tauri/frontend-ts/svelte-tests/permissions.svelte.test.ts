/**
 * DOM tests for the Svelte 5 privacy/permissions screen (PermissionsApp.svelte).
 *
 * Pure ledger logic is unit-tested once against lib/permissions.ts (shared by
 * the React + Svelte UIs). Here we verify the Svelte UI wiring works fully
 * OFFLINE: the daemon "recent access" audit section must stay hidden (no bridge),
 * while local grant/revoke toggles update the persisted ledger immediately.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import PermissionsApp from "../src/svelte/PermissionsApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { PERMISSIONS_KEY } from "../src/lib/permissions";
// The **oracles** the assertions below read, so the test holds no copy of the UI's
// tables: the app names come from `lib/appMeta`, the strings from the zh dictionary,
// and the default-on matrix from `osCapabilities` itself.
import { appTitleKey } from "../src/lib/appMeta";
import { zh } from "../src/i18n/locales/zh";
import { translate } from "../src/svelte/i18n";
import { DEFAULT_ON_CAPABILITIES, defaultAppsFor } from "../src/svelte/osCapabilities";

function candidates(h: { container: HTMLElement }): HTMLButtonElement[] {
  return [...h.container.querySelectorAll("button[aria-pressed]")];
}
const cameraCandidate = (h: { container: HTMLElement }) =>
  candidates(h).find((b) => (b.textContent ?? "").startsWith("相机 ·"));

describe("PermissionsApp.svelte (offline ledger)", () => {
  test("no daemon audit section when offline; camera capability is listed", () => {
    const host = render(PermissionsApp);
    // auditOnline stays false → the audit section header is absent
    expect(host.container.textContent ?? "").not.toContain("最近访问");
    expect(cameraCandidate(host)).toBeTruthy();
  });

  test("granting the camera capability to the camera app persists to the ledger", async () => {
    const host = render(PermissionsApp);
    const cam = cameraCandidate(host)!;
    expect(cam.getAttribute("aria-pressed")).toBe("false");

    await fireEvent.click(cam);
    expect(cameraCandidate(host)!.getAttribute("aria-pressed")).toBe("true");

    const ledger = readStoreValue<Record<string, string[]>>(PERMISSIONS_KEY, {});
    expect((ledger.camera ?? []).includes("camera")).toBe(true);
  });

  test("revoking via the green holder chip clears the grant", async () => {
    const host = render(PermissionsApp);
    await fireEvent.click(cameraCandidate(host)!);
    expect(cameraCandidate(host)!.getAttribute("aria-pressed")).toBe("true");

    // The granted holder appears as a green chip "相机 ✕"; click to revoke.
    const holder = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("相机") && !!b.querySelector('[data-icon="x"]'),
    );
    expect(holder).toBeTruthy();
    await fireEvent.click(holder as HTMLButtonElement);

    expect(cameraCandidate(host)!.getAttribute("aria-pressed")).toBe("false");
    const ledger = readStoreValue<Record<string, string[]>>(PERMISSIONS_KEY, {});
    expect(ledger.camera ?? []).not.toContain("camera");
  });

  test("an app-centric section lists what each app may access (lib/permissions.grantedCaps)", () => {
    writeStoreValue(PERMISSIONS_KEY, { camera: ["camera"], maps: ["location"] });
    const host = render(PermissionsApp);
    const byApp = host.container.querySelector('[data-testid="perm-by-app"]');
    expect(byApp).toBeTruthy();
    const text = byApp?.textContent ?? "";
    expect(text).toContain("相机"); // app.camera + its capability
    expect(text).toContain("地图"); // app.maps
    expect(text).toContain("定位"); // perm.cap.location
  });

  test("no app holds anything → the app-centric section is absent", () => {
    const host = render(PermissionsApp);
    expect(host.container.querySelector('[data-testid="perm-by-app"]')).toBeNull();
  });
});

/**
 * The **default-on** apps (REQ-A380: `svelte/osCapabilities.ts` seeds Camera and
 * Voice Memos' microphone on the first boot) must be offerable in the capability
 * row that grants them.
 *
 * The defect this pins: `CANDIDATES` in `PermissionsApp.svelte` is a hand-written
 * showcase list, and it did not mention `vmemos` — so the app the OS *itself*
 * grants the microphone to was missing from the microphone row. The user could
 * revoke it (it appears as a granted holder) and then had **no way back on** in
 * that session: the holder chip disappears with the grant and the row that turns
 * a capability back on never listed it. `osCapabilities.defaultAppsFor` is the one
 * function that knows the matrix, and it had no production caller at all.
 */
describe("PermissionsApp.svelte (default-on apps stay reachable)", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  /** The per-capability section whose header names `label` (e.g. 麦克风). */
  function capSection(h: { container: HTMLElement }, label: string): HTMLElement | undefined {
    return [...h.container.querySelectorAll("section")].find((s) =>
      (s.querySelector("h3")?.textContent ?? "").includes(label),
    );
  }
  /** The candidate buttons (the row that grants) of one capability section. */
  function rowButtons(section: HTMLElement | undefined): HTMLButtonElement[] {
    return [...(section?.querySelectorAll("button[aria-pressed]") ?? [])] as HTMLButtonElement[];
  }

  test("every default-on (app, capability) pair is offered in its row — the table cannot drift", () => {
    // Table-driven **from the module**, not from a list copied into the test: a new
    // default-on entry (a new app, a new capability) that `PermissionsApp` forgets now
    // fails here instead of shipping a dead end. `vmemos` + microphone was that case.
    const host = render(PermissionsApp);
    for (const cap of DEFAULT_ON_CAPABILITIES) {
      const row = rowButtons(capSection(host, translate(zh, `perm.cap.${cap}`)));
      expect(row.length, `no candidate row for ${cap}`).toBeGreaterThan(0);
      for (const app of defaultAppsFor(cap)) {
        const key = appTitleKey(app);
        // The localized name from `lib/appMeta` — a raw id (`vmemos`) must fail too.
        const name = key ? translate(zh as unknown as Record<string, string>, key) : app;
        const offered = row.some((b) => (b.textContent ?? "").startsWith(name));
        expect(offered, `${name} is missing from the ${cap} candidate row`).toBe(true);
      }
    }
  });

  test("revoking a default-on grant is reversible in the same session", async () => {
    const host = render(PermissionsApp);
    const vmemos = () =>
      rowButtons(capSection(host, "麦克风")).find((b) =>
        (b.textContent ?? "").startsWith("语音备忘录"),
      );

    // Grant it from the row, revoke it through the granted holder chip (the path a
    // user takes), and then go back through the row — the way back on.
    await fireEvent.click(vmemos()!);
    expect(vmemos()!.getAttribute("aria-pressed")).toBe("true");

    const holder = [...host.container.querySelectorAll("button")].find(
      (b) =>
        (b.textContent ?? "").startsWith("语音备忘录") && !!b.querySelector('[data-icon="x"]'),
    );
    expect(holder, "the granted holder chip should exist").toBeTruthy();
    await fireEvent.click(holder as HTMLButtonElement);
    expect(vmemos()!.getAttribute("aria-pressed")).toBe("false");

    await fireEvent.click(vmemos()!);
    expect(vmemos()!.getAttribute("aria-pressed")).toBe("true");
    const ledger = readStoreValue<Record<string, string[]>>(PERMISSIONS_KEY, {});
    expect(ledger.vmemos ?? []).toContain("microphone");
  });
});

describe("PermissionsApp.svelte (daemon ↔ ledger drift)", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.localStorage.clear();
  });

  /** Bridge whose `perm_authorize` answers `verdict` for every (app, cap). */
  function bridge(verdict: boolean) {
    const calls: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "perm_authorize") return verdict;
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }

  test("flags a local grant the daemon denies", async () => {
    // The local ledger grants camera→camera, the daemon denies it: the dashboard
    // must say so instead of silently implying the two agree.
    writeStoreValue(PERMISSIONS_KEY, { camera: ["camera"] });
    bridge(false);
    const host = render(PermissionsApp);
    await vi.waitFor(() => {
      expect(
        host.container.querySelector('[data-testid="perm-drift-camera-camera"]'),
      ).toBeTruthy();
    });
  });

  test("shows no drift marker when the daemon agrees", async () => {
    writeStoreValue(PERMISSIONS_KEY, { camera: ["camera"] });
    bridge(true);
    const host = render(PermissionsApp);
    await vi.waitFor(() => {
      expect(cameraCandidate(host)!.getAttribute("aria-pressed")).toBe("true");
    });
    // Give the async verdict a chance to land, then assert it stayed clean.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(host.container.querySelector('[data-testid^="perm-drift-"]')).toBeNull();
  });
});

describe("PermissionsApp.svelte (daemon-only grants)", () => {
  afterEach(() => {
    cleanup();
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.localStorage.clear();
  });

  /**
   * Bridge answering `perm_grants_all` from `rows` (mutable: a `perm_revoke` empties
   * it, so the component's re-read reflects the authority instead of assuming).
   */
  function bridgeWith(rows: unknown) {
    let current = rows;
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        if (cmd === "perm_grants_all") return current;
        if (cmd === "perm_revoke") {
          current = [];
          return null;
        }
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }

  const daemonSection = (h: { container: HTMLElement }) =>
    h.container.querySelector('[data-testid="perm-daemon-grants"]');

  test("lists a grant that exists only in the daemon's store", async () => {
    // The daemon reloads its store from AMOS_PRIVACY_PATH, so it can hold a grant
    // this device's ledger never saw — the review page must show it.
    const calls = bridgeWith([{ app_id: "com.other", resources: ["camera"] }]);
    const host = render(PermissionsApp);
    await vi.waitFor(() => expect(daemonSection(host)).toBeTruthy());
    const text = daemonSection(host)?.textContent ?? "";
    expect(text).toContain("com.other");
    expect(text).toContain("相机");
    expect(calls.some((c) => c.cmd === "perm_grants_all")).toBe(true);
  });

  test("no section when the daemon cannot answer, and unknown wire keys are skipped", async () => {
    // `null` meaning "no daemon" must never be rendered as "nothing granted".
    bridgeWith(null);
    const silent = render(PermissionsApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(daemonSection(silent)).toBeNull();
    cleanup();

    // A resource this build does not know is not invented into a capability row.
    bridgeWith([{ app_id: "com.other", resources: ["nfc"] }]);
    const unknown = render(PermissionsApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(daemonSection(unknown)).toBeNull();
  });

  test("a grant the local ledger already lists is not repeated as daemon-only", async () => {
    writeStoreValue(PERMISSIONS_KEY, { camera: ["camera"] });
    bridgeWith([{ app_id: "camera", resources: ["camera"] }]);
    const host = render(PermissionsApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(cameraCandidate(host)!.getAttribute("aria-pressed")).toBe("true");
    expect(daemonSection(host)).toBeNull();
  });

  test("revoking a daemon-only grant goes to the authority and the row goes away", async () => {
    const calls = bridgeWith([{ app_id: "com.other", resources: ["microphone"] }]);
    const host = render(PermissionsApp);
    await vi.waitFor(() => expect(daemonSection(host)).toBeTruthy());

    const btn = daemonSection(host)!.querySelector("button") as HTMLButtonElement;
    await fireEvent.click(btn);

    await vi.waitFor(() => expect(daemonSection(host)).toBeNull());
    expect(calls).toContainEqual({
      cmd: "perm_revoke",
      args: { appId: "com.other", resource: "microphone" },
    });
  });
});
