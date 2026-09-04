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

/** First-party apps that get a hand-tuned, iOS-style icon face instead of the
 *  generic emoji-on-gradient tile. Reminders = white card + green checklist;
 *  Voice Memos = white card + red waveform; Notes = white card + yellow pad. */
const BESPOKE_IDS: ReadonlySet<string> = new Set(["reminders", "vmemos", "notes"]);
/** True when a launcher tile should use a dedicated face rather than a glyph. */
export function isBespokeTile(id: string): boolean {
  return BESPOKE_IDS.has(id);
}

/** Apple-Reminders-inspired glyph: a checked white/green checkbox over soft grey
 *  "text" lines — drawn as one crisp, tint-independent SVG. */
function RemindersGlyph() {
  return (
    <svg
      viewBox="0 0 72 72"
      aria-hidden
      className="h-[62%] w-[62%] drop-shadow-[0_1px_2px_rgba(0,0,0,0.14)]"
    >
      <g>
        {/* checked box */}
        <rect x="9" y="11" width="19" height="19" rx="5.5" fill="#2fbf71" />
        <path
          d="M13.5 20.5 l4.6 4.6 L26 15.6"
          stroke="#ffffff"
          strokeWidth="3.6"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* unchecked box + title lines */}
        <rect x="9" y="40" width="15" height="15" rx="4.5" fill="#eef1f6" stroke="#c6cbd6" strokeWidth="1.6" />
        <rect x="29" y="42.5" width="34" height="5.6" rx="2.8" fill="#d7dbe4" />
        <rect x="29" y="50.5" width="24" height="5.6" rx="2.8" fill="#e6e9ef" />
      </g>
    </svg>
  );
}

/** Apple-Voice-Memos-inspired glyph: a red recording waveform over a white card. */
function VoiceGlyph() {
  const bars = [
    { x: 18, h: 12 },
    { x: 27, h: 22 },
    { x: 36, h: 34 },
    { x: 45, h: 22 },
    { x: 54, h: 12 },
  ];
  return (
    <svg
      viewBox="0 0 72 72"
      aria-hidden
      className="h-[62%] w-[62%] drop-shadow-[0_1px_2px_rgba(0,0,0,0.14)]"
    >
      <g fill="#f43f5e">
        {bars.map((b) => (
          <rect
            key={b.x}
            x={b.x}
            y={36 - b.h / 2}
            width="6"
            height={b.h}
            rx="3"
          />
        ))}
        {/* mic stem + capsule hint */}
        <path
          d="M36 17a6 6 0 0 1 6 6v6a6 6 0 0 1-12 0v-6a6 6 0 0 1 6-6z"
          fill="#ffffff"
        />
        <path d="M26 30v2a10 10 0 0 0 20 0v-2" fill="none" stroke="#f43f5e" strokeWidth="4" strokeLinecap="round" />
        <rect x="33" y="44" width="6" height="5" rx="1.5" fill="#f43f5e" />
      </g>
    </svg>
  );
}

/** Apple-Notes-inspired glyph: a yellow notepad with rule lines over white. */
function NotesGlyph() {
  return (
    <svg
      viewBox="0 0 72 72"
      aria-hidden
      className="h-[66%] w-[66%] drop-shadow-[0_1px_2px_rgba(0,0,0,0.16)]"
    >
      <g>
        <rect x="13" y="9" width="46" height="54" rx="7" fill="#f4c430" />
        {/* top "binding" tab in a deeper shade */}
        <path d="M13 9 h46 v8 a0 0 0 0 1 0 0 H13 Z" fill="#d9a800" />
        <rect x="13" y="9" width="46" height="6" rx="3" fill="#e0ae00" />
        {/* rule lines */}
        <g fill="#c9a227">
          <rect x="20" y="26" width="32" height="3.4" rx="1.7" />
          <rect x="20" y="36" width="32" height="3.4" rx="1.7" />
          <rect x="20" y="46" width="32" height="3.4" rx="1.7" />
        </g>
        {/* a short accent underline like Apple's pencil note */}
        <rect x="20" y="54" width="18" height="3.4" rx="1.7" fill="#fff3c0" />
      </g>
    </svg>
  );
}

/** Pick the dedicated tile art for a bespoke app id. */
function bespokeGlyph(id: string) {
  switch (id) {
    case "vmemos":
      return <VoiceGlyph />;
    case "notes":
      return <NotesGlyph />;
    case "reminders":
    default:
      return <RemindersGlyph />;
  }
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
  const bespoke = isBespokeTile(id);
  // Bespoke first-party tiles keep a near-white card (they carry their own art);
  // every other app keeps the deterministic tonal gradient.
  const face: CSSProperties = bespoke
    ? { backgroundImage: "linear-gradient(165deg,#ffffff,#eef2fa)" }
    : { backgroundImage: toneOf(id) };
  return (
    <span
      className={`relative grid select-none place-items-center overflow-hidden shadow-md ring-1 ring-black/10 transition-all duration-150 dark:ring-white/10 ${tileClassName}`}
      style={{ ...face, ...style }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_60%_at_50%_-10%,rgba(255,255,255,0.3),transparent_55%)]"
      />
      {bespoke ? (
        <span className="grid h-full w-full place-items-center">{bespokeGlyph(id)}</span>
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
