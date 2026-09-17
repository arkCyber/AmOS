<script lang="ts">
  // ShortcutHud.svelte — the "hold ⌘" shortcut panel (REQ-A338).
  //
  // Why this exists: `docs/UI_APPLE_HIG_AUDIT.md` §16 records the touch shell's keyboard
  // admission (⌘Space / F3 / ⌘Tab / F4 / ⌘[ / ⌘,) and its boundary ⑤ admitted the obvious hole —
  // **nothing on screen said so**. iPadOS answers that with a panel you get by holding ⌘, and
  // that is exactly what this is.
  //
  // Two rules, both learned from this audit's own failures:
  //   1. **The content is generated, never hand-written.** `touchShortcutCatalog()` walks the
  //      desktop chrome's registry plus the shell's own system keys, and the unit tests pin the
  //      result — so a new key cannot exist in the engine and be missing here (the defect class
  //      REQ-A335 closed), and the labels are i18n keys, so no string is inlined.
  //   2. **A chord must not flash it.** Holding ⌘ to *use* a shortcut is the common case; the
  //      panel only appears after `HOLD_MS` of the modifier being down alone, and any other key
  //      gets it out of the way immediately.
  //
  // It is a `role="status"` region, **not** `aria-hidden`: the first version hid it from assistive
  // tech on the theory that "nobody can hold a key and read at the same time" — which is wrong,
  // and the repo's own `a11y-scan` said so (it flagged the component: a timer-driven readout with
  // no live region). A VoiceOver user with an external keyboard gets the same answer as everyone
  // else: hold ⌘, and the list is announced.
  import { t } from "./locale.svelte";
  import { SHELL_MODULES } from "./shellModules";
  import { touchShortcutCatalog } from "../lib/systemKeys";

  /** How long a modifier must be held, with nothing else pressed, before the panel appears. */
  const HOLD_MS = 350;

  let visible = $state(false);
  let timer: number | null = null;

  const rows = touchShortcutCatalog(SHELL_MODULES);

  function clearTimer() {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  $effect(() => {
    const hide = () => {
      clearTimer();
      visible = false;
    };
    const onDown = (e: KeyboardEvent) => {
      // Entering: only the modifiers the panel is about (⌘, and Ctrl for external keyboards —
      // the same equivalence `shortcutMatches` uses). Repeats while held must not restart it,
      // and any *other* key means the user is using a shortcut, not asking what they are.
      const modifier = e.key === "Meta" || e.key === "Control";
      if (!modifier || e.repeat || visible) {
        if (visible && !modifier) hide();
        return;
      }
      if (timer === null) {
        timer = window.setTimeout(() => {
          timer = null;
          visible = true;
        }, HOLD_MS);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") hide();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", hide);
    // The panel must not survive the shell losing the window (app switch, lock, call).
    return () => {
      clearTimer();
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", hide);
    };
  });
</script>

{#if visible}
  <div
    class="pointer-events-none absolute inset-0 z-50 grid place-items-center bg-black/20"
    role="status"
    aria-live="polite"
    data-testid="shortcut-hud"
  >
    <div class="fx-fade w-[22rem] max-w-[85%] rounded-2xl bg-white/95 p-4 shadow-2xl backdrop-blur-md dark:bg-neutral-900/95">
      <h3 class="mb-3 text-center text-[13px] font-semibold tracking-wide opacity-60">
        {t("shell.shortcuts")}
      </h3>
      <ul class="flex flex-col gap-2">
        {#each rows as row (row.keys + row.labelKey)}
          <li class="flex items-center justify-between gap-4 text-[14px]">
            <span class="truncate">{t(row.labelKey)}</span>
            <kbd
              class="shrink-0 rounded-md bg-black/5 px-2 py-1 font-sans text-[13px] font-medium tabular-nums dark:bg-white/10"
            >{row.keys}</kbd>
          </li>
        {/each}
      </ul>
    </div>
  </div>
{/if}
