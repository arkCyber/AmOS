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
 * Round 2 (REQ-A262) added the tokens the **dock** and the **menu panels** need
 * (they used to spell their own tile / panel / separator / running-dot classes in
 * `Dock.svelte` and `DesktopStage.svelte`): one place now covers the bar, the dock
 * items, the dropdown panels and the running indicator.
 *
 * Honest boundary: this is a *shape* token set, not a design system — colour comes
 * from the same white-on-glass palette the shell already uses, and the real look
 * (blur, vibrancy, dock magnification curves) is still a device/eye item
 * (`docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` G6). Two of the shortcuts this file used to
 * *claim* are bound were not (`F4`); they are now filtered through the registry table
 * (`lib/shellModule.ts`) instead of being asserted in a comment.
 */

/**
 * An interactive chrome glyph (a button in the bar): a 24 px hit target (`h-6
 * min-w-6`, macOS 标准为 24px bar), a hover wash, and a **focus-visible
 * ring** — the bar is reachable by keyboard (⌘Space/F4/F3 are bound, from the
 * registry table; Tab must be able to walk the widgets, and on a dark glass bar a
 * missing focus ring is invisible, not merely ugly).
 *
 * macOS 实测字号：13px body（菜单文字）、11px subheadline（次要信息）。
 */
export const CHROME_ICON_BUTTON =
  "inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1 " +
  "text-[13px] leading-none text-white/70 transition-colors " +
  "hover:bg-white/10 hover:text-white active:bg-white/15 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

/** A menu entry in the bar (text button, same wash and ring, wider padding). */
export const CHROME_MENU_BUTTON =
  "rounded px-2 py-0.5 text-[13px] text-white/80 transition-colors " +
  "hover:bg-white/10 hover:text-white " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

/** Read-only chrome text (app name, menu title). */
export const CHROME_TEXT = "text-[13px] font-medium text-white/90";

/** A numeric read-out (clock, battery %) — `tabular-nums` so digits do not jitter. */
export const CHROME_READOUT = "text-[13px] tabular-nums text-white/90";

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

/**
 * A dock item's icon tile (macOS 实测 48px 图标 + 16px 圆角).
 *
 * The size / border / font-size stay inline in the widget (`DOCK_ICON_SIZE` is a
 * layout number, `lib/desktopLayout.ts`), while the *look* — radius, gradient, shadow,
 * press feedback — lives here, so the app items and the system items (Launchpad /
 * Finder / Trash) cannot drift into two different dock looks.
 *
 * The magnification `transform` is deliberately **not** part of this token: the
 * container applies it to a wrapper around the widget (see `Dock.svelte`), which is
 * what keeps a scaled item out of the geometry the container measures.
 * 
 * macOS 实测：16px 圆角（约图标尺寸的 1/3），按下时 scale(0.85)。
 */
export const DOCK_ITEM_TILE =
  "group flex items-center justify-center rounded-[16px] shadow-xl transition-transform " +
  "duration-100 active:scale-85 " +
  "bg-gradient-to-br from-neutral-700/90 to-neutral-900/90";

/** A dock item's wrapper: tile column + the running dot under it. */
export const DOCK_ITEM_COLUMN = "flex flex-col items-center";

/** The running indicator macOS draws under an open app (`null` when it is not running). */
export const DOCK_RUNNING_DOT = "mt-1 h-[5px] w-[5px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)]";

/** The reserved space the dot would occupy, so a running item does not change height. */
export const DOCK_RUNNING_DOT_SLOT = "mt-1 h-[5px] w-[5px]";

/** The `+N` chip the dock shows for items its width could not fit (never silent). */
export const DOCK_OVERFLOW_CHIP =
  "flex items-center justify-center rounded-2xl bg-white/15 text-[13px] font-semibold text-white/85";

/** The dock's separator between the apps and the Trash. */
export const DOCK_SEPARATOR =
  "mb-3 ml-1 flex-shrink-0 w-px h-12 rounded-[1px] bg-white/25";

/**
 * A dropdown panel (the Apple menu, the desktop's context menu): dark glass, 200 px
 * minimum width, 1 px hairline border.
 *
 * `_STYLE` is separate because a `backdrop-filter` is not a Tailwind class the build
 * can see — the panel widgets pass it as an inline `style`. Two menus (Apple menu,
 * stage context menu) now share these four constants instead of repeating the same
 * rgba/blur/border four times.
 */
export const CHROME_MENU_PANEL = "min-w-[200px] rounded-lg py-1 shadow-2xl";
export const CHROME_MENU_PANEL_STYLE =
  "background: rgba(40, 40, 40, 0.92); " +
  "backdrop-filter: blur(20px) saturate(180%); " +
  "-webkit-backdrop-filter: blur(20px) saturate(180%); " +
  "border: 1px solid rgba(255,255,255,0.08);";

/**
 * One row of a menu. `disabled:` is part of the token on purpose: a menu item that
 * cannot act must render as macOS renders one — greyed — and `items/` widgets pass
 * `disabled` rather than dropping the row (see `docs/FMEA.md` F-SH-001).
 * 
 * macOS 实测：13px body，1.5rem 行高。
 */
