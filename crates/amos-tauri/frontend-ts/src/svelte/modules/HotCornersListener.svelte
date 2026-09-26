<script lang="ts">
  /**
   * HotCornersListener.svelte — global mousemove listener for hot corners.
   *
   * Mounted once by DesktopShell. Listens to mousemove events and triggers
   * configured actions when the mouse hovers in a corner for the specified delay.
   *
   * **Aerospace-grade implementation**:
   * - Event-driven (no polling)
   * - Debounced via per-corner timers
   * - Modifier key support
   * - No DOM manipulation (delegates to shellModule)
   */
  import { onMount, getContext } from "svelte";
  import { createStoreValue } from "../store";
  import {
    DEFAULT_HOT_CORNERS,
    HOT_CORNER_KEY,
    isInHotZone,
    modifierMatches,
    normalizeHotCorners,
    type Corner,
    type HotCornerAction,
    type HotCornerConfig,
  } from "../../lib/hotCorners";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../../lib/shellModule";
  import { wmFocusWithDiag, wmHide, wmWindows } from "../../lib/wm";
  import type { BridgeDiag } from "../../lib/backend";

  const api = getContext<ShellChromeApi>(SHELL_CHROME_API);

  // Subscribed, not read-once: editing the corners in Settings must take effect at once
  // (the old `readStoreValue` at construction meant a change needed a reload — every other
  // store-backed surface here subscribes, this one was the odd copy out).
  const hotCorners = createStoreValue<HotCornerConfig[]>(HOT_CORNER_KEY, DEFAULT_HOT_CORNERS);

  const configs = $derived(normalizeHotCorners($hotCorners));

  // Per-corner hover timers (cleared when mouse leaves the zone)
  const timers = new Map<Corner, number>();

  // Track which corner was last active to prevent re-triggering
  let activeCorner: Corner | null = null;

  function handleMouseMove(e: MouseEvent) {
    const { clientX, clientY } = e;
    const { innerWidth, innerHeight } = window;

    let inAnyZone = false;

    for (const config of configs) {
      if (config.action === "disabled") continue;

      if (isInHotZone(clientX, clientY, innerWidth, innerHeight, config.corner)) {
        inAnyZone = true;

        // Modifier key check
        if (!modifierMatches(e, config.modifier)) {
          cancelTimer(config.corner);
          continue;
        }

        // Already has a timer running or action was triggered
        if (timers.has(config.corner) || activeCorner === config.corner) continue;

        // Start delay timer
        const id = window.setTimeout(() => {
          triggerAction(config.action);
          timers.delete(config.corner);
          activeCorner = config.corner;
        }, config.delay);

        timers.set(config.corner, id);
      } else {
        // Mouse left this corner's zone
        cancelTimer(config.corner);
        if (activeCorner === config.corner) {
          activeCorner = null;
        }
      }
    }

    // If mouse is not in any zone, reset active corner
    if (!inAnyZone) {
      activeCorner = null;
    }
  }

  function cancelTimer(corner: Corner) {
    const id = timers.get(corner);
    if (id !== undefined) {
      clearTimeout(id);
      timers.delete(corner);
    }
  }

  // ─── Show Desktop（「显示桌面」）──────────────────────────────────────────────
  //
  // REQ-A415: this action used to be a single `console.log("🖥️ Show Desktop (not yet
  // implemented)")` — an entry the Settings page offers, enabled in the default
  // configuration, that did nothing (FMEA F-SH-001: a control that looks usable).
  //
  // Semantics (macOS): move every *visible* app window out of the way so the desktop
  // shows through; the same gesture brings them back. What it remembers is exactly the
  // windows **it** hid, so a window the user opens while the desktop is showing is not
  // swept away by the second trigger (that is the difference between "restore" and
  // "hide everything again").
  //
  // Failure is not faked: a missing bridge (`wm_windows` ⇒ `null`) leaves the set empty
  // and nothing changes, and a per-window `wm_hide` that the host refused is simply not
  // remembered — so the restore cannot claim to bring back a window that never left.
  let deskHidden: string[] = [];

  /**
   * Report a refused `wm_focus` — the same breadcrumb the three sibling surfaces that
   * bring a window forward already leave (`AppExpose`, `MissionControl`, `DockContextMenu`).
   * `#diag.ok` means nothing was recorded, so there is nothing to explain.
   */
  function noteFocusRefused(label: string, diag: BridgeDiag): void {
    if (diag.ok) return;
    const code =
      diag.kind === "command-failed" && diag.detail && typeof diag.detail === "object"
        ? (diag.detail as { code?: string }).code
        : undefined;
    console.warn(`🛟 [HotCorners] wm_focus(${label}) refused`, code ?? diag.kind);
  }

  async function toggleShowDesktop(): Promise<void> {
    if (deskHidden.length > 0) {
      // `wm_focus` is show + focus, so the loop leaves the last window focused — macOS
      // also hands the focus to exactly one window.
      //
      // The restore half is the mirror of the hide half below: only a window the host
      // **confirmed** it brought back leaves the memory. An emptied-first list (the old
      // shape) made a refused window *gone*: still hidden, but no longer remembered — and
      // the next trigger only hides what is visible, so it could never return.
      const stillDown: string[] = [];
      for (const label of deskHidden) {
        const r = await wmFocusWithDiag(label);
        if (!r.ok) {
          stillDown.push(label);
          noteFocusRefused(label, r.diag);
        }
      }
      deskHidden = stillDown;
      return;
    }
    const snap = await wmWindows();
    if (!snap) return;
    for (const w of snap.windows) {
      if (w.kind !== "App" || w.state === "Hidden") continue;
      if (await wmHide(w.label)) deskHidden.push(w.label);
    }
  }

  function triggerAction(action: HotCornerAction) {
    if (action === "disabled") return; // the caller filters these out; belt and braces
    // Show Desktop drives the host's window manager directly and needs no chrome handle
    // (locking the screen, by contrast, is `shellState`'s).
    if (action === "desktop") {
      void toggleShowDesktop();
      return;
    }
    if (!api) {
      console.warn("ShellChromeApi not available");
      return;
    }

    switch (action) {
      case "mission-control":
        // REQ-A414: this used to toggle `"spaces"` — an id no overlay row has
        // (`shellModules.ts` declares `mission-control` / `spaces-panel`). The call was
        // accepted, entered `openOverlays`, rendered nothing, and then swallowed the
        // first `Escape`. The default top-left hot corner therefore did nothing at all.
        api.toggleOverlay("mission-control");
        break;
      case "launchpad":
        api.openLaunchpad();
        break;
      case "lock-screen":
        api.lockScreen();
        break;
      case "notification-center":
        // The one overlay row for this is `notifications` (`shellModules.ts`), the id the
        // bar's clock toggles (`modules/ClockWidget.svelte`). This branch sent
        // `control-center-panel`, so a corner labelled "Notification Center" opened Control
        // Center — the same wrong-id shape the `mission-control` case above was fixed for.
        api.toggleOverlay("notifications");
        break;
    }
  }

  onMount(() => {
    window.addEventListener("mousemove", handleMouseMove, { passive: true });

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      // Clean up all pending timers
      for (const id of timers.values()) {
        clearTimeout(id);
      }
      timers.clear();
    };
  });
</script>

<!-- No UI, pure event listener -->
