import type { CSSProperties, ReactNode } from "react";
import { bespokeGlyphSvg, tileBackground } from "../lib/appIcon";

/**
 * AppIcon.tsx — React renderer for launcher tiles.
 *
 * All colour / gradient / bespoke-glyph GEOMETRY now lives in the framework-
 * agnostic `src/lib/appIcon.ts` (single source of truth). This file only paints
 * that model onto the DOM the way React surfaces expect. Its twin is
 * `src/svelte/AppIcon.svelte`; both consume the SAME pure data, so the two
 * renderers cannot drift (this closes the audit-flagged #1 regression source:
 * a duplicated icon implementation).
 *
 * Compatibility re-exports keep existing callers (SystemPanels / HomeDock / the
 * Svelte ports' React fallbacks) importing the same names from this module.
 */
export { ICON_TONES, toneOf, isBespokeTile } from "../lib/appIcon";
import { isBespokeTile } from "../lib/appIcon";

/**
 * The rounded, tonal tile face with a crisp centered glyph + soft glass sheen.
 * Presentational only (no label / badge / drag) so every surface stays in sync.
 */
export function AppIconTile({
  id,
  icon,
  tileClassName = "h-14 w-14 rounded-[19px]",
  glyphClassName = "text-[2.5rem]",
  children,
  style,
}: {
  id: string;
  icon?: ReactNode;
  /** Sizing / radius / hover transforms merged onto the square tile. */
  tileClassName?: string;
  glyphClassName?: string;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  const bespoke = isBespokeTile(id);
  // Bespoke tiles paint their own face (paper / night / tinted wash) from the
  // shared registry; every other app keeps the deterministic tonal gradient.
  const face: CSSProperties = { backgroundImage: tileBackground(id) };
  const bespokeMarkup = bespokeGlyphSvg(id);
  return (
    <span
      className={`relative grid select-none place-items-center overflow-hidden shadow-md ring-1 ring-black/10 transition-all duration-150 dark:ring-white/10 ${tileClassName}`}
      style={{ ...face, ...style }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_60%_at_50%_-10%,rgba(255,255,255,0.3),transparent_55%)]"
      />
      {bespoke && bespokeMarkup != null ? (
        <span
          className="grid h-full w-full place-items-center"
          // The glyph SVG is pure, framework-agnostic markup produced by
          // lib/appIcon.ts — identical bytes that React and Svelte both inject.
          dangerouslySetInnerHTML={{ __html: bespokeMarkup }}
        />
      ) : icon != null ? (
        <span
          className={`grid h-full w-full place-items-center leading-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.18)] ${glyphClassName}`}
        >
          {icon}
        </span>
      ) : (
        children
      )}
    </span>
  );
}

