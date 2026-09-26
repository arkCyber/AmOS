/**
 * permissions-live-ledger.svelte.test.ts — the privacy dashboard must FOLLOW
 * `amos.permissions`, not photograph it (REQ-A1467 ∕ F-SH-738).
 *
 * `PermissionsApp` is the OS's **review** surface: its whole job is to answer "who can use
 * the camera / mic / location right now?". It read the ledger once, at mount:
 *
 *     let ledger = $state<PermissionLedger>(loadLedger());   // PermissionsApp.svelte:55, pre-fix
 *
 * and moved it only from its **own** writes (`adopt(res.ledger)`). But `amos.permissions` is
 * not this screen's store — it has writer sites on eight other screens
 * (`osPermissions.grantCapability` ∕ `revokeCapability`):
 *
 *   - `CameraApp.svelte:92`      grantCapability(APP_ID, CAMERA_CAP)   ← top-level, on mount
 *   - `MapsApp.svelte:137`       grantCapability("maps", "location")
 *   - `VoiceMemosApp.svelte:122` grantCapability("vmemos", "microphone")
 *   - `InterpApp.svelte:124`, `MagnifierApp.svelte:63`, the three voice-mic buttons, …
 *
 * On a tablet these are on stage together — the dashboard as the surface, the other app in
 * the Slide Over panel (or as the split's second pane). There, tapping the mic in one pane
 * writes the ledger, and nothing remounts the dashboard, so every row keeps describing the
 * ledger as it was when the dashboard opened: `地图` reads 关 for a grant that is really held,
 * and the holder chip for a revoked capability stays and promises a ⛔/★ that is no longer true.
 *
 * Why the existing cases cannot see it: `permissions.svelte.test.ts` and
 * `permissions-write-refused.svelte.test.ts` only ever write through the screen's **own**
 * controls (`adopt` moves the local `$state`), and every granted ledger is seeded into
 * `localStorage` *before* the render. A writer and this reader are never both live, so a value
 * that never changes is indistinguishable from a value that is followed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import PermissionsApp from "../src/svelte/PermissionsApp.svelte";
import { writeStoreValueChecked } from "../src/lib/amosStore";
import { PERMISSIONS_KEY, loadLedger } from "../src/lib/permissions";
import { grantCapability, mirrorRefused, revokeCapability } from "../src/svelte/osPermissions";
import { setLocale } from "../src/svelte/locale.svelte";

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
/** A capability row's "can turn on" button — `aria-pressed` is that tile's verdict. */
const candidates = (h: { container: HTMLElement }): HTMLButtonElement[] =>
  [...h.container.querySelectorAll("button[aria-pressed]")] as HTMLButtonElement[];
const candidate = (h: { container: HTMLElement }, starts: string): HTMLButtonElement | undefined =>
  candidates(h).find((b) => (b.textContent ?? "").trim().startsWith(starts));
/** A green holder chip (the one carrying the ✕), click = revoke. */
const holderChip = (h: { container: HTMLElement }, name: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").includes(name) && !!b.querySelector('[data-icon="x"]'),
  ) as HTMLButtonElement | undefined;
const byApp = (h: { container: HTMLElement }) => h.container.querySelector('[data-testid="perm-by-app"]');

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});
afterEach(() => {
  cleanup();
  setLocale("zh");
});

describe("PermissionsApp.svelte — the ledger follows amos.permissions (REQ-A1467)", () => {
  test("a grant another app made while the dashboard is open lights its row without a remount", async () => {
    const host = render(PermissionsApp);
    await tick();
    expect(candidate(host, "地图 ·")?.getAttribute("aria-pressed")).toBe("false");

    // The write `MapsApp.confirmAndGrant` makes — a second writer outside this component.
    const res = grantCapability("maps", "location");
    expect(res.landed).toBe(true);
    await tick();

    expect(
      candidate(host, "地图 ·")?.getAttribute("aria-pressed"),
      `the location row should follow the ledger — got: ${txt(host)}`,
    ).toBe("true");
    // …and the review half (app-centric view) draws the new holder too.
    expect(byApp(host)?.textContent ?? "").toContain("地图");
  });

  test("a revoke another app made while the dashboard is open removes the holder chip", async () => {
    expect(writeStoreValueChecked(PERMISSIONS_KEY, { vmemos: ["microphone"] })).toBe(true);
    const host = render(PermissionsApp);
    await tick();
    expect(holderChip(host, "语音备忘录"), "the seeded holder should be drawn").toBeTruthy();

    // The write `InterpApp`/the mic buttons make when the user turns the mic off elsewhere.
    const res = revokeCapability("vmemos", "microphone");
    expect(res.landed).toBe(true);
    await tick();

    // The capability is really not held now, so no chip may keep offering it.
    expect(holderChip(host, "语音备忘录")).toBeUndefined();
    expect(candidate(host, "语音备忘录 ·")?.getAttribute("aria-pressed")).toBe("false");
  });

  test("complement: this screen's own toggle still writes the key and moves the tile", async () => {
    const host = render(PermissionsApp);
    await tick();
    const cam = candidate(host, "相机 ·")!;
    expect(cam.getAttribute("aria-pressed")).toBe("false");

    await fireEvent.click(cam);
    await tick();

    expect(candidate(host, "相机 ·")?.getAttribute("aria-pressed")).toBe("true");
    expect((loadLedger().camera ?? []).includes("camera")).toBe(true);
  });
});

/**
 * The refusal marks are keyed by `app|cap`, so they are only meaningful against the ledger
 * the page is showing. A refusal the daemon recorded *before* this page opened (another
 * screen made the grant) is already in `mirrorRefused` at mount — the page has to read it
 * then, not wait for some later verdict to happen to arrive.
 */
describe("PermissionsApp.svelte — a refusal recorded before the page opened (REQ-A1467)", () => {
  beforeEach(() => {
    // A daemon socket that is not there: both the write and the read fail.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd.startsWith("perm_")) throw new Error(`${cmd} refused`);
        return null;
      },
      listen: async () => () => {},
    };
  });
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("the ⛔ is drawn at mount, with no later verdict to carry it", async () => {
    expect(grantCapability("camera", "camera").landed).toBe(true);
    await vi.waitFor(() => expect(mirrorRefused("camera", "camera")).toBe(true));

    const host = render(PermissionsApp);
    await tick();

    expect(
      host.container.querySelector('[data-testid="perm-mirror-camera-camera"]'),
      `the refusal should be drawn off the ledger at mount — got: ${txt(host)}`,
    ).toBeTruthy();
  });
});
