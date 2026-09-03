import type { CSSProperties, ReactNode } from "react";

// Refined, understated icon gradients chosen deterministically by app id.
// Each tile keeps a single soft hue family (top lighter → bottom deeper) instead
// of clashing saturated pairs, so the launcher reads calm/elegan (素雅) while apps
// stay visually distinct. Shared by every home surface so they never drift.
export const ICON_TONES: [string, string][] = [
  ["#cfe3ee", "#a7c9e3"], // soft sky
  ["#ded7ee", "#bfaede"], // soft lavender
  ["#f3ddd6", "#e9c0b8"], // soft rose
  ["#d0e8dc", "#a8d3bd"], // soft sage
  ["#cfe0f2", "#a3bce6"], // soft periwinkle
  ["#f6e3cf", "#efcd9f"], // soft apricot
  ["#f0d6e2", "#ddadd3"], // soft pink
  ["#e8ecd0", "#d3df9e"], // soft green
  ["#cde8e2", "#a6d5cf"], // soft mint
  ["#f2d3cf", "#e6a89f"], // soft coral
];

/** Deterministic per-app background gradient (hash of the id). */
export function toneOf(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const [a, b] = ICON_TONES[h % ICON_TONES.length]!;
  return `linear-gradient(135deg, ${a}, ${b})`;
}

/** The rounded, tonal tile face with a crisp centered glyph + soft glass sheen.
 * Presentational only (no label / badge / drag) so every surface stays in sync. */
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
  return (
    <span
      className={`relative grid select-none place-items-center overflow-hidden shadow-md ring-1 ring-black/10 transition-all duration-150 dark:ring-white/10 ${tileClassName}`}
      style={{ backgroundImage: toneOf(id), ...style }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_60%_at_50%_-10%,rgba(255,255,255,0.3),transparent_55%)]"
      />
      {icon != null ? (
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
