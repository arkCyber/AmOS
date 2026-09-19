<script lang="ts">
  /**
   * DesktopWindowKeys.svelte — the focused-window system keys for an **app window**.
   *
   * REQ-A419. `DesktopShell` (the launcher window) used to be mounted by *every* desktop
   * window, and it owned ⌘W / ⌘M / ⌘H / ⌘,. REQ-A416 made an app window render its own app
   * instead, which silently took those keys away from the windows they act on: measured on
   * this machine, with the Settings window key, **⌘W closed nothing** (⌘, kept working only
   * because it is a native-menu accelerator the OS owns).
   *
   * macOS semantics: ⌘W closes **the window you are in**. An app window knows its own label
   * (`DesktopAppWindow`'s `id`), so this component does not need the host's focus model at
   * all — no poll, no staleness, and no chance of closing a neighbour. The intent table and
   * the dispatch are the shared ones (`desktopSystemKeys.ts`), so the launcher and an app
   * window cannot drift apart.
   *
   * Capture phase + `stopPropagation`, like the launcher: after ⌘W the window is gone, and
   * letting the key bubble into the app's own controls first is how a "close" starts typing
   * a `w` into a field.
   */
  import { onMount } from "svelte";
  import { matchesShortcut } from "../../lib/keyboardConfigHook.svelte";
  import { createKeyboardBindings } from "../../lib/keyboardConfigHook.svelte";
  import { isDesktopFeatureEnabled } from "../../lib/desktopFeatures";
  import { deadChordMessage, refusedChordMessage, runSystemIntent, systemIntentFor } from "../desktopSystemKeys";
  import { handOverSystemKeys } from "../../lib/earlySystemKeys";
  import { isSelectAllChord, selectAllInFocus } from "../../lib/editKeys";
  import { amosWarn } from "../../lib/debugLog";

  /** The label of the window this component lives in (= the app id of the window). */
  let { label }: { label: string } = $props();

  const keyboardBindings = createKeyboardBindings();
  keyboardBindings.startListening();

  onMount(() => {
    /** Capture, so the window sees the chord before the app's own controls do. */
    const OPTIONS: AddEventListenerOptions = { capture: true };
    // REQ-A431: this window now owns the system chords — the boot-time listener installed by
    // `shell-entry.ts` stands down (it covered the seconds before this component mounted).
    handOverSystemKeys();
    const onKeyDown = (e: KeyboardEvent) => {
      // ⌘A first, outside the shortcuts switch: the platform never delivers it here (see
      // `lib/editKeys.ts`), and a text field must be selectable whatever the operator's
      // shortcut preference is.
      if (isSelectAllChord(e) && selectAllInFocus()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // The documented switch (`AMOS_DESKTOP_SHORTCUTS=disabled`) is honoured here exactly
      // as it is in the launcher: the operator asked the frontend not to take these keys.
      if (!isDesktopFeatureEnabled("shortcuts")) return;
      for (const [id, shortcut] of keyboardBindings.bindings.system) {
        const intent = systemIntentFor(id);
        if (!intent) continue;
        if (!matchesShortcut(shortcut, e)) continue;
        e.preventDefault();
        e.stopPropagation();
        // `label` is this window's own label: `main` cannot reach here (the launcher does
        // not mount this component), so `runSystemIntent` acts on a real app window. The
        // outcome is *checked*, not discarded (REQ-A424/REQ-A430): either there was no
        // window to act on, or the host refused the command — and both must be visible
        // rather than silent, or "the key was consumed and nothing happened" is
        // indistinguishable from "the key never arrived".
        void runSystemIntent(intent, label).then((outcome) => {
          if (!outcome.reason) return;
          amosWarn(
            "shell",
            outcome.reason === "host-refused"
              ? refusedChordMessage(intent, label)
              : deadChordMessage(intent),
            { label, reason: outcome.reason },
          );
        });
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, OPTIONS);
    return () => {
      window.removeEventListener("keydown", onKeyDown, OPTIONS);
      keyboardBindings.stopListening();
    };
  });
</script>

<!-- No UI: this is a key listener, like `HotCornersListener`. -->
