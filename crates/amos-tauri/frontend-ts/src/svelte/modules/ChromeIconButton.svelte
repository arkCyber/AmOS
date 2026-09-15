<script lang="ts">
  /**
   * ChromeIconButton.svelte — one interactive glyph in the desktop chrome.
   *
   * The bar's buttons all looked slightly different (20×20 here, 24×24 there, three
   * hover greys, no focus ring) because each one spelled its own classes. This is
   * the single implementation the widgets share, so the *look* has one owner:
   * `lib/shellChrome.ts`. A widget supplies what it says and what it does, never how
   * it looks.
   */
  import { CHROME_ICON_BUTTON, CHROME_TEXT_SHADOW } from "../../lib/shellChrome";
  import type { ShortcutHint } from "../../lib/shellModule";

  let {
    /** Accessible name + tooltip. Must come from `t(...)` — never a literal. */
    label,
    /** `data-testid` so tests address the widget, not the glyph inside it. */
    testId,
    glyph,
    onclick,
    /** `true` for a control that is deliberately not wired yet (see StatusWidget's
     * sibling note in the audit: an inert control must say so instead of soaking up
     * a click and doing nothing). */
    disabled = false,
    /**
     * `true` when this control's surface is currently up. Rendered as `aria-expanded`,
     * because a toggle whose state the assistive layer cannot hear is a toggle that lies
     * about half of what it does (the Control Center item is the one that needs it).
     * `undefined` (the default) means "not a disclosure control" and renders no attribute.
     */
    expanded,
    /**
     * The key that does the same thing, from the registry (`api.overlayShortcut`) —
     * shown in the tooltip and exposed as `aria-keyshortcuts`. A widget that has no
     * binding passes `null` and shows no hint: inventing one would be worse than the
     * silence (a shortcut nobody can press is exactly the kind of claim this round
     * removed from the docs).
     */
    shortcut = null,
  }: {
    label: string;
    testId: string;
    glyph: string;
    onclick: () => void;
    disabled?: boolean;
    expanded?: boolean;
    shortcut?: ShortcutHint | null;
  } = $props();
</script>

<button
  type="button"
  aria-label={label}
  title={shortcut ? `${label} (${shortcut.label})` : label}
  aria-keyshortcuts={shortcut?.aria}
  aria-expanded={expanded}
  data-testid={testId}
  {disabled}
  aria-disabled={disabled ? "true" : undefined}
  {onclick}
  class="{CHROME_ICON_BUTTON} {disabled ? 'opacity-40 hover:bg-transparent' : ''}"
  style="text-shadow: {CHROME_TEXT_SHADOW};"
>{glyph}</button>
