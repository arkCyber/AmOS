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

  function triggerAction(action: HotCornerAction) {
    if (!api) {
      console.warn("ShellChromeApi not available");
      return;
    }

    switch (action) {
      case "mission-control":
        api.toggleOverlay("spaces");
        break;
      case "launchpad":
        api.openLaunchpad();
        break;
      case "desktop":
        // TODO: Minimize all windows (show desktop)
        // This requires wm integration to minimize all open windows
        console.log("🖥️ Show Desktop (not yet implemented)");
        break;
      case "lock-screen":
        api.lockScreen();
        break;
      case "notification-center":
        api.toggleOverlay("control-center-panel");
        break;
      case "disabled":
        // Should never reach here
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
