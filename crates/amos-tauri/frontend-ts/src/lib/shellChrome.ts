/**
 * shellChrome.ts — the desktop chrome's **one** place for how it looks.
 *
 * Why: every panel widget used to spell its own hit target, hover colour, radius
 * and text shadow inline (`TopBar.svelte` repeated the same `text-shadow` style
 * eight times and sized its buttons 20×20 while the menu buttons were a different
 * shape). That is exactly how a bar ends up with three hover greys and two icon
 * sizes — the failure mode is not one wrong value, it is five copies of a value.
 * A theme in one place is also what makes the panel/applet split work in COSMIC:
 * the applets do not choose the panel's look, `libcosmic`'s theme does.
 *
 * The numbers are macOS-ish for a 40 px bar (28 px content + notch strip): a 24 px
 * hit target, a 6 px radius, a 12 px label. They are deliberately **not**
 * interpolated from the constants below — Tailwind only sees literal class names
 * at build time, so a template string would silently produce an unstyled bar. The
 * constants exist to document and test the intended size instead.
 *
 * Honest boundary: this is a *shape* token set, not a design system — colour comes
 * from the same white-on-glass palette the shell already uses, and the real look
 * (blur, vibrancy, dock magnification curves) is still a device/eye item
 * (`docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` G6).
 */

/**
 * An interactive chrome glyph (a button in the bar): a 24 px hit target (`h-6
 * min-w-6`, macOS-ish for this 40 px bar), a hover wash, and a **focus-visible
 * ring** — the bar is reachable by keyboard (⌘Space/F4 are bound; Tab must be able
 * to walk the widgets, and on a dark glass bar a missing focus ring is invisible,
 * not merely ugly).
 *
 * The size is spelled here rather than interpolated from a constant: Tailwind only
 * sees literal class names at build time, so a template string would silently
 * produce an unstyled bar. `chrome-widgets.svelte.test.ts` asserts the rendered
 * buttons actually carry these classes, which is what keeps the "one place" claim
 * true.
 */
export const CHROME_ICON_BUTTON =
  "inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1 " +
  "text-[12px] leading-none text-white/70 transition-colors " +
  "hover:bg-white/10 hover:text-white active:bg-white/15 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

/** A menu entry in the bar (text button, same wash and ring, wider padding). */
export const CHROME_MENU_BUTTON =
  "rounded px-2 py-0.5 text-[12px] text-white/80 transition-colors " +
  "hover:bg-white/10 hover:text-white " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

/** Read-only chrome text (app name, menu title). */
export const CHROME_TEXT = "text-[12px] font-medium text-white/90";

/** A numeric read-out (clock, battery %) — `tabular-nums` so digits do not jitter. */
export const CHROME_READOUT = "text-[12px] tabular-nums text-white/90";

/**
 * Minimum width for a read-out, so a wider value does not shift every widget to
 * its right (macOS reserves the clock's space for the same reason; a bar that
 * moves while you watch it is the cheapest way to look unfinished).
 */
export const CHROME_READOUT_MIN_WIDTH = "3.5rem";

/** Non-interactive status glyph (Wi-Fi / cellular): no hover, dim when off. */
export const CHROME_STATUS_GLYPH = "inline-flex items-center justify-center transition-opacity";

/**
 * The drop shadow every glyph/text in the bar carries. The bar is translucent
 * glass, so a white glyph over a light wallpaper needs its own contrast — this is
 * applied as an inline `style` (it is a shadow, not a colour token), from one
 * constant instead of eight copies.
 */
export const CHROME_TEXT_SHADOW = "0 1px 2px rgba(0,0,0,0.3)";
