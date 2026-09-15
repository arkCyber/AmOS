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
  }: {
    label: string;
    testId: string;
    glyph: string;
    onclick: () => void;
    disabled?: boolean;
  } = $props();
</script>

<button
  type="button"
  aria-label={label}
  title={label}
  data-testid={testId}
  {disabled}
  aria-disabled={disabled ? "true" : undefined}
  {onclick}
  class="{CHROME_ICON_BUTTON} {disabled ? 'opacity-40 hover:bg-transparent' : ''}"
  style="text-shadow: {CHROME_TEXT_SHADOW};"
>{glyph}</button>