export const CHROME_MENU_ITEM =
  "block w-full px-4 py-1.5 text-left text-[13px] text-white/85 transition-colors " +
  "hover:bg-blue-500/70 hover:text-white " +
  "disabled:text-white/35 disabled:hover:bg-transparent disabled:cursor-default";

/** A hairline between menu groups. */
export const CHROME_MENU_SEPARATOR = "my-1 h-px bg-white/10";

/**
 * The desktop icon's "selected" state (macOS shows a translucent blue overlay + 2px
 * hairline around the tile; the selection is **visible**, not just stored). One place
 * for both: an icon that looks pressable but reports unselected (or vice-versa) is the
 * FMEA F-SH-001 shape in a different outfit.
 */
export const DESKTOP_ICON_SELECTED =
  "outline outline-2 outline-offset-2 outline-blue-400/90 rounded-[24px]";

/**
 * Keyboard-focus ring on a desktop icon (REQ-A273 — WAI-ARIA Active Descendant).
 * Distinct from `DESKTOP_ICON_SELECTED` (blue outline) so a user navigating with
 * the keyboard can see *which* icon the listbox's focus is on, even when it
 * matches the selection. White-with-translucency matches the topbar focus ring
 * so a sighted user sees one consistent focus vocabulary across the chrome.
 */
export const DESKTOP_ICON_FOCUSED =
  "outline outline-2 outline-offset-2 outline-white/80 rounded-[24px]";

/**
 * The drag-rectangle that appears while the user is rubber-band-selecting icons on the
 * desktop (mouse-down on the stage backdrop → drag → mouse-up). macOS draws this as a
 * translucent blue rectangle with a hairline border, and only while the drag is live;
 * the rectangle itself never persists.
 */
export const DESKTOP_SELECTION_RECT =
  "pointer-events-none fixed border border-blue-400/80 bg-blue-400/15 rounded-[2px]";

/**
 * Glass effect tokens — unified blur/saturate/alpha for all chrome surfaces.
 * 
 * macOS uses vibrancy with different blur strengths and background alphas depending
 * on the surface hierarchy. These tokens replace 6 inline style blocks that used to
 * spell their own blur/saturate/alpha values.
 * 
 * Why: changing the glass effect used to require editing 6 files (TopBar, Dock,
 * Spotlight, MissionControl, ControlCenter, Launchpad). Now it is one place.
 */

/** TopBar glass (subtle blur, medium translucency) */
export const GLASS_TOPBAR_STYLE =
  "background: rgba(30, 30, 30, 0.72); " +
  "backdrop-filter: blur(20px) saturate(180%); " +
  "-webkit-backdrop-filter: blur(20px) saturate(180%);";

/** Dock glass (light tint for contrast, strong blur matching macOS) */
export const GLASS_DOCK_STYLE =
  "background: rgba(255, 255, 255, 0.15); " +
  "backdrop-filter: blur(50px) saturate(180%); " +
  "-webkit-backdrop-filter: blur(50px) saturate(180%);";

/** Spotlight / search overlay (strong blur, high opacity for readability) */
export const GLASS_SPOTLIGHT_STYLE =
  "background: rgba(40, 40, 40, 0.92); " +
  "backdrop-filter: blur(30px) saturate(200%); " +
  "-webkit-backdrop-filter: blur(30px) saturate(200%);";

/** Mission Control overlay (medium blur, balanced opacity) */
export const GLASS_MISSION_CONTROL_STYLE =
  "background: rgba(20, 20, 20, 0.88); " +
  "backdrop-filter: blur(24px) saturate(200%); " +
  "-webkit-backdrop-filter: blur(24px) saturate(200%);";

/** Control Center panel (strong blur, medium-high opacity) */
export const GLASS_CONTROL_CENTER_STYLE =
  "background: rgba(40, 40, 40, 0.86); " +
  "backdrop-filter: blur(30px) saturate(180%); " +
  "-webkit-backdrop-filter: blur(30px) saturate(180%);";

/** Launchpad overlay (strongest blur, high opacity for app grid contrast) */
export const GLASS_LAUNCHPAD_STYLE =
  "background: rgba(15, 15, 15, 0.92); " +
  "backdrop-filter: blur(40px) saturate(200%); " +
  "-webkit-backdrop-filter: blur(40px) saturate(200%);";

/** Border style for glass surfaces (subtle hairline) */
export const GLASS_BORDER_SUBTLE = "border: 1px solid rgba(255,255,255,0.08);";

/** Border style for glass surfaces (medium visibility) */
export const GLASS_BORDER_MEDIUM = "border: 1px solid rgba(255,255,255,0.10);";

/** Dock border style (macOS light tint edges + top highlight，16px 顶部圆角) */
export const GLASS_BORDER_DOCK =
  "border-radius: 16px 16px 0 0; " +
  "border-top: 1px solid rgba(255, 255, 255, 0.18); " +
  "border-left: 1px solid rgba(255, 255, 255, 0.12); " +
  "border-right: 1px solid rgba(255, 255, 255, 0.12);";
