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
  import { readStoreValue } from "../../lib/amosStore";
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
  import { wmFocus, wmHide, wmWindows } from "../../lib/wm";

  const api = getContext<ShellChromeApi>(SHELL_CHROME_API);

  let configs = $state<HotCornerConfig[]>(
    normalizeHotCorners(readStoreValue(HOT_CORNER_KEY, DEFAULT_HOT_CORNERS))
  );

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

  async function toggleShowDesktop(): Promise<void> {
    if (deskHidden.length > 0) {
      const back = deskHidden;
      deskHidden = [];
      // `wm_focus` is show + focus, so the loop leaves the last window focused — macOS
      // also hands the focus to exactly one window.
      for (const label of back) await wmFocus(label);
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
        api.toggleOverlay("control-center-panel");
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
